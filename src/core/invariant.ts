/**
 * Single point for runtime-asserted internal invariants.
 *
 * The library carries a small number of values that TypeScript types as
 * `T | undefined` because of `noUncheckedIndexedAccess`, even though the
 * surrounding control flow guarantees they are defined (e.g. accessing
 * `array[i]` immediately after a length check, or `map.get(k)` after
 * `map.has(k)`).
 *
 * Routing every one of these through {@link invariant} centralises the
 * non-null assertion in a single, fully-tested helper instead of scattering
 * `c8 ignore` comments around the codebase.
 *
 * @packageDocumentation
 */

import { InvalidRegistryError } from './errors.js';

/**
 * Asserts that `value` is neither `undefined` nor `null` and returns it
 * narrowed to {@link NonNullable}. Throws {@link InvalidRegistryError} when
 * the assertion fails — these failures only happen when an internal
 * invariant has been broken by a code change.
 *
 * @example
 * ```ts
 * const first = invariant(items[0], 'items must not be empty');
 * ```
 *
 * @internal
 */
export const invariant = <T>(value: T, message: string): NonNullable<T> => {
  if (value === undefined || value === null) {
    throw new InvalidRegistryError(`Internal invariant violated: ${message}`);
  }
  return value;
};
