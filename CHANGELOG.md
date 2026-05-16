# Changelog

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
