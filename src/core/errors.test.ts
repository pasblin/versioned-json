import { describe, expect, it } from 'vitest';

import {
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
} from './errors.js';

describe('core/errors', () => {
  it('every subclass exposes a stable code and a useful message', () => {
    const cases: { error: VersionedJsonError; code: string; messageContains: string }[] = [
      {
        error: new MissingVersionError('version'),
        code: ErrorCode.MissingVersion,
        messageContains: '"version"',
      },
      {
        error: new UnknownVersionError(7),
        code: ErrorCode.UnknownVersion,
        messageContains: '7',
      },
      {
        error: new FutureVersionError(99, 4),
        code: ErrorCode.FutureVersion,
        messageContains: '99',
      },
      {
        error: new UnsupportedLegacyVersionError(1, 3),
        code: ErrorCode.UnsupportedLegacyVersion,
        messageContains: 'retired',
      },
      {
        error: new MigrationGapError(2, 3),
        code: ErrorCode.MigrationGap,
        messageContains: 'Missing migration from version 2 to 3',
      },
      {
        error: new MigrationFailedError(1, 2),
        code: ErrorCode.MigrationFailed,
        messageContains: 'threw',
      },
      {
        error: new ValidationFailedError([]),
        code: ErrorCode.ValidationFailed,
        messageContains: '0 error',
      },
      {
        error: new InvalidRegistryError('boom'),
        code: ErrorCode.InvalidRegistry,
        messageContains: 'boom',
      },
    ];

    for (const { error, code, messageContains } of cases) {
      expect(error).toBeInstanceOf(VersionedJsonError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toContain(messageContains);
      expect(error.name).not.toBe('Error');
    }
  });

  it('preserves the original cause when provided', () => {
    const root = new TypeError('underlying');
    const err = new MigrationFailedError(1, 2, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('keeps the prototype chain so instanceof works after rethrow', () => {
    try {
      throw new UnknownVersionError(42);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownVersionError);
      expect(e).toBeInstanceOf(VersionedJsonError);
    }
  });

  it('exposes the offending version on version-related errors', () => {
    expect(new UnknownVersionError(5).detectedVersion).toBe(5);
    expect(new FutureVersionError(9, 4).latestVersion).toBe(4);
    expect(new UnsupportedLegacyVersionError(1, 3).minSupportedVersion).toBe(3);
    expect(new MigrationGapError(2, 3).missingTo).toBe(3);
  });
});
