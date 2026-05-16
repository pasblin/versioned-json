import { describe, expect, it } from 'vitest';

import { fromValidateFn } from '../validation/validatorAdapter.js';

import { DEPRECATED_FIELD_CODE } from './deprecation.js';
import { defineSchema } from './schema.js';

describe('defineSchema', () => {
  const passingValidator = fromValidateFn<{ foo: number }>((input) => ({
    ok: true,
    data: input as { foo: number },
    warnings: [],
  }));

  it('defaults deprecated to an empty array', () => {
    const schema = defineSchema({ version: 1, validator: passingValidator });
    expect(schema.deprecated).toEqual([]);
  });

  it('freezes the schema and the deprecated list', () => {
    const schema = defineSchema({
      version: 2,
      validator: passingValidator,
      deprecated: [{ path: 'foo', sinceVersion: 2 }],
    });

    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.deprecated)).toBe(true);
    // The frozen array is a defensive copy, so mutations on the caller's
    // original array don't leak into the schema.
    expect(() => {
      (schema.deprecated as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });

  it('takes a defensive copy of the deprecated input', () => {
    const input = [{ path: 'foo', sinceVersion: 2 } as const];
    const schema = defineSchema({
      version: 2,
      validator: passingValidator,
      deprecated: input,
    });
    // Mutating the caller's array does not affect the schema.
    (input as unknown as { length: number }).length = 0;
    expect(schema.deprecated).toHaveLength(1);
  });

  it('keeps DEPRECATED_FIELD_CODE as a stable string constant', () => {
    expect(DEPRECATED_FIELD_CODE).toBe('DEPRECATED_FIELD');
  });
});
