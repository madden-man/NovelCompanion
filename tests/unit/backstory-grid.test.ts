import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { readFixture } from '../helpers/loadFixture';
import {
  BACKSTORY_MARKERS,
  BACKSTORY_METRICS,
  NO_FAMILY,
  ageIn,
  ageText,
  allMoments,
  backstoryGrid,
  buildFamilies,
  eventsNear,
  hitBackstory,
  insertEventTitle,
  insertMention,
  layoutBackstory,
  lifespanBar,
  lifespanOf,
  lifeProblem,
  momentItems,
  momentsOf,
  moveLifeEnd,
  PICKER_REACH,
  treeOrder,
  withMentionLink,
  withYear,
} from '../../src/shared/domain/backstoryGrid';
import { eventSpans, fromCollections, strandSpans } from '../../src/shared/domain/timeline';
import {
  MARKER_DEFAULTS,
  hitTest,
  makeScale,
  writingBand,
  yearMid,
  yearX,
} from '../../src/shared/domain/worldGrid';
import type { Doc } from '../../src/shared/domain/paths';
import { DEFAULT_NUMBERS } from '../../src/shared/schema/settings';

const fixture = readFixture();
const input = {
  characters: fixture.characters!,
  families: fixture.families!,
  unions: fixture.unions!,
  parentLinks: fixture.parentLinks!,
  moments: fixture.moments!,
};
const grid = backstoryGrid(input);
const person = (id: string) => grid.people.get(id)!;

describe('SM-9 FT-1 rows: families in tree order, people in each', () => {
  test('SM-9 the fixture families are headings in tree order with their people in tree order, No family last', () => {
    // The tree reads top to bottom, left to right: the Hales sit left of the Zhous.
    expect(buildFamilies(input).map((f) => [f.id, f.label, f.people.map((p) => p.id)])).toEqual([
      ['FAM-HALE', 'Hale', ['H1', 'H2', 'H4', 'H3', 'H6', 'H5']],
      ['FAM-ZHOU', 'Zhou', ['Z1', 'Z2', 'Z3', 'Z4', 'Z5']],
      [NO_FAMILY, 'No family', ['U1', 'X1']],
    ]);
  });

  test('SM-9 a character in two families has one row, under the family that comes first', () => {
    const iris = person('H5');
    expect(iris.familyId).toBe('FAM-HALE');
    expect(iris.familyIds).toEqual(['FAM-HALE', 'FAM-ZHOU']);
    const rows = grid.families.flatMap((f) => f.people.map((p) => p.id));
    expect(rows.filter((id) => id === 'H5')).toHaveLength(1);
    expect(rows).toHaveLength(13);
  });

  test('SM-9 the row label carries the name and the Chinese name; the family carries its colour', () => {
    expect([person('Z1').name, person('Z1').chinese]).toEqual(['Zhou Meiling', '周美玲']);
    expect([person('H1').name, person('H1').chinese]).toEqual(['Margaret Hale', '']);
    // A47 (IP-12): a family's colour is a hex value.
    expect(grid.families.map((f) => f.color)).toEqual(['#2a78d6', '#1baf7a', null]);
  });

  test('SM-9 FT-11 stored tree positions set the order: Daniel dragged left of Ruth comes first', () => {
    const before = treeOrder(input);
    expect(before.indexOf('H4')).toBeLessThan(before.indexOf('H3'));
    const positions = {
      H1: { x: 0, y: 0 },
      H2: { x: 200, y: 0 },
      H3: { x: -400, y: 132 },
      H4: { x: 400, y: 132 },
    };
    const moved = buildFamilies({ ...input, positions });
    expect(moved[0]!.people.slice(0, 4).map((p) => p.id)).toEqual(['H1', 'H2', 'H3', 'H4']);
  });

  test('SM-9 a trashed character and a trashed family leave the grid; their people go to No family', () => {
    const trashed = '2026-02-01T00:00:00.000Z';
    const families = buildFamilies({
      ...input,
      characters: input.characters.map((c) => (c._id === 'H6' ? { ...c, deletedAt: trashed } : c)),
      families: input.families.map((f) =>
        f._id === 'FAM-ZHOU' ? { ...f, deletedAt: trashed } : f,
      ),
    });
    expect(families.map((f) => f.id)).toEqual(['FAM-HALE', NO_FAMILY]);
    expect(families[0]!.people.map((p) => p.id)).not.toContain('H6');
    expect(families[1]!.people.map((p) => p.id)).toEqual([
      'U1',
      'Z1',
      'Z2',
      'Z3',
      'Z4',
      'X1',
      'Z5',
    ]);
  });
});

