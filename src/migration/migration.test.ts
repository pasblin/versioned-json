import { describe, expect, it } from 'vitest';

import { defineMigration } from './migration.js';

describe('defineMigration', () => {
  it('builds a frozen migration with only `up`', () => {
    const m = defineMigration({
      from: 1,
      to: 2,
      up: (doc: { foo: number }) => ({ ...doc, bar: 'default' }),
    });

    expect(Object.isFrozen(m)).toBe(true);
    expect(m.from).toBe(1);
    expect(m.to).toBe(2);
    expect(m.down).toBeUndefined();
    expect(m.up({ foo: 1 })).toEqual({ foo: 1, bar: 'default' });
  });

  it('preserves `down` when provided', () => {
    const m = defineMigration({
      from: 1,
      to: 2,
      up: (doc: { foo: number }) => ({ ...doc, bar: 'x' }),
      down: (doc) => ({ foo: doc.foo }),
    });

    expect(m.down).toBeDefined();
    expect(m.down?.({ foo: 7, bar: 'x' })).toEqual({ foo: 7 });
  });

  it('does not silently add a `down` key when omitted (exactOptionalPropertyTypes)', () => {
    const m = defineMigration({
      from: 1,
      to: 2,
      up: (doc: object) => doc,
    });
    expect(Object.prototype.hasOwnProperty.call(m, 'down')).toBe(false);
  });
});
