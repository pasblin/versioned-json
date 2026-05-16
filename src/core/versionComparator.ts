/**
 * Pluggable ordering for {@link Version} identifiers.
 *
 * The library never assumes how to compare versions: callers register a
 * {@link VersionComparator} when building a registry. Two built-ins are
 * shipped: {@link integerVersionComparator} (default) and a strict
 * lexicographic one. Semver, calendar versioning, etc. can be plugged in by
 * implementing the interface.
 *
 * @packageDocumentation
 */

import type { Version } from './types.js';

/**
 * Result of comparing two versions.
 *
 * - Negative number: `a` is older than `b`.
 * - Zero: `a` and `b` represent the same version.
 * - Positive number: `a` is newer than `b`.
 *
 * Same convention as `Array.prototype.sort` callbacks, so a comparator can be
 * passed directly to {@link Array.sort}.
 *
 * @public
 */
export type CompareResult = number;

/**
 * Strategy interface for comparing and validating version identifiers.
 *
 * Implementations must be **pure**, **total** and **stable**:
 *
 * - Pure: no side effects, no time-dependent behaviour.
 * - Total: every accepted version pair must produce a numeric result.
 * - Stable: `compare(a, b)` and `compare(b, a)` must have opposite signs.
 *
 * @typeParam V - Concrete version type accepted by this comparator.
 * @public
 */
export interface VersionComparator<V extends Version = Version> {
  /**
   * Compares two versions.
   *
   * @throws If either argument is not a value this comparator can handle.
   *   Callers are expected to use {@link VersionComparator.isVersion} first
   *   when working with `unknown` input.
   */
  readonly compare: (a: V, b: V) => CompareResult;
  /**
   * Narrowing predicate: returns `true` if `value` is a valid version for
   * this comparator. Used by the registry when reading the version field
   * from raw JSON.
   */
  readonly isVersion: (value: unknown) => value is V;
}

/**
 * Compares two values as JavaScript numbers and returns a {@link CompareResult}.
 *
 * @internal
 */
const numericCompare = (a: number, b: number): CompareResult => {
  // Avoid relying on `a - b`, which loses precision for large integers.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * Default comparator for non-negative finite integer versions.
 *
 * Matches the shape used in most of our document families (e.g.
 * `"version": 4`). Rejects `NaN`, fractional numbers, `Infinity` and negative
 * values.
 *
 * @public
 */
export const integerVersionComparator: VersionComparator<number> = {
  isVersion: (value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
  compare: (a, b) => {
    if (!integerVersionComparator.isVersion(a) || !integerVersionComparator.isVersion(b)) {
      throw new TypeError(
        `integerVersionComparator only accepts non-negative integers; got (${String(a)}, ${String(b)}).`,
      );
    }
    return numericCompare(a, b);
  },
};

/**
 * Strict lexicographic comparator for opaque string versions.
 *
 * Useful for non-numeric identifiers (e.g. `'2024-01'`, `'A'..'Z'`). Does NOT
 * implement semver; for semver, plug in a semver-aware implementation of
 * {@link VersionComparator}.
 *
 * @public
 */
export const lexicographicVersionComparator: VersionComparator<string> = {
  isVersion: (value): value is string => typeof value === 'string' && value.length > 0,
  compare: (a, b) => {
    if (
      !lexicographicVersionComparator.isVersion(a) ||
      !lexicographicVersionComparator.isVersion(b)
    ) {
      throw new TypeError(
        `lexicographicVersionComparator only accepts non-empty strings; got (${String(a)}, ${String(b)}).`,
      );
    }
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  },
};