describe('SM-9 TL-2 lifespans from the StoryDates', () => {
  const s = makeScale(grid.span, 10);

  test('SM-9 the axis holds every birth: 1956 (Peter Hale) to 2100', () => {
    expect(grid.span).toEqual({ from: 1956, to: 2100 });
  });

  test('SM-9 TL-2 Margaret Hale lives 1958 to 2041: a solid bar across those years', () => {
    const life = lifespanOf(person('H1'));
    expect(life).toEqual({ kind: 'dead', from: 1958, to: 2041 });
    expect(lifespanBar(life, s, 2040)).toEqual({
      x: (1958 - 1956) * 10,
      width: (2041 - 1958 + 1) * 10,
      dashFrom: null,
    });
  });

  test('SM-9 TL-2 Daniel Hale is alive: the bar runs to the end of the axis, dashed past the story year', () => {
    const life = lifespanOf(person('H3'));
    expect(life).toEqual({ kind: 'alive', from: 1985, to: null });
    expect(lifespanBar(life, s, 2040)).toEqual({
      x: (1985 - 1956) * 10,
      width: (2100 - 1985 + 1) * 10,
      dashFrom: (2041 - 1956) * 10,
    });
    // Noor, born after the story year, is dashed from birth.
    const noor = lifespanBar(lifespanOf(person('Z5')), s, 2040)!;
    expect(noor.dashFrom).toBe(noor.x);
    // With the story year past the end of the axis, nothing is dashed.
    expect(lifespanBar(life, s, 2100)!.dashFrom).toBeNull();
  });

  test('SM-9 CH-4 The Archivist has an unknown birth: no bar, never an estimate', () => {
    const life = lifespanOf(person('U1'));
    expect(life.kind).toBe('unknown');
    expect(lifespanBar(life, s, 2040)).toBeNull();
    // A death on record without a birth still draws nothing.
    expect(
      lifespanBar(lifespanOf({ birth: { unknown: true }, death: { year: 2050 } }), s, 2040),
    ).toBeNull();
  });
});

