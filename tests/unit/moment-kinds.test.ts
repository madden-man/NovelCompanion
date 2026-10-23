import { describe, expect, test } from 'vitest';
import {
  KIND_HEX_TOKENS,
  kindColorCss,
  kindWeight,
  listColorCss,
  momentKindItem,
} from '../../src/shared/domain/lists';
import {
  CHART_SURFACE_DARK,
  CHART_SURFACE_LIGHT,
  MIN_MARKER_CONTRAST,
  contrastRatio,
} from '../../src/shared/domain/colour';
import { defaultLists } from '../../src/main/db/defaultLists';
import { MOMENT_KIND_SEED, kindFromTitle } from '../../src/main/db/migrations/012-moment-kinds';
import { LIST_IDS, Moment, ListDoc, momentFields } from '../../src/shared/schema';
import { LIVES_IN_PREFIX, VOICE_MOMENT_TITLE } from '../../src/shared/schema/moment';

const seeded = defaultLists().find((l) => l._id === 'momentKinds')!;

describe('A51 moment kinds: the list and the schema', () => {
  test('SM-3 a moment has a kind, null by default, and the manifest reads it from the momentKinds list', () => {
    expect(LIST_IDS).toContain('momentKinds');
    const at = '2026-10-23T09:00:00.000Z';
    const m = Moment.parse({
      _id: 'M1',
      title: 'Born',
      status: 'canon',
      characterId: 'C1',
      year: 1990,
      createdAt: at,
      modifiedAt: at,
    });
    expect(m.kind).toBeNull();
    const spec = momentFields.find((s) => s.name === 'kind')!;
    expect(spec).toMatchObject({ kind: 'listItem', listId: 'momentKinds', nullable: true });
    expect(spec.warnings).toContain('unknown-list-item');
  });

  test('IP-9 a new bible seeds four kinds at the plain weight, Voice with no colour, as migration 12 does', () => {
    expect(ListDoc.parse(seeded).items).toEqual(MOMENT_KIND_SEED);
    expect(seeded.items.map((i) => [i.id, i.label, i.color ?? null])).toEqual([
      ['move', 'Moves', '#008300'],
      ['life', 'Life event', '#e34948'],
      ['work', 'Work and study', '#4a3aa7'],
      ['voice', 'Voice', null],
    ]);
    expect(seeded.items.map((i) => kindWeight(i))).toEqual(['plain', 'plain', 'plain', 'plain']);
  });

  test('SM-3 migration 12 sorts "Lives in" titles into move and "Voice" into voice, nothing else', () => {
    expect(kindFromTitle(`${LIVES_IN_PREFIX}Guangzhou`)).toBe('move');
    expect(kindFromTitle(VOICE_MOMENT_TITLE)).toBe('voice');
    expect(kindFromTitle('Voice lessons')).toBeNull();
    expect(kindFromTitle('voice')).toBeNull();
    expect(kindFromTitle('Lives in')).toBeNull();
    expect(kindFromTitle('Moves to Portland')).toBeNull();
    expect(kindFromTitle(undefined)).toBeNull();
  });
});

describe('A51 moment kinds: colour and weight', () => {
  const lists = [seeded];

  test('SM-9 kindColorCss draws a seeded hex through its kind token and any other hex as it is', () => {
    expect(['move', 'life', 'work'].map((k) => kindColorCss(momentKindItem(lists, k)))).toEqual([
      'var(--kind-move)',
      'var(--kind-life)',
      'var(--kind-work)',
    ]);
    expect(kindColorCss({ color: '#E34948' })).toBe('var(--kind-life)');
    expect(kindColorCss({ color: '#123456' })).toBe('#123456');
    // A family colour a writer reuses for a kind still follows the theme.
    expect(kindColorCss({ color: '#2a78d6' })).toBe('var(--series-1)');
  });

  test('SM-9 a kind with no colour, no kind, and an ID the list does not hold have no colour', () => {
    expect(kindColorCss(momentKindItem(lists, 'voice'))).toBeNull();
    expect(momentKindItem(lists, null)).toBeUndefined();
    expect(momentKindItem(lists, 'gone')).toBeUndefined();
    expect(momentKindItem([], 'move')).toBeUndefined();
    expect(kindColorCss(undefined)).toBeNull();
  });

  test('IP-9 the seeded kind hexes are theme colours elsewhere too; violet stays series-4 outside a kind', () => {
    expect(listColorCss('#008300')).toBe('var(--kind-move)');
    expect(listColorCss('#e34948')).toBe('var(--kind-life)');
    expect(listColorCss('#4a3aa7')).toBe('var(--series-4)');
    expect(Object.values(KIND_HEX_TOKENS)).toEqual(['kind-move', 'kind-life', 'kind-work']);
  });

  test('IP-9 the weight reads extra.weight: big is big, anything else is plain', () => {
    expect(kindWeight({ extra: { weight: 'big' } })).toBe('big');
    expect(kindWeight({ extra: { weight: 'plain' } })).toBe('plain');
    expect(kindWeight({ extra: { weight: 'huge' } })).toBe('plain');
    expect(kindWeight({ extra: {} })).toBe('plain');
    expect(kindWeight({})).toBe('plain');
    expect(kindWeight(undefined)).toBe('plain');
  });
});

describe('A51 NF-2 contrastRatio', () => {
  const r = (a: string, b: string) => Math.round(contrastRatio(a, b) * 10) / 10;

  test('NF-2 the WCAG formula: black on white is 21, a colour on itself is 1, order does not matter', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#4a3aa7', '#4a3aa7')).toBe(1);
    expect(() => contrastRatio('red', '#ffffff')).toThrow();
  });

  test('NF-2 every seeded kind colour clears 3:1 on both chart surfaces, at the values the plan quotes', () => {
    const light: [string, number][] = [
      ['#008300', 4.8],
      ['#e34948', 3.9],
      ['#4a3aa7', 8.3],
      ['#3f4d5b', 8.4], // Voice in --fg-2
    ];
    const dark: [string, number][] = [
      ['#008300', 3.5],
      ['#e66767', 5.4],
      ['#9085e9', 5.6],
      ['#b8c3ce', 9.7], // Voice in --fg-2
    ];
    for (const [hex, want] of light) {
      expect(r(hex, CHART_SURFACE_LIGHT), hex).toBe(want);
      expect(contrastRatio(hex, CHART_SURFACE_LIGHT)).toBeGreaterThanOrEqual(MIN_MARKER_CONTRAST);
    }
    for (const [hex, want] of dark) {
      expect(r(hex, CHART_SURFACE_DARK), hex).toBe(want);
      expect(contrastRatio(hex, CHART_SURFACE_DARK)).toBeGreaterThanOrEqual(MIN_MARKER_CONTRAST);
    }
  });
});
