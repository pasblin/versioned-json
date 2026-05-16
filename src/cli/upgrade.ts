/**
 * `versioned-json upgrade` command.
 *
 * Migrates a JSON document up to the latest version declared by a user-built
 * {@link Registry}. The command is implemented as a pure function
 * ({@link runUpgrade}) that takes injectable IO dependencies, so it can be
 * tested without spawning subprocesses or touching the real filesystem.
 *
 * Wiring to Node's actual stdio / fs / dynamic import happens in
 * `./index.ts`.
 *
 * @packageDocumentation
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { ProcessResult, ValidationIssue } from '../core/types.js';

/**
 * Exit codes used by the CLI. Documented so users can branch on them in
 * scripts.
 *
 * @public
 */
export const UpgradeExitCode = {
  Ok: 0,
  /** Validation / migration failure on the document. */
  DocumentFailed: 1,
  /** Misuse: bad arguments, missing files, registry not loadable, etc. */
  Misuse: 2,
} as const;

export type UpgradeExitCodeValue = (typeof UpgradeExitCode)[keyof typeof UpgradeExitCode];

/**
 * IO dependencies that {@link runUpgrade} consumes. Injectable for testing.
 *
 * @public
 */
export interface UpgradeDeps {
  /** Reads a UTF-8 text file. Reject with `code === 'ENOENT'` for missing. */
  readonly readFile: (path: string) => Promise<string>;
  /** Writes a UTF-8 text file (overwriting). */
  readonly writeFile: (path: string, data: string) => Promise<void>;
  /** Reads stdin to end as UTF-8 text. */
  readonly readStdin: () => Promise<string>;
  /** Emits a chunk to stdout (no implicit newline). */
  readonly stdout: (text: string) => void;
  /** Emits a chunk to stderr (no implicit newline). */
  readonly stderr: (text: string) => void;
  /**
   * Dynamically imports a module by absolute or `file://` URL. Returning
   * `unknown` matches the runtime contract: the loader has no way of knowing
   * the shape of the exported registry.
   */
  readonly importModule: (specifier: string) => Promise<unknown>;
  /**
   * Resolves a possibly-relative user-supplied path to an absolute one,
   * typically against the working directory.
   */
  readonly resolvePath: (path: string) => string;
}

interface ParsedOptions {
  readonly registryPath: string;
  readonly input: string; // file path or '-'
  readonly out: string | undefined;
  readonly pretty: boolean;
  readonly quiet: boolean;
  readonly allowFailed: boolean;
  readonly help: boolean;
}

const USAGE = `Usage: versioned-json upgrade [options] <input>

Migrate a JSON document up to the latest version declared by a Registry.

Arguments:
  <input>             Path to a JSON file, or '-' to read from stdin.

Options:
  --registry <path>   Required. Path to a built JS module exporting a
                      Registry (default export or named 'registry').
  --out <path>        Write the migrated document to this file. When omitted
                      the document is written to stdout.
  --pretty            Pretty-print JSON output (2-space indent).
  --quiet             Suppress warnings on stderr.
  --allow-failed      Exit 0 even when validation produces errors.
  -h, --help          Show this help text.

Exit codes:
  0  success (or --allow-failed)
  1  the document failed validation or migration
  2  misuse (bad CLI args, registry not loadable, etc.)`;

const PARSE_CONFIG = {
  options: {
    registry: { type: 'string' },
    out: { type: 'string' },
    pretty: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    'allow-failed': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
} as const satisfies ParseArgsConfig;

/**
 * Parses the CLI argv (without the leading `node` and script entries) into a
 * normalised options object. Throws a plain `Error` whose `message` is
 * suitable to print to stderr when arguments are invalid.
 *
 * @internal
 */
export const parseUpgradeArgs = (args: readonly string[]): ParsedOptions => {
  const { values, positionals } = parseArgs({ ...PARSE_CONFIG, args: [...args] });

  if (values.help === true) {
    return {
      registryPath: '',
      input: '',
      out: undefined,
      pretty: false,
      quiet: false,
      allowFailed: false,
      help: true,
    };
  }

  if (values.registry === undefined || values.registry.length === 0) {
    throw new Error('Missing required --registry <path>.');
  }
  if (positionals.length === 0) {
    throw new Error('Missing required <input> argument (use "-" for stdin).');
  }
  if (positionals.length > 1) {
    throw new Error(
      `Too many positional arguments: ${positionals
        .slice(1)
        .map((a) => JSON.stringify(a))
        .join(', ')}.`,
    );
  }

  const [input] = positionals;
  // positionals.length === 1 was just asserted; invariant holds.
  /* c8 ignore next */
  if (input === undefined) throw new Error('Missing required <input> argument.');

  return {
    registryPath: values.registry,
    input,
    out: values.out,
    pretty: values.pretty,
    quiet: values.quiet,
    allowFailed: values['allow-failed'],
    help: false,
  };
};

/**
 * Structural view of a Registry the CLI cares about. Used instead of the
 * fully-parameterised `Registry<V, T>` to side-step generic-variance issues
 * when accepting registries dynamically loaded from disk.
 *
 * @public
 */
export interface RegistryLike {
  readonly process: (input: unknown) => ProcessResult<unknown>;
}

const isRegistryLike = (value: unknown): value is RegistryLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { process?: unknown }).process === 'function';