describe('SM-9 SM-3 moments on the grid', () => {
  test('SM-9 the fixture holds four moments for three characters, each in its own row at its year', () => {
    expect(
      momentItems(grid.moments).map((i) => [i.id, i.row, i.startYear, i.endYear, i.label]),
    ).toEqual([
      ['H1-voice-0', 'H1', 2028, 2028, 'Voice'],
      ['H5-voice-0', 'H5', 2060, 2060, 'Voice'],
      ['Z3-lives-0', 'Z3', 1988, 2027, 'Lives in Guangzhou'],
      ['Z3-lives-1', 'Z3', 2027, 2027, 'Lives in Portland, Oregon'],
    ]);
  });

  test('SM-9 a person’s moments are in year order; a trashed moment is gone; a blank title still labels', () => {
    expect(momentsOf(grid.moments, 'Z3').map((m) => m.id)).toEqual(['Z3-lives-0', 'Z3-lives-1']);
    const g = backstoryGrid({
      ...input,
      moments: [
        ...input.moments.map((m) =>
          m._id === 'Z3-lives-0' ? { ...m, deletedAt: '2026-02-01T00:00:00.000Z' } : m,
        ),
        { ...input.moments[0]!, _id: 'NEW', characterId: 'Z3', year: 2001, title: '' } as Doc,
      ],
    });
    expect(momentsOf(g.moments, 'Z3').map((m) => m.id)).toEqual(['NEW', 'Z3-lives-1']);
    expect(momentItems(momentsOf(g.moments, 'Z3'))[0]!.label).toBe('Untitled moment');
  });

  test('SM-9 TL-3 ages per row: year minus birth year, and plain words outside a life', () => {
    expect(ageText(person('H1'), 2028)).toBe('70');
    expect(ageText(person('Z3'), 1988)).toBe('0');
    expect(ageText(person('Z3'), 2027)).toBe('39');
    // Iris has a full birth date; a year question is still year arithmetic (TL-3).
    expect(ageIn(person('H5'), 2040)).toBe(9);
    expect(ageText(person('H5'), 2060)).toBe('29');
    // TL-4: the year of death is still a living age.
    expect(ageText(person('H1'), 2041)).toBe('83');
    expect(ageText(person('H2'), 2031)).toBe('After death (2030)');
    expect(ageText(person('Z5'), 2040)).toBe('Not yet born');
    expect(ageText(person('U1'), 2040)).toBe('Unknown');
  });

  test('SM-9 hit tests: an empty spot is a person and a year, a marker is its moment, a heading its family', () => {
    const s = makeScale(grid.span, 10);
    const layout = layoutBackstory(grid, s);
    expect(layout.metrics).toEqual(BACKSTORY_METRICS);
    const row = (id: string) =>
      layout.lines.find((l) => l.kind === 'row' && l.row.key === id) as Extract<
        (typeof layout.lines)[number],
        { kind: 'row' }
      >;
    const z3 = row('Z3');
    const midLane = z3.y + BACKSTORY_METRICS.rowPad + BACKSTORY_METRICS.lane / 2;
    expect(hitBackstory(layout, grid, yearMid(s, 2050), midLane)).toEqual({
      kind: 'person',
      characterId: 'Z3',
      year: 2050,
    });
    const portland = z3.layout.markers.find((m) => m.id === 'Z3-lives-1')!;
    const portlandY = z3.y + BACKSTORY_METRICS.rowPad + portland.lane * BACKSTORY_METRICS.lane + 5;
    expect(hitBackstory(layout, grid, portland.x + 2, portlandY)).toEqual({
      kind: 'moment',
      id: 'Z3-lives-1',
      characterId: 'Z3',
      year: 2027,
    });
    const heading = layout.lines.find((l) => l.kind === 'group' && l.group.id === 'FAM-ZHOU')!;
    expect(hitBackstory(layout, grid, yearX(s, 2000) + 1, heading.y + 2)).toEqual({
      kind: 'family',
      familyId: 'FAM-ZHOU',
      year: 2000,
    });
    // The header is nothing.
    expect(hitBackstory(layout, grid, 10, 5)).toBeNull();
  });

  test('SM-9 A49 rows are 48px for one lane and 76px for two; markers are 14px dots with 10px bars', () => {
    const s = makeScale(grid.span, 10);
    const layout = layoutBackstory(grid, s);
    expect(layout.markers).toBe(BACKSTORY_MARKERS);
    const rows = layout.lines.filter((l) => l.kind === 'row');
    const one = rows.find((l) => l.layout.lanes === 1)!;
    expect(one.height).toBe(48);
    // Two moments a year apart in one row cannot share a lane.
    const twoLane = backstoryGrid({
      ...input,
      moments: [
        ...input.moments,
        { ...input.moments[0]!, _id: 'H1-next', year: 2029, title: 'Next' } as Doc,
      ],
    });
    const h1 = layoutBackstory(twoLane, s).lines.find(
      (l) => l.kind === 'row' && l.row.key === 'H1',
    )!;
    expect(h1.kind === 'row' && h1.layout.lanes).toBe(2);
    expect(h1.height).toBe(76);
    const dot = rows.flatMap((l) => l.layout.markers).find((m) => m.id === 'H1-voice-0')!;
    expect(dot.width).toBe(14);
    expect(dot.x).toBe(yearMid(s, 2028) - 7);
    expect(BACKSTORY_MARKERS.barHeight).toBe(10);
    expect(BACKSTORY_MARKERS.bigBarHeight).toBe(14);
    // The World events grid keeps its own sizes.
    expect(MARKER_DEFAULTS).toMatchObject({
      dot: 10,
      bigDot: 16,
      gap: 4,
      barHeight: 8,
      bigBarHeight: 12,
    });
  });

  test('SM-9 A49 the hit test finds a marker across its 14px, and the track beside it is empty', () => {
    const s = makeScale(grid.span, 10);
    const layout = layoutBackstory(grid, s);
    const h1 = layout.lines.find((l) => l.kind === 'row' && l.row.key === 'H1')!;
    if (h1.kind !== 'row') throw new Error('H1 is a row');
    const m = h1.layout.markers.find((x) => x.id === 'H1-voice-0')!;
    const y = h1.y + BACKSTORY_METRICS.rowPad + m.lane * BACKSTORY_METRICS.lane + 14;
    for (const x of [m.x, m.x + 7, m.x + 14]) {
      const h = hitTest(layout, x, y);
      expect(h?.kind === 'marker' && h.marker.id).toBe('H1-voice-0');
    }
    expect(hitTest(layout, m.x + 20, y)?.kind).toBe('empty');
  });

  test('SM-9 a closed family merges its people’s markers onto the heading line', () => {
    const s = makeScale(grid.span, 10);
    const layout = layoutBackstory(grid, s, new Set(['FAM-ZHOU']));
    const heading = layout.lines.find((l) => l.kind === 'group' && l.group.id === 'FAM-ZHOU');
    expect(heading?.kind === 'group' && heading.merged?.markers.map((m) => m.id)).toEqual([
      'Z3-lives-0',
      'Z3-lives-1',
    ]);
    expect(layout.lines.some((l) => l.kind === 'row' && l.row.groupId === 'FAM-ZHOU')).toBe(false);
  });

  test('SM-9 a label shows beside a marker only when its lane leaves room', () => {
    const label = (l: ReturnType<typeof layoutBackstory>, id: string) =>
      l.lines.flatMap((x) => (x.kind === 'row' ? x.layout.markers : [])).find((m) => m.id === id)!
        .showLabel;
    const s = makeScale(grid.span, 10);
    expect(label(layoutBackstory(grid, s), 'H1-voice-0')).toBe(true);
    // A moment three years later shares the lane and leaves 10 pixels: too few for "Voice".
    const crowded = backstoryGrid({
      ...input,
      moments: [
        ...input.moments,
        { ...input.moments[0]!, _id: 'H1-later', year: 2031, title: 'Retires' } as Doc,
      ],
    });
    const l = layoutBackstory(crowded, s);
    expect(label(l, 'H1-voice-0')).toBe(false);
    expect(label(l, 'H1-later')).toBe(true);
  });
});

