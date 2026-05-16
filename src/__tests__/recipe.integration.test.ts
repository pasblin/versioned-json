/**
 * End-to-end integration test exercising the full pipeline against a
 * recipe-shaped document family.
 *
 * Each fixture under `./recipe/fixtures/` represents a *real* historical
 * shape (v1..v4). The test asserts that the registry:
 *
 * - Migrates legacy versions up to the latest, filling in explicit defaults.
 * - Validates the final document with Zod.
 * - Surfaces deprecation warnings introduced in newer versions.
 * - Honours the lifecycle of `minSupportedVersion` (legacy retirement).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodAdapter } from '../adapters/zod/index.js';
import { ErrorCode } from '../core/errors.js';
import { defineMigration } from '../migration/migration.js';
import { createRegistry } from '../registry/createRegistry.js';
import { defineSchema } from '../schema/schema.js';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const loadFixture = (name: string): unknown => {
  const path = fileURLToPath(new URL(`./recipe/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

// ---------------------------------------------------------------------------
// Schemas — one Zod schema per historical version
// ---------------------------------------------------------------------------

const StepV1 = z.object({
  timer: z.object({ active: z.boolean() }),
  tags: z.array(z.string()),
});

const RecipeV1Shape = z.object({
  version: z.literal(1),
  title: z.string(),
  cuisine: z.string(),
  year: z.number().int(),
  type: z.enum(['Main', 'Side']),
  steps: z.array(StepV1),
});

const RecipeV2Shape = RecipeV1Shape.extend({
  version: z.literal(2),
  notes: z.string().default('NONE'),
});

const StepV3 = StepV1.extend({
  timing: z.object({
    method: z.string(),
    minMinutes: z.number().int().positive().optional(),
    maxMinutes: z.number().int().positive().optional(),
  }),
});

const RecipeV3Shape = RecipeV2Shape.extend({
  version: z.literal(3),
  cookbook: z.string().default('home'),
  steps: z.array(StepV3),
});

const StepV4 = StepV3.extend({
  category: z.string(),
});

const RecipeV4Shape = RecipeV3Shape.extend({
  version: z.literal(4),
  relatedDishes: z.array(z.string()).default([]),
  steps: z.array(StepV4),
});

type RecipeV1 = z.infer<typeof RecipeV1Shape>;
type RecipeV2 = z.infer<typeof RecipeV2Shape>;
type RecipeV3 = z.infer<typeof RecipeV3Shape>;
type RecipeV4 = z.infer<typeof RecipeV4Shape>;

const schemaV1 = defineSchema<1, RecipeV1>({
  version: 1,
  validator: zodAdapter(RecipeV1Shape),
});

const schemaV2 = defineSchema<2, RecipeV2>({
  version: 2,
  validator: zodAdapter(RecipeV2Shape),
});

const schemaV3 = defineSchema<3, RecipeV3>({
  version: 3,
  validator: zodAdapter(RecipeV3Shape),
});

const schemaV4 = defineSchema<4, RecipeV4>({
  version: 4,
  validator: zodAdapter(RecipeV4Shape),
  deprecated: [
    {
      path: 'steps[*].timing.minMinutes',
      sinceVersion: 4,
      plannedRemovalVersion: 6,
      replacement: 'steps[*].timing.range.min',
      reason: 'flattened range fields will be grouped under a single object',
    },
    {
      path: 'steps[*].timing.maxMinutes',
      sinceVersion: 4,
      plannedRemovalVersion: 6,
    },
  ],
});

// ---------------------------------------------------------------------------
// Migrations — strict pairwise, each adds explicit defaults
// ---------------------------------------------------------------------------

const m1to2 = defineMigration<1, 2, RecipeV1, RecipeV2>({
  from: 1,
  to: 2,
  up: (doc) => ({ ...doc, version: 2, notes: 'NONE' }),
});

const m2to3 = defineMigration<2, 3, RecipeV2, RecipeV3>({
  from: 2,
  to: 3,
  up: (doc) => ({
    ...doc,
    version: 3,
    cookbook: 'home',
    steps: doc.steps.map((step) => ({
      ...step,
      timing: { method: 'manual' },
    })),
  }),
});

const m3to4 = defineMigration<3, 4, RecipeV3, RecipeV4>({
  from: 3,
  to: 4,
  up: (doc) => ({
    ...doc,
    version: 4,
    relatedDishes: [],
    steps: doc.steps.map((step) => ({ ...step, category: 'general' })),
  }),
});

const recipeRegistry = createRegistry({
  schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
  migrations: [m1to2, m2to3, m3to4],
  latest: schemaV4,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recipe family – integration', () => {
  it('migrates v1 → v4 with explicit defaults applied at every step', () => {
    const result = recipeRegistry.process(loadFixture('v1.json'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.meta.detectedVersion).toBe(1);
    expect(result.meta.targetVersion).toBe(4);
    expect(result.meta.appliedMigrations).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ]);

    expect(result.data.version).toBe(4);
    expect(result.data.notes).toBe('NONE');
    expect(result.data.cookbook).toBe('home');
    expect(result.data.relatedDishes).toEqual([]);
    for (const step of result.data.steps) {
      expect(step.category).toBe('general');
      expect(step.timing.method).toBe('manual');
    }
  });

  it('migrates v2 → v4 preserving v2-only fields', () => {
    const result = recipeRegistry.process(loadFixture('v2.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notes).toBe('BETA');
    expect(result.meta.appliedMigrations.map((s) => s.to)).toEqual([3, 4]);
  });

  it('migrates v3 → v4 and surfaces deprecation warnings present in the source', () => {
    const result = recipeRegistry.process(loadFixture('v3.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deprecationWarnings = result.warnings.filter((w) => w.code === 'DEPRECATED_FIELD');
    // Fixture step 0 has both minMinutes and maxMinutes; step 1 has neither.
    expect(deprecationWarnings).toHaveLength(2);
    expect(deprecationWarnings.map((w) => w.path).sort()).toEqual([
      'steps[0].timing.maxMinutes',
      'steps[0].timing.minMinutes',
    ]);
    expect(deprecationWarnings[0]?.severity).toBe('warning');
  });

  it('returns identity meta when the input is already at the latest version', () => {
    const result = recipeRegistry.process(loadFixture('v4.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.appliedMigrations).toEqual([]);
  });

  it('rejects a doc whose version field is missing', () => {
    const result = recipeRegistry.process({ cuisine: 'italian' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.MissingVersion);
  });

  it('respects minSupportedVersion: legacy v1 is rejected when retired', () => {
    const retired = createRegistry({
      schemas: [schemaV1, schemaV2, schemaV3, schemaV4],
      migrations: [m1to2, m2to3, m3to4],
      latest: schemaV4,
      minSupportedVersion: 3,
    });
    const result = retired.process(loadFixture('v1.json'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe(ErrorCode.UnsupportedLegacyVersion);
  });

  it('reports validation errors with Zod-prefixed codes when the source is malformed', () => {
    const malformed = {
      version: 1,
      title: 'Broken Recipe',
      cuisine: 'italian',
      year: 'not-a-number', // <- wrong type
      type: 'Main',
      steps: [],
    };
    const result = recipeRegistry.process(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code.startsWith('ZOD_'))).toBe(true);
    expect(result.errors.some((e) => e.path === 'year')).toBe(true);
  });
});
