/**
 * Per-version schema description.
 *
 * A {@link Schema} binds three pieces of information together:
 *
 * 1. The version identifier this schema describes.
 * 2. A {@link ValidatorAdapter} that knows how to validate an arbitrary
 *    `unknown` value against that version's shape.
 * 3. An optional, declarative list of {@link DeprecatedField | deprecations}.
 *
 * Schemas are plain data: they are passed to {@link createRegistry} which
 * orchestrates validation, deprecation reporting and migrations.
 *
 * @packageDocumentation
 */

import type { Version } from '../core/types.js';
import type { ValidatorAdapter } from '../validation/validatorAdapter.js';

import type { DeprecatedField } from './deprecation.js';

/**
 * Frozen, fully-resolved schema for a single document version.
 *
 * Always built through {@link defineSchema} so that defaults (empty
 * `deprecated` array, deep freeze) are applied consistently.
 *
 * @typeParam V - Concrete version identifier type.
 * @typeParam T - Shape of the validated document at this version.
 * @public
 */
export interface Schema<V extends Version, T> {
  readonly version: V;
  readonly validator: ValidatorAdapter<T>;
  readonly deprecated: readonly DeprecatedField[];
}

/**
 * User-facing input to {@link defineSchema}. `deprecated` is optional and
 * defaults to an empty array.
 *
 * @public
 */
export interface SchemaInput<V extends Version, T> {
  readonly version: V;
  readonly validator: ValidatorAdapter<T>;
  readonly deprecated?: readonly DeprecatedField[];
}

/**
 * Builds a frozen {@link Schema}.
 *
 * The result is structurally immutable (`Object.freeze` on both the wrapper
 * and the `deprecated` array) so it can safely be shared across registries
 * and threads (workers).
 *
 * @example
 * ```ts
 * const schemaV4 = defineSchema({
 *   version: 4,
 *   validator: zodAdapter(docV4Shape),
 *   deprecated: [
 *     { path: 'items[*].timing.minMinutes', sinceVersion: 4 },
 *   ],
 * });
 * ```
 *
 * @public
 */
export const defineSchema = <V extends Version, T>(input: SchemaInput<V, T>): Schema<V, T> => {
  const deprecated = Object.freeze([...(input.deprecated ?? [])]);
  return Object.freeze({
    version: input.version,
    validator: input.validator,
    deprecated,
  });
};
