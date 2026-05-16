/**
 * Public entry point of `@pasblin/versioned-json`.
 *
 * Re-exports the framework-agnostic primitives used to model, migrate and
 * validate versioned JSON documents.
 *
 * @packageDocumentation
 */

export type {
  IssueSeverity,
  ProcessErr,
  ProcessMeta,
  ProcessOk,
  ProcessResult,
  ValidationIssue,
  ValidationResult,
  Version,
} from './core/types.js';

export {
  ErrorCode,
  FutureVersionError,
  InvalidRegistryError,
  MigrationFailedError,
  MigrationGapError,
  MissingVersionError,
  UnknownVersionError,
  UnsupportedLegacyVersionError,
  ValidationFailedError,
  VersionedJsonError,
} from './core/errors.js';
export type { ErrorCodeValue } from './core/errors.js';

export {
  integerVersionComparator,
  lexicographicVersionComparator,
} from './core/versionComparator.js';
export type { CompareResult, VersionComparator } from './core/versionComparator.js';

export { fromValidateFn } from './validation/validatorAdapter.js';
export type { ValidatorAdapter } from './validation/validatorAdapter.js';

export { defineSchema } from './schema/schema.js';
export type { Schema, SchemaInput } from './schema/schema.js';
export { DEPRECATED_FIELD_CODE } from './schema/deprecation.js';
export type { DeprecatedField } from './schema/deprecation.js';
export { collectDeprecationWarnings } from './schema/deprecationWalker.js';

export { defineMigration } from './migration/migration.js';
export type { Migration, MigrationInput } from './migration/migration.js';
export { createMigrator } from './migration/migrator.js';
export type {
  AnyMigration,
  AppliedMigration,
  Migrator,
  MigratorOptions,
} from './migration/migrator.js';

export { createRegistry } from './registry/createRegistry.js';
export type { AnySchema, Registry, RegistryConfig } from './registry/createRegistry.js';
