import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { z as z4 } from 'zod';
import { z as z3 } from 'zod3';

import {
  assertWriterExact,
  collectUndeclaredPaths,
  WriterExactnessError,
} from './writerExactness.js';

// ---------------------------------------------------------------------------
// The same behavioural suite runs against both supported zod majors. Each
// dialect exposes the few API points whose spelling differs between them.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

interface Dialect {
  readonly name: string;
  readonly z: any;
  /** Loose object: unknown keys tolerated by validation. */
  readonly loose: (shape: any) => ZodType;
}

const dialects: readonly Dialect[] = [
  { name: 'zod 4', z: z4, loose: (shape) => (z4 as any).looseObject(shape) },
  { name: 'zod 3', z: z3, loose: (shape) => (z3 as any).object(shape).passthrough() },
];

describe.each(dialects)('collectUndeclaredPaths ($name)', ({ z, loose }) => {
  const asZ = (schema: any): ZodType => schema as ZodType;

  it('returns [] for an exact writer', () => {
    const schema = asZ(z.object({ title: z.string(), tags: z.array(z.string()) }));
    expect(collectUndeclaredPaths(schema, { title: 't', tags: ['a'] })).toEqual([]);
  });

  it('reports a flat undeclared key', () => {
    const schema = asZ(z.object({ title: z.string() }));
    expect(collectUndeclaredPaths(schema, { title: 't', extra: 1 })).toEqual(['extra']);
  });

  it('reports nested undeclared keys through arrays with indexed paths', () => {
    const schema = asZ(
      z.object({
        pages: z.array(z.object({ documents: z.array(z.object({ id: z.number() })) })),
      }),
    );
    const value = {
      pages: [{ documents: [{ id: 1 }, { id: 2, newField: 'x' }] }],
    };
    expect(collectUndeclaredPaths(schema, value)).toEqual(['pages[0].documents[1].newField']);
  });

  it('reports undeclared keys on loose objects too — tolerance is not declaration', () => {
    const schema = loose({ title: z.string() });
    expect(collectUndeclaredPaths(schema, { title: 't', extra: 1 })).toEqual(['extra']);
  });

  it('treats a substantive catchall as declaring the keys it matches, and recurses into it', () => {
    const schema = asZ(z.object({ id: z.number() }).catchall(z.object({ inner: z.string() })));
    expect(collectUndeclaredPaths(schema, { id: 1, other: { inner: 's' } })).toEqual([]);
    expect(collectUndeclaredPaths(schema, { id: 1, other: { inner: 's', bad: 1 } })).toEqual([
      'other.bad',
    ]);
  });

  it('produces no findings under z.unknown() / z.any() subtrees', () => {
    const schema = asZ(z.object({ blob: z.unknown(), anything: z.any() }));
    const value = { blob: { free: 1 }, anything: { form: 2 } };
    expect(collectUndeclaredPaths(schema, value)).toEqual([]);
  });

  it('treats record keys as declared and recurses into the value schema', () => {
    const schema = asZ(z.object({ byId: z.record(z.string(), z.object({ n: z.number() })) }));
    const value = { byId: { a: { n: 1 }, b: { n: 2, extra: 3 } } };
    expect(collectUndeclaredPaths(schema, value)).toEqual(['byId.b.extra']);
  });

  it('unwraps optional/nullable/default/readonly/catch down to the carrier schema', () => {
    const inner = z.object({ x: z.number() });
    const schema = asZ(
      z.object({
        a: inner.optional(),
        b: inner.nullable(),
        c: inner.default({ x: 0 }),
        d: inner.readonly(),
        e: inner.catch({ x: 0 }),
      }),
    );
    const value = {
      a: { x: 1, rogueA: 1 },
      b: { x: 1, rogueB: 1 },
      c: { x: 1, rogueC: 1 },
      d: { x: 1, rogueD: 1 },
      e: { x: 1, rogueE: 1 },
    };
    expect(collectUndeclaredPaths(schema, value)).toEqual([
      'a.rogueA',
      'b.rogueB',
      'c.rogueC',
      'd.rogueD',
      'e.rogueE',
    ]);
  });

  it('matches discriminated-union variants by tag and recurses inside the variant', () => {
    const schema = asZ(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }),
        z.object({ kind: z.literal('b'), b: z.number() }),
      ]),
    );
    expect(collectUndeclaredPaths(schema, { kind: 'a', a: 's', rogue: 1 })).toEqual(['rogue']);
    expect(collectUndeclaredPaths(schema, { kind: 'b', b: 2 })).toEqual([]);
  });

  it('stays silent on an unmatched discriminated-union tag — validation owns that failure', () => {
    const schema = asZ(
      z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), a: z.string() })]),
    );
    expect(collectUndeclaredPaths(schema, { kind: 'zzz', whatever: 1 })).toEqual([]);
  });

  it('skips undefined-valued keys — JSON.stringify never writes them', () => {
    const schema = asZ(z.object({ title: z.string() }));
    expect(collectUndeclaredPaths(schema, { title: 't', ghost: undefined })).toEqual([]);
  });

  it('reports keys shadowing Object.prototype members instead of resolving them', () => {
    const schema = asZ(z.object({ title: z.string() }));
    const value: unknown = JSON.parse('{"title":"t","constructor":1,"toString":2,"__proto__":3}');
    const paths = collectUndeclaredPaths(schema, value);
    expect(paths).toEqual(expect.arrayContaining(['constructor', 'toString', '__proto__']));
    expect(paths).toHaveLength(3);
  });

  it('produces no findings when the value does not structurally match the schema', () => {
    // The walker only answers "any undeclared keys?", never "is it valid?".
    const schema = asZ(z.object({ title: z.string() }));
    expect(collectUndeclaredPaths(schema, 'not an object')).toEqual([]);
    expect(collectUndeclaredPaths(schema, null)).toEqual([]);
    expect(collectUndeclaredPaths(schema, [{ title: 't' }])).toEqual([]);
  });
});

describe.each(dialects)('assertWriterExact ($name)', ({ z }) => {
  const schema = z.object({ title: z.string() }) as ZodType;

  it('throws WriterExactnessError with context and paths when the writer is not exact', () => {
    let caught: unknown;
    try {
      assertWriterExact(schema, { title: 't', extra: 1 }, 'export to disk');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WriterExactnessError);
    const error = caught as WriterExactnessError;
    expect(error.context).toBe('export to disk');
    expect(error.paths).toEqual(['extra']);
    expect(error.message).toContain('export to disk');
    expect(error.message).toContain('extra');
  });

  it('does not throw for an exact writer', () => {
    expect(() => assertWriterExact(schema, { title: 't' }, 'export')).not.toThrow();
  });

  it('is a no-op when devMode is false', () => {
    expect(() =>
      assertWriterExact(schema, { title: 't', extra: 1 }, 'export', false),
    ).not.toThrow();
  });
});
