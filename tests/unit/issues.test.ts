import { describe, expect, test } from 'vitest';
import { entrySchemas, manifests } from '../../src/shared/schema';
import { fieldIssues, labelPath } from '../../src/shared/domain/issues';

describe('ED-10 schema problems in plain words at the field', () => {
  test('ED-10 a value the schema cannot store gets a plain message keyed by its field path', () => {
    const r = entrySchemas.characters.safeParse({
      _id: 'A',
      title: 'Ada',
      status: 'canon',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      names: { full: '' },
      birth: { year: 2.5 },
    });
    expect(r.success).toBe(false);
    const issues = fieldIssues(r.error!.issues);
    expect(issues).toContainEqual({ path: 'names.full', message: 'Cannot be empty.' });
    expect(issues.find((i) => i.path === 'birth')?.message).toBe('This value has the wrong form.');
    for (const i of issues) expect(i.message).not.toMatch(/\u2014|--|expected|received/);
  });

  test('ED-10 a field path reads as its labels', () => {
    expect(labelPath(manifests.chapters, 'strands.0.startYear')).toBe(
      'Strands, item 1, Story year',
    );
    expect(labelPath(manifests.characters, 'names.full')).toBe('Names, Full name');
  });
});
