import { describe, expect, it } from 'vitest';

import { InvalidRegistryError } from './errors.js';
import { invariant } from './invariant.js';

describe('invariant', () => {
  it('returns the value when it is defined', () => {
    expect(invariant(0, 'zero must pass')).toBe(0);
    expect(invariant('', 'empty string must pass')).toBe('');
    expect(invariant(false, 'false must pass')).toBe(false);
    const obj = { a: 1 } as const;
    expect(invariant(obj, 'object must pass')).toBe(obj);
  });

  it('throws InvalidRegistryError on undefined', () => {
    expect(() => invariant(undefined, 'expected')).toThrow(InvalidRegistryError);
  });

  it('throws InvalidRegistryError on null', () => {
    expect(() => invariant(null, 'expected')).toThrow(InvalidRegistryError);
  });

  it('preserves the caller-supplied message', () => {
    try {
      invariant(undefined, 'cursor out of range');
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRegistryError);
      expect((e as Error).message).toContain('cursor out of range');
    }
  });
});
