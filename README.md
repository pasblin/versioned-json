# @pasblin/versioned-json

[![CI](https://github.com/pasblin/versioned-json/actions/workflows/ci.yml/badge.svg)](https://github.com/pasblin/versioned-json/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pasblin/versioned-json.svg)](https://www.npmjs.com/package/@pasblin/versioned-json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Framework-agnostic lifecycle toolkit for versioned JSON: migrations,
> deprecations, retirement and pluggable validators.

Works in **any** JavaScript / TypeScript project: Angular, React, Vue, Svelte, Node.js, Deno, Bun, etc.

## What problem does it solve?

Long-lived JSON documents change shape over time. Once a doc is in production
you cannot just rename a field, drop a column or tighten a type without
breaking every document already stored somewhere. `versioned-json` gives you a
small, opinionated toolkit to manage that lifecycle:

- **Per-version schemas**: describe what each historical version looks like.
- **Pure forward migrations**: `v(n) → v(n+1)`, no skipping, enforced at
  registry build time.
- **One typed result**: the public API always returns the latest version
  type, regardless of how old the input was.
- **Errors vs warnings**: validation produces structured `ValidationIssue`s,
  not exceptions, so consumers can render them in UIs.
- **Deprecations as data**: mark a field deprecated on any schema; the
  registry walks both the source document (using the source schema's
  deprecations) and the migrated latest document (using the latest schema's
  deprecations), so warnings fire even for fields that the migration chain
  removes or renames before reaching the latest shape.
- **Lifecycle hooks for legacy retirement**: bump `minSupportedVersion` to
  soft-retire old versions before deleting their migrations.

## Project policy

This library enforces (or makes it easy to enforce) the following rules:

1. **Never remove fields directly** — deprecate them first.
2. **Never change the meaning of an existing field** — add a new one and
   deprecate the old.
3. **New fields always ship with an explicit default**, applied by a
   migration.
4. **Every new version requires a migration from the previous one** —
   missing steps fail at registry build time.
5. **The internal model is always the latest version** — callers never see
   intermediate shapes.
6. **Validators distinguish error from warning** — `severity: 'error'`
   blocks the result, `severity: 'warning'` does not.
7. **Tests include real fixtures of old versions** — see
   `src/__tests__/recipe/fixtures/`.

## Install

```bash
npm install @pasblin/versioned-json
# To use the optional Zod adapter:
npm install @pasblin/versioned-json zod
```

## Quick start

```ts
import { z } from 'zod';
import { createRegistry, defineMigration, defineSchema } from '@pasblin/versioned-json';
import { zodAdapter } from '@pasblin/versioned-json/zod';

// 1. Describe each historical shape.
const DocV1 = z.object({ version: z.literal(1), title: z.string() });
const DocV2 = DocV1.extend({ version: z.literal(2), tags: z.array(z.string()).default([]) });

const schemaV1 = defineSchema({ version: 1, validator: zodAdapter(DocV1) });
const schemaV2 = defineSchema({
  version: 2,
  validator: zodAdapter(DocV2),
  deprecated: [{ path: 'title', sinceVersion: 2, replacement: 'name' }],
});

// 2. Migrate v(n) → v(n+1) with explicit defaults.
const m1to2 = defineMigration({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2 as const, tags: [] }),
});

// 3. Build the registry once.
const registry = createRegistry({
  schemas: [schemaV1, schemaV2],
  migrations: [m1to2],
  latest: schemaV2,
});

// 4. Use it on arbitrary input.
const result = registry.process({ version: 1, title: 'hello' });

if (result.ok) {
  result.data; // typed as DocV2
  result.warnings; // deprecation notices, etc.
  result.meta; // { detectedVersion, targetVersion, appliedMigrations }
} else {
  result.errors; // ValidationIssue[] with severity 'error'
}
```

> **Note:** the examples use plain `z.object`, which silently strips keys the
> schema does not declare. For long-lived documents prefer loose objects —
> see
> [Zod schemas: strict objects silently strip unknown keys](#zod-schemas-strict-objects-silently-strip-unknown-keys).

## Migration output must satisfy the latest schema

`registry.process()` re-validates the migrated document against the **latest**
schema after the migration chain runs. This is what guarantees policy #5 —
"the internal model is always the latest version" — but it has a subtle
consequence: **a later schema can never demand more than earlier data
provides unless a migration normalizes the data.**

If you tighten a schema between versions (add a required field, narrow a
type) without touching the corresponding migration, legacy documents will
fail validation _after_ migrating — and nothing about the input was wrong.
The fix belongs in the migration:

```ts
const V1 = z.object({ version: z.literal(1), title: z.string() });
// v2 tightens the contract: `id` is now required (nullable, but present).
const V2 = z.object({ version: z.literal(2), title: z.string(), id: z.number().nullable() });

// BROKEN: forgets to materialize `id`. process() on a v1 document returns
// ok: false — v2 validation fails on the MIGRATED output, not on the input.
const broken = defineMigration({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2 as const }),
});

// FIXED: the new field ships with an explicit default (project policy #3).
const fixed = defineMigration({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2 as const, id: null }),
});
```

Rule of thumb: **tightening a schema between versions is migration work, not
schema work.** Every `up` must return a document that fully satisfies its
target version's schema, so the chain's final output is valid against
`latest`.

This failure mode is programmatically distinguishable: when the migrated
output fails latest-schema validation, `result.errors` starts with a
synthetic `MIGRATION_OUTPUT_INVALID` issue that points at the migration
chain as the fix site, and every issue emitted by a schema validator carries
a `stage` discriminator — `'source'` (the input document is the problem) or
`'migrated'` (a migration under-delivered):

```ts
if (!result.ok) {
  if (result.errors.some((e) => e.stage === 'migrated')) {
    // The input was fine — a migration must normalize the reported fields.
  } else {
    // The input document itself is invalid.
  }
}
```

## Registry options

`createRegistry` accepts a small but important set of options. The defaults
cover the simplest case (`{ version: 1 }` at the top of every document); the
rest are essential for real adoption.

| Option                | Type                               | Default             | When to use                                                                  |
| --------------------- | ---------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `schemas`             | `Schema[]`                         | —                   | Required. Every historical version, in any order.                            |
| `migrations`          | `Migration[]`                      | —                   | Required. One per `v(n) → v(n+1)` step.                                      |
| `latest`              | `Schema<V, TLatest>`               | —                   | Required. Pinpoints the latest schema and lets TS infer the output type.     |
| `versionField`        | `string`                           | `'version'`         | Override when the version key is not the root `version` field.               |
| `resolveVersion`      | `(input) => V \| undefined`        | _none_              | Pluggable detection strategy when the version is not at the root.            |
| `comparator`          | `VersionComparator<V>`             | `integerVersion…`   | Use `lexicographicVersionComparator` for string versions like `'1.0.2'`.     |
| `minSupportedVersion` | `V`                                | smallest registered | Soft-retire old versions; documents below this bound are rejected.           |
| `assumeVersion`       | `V`                                | _none_              | Treat documents missing the version field as this version (legacy adoption). |
| `strictSource`        | `boolean`                          | `true`              | When `false`, skip validation against the source schema before migrating.    |
| `onMigration`         | `(step: AppliedMigration) => void` | _none_              | Observability hook fired once per applied migration step.                    |
| `onDeprecation`       | `(issue: ValidationIssue) => void` | _none_              | Observability hook fired once per deprecation warning emitted.               |

### Adopting on existing data (no version field yet)

When you bolt versioning onto a system that already has JSON in production,
the legacy documents do not carry your new version field. Two flags make this
bearable:

- **`versionField`** lets you pick a name without colliding with existing
  domain keys (e.g. `'_schemaVersion'` to avoid clashing with a business
  `'version'` string already in use).
- **`assumeVersion`** tells the registry what to do when the field is missing.
  Set it to the current latest so legacy documents pass through unchanged;
  every new export writes the field explicitly going forward.

```ts
export const registry = createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
  migrations: [m1to2, m2to3, m3to4],
  latest: schemaV4,
  versionField: '_schemaVersion', // dedicated key, not your business 'version'
  assumeVersion: 4, // pre-existing JSONs are treated as v4
  strictSource: true, // catch malformed legacy shapes early
});
```

Bump `assumeVersion` every time you raise `latest`. New exports must always
write the field explicitly; `assumeVersion` is only a safety net for data
that predates the field. The write side is a one-liner on top of the
document:

```ts
// Whenever your code emits a new document, stamp the latest schema version.
const doc = {
  _schemaVersion: 4,
  // ...your domain payload
};

fs.writeFileSync('out.json', JSON.stringify(doc, null, 2));
```

#### Several unmarked eras: content-sniffing `resolveVersion`

A constant `assumeVersion` only works when **all** unmarked legacy documents
belong to one era. If the version field was introduced after more than one
format change, the unmarked population splits into distinguishable
generations and no single constant classifies them correctly. Derive the
version from the document's shape instead, with `resolveVersion`:

```ts
// Era A (oldest): no marker, no `language` key.
// Era B: no marker, HAS `language`.
// Era C (current): explicit `_schemaVersion`.
createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3],
  migrations: [m1to2, m2to3],
  latest: schemaV3,
  resolveVersion: (input) => {
    if (typeof input !== 'object' || input === null) return undefined;
    const doc = input as Record<string, unknown>;
    if (doc['_schemaVersion'] !== undefined) return doc['_schemaVersion'] as number;
    return 'language' in doc ? 2 : 1; // shape-sniff the pre-marker eras
  },
});
```

Unlike `assumeVersion` — which must be bumped on every release — the
sniffing resolver is **maintenance-free forever**: it only distinguishes
pre-marker eras, which are frozen history, because every document written
after adoption carries the marker explicitly.

The usual `resolveVersion` rules apply (see
[Custom version detection](#custom-version-detection)): the function must be
pure; whatever version value it returns is validated through the comparator
and rejected with `UNKNOWN_VERSION` when unsupported; returning `undefined`
falls back to `assumeVersion` when configured, otherwise `MISSING_VERSION`.

## Custom version detection

When the version is not at the root or follows a non-trivial encoding —
nested under `meta.schemaVersion`, encoded in a `$schema` URL, derived from
the document content, or supplied by an external source (filename, HTTP
header) — pass a `resolveVersion(input)` function. It overrides
`versionField` and gives you full control:

```ts
createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
  migrations: [m1to2, m2to3, m3to4],
  latest: schemaV4,
  resolveVersion: (input) => {
    if (typeof input !== 'object' || input === null) return undefined;
    const obj = input as { meta?: { schemaVersion?: number } };
    return obj.meta?.schemaVersion;
  },
  assumeVersion: 4, // applies when resolveVersion returns undefined
});
```

Semantics:

- Return any version value: the registry validates it through the
  comparator and rejects unsupported values with `UNKNOWN_VERSION`.
- Return `undefined`: the registry falls back to `assumeVersion` if
  configured, otherwise emits `MISSING_VERSION`.
- The function must be pure (same input ⇒ same output, no side effects);
  thrown errors propagate.

## Observability hooks

Two optional hooks let you stream pipeline events into your logger,
metrics, or telemetry without iterating `result.warnings` and
`result.meta.appliedMigrations` yourself:

```ts
import type { AppliedMigration, ValidationIssue } from '@pasblin/versioned-json';

createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
  migrations: [m1to2, m2to3, m3to4],
  latest: schemaV4,
  onMigration: (step: AppliedMigration) => {
    metrics.increment('versioned_json.migration', { from: step.from, to: step.to });
  },
  onDeprecation: (issue: ValidationIssue) => {
    logger.warn('[deprecation]', issue.code, issue.path, issue.message);
  },
});
```

Semantics:

- `onMigration` fires once per applied step, in pipeline order, only
  after the full migration succeeds. It is not called when the source
  document is already at `latest`.
- `onDeprecation` fires once per warning emitted by either the source
  schema (during the source-document walk) or the latest schema (during
  the post-migration walk).
- Hooks must not throw; thrown errors propagate and abort `process(...)`.
  Wrap with `try/catch` in user code if you need at-most-once-delivery
  semantics.

## Zod schemas: strict objects silently strip unknown keys

`zodAdapter` returns the **parsed** output of `safeParse`, so validation is
also a transformation: with plain `z.object`, any key the schema does not
declare is silently dropped from `result.data`. For long-lived documents —
this library's core use case — that is a data-loss footgun: a schema written
for era N silently deletes fields added in era N+1 whenever older code
processes newer documents, and hand-added fields vanish on round-trip.

```ts
const V1 = z.object({ title: z.string() }); // strict object
zodAdapter(V1).validate({ title: 'x', newerField: 'kept?' });
// → ok: true, data = { title: 'x' } — `newerField` is GONE, no warning.

const V1loose = z.looseObject({ title: z.string() }); // loose object
zodAdapter(V1loose).validate({ title: 'x', newerField: 'kept?' });
// → ok: true, data = { title: 'x', newerField: 'kept?' } — preserved.
```

Recommendation: use loose objects for document schemas — `z.looseObject(...)`
in zod 4, `z.object(...).passthrough()` in zod 3. Reach for strict objects
only when stripping is exactly what you want (e.g. sanitizing an untrusted
payload at a boundary). The Quick start and recipe examples in this README
use strict objects for brevity; on real long-lived documents, prefer loose
ones.

## Writer exactness: tolerant reader, exact writer

Loose schemas fix the READ side: unknown keys survive because they may belong
to a newer era of the document. The flip side is a blind spot on the WRITE
side — validation can never notice when your own code starts emitting a field
that **no schema version declares**, which is precisely the mistake of adding
a field to an export without creating a new schema version plus a migration.
The `@pasblin/versioned-json/zod` sub-entry ships the guard for that:

```ts
import { assertWriterExact, collectUndeclaredPaths } from '@pasblin/versioned-json/zod';

// Paths of every key present in `value` but not declared by `schema`.
// [] === the writer is exact.
collectUndeclaredPaths(RecipeV4, doc);
// e.g. ['steps[2].newField']

// Throws WriterExactnessError when a document about to be serialized
// carries undeclared keys; pass your framework's dev flag to make it a
// production no-op.
assertWriterExact(RecipeV4, doc, 'recipe export', isDevMode());
fs.writeFileSync(path, JSON.stringify(doc, null, 2));
```

Semantics worth knowing:

- **Tolerance is not declaration**: a loose object's implicit `unknown`
  catchall does NOT declare keys — its extra keys are still reported. A
  substantive `.catchall(schema)` DOES declare every key it matches.
- `optional`/`nullable`/`default`/`readonly`/`catch` wrappers unwrap to the
  carrier schema; arrays recurse per element with indexed paths;
  discriminated unions match the variant by tag and recurse inside it (an
  unmatched tag stays silent — validation owns that failure).
- Keys under `z.unknown()`/`z.any()`/`z.record(...)` produce no findings,
  and `undefined`-valued keys are skipped — the guard judges the file that
  will exist, not the in-memory object.
- The walker only ever answers "any undeclared keys?", never "is it valid?"
  — zero overlap with `process()`.

Wire the assert at your serialization points, and pair it with a CI contract
spec so the mistake is caught twice — in the running dev app and in the
pipeline:

```ts
it('all export fixtures are writer-exact', () => {
  for (const fixture of exportFixtures) {
    expect(collectUndeclaredPaths(RecipeV4, fixture)).toEqual([]);
  }
});
```

One companion hazard the walker cannot catch (declared key — it checks keys,
not values): `{ _schemaVersion: N, ...doc }` lets a stale input marker win
the spread. Stamp by dropping any input marker first, so the output always
carries the current version:

```ts
const { _schemaVersion: _stale, ...payload } = doc;
const out = { _schemaVersion: registry.latest, ...payload };
```

Loose schemas for reading + writer exactness for writing is Postel's law
operationalized: be liberal in what you accept, conservative in what you
emit.

## Validators without Zod

`zodAdapter` is convenient but optional. Any function that returns a
`ValidationResult` works via `fromValidateFn`. Useful when you want zero
runtime dependencies, custom error codes, or to wrap an existing JSON
schema engine.

This is the Quick start, rewritten without Zod — same shape, same
behaviour:

```ts
import {
  createRegistry,
  defineMigration,
  defineSchema,
  fromValidateFn,
} from '@pasblin/versioned-json';

interface DocV1 {
  version: 1;
  title: string;
}
interface DocV2 {
  version: 2;
  title: string;
  tags: string[];
}

// 1. Hand-rolled validators — each returns ValidationResult<T>.
const validateV1 = fromValidateFn<DocV1>((input) => {
  if (typeof input !== 'object' || input === null) {
    return {
      ok: false,
      errors: [{ severity: 'error', code: 'NOT_OBJECT', message: 'Expected object', path: '' }],
      warnings: [],
    };
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.title !== 'string') {
    return {
      ok: false,
      errors: [{ severity: 'error', code: 'INVALID_DOC_V1', message: 'invalid v1 doc', path: '' }],
      warnings: [],
    };
  }
  return { ok: true, data: { version: 1, title: obj.title }, warnings: [] };
});

const validateV2 = fromValidateFn<DocV2>((input) => {
  const obj = input as Record<string, unknown>;
  if (obj?.version !== 2 || typeof obj.title !== 'string' || !Array.isArray(obj.tags)) {
    return {
      ok: false,
      errors: [{ severity: 'error', code: 'INVALID_DOC_V2', message: 'invalid v2 doc', path: '' }],
      warnings: [],
    };
  }
  return {
    ok: true,
    data: { version: 2, title: obj.title, tags: obj.tags as string[] },
    warnings: [],
  };
});

// 2. Schemas + migration + registry — identical to the Zod Quick start.
const schemaV1 = defineSchema({ version: 1, validator: validateV1 });
const schemaV2 = defineSchema({
  version: 2,
  validator: validateV2,
  deprecated: [{ path: 'title', sinceVersion: 2, replacement: 'name' }],
});

const m1to2 = defineMigration({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2 as const, tags: [] }),
});

const registry = createRegistry({
  schemas: [schemaV1, schemaV2],
  migrations: [m1to2],
  latest: schemaV2,
});

// 3. Use it.
const result = registry.process({ version: 1, title: 'hello' });
if (result.ok) {
  console.log(result.data); // { version: 2, title: 'hello', tags: [] }
}
```

## Deprecation path syntax

Deprecation `path`s describe where in a document a deprecated value can
live. The grammar is intentionally tiny:

| Pattern                     | Matches                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `title`                     | The `title` key at the root.                                      |
| `meta.author.name`          | A nested object key, dot-separated.                               |
| `tags[0]`                   | The first element of the `tags` array.                            |
| `items[*].sub.flag`         | The `sub.flag` key on every element of `items`.                   |
| `parents[*].children[*].id` | A wildcard at every array level — most useful for legacy renames. |

No other operators are supported (no slices, no regex, no conditional
selectors). If you need them, build the deprecation list dynamically before
passing it to `defineSchema`.

### What a deprecation warning looks like at runtime

Given this declaration on `schemaV3`:

```ts
const schemaV3 = defineSchema({
  version: 3,
  validator: validateV3,
  deprecated: [
    {
      path: 'parents[*].children[*].oldId',
      sinceVersion: 3,
      plannedRemovalVersion: 5,
      replacement: 'parents[*].children[*].id',
      reason: 'renamed for clarity',
    },
  ],
});
```

Processing an input that contains `parents[0].children[1].oldId: 'x'`
yields one warning per concrete hit (wildcards are expanded against the
actual data):

```ts
result.warnings;
// [
//   {
//     severity: 'warning',
//     code: 'DEPRECATED_FIELD',
//     path: 'parents[0].children[1].oldId',
//     message:
//       'Field "parents[0].children[1].oldId" is deprecated since version 3 ' +
//       'and is scheduled for removal in version 5; ' +
//       'use "parents[*].children[*].id" instead (renamed for clarity).',
//     meta: {
//       declaredPath: 'parents[*].children[*].oldId',
//       sinceVersion: 3,
//       plannedRemovalVersion: 5,
//       replacement: 'parents[*].children[*].id',
//       reason: 'renamed for clarity',
//     },
//   },
// ]
```

Deprecation warnings never block: `result.ok` stays `true` and `result.data`
holds the migrated document. Use them to drive logging, telemetry or UI hints.

## Real-world example: a recipe document family

The library's own integration test (
[`src/__tests__/recipe.integration.test.ts`](./src/__tests__/recipe.integration.test.ts)
) walks a realistic 4-version family. The shape below is condensed but real —
it is the exact pipeline the test runs against fixtures `v1.json` … `v4.json`.

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createRegistry, defineMigration, defineSchema, ErrorCode } from '@pasblin/versioned-json';
import { zodAdapter } from '@pasblin/versioned-json/zod';

// --- Per-version Zod shapes (each version extends the previous one) -------
const StepV1 = z.object({
  timer: z.object({ active: z.boolean() }),
  tags: z.array(z.string()),
});
const RecipeV1 = z.object({
  version: z.literal(1),
  title: z.string(),
  cuisine: z.string(),
  year: z.number().int(),
  type: z.enum(['Main', 'Side']),
  steps: z.array(StepV1),
});
const RecipeV2 = RecipeV1.extend({ version: z.literal(2), notes: z.string().default('NONE') });
const StepV3 = StepV1.extend({
  timing: z.object({
    method: z.string(),
    minMinutes: z.number().int().positive().optional(),
    maxMinutes: z.number().int().positive().optional(),
  }),
});
const RecipeV3 = RecipeV2.extend({
  version: z.literal(3),
  cookbook: z.string().default('home'),
  steps: z.array(StepV3),
});
const StepV4 = StepV3.extend({ category: z.string() });
const RecipeV4 = RecipeV3.extend({
  version: z.literal(4),
  relatedDishes: z.array(z.string()).default([]),
  steps: z.array(StepV4),
});

// --- Schemas -------------------------------------------------------------
const schemaV1 = defineSchema({ version: 1, validator: zodAdapter(RecipeV1) });
const schemaV2 = defineSchema({ version: 2, validator: zodAdapter(RecipeV2) });
const schemaV3 = defineSchema({ version: 3, validator: zodAdapter(RecipeV3) });
const schemaV4 = defineSchema({
  version: 4,
  validator: zodAdapter(RecipeV4),
  deprecated: [
    {
      path: 'steps[*].timing.minMinutes',
      sinceVersion: 4,
      plannedRemovalVersion: 6,
      replacement: 'steps[*].timing.range.min',
      reason: 'flattened range fields will be grouped under a single object',
    },
    {
      path: 'steps[*].timing.maxMinutes',
      sinceVersion: 4,
      plannedRemovalVersion: 6,
    },
  ],
});

// --- Migrations: each one applies its own explicit defaults ---------------
const m1to2 = defineMigration({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2 as const, notes: 'NONE' }),
});
const m2to3 = defineMigration({
  from: 2,
  to: 3,
  up: (doc) => ({
    ...doc,
    version: 3 as const,
    cookbook: 'home',
    steps: doc.steps.map((s) => ({ ...s, timing: { method: 'manual' } })),
  }),
});
const m3to4 = defineMigration({
  from: 3,
  to: 4,
  up: (doc) => ({
    ...doc,
    version: 4 as const,
    relatedDishes: [],
    steps: doc.steps.map((s) => ({ ...s, category: 'general' })),
  }),
});

export const recipeRegistry = createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
  migrations: [m1to2, m2to3, m3to4],
  latest: schemaV4,
});

