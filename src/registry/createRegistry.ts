/**
 * Orchestrates schemas, migrations and validation into a single, ergonomic
 * entry point.
 *
 * A registry is built once per document family and used to {@link Registry.process | process}
 * incoming JSON. The build step performs eager sanity checks so that bugs in
 * the configuration surface at module load, not at runtime when a document
 * arrives.
 *
 * Pipeline of {@link Registry.process | process(input)}:
 *
 * 1. Read the version field from `input` (or fall back to `assumeVersion`).
 * 2. Gate the detected version against `minSupportedVersion` and `latest`.
 * 3. (optional) Validate the input against its source schema (`strictSource`).
 * 4. Walk the source schema's deprecations on the source document so that
 *    deprecated fields are reported even if a later migration removes or
 *    renames them. Skipped when source equals latest to avoid duplicates.
 * 5. Run the migrator from the detected version up to `latest`.
 * 6. Validate the migrated document against the latest schema.
 * 7. Collect deprecation warnings on the validated latest document.
 *
 * Every recoverable failure is surfaced as a {@link ValidationIssue} on the
 * returned {@link ProcessResult}; only programmer mistakes (missing
 * migrations in the chain, comparator misuse, etc.) throw.
 *
 * @packageDocumentation
 */

import {
  ErrorCode,
  InvalidRegistryError,
  MigrationFailedError,
  MigrationGapError,
  ValidationFailedError,
  VersionedJsonError,
} from '../core/errors.js';
import { invariant } from '../core/invariant.js';
import type { ProcessResult, ValidationIssue, Version } from '../core/types.js';
import { integerVersionComparator, type VersionComparator } from '../core/versionComparator.js';
import { createMigrator, type AnyMigration } from '../migration/migrator.js';
import { collectDeprecationWarnings } from '../schema/deprecationWalker.js';
import type { Schema } from '../schema/schema.js';

/** Default key used to read the version from a raw document. */
const DEFAULT_VERSION_FIELD = 'version';

/**
 * Structural shape required by the registry for the schemas array. Each
 * schema in the list may have a different `T` (validated shape); the registry
 * only needs uniform access to `version`, `validator.validate` and
 * `deprecated`.
 *
 * @public
 */
export type AnySchema<V extends Version> = Schema<V, unknown>;

/**
 * User-supplied configuration for {@link createRegistry}.
 *
 * @typeParam V       - Concrete version identifier type.
 * @typeParam TLatest - Validated shape of the document at `latest.version`.
 * @public
 */
export interface RegistryConfig<V extends Version, TLatest> {
  /**
   * Every schema known to this registry, including the latest one.
   *
   * Order is irrelevant; duplicate versions are rejected.
   */
  readonly schemas: readonly AnySchema<V>[];

  /**
   * Every migration known to this registry. The migrator validates
   * forward-only direction and unique `from` values; the registry adds
   * gap detection between `minSupportedVersion` and `latest.version`.
   */
  readonly migrations: readonly AnyMigration<V>[];

  /**
   * Typed reference to the latest schema. Must also be present in
   * `schemas` (same `version`). Passing the schema rather than only the
   * version lets TypeScript infer `TLatest` automatically.
   */
  readonly latest: Schema<V, TLatest>;

  /**
   * Comparator used to order versions. Defaults to
   * {@link integerVersionComparator}.
   */
  readonly comparator?: VersionComparator<V>;

  /**
   * Property name on the raw JSON that carries the version. Defaults to
   * `'version'`.
   */
  readonly versionField?: string;

  /**
   * Minimum version still accepted by the registry. Defaults to the smallest
   * registered schema version.
   *
   * When set above the smallest registered version, documents declaring a
   * version below this bound are rejected with
   * {@link UnsupportedLegacyVersionError | UNSUPPORTED_LEGACY_VERSION}, even
   * if the relevant migrations are still wired. Used to drive the
   * "soft-retirement -> hard-retirement" lifecycle.
   */
  readonly minSupportedVersion?: V;

  /**
   * Fallback version used when the raw JSON has no `versionField`.
   *
   * Without this option, missing-version inputs are rejected.
   */
  readonly assumeVersion?: V;

