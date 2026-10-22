import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { readFixture } from '../helpers/loadFixture';
import {
  bandGaps,
  buildGroups,
  categoryScope,
  DEFAULT_SPAN,
  dragYears,
  edgeAt,
  HANDLE_W,
  moveEdge,
  moveSharedEdge,
  neighbourAt,
  snapEdge,
  GRID_METRICS,
  gridSpan,
  hitTest,
  inWindow,
  layoutGrid,
  lineAt,
  makeScale,
  placeRow,
  scaleWidth,
  scrollToYear,
  shiftEnd,
  shiftSpan,
  tickYears,
  UNFILED,
  yearAt,
  yearMid,
  yearWindow,
  yearX,
  zoomPpy,
} from '../../src/shared/domain/worldGrid';
import type { CategoryItem, GridItem } from '../../src/shared/domain/worldGrid';
import { DEFAULT_NUMBERS } from '../../src/shared/schema/settings';

const fixture = readFixture();
const categories = (fixture.lists!.find((l) => l._id === 'eventCategories')!.items ??
  []) as CategoryItem[];

const item = (id: string, row: string, start: number, end = start, big = false): GridItem => ({
  id,
  row,
  startYear: start,
  endYear: end,
  big,
  label: `Event ${id}`,
});

describe('SM-8 the year axis', () => {
  test('SM-8 the span is 2025 to 2100 by default and widens to take in every year given', () => {
    expect(gridSpan([])).toEqual({ from: 2025, to: 2100 });
    expect(gridSpan([2040, 2090])).toEqual({ from: 2025, to: 2100 });
    expect(gridSpan([2008, 2104])).toEqual({ from: 2008, to: 2104 });
  });

  test('SM-8 zoom: the whole span fits the track, default and close are fixed widths', () => {
    const span = { from: 2025, to: 2100 };
    expect(zoomPpy('fit', 760, span)).toBe(10);
    expect(scaleWidth(makeScale(span, zoomPpy('fit', 760, span)))).toBeLessThanOrEqual(760);
    expect(zoomPpy('fit', 10, span)).toBe(3);
    expect(zoomPpy('default', 760, span)).toBeLessThan(zoomPpy('close', 760, span));
  });

  test('SM-8 x from year and year from x round trip; x past the ends clamps to the span', () => {
    const s = makeScale({ from: 2025, to: 2100 }, 20);
    expect(yearX(s, 2025)).toBe(0);
    expect(yearX(s, 2040)).toBe(300);
    expect(yearMid(s, 2040)).toBe(310);
    expect(yearAt(s, 300)).toBe(2040);
    expect(yearAt(s, 319.9)).toBe(2040);
    expect(yearAt(s, 320)).toBe(2041);
    expect(yearAt(s, -50)).toBe(2025);
    expect(yearAt(s, 99999)).toBe(2100);
    expect(scaleWidth(s)).toBe(76 * 20);
  });

  test('SM-8 header ticks thin out as the columns narrow so labels never collide', () => {
    const wide = makeScale({ from: 2025, to: 2035 }, 44);
    expect(tickYears(wide)).toEqual([
      2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035,
    ]);
    const narrow = makeScale({ from: 2025, to: 2100 }, 5);
    expect(tickYears(narrow)).toEqual([2030, 2040, 2050, 2060, 2070, 2080, 2090, 2100]);
    for (const ppy of [3, 7, 12, 18, 44]) {
      const t = tickYears(makeScale({ from: 2025, to: 2100 }, ppy));
      for (let i = 1; i < t.length; i++)
        expect((t[i]! - t[i - 1]!) * ppy).toBeGreaterThanOrEqual(40);
    }
  });

  test('SM-8 the grid opens scrolled so the story year is in view', () => {
    const s = makeScale({ from: 2025, to: 2100 }, 20);
    const left = scrollToYear(s, 2060, 400);
    expect(yearMid(s, 2060)).toBeGreaterThan(left);
    expect(yearMid(s, 2060)).toBeLessThan(left + 400);
    expect(scrollToYear(s, 2025, 400)).toBe(0);
    expect(scrollToYear(s, 2100, 400)).toBe(scaleWidth(s) - 400);
  });
});

