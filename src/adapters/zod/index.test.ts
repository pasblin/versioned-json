import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodAdapter, ZOD_ISSUE_PREFIX } from './index.js';

describe('zodAdapter', () => {
  it('returns the parsed data on success', () => {
    const schema = z.object({ name: z.string(), age: z.number().int().nonnegative() });
    const adapter = zodAdapter(schema);

    const result = adapter.validate({ name: 'a', age: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ name: 'a', age: 1 });
    expect(result.warnings).toEqual([]);
  });

  it('reflects Zod-applied defaults in the parsed data', () => {
    const schema = z.object({
      name: z.string(),
      tags: z.array(z.string()).default([]),
    });
    const adapter = zodAdapter(schema);
    const result = adapter.validate({ name: 'a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ name: 'a', tags: [] });
  });

  it('maps Zod issues to ValidationIssues with prefixed codes and dot/bracket paths', () => {
    const schema = z.object({
      user: z.object({ name: z.string() }),
      ids: z.array(z.number().int()),
    });
    const adapter = zodAdapter(schema);

    const result = adapter.validate({ user: { name: 12 }, ids: [1, 'two', 3] });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const byPath = new Map(result.errors.map((e) => [e.path, e]));
    const nameIssue = byPath.get('user.name');
    const idsIssue = byPath.get('ids[1]');

    expect(nameIssue).toBeDefined();
    expect(nameIssue?.code.startsWith(ZOD_ISSUE_PREFIX)).toBe(true);
    expect(nameIssue?.severity).toBe('error');
    expect(nameIssue?.meta?.['zodIssue']).toBeDefined();

    expect(idsIssue).toBeDefined();
    expect(idsIssue?.code.startsWith(ZOD_ISSUE_PREFIX)).toBe(true);
  });

  it('preserves the original Zod issue in meta.zodIssue', () => {
    const schema = z.string();
    const adapter = zodAdapter(schema);
    const result = adapter.validate(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.errors[0];
    expect(issue?.meta?.['zodIssue']).toMatchObject({
      code: 'invalid_type',
      path: [],
    });
  });
});
