import { describe, expect, test } from 'vitest';
import { manifests } from '../../src/shared/schema';
import { outgoingRefs } from '../../src/shared/domain/refs';

describe('ED-9 references an entry makes', () => {
  test('ED-9 every reference field is found, at any depth', () => {
    const chapter = {
      _id: 'CH',
      partId: 'PT1',
      strands: [{ id: 's', povCharacterId: 'H5', characterIds: ['H5', 'Z5'], placeIds: ['PL1'] }],
    };
    expect(
      outgoingRefs(manifests.chapters, chapter).map((r) => [r.targetId, r.kind, r.path]),
    ).toEqual([
      ['PT1', 'Part', 'partId'],
      ['H5', 'Strands: Point of view', 'strands.0.povCharacterId'],
      ['H5', 'Strands: Characters present', 'strands.0.characterIds.0'],
      ['Z5', 'Strands: Characters present', 'strands.0.characterIds.1'],
      ['PL1', 'Strands: Places', 'strands.0.placeIds.0'],
    ]);
  });

  test('ED-9 SM-3 a moment refers to its character', () => {
    const refs = outgoingRefs(manifests.moments, {
      _id: 'M',
      characterId: 'Z1',
      year: 1980,
    });
    expect(refs.map((r) => [r.targetId, r.kind])).toEqual([['Z1', 'Character']]);
  });
});
