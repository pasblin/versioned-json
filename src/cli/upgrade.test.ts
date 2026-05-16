import { describe, expect, it } from 'vitest';

import { defineMigration } from '../migration/migration.js';
import { createRegistry } from '../registry/createRegistry.js';
import { defineSchema } from '../schema/schema.js';
import { fromValidateFn } from '../validation/validatorAdapter.js';

import {
  parseUpgradeArgs,
  pickRegistry,
  runUpgrade,
  UpgradeExitCode,
  type UpgradeDeps,
} from './upgrade.js';

// ---------------------------------------------------------------------------
// Test fixtures: tiny registry exposed exactly as a CLI user would publish it.
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

const schemaV1 = defineSchema<1, DocV1>({
  version: 1,
  validator: fromValidateFn<DocV1>((x) => ({ ok: true, data: x as DocV1, warnings: [] })),
});

const schemaV2 = defineSchema<2, DocV2>({
  version: 2,
  validator: fromValidateFn<DocV2>((x) => {
    const obj = x as Partial<DocV2>;
    if (typeof obj.title !== 'string') {
      return {
        ok: false,
        errors: [
          { severity: 'error', code: 'BAD_TITLE', message: 'title required', path: 'title' },
        ],
        warnings: [],
      };
    }
    return { ok: true, data: obj as DocV2, warnings: [] };
  }),
  deprecated: [{ path: 'title', sinceVersion: 2 }],
});

const m1to2 = defineMigration<1, 2, DocV1, DocV2>({
  from: 1,
  to: 2,
  up: (d) => ({ ...d, version: 2, tags: [] }),
});

// Mimics the shape of a freshly-imported ESM module. Return type kept as
// `Record<string, unknown>` so the test isn't coupled to Registry's
// concrete generic parameters (the CLI consumes it via the structural
// RegistryLike predicate).
const buildRegistry = (): Record<string, unknown> => ({
  default: createRegistry({
    schemas: [schemaV1, schemaV2],
    migrations: [m1to2],
    latest: schemaV2,
  }),
});

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface CollectedIO {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly files: Map<string, string>;
}

