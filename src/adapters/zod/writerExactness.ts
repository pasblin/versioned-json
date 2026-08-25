/**
 * Writer-exactness utilities: "tolerant reader, exact writer".
 *
 * The recommended schema style for long-lived documents is loose objects:
 * the READER deliberately accepts unknown keys, because they may belong to a
 * newer era of the document. The flip side is a structural blind spot on the
 * WRITE side: validation can never notice when your own code starts emitting
 * a field that no schema version declares — precisely the mistake of adding
 * a field to an export without creating a new schema version plus a
 * migration.
 *
 * {@link collectUndeclaredPaths} walks a value against a Zod schema and
 * returns the path of every key the schema does not declare;
 * {@link assertWriterExact} turns that into a dev-mode guard for
 * serialization points.
 *
 * The walker has a single responsibility: it only ever answers "any
 * undeclared keys?", never "is it valid?" — zero overlap with
 * `registry.process()`. Both zod majors supported by the adapter (3 and 4)
 * are handled; their introspection internals differ and are bridged here.
 *
 * @packageDocumentation
 */

import type { ZodType } from 'zod';

/**
 * Minimal structural view of a Zod internal `_def`, covering both majors:
 * zod 3 discriminates via `typeName` ('ZodObject', …) and stores an array's
 * element under `type`; zod 4 discriminates via a string `type` ('object', …)
 * and stores the element under `element`.
 */
interface IntrospectedDef {
  readonly typeName?: string;
  readonly type?: unknown;
  readonly innerType?: unknown;
  readonly element?: unknown;
  readonly catchall?: unknown;
  readonly valueType?: unknown;
  readonly discriminator?: string;
  readonly options?: Iterable<unknown>;
}

/** Structural view of a Zod schema instance shared by both majors. */
interface IntrospectedSchema {
  readonly _def: IntrospectedDef;
  readonly shape?: Record<string, unknown>;
  readonly safeParse?: (input: unknown) => { readonly success: boolean };
}

const defOf = (schema: unknown): IntrospectedDef | undefined =>
  typeof schema === 'object' && schema !== null && '_def' in schema
    ? (schema as IntrospectedSchema)._def
    : undefined;

type Kind = 'object' | 'array' | 'wrapper' | 'union' | 'record' | 'unconstrained' | 'opaque';

const KIND_BY_RAW: Readonly<Record<string, Kind>> = {
  ZodObject: 'object',
  object: 'object',
  ZodArray: 'array',
  array: 'array',
  ZodOptional: 'wrapper',
  optional: 'wrapper',
  ZodNullable: 'wrapper',
  nullable: 'wrapper',
  ZodDefault: 'wrapper',
  default: 'wrapper',
  ZodReadonly: 'wrapper',
  readonly: 'wrapper',
  ZodCatch: 'wrapper',
  catch: 'wrapper',
  ZodDiscriminatedUnion: 'union',
  ZodUnion: 'union',
  union: 'union',
  ZodRecord: 'record',
  record: 'record',
  // `unknown`/`any` accept their whole subtree; `never` accepts nothing.
  // For declaredness they classify together: none of them *names* keys, so
  // none of them counts as a substantive catchall, while a field explicitly
  // typed as one of them produces no findings underneath.
  ZodUnknown: 'unconstrained',
  unknown: 'unconstrained',
  ZodAny: 'unconstrained',
  any: 'unconstrained',
  ZodNever: 'unconstrained',
  never: 'unconstrained',
};

