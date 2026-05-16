import { describe, expect, it } from 'vitest';

import { InvalidRegistryError, MigrationFailedError, MigrationGapError } from '../core/errors.js';
import { integerVersionComparator } from '../core/versionComparator.js';

import { defineMigration } from './migration.js';
import { createMigrator } from './migrator.js';

const m1to2 = defineMigration({
  from: 1,
  to: 2,
  up: (doc: { foo: number }) => ({ ...doc, bar: 'b' }),
});

const m2to3 = defineMigration({
  from: 2,
  to: 3,
  up: (doc: { foo: number; bar: string }) => ({ ...doc, baz: true }),
});

const m3to4 = defineMigration({
  from: 3,
  to: 4,
  up: (doc: { foo: number; bar: string; baz: boolean }) => ({
    ...doc,
    qux: [] as readonly string[],
  }),
});

describe('createMigrator', () => {
  it('returns the input unchanged when from === to', () => {
    const migrator = createMigrator({
      migrations: [m1to2, m2to3],
      comparator: integerVersionComparator,
    });
    const result = migrator.migrate({ foo: 1 }, 2, 2);
    expect(result.applied).toEqual([]);
    expect(result.data).toEqual({ foo: 1 });
  });

  it('walks the chain step by step and reports the trace', () => {
    const migrator = createMigrator({
      migrations: [m1to2, m2to3, m3to4],
      comparator: integerVersionComparator,
    });
    const result = migrator.migrate({ foo: 7 }, 1, 4);
    expect(result.applied).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ]);
    expect(result.data).toEqual({ foo: 7, bar: 'b', baz: true, qux: [] });
  });

  it('throws MigrationGapError when a step is missing', () => {
    const migrator = createMigrator({
      migrations: [m1to2, m3to4], // missing 2 -> 3
      comparator: integerVersionComparator,
    });
    try {
      migrator.migrate({ foo: 1 }, 1, 4);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationGapError);
      const err = e as MigrationGapError;
      expect(err.missingFrom).toBe(2);
      expect(err.missingTo).toBe(4);
    }
  });

  it('throws MigrationFailedError preserving the cause when `up` throws', () => {
    const exploding = defineMigration({
      from: 1,
      to: 2,
      up: () => {
        throw new TypeError('kaboom');
      },
    });
    const migrator = createMigrator({
      migrations: [exploding],
      comparator: integerVersionComparator,
    });
    try {
      migrator.migrate({ foo: 1 }, 1, 2);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationFailedError);
      const err = e as MigrationFailedError;
      expect(err.from).toBe(1);
      expect(err.to).toBe(2);
      expect(err.cause).toBeInstanceOf(TypeError);
    }
  });

  it('rejects duplicate `from` versions at build time', () => {
    expect(() =>
      createMigrator({
        migrations: [m1to2, m1to2],
        comparator: integerVersionComparator,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects migrations that do not move forward', () => {
    const backwards = defineMigration({
      from: 2,
      to: 1,
      up: (doc: object) => doc,
    });
    expect(() =>
      createMigrator({
        migrations: [backwards],
        comparator: integerVersionComparator,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects an explicit backwards migrate() request', () => {
    const migrator = createMigrator({
      migrations: [m1to2],
      comparator: integerVersionComparator,
    });
    expect(() => migrator.migrate({}, 2, 1)).toThrow(InvalidRegistryError);
  });

  it('throws MigrationGapError when the chain overshoots the target', () => {
    // A skipping migration jumps 1 -> 3 directly; asking for 2 lands beyond
    // the target without a stop, which must surface as a gap.
    const skip = defineMigration({
      from: 1,
      to: 3,
      up: (doc: object) => doc,
    });
    const migrator = createMigrator({
      migrations: [skip],
      comparator: integerVersionComparator,
    });
    expect(() => migrator.migrate({}, 1, 2)).toThrow(MigrationGapError);
  });

  it('hasFrom reports the indexed source versions', () => {
    const migrator = createMigrator({
      migrations: [m1to2, m2to3],
      comparator: integerVersionComparator,
    });
    expect(migrator.hasFrom(1)).toBe(true);
    expect(migrator.hasFrom(2)).toBe(true);
    expect(migrator.hasFrom(3)).toBe(false);
  });
});