describe('SM-8 rows from the category list', () => {
  test('SM-8 the fixture list gives its groups in list order, subcategories as rows under their heading', () => {
    const { groups, rowOf } = buildGroups(categories, [
      'robotics',
      'energy',
      'technology',
      'climate',
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Technology',
      'Climate',
      'Geopolitics',
      'Economy',
      'Culture',
    ]);
    // Technology has events of its own, so it keeps a row for them above its subcategories.
    expect(groups[0]!.rows.map((r) => [r.key, r.label, r.own])).toEqual([
      ['technology', 'General', true],
      ['robotics', 'Robotics', false],
      ['energy', 'Energy', false],
    ]);
    // A heading with no subcategory is its own row.
    expect(groups[1]!.rows.map((r) => [r.key, r.label])).toEqual([['climate', 'Climate']]);
    expect(rowOf.get('robotics')).toBe('robotics');
    expect(rowOf.get('technology')).toBe('technology');
  });

  test('SM-8 a heading with subcategories and no events of its own has no own row', () => {
    const { groups } = buildGroups(categories, ['robotics']);
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['robotics', 'energy']);
  });

  test('SM-8 deeper items file into their subcategory row; unknown categories gather last; cycles end', () => {
    const items: CategoryItem[] = [
      { id: 'tech', label: 'Technology', parentId: null },
      { id: 'ai', label: 'AI', parentId: 'tech' },
      { id: 'llm', label: 'Language models', parentId: 'ai' },
      { id: 'a', label: 'A', parentId: 'b' },
      { id: 'b', label: 'B', parentId: 'a' },
    ];
    const { groups, rowOf } = buildGroups(items, ['llm', 'gone']);
    expect(rowOf.get('llm')).toBe('ai');
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['ai']);
    const last = groups.at(-1)!;
    expect(last.id).toBe(UNFILED);
    expect(last.rows.map((r) => r.key)).toEqual(['gone']);
    expect(rowOf.get('gone')).toBe('gone');
  });

  test('SM-8 a closed heading merges its rows onto the heading line', () => {
    const { groups } = buildGroups(categories, ['robotics', 'energy'], new Set(['technology']));
    const s = makeScale({ from: 2025, to: 2100 }, 20);
    const items = [
      item('E2', 'robotics', 2027),
      item('E5', 'energy', 2042),
      item('E9', 'robotics', 2072),
    ];
    const layout = layoutGrid(groups, items, s);
    const tech = layout.lines[0]!;
    expect(tech.kind).toBe('group');
    if (tech.kind !== 'group') throw new Error('not a group');
    expect(tech.group.open).toBe(false);
    expect(tech.merged?.markers.map((m) => m.id)).toEqual(['E2', 'E5', 'E9']);
    // No row lines for a closed group: the next line is the Climate heading.
    expect(layout.lines[1]).toMatchObject({ kind: 'group', group: { id: 'climate' } });
    const open = layoutGrid(buildGroups(categories, ['robotics']).groups, items, s);
    expect(open.lines.filter((l) => l.kind === 'row').length).toBeGreaterThan(2);
  });
});

describe('SM-8 marker placement', () => {
  const s = makeScale({ from: 2025, to: 2100 }, 20);

  test('SM-8 a single year is a dot in its column, larger when big; a range is a bar to its end year', () => {
    const row = placeRow(
      'r',
      [item('a', 'r', 2030), item('b', 'r', 2040, 2040, true), item('c', 'r', 2050, 2053)],
      s,
    );
    const [a, b, c] = row.markers;
    expect(a).toMatchObject({ bar: false, x: yearMid(s, 2030) - 5, width: 10 });
    expect(b).toMatchObject({ bar: false, big: true, x: yearMid(s, 2040) - 8, width: 16 });
    expect(c).toMatchObject({ bar: true, x: yearX(s, 2050), width: 4 * 20 });
  });

  test('SM-8 a label shows when the next marker in the lane leaves room, else it hides', () => {
    const row = placeRow(
      'r',
      [item('a', 'r', 2030), item('b', 'r', 2032), item('c', 'r', 2060)],
      s,
    );
    const [a, b, c] = row.markers;
    expect(a!.showLabel).toBe(false);
    expect(a!.labelRoom).toBe(40 - 10 - 4);
    expect(b!.showLabel).toBe(true);
    expect(c!.showLabel).toBe(true);
    // The last marker's room runs to the end of the track.
    expect(c!.labelRoom).toBe(scaleWidth(s) - (c!.x + c!.width) - 4);
  });

  test('SM-8 overlapping markers take the next lane; markers keep reading order by year', () => {
    const row = placeRow(
      'r',
      [item('late', 'r', 2048, 2051), item('early', 'r', 2045, 2050), item('same', 'r', 2045)],
      s,
    );
    expect(row.markers.map((m) => m.id)).toEqual(['same', 'early', 'late']);
    // The range from 2048 clears the dot at 2045, so it goes back to the first lane.
    expect(row.markers.map((m) => m.lane)).toEqual([0, 1, 0]);
    expect(row.lanes).toBe(2);
    const crowded = placeRow(
      'r',
      Array.from({ length: 9 }, (_, i) => item(`x${i}`, 'r', 2040)),
      s,
    );
    expect(crowded.lanes).toBe(4);
  });
});

