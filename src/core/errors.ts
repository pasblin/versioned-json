/**
 * Error hierarchy thrown by the library.
 *
 * These errors model *programmer mistakes* and *impossible-to-recover*
 * situations. Recoverable problems (invalid documents, deprecations, etc.)
 * are represented as {@link ValidationIssue | validation issues} on a
 * {@link ProcessResult} instead.
 *
 * Every error carries a stable {@link VersionedJsonError.code | code} that is
 * part of the public contract — callers may switch on it. Codes are listed in
 * {@link ErrorCode}.
 *
 * @packageDocumentation
 */

import type { ValidationIssue, Version } from './types.js';

/**
 * Stable, machine-readable identifiers for each error class.
 *
 * Codes are immutable across library versions: once published they will not
 * change meaning. New codes may be added in minor releases.
 *
 * @public
 */
export const ErrorCode = {
  MissingVersion: 'MISSING_VERSION',
  UnknownVersion: 'UNKNOWN_VERSION',
  FutureVersion: 'FUTURE_VERSION',
  UnsupportedLegacyVersion: 'UNSUPPORTED_LEGACY_VERSION',
  MigrationGap: 'MIGRATION_GAP',
  MigrationFailed: 'MIGRATION_FAILED',
  MigrationOutputInvalid: 'MIGRATION_OUTPUT_INVALID',
  ValidationFailed: 'VALIDATION_FAILED',
  InvalidRegistry: 'INVALID_REGISTRY',
} as const;

/**
 * Union of every {@link ErrorCode} value.
 *
 * @public
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Base class for all errors thrown by `@pasblin/versioned-json`.
 *
 * Use {@link VersionedJsonError.code | `error.code`} for programmatic
 * branching; do not rely on `instanceof` checks across bundles, as multiple
 * copies of the library may coexist.
 *
 * @public
 */
export class VersionedJsonError extends Error {
  /** Stable identifier for this error class. See {@link ErrorCode}. */
  public readonly code: ErrorCodeValue;

  public constructor(code: ErrorCodeValue, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VersionedJsonError';
    this.code = code;
    // Restore the prototype chain for environments that down-compile classes
    // (Vitest with v8 coverage, older bundlers, etc.).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when the input document does not carry the configured version field
 * and no `assumeVersion` fallback was provided.
 *
 * @public
 */
export class MissingVersionError extends VersionedJsonError {
  public readonly versionField: string;

  public constructor(versionField: string, options?: { cause?: unknown }) {
    super(
      ErrorCode.MissingVersion,
      `Document does not contain the required version field "${versionField}".`,
      options,
    );
    this.name = 'MissingVersionError';
    this.versionField = versionField;
  }
}

/**
 * Raised when the document declares a version that is not registered in the
 * registry at all (e.g. a value that has never existed).
 *
 * Distinct from {@link UnsupportedLegacyVersionError} (intentional retirement)
 * and {@link FutureVersionError} (newer than `latest`).
 *
 * @public
 */
export class UnknownVersionError extends VersionedJsonError {
  public readonly detectedVersion: Version;

  public constructor(detectedVersion: Version, options?: { cause?: unknown }) {
    super(
      ErrorCode.UnknownVersion,
      `Detected version ${String(detectedVersion)} is not registered.`,
      options,
    );
    this.name = 'UnknownVersionError';
    this.detectedVersion = detectedVersion;
  }
}

/**
 * Raised when the detected version is newer than {@link Registry.latest}.
 *
 * Typically means the producing application is ahead of the consuming one and
 * the consumer must be upgraded.
 *
 * @public
 */
export class FutureVersionError extends VersionedJsonError {
  public readonly detectedVersion: Version;
  public readonly latestVersion: Version;

  public constructor(
    detectedVersion: Version,
    latestVersion: Version,
    options?: { cause?: unknown },
  ) {
    super(
      ErrorCode.FutureVersion,
      `Detected version ${String(detectedVersion)} is newer than the latest supported ` +
        `version ${String(latestVersion)}.`,
      options,
    );
    this.name = 'FutureVersionError';
    this.detectedVersion = detectedVersion;
    this.latestVersion = latestVersion;
  }
}

/**
 * Raised when the detected version was intentionally retired via
 * {@link RegistryConfig.minSupportedVersion}.
 *
 * Distinct from {@link UnknownVersionError}: the version *existed*, but the
 * registry no longer ships migrations for it.
 *
 * @public
 */
export class UnsupportedLegacyVersionError extends VersionedJsonError {
  public readonly detectedVersion: Version;
  public readonly minSupportedVersion: Version;

  public constructor(
    detectedVersion: Version,
    minSupportedVersion: Version,
    options?: { cause?: unknown },
  ) {
    super(
      ErrorCode.UnsupportedLegacyVersion,
      `Detected version ${String(detectedVersion)} has been retired; ` +
        `minimum supported version is ${String(minSupportedVersion)}.`,
      options,
    );
    this.name = 'UnsupportedLegacyVersionError';
    this.detectedVersion = detectedVersion;
    this.minSupportedVersion = minSupportedVersion;
  }
}

/**
 * Raised at *registry build time* (not at document-processing time) when the
 * configured migrations do not form a contiguous chain from
 * `minSupportedVersion` to `latest`.
 *
 * This guarantees that a registry that successfully builds is internally
 * consistent: no document that meets the version preconditions can hit a
 * missing migration in production.
 *
 * @public
 */
export class MigrationGapError extends VersionedJsonError {
  public readonly missingFrom: Version;
  public readonly missingTo: Version;

  public constructor(missingFrom: Version, missingTo: Version, options?: { cause?: unknown }) {
    super(
      ErrorCode.MigrationGap,
      `Missing migration from version ${String(missingFrom)} to ${String(missingTo)}.`,
      options,
    );
    this.name = 'MigrationGapError';
    this.missingFrom = missingFrom;
    this.missingTo = missingTo;
  }
}

/**
 * Raised when a migration's `up` callback throws.
 *
 * The original error is preserved via `cause`.
 *
 * @public
 */
export class MigrationFailedError extends VersionedJsonError {
  public readonly from: Version;
  public readonly to: Version;

  public constructor(from: Version, to: Version, options?: { cause?: unknown }) {
    super(
      ErrorCode.MigrationFailed,
      `Migration from version ${String(from)} to ${String(to)} threw an error.`,
      options,
    );
    this.name = 'MigrationFailedError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Raised by `processOrThrow`-style helpers when validation produces errors.
 *
 * The regular {@link Registry.process} flow returns errors as data on a
 * {@link ProcessResult}; this exception only exists for callers that prefer
 * a throwing API.
 *
 * @public
 */
export class ValidationFailedError extends VersionedJsonError {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[], options?: { cause?: unknown }) {
    super(
      ErrorCode.ValidationFailed,
      `Validation produced ${String(issues.length)} error(s).`,
      options,
    );
    this.name = 'ValidationFailedError';
    this.issues = issues;
  }
}

/**
 * Raised at registry build time for configuration mistakes that are not
 * gap-related: duplicate versions, latest not registered, etc.
 *
 * @public
 */
export class InvalidRegistryError extends VersionedJsonError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(ErrorCode.InvalidRegistry, message, options);
    this.name = 'InvalidRegistryError';
  }
}
