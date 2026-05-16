/**
 * Resolves and executes migration chains between two versions.
 *
 * The {@link Migrator} indexes migrations by their `from` version and follows
 * the chain until it reaches the requested target. Gaps are detected eagerly
 * at construction time, so a registry that builds successfully can never
 * fail later because of a missing migration.
 *
 * The migrator is intentionally minimal: it knows nothing about validation
 * or deprecations. Composition with those concerns happens in
 * {@link createRegistry}.
 *
 * @packageDocumentation
 */

import { InvalidRegistryError, MigrationFailedError, MigrationGapError } from '../core/errors.js';
import type { Version } from '../core/types.js';
import type { VersionComparator } from '../core/versionComparator.js';

/**
 * A single step that {@link Migrator.migrate | migrate} reports back to its
 * caller, so callers can build a trace for telemetry / debugging.
 *
 * @public
 */
export interface AppliedMigration {
  readonly from: Version;
  readonly to: Version;
}

/**
 * Structural shape required by the migrator. Heterogeneous user-defined
 * migrations (different `TFrom` / `TTo` per step) are assignable to this
 * alias thanks to function-parameter contravariance:
 *
 * - `up`'s parameter is typed as `never`, which is the bottom type, so any
 *   concrete `(doc: TFrom) => TTo` callback is assignable to it.
 * - `down` is intentionally NOT part of this shape because TypeScript
 *   variance for `(doc: TTo) => TFrom` cannot be expressed with a single
 *   `never`/`unknown` pair simultaneously. Downward migrations are
 *   accessible via the original {@link Migration} reference for callers that
 *   need them (e.g. an export pipeline).
 *
 * @public
 */
export interface AnyMigration<V extends Version> {
  readonly from: V;
  readonly to: V;
  readonly up: (doc: never) => unknown;
}

/**
 * Options accepted by {@link createMigrator}.
 *
 * @public
 */
export interface MigratorOptions<V extends Version> {
  readonly migrations: readonly AnyMigration<V>[];
  readonly comparator: VersionComparator<V>;
}

/**
 * Runs migrations between two versions of the same document family.
 *
 * @public
 */
export interface Migrator<V extends Version> {
  /**
   * Migrates `doc` from `fromVersion` up to `toVersion`. Throws
   * {@link MigrationGapError} if there is no contiguous path (this should
   * not happen for migrators built by the registry, which validates the
   * chain up-front).
   *
   * @returns The migrated document and the list of applied steps.
   */
  readonly migrate: (
    doc: unknown,
    fromVersion: V,
    toVersion: V,
  ) => { readonly data: unknown; readonly applied: readonly AppliedMigration[] };

  /**
   * True if a migration registered with `from === version` exists.
   */
  readonly hasFrom: (version: V) => boolean;
}

const indexByFrom = <V extends Version>(
  migrations: readonly AnyMigration<V>[],
): ReadonlyMap<V, AnyMigration<V>> => {
  const map = new Map<V, AnyMigration<V>>();
  for (const m of migrations) {
    if (map.has(m.from)) {
      throw new InvalidRegistryError(
        `Duplicate migration starting from version ${String(m.from)}.`,
      );
    }
    map.set(m.from, m);
  }
  return map;
};

/**
 * Builds a {@link Migrator}. Performs eager sanity checks:
 *
 * - No two migrations may share the same `from` version (would be ambiguous).
 * - Every migration must move *forward* (`compare(to, from) > 0`); otherwise
 *   chains could loop. Sideways or downward migrations are out of scope.
 *
 * Gaps are NOT checked here: the migrator can describe a partial graph. The
 * registry is the one that enforces contiguity between
 * `minSupportedVersion` and `latest`.
 *
 * @public
 */
export const createMigrator = <V extends Version>(options: MigratorOptions<V>): Migrator<V> => {
  const { comparator, migrations } = options;

  for (const m of migrations) {
    if (comparator.compare(m.to, m.from) <= 0) {
      throw new InvalidRegistryError(
        `Migration from ${String(m.from)} to ${String(m.to)} does not move forward.`,
      );
    }
  }

  const byFrom = indexByFrom(migrations);

  return {
    hasFrom: (version) => byFrom.has(version),
    migrate: (doc, fromVersion, toVersion) => {
      const cmp = comparator.compare(fromVersion, toVersion);
      if (cmp === 0) {
        return { data: doc, applied: [] };
      }
      if (cmp > 0) {
        throw new InvalidRegistryError(
          `Cannot migrate backwards from ${String(fromVersion)} to ${String(toVersion)}.`,
        );
      }

      const applied: AppliedMigration[] = [];
      let current: unknown = doc;
      let cursor: V = fromVersion;

      // Termination: every successfully applied migration moves `cursor`
      // strictly forward (createMigrator() rejects non-forward steps), and
      // the byFrom map indexes each version at most once. So either we hit
      // the target, miss a migration (gap), overshoot, or a migration
      // throws — every iteration ends in `return` or `throw`.
      for (;;) {
        if (comparator.compare(cursor, toVersion) === 0) {
          return { data: current, applied };
        }
        const m = byFrom.get(cursor);
        if (m === undefined) {
          throw new MigrationGapError(cursor, toVersion);
        }
        // `up` accepts `never` on the type side (see AnyMigration); at the
        // call site we know `current` carries the validated shape produced
        // by the previous step, so we widen the parameter to `unknown` and
        // trust the user-supplied transformer.
        const apply = m.up as unknown as (doc: unknown) => unknown;
        try {
          current = apply(current);
        } catch (cause) {
          throw new MigrationFailedError(m.from, m.to, { cause });
        }
        applied.push({ from: m.from, to: m.to });
        cursor = m.to;
        if (comparator.compare(cursor, toVersion) > 0) {
          // Overshot the target — the chain points beyond `toVersion` without
          // stopping there. Treat as a gap so callers get a deterministic
          // error instead of silently returning the wrong version.
          throw new MigrationGapError(m.from, toVersion);
        }
      }
    },
  };
};