describe('SM-8 hit testing', () => {
  const s = makeScale({ from: 2025, to: 2100 }, 20);
  const { groups } = buildGroups(categories, ['robotics', 'climate']);
  const layout = layoutGrid(groups, [item('E2', 'robotics', 2027), item('E3', 'climate', 2034)], s);
  const robotics = layout.lines.find((l) => l.kind === 'row' && l.row.key === 'robotics')!;
  const tech = layout.lines.find((l) => l.kind === 'group' && l.group.id === 'technology')!;
  const mid = (y: number) => robotics.y + GRID_METRICS.rowPad + y;

  test('SM-8 a pointer maps to the row and the year under it', () => {
    expect(hitTest(layout, yearX(s, 2061) + 3, mid(5))).toEqual({
      kind: 'empty',
      rowKey: 'robotics',
      year: 2061,
    });
    expect(lineAt(layout, robotics.y)).toBe(robotics);
    expect(lineAt(layout, robotics.y + robotics.height - 0.5)).toBe(robotics);
  });

  test('SM-8 a pointer on a marker finds it; the header and the label column find nothing', () => {
    const hit = hitTest(layout, yearMid(s, 2027), mid(10));
    expect(hit).toMatchObject({
      kind: 'marker',
      rowKey: 'robotics',
      marker: { id: 'E2' },
      year: 2027,
    });
    expect(hitTest(layout, 30, 10)).toBeNull();
    expect(hitTest(layout, -1, mid(5))).toBeNull();
    expect(hitTest(layout, 30, layout.height + 5)).toBeNull();
    expect(hitTest(layout, 30, tech.y + 3)).toEqual({
      kind: 'group',
      groupId: 'technology',
      year: 2026,
    });
  });
});

describe('SM-8 drag arithmetic', () => {
  const span = { from: 2025, to: 2100 };

  test('SM-8 pixels become whole years at the zoom', () => {
    expect(dragYears(0, 20)).toBe(0);
    expect(dragYears(9, 20)).toBe(0);
    expect(dragYears(11, 20)).toBe(1);
    expect(dragYears(-61, 20)).toBe(-3);
    expect(Object.is(dragYears(-4, 20), -0)).toBe(false);
  });

  test('SM-8 a span moves with its end and clamps to the axis', () => {
    expect(shiftSpan(2048, 2051, 2, span)).toEqual({ startYear: 2050, endYear: 2053, delta: 2 });
    expect(shiftSpan(2048, 2051, 80, span)).toEqual({ startYear: 2097, endYear: 2100, delta: 49 });
    expect(shiftSpan(2030, 2030, -10, span)).toEqual({ startYear: 2025, endYear: 2025, delta: -5 });
    // An event already before the axis can still move later, never further back.
    expect(shiftSpan(2008, 2008, -1, span)).toEqual({ startYear: 2008, endYear: 2008, delta: 0 });
    expect(shiftSpan(2008, 2008, 1, span)).toEqual({ startYear: 2009, endYear: 2009, delta: 1 });
  });

  test('SM-8 the end year moves alone, never before the start', () => {
    expect(shiftEnd(2048, 2051, 1, span)).toBe(2052);
    expect(shiftEnd(2048, 2048, -1, span)).toBe(2048);
    expect(shiftEnd(2048, 2100, 1, span)).toBe(2100);
  });
});