  /**
   * When `true` (default), the input is validated against its source schema
   * *before* migrating. When `false`, only the final document (post-migration)
   * is validated against the latest schema. The strict mode catches malformed
   * legacy documents earlier.
   */
  readonly strictSource?: boolean;
}

/**
 * Public surface of a built registry.
 *
 * @public
 */
export interface Registry<V extends Version, TLatest> {
  readonly latest: V;
  readonly minSupportedVersion: V;
  readonly versionField: string;
  readonly comparator: VersionComparator<V>;

  /**
   * Runs the full pipeline on `input` and returns a {@link ProcessResult}.
   * Never throws for recoverable problems (invalid version, validation
   * failures, migration failures) — they are surfaced as errors on the
   * result.
   */
  readonly process: (input: unknown) => ProcessResult<TLatest>;

  /**
   * Convenience variant of {@link Registry.process | process} that throws
   * {@link ValidationFailedError} when the result is not `ok`. Use only when
   * a throwing API fits the call site better than a `Result` API.
   */
  readonly processOrThrow: (input: unknown) => TLatest;
}

const issue = (
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  meta?: Readonly<Record<string, unknown>>,
): ValidationIssue =>
  meta === undefined
    ? { severity, code, message, path: '' }
    : { severity, code, message, path: '', meta };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sortVersions = <V extends Version>(
  versions: readonly V[],
  comparator: VersionComparator<V>,
): readonly V[] => [...versions].sort(comparator.compare);

const assertContiguousChain = <V extends Version>(
  ordered: readonly V[],
  byFrom: ReadonlyMap<V, AnyMigration<V>>,
  comparator: VersionComparator<V>,
): void => {
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = invariant(ordered[i], 'assertContiguousChain: ordered[i]');
    const to = invariant(ordered[i + 1], 'assertContiguousChain: ordered[i + 1]');
    const migration = byFrom.get(from);
    if (migration === undefined) {
      throw new MigrationGapError(from, to);
    }
    if (comparator.compare(migration.to, to) !== 0) {
      // The migration exists but its target is not the next registered
      // version; the chain is broken.
      throw new MigrationGapError(from, to);
    }
  }
};

/**
 * Builds a {@link Registry}.
 *
 * @throws {@link InvalidRegistryError}
 *   When schemas or migrations are misconfigured (duplicate versions,
 *   `latest` not registered, `minSupportedVersion` out of range, etc.).
 * @throws {@link MigrationGapError}
 *   When the contiguous chain from `minSupportedVersion` to `latest.version`
 *   has a missing step.
 *
 * @public
 */
