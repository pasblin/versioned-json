import { describe, expect, it } from 'vitest';

import {
  integerVersionComparator,
  lexicographicVersionComparator,
  type VersionComparator,
} from './versionComparator.js';

describe('integerVersionComparator', () => {
  it('returns negative, zero and positive consistently', () => {
    expect(integerVersionComparator.compare(1, 2)).toBeLessThan(0);
    expect(integerVersionComparator.compare(2, 2)).toBe(0);
    expect(integerVersionComparator.compare(3, 2)).toBeGreaterThan(0);
  });

  it('accepts only non-negative finite integers', () => {
    expect(integerVersionComparator.isVersion(0)).toBe(true);
    expect(integerVersionComparator.isVersion(42)).toBe(true);
    expect(integerVersionComparator.isVersion(-1)).toBe(false);
    expect(integerVersionComparator.isVersion(1.5)).toBe(false);
    expect(integerVersionComparator.isVersion(Number.NaN)).toBe(false);
    expect(integerVersionComparator.isVersion(Number.POSITIVE_INFINITY)).toBe(false);
    expect(integerVersionComparator.isVersion('1')).toBe(false);
    expect(integerVersionComparator.isVersion(null)).toBe(false);
  });

  it('throws when given non-integer values via compare', () => {
    expect(() => integerVersionComparator.compare(1.2, 2)).toThrow(TypeError);
  });

  it('is antisymmetric for every pair', () => {
    const pairs: readonly (readonly [number, number])[] = [
      [0, 1],
      [5, 5],
      [10, 3],
    ];
    for (const [a, b] of pairs) {
      const ab = integerVersionComparator.compare(a, b);
      const ba = integerVersionComparator.compare(b, a);
      // a < b  =>  ab < 0 and ba > 0  (and vice versa); a === b => both 0.
      expect(ab === 0 ? ba : Math.sign(ab) + Math.sign(ba)).toBe(0);
    }
  });

  it('sorts a real-world version list', () => {
    const sorted = [4, 1, 3, 2].slice().sort(integerVersionComparator.compare);
    expect(sorted).toEqual([1, 2, 3, 4]);
  });
});

describe('lexicographicVersionComparator', () => {
  it('orders non-empty strings', () => {
    expect(lexicographicVersionComparator.compare('a', 'b')).toBeLessThan(0);
    expect(lexicographicVersionComparator.compare('z', 'a')).toBeGreaterThan(0);
    expect(lexicographicVersionComparator.compare('foo', 'foo')).toBe(0);
  });

  it('rejects empty strings and non-string values', () => {
    expect(lexicographicVersionComparator.isVersion('')).toBe(false);
    expect(lexicographicVersionComparator.isVersion(0)).toBe(false);
    expect(lexicographicVersionComparator.isVersion(undefined)).toBe(false);
  });

  it('throws when given an empty string or a non-string via compare', () => {
    expect(() => lexicographicVersionComparator.compare('', 'a')).toThrow(TypeError);
    expect(() => lexicographicVersionComparator.compare('a', 42 as unknown as string)).toThrow(
      TypeError,
    );
  });
});

describe('VersionComparator (interface)', () => {
  it('admits custom implementations for e.g. semver-like tuples', () => {
    const tupleComparator: VersionComparator<string> = {
      isVersion: (v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v),
      compare: (a, b) => {
        const pa = a.split('.').map((s) => Number.parseInt(s, 10));
        const pb = b.split('.').map((s) => Number.parseInt(s, 10));
        for (let i = 0; i < 3; i += 1) {
          const ai = pa[i] ?? 0;
          const bi = pb[i] ?? 0;
          if (ai !== bi) return ai - bi;
        }
        return 0;
      },
    };

    expect(tupleComparator.isVersion('1.2.3')).toBe(true);
    expect(tupleComparator.isVersion('1.2')).toBe(false);
    expect(tupleComparator.compare('1.2.3', '1.10.0')).toBeLessThan(0);
  });
});