describe('SM-8 A33 the world around the story year', () => {
  test('SM-8 A33 the window is three years before the story year through one after', () => {
    expect(yearWindow(2051)).toEqual({ from: 2048, to: 2052 });
    const events = [
      { id: 'a', startYear: 2040, endYear: 2047 },
      { id: 'b', startYear: 2040, endYear: 2048 },
      { id: 'c', startYear: 2052, endYear: 2052 },
      { id: 'd', startYear: 2053, endYear: 2053 },
      { id: 'e', startYear: 2050, endYear: 2050 },
    ];
    expect(inWindow(events, yearWindow(2051)).map((e) => e.id)).toEqual(['b', 'e', 'c']);
  });
});

describe('NF-1 the grid with a 5,000-event bible', () => {
  test('NF-1 SM-8 rows, markers and hit tests for 5,000 events across 111 rows lay out under 100 ms', () => {
    const items: CategoryItem[] = [];
    for (let g = 0; g < 15; g++) {
      items.push({ id: `g${g}`, label: `Group ${g}`, parentId: null });
      for (let k = 0; k < (g < 6 ? 8 : 7); k++) {
        items.push({ id: `g${g}s${k}`, label: `Sub ${g}.${k}`, parentId: `g${g}` });
      }
    }
    const subs = items.filter((i) => i.parentId);
    expect(subs.length).toBe(111);
    const events: GridItem[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `E${i}`,
      row: subs[i % subs.length]!.id,
      startYear: 2025 + ((i * 7) % 76),
      endYear: 2025 + ((i * 7) % 76) + (i % 5 === 0 ? 3 : 0),
      big: i % 11 === 0,
      label: `World event number ${i}`,
    }));
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      const { groups, rowOf } = buildGroups(
        items,
        new Set(events.map((e) => e.row)),
        new Set(['g3']),
      );
      const placed = events.map((e) => ({ ...e, row: rowOf.get(e.row) ?? e.row }));
      const layout = layoutGrid(groups, placed, makeScale(gridSpan([]), 18));
      for (let y = 0; y < layout.height; y += 7) hitTest(layout, (y * 13) % layout.width, y);
      runs.push(performance.now() - t0);
      const drawn = layout.lines.reduce(
        (n, l) =>
          n + (l.kind === 'row' ? l.layout.markers.length : (l.merged?.markers.length ?? 0)),
        0,
      );
      expect(drawn).toBe(5000);
    }
    expect(Math.min(...runs)).toBeLessThan(100);
  });
});

describe('WE-1 the category filter', () => {
  test('WE-1 SM-8 a group keeps its own rows; a subcategory keeps only its row under the heading', () => {
    const used = ['technology', 'robotics', 'energy', 'climate'];
    expect(categoryScope(categories, null)).toBeNull();
    const tech = categoryScope(categories, 'technology')!;
    expect([...tech.keep].sort()).toEqual(['energy', 'robotics', 'technology']);
    expect(
      buildGroups(
        tech.items,
        used.filter((c) => tech.keep.has(c)),
      ).groups.flatMap((g) => g.rows.map((r) => r.key)),
    ).toEqual(['technology', 'robotics', 'energy']);
    const robotics = categoryScope(categories, 'technology', 'robotics')!;
    expect([...robotics.keep]).toEqual(['robotics']);
    const { groups } = buildGroups(
      robotics.items,
      used.filter((c) => robotics.keep.has(c)),
    );
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.key)])).toEqual([
      ['technology', ['robotics']],
    ]);
  });
});