const makeDeps = (
  files: Record<string, string>,
  modules: Record<string, unknown> = {},
  stdin = '',
): { deps: UpgradeDeps; io: CollectedIO } => {
  const io: CollectedIO = {
    stdout: [],
    stderr: [],
    files: new Map(),
  };
  const deps: UpgradeDeps = {
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file '${path}'`) as Error & { code?: string };
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(content);
    },
    writeFile: (path, data) => {
      io.files.set(path, data);
      return Promise.resolve();
    },
    readStdin: () => Promise.resolve(stdin),
    stdout: (text) => io.stdout.push(text),
    stderr: (text) => io.stderr.push(text),
    importModule: (specifier) => {
      const mod = modules[specifier];
      if (mod === undefined) {
        return Promise.reject(new Error(`Cannot find module '${specifier}'`));
      }
      return Promise.resolve(mod);
    },
    // Stub: treat every path as already absolute for the tests.
    resolvePath: (path) => path,
  };
  return { deps, io };
};

// ---------------------------------------------------------------------------

describe('parseUpgradeArgs', () => {
  it('returns help shape when --help is passed', () => {
    expect(parseUpgradeArgs(['--help']).help).toBe(true);
    expect(parseUpgradeArgs(['-h']).help).toBe(true);
  });

  it('requires --registry', () => {
    expect(() => parseUpgradeArgs(['doc.json'])).toThrow(/--registry/);
  });

  it('requires a positional <input>', () => {
    expect(() => parseUpgradeArgs(['--registry', 'r.js'])).toThrow(/<input>/);
  });

  it('rejects extra positionals', () => {
    expect(() => parseUpgradeArgs(['--registry', 'r.js', 'a.json', 'b.json'])).toThrow(
      /Too many positional/,
    );
  });

  it('rejects unknown flags (strict mode)', () => {
    expect(() => parseUpgradeArgs(['--registry', 'r.js', '--bogus', 'doc.json'])).toThrow();
  });

  it('parses every supported option', () => {
    const opts = parseUpgradeArgs([
      '--registry',
      'r.js',
      '--out',
      'o.json',
      '--pretty',
      '--quiet',
      '--allow-failed',
      'doc.json',
    ]);
    expect(opts).toEqual({
      registryPath: 'r.js',
      input: 'doc.json',
      out: 'o.json',
      pretty: true,
      quiet: true,
      allowFailed: true,
      help: false,
    });
  });
});

describe('pickRegistry', () => {
  it('prefers the default export', () => {
    const mod = buildRegistry();
    expect(pickRegistry(mod)).toBe(mod['default']);
  });

  it('falls back to the `registry` named export', () => {
    const reg = buildRegistry()['default'];
    expect(pickRegistry({ registry: reg })).toBe(reg);
  });

  it('returns null when no recognisable export is present', () => {
    expect(pickRegistry({})).toBeNull();
    expect(pickRegistry(null)).toBeNull();
    expect(pickRegistry({ default: { wrong: true } })).toBeNull();
  });
});

describe('runUpgrade – happy path', () => {
  it('migrates a v1 file and writes JSON to stdout', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 1, title: 'hello' }) },
      { 'registry.js': buildRegistry() },
    );

    const code = await runUpgrade(['--registry', 'registry.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.Ok);

    const printed = io.stdout.join('');
    const data = JSON.parse(printed) as { version: number; tags: unknown[] };
    expect(data.version).toBe(2);
    expect(data.tags).toEqual([]);

    // Deprecation warning emitted on stderr.
    const stderr = io.stderr.join('');
    expect(stderr).toContain('warn [DEPRECATED_FIELD]');
    expect(stderr).toContain('detected=1 target=2 steps=1');
  });

  it('writes to --out when provided and pretty-prints when --pretty is set', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 1, title: 'x' }) },
      { 'registry.js': buildRegistry() },
    );
    const code = await runUpgrade(
      ['--registry', 'registry.js', '--out', 'out.json', '--pretty', 'doc.json'],
      deps,
    );
    expect(code).toBe(UpgradeExitCode.Ok);
    expect(io.stdout.join('')).toBe('');
    const written = io.files.get('out.json');
    expect(written).toBeDefined();
    expect(written?.includes('\n  ')).toBe(true);
  });

  it('reads from stdin when input is "-"', async () => {
    const { deps, io } = makeDeps(
      {},
      { 'registry.js': buildRegistry() },
      JSON.stringify({ version: 1, title: 'piped' }),
    );
    const code = await runUpgrade(['--registry', 'registry.js', '-'], deps);
    expect(code).toBe(UpgradeExitCode.Ok);
    const printed = JSON.parse(io.stdout.join('')) as { title: string };
    expect(printed.title).toBe('piped');
  });

  it('suppresses warnings on --quiet', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 1, title: 'x' }) },
      { 'registry.js': buildRegistry() },
    );
    await runUpgrade(['--registry', 'registry.js', '--quiet', 'doc.json'], deps);
    expect(io.stderr.join('')).toBe('');
  });
});

describe('runUpgrade – failure modes', () => {
  it('returns Misuse and prints help on bad arguments', async () => {
    const { deps, io } = makeDeps({}, {});
    const code = await runUpgrade(['no-registry'], deps);
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/--registry/);
  });

  it('returns Ok and prints usage on --help', async () => {
    const { deps, io } = makeDeps({}, {});
    const code = await runUpgrade(['--help'], deps);
    expect(code).toBe(UpgradeExitCode.Ok);
    expect(io.stdout.join('')).toMatch(/Usage: versioned-json upgrade/);
  });

  it('returns Misuse when the registry module cannot be imported', async () => {
    const { deps, io } = makeDeps({ 'doc.json': '{}' }, {});
    const code = await runUpgrade(['--registry', 'missing.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/Failed to load registry/);
  });

  it('returns Misuse when the module exports no recognisable Registry', async () => {
    const { deps, io } = makeDeps({ 'doc.json': '{}' }, { 'registry.js': { unrelated: 1 } });
    const code = await runUpgrade(['--registry', 'registry.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/does not export a Registry/);
  });

  it('returns Misuse when the input file is missing', async () => {
    const { deps, io } = makeDeps({}, { 'registry.js': buildRegistry() });
    const code = await runUpgrade(['--registry', 'registry.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/Failed to read input/);
  });

  it('returns Misuse when the input is not valid JSON', async () => {
    const { deps, io } = makeDeps({ 'doc.json': 'not-json' }, { 'registry.js': buildRegistry() });
    const code = await runUpgrade(['--registry', 'registry.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/not valid JSON/);
  });

  it('returns Misuse when --out cannot be written', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 1, title: 'x' }) },
      { 'registry.js': buildRegistry() },
    );
    // Override writeFile to reject.
    const failing: UpgradeDeps = {
      ...deps,
      writeFile: () => Promise.reject(new Error('EACCES: read-only filesystem')),
    };
    const code = await runUpgrade(
      ['--registry', 'registry.js', '--out', '/ro/out.json', 'doc.json'],
      failing,
    );
    expect(code).toBe(UpgradeExitCode.Misuse);
    expect(io.stderr.join('')).toMatch(/Failed to write output/);
  });

  it('returns DocumentFailed and prints errors when validation fails', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 2 /* missing title */ }) },
      { 'registry.js': buildRegistry() },
    );
    const code = await runUpgrade(['--registry', 'registry.js', 'doc.json'], deps);
    expect(code).toBe(UpgradeExitCode.DocumentFailed);
    const stderr = io.stderr.join('');
    expect(stderr).toMatch(/error \[BAD_TITLE\]/);
    expect(stderr).toMatch(/detected=2 target=2/);
  });

  it('still exits 0 with --allow-failed even when the document fails', async () => {
    const { deps } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 2 }) },
      { 'registry.js': buildRegistry() },
    );
    const code = await runUpgrade(
      ['--registry', 'registry.js', '--allow-failed', 'doc.json'],
      deps,
    );
    expect(code).toBe(UpgradeExitCode.Ok);
  });

  it('suppresses the meta summary on failure when --quiet is set', async () => {
    const { deps, io } = makeDeps(
      { 'doc.json': JSON.stringify({ version: 2 }) },
      { 'registry.js': buildRegistry() },
    );
    await runUpgrade(['--registry', 'registry.js', '--quiet', 'doc.json'], deps);
    const stderr = io.stderr.join('');
    // Errors are still printed (they are the whole reason to run the
    // command), but the trailing `meta  detected=...` line is silenced.
    expect(stderr).toMatch(/error \[BAD_TITLE\]/);
    expect(stderr).not.toMatch(/^meta/m);
  });
});
