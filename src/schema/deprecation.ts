/**
 * Field-level deprecation metadata.
 *
 * Per project policy we *never* remove fields directly: we mark them as
 * deprecated for at least one major version so consumers have time to migrate
 * to the replacement. The schema records each deprecation; the registry
 * surfaces them as {@link ValidationIssue | warnings} on every
 * {@link ProcessResult}.
 *
 * The runtime walker that materialises warnings lives in
 * `./deprecationWalker.ts` and is added in a follow-up commit.
 *
 * @packageDocumentation
 */

import type { Version } from '../core/types.js';

/**
 * Declarative description of a deprecated field.
 *
 * `path` follows a small, JSON-pointer-like syntax:
 *
 * - Dot notation for object keys: `items.sub.flag`.
 * - Bracket notation for arrays: `items[0].sub.flag` (numeric index) or
 *   `items[*].sub.flag` (wildcard, matches every element).
 *
 * Whitespace and other separators are not supported on purpose: the syntax
 * stays small so the walker remains predictable.
 *
 * @public
 */
export interface DeprecatedField {
  /** Path of the deprecated property inside the document. */
  readonly path: string;
  /** Version in which the deprecation was introduced. */
  readonly sinceVersion: Version;
  /**
   * Optional version in which the field is scheduled to be removed.
   *
   * When set, the warning includes it so consumers can plan their migration.
   */
  readonly plannedRemovalVersion?: Version;
  /** Human-readable explanation. Surfaced verbatim in the warning message. */
  readonly reason?: string;
  /**
   * Suggested replacement (e.g. another field path or a doc URL). Surfaced
   * verbatim in the warning message.
   */
  readonly replacement?: string;
}

/**
 * Stable issue code emitted for every deprecation hit.
 *
 * Re-exported here so callers can match on it without importing the walker.
 *
 * @public
 */
export const DEPRECATED_FIELD_CODE = 'DEPRECATED_FIELD' as const;