describe('SM-9 A33 the Relevant world events picker', () => {
  const events = eventSpans(fromCollections({ worldEvents: fixture.worldEvents! }));

  test('SM-9 the events of a year plus or minus one, in date order', () => {
    expect(eventsNear(events, 2042).map((e) => e.id)).toEqual(['E5']);
    expect(eventsNear(events, 2035).map((e) => e.id)).toEqual(['E3', 'E4']);
    // A range counts in every year it runs: 2048 to 2051 is in reach of 2052.
    expect(eventsNear(events, 2052).map((e) => e.id)).toEqual(['E6']);
    expect(eventsNear(events, 2030)).toEqual([]);
  });

  test('SM-9 a picked title goes on a line of its own, once', () => {
    expect(insertEventTitle('', 'Pacific Rim trade accord signed')).toBe(
      'Pacific Rim trade accord signed',
    );
    expect(insertEventTitle('The floods.  \n', 'Pacific Rim trade accord signed')).toBe(
      'The floods.\nPacific Rim trade accord signed',
    );
    expect(
      insertEventTitle(
        'The floods.\nPacific Rim trade accord signed',
        'Pacific Rim trade accord signed',
      ),
    ).toBe('The floods.\nPacific Rim trade accord signed');
  });
});

describe('SM-9 TM-3 the chapter being written', () => {
  test('SM-9 the Writing strand is the band; with no strand picked, the primary strand', () => {
    const strands = strandSpans(fromCollections({ chapters: fixture.chapters! }));
    expect(writingBand(strands, 'CH2', 'CH2-backstory')).toMatchObject({ from: 2032, to: 2032 });
    expect(writingBand(strands, 'CH2', undefined)).toMatchObject({
      from: 2045,
      to: 2045,
      label: 'Chapter 2: Two Kitchens, present, being written (2045)',
    });
    expect(writingBand(strands, undefined, undefined)).toBeNull();
  });
});

