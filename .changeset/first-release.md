---
'@pasblin/versioned-json': minor
---

Initial public release.

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
