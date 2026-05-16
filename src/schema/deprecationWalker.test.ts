import { describe, expect, it } from 'vitest';

import { collectDeprecationWarnings } from './deprecationWalker.js';
import { DEPRECATED_FIELD_CODE, type DeprecatedField } from './deprecation.js';

describe('collectDeprecationWarnings', () => {
  it('returns an empty array when there are no deprecated fields', () => {
    expect(collectDeprecationWarnings({ any: 'thing' }, [])).toEqual([]);
  });

  it('returns an empty array when no deprecated field is present', () => {
    const deprecated: readonly DeprecatedField[] = [{ path: 'oldField', sinceVersion: 2 }];
    expect(collectDeprecationWarnings({ other: 1 }, deprecated)).toEqual([]);
  });

  it('emits one warning per present deprecated field', () => {
    const deprecated: readonly DeprecatedField[] = [
      {
        path: 'items[*].sub.flag',
        sinceVersion: 4,
        plannedRemovalVersion: 6,
        replacement: 'items[*].sub.flaggedAt',
        reason: 'moved under a structured object',
      },
    ];
    const doc = {
      items: [
        { sub: { flag: true } },
        { sub: { flag: false } },
        { sub: {} }, // no hit here
      ],
    };

    const warnings = collectDeprecationWarnings(doc, deprecated);
    expect(warnings).toHaveLength(2);
    for (const w of warnings) {
      expect(w.severity).toBe('warning');
      expect(w.code).toBe(DEPRECATED_FIELD_CODE);
      expect(w.message).toContain('deprecated since version 4');
      expect(w.message).toContain('scheduled for removal in version 6');
      expect(w.message).toContain('moved under a structured object');
      expect(w.message).toContain('items[*].sub.flaggedAt');
    }
    expect(warnings.map((w) => w.path)).toEqual(['items[0].sub.flag', 'items[1].sub.flag']);
  });

  it('includes structured meta for tooling', () => {
    const field: DeprecatedField = {
      path: 'oldName',
      sinceVersion: 3,
      plannedRemovalVersion: 5,
      replacement: 'newName',
      reason: 'renamed',
    };

    const [warning] = collectDeprecationWarnings({ oldName: 'x' }, [field]);
    expect(warning?.meta).toEqual({
      declaredPath: 'oldName',
      sinceVersion: 3,
      plannedRemovalVersion: 5,
      replacement: 'newName',
      reason: 'renamed',
    });
  });

  it('omits optional meta fields when not provided', () => {
    const field: DeprecatedField = { path: 'oldName', sinceVersion: 3 };
    const [warning] = collectDeprecationWarnings({ oldName: 'x' }, [field]);
    expect(warning?.meta).toEqual({
      declaredPath: 'oldName',
      sinceVersion: 3,
    });
    expect(warning?.message).toBe('Field "oldName" is deprecated since version 3.');
  });
});
