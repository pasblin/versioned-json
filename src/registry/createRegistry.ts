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
 * 1. Detect the version via `resolveVersion(input)` if provided, else read
 *    the configured `versionField` from `input`. Fall back to `assumeVersion`
 *    when nothing matches.
 * 2. Gate the detected version against `minSupportedVersion` and `latest`.
 * 3. (optional) Validate the input against its source schema (`strictSource`).
 * 4. Walk the source schema's deprecations on the source document so that
 *    deprecated fields are reported even if a later migration removes or
 *    renames them. Skipped when source equals latest to avoid duplicates.
 *    The optional `onDeprecation` hook fires once per warning produced here.
 * 5. Run the migrator from the detected version up to `latest`.
 * 6. Validate the migrated document against the latest schema. The optional
 *    `onMigration` hook fires once per applied step, in pipeline order.
 * 7. Collect deprecation warnings on the validated latest document, firing
 *    `onDeprecation` once per warning.
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
import type { ProcessResult, ValidationIssue, ValidationStage, Version } from '../core/types.js';
import { integerVersionComparator, type VersionComparator } from '../core/versionComparator.js';
import { createMigrator, type AnyMigration, type AppliedMigration } from '../migration/migrator.js';
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
   *
   * Ignored when {@link RegistryConfig.resolveVersion | resolveVersion} is
   * also provided.
   */
  readonly versionField?: string;

  /**
   * Pluggable strategy to extract the version from a raw input. When provided,
   * it takes precedence over {@link RegistryConfig.versionField | versionField}
   * and gives full control over how the version is detected.
   *
   * Useful when the version lives in a non-root location (e.g. `meta.schema`),
   * is encoded in a `$schema` URL, must be derived from the document content,
   * or is supplied externally (filename, HTTP header, etc.).
   *
   * Return `undefined` to signal "no version detected" — the registry then
   * falls back to {@link RegistryConfig.assumeVersion | assumeVersion} or
   * surfaces a `MISSING_VERSION` error.
   *
   * Return any other value to mean "this is the version"; the registry
   * validates it through the comparator and rejects unsupported values with
   * `UNKNOWN_VERSION`.
   *
   * The function must be pure: same input ⇒ same output, no side effects.
   *
   * @example
   * ```ts
   * createRegistry({
   *   // ...
   *   resolveVersion: (input) => {
   *     if (typeof input !== 'object' || input === null) return undefined;
   *     return (input as { meta?: { schemaVersion?: number } }).meta?.schemaVersion;
   *   },
   * });
   * ```
   */
  readonly resolveVersion?: (input: unknown) => V | undefined;

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

  /**
   * Observability hook. Invoked once per migration step actually applied,
   * in pipeline order, *after* the migrator finishes successfully.
   *
   * Use it to wire migration traces into your logger, metrics, or telemetry
   * pipeline. The hook is non-blocking and its return value is ignored;
   * it is *not* called when no migration is applied (source already at
   * `latest`) or when migration fails.
   *
   * The hook should not throw. Thrown errors propagate and abort
   * `process(...)` — wrap with try/catch in user code if needed.
   */
  readonly onMigration?: (step: AppliedMigration) => void;

  /**
   * Observability hook. Invoked once per deprecation warning emitted,
   * including warnings produced by the source-schema walk and the
   * latest-schema walk.
   *
   * Use it to surface deprecations in real time (e.g. send to Sentry,
   * write a structured log line) without iterating `result.warnings`
   * yourself.
   *
   * The hook should not throw. Thrown errors propagate and abort
   * `process(...)` — wrap with try/catch in user code if needed.
   */
  readonly onDeprecation?: (issue: ValidationIssue) => void;
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

const withStage = (
  issues: readonly ValidationIssue[],
  stage: ValidationStage,
): readonly ValidationIssue[] => issues.map((i) => ({ ...i, stage }));

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
    // Strategy 1: user-supplied resolveVersion takes precedence.
    if (config.resolveVersion !== undefined) {
      const resolved = config.resolveVersion(input);
      if (resolved === undefined) {
        if (config.assumeVersion !== undefined) {
          return { ok: true, version: config.assumeVersion };
        }
        return {
          ok: false,
          issue: issue(
            'error',
            ErrorCode.MissingVersion,
            'resolveVersion returned undefined and no assumeVersion is configured.',
          ),
        };
      }
      if (!comparator.isVersion(resolved)) {
        return {
          ok: false,
          issue: issue(
            'error',
            ErrorCode.UnknownVersion,
            `resolveVersion returned an unsupported value: ${JSON.stringify(resolved)}.`,
            { rawValue: resolved },
          ),
        };
      }
      return { ok: true, version: resolved };
    }

    // Strategy 2: read the configured (or default) version field on the root.
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
      warnings.push(...withStage(sourceResult.warnings, 'source'));
      if (!sourceResult.ok) {
        return {
          ok: false,
          errors: withStage(sourceResult.errors, 'source'),
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
      if (config.onDeprecation !== undefined) {
        for (const w of sourceDeprecationWarnings) {
          config.onDeprecation(w);
        }
      }
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

    // When at least one migration ran, the document being validated is the
    // chain's output, not the caller's input: a failure there means a
    // migration under-delivered, and the issues are staged accordingly.
    const latestStage: ValidationStage = migrated.applied.length > 0 ? 'migrated' : 'source';

    const latestResult = latestSchema.validator.validate(migrated.data);
    warnings.push(...withStage(latestResult.warnings, latestStage));
    if (!latestResult.ok) {
      const staged = withStage(latestResult.errors, latestStage);
      const errors =
        latestStage === 'migrated'
          ? [
              {
                severity: 'error' as const,
                code: ErrorCode.MigrationOutputInvalid,
                message:
                  `Migrated output (${String(detectedVersion)} → ${String(latestVersion)}) ` +
                  'failed validation against the latest schema; the migration chain must ' +
                  'normalize the reported fields — fix the migration, not the input document.',
                path: '',
                stage: 'migrated' as const,
                meta: Object.freeze({
                  detectedVersion,
                  targetVersion: latestVersion,
                  appliedMigrations: migrated.applied,
                }),
              },
              ...staged,
            ]
          : staged;
      return {
        ok: false,
        errors,
        warnings,
        meta: {
          detectedVersion,
          targetVersion: latestVersion,
          appliedMigrations: migrated.applied,
        },
      };
    }

    // Migration succeeded and the latest document is structurally valid.
    // Notify observers, in pipeline order, before reporting deprecations.
    if (config.onMigration !== undefined) {
      for (const step of migrated.applied) {
        config.onMigration(step);
      }
    }

    const deprecationWarnings = collectDeprecationWarnings(
      latestResult.data,
      latestSchema.deprecated,
    );
    warnings.push(...deprecationWarnings);
    if (config.onDeprecation !== undefined) {
      for (const w of deprecationWarnings) {
        config.onDeprecation(w);
      }
    }

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
