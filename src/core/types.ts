/**
 * Shared primitive types used across the library.
 *
 * @packageDocumentation
 */

/**
 * Any value that can be used as a document version identifier.
 *
 * The library treats versions as opaque values and delegates ordering to a
 * {@link VersionComparator}. Integers are the default, but strings (e.g. semver)
 * are equally valid as long as a comparator is provided.
 *
 * @public
 */
export type Version = number | string;

/**
 * Severity of a single {@link ValidationIssue}.
 *
 * - `error`: blocks the result; the document is considered invalid.
 * - `warning`: does not block; surfaced to the caller (e.g. deprecations).
 *
 * @public
 */
export type IssueSeverity = 'error' | 'warning';

/**
 * A single piece of feedback produced by a validator or by the migration
 * pipeline. Issues are data, not exceptions: they are returned inside
 * {@link ProcessResult} so callers can render them without `try/catch`.
 *
 * @public
 */
export interface ValidationIssue {
  /** Severity bucket. */
  readonly severity: IssueSeverity;
  /**
   * Stable machine-readable code (e.g. `'DEPRECATED_FIELD'`).
   *
   * Codes are part of the public contract: do not change their meaning across
   * versions of the library. Add new codes instead.
   */
  readonly code: string;
  /** Human-readable message. Safe to surface in UIs/logs. */
  readonly message: string;
  /**
   * JSON-pointer-like path to the offending value, e.g. `'items[0].sub.flag'`.
   *
   * Empty string when the issue refers to the document as a whole.
   */
  readonly path: string;
  /** Optional structured payload for tooling. Must be JSON-serialisable. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Metadata produced by {@link Registry.process | a registry run}.
 *
 * Exposed so callers can build telemetry without re-deriving the data.
 *
 * @public
 */
export interface ProcessMeta {
  /** The version detected on the raw input. */
  readonly detectedVersion: Version;
  /** The version of the schema used for the final validation. */
  readonly targetVersion: Version;
  /**
   * Ordered list of migrations applied to reach `targetVersion`.
   *
   * Empty array means the document was already at the target version.
   */
  readonly appliedMigrations: readonly {
    readonly from: Version;
    readonly to: Version;
  }[];
}

/**
 * Successful branch of {@link ProcessResult}.
 *
 * @public
 */
export interface ProcessOk<T> {
  readonly ok: true;
  /** The validated, fully-migrated document, typed as the latest version. */
  readonly data: T;
  /** Non-blocking issues (deprecations, soft warnings, etc.). */
  readonly warnings: readonly ValidationIssue[];
  /** Run metadata. */
  readonly meta: ProcessMeta;
}

/**
 * Failure branch of {@link ProcessResult}.
 *
 * Note that {@link ProcessErr.warnings | warnings} are still surfaced even on
 * failure: callers may want to display "your document is deprecated AND
 * invalid".
 *
 * @public
 */
export interface ProcessErr {
  readonly ok: false;
  /** Blocking issues. Non-empty by construction. */
  readonly errors: readonly ValidationIssue[];
  /** Non-blocking issues collected before the failure. */
  readonly warnings: readonly ValidationIssue[];
  /**
   * Run metadata. May be partial: e.g. when version detection fails we still
   * report `detectedVersion` as the raw value seen (or `null`).
   */
  readonly meta: Partial<ProcessMeta>;
}

/**
 * Discriminated union returned by every top-level operation in the library.
 *
 * Use the `ok` discriminant for narrowing:
 *
 * ```ts
 * const r = registry.process(json);
 * if (r.ok) {
 *   r.data; // typed as TLatest
 * } else {
 *   r.errors; // ReadonlyArray<ValidationIssue>
 * }
 * ```
 *
 * @public
 */
export type ProcessResult<T> = ProcessOk<T> | ProcessErr;

/**
 * Generic, lower-level result used by adapters and internal helpers.
 *
 * Differs from {@link ProcessResult} in that it carries no metadata; reserved
 * for building blocks like {@link ValidatorAdapter} implementations.
 *
 * @public
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly data: T; readonly warnings: readonly ValidationIssue[] }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationIssue[];
      readonly warnings: readonly ValidationIssue[];
    };