const kindOf = (def: IntrospectedDef): Kind => {
  const raw = def.typeName ?? (typeof def.type === 'string' ? def.type : undefined);
  return (raw !== undefined ? KIND_BY_RAW[raw] : undefined) ?? 'opaque';
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const appendKey = (prefix: string, key: string): string =>
  prefix.length === 0 ? key : `${prefix}.${key}`;

/**
 * A `.catchall(schema)` with a substantive schema declares every key it
 * matches. A loose object's implicit `unknown` catchall (and `any`/`never`)
 * does NOT: that tolerance exists for foreign readers, not for the adopter's
 * own writer.
 */
const substantiveCatchall = (catchall: unknown): boolean => {
  const def = defOf(catchall);
  return def !== undefined && kindOf(def) !== 'unconstrained';
};

const matchVariant = (options: Iterable<unknown>, discriminator: string, tag: unknown): unknown => {
  for (const option of options) {
    const shape = (option as IntrospectedSchema).shape;
    if (shape === undefined || !Object.hasOwn(shape, discriminator)) continue;
    const tagSchema = shape[discriminator] as IntrospectedSchema;
    if (tagSchema.safeParse?.(tag).success === true) {
      return option;
    }
  }
  return undefined;
};

const walk = (schema: unknown, value: unknown, path: string, out: string[]): void => {
  const def = defOf(schema);
  if (def === undefined) return;

  switch (kindOf(def)) {
    case 'wrapper':
      // optional/nullable/default/readonly/catch peel down to the carrier.
      walk(def.innerType, value, path, out);
      return;

    case 'unconstrained':
      return;

    case 'array': {
      if (!Array.isArray(value)) return;
      // zod 3 stores the element schema under `type`; zod 4 under `element`.
      const element = def.typeName !== undefined ? def.type : def.element;
      for (let i = 0; i < value.length; i += 1) {
        walk(element, value[i], `${path}[${String(i)}]`, out);
      }
      return;
    }

    case 'record': {
      if (!isPlainObject(value)) return;
      for (const key of Object.keys(value)) {
        const entry = value[key];
        if (entry === undefined) continue;
        walk(def.valueType, entry, appendKey(path, key), out);
      }
      return;
    }

    case 'union': {
      // Only discriminated unions can be matched structurally; plain unions
      // stay silent. An unmatched tag also stays silent — validation owns
      // that failure and reports it with full context.
      if (def.discriminator === undefined || !isPlainObject(value)) return;
      const variant = matchVariant(def.options ?? [], def.discriminator, value[def.discriminator]);
      if (variant !== undefined) walk(variant, value, path, out);
      return;
    }

    case 'object': {
      if (!isPlainObject(value)) return;
      const shape = (schema as IntrospectedSchema).shape ?? {};
      const catchallDeclares = substantiveCatchall(def.catchall);
      for (const key of Object.keys(value)) {
        const entry = value[key];
        // JSON.stringify never writes undefined-valued keys; the guard
        // judges the file that will exist, not the in-memory object.
        if (entry === undefined) continue;
        // Object.hasOwn, not `shape[key]` truthiness: input keys named
        // `constructor`/`toString`/`__proto__` must be reported as
        // undeclared, not resolved against inherited Object.prototype
        // members.
        if (Object.hasOwn(shape, key)) {
          walk(shape[key], entry, appendKey(path, key), out);
        } else if (catchallDeclares) {
          walk(def.catchall, entry, appendKey(path, key), out);
        } else {
          out.push(appendKey(path, key));
        }
      }
      return;
    }

    case 'opaque':
      // Constructs the walker does not understand (tuples, intersections,
      // pipes/transforms, …) are treated as declaring their subtree: this
      // guard must never produce false positives.
      return;
  }
};

/**
 * Returns the path (dot/bracket notation, e.g.
 * `'pages[0].documents[2].newField'`) of every key present in `value` but
 * not declared by `schema`. An empty array means the writer is exact.
 *
 * Semantics:
 *
 * - Loose objects (`z.looseObject`, `.passthrough()`) do NOT declare their
 *   extra keys — reader tolerance is not writer declaration. A substantive
 *   `.catchall(schema)` DOES declare every key it matches.
 * - `optional`/`nullable`/`default`/`readonly`/`catch` wrappers are peeled
 *   down to the carrier schema.
 * - Arrays recurse per element with indexed paths; discriminated unions
 *   match the variant by tag and recurse inside it (an unmatched tag stays
 *   silent — validation owns that failure).
 * - Keys under `z.unknown()`/`z.any()`/`z.record(...)` produce no findings.
 * - `undefined`-valued keys are skipped: `JSON.stringify` never writes them.
 *
 * @public
 */
export const collectUndeclaredPaths = (schema: ZodType, value: unknown): string[] => {
  const out: string[] = [];
  walk(schema, value, '', out);
  return out;
};

/**
 * Thrown by {@link assertWriterExact} when a document about to be serialized
 * carries undeclared keys.
 *
 * @public
 */
export class WriterExactnessError extends Error {
  public readonly context: string;
  public readonly paths: readonly string[];

  public constructor(context: string, paths: readonly string[]) {
    super(
      `Writer is not exact in ${context}: ${String(paths.length)} undeclared path(s): ` +
        `${paths.join(', ')}. Declare the field in a new schema version (plus its ` +
        'migration), or stop writing it.',
    );
    this.name = 'WriterExactnessError';
    this.context = context;
    this.paths = paths;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Dev-mode guard for serialization points: throws
 * {@link WriterExactnessError} when `value` carries keys `schema` does not
 * declare; no-op when `devMode` is `false`.
 *
 * `devMode` defaults to `true` — calling the assert means you want the
 * check. Inject your framework's flag (e.g. Angular's `isDevMode()`, Vite's
 * `import.meta.env.DEV`) to turn it into a production no-op:
 *
 * @example
 * ```ts
 * assertWriterExact(RecipeV4, doc, 'recipe export', isDevMode());
 * fs.writeFileSync(path, JSON.stringify(doc, null, 2));
 * ```
 *
 * @public
 */
export const assertWriterExact = (
  schema: ZodType,
  value: unknown,
  context: string,
  devMode = true,
): void => {
  if (!devMode) return;
  const paths = collectUndeclaredPaths(schema, value);
  if (paths.length > 0) throw new WriterExactnessError(context, paths);
};
