/**
 * Pluggable validator interface.
 *
 * The library is intentionally agnostic to the validation engine: callers
 * adapt their favourite tool (Zod, Valibot, ArkType, hand-written guards…)
 * by implementing this interface and passing it to {@link defineSchema}.
 *
 * Adapters MUST be pure: same input → same output, no side effects, no I/O.
 *
 * @packageDocumentation
 */

import type { ValidationResult } from '../core/types.js';

/**
 * Adapter from raw `unknown` input to a typed, validated value.
 *
 * Implementations decide whether to *transform* the input (e.g. apply
 * defaults, coerce strings to dates, parse numerics) or only assert its
 * shape. Either way, the produced value on success is the one that downstream
 * code (deprecation walker, migration pipeline, consumers) will see.
 *
 * @typeParam T - The validated, fully-typed output.
 * @public
 */
export interface ValidatorAdapter<T> {
  /**
   * Validates `input`.
   *
   * @param input - Untrusted value, typically the result of `JSON.parse`.
   * @returns A {@link ValidationResult} carrying either the typed value or
   *   a non-empty array of errors. Warnings may be present on either branch.
   */
  readonly validate: (input: unknown) => ValidationResult<T>;
}

/**
 * Convenience helper to build a {@link ValidatorAdapter} from a raw function.
 *
 * Useful for tests and for hand-rolled validators that don't have a fluent
 * builder API.
 *
 * @public
 */
export const fromValidateFn = <T>(
  validate: (input: unknown) => ValidationResult<T>,
): ValidatorAdapter<T> => ({ validate });