describe('NF-1 the Backstory grid with a 5,000-moment bible', () => {
  test('NF-1 SM-9 rows, lifespans, markers and hit tests for 5,000 moments of 500 people lay out under 100 ms', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = { status: 'canon', body: '', createdAt: now, modifiedAt: now };
    const families: Doc[] = Array.from({ length: 20 }, (_, f) => ({
      ...base,
      _id: `F${f}`,
      title: `Family ${f}`,
      name: `Family ${f}`,
      color: `series-${(f % 4) + 1}`,
    }));
    const characters: Doc[] = Array.from({ length: 500 }, (_, i) => ({
      ...base,
      _id: `C${i}`,
      title: `Person ${i}`,
      names: { full: `Person ${i}`, chinese: '' },
      birth: { year: 1950 + (i % 90) },
      death: i % 3 === 0 ? { year: 2040 + (i % 60) } : null,
      familyIds: i % 25 === 0 ? [] : [`F${i % 20}`],
    }));
    // Parents link each person to someone 20 indices earlier, so the tree has depth.
    const parentLinks: Doc[] = characters.slice(20).map((c, i) => ({
      ...base,
      _id: `L${i}`,
      title: '',
      parentId: `C${i}`,
      childId: c._id,
      type: 'biological',
    }));
    const moments: Doc[] = Array.from({ length: 5000 }, (_, i) => ({
      ...base,
      _id: `M${i}`,
      title: `Moment number ${i}`,
      characterId: `C${i % 500}`,
      year: 1960 + ((i * 7) % 130),
      endYear: i % 6 === 0 ? 1960 + ((i * 7) % 130) + 4 : null,
      worldContext: '',
    }));
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      const g = backstoryGrid({ characters, families, unions: [], parentLinks, moments });
      const s = makeScale(g.span, 18);
      const layout = layoutBackstory(g, s, new Set(['F3']));
      for (const p of g.people.values()) lifespanBar(lifespanOf(p), s, 2045);
      for (let y = 0; y < layout.height; y += 7) {
        hitBackstory(layout, g, (y * 13) % layout.width, y);
      }
      runs.push(performance.now() - t0);
      expect(g.moments).toHaveLength(5000);
      expect(g.families.map((f) => f.id)).toContain(NO_FAMILY);
    }
    expect(Math.min(...runs)).toBeLessThan(100);
  });
});

