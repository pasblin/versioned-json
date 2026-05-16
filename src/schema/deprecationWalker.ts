/**
 * Materialises the warnings declared by a schema's `deprecated` list.
 *
 * Given a validated document and a list of {@link DeprecatedField}
 * descriptors, this module walks the document and emits one
 * {@link ValidationIssue | warning} per *present* deprecated path. Missing
 * fields produce no warning (the user has nothing to migrate).
 *
 * Each descriptor's path is parsed lazily on first use and cached in a
 * `WeakMap` keyed by the descriptor reference, so repeated runs on the same
 * registry never re-parse.
 *
 * @packageDocumentation
 */

import type { ValidationIssue } from '../core/types.js';

import { DEPRECATED_FIELD_CODE, type DeprecatedField } from './deprecation.js';
import { parsePath, walkPath, type PathSegment } from './path.js';

const segmentsCache = new WeakMap<DeprecatedField, readonly PathSegment[]>();

const getSegments = (field: DeprecatedField): readonly PathSegment[] => {
  const cached = segmentsCache.get(field);
  if (cached !== undefined) return cached;
  const parsed = parsePath(field.path);
  segmentsCache.set(field, parsed);
  return parsed;
};

const buildMessage = (field: DeprecatedField, resolvedPath: string): string => {
  const parts: string[] = [
    `Field "${resolvedPath}" is deprecated since version ${String(field.sinceVersion)}`,
  ];
  if (field.plannedRemovalVersion !== undefined) {
    parts.push(`and is scheduled for removal in version ${String(field.plannedRemovalVersion)}`);
  }
  let message = parts.join(' ');
  if (field.replacement !== undefined && field.replacement.length > 0) {
    message += `; use "${field.replacement}" instead`;
  }
  if (field.reason !== undefined && field.reason.length > 0) {
    message += ` (${field.reason})`;
  }
  return `${message}.`;
};

const buildMeta = (field: DeprecatedField): Readonly<Record<string, unknown>> => {
  const meta: Record<string, unknown> = {
    declaredPath: field.path,
    sinceVersion: field.sinceVersion,
  };
  if (field.plannedRemovalVersion !== undefined) {
    meta['plannedRemovalVersion'] = field.plannedRemovalVersion;
  }
  if (field.replacement !== undefined) {
    meta['replacement'] = field.replacement;
  }
  if (field.reason !== undefined) {
    meta['reason'] = field.reason;
  }
  return Object.freeze(meta);
};

/**
 * Returns one warning per *present* deprecated field in `doc`.
 *
 * The result is a fresh array; callers may safely mutate or spread it.
 *
 * @example
 * ```ts
 * const warnings = collectDeprecationWarnings(doc, schemaV4.deprecated);
 * for (const w of warnings) console.warn(w.message);
 * ```
 *
 * @public
 */
export const collectDeprecationWarnings = (
  doc: unknown,
  deprecated: readonly DeprecatedField[],
): readonly ValidationIssue[] => {
  if (deprecated.length === 0) return [];

  const issues: ValidationIssue[] = [];
  for (const field of deprecated) {
    const segments = getSegments(field);
    const hits = walkPath(doc, segments);
    for (const hit of hits) {
      issues.push({
        severity: 'warning',
        code: DEPRECATED_FIELD_CODE,
        path: hit.path,
        message: buildMessage(field, hit.path),
        meta: buildMeta(field),
      });
    }
  }
  return issues;
};
