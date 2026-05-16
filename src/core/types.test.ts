import { describe, expectTypeOf, it } from 'vitest';

import type { ProcessResult, ValidationIssue, ValidationResult, Version } from './types.js';

describe('core/types', () => {
  it('Version accepts numbers and strings', () => {
    expectTypeOf<number>().toExtend<Version>();
    expectTypeOf<string>().toExtend<Version>();
    expectTypeOf<boolean>().not.toExtend<Version>();
  });

  it('ProcessResult discriminates on ok', () => {
    const sample = {} as ProcessResult<{ foo: number }>;
    if (sample.ok) {
      expectTypeOf(sample.data).toEqualTypeOf<{ foo: number }>();
    } else {
      expectTypeOf(sample.errors).toEqualTypeOf<readonly ValidationIssue[]>();
    }
  });

  it('ValidationResult is independent of ProcessMeta', () => {
    const v = {} as ValidationResult<string>;
    if (v.ok) {
      expectTypeOf(v.data).toEqualTypeOf<string>();
    }
  });
});