// --- Use it ---------------------------------------------------------------
const legacyV1 = JSON.parse(readFileSync('./legacy-v1.json', 'utf-8')) as unknown;
const result = recipeRegistry.process(legacyV1);

if (!result.ok) {
  if (result.errors[0]?.code === ErrorCode.UnsupportedLegacyVersion) {
    // The version was registered but soft-retired with `minSupportedVersion`.
    console.warn('Document refers to a retired schema version, refusing.');
  }
  throw new Error(`Cannot upgrade document: ${result.errors[0]?.code}`);
}

result.data; // typed as RecipeV4 — latest, fully validated
result.meta.appliedMigrations; // [{from:1,to:2}, {from:2,to:3}, {from:3,to:4}]
result.warnings; // any DEPRECATED_FIELD hits found in the source
```

The corresponding integration test asserts every step of this pipeline,
including deprecation warnings on `v3.json` and rejection of legacy `v1.json`
when `minSupportedVersion: 3` is configured.

## Lifecycle of a version

```
[introduced] → [active] → [field-deprecated] → [legacy, minSupported bumped] → [retired]
```

- **Field deprecation**: declare `deprecated: [{ path, sinceVersion, ... }]`
  on the schema where the field becomes obsolete. The registry emits a
  `DEPRECATED_FIELD` warning every time it is present in an input.
- **Version retirement**: when telemetry says no live documents are still on
  v(n), bump `minSupportedVersion` to `n+1`. Documents declaring v(n) will
  now be rejected with `UNSUPPORTED_LEGACY_VERSION` instead of being
  migrated. After a deprecation window, delete the schema, the migration and
  the fixture files; keep one regression test that asserts the new error.

## API surface

- `defineSchema` / `Schema` — per-version description (validator +
  optional deprecations).
- `defineMigration` / `Migration` — pure forward transformation.
- `createMigrator` — chain executor used internally; exposed for advanced
  use cases.
- `createRegistry` / `Registry.process` / `Registry.processOrThrow` —
  top-level orchestrator. Configurable detection (`versionField`,
  `resolveVersion`), retirement (`minSupportedVersion`), legacy adoption
  (`assumeVersion`), and observability hooks (`onMigration`,
  `onDeprecation`).
- `ValidatorAdapter` + `fromValidateFn` — plug your own validator.
- `zodAdapter` (sub-export `@pasblin/versioned-json/zod`) — ready-made
  adapter for Zod schemas.
- `collectUndeclaredPaths` / `assertWriterExact` / `WriterExactnessError`
  (same `/zod` sub-export) — writer-exactness guard for serialization
  points.
- `integerVersionComparator` (default), `lexicographicVersionComparator`,
  `VersionComparator` — pluggable ordering for version identifiers.
- `VersionedJsonError`, `ErrorCode`, and the typed subclasses for
  programmatic branching.

## CLI

The package ships a small `versioned-json` binary for one-off upgrades from
the shell. It loads a built JS module exposing your `Registry`, processes a
JSON document and writes the migrated result to stdout or a file.

```bash
versioned-json upgrade --registry ./registry.js doc.json
versioned-json upgrade --registry ./registry.js --out upgraded.json --pretty doc.json
cat doc.json | versioned-json upgrade --registry ./registry.js -
```

Options:

- `--registry <path>` (required) — path to a built JS module exporting a
  `Registry` (default export or a named `registry` export).
- `--out <path>` — write the migrated document to a file; defaults to stdout.
- `--pretty` — pretty-print the JSON output.
- `--quiet` — suppress warnings on stderr.
- `--allow-failed` — exit `0` even when the document fails.
- `-h`, `--help` — show help.

Exit codes are stable: `0` success, `1` the document failed validation or
migration, `2` misuse (bad arguments, registry not loadable, etc.).

The `<input>` positional is a file path, or `-` to read JSON from stdin.

## TypeScript and module formats

The package ships both ESM and CJS builds with `.d.ts` declarations:

```ts
import { createRegistry } from '@pasblin/versioned-json'; // ESM
const { createRegistry } = require('@pasblin/versioned-json'); // CJS
```

`zod` is declared as an **optional** peer dependency: only install it if you
import from `@pasblin/versioned-json/zod`.

## Development

```bash
# Install dependencies
npm install

# Run tests in watch mode
npm run test:watch

# Build the library
npm run build

# Lint & format
npm run lint
npm run format
```

### Scripts

| Script                    | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `build`                   | Build ESM + CJS + d.ts with [`tsup`](https://tsup.egoist.dev/) |
| `dev`                     | Build in watch mode                                            |
| `test`                    | Run tests once with [Vitest](https://vitest.dev/)              |
| `test:watch`              | Tests in watch mode                                            |
| `test:coverage`           | Tests with coverage                                            |
| `typecheck`               | Type-check without emitting                                    |
| `lint` / `lint:fix`       | ESLint                                                         |
| `format` / `format:check` | Prettier                                                       |
| `changeset`               | Create a changeset for the next release                        |

### Releasing

This repo uses [Changesets](https://github.com/changesets/changesets):

1. Run `npm run changeset` and describe your change.
2. Commit and push.
3. The **Release** GitHub Action opens a "Version Packages" PR.
4. Merging that PR publishes to npm automatically.

You need to set the secret `NPM_TOKEN` in the repository for publishing.

## License

[MIT](./LICENSE) © pasblin
