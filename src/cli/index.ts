#!/usr/bin/env node
/**
 * `versioned-json` CLI entry point.
 *
 * Dispatches to the `upgrade` subcommand and wires Node's stdio, fs and
 * dynamic import to the {@link runUpgrade} core function.
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runUpgrade, UpgradeExitCode, type UpgradeDeps } from './upgrade.js';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
};

const deps: UpgradeDeps = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, data) => writeFile(path, data, 'utf-8'),
  readStdin,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  importModule: (specifier) => import(pathToFileURL(specifier).href),
  resolvePath: (path) => resolvePath(process.cwd(), path),
};

const TOP_USAGE = `Usage: versioned-json <command> [options]

Commands:
  upgrade <input>   Migrate a JSON document up to the latest version.

Run "versioned-json upgrade --help" for details.`;

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    deps.stdout(`${TOP_USAGE}\n`);
    return UpgradeExitCode.Ok;
  }

  if (command === 'upgrade') {
    return runUpgrade(rest, deps);
  }

  deps.stderr(`Unknown command: ${command}\n\n${TOP_USAGE}\n`);
  return UpgradeExitCode.Misuse;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Unexpected CLI error: ${String(err)}\n`);
    process.exitCode = UpgradeExitCode.Misuse;
  },
);
