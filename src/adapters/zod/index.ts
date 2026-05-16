/**
 * Zod adapter for {@link ValidatorAdapter}.
 *
 * Available under the `@pasblin/versioned-json/zod` sub-path. `zod` is an
 * optional peer dependency — install it in your consumer project to use
 * this adapter.
 *
 * @packageDocumentation
 */

import type { ZodIssue, ZodType } from 'zod';

import type { ValidationIssue, ValidationResult } from '../../core/types.js';
import type { ValidatorAdapter } from '../../validation/validatorAdapter.js';

/**
 * Stable prefix used on every issue code produced by this adapter. Concrete
 * codes look like `'ZOD_invalid_type'`, `'ZOD_custom'`, etc.
 *
 * @public
 */
export const ZOD_ISSUE_PREFIX = 'ZOD_' as const;

/**
 * Renders a Zod path (mix of string keys and numeric indices) into the dot /
 * bracket notation used by the rest of the library.
 *
 * @internal
 */
const formatPath = (path: readonly (string | number)[]): string => {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${String(seg)}]`;
    } else {
      out += out.length === 0 ? seg : `.${seg}`;
    }
  }
  return out;
};

const toValidationIssue = (issue: ZodIssue): ValidationIssue => ({
  severity: 'error',
  code: `${ZOD_ISSUE_PREFIX}${issue.code}`,
  message: issue.message,
  path: formatPath(issue.path as readonly (string | number)[]),
  meta: Object.freeze({ zodIssue: issue }),
});

/**
 * Wraps a Zod schema in a {@link ValidatorAdapter}.
 *
 * On success, the adapter returns the *parsed* output of the schema (so any
 * Zod-applied defaults, transforms or coercions are reflected in the data
 * that downstream migrations and consumers see).
 *
 * On failure, every Zod issue becomes a {@link ValidationIssue} with:
 *
 * - `severity: 'error'`,
 * - `code: 'ZOD_<zod-code>'` (e.g. `'ZOD_invalid_type'`),
 * - `path` rendered in dot/bracket notation,
 * - the original Zod issue preserved on `meta.zodIssue` for tooling.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { defineSchema } from '@pasblin/versioned-json';
 * import { zodAdapter } from '@pasblin/versioned-json/zod';
 *
 * const v4 = z.object({ version: z.literal(4), title: z.string() });
 * const schemaV4 = defineSchema({ version: 4, validator: zodAdapter(v4) });
 * ```
 *
 * @public
 */
export const zodAdapter = <T>(schema: ZodType<T>): ValidatorAdapter<T> => ({
  validate: (input: unknown): ValidationResult<T> => {
    const result = schema.safeParse(input);
    if (result.success) {
      return { ok: true, data: result.data, warnings: [] };
    }
    return {
      ok: false,
      errors: result.error.issues.map(toValidationIssue),
      warnings: [],
    };
  },
});