describe('IP-4 dragging a lifespan and the picker mention', () => {
  const axis = { from: 2025, to: 2100 };

  test('IP-4 the left end moves the birth, the right end the death; an open life ends at the axis end', () => {
    const dead = lifespanOf({ birth: { year: 1958 }, death: { year: 2041 } });
    expect(moveLifeEnd(dead, 'start', -2, { from: 1950, to: 2100 })).toEqual({
      from: 1956,
      to: 2041,
    });
    expect(moveLifeEnd(dead, 'end', 3, axis)).toEqual({ from: 1958, to: 2044 });
    const alive = lifespanOf({ birth: { year: 1985 }, death: null });
    expect(moveLifeEnd(alive, 'end', -10, axis)).toEqual({ from: 1985, to: 2090 });
    expect(moveLifeEnd(alive, 'start', 1, axis)).toEqual({ from: 1986, to: null });
    // Pushed past the axis end, an open life stays open: no death in the last year.
    expect(moveLifeEnd(alive, 'end', 1, axis)).toEqual({ from: 1985, to: null });
    expect(moveLifeEnd(lifespanOf({ birth: { unknown: true }, death: null }), 'end', 1, axis)).toBe(
      null,
    );
  });

  test('IP-4 ED-10 a death dragged before the birth is refused with the reason', () => {
    const life = lifespanOf({ birth: { year: 2030 }, death: { year: 2032 } });
    const moved = moveLifeEnd(life, 'end', -5, axis)!;
    expect(moved).toEqual({ from: 2030, to: 2027 });
    expect(lifeProblem(moved.from, moved.to)).toBe(
      'The death year 2027 is before the birth year 2030. Drag the death to 2030 or later.',
    );
    // The birth dragged past the death: the advice is about the birth.
    const late = moveLifeEnd(life, 'start', 5, axis)!;
    expect(late).toEqual({ from: 2035, to: 2032 });
    expect(lifeProblem(late.from, late.to, 'start')).toBe(
      'The death year 2032 is before the birth year 2035. Drag the birth to 2032 or earlier.',
    );
    expect(lifeProblem(2030, 2030)).toBeNull();
    expect(lifeProblem(2030, null)).toBeNull();
  });

  test('IP-4 a moved year keeps the month and day; an unknown date becomes the year', () => {
    expect(withYear({ year: 1958, month: 3, day: 2 }, 1957)).toEqual({
      year: 1957,
      month: 3,
      day: 2,
    });
    expect(withYear({ unknown: true }, 1990)).toEqual({ year: 1990 });
    expect(withYear(null, 2050)).toEqual({ year: 2050 });
  });

  test('IP-4 ED-9 Pick events inserts an @ mention on its own line, once, and adds the link once', () => {
    expect(insertMention('', 'Care robots')).toBe('@Care robots');
    expect(insertMention('Rents doubled.', ' Care robots ')).toBe('Rents doubled.\n@Care robots');
    expect(insertMention('Rents doubled.\n@Care robots', 'Care robots')).toBe(
      'Rents doubled.\n@Care robots',
    );
    expect(insertMention('x', '  ')).toBe('x');
    expect(withMentionLink([], 'E2')).toEqual([{ targetId: 'E2', kind: 'mention' }]);
    expect(withMentionLink([{ targetId: 'E2', kind: 'mentions' }], 'E2')).toEqual([
      { targetId: 'E2', kind: 'mentions' },
    ]);
  });

  test('IP-13 every moment lists by year, then by the person’s name', () => {
    const g = backstoryGrid({ ...input, base: axis });
    const all = allMoments(g.moments, g.people);
    expect(all.map((m) => m.id)).toEqual(['Z3-lives-0', 'Z3-lives-1', 'H1-voice-0', 'H5-voice-0']);
    const tie = allMoments(
      [
        { ...g.moments[0]!, id: 'b', characterId: 'H1', year: 2030, endYear: null },
        { ...g.moments[0]!, id: 'a', characterId: 'Z3', year: 2030, endYear: null },
      ],
      g.people,
    );
    // Margaret Hale before Zhou Lan.
    expect(tie.map((m) => m.id)).toEqual(['b', 'a']);
  });

  test('IP-11 the picker reach defaults to the bible numbers', () => {
    expect(PICKER_REACH).toBe(DEFAULT_NUMBERS.pickerReach);
  });
});
