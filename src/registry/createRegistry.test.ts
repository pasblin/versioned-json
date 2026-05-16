import { describe, expect, it } from 'vitest';

import {
  ErrorCode,
  InvalidRegistryError,
  MigrationGapError,
  ValidationFailedError,
} from '../core/errors.js';
import type { ValidationIssue } from '../core/types.js';
import { defineMigration } from '../migration/migration.js';
import { defineSchema } from '../schema/schema.js';
import { fromValidateFn, type ValidatorAdapter } from '../validation/validatorAdapter.js';

import { createRegistry } from './createRegistry.js';

// ---------------------------------------------------------------------------
// Test fixtures: a minimal three-version document family.
// ---------------------------------------------------------------------------

interface DocV1 {
  readonly version: 1;
  readonly title: string;
}
interface DocV2 {
  readonly version: 2;
  readonly title: string;
  readonly tags: readonly string[];
}
interface DocV3 {
  readonly version: 3;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status: 'draft' | 'published';
}

const passThrough = <T>(): ValidatorAdapter<T> =>
  fromValidateFn<T>((input) => ({ ok: true, data: input as T, warnings: [] }));

const rejecting = <T>(message: string): ValidatorAdapter<T> =>
  fromValidateFn<T>(() => ({
    ok: false,
    errors: [{ severity: 'error', code: 'BAD', message, path: '' } satisfies ValidationIssue],
    warnings: [],
  }));

const schemaV1 = defineSchema<1, DocV1>({ version: 1, validator: passThrough<DocV1>() });
const schemaV2 = defineSchema<2, DocV2>({ version: 2, validator: passThrough<DocV2>() });
const schemaV3 = defineSchema<3, DocV3>({
  version: 3,
  validator: passThrough<DocV3>(),
  deprecated: [{ path: 'title', sinceVersion: 3 }],
});

const m1to2 = defineMigration({
  from: 1,
  to: 2,
  up: (d: DocV1): DocV2 => ({ ...d, version: 2, tags: [] }),
});
const m2to3 = defineMigration({
  from: 2,
  to: 3,
  up: (d: DocV2): DocV3 => ({ ...d, version: 3, status: 'draft' }),
});

const buildRegistry = () =>
  createRegistry({
    schemas: [schemaV1, schemaV2, schemaV3],
    migrations: [m1to2, m2to3],
    latest: schemaV3,
  });

// ---------------------------------------------------------------------------

describe('createRegistry – construction invariants', () => {
  it('rejects an empty schema list', () => {
    expect(() =>
      createRegistry({
        schemas: [],
        migrations: [],
        // We must still provide a `latest`; fabricate one knowing it'll fail
        // earlier on the empty list check.
        latest: schemaV3,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects duplicate schema versions', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV1],
        migrations: [],
        latest: schemaV1,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects when latest schema is not in schemas', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2],
        migrations: [m1to2],
        latest: schemaV3,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects when `latest` shares its version with `schemas` but is a different reference', () => {
    // A common pitfall: defining the latest schema twice (once when wired
    // into the schemas array, once when passed as `latest`). The reference
    // mismatch is rejected so callers don't accidentally validate against
    // a different schema than the one declared.
    const v3Twin = defineSchema<3, DocV3>({ version: 3, validator: passThrough<DocV3>() });
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2, m2to3],
        latest: v3Twin,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('detects a gap in the contiguous chain', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2], // missing 2 -> 3
        latest: schemaV3,
      }),
    ).toThrow(MigrationGapError);
  });

  it('accepts a registry with no migrations when latest == minSupported', () => {
    const registry = createRegistry({
      schemas: [schemaV3],
      migrations: [],
      latest: schemaV3,
    });
    expect(registry.latest).toBe(3);
    expect(registry.minSupportedVersion).toBe(3);
  });

  it('defaults minSupportedVersion to the smallest registered version', () => {
    const registry = buildRegistry();
    expect(registry.minSupportedVersion).toBe(1);
  });

  it('honours an explicit minSupportedVersion', () => {
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
      minSupportedVersion: 2,
    });
    expect(registry.minSupportedVersion).toBe(2);
  });

  it('rejects schema versions the comparator does not accept', () => {
    // The default integer comparator rejects negative integers; defining a
    // schema with version -1 must blow up at construction time, not later.
    const bad = defineSchema({
      version: -1 as unknown as 1,
      validator: passThrough<DocV1>(),
    });
    expect(() => createRegistry({ schemas: [bad], migrations: [], latest: bad })).toThrow(
      InvalidRegistryError,
    );
  });

  it('rejects minSupportedVersion not accepted by the comparator', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2, m2to3],
        latest: schemaV3,
        minSupportedVersion: -1 as unknown as 1,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects minSupportedVersion that is not registered as a schema', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2, m2to3],
        latest: schemaV3,
        // 99 is a valid integer but no schema for it exists.
        minSupportedVersion: 99 as unknown as 1,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects minSupportedVersion greater than latest', () => {
    // Build a registry whose latest is v2 but require docs to be at least
    // v3 (which is registered as a schema but lies past `latest`).
    expect(() =>
      // The `as` cast widens schemaV2 to Schema<3, ...> at the type level
      // so we can express the misconfiguration; the runtime check catches
      // it regardless.
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2],
        latest: schemaV2 as unknown as typeof schemaV3,
        minSupportedVersion: 3,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('rejects assumeVersion not accepted by the comparator', () => {
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to2, m2to3],
        latest: schemaV3,
        assumeVersion: -1 as unknown as 1,
      }),
    ).toThrow(InvalidRegistryError);
  });

  it('detects a broken chain when a migration target skips the next version', () => {
    // schemas [1,2,3] but the only migration available from v1 jumps to v3
    // directly, leaving the (1, 2) pair without a matching migration.
    const m1to3 = defineMigration({
      from: 1,
      to: 3,
      up: (d: DocV1): DocV3 => ({ ...d, version: 3, tags: [], status: 'draft' }),
    });
    expect(() =>
      createRegistry({
        schemas: [schemaV1, schemaV2, schemaV3],
        migrations: [m1to3, m2to3],
        latest: schemaV3,
      }),
    ).toThrow(MigrationGapError);
  });
});

