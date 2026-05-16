import { describe, expect, it } from 'vitest';

import { fromValidateFn, type ValidatorAdapter } from './validatorAdapter.js';

describe('ValidatorAdapter / fromValidateFn', () => {
  it('wraps a function into an adapter', () => {
    const adapter: ValidatorAdapter<number> = fromValidateFn((input) => {
      if (typeof input === 'number') {
        return { ok: true, data: input, warnings: [] };
      }
      return {
        ok: false,
        errors: [{ severity: 'error', code: 'NOT_A_NUMBER', message: 'expected number', path: '' }],
        warnings: [],
      };
    });

    const okResult = adapter.validate(42);
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.data).toBe(42);
    }

    const errResult = adapter.validate('nope');
    expect(errResult.ok).toBe(false);
    if (!errResult.ok) {
      expect(errResult.errors[0]?.code).toBe('NOT_A_NUMBER');
    }
  });
});