/**
 * Locates the registry inside a freshly-imported module. Looks at the
 * `default` and `registry` named exports in that order.
 *
 * @internal
 */
export const pickRegistry = (mod: unknown): RegistryLike | null => {
  if (typeof mod !== 'object' || mod === null) return null;
  const record = mod as Record<string, unknown>;
  const candidates = [record['default'], record['registry']];
  for (const candidate of candidates) {
    if (isRegistryLike(candidate)) return candidate;
  }
  return null;
};

const formatIssue = (issue: ValidationIssue): string => {
  const where = issue.path.length === 0 ? '<root>' : issue.path;
  return `[${issue.code}] ${where}: ${issue.message}`;
};

const formatMeta = (meta: ProcessResult<unknown> extends { meta: infer M } ? M : never): string => {
  const parts: string[] = [];
  if ('detectedVersion' in meta && meta.detectedVersion !== undefined) {
    parts.push(`detected=${String(meta.detectedVersion)}`);
  }
  if ('targetVersion' in meta && meta.targetVersion !== undefined) {
    parts.push(`target=${String(meta.targetVersion)}`);
  }
  if ('appliedMigrations' in meta && Array.isArray(meta.appliedMigrations)) {
    parts.push(`steps=${String(meta.appliedMigrations.length)}`);
  }
  return parts.join(' ');
};

/**
 * Runs the `upgrade` command.
 *
 * @returns The exit code the calling process should use.
 * @public
 */
export const runUpgrade = async (
  argv: readonly string[],
  deps: UpgradeDeps,
): Promise<UpgradeExitCodeValue> => {
  let options: ParsedOptions;
  try {
    options = parseUpgradeArgs(argv);
  } catch (e) {
    deps.stderr(`${(e as Error).message}\n\n${USAGE}\n`);
    return UpgradeExitCode.Misuse;
  }

  if (options.help) {
    deps.stdout(`${USAGE}\n`);
    return UpgradeExitCode.Ok;
  }

  // Load the registry module.
  const registryAbsolute = deps.resolvePath(options.registryPath);
  let mod: unknown;
  try {
    mod = await deps.importModule(registryAbsolute);
  } catch (e) {
    deps.stderr(
      `Failed to load registry from "${options.registryPath}": ${(e as Error).message}\n`,
    );
    return UpgradeExitCode.Misuse;
  }
  const registry = pickRegistry(mod);
  if (registry === null) {
    deps.stderr(
      `Module "${options.registryPath}" does not export a Registry ` +
        `(expected a default or "registry" named export with a process() method).\n`,
    );
    return UpgradeExitCode.Misuse;
  }

  // Read input.
  let raw: string;
  try {
    raw =
      options.input === '-'
        ? await deps.readStdin()
        : await deps.readFile(deps.resolvePath(options.input));
  } catch (e) {
    deps.stderr(`Failed to read input "${options.input}": ${(e as Error).message}\n`);
    return UpgradeExitCode.Misuse;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    deps.stderr(`Input is not valid JSON: ${(e as Error).message}\n`);
    return UpgradeExitCode.Misuse;
  }

  // Run the pipeline.
  const result = registry.process(parsed);

  // Emit warnings (unless quiet).
  if (!options.quiet) {
    for (const warning of result.warnings) {
      deps.stderr(`warn ${formatIssue(warning)}\n`);
    }
  }

  if (!result.ok) {
    for (const error of result.errors) {
      deps.stderr(`error ${formatIssue(error)}\n`);
    }
    if (!options.quiet) {
      const meta = formatMeta(result.meta);
      if (meta.length > 0) deps.stderr(`meta  ${meta}\n`);
    }
    return options.allowFailed ? UpgradeExitCode.Ok : UpgradeExitCode.DocumentFailed;
  }

  const serialised = options.pretty
    ? `${JSON.stringify(result.data, null, 2)}\n`
    : `${JSON.stringify(result.data)}\n`;

  if (options.out === undefined) {
    deps.stdout(serialised);
  } else {
    try {
      await deps.writeFile(deps.resolvePath(options.out), serialised);
    } catch (e) {
      deps.stderr(`Failed to write output "${options.out}": ${(e as Error).message}\n`);
      return UpgradeExitCode.Misuse;
    }
  }

  if (!options.quiet) {
    const meta = formatMeta(result.meta);
    if (meta.length > 0) deps.stderr(`meta  ${meta}\n`);
  }
  return UpgradeExitCode.Ok;
};
