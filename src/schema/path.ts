/**
 * Tiny path language used by {@link DeprecatedField.path}.
 *
 * Grammar (informal):
 *
 * ```
 * path     := segment ( ('.' key) | index )*
 * segment  := key | index
 * key      := [^.\[]+
 * index    := '[' ( <non-negative integer> | '*' ) ']'
 * ```
 *
 * Examples of valid paths:
 *
 * - `items`
 * - `items[0]`
 * - `items[*]`
 * - `items[0].sub.flag`
 * - `items[*].children[*].name`
 *
 * Anything outside the grammar throws {@link InvalidPathError} so callers
 * find typos early.
 *
 * @packageDocumentation
 */

import { invariant } from '../core/invariant.js';

/**
 * A single resolved path step.
 *
 * @public
 */
export type PathSegment =
  | { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'wildcard' };

/**
 * Raised by {@link parsePath} when the input does not match the grammar.
 *
 * @public
 */
export class InvalidPathError extends Error {
  public readonly path: string;
  public readonly position: number;

  public constructor(path: string, position: number, reason: string) {
    super(`Invalid path "${path}" at position ${String(position)}: ${reason}.`);
    this.name = 'InvalidPathError';
    this.path = path;
    this.position = position;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Parses a path string into an ordered list of {@link PathSegment | segments}.
 *
 * @throws {@link InvalidPathError} on syntactic errors.
 * @public
 */
export const parsePath = (path: string): readonly PathSegment[] => {
  if (path.length === 0) {
    throw new InvalidPathError(path, 0, 'path is empty');
  }

  const segments: PathSegment[] = [];
  let i = 0;

  while (i < path.length) {
    const ch = path[i];

    if (ch === '.') {
      if (segments.length === 0) {
        throw new InvalidPathError(path, i, 'unexpected leading "."');
      }
      i += 1;
      if (i >= path.length) {
        throw new InvalidPathError(path, i, 'trailing "."');
      }
      if (path[i] === '.' || path[i] === '[' || path[i] === ']') {
        throw new InvalidPathError(path, i, 'expected a key after "."');
      }
      continue;
    }

    if (ch === '[') {
      const end = path.indexOf(']', i);
      if (end === -1) {
        throw new InvalidPathError(path, i, 'unterminated "["');
      }
      const inside = path.slice(i + 1, end);
      if (inside.length === 0) {
        throw new InvalidPathError(path, i + 1, 'empty index "[]"');
      }
      if (inside === '*') {
        segments.push({ kind: 'wildcard' });
      } else {
        // Accept only canonical non-negative integers (no signs, no leading
        // zeros except "0" itself, no whitespace).
        const allDigits = [...inside].every(isDigit);
        if (!allDigits || (inside.length > 1 && inside.startsWith('0'))) {
          throw new InvalidPathError(
            path,
            i + 1,
            `invalid index "${inside}" (expected non-negative integer or "*")`,
          );
        }
        const index = Number.parseInt(inside, 10);
        segments.push({ kind: 'index', index });
      }
      i = end + 1;
      continue;
    }

    if (ch === ']') {
      throw new InvalidPathError(path, i, 'unmatched "]"');
    }

    // Read a bare key until the next separator.
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[' && path[j] !== ']') {
      j += 1;
    }
    segments.push({ kind: 'key', name: path.slice(i, j) });
    i = j;
  }

  return segments;
};

/**
 * Single hit produced by {@link walkPath}.
 *
 * @public
 */
export interface PathHit {
  /** Concrete, fully-resolved path (no wildcards) to the matched value. */
  readonly path: string;
  /** The value at that path. */
  readonly value: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walks `doc` following `segments`, expanding wildcards into every matching
 * array index, and returns the concrete hits.
 *
 * Behaviour:
 *
 * - A `key` segment on a non-object value (including arrays and `null`)
 *   yields no hit for that branch (silently skipped, not an error).
 * - An `index` or `wildcard` segment on a non-array value yields no hit.
 * - Missing keys / out-of-range indices yield no hit.
 *
 * This silent behaviour is intentional: deprecation is a *non-blocking*
 * concern. If the field is not present we have nothing to warn about.
 *
 * @public
 */
export const walkPath = (doc: unknown, segments: readonly PathSegment[]): readonly PathHit[] => {
  const hits: PathHit[] = [];
  walk(doc, segments, 0, '', hits);
  return hits;
};

const appendKey = (prefix: string, key: string): string =>
  prefix.length === 0 ? key : `${prefix}.${key}`;

const appendIndex = (prefix: string, index: number): string => `${prefix}[${String(index)}]`;

const walk = (
  doc: unknown,
  segments: readonly PathSegment[],
  cursor: number,
  prefix: string,
  out: PathHit[],
): void => {
  if (cursor === segments.length) {
    out.push({ path: prefix, value: doc });
    return;
  }
  // Bounded by the previous length check; routed through invariant() so the
  // non-null assertion stays centralised and tested.
  const seg = invariant(segments[cursor], 'walk: segment cursor out of range');

  if (seg.kind === 'key') {
    if (!isPlainObject(doc)) return;
    if (!Object.prototype.hasOwnProperty.call(doc, seg.name)) return;
    walk(doc[seg.name], segments, cursor + 1, appendKey(prefix, seg.name), out);
    return;
  }

  if (seg.kind === 'index') {
    if (!Array.isArray(doc)) return;
    if (seg.index >= doc.length) return;
    walk(doc[seg.index], segments, cursor + 1, appendIndex(prefix, seg.index), out);
    return;
  }

  // wildcard
  if (!Array.isArray(doc)) return;
  for (let i = 0; i < doc.length; i += 1) {
    walk(doc[i], segments, cursor + 1, appendIndex(prefix, i), out);
  }
};
