import { describe, expect, it } from 'vitest';

import { InvalidPathError, parsePath, walkPath } from './path.js';

describe('parsePath', () => {
  it('parses a bare key', () => {
    expect(parsePath('foo')).toEqual([{ kind: 'key', name: 'foo' }]);
  });

  it('parses dotted keys', () => {
    expect(parsePath('foo.bar.baz')).toEqual([
      { kind: 'key', name: 'foo' },
      { kind: 'key', name: 'bar' },
      { kind: 'key', name: 'baz' },
    ]);
  });

  it('parses numeric indices', () => {
    expect(parsePath('foo[0]')).toEqual([
      { kind: 'key', name: 'foo' },
      { kind: 'index', index: 0 },
    ]);
    expect(parsePath('foo[12].bar')).toEqual([
      { kind: 'key', name: 'foo' },
      { kind: 'index', index: 12 },
      { kind: 'key', name: 'bar' },
    ]);
  });

  it('parses wildcards', () => {
    expect(parsePath('items[*].sub.flag')).toEqual([
      { kind: 'key', name: 'items' },
      { kind: 'wildcard' },
      { kind: 'key', name: 'sub' },
      { kind: 'key', name: 'flag' },
    ]);
  });

  it('rejects empty path', () => {
    expect(() => parsePath('')).toThrow(InvalidPathError);
  });

  it.each([
    ['.foo', 'leading dot'],
    ['foo.', 'trailing dot'],
    ['foo..bar', 'double dot'],
    ['foo[', 'unterminated bracket'],
    ['foo[]', 'empty index'],
    ['foo[-1]', 'negative index'],
    ['foo[01]', 'leading zero'],
    ['foo[a]', 'non-numeric index'],
    ['foo]', 'unmatched closing bracket'],
  ])('rejects "%s" (%s)', (input) => {
    expect(() => parsePath(input)).toThrow(InvalidPathError);
  });
});

describe('walkPath', () => {
  const doc = {
    label: 'demo',
    items: [{ sub: { flag: true } }, { sub: { flag: false } }, { sub: { flag: null } }],
    nested: { a: { b: 42 } },
  };

  it('resolves a single key', () => {
    expect(walkPath(doc, parsePath('label'))).toEqual([{ path: 'label', value: 'demo' }]);
  });

  it('resolves a nested key', () => {
    expect(walkPath(doc, parsePath('nested.a.b'))).toEqual([{ path: 'nested.a.b', value: 42 }]);
  });

  it('resolves an explicit index', () => {
    expect(walkPath(doc, parsePath('items[1].sub.flag'))).toEqual([
      { path: 'items[1].sub.flag', value: false },
    ]);
  });

  it('expands wildcards over every element', () => {
    expect(walkPath(doc, parsePath('items[*].sub.flag'))).toEqual([
      { path: 'items[0].sub.flag', value: true },
      { path: 'items[1].sub.flag', value: false },
      { path: 'items[2].sub.flag', value: null },
    ]);
  });

  it('returns no hits when a segment does not match', () => {
    expect(walkPath(doc, parsePath('items[99].sub.flag'))).toEqual([]);
    expect(walkPath(doc, parsePath('does.not.exist'))).toEqual([]);
    expect(walkPath(doc, parsePath('label[*]'))).toEqual([]); // not an array
  });

  it('treats null and arrays as non-objects for key segments', () => {
    expect(walkPath({ a: null }, parsePath('a.b'))).toEqual([]);
    expect(walkPath({ a: [1, 2] }, parsePath('a.b'))).toEqual([]);
  });

  it('silently skips index segments when the target is not an array', () => {
    // Documents the contract: deprecation walks are non-blocking, so a
    // schema declaring `foo[0]` against a malformed doc where `foo` is an
    // object (or null/undefined) yields no hit instead of crashing.
    expect(walkPath({ foo: { '0': 'x' } }, parsePath('foo[0]'))).toEqual([]);
    expect(walkPath({ foo: null }, parsePath('foo[0]'))).toEqual([]);
  });
});