describe('createRegistry – process happy path', () => {
  it('migrates a v1 document up to v3 and emits deprecation warnings', () => {
    const registry = buildRegistry();
    const result = registry.process({ version: 1, title: 'hello' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual({
      version: 3,
      title: 'hello',
      tags: [],
      status: 'draft',
    });
    expect(result.meta.detectedVersion).toBe(1);
    expect(result.meta.targetVersion).toBe(3);
    expect(result.meta.appliedMigrations).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('DEPRECATED_FIELD');
  });

  it('returns identity (no migrations applied) for a doc already at latest', () => {
    const registry = buildRegistry();
    const result = registry.process({
      version: 3,
      title: 't',
      tags: ['a'],
      status: 'published',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.appliedMigrations).toEqual([]);
  });

  it('emits deprecation warnings declared on a source schema even when the migration removes the field', () => {
    // Regression for the original behaviour where deprecations were only
    // walked on the post-migration latest document. A field declared
    // deprecated in the source schema and renamed away by the migration
    // chain produced no warning, even though the field existed in the input.
    interface OldDocV1 {
      readonly version: 1;
      readonly oldName: string;
    }
    interface OldDocV2 {
      readonly version: 2;
      readonly newName: string;
    }
    const sourceWithDeprecation = defineSchema<1, OldDocV1>({
      version: 1,
      validator: passThrough<OldDocV1>(),
      deprecated: [
        {
          path: 'oldName',
          sinceVersion: 1,
          plannedRemovalVersion: 2,
          replacement: 'newName',
        },
      ],
    });
    const cleanLatest = defineSchema<2, OldDocV2>({
      version: 2,
      validator: passThrough<OldDocV2>(),
    });
    const renaming = defineMigration({
      from: 1,
      to: 2,
      up: (d: OldDocV1): OldDocV2 => ({ version: 2, newName: d.oldName }),
    });
    const registry = createRegistry({
      schemas: [sourceWithDeprecation, cleanLatest],
      migrations: [renaming],
      latest: cleanLatest,
    });

    const result = registry.process({ version: 1, oldName: 'foo' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deprecationWarnings = result.warnings.filter((w) => w.code === 'DEPRECATED_FIELD');
    expect(deprecationWarnings).toHaveLength(1);
    expect(deprecationWarnings[0]?.path).toBe('oldName');
    expect(deprecationWarnings[0]?.meta?.['sinceVersion']).toBe(1);
    expect(deprecationWarnings[0]?.meta?.['replacement']).toBe('newName');

    // Sanity: the migrated doc should no longer carry the deprecated field.
    expect(result.data).toEqual({ version: 2, newName: 'foo' });
  });

  it('does not double-emit warnings when source === latest (single walk)', () => {
    // Guard against a regression where source and latest deprecations both
    // fire on the same doc when the input is already at the latest version.
    const registry = buildRegistry();
    const result = registry.process({
      version: 3,
      title: 't',
      tags: ['a'],
      status: 'published',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deprecationWarnings = result.warnings.filter((w) => w.code === 'DEPRECATED_FIELD');
    // schemaV3 declares `title` deprecated; the field is present once → exactly one warning.
    expect(deprecationWarnings).toHaveLength(1);
    expect(deprecationWarnings[0]?.path).toBe('title');
  });
});

describe('createRegistry – process error branches', () => {
  it('errors on missing version field', () => {
    const registry = buildRegistry();
    const result = registry.process({ title: 'no version' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.MissingVersion);
  });

  it('errors on non-object inputs (null, array, primitive)', () => {
    const registry = buildRegistry();
    for (const input of [null, ['not', 'an', 'object'], 'string', 42]) {
      const result = registry.process(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.code).toBe(ErrorCode.MissingVersion);
    }
  });

  it('honours assumeVersion when input is not even an object', () => {
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
      assumeVersion: 3,
    });
    // A primitive input has no version field; assumeVersion=3 means
    // "treat as already-latest". Pass-through validators accept anything.
    const result = registry.process('legacy-blob');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.detectedVersion).toBe(3);
  });

  it('uses assumeVersion when configured and version is missing', () => {
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
      assumeVersion: 1,
    });
    const result = registry.process({ title: 'no version' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.detectedVersion).toBe(1);
  });

  it('errors on future versions', () => {
    const registry = buildRegistry();
    const result = registry.process({ version: 99, title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.FutureVersion);
  });

  it('errors on retired versions when minSupportedVersion is bumped', () => {
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
      minSupportedVersion: 2,
    });
    const result = registry.process({ version: 1, title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.UnsupportedLegacyVersion);
  });

  it('errors on non-integer version values', () => {
    const registry = buildRegistry();
    const result = registry.process({ version: '1', title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.UnknownVersion);
  });

  it('errors when an intermediate, unregistered version is detected', () => {
    // Realistic scenario: a registry whose registered versions are 1, 2
    // and 4 (a `3` was never published — perhaps it was retired or never
    // existed). A document declaring `version: 3` falls inside [min,
    // latest] but maps to no schema; gating must flag it as
    // UNKNOWN_VERSION instead of silently picking a neighbour.
    interface Tiny1 {
      readonly version: 1;
      readonly a: number;
    }
    interface Tiny2 {
      readonly version: 2;
      readonly a: number;
      readonly b: number;
    }
    interface Tiny4 {
      readonly version: 4;
      readonly a: number;
      readonly b: number;
      readonly c: number;
    }

    const t1 = defineSchema<1, Tiny1>({ version: 1, validator: passThrough<Tiny1>() });
    const t2 = defineSchema<2, Tiny2>({ version: 2, validator: passThrough<Tiny2>() });
    const t4 = defineSchema<4, Tiny4>({ version: 4, validator: passThrough<Tiny4>() });

    const m1to2t = defineMigration<1, 2, Tiny1, Tiny2>({
      from: 1,
      to: 2,
      up: (d) => ({ ...d, version: 2, b: 0 }),
    });
    const m2to4t = defineMigration<2, 4, Tiny2, Tiny4>({
      from: 2,
      to: 4,
      up: (d) => ({ ...d, version: 4, c: 0 }),
    });

    const skippy = createRegistry({
      schemas: [t1, t2, t4],
      migrations: [m1to2t, m2to4t],
      latest: t4,
    });

    const result = skippy.process({ version: 3, a: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.UnknownVersion);
  });

  it('errors when the source schema rejects the input in strict mode', () => {
    const registry = createRegistry({
      schemas: [
        defineSchema<1, DocV1>({ version: 1, validator: rejecting<DocV1>('bad v1') }),
        schemaV2,
        schemaV3,
      ],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
    });
    const result = registry.process({ version: 1, title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toBe('bad v1');
  });

  it('skips source validation when strictSource is false', () => {
    const registry = createRegistry({
      schemas: [
        defineSchema<1, DocV1>({ version: 1, validator: rejecting<DocV1>('bad v1') }),
        schemaV2,
        schemaV3,
      ],
      migrations: [m1to2, m2to3],
      latest: schemaV3,
      strictSource: false,
    });
    const result = registry.process({ version: 1, title: 't' });
    // Source rejected but ignored; latest schema accepts the migrated doc.
    expect(result.ok).toBe(true);
  });

  it('errors when the latest schema rejects the migrated document', () => {
    const rejectingV3 = defineSchema<3, DocV3>({
      version: 3,
      validator: rejecting<DocV3>('bad v3'),
    });
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, rejectingV3],
      migrations: [m1to2, m2to3],
      latest: rejectingV3,
    });
    const result = registry.process({ version: 1, title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toBe('bad v3');
    expect(result.meta.appliedMigrations).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });

  it('captures migration failures as errors instead of throwing', () => {
    const breaking = defineMigration({
      from: 2,
      to: 3,
      up: (): DocV3 => {
        throw new TypeError('migration kaboom');
      },
    });
    const registry = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3],
      migrations: [m1to2, breaking],
      latest: schemaV3,
    });
    const result = registry.process({ version: 1, title: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.MigrationFailed);
    expect(result.errors[0]?.meta?.['cause']).toContain('migration kaboom');
  });
});

describe('createRegistry – processOrThrow', () => {
  it('returns the data on success', () => {
    const registry = buildRegistry();
    const data = registry.processOrThrow({ version: 1, title: 't' });
    expect(data.version).toBe(3);
  });

  it('throws ValidationFailedError on failure', () => {
    const registry = buildRegistry();
    expect(() => registry.processOrThrow({ title: 'no version' })).toThrow(ValidationFailedError);
  });
});