export const createRegistry = <V extends Version, TLatest>(
  config: RegistryConfig<V, TLatest>,
): Registry<V, TLatest> => {
  const comparator =
    config.comparator ?? (integerVersionComparator as unknown as VersionComparator<V>);
  const versionField = config.versionField ?? DEFAULT_VERSION_FIELD;
  const strictSource = config.strictSource ?? true;

  if (config.schemas.length === 0) {
    throw new InvalidRegistryError('At least one schema must be registered.');
  }

  // Index schemas by version, rejecting duplicates.
  const schemaByVersion = new Map<V, AnySchema<V>>();
  for (const schema of config.schemas) {
    if (!comparator.isVersion(schema.version)) {
      throw new InvalidRegistryError(
        `Schema version ${String(schema.version)} is not accepted by the comparator.`,
      );
    }
    if (schemaByVersion.has(schema.version)) {
      throw new InvalidRegistryError(`Duplicate schema for version ${String(schema.version)}.`);
    }
    schemaByVersion.set(schema.version, schema);
  }

  const latestVersion = config.latest.version;
  if (!schemaByVersion.has(latestVersion)) {
    throw new InvalidRegistryError(
      `Latest schema (version ${String(latestVersion)}) is not present in "schemas".`,
    );
  }
  if (schemaByVersion.get(latestVersion) !== config.latest) {
    throw new InvalidRegistryError(
      `Latest schema reference does not match the schema registered for version ${String(latestVersion)}.`,
    );
  }

  const orderedVersions = sortVersions([...schemaByVersion.keys()], comparator);
  // schemas.length > 0 was checked earlier, so the sorted list is non-empty.
  const lowestVersion = invariant(orderedVersions[0], 'sorted versions must be non-empty');

  const minSupportedVersion: V = config.minSupportedVersion ?? lowestVersion;

  if (!comparator.isVersion(minSupportedVersion)) {
    throw new InvalidRegistryError(
      `minSupportedVersion ${String(minSupportedVersion)} is not accepted by the comparator.`,
    );
  }
  if (!schemaByVersion.has(minSupportedVersion)) {
    throw new InvalidRegistryError(
      `minSupportedVersion ${String(minSupportedVersion)} is not registered in "schemas".`,
    );
  }
  if (comparator.compare(minSupportedVersion, latestVersion) > 0) {
    throw new InvalidRegistryError(
      `minSupportedVersion (${String(minSupportedVersion)}) cannot be greater than latest (${String(latestVersion)}).`,
    );
  }

  // Build the migrator (validates per-migration invariants).
  const migrator = createMigrator({
    migrations: config.migrations,
    comparator,
  });

  // Enforce strict pairwise contiguity from minSupportedVersion to latest.
  const contiguousWindow = orderedVersions.filter(
    (v) =>
      comparator.compare(v, minSupportedVersion) >= 0 && comparator.compare(v, latestVersion) <= 0,
  );
  const migrationByFrom = new Map<V, AnyMigration<V>>();
  for (const m of config.migrations) {
    migrationByFrom.set(m.from, m);
  }
  assertContiguousChain(contiguousWindow, migrationByFrom, comparator);

  if (config.assumeVersion !== undefined && !comparator.isVersion(config.assumeVersion)) {
    throw new InvalidRegistryError(
      `assumeVersion ${String(config.assumeVersion)} is not accepted by the comparator.`,
    );
  }

  const latestSchema = config.latest;

  const readVersion = (
    input: unknown,
  ):
    | { readonly ok: true; readonly version: V }
    | { readonly ok: false; readonly issue: ValidationIssue } => {
    if (!isPlainObject(input)) {
      if (config.assumeVersion !== undefined) {
        return { ok: true, version: config.assumeVersion };
      }
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.MissingVersion,
          'Input is not a plain object; cannot read the version field.',
        ),
      };
    }
    const raw = input[versionField];
    if (raw === undefined) {
      if (config.assumeVersion !== undefined) {
        return { ok: true, version: config.assumeVersion };
      }
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.MissingVersion,
          `Missing required version field "${versionField}".`,
          { versionField },
        ),
      };
    }
    if (!comparator.isVersion(raw)) {
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.UnknownVersion,
          `Field "${versionField}" carries an unsupported value: ${JSON.stringify(raw)}.`,
          { versionField, rawValue: raw },
        ),
      };
    }
    return { ok: true, version: raw };
  };

  const gateVersion = (
    detected: V,
  ): { readonly ok: true } | { readonly ok: false; readonly issue: ValidationIssue } => {
    if (comparator.compare(detected, latestVersion) > 0) {
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.FutureVersion,
          `Detected version ${String(detected)} is newer than the latest supported version ${String(latestVersion)}.`,
          { detectedVersion: detected, latestVersion },
        ),
      };
    }
    if (comparator.compare(detected, minSupportedVersion) < 0) {
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.UnsupportedLegacyVersion,
          `Detected version ${String(detected)} has been retired; minimum supported version is ${String(minSupportedVersion)}.`,
          { detectedVersion: detected, minSupportedVersion },
        ),
      };
    }
    if (!schemaByVersion.has(detected)) {
      return {
        ok: false,
        issue: issue(
          'error',
          ErrorCode.UnknownVersion,
          `Detected version ${String(detected)} is not registered.`,
          { detectedVersion: detected },
        ),
      };
    }
    return { ok: true };
  };

  const process = (input: unknown): ProcessResult<TLatest> => {
    const warnings: ValidationIssue[] = [];

    const versionRead = readVersion(input);
    if (!versionRead.ok) {
      return {
        ok: false,
        errors: [versionRead.issue],
        warnings,
        meta: {},
      };
    }
    const detectedVersion = versionRead.version;

    const gate = gateVersion(detectedVersion);
    if (!gate.ok) {
      return {
        ok: false,
        errors: [gate.issue],
        warnings,
        meta: { detectedVersion },
      };
    }

    let currentDoc: unknown = input;

    // gateVersion() already ensured detectedVersion is registered.
    const sourceSchema = invariant(
      schemaByVersion.get(detectedVersion),
      `schemaByVersion.get(${String(detectedVersion)}) after gating`,
    );
    const isSourceLatest = comparator.compare(detectedVersion, latestVersion) === 0;

    if (strictSource) {
      const sourceResult = sourceSchema.validator.validate(input);
      warnings.push(...sourceResult.warnings);
      if (!sourceResult.ok) {
        return {
          ok: false,
          errors: sourceResult.errors,
          warnings,
          meta: { detectedVersion, targetVersion: latestVersion },
        };
      }
      currentDoc = sourceResult.data;
    }

    // Walk source-version deprecations on the source document so that fields
    // declared deprecated in the source schema produce a warning even when the
    // forward migration removes or renames them before they reach the latest
    // shape. Skipped when source === latest because the post-migration walk
    // below covers that case (and avoids emitting duplicate warnings).
    if (!isSourceLatest && sourceSchema.deprecated.length > 0) {
      const sourceDeprecationWarnings = collectDeprecationWarnings(
        currentDoc,
        sourceSchema.deprecated,
      );
      warnings.push(...sourceDeprecationWarnings);
    }

    let migrated;
    try {
      migrated = migrator.migrate(currentDoc, detectedVersion, latestVersion);
    } catch (e) {
      if (e instanceof MigrationFailedError) {
        return {
          ok: false,
          errors: [
            issue('error', ErrorCode.MigrationFailed, e.message, {
              from: e.from,
              to: e.to,
              cause: stringifyCause(e.cause),
            }),
          ],
          warnings,
          meta: { detectedVersion, targetVersion: latestVersion },
        };
      }
      // Defensive: MigrationGapError can only fire from `migrator.migrate`
      // when the chain is incomplete, but `assertContiguousChain` above
      // ruled that out at build time. Any other exception is a programmer
      // bug. Re-throw so it surfaces loudly. Intentionally NOT covered by
      // tests — exercising this branch would require constructing a
      // self-inconsistent registry, which the same checks forbid.
      throw e;
    }

    const latestResult = latestSchema.validator.validate(migrated.data);
    warnings.push(...latestResult.warnings);
    if (!latestResult.ok) {
      return {
        ok: false,
        errors: latestResult.errors,
        warnings,
        meta: {
          detectedVersion,
          targetVersion: latestVersion,
          appliedMigrations: migrated.applied,
        },
      };
    }

    const deprecationWarnings = collectDeprecationWarnings(
      latestResult.data,
      latestSchema.deprecated,
    );
    warnings.push(...deprecationWarnings);

    return {
      ok: true,
      data: latestResult.data,
      warnings,
      meta: {
        detectedVersion,
        targetVersion: latestVersion,
        appliedMigrations: migrated.applied,
      },
    };
  };

  const processOrThrow = (input: unknown): TLatest => {
    const result = process(input);
    if (result.ok) return result.data;
    throw new ValidationFailedError(result.errors);
  };

  return Object.freeze({
    latest: latestVersion,
    minSupportedVersion,
    versionField,
    comparator,
    process,
    processOrThrow,
  });
};

const stringifyCause = (cause: unknown): string => {
  if (cause instanceof VersionedJsonError || cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  // Defensive: migrations conventionally throw Error subclasses (the path
  // above), so reaching here requires the user code to `throw plainObject`.
  // The JSON.stringify fallback handles serialisable values; the catch
  // covers circular references. Not tested directly because the test would
  // assert on JSON.stringify behaviour rather than on our own logic.
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};
