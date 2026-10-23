import { describe, expect, test } from 'vitest';
import {
  countListUsage,
  defaultProvenance,
  defaultStatus,
  familyColorCss,
  familyToken,
  isUnder,
  listColorCss,
  moveItem,
  parentProblem,
  statusKind,
} from '../../src/shared/domain/lists';
import {
  ageGroupOptions,
  decadeGroups,
  decadesFor,
  demographicOf,
  spanInDecade,
  unitLabel,
  unitOf,
  unitSpan,
} from '../../src/shared/domain/culture';
import { gridSpan, yearWindow } from '../../src/shared/domain/worldGrid';
import { backstoryGrid, eventsNear } from '../../src/shared/domain/backstoryGrid';
import { selectForSession } from '../../src/shared/domain/brief/selection';
import { establishedPlanned } from '../../src/shared/domain/manuscript';
import { fromCollections } from '../../src/shared/domain/timeline';
import { computeWarnings } from '../../src/shared/domain/warnings';
import {
  BibleSettings,
  DEFAULT_BIBLE_SETTINGS,
  DEFAULT_TEMPLATES,
  Family,
  ListDoc,
  WorldEvent,
  autosaveMaxMs,
  bibleSettings,
  fillTemplate,
  manifests,
  templates,
} from '../../src/shared/schema';
import { briefCollections } from '../helpers/briefFixture';
import { readFixture } from '../helpers/loadFixture';

const fixture = readFixture();
const fixtureList = (id: string) => fixture.lists!.find((l) => l._id === id)!;
const AT = '2026-01-15T09:00:00.000Z';

