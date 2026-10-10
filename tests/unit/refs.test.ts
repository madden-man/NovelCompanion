import { describe, expect, test } from 'vitest';
import { customFieldSpecs, manifests } from '../../src/shared/schema';
import { outgoingRefs } from '../../src/shared/domain/refs';

describe('ED-9 references an entry makes', () => {
  test('ED-9 links and every reference field are found, at any depth', () => {
    const chapter = {
      _id: 'CH',
      partId: 'PT1',
      links: [{ targetId: 'E9', kind: 'happened' }],
      strands: [{ id: 's', povCharacterId: 'H5', characterIds: ['H5', 'Z5'], placeIds: ['PL1'] }],
      arcIds: ['ARC'],
      themeIds: [],
      factsInPlay: [{ factId: 'F1', characterId: 'Z3', note: '' }],
    };
    expect(
      outgoingRefs(manifests.chapters, chapter).map((r) => [r.targetId, r.kind, r.path]),
    ).toEqual([
      ['E9', 'happened', 'links.0'],
      ['PT1', 'Part', 'partId'],
      ['H5', 'Strands: Point of view', 'strands.0.povCharacterId'],
      ['H5', 'Strands: Characters present', 'strands.0.characterIds.0'],
      ['Z5', 'Strands: Characters present', 'strands.0.characterIds.1'],
      ['PL1', 'Strands: Places', 'strands.0.placeIds.0'],
      ['ARC', 'Arcs', 'arcIds.0'],
      ['F1', 'Facts in play: Fact', 'factsInPlay.0.factId'],
      ['Z3', 'Facts in play: Acted on by', 'factsInPlay.0.characterId'],
    ]);
  });

  test('ED-9 a custom entry link field is a reference too', () => {
    const specs = customFieldSpecs({
      fields: [{ id: 'cook', label: 'Cook', type: 'link', options: [] }],
    });
    const refs = outgoingRefs(
      manifests.customEntries,
      { _id: 'E', sectionId: 'S', links: [], values: { cook: 'Z1' } },
      () => specs,
    );
    expect(refs.map((r) => [r.targetId, r.kind])).toEqual([
      ['S', 'Section'],
      ['Z1', 'Cook'],
    ]);
  });
});
