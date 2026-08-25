/**
 * Migrations between two contiguous versions of a document family.
 *
 * Migrations are pure functions: they take a document in version `from` and
 * return the same document in version `to`. The library never inspects their
 * implementation; it only chains them.
 *
 * Per project policy, every new version must ship a migration *from* the
 * previous one — enforced at registry construction time via
 * {@link MigrationGapError}.
 *
 * @packageDocumentation
 */

import type { Version } from '../core/types.js';

/**
 * Pure mapping between two contiguous document versions.
 *
 * - `up` is mandatory: it transforms a `TFrom` into a `TTo`.
 * - `down` is optional: provide it when you need to *export* documents to
 *   older consumers (e.g. for backwards-compatible APIs).
 *
 * @typeParam VFrom - Version identifier of the source document.
 * @typeParam VTo   - Version identifier of the target document.
 * @typeParam TFrom - Shape of the source document.
 * @typeParam TTo   - Shape of the target document.
 * @public
 */
export interface Migration<
  VFrom extends Version = Version,
  VTo extends Version = Version,
  TFrom = unknown,
  TTo = unknown,
> {
  readonly from: VFrom;
  readonly to: VTo;
  /**
   * Forward migration. MUST be pure: no I/O, no side effects, no time-
   * dependent behaviour. Receives the validated document at version `from`
   * and returns the document at version `to` with all new fields filled in
   * with explicit defaults.
   *
   * The registry validates the final output of the migration chain against
   * the latest schema, so `up` must produce a document that fully satisfies
   * version `to` — tightening a schema between versions (new required field,
   * narrowed type) is migration work: an `up` that under-delivers surfaces
   * as a validation failure on the migrated output.
   */
  readonly up: (doc: TFrom) => TTo;
  /**
   * Optional backwards migration. When omitted, the registry cannot export
   * a document to a version older than `to`.
   */
  readonly down?: (doc: TTo) => TFrom;
}

/**
 * User-facing input to {@link defineMigration}. Mirrors {@link Migration} but
 * exists so the documented entry point is clearly distinct from the result
 * type.
 *
 * @public
 */
export interface MigrationInput<VFrom extends Version, VTo extends Version, TFrom, TTo> {
  readonly from: VFrom;
  readonly to: VTo;
  readonly up: (doc: TFrom) => TTo;
  readonly down?: (doc: TTo) => TFrom;
}

/**
 * Builds a frozen {@link Migration}.
 *
 * Using this helper instead of an object literal ensures the migration is
 * immutable and gets a stable identity at module load time, so the registry
 * can cache derived data keyed by reference.
 *
 * @example
 * ```ts
 * const m3to4 = defineMigration({
 *   from: 3,
 *   to: 4,
 *   up: (doc) => ({ ...doc, tags: doc.tags ?? [] }),
 * });
 * ```
 *
 * @public
 */
export const defineMigration = <VFrom extends Version, VTo extends Version, TFrom, TTo>(
  input: MigrationInput<VFrom, VTo, TFrom, TTo>,
): Migration<VFrom, VTo, TFrom, TTo> => {
  // Preserve `down` only when actually provided so that
  // exactOptionalPropertyTypes is respected.
  if (input.down === undefined) {
    return Object.freeze({
      from: input.from,
      to: input.to,
      up: input.up,
    });
  }
  return Object.freeze({
    from: input.from,
    to: input.to,
    up: input.up,
    down: input.down,
  });
};