describe('IP-8 list items carry a colour and extra values, move, and take parents', () => {
  test('IP-8 an item stored before A47 reads with no colour and no extra values', () => {
    const list = ListDoc.parse({
      _id: 'communities',
      label: 'Communities',
      items: [{ id: 'sf', label: 'San Francisco', parentId: null }],
    });
    expect(list.items[0]).toEqual({
      id: 'sf',
      label: 'San Francisco',
      parentId: null,
      color: null,
      extra: {},
    });
    expect(() => ListDoc.parse({ ...list, items: [{ ...list.items[0], color: 'blue' }] })).toThrow(
      /hex value/,
    );
  });

  test('IP-8 moveItem puts an item at an index of the stored order, clamped to the ends', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(moveItem(items, 'a', 2)!.map((i) => i.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(items, 'd', 0)!.map((i) => i.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(items, 'b', 99)!.map((i) => i.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveItem(items, 'b', -3)!.map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveItem(items, 'zz', 1)).toBeNull();
  });

  test('IP-8 an item cannot sit under itself or anything under it, and the reason is plain', () => {
    const cats = fixtureList('eventCategories').items as {
      id: string;
      label: string;
      parentId: string | null;
    }[];
    expect(isUnder(cats, 'robotics', 'technology')).toBe(true);
    expect(isUnder(cats, 'climate', 'technology')).toBe(false);
    expect(parentProblem(cats, 'climate', 'technology')).toBeNull();
    expect(parentProblem(cats, 'robotics', null)).toBeNull();
    expect(parentProblem(cats, 'technology', 'robotics')).toBe(
      'Technology cannot sit under Robotics, which is already under it.',
    );
    expect(parentProblem(cats, 'technology', 'technology')).toBe(
      'Technology cannot sit under itself.',
    );
    expect(parentProblem(cats, 'technology', 'nowhere')).toBe(
      'The parent item is not in this list.',
    );
  });

  test('IP-8 world events store region item IDs: the manifest names the regions list and usage counts by ID', () => {
    const spec = manifests.worldEvents.find((s) => s.name === 'regions')!;
    expect([spec.kind, spec.listId]).toEqual(['listItems', 'regions']);
    const all = [
      { collection: 'worldEvents', manifest: manifests.worldEvents, docs: fixture.worldEvents! },
    ];
    expect(countListUsage('regions', { id: 'oregon', label: 'Oregon' }, all)).toBe(4);
    expect(countListUsage('regions', { id: 'china', label: 'China' }, all)).toBe(2);
    expect(countListUsage('regions', { id: 'mars', label: 'Mars' }, all)).toBe(0);
  });

  test('IP-8 a region ID that is not in the list is a field warning on that region', () => {
    const event = WorldEvent.parse({
      ...fixture.worldEvents![0],
      regions: ['oregon', 'atlantis'],
    });
    const warnings = computeWarnings('worldEvents', manifests.worldEvents, event, {
      get: () => undefined,
      find: () => undefined,
      list: (id) => fixture.lists!.find((l) => l._id === id) as never,
      all: () => [],
    });
    expect(warnings.filter((w) => w.code === 'unknown-list-item')).toEqual([
      {
        path: 'regions.1',
        code: 'unknown-list-item',
        message: '"atlantis" is not in the Regions list. Add it there or pick another.',
      },
    ]);
  });
});

describe('IP-9 statuses and provenance are lists with colours, and a status has a kind', () => {
  const lists = fixture.lists!;

  test('IP-9 statusKind reads the item kind, so a renamed or added status keeps the brief rules', () => {
    expect(statusKind(lists, 'canon')).toBe('canon');
    expect(statusKind(lists, 'planned')).toBe('planned');
    expect(statusKind(lists, 'idea')).toBe('idea');
    const own = [
      {
        _id: 'statuses',
        items: [
          { id: 'settled', label: 'Settled', extra: { kind: 'canon' } },
          { id: 'canon', label: 'Canon', extra: { kind: 'planned' } },
        ],
      },
    ];
    expect(statusKind(own, 'settled')).toBe('canon');
    expect(statusKind(own, 'canon')).toBe('planned');
  });

  test('IP-9 defaultStatus gives the first status of a kind, then the item named for it, then the first', () => {
    const own = [
      {
        _id: 'statuses',
        items: [
          { id: 'settled', label: 'Settled', extra: { kind: 'canon' } },
          { id: 'notion', label: 'Notion', extra: { kind: 'idea' } },
          { id: 'whim', label: 'Whim', extra: { kind: 'idea' } },
        ],
      },
    ];
    expect(defaultStatus(own, 'idea')).toBe('notion');
    expect(defaultStatus(own, 'canon')).toBe('settled');
    expect(defaultStatus(own, 'planned')).toBe('settled');
    expect(defaultStatus(lists, 'planned')).toBe('planned');
    expect(
      defaultStatus([{ _id: 'statuses', items: [{ id: 'idea', label: 'Idea' }] }], 'idea'),
    ).toBe('idea');
    expect(defaultStatus([], 'idea')).toBe('idea');
    expect(defaultProvenance(lists, 'invented')).toBe('invented');
    expect(defaultProvenance([{ _id: 'provenance', items: [] }], 'invented')).toBeNull();
    expect(defaultProvenance([], 'invented')).toBe('invented');
  });

  test('IP-9 a status with no kind reads by its seeded ID, and anything unknown is never canon', () => {
    expect(statusKind([], 'canon')).toBe('canon');
    expect(statusKind([], 'planned')).toBe('planned');
    expect(statusKind([], 'drafted')).toBe('idea');
    expect(statusKind([], undefined)).toBe('idea');
  });

  test('IP-9 the seeded colours draw through their theme tokens; any other hex as it is', () => {
    const statuses = fixtureList('statuses').items as { id: string; color: string }[];
    expect(statuses.map((s) => listColorCss(s.color))).toEqual([
      'var(--canon)',
      'var(--series-4)',
      'var(--idea)',
    ]);
    const prov = fixtureList('provenance').items as { color: string }[];
    expect(prov.map((p) => listColorCss(p.color))).toEqual([
      'var(--series-1)',
      'var(--serious-ink)',
    ]);
    expect(listColorCss('#123456')).toBe('#123456');
    expect(listColorCss(null)).toBeNull();
  });

  test('IP-9 status and provenance are list references in every manifest', () => {
    for (const manifest of Object.values(manifests)) {
      const status = manifest.find((s) => s.name === 'status')!;
      const prov = manifest.find((s) => s.name === 'provenance')!;
      expect([status.kind, status.listId, status.required]).toEqual(['listItem', 'statuses', true]);
      expect([prov.kind, prov.listId, prov.nullable]).toEqual(['listItem', 'provenance', true]);
    }
  });

  test('IP-9 SB-5 a selected item carries the kind of its status: a canon-kind status is canon, an idea-kind one is idea', () => {
    const cols = briefCollections(true);
    cols.lists = cols.lists!.map((l) =>
      l._id === 'statuses'
        ? {
            ...l,
            items: [
              ...(l.items as object[]),
              {
                id: 'settled',
                label: 'Settled',
                parentId: null,
                color: null,
                extra: { kind: 'canon' },
              },
              {
                id: 'shelved',
                label: 'Shelved',
                parentId: null,
                color: null,
                extra: { kind: 'idea' },
              },
            ],
          }
        : l,
    );
    const b4 = cols.moments!.find((m) => m._id === 'B4')!;
    const before = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH6' });
    const b4Item = before.strands[0]!.groups.flatMap((g) => g.items).find((i) => i.id === 'B4')!;
    expect(b4Item.kind).toBe(b4.status === 'canon' ? 'canon' : b4.status);

    const asStatus = (status: string) => {
      const c = {
        ...cols,
        moments: cols.moments!.map((m) => (m._id === 'B4' ? { ...m, status } : m)),
      };
      const sel = selectForSession(fromCollections(c), { kind: 'chapter', chapterId: 'CH6' });
      return sel.strands[0]!.groups.flatMap((g) => g.items).find((i) => i.id === 'B4')!;
    };
    const settled = asStatus('settled');
    expect([settled.status, settled.kind]).toEqual(['settled', 'canon']);
    const shelved = asStatus('shelved');
    expect([shelved.status, shelved.kind]).toEqual(['shelved', 'idea']);
  });

  test('IP-9 MS-3 a written chapter establishes entries whose status kind is planned', () => {
    const cols = briefCollections(true);
    const plannedIds = establishedPlanned(fromCollections(cols), 'CH6').map((e) => e.id);
    expect(plannedIds.length).toBeGreaterThan(0);
    const withKind = (kind: string) =>
      cols.lists!.map((l) =>
        l._id === 'statuses'
          ? {
              ...l,
              items: (l.items as { id: string; extra?: object }[]).map((i) =>
                i.id === 'planned' ? { ...i, extra: { kind } } : i,
              ),
            }
          : l,
      );
    // The same entries, their status now meaning idea: nothing is established.
    expect(
      establishedPlanned(fromCollections({ ...cols, lists: withKind('idea') }), 'CH6'),
    ).toEqual([]);
    expect(
      establishedPlanned(fromCollections({ ...cols, lists: withKind('planned') }), 'CH6').map(
        (e) => e.id,
      ),
    ).toEqual(plannedIds);
  });
});

describe('IP-10 age groups and the cultural time unit', () => {
  const ageGroups = fixtureList('ageGroups') as unknown as {
    items: { id: string; label: string; extra: { from: number; to?: number } }[];
  };

  test('IP-10 the age groups list holds the six A41 bands with their ages under the IDs lines store', () => {
    expect(ageGroups.items.map((i) => [i.id, i.extra.from, i.extra.to ?? null])).toEqual([
      ['all', 0, null],
      ['0-18', 0, 18],
      ['18-30', 18, 30],
      ['30-50', 30, 50],
      ['50-70', 50, 70],
      ['70+', 70, null],
    ]);
    expect(ageGroupOptions(ageGroups).map((o) => o.label)[0]).toBe('Everyone');
    expect(ageGroupOptions(undefined)).toHaveLength(6);
    const spec = manifests.culturalEntries.find((s) => s.name === 'demographic')!;
    expect([spec.kind, spec.listId]).toEqual(['listItem', 'ageGroups']);
  });

  test('IP-10 a line keeps its age group when the group is in the list, else it is about everyone', () => {
    const groups = [...ageGroupOptions(ageGroups), { value: 'teens', label: 'Teens' }];
    expect(demographicOf({ demographic: 'teens' }, groups)).toBe('teens');
    expect(demographicOf({ demographic: 'teens' })).toBe('all');
    expect(demographicOf({})).toBe('all');
  });

  test('IP-10 a decade unit: 2047 is the 2040s, a line added covers the decade', () => {
    expect(unitOf(2047, 'decade')).toBe(2040);
    expect(unitLabel(2040, 'decade')).toBe('2040s');
    expect(unitSpan(2040, 'decade')).toEqual({ startYear: 2040, endYear: 2049 });
    expect(spanInDecade({ startYear: 2040, endYear: 2049 }, 2040, 'decade')).toBeNull();
  });

  test('IP-10 a five year unit: 2047 is 2045 to 2049, and the units step by five', () => {
    expect(unitOf(2047, 'five')).toBe(2045);
    expect(unitOf(2044, 'five')).toBe(2040);
    expect(unitLabel(2045, 'five')).toBe('2045 to 2049');
    expect(unitSpan(2045, 'five')).toEqual({ startYear: 2045, endYear: 2049 });
    expect(decadesFor([], [], 2047, 'five')).toEqual([2040, 2045, 2050]);
    expect(spanInDecade({ startYear: 2045, endYear: 2049 }, 2045, 'five')).toBeNull();
    expect(spanInDecade({ startYear: 2040, endYear: 2049 }, 2045, 'five')).toBe('2040 to 2049');
  });

  test('IP-10 a one year unit: each year is its own unit', () => {
    expect(unitOf(2047, 'one')).toBe(2047);
    expect(unitLabel(2047, 'one')).toBe('2047');
    expect(unitSpan(2047, 'one')).toEqual({ startYear: 2047, endYear: 2047 });
    expect(decadesFor([], [], 2047, 'one')).toEqual([2046, 2047, 2048]);
    expect(spanInDecade({ startYear: 2047, endYear: 2047 }, 2047, 'one')).toBeNull();
  });

  test('IP-10 the groups of a unit follow the age groups list order and take lines that touch the unit', () => {
    const line = (id: string, start: number, end: number, demographic = 'all') => ({
      _id: id,
      title: id,
      communityId: 'sf',
      startYear: start,
      endYear: end,
      demographic,
    });
    const entries = [line('a', 2040, 2049), line('b', 2046, 2046, '18-30'), line('c', 2041, 2042)];
    const five = decadeGroups(entries, 'sf', 2045, 'five', ageGroupOptions(ageGroups));
    expect(five.map((g) => [g.demographic, g.rows.map((r) => r._id)])).toEqual([
      ['all', ['a']],
      ['0-18', []],
      ['18-30', ['b']],
      ['30-50', []],
      ['50-70', []],
      ['70+', []],
    ]);
    const one = decadeGroups(entries, 'sf', 2041, 'one', [{ value: 'all', label: 'Everyone' }]);
    expect(one.map((g) => g.rows.map((r) => r._id))).toEqual([['a', 'c']]);
  });
});

describe('IP-11 the grids, the brief window and the picker take the bible numbers', () => {
  test('IP-11 the grid span starts from the bible timeline and still widens to every year', () => {
    expect(gridSpan([], { from: 2030, to: 2060 })).toEqual({ from: 2030, to: 2060 });
    expect(gridSpan([2020, 2070], { from: 2030, to: 2060 })).toEqual({ from: 2020, to: 2070 });
    expect(gridSpan([])).toEqual({ from: 2025, to: 2100 });
  });

  test('IP-11 the world window reads years before and after', () => {
    expect(yearWindow(2051, 5, 2)).toEqual({ from: 2046, to: 2053 });
    expect(yearWindow(2051)).toEqual({ from: 2048, to: 2052 });
  });

  test('IP-11 the Backstory grid starts from the bible timeline', () => {
    const input = {
      characters: fixture.characters!,
      families: fixture.families!,
      unions: fixture.unions!,
      parentLinks: fixture.parentLinks!,
      moments: fixture.moments!,
    };
    const base = backstoryGrid(input).span;
    const wide = backstoryGrid({ ...input, base: { from: 1900, to: 2200 } }).span;
    expect(wide).toEqual({ from: Math.min(1900, base.from), to: 2200 });
  });

  test('IP-11 the events picker reaches the bible number of years either side', () => {
    const events = [2040, 2042, 2045, 2048].map((y, i) => ({
      id: `e${i}`,
      startYear: y,
      endYear: y,
    }));
    expect(eventsNear(events, 2045).map((e) => e.startYear)).toEqual([2045]);
    expect(eventsNear(events, 2045, 3).map((e) => e.startYear)).toEqual([2042, 2045, 2048]);
    expect(eventsNear(events, 2045, 0).map((e) => e.startYear)).toEqual([2045]);
  });

  test('IP-11 SB-2 the brief looks ahead the bible number of years after the story year', () => {
    const cols = briefCollections(true);
    const b4 = cols.moments!.find((m) => m._id === 'B4')!;
    cols.moments = [
      ...cols.moments!,
      { ...b4, _id: 'M-NEXT', title: 'Iris answers the letter', year: 2046 },
      { ...b4, _id: 'M-LATER', title: 'Iris moves to Seattle', year: 2050 },
    ];
    const ahead = (n?: number) => {
      const sel = selectForSession(
        fromCollections(cols),
        { kind: 'chapter', chapterId: 'CH6' },
        { window: 3, budget: 40_000, ...(n === undefined ? {} : { ahead: n }) },
      );
      return {
        ahead: sel.ahead,
        ids: sel.strands[0]!.groups.filter((g) => g.kind === 'plannedAhead').flatMap((g) =>
          g.items.map((i) => i.id),
        ),
      };
    };
    expect(ahead()).toMatchObject({ ahead: 1 });
    expect(ahead().ids).toContain('M-NEXT');
    expect(ahead().ids).not.toContain('M-LATER');
    expect(ahead(0).ids).not.toContain('M-NEXT');
    expect(ahead(5).ids).toEqual(expect.arrayContaining(['M-NEXT', 'M-LATER']));
  });

  test('IP-11 the longest autosave wait is the larger of 700 and the delay plus 200', () => {
    expect(autosaveMaxMs({ autosaveMs: 500 })).toBe(700);
    expect(autosaveMaxMs({ autosaveMs: 300 })).toBe(700);
    expect(autosaveMaxMs({ autosaveMs: 750 })).toBe(950);
  });

  test('IP-11 the stored numbers are read with defaults for anything missing or out of range', () => {
    expect(bibleSettings(undefined)).toEqual(DEFAULT_BIBLE_SETTINGS);
    const s = bibleSettings({
      cultureUnit: 'five',
      numbers: {
        timelineStart: 2000,
        windowBefore: 'x',
        autosaveMs: 99_999,
        pickerReach: 4,
        outlineVersionDays: 0,
      },
    });
    expect(s.cultureUnit).toBe('five');
    expect(s.numbers).toEqual({
      timelineStart: 2000,
      timelineEnd: 2100,
      windowBefore: 3,
      windowAfter: 1,
      pickerReach: 4,
      autosaveMs: 500,
      outlineVersionDays: 7,
    });
    expect(bibleSettings({ numbers: { outlineVersionDays: 14 } }).numbers.outlineVersionDays).toBe(
      14,
    );
    // An end before the start falls back to the default span.
    expect(bibleSettings({ numbers: { timelineStart: 2200 } }).numbers.timelineStart).toBe(2025);
    expect(BibleSettings.safeParse(DEFAULT_BIBLE_SETTINGS).success).toBe(true);
  });
});

describe('IP-12 family colour is any hex colour', () => {
  test('IP-12 a family takes any hex and refuses a token name', () => {
    const base = {
      _id: 'F1',
      title: 'Hale',
      name: 'Hale',
      status: 'canon',
      createdAt: AT,
      modifiedAt: AT,
    };
    expect(Family.parse({ ...base, color: '#AbCdEf' }).color).toBe('#AbCdEf');
    expect(Family.parse(base).color).toBe('#2a78d6');
    expect(() => Family.parse({ ...base, color: 'series-2' })).toThrow(/hex value/);
  });

  test('IP-12 the four colours families had draw through their series tokens; others as the hex', () => {
    expect(['#2a78d6', '#EB6834', '#1baf7a', '#4a3aa7'].map(familyToken)).toEqual([
      'series-1',
      'series-2',
      'series-3',
      'series-4',
    ]);
    expect(familyToken('series-3')).toBe('series-3');
    expect(familyToken('#123456')).toBeNull();
    expect(familyColorCss('#1baf7a')).toBe('var(--series-3)');
    expect(familyColorCss('#123456')).toBe('#123456');
    expect(familyColorCss('not a colour')).toBeNull();
    expect(fixture.families!.map((f) => familyToken(f.color))).toEqual(['series-1', 'series-3']);
  });
});

describe('IP-14 templates', () => {
  test('IP-14 the templates fill in the defaults the app has always used', () => {
    expect(templates(undefined)).toEqual(DEFAULT_TEMPLATES);
    expect(DEFAULT_TEMPLATES).toMatchObject({
      chapterTitle: 'New chapter',
      sectionTitle: 'New section',
      partTitle: 'Part {n}',
      strandPresent: 'present',
      strandBackstory: 'backstory',
      eraName: 'New era',
    });
    expect(DEFAULT_TEMPLATES.linkTypeLabels.biological).toBe('Biological parent');
  });

  test('IP-14 stored templates win, a bad one falls back, and link labels merge onto the defaults', () => {
    const t = templates({
      templates: {
        chapterTitle: 'Untitled scene',
        sectionTitle: '',
        linkTypeLabels: { step: 'Stepparent' },
      },
    });
    expect(t.chapterTitle).toBe('Untitled scene');
    expect(t.sectionTitle).toBe('New section');
    expect(t.linkTypeLabels).toMatchObject({ step: 'Stepparent', married: 'Married' });
  });

  test('IP-14 fillTemplate puts the number in place of {n}', () => {
    expect(fillTemplate('Part {n}', 2)).toBe('Part 2');
    expect(fillTemplate('Book {n} of the saga', 1)).toBe('Book 1 of the saga');
    expect(fillTemplate('New chapter')).toBe('New chapter');
  });
});
