# Changelog

## 0.2.0

### Minor Changes

- 4fb107b: Distinguish migration-output validation failures from source-document failures. Issues emitted by schema validators now carry a `stage: 'source' | 'migrated'` discriminator, and when the migrated output fails latest-schema validation the errors are prefixed with a synthetic `MIGRATION_OUTPUT_INVALID` issue pointing at the migration chain as the fix site. Additive only: existing error codes and result shapes are unchanged, and issues not tied to a validation stage (version detection, migration failures, deprecation warnings) remain unstaged.
- 0ad51b0: Add first-class writer-exactness utilities to the `/zod` sub-entry: `collectUndeclaredPaths(schema, value)` returns the dot/bracket path of every key the schema does not declare, and `assertWriterExact(schema, value, context, devMode?)` turns that into a dev-mode guard for serialization points (throwing the new `WriterExactnessError`). Loose-object tolerance is not treated as declaration, substantive `.catchall` schemas are, wrappers unwrap to their carrier, arrays and discriminated-union variants recurse, and `undefined`-valued keys are skipped. Works with both zod 3 and zod 4.

## 0.1.0

### Minor Changes

- c60c0b3: Initial public release.

  Provides a framework-agnostic lifecycle toolkit for versioned JSON
  documents, including:
  - A typed `Schema` model with declarative deprecation paths and a tiny
    `dot.bracket[*]` path grammar.
  - A pure forward `Migration` model and a strict pairwise migrator with
    build-time chain validation.
  - A `createRegistry` orchestrator that wires gating, source/latest
    validation, source-schema deprecation walking, the migration chain and
    latest-schema deprecation reporting into one entry point.
  - A pluggable `resolveVersion(input)` strategy for non-trivial version
    detection (nested keys, `$schema` URLs, externally supplied versions).
  - Soft-retirement via `minSupportedVersion` and adoption support via
    `assumeVersion` for legacy documents without a version field.
  - Observability hooks `onMigration` and `onDeprecation` for streaming
    pipeline events into logs, metrics or telemetry.
  - A `ValidatorAdapter` interface with `fromValidateFn` and an optional
    Zod adapter exposed at `@pasblin/versioned-json/zod`.
  - Pluggable `VersionComparator` (default: integer; alternative:
    lexicographic) for arbitrary version identifier shapes.
  - A `versioned-json` CLI binary for one-off document upgrades (stdin,
    files, `--pretty`, `--quiet`, stable exit codes).

All notable changes to `@pasblin/versioned-json` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public sub-path export `@pasblin/versioned-json/zod` so consumers can import
  the Zod adapter under modern Node `exports`-aware resolvers.
- `zod` declared as an **optional** peer dependency
  (`peerDependencies` + `peerDependenciesMeta`), matching the README claim.
  Consumers that import the adapter must install `zod` themselves; consumers
  that use only the core API do not pay the dependency cost.
- Source-version deprecation walking: `Registry.process` now walks the
  source schema's `deprecated` list against the source document **in
  addition to** walking the latest schema's deprecations against the
  migrated document. Fields declared deprecated in the source schema now
  produce warnings even when forward migrations remove or rename them
  before reaching the latest shape. The walk is skipped when source ===
  latest to avoid duplicate warnings on already-latest inputs.

### Fixed

- `package.json` `exports` map previously did not list `./zod`, which
  caused `import { zodAdapter } from '@pasblin/versioned-json/zod'` to fail
  with `ERR_PACKAGE_PATH_NOT_EXPORTED` under modern Node resolvers despite
  the build emitting the correct artefacts. The map now lists `./zod`
  explicitly with `types`, `import` and `require` conditions.

### Changed

- README clarifies the deprecation walking semantics: warnings are emitted
  for fields present at the source version (using source-schema
  deprecations) and for fields present at the latest version (using
  latest-schema deprecations).
