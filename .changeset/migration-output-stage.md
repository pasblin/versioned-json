---
'@pasblin/versioned-json': minor
---

Distinguish migration-output validation failures from source-document failures. Issues emitted by schema validators now carry a `stage: 'source' | 'migrated'` discriminator, and when the migrated output fails latest-schema validation the errors are prefixed with a synthetic `MIGRATION_OUTPUT_INVALID` issue pointing at the migration chain as the fix site. Additive only: existing error codes and result shapes are unchanged, and issues not tied to a validation stage (version detection, migration failures, deprecation warnings) remain unstaged.