describe('IP-4 span ends and era edges', () => {
  const s = makeScale({ from: 2025, to: 2100 }, 10);

  test('IP-4 a pointer within a handle of either edge finds that end; the middle of a bar finds none', () => {
    const bar = { x: 100, width: 200 };
    expect(edgeAt(bar, 100)).toBe('start');
    expect(edgeAt(bar, 97)).toBe('start');
    expect(edgeAt(bar, 107)).toBe('start');
    expect(edgeAt(bar, 300)).toBe('end');
    expect(edgeAt(bar, 293)).toBe('end');
    expect(edgeAt(bar, 200)).toBeNull();
    expect(edgeAt(bar, 90)).toBeNull();
    expect(edgeAt(bar, 310)).toBeNull();
    // A one-year bar narrower than two handles: the nearer edge wins.
    expect(edgeAt({ x: 50, width: 10 }, 52)).toBe('start');
    expect(edgeAt({ x: 50, width: 10 }, 58)).toBe('end');
    expect(HANDLE_W).toBe(8);
  });

  test('IP-4 an edge dropped between columns snaps to the nearest year boundary, clamped to the axis', () => {
    // The boundary at x = 50 is the left edge of 2030 and the right edge of 2029.
    expect(snapEdge(s, 50, 'start')).toBe(2030);
    expect(snapEdge(s, 54, 'start')).toBe(2030);
    expect(snapEdge(s, 56, 'start')).toBe(2031);
    expect(snapEdge(s, 50, 'end')).toBe(2029);
    expect(snapEdge(s, 46, 'end')).toBe(2029);
    expect(snapEdge(s, -40, 'start')).toBe(2025);
    expect(snapEdge(s, 99999, 'end')).toBe(2100);
    expect(dragYears(14, 10)).toBe(1);
    expect(dragYears(16, 10)).toBe(2);
  });

  test('IP-4 one end moves by whole years and never passes the other, unless crossing is allowed', () => {
    expect(moveEdge(2030, 2040, 'start', 3, s)).toEqual({ startYear: 2033, endYear: 2040 });
    expect(moveEdge(2030, 2040, 'start', 30, s)).toEqual({ startYear: 2040, endYear: 2040 });
    expect(moveEdge(2030, 2040, 'end', -30, s)).toEqual({ startYear: 2030, endYear: 2030 });
    expect(moveEdge(2030, 2040, 'end', 100, s)).toEqual({ startYear: 2030, endYear: 2100 });
    expect(moveEdge(2030, 2040, 'start', -100, s)).toEqual({ startYear: 2025, endYear: 2040 });
    expect(moveEdge(2030, 2040, 'end', -15, s, true)).toEqual({ startYear: 2030, endYear: 2025 });
  });

  test('IP-4 eras that meet share an edge; moving it moves both ends and keeps each era a year long at least', () => {
    const eras = [
      { id: 'a', startYear: 2025, endYear: 2029 },
      { id: 'b', startYear: 2030, endYear: 2039 },
      { id: 'c', startYear: 2045, endYear: 2050 },
    ];
    expect(neighbourAt(eras, 'a', 'end')?.id).toBe('b');
    expect(neighbourAt(eras, 'b', 'start')?.id).toBe('a');
    expect(neighbourAt(eras, 'b', 'end')).toBeNull();
    expect(neighbourAt(eras, 'c', 'start')).toBeNull();
    expect(neighbourAt(eras, 'x', 'start')).toBeNull();
    expect(moveSharedEdge(eras[0]!, eras[1]!, 2)).toEqual({
      beforeEnd: 2031,
      afterStart: 2032,
      delta: 2,
    });
    expect(moveSharedEdge(eras[0]!, eras[1]!, -10)).toEqual({
      beforeEnd: 2025,
      afterStart: 2026,
      delta: -4,
    });
    expect(moveSharedEdge(eras[0]!, eras[1]!, 20).delta).toBe(9);
  });

  test('IP-4 the band gaps are the stretches of the axis no era covers', () => {
    expect(
      bandGaps(
        [
          { startYear: 2030, endYear: 2039 },
          { startYear: 2035, endYear: 2044 },
          { startYear: 2050, endYear: 2060 },
        ],
        { from: 2025, to: 2100 },
      ),
    ).toEqual([
      { startYear: 2025, endYear: 2029 },
      { startYear: 2045, endYear: 2049 },
      { startYear: 2061, endYear: 2100 },
    ]);
    expect(bandGaps([{ startYear: 2000, endYear: 2200 }], { from: 2025, to: 2100 })).toEqual([]);
    expect(bandGaps([], { from: 2025, to: 2030 })).toEqual([{ startYear: 2025, endYear: 2030 }]);
  });

  test('IP-11 the default span and window come from the default bible numbers', () => {
    expect(DEFAULT_SPAN).toEqual({
      from: DEFAULT_NUMBERS.timelineStart,
      to: DEFAULT_NUMBERS.timelineEnd,
    });
    expect(yearWindow(2040)).toEqual({
      from: 2040 - DEFAULT_NUMBERS.windowBefore,
      to: 2040 + DEFAULT_NUMBERS.windowAfter,
    });
    expect(gridSpan([], { from: 2000, to: 2150 })).toEqual({ from: 2000, to: 2150 });
  });
});
