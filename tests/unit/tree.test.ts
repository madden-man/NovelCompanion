import { describe, expect, test } from 'vitest';
import {
  NODE_W,
  ROW_H,
  assembleGraph,
  ancestorsOf,
  buildGraph,
  descendantsOf,
  filterPeople,
  generations,
  hideCollapsed,
  layoutTree,
  planAddRelative,
  planLinkExisting,
  relativesOf,
  treeEdges,
  treeWarnings,
  unionStateIn,
  wouldBeOwnAncestor,
} from '../../src/shared/domain/tree';
import type { AddRelative, TreeGraph } from '../../src/shared/domain/tree';
import { readFixture } from '../helpers/loadFixture';
import { generatedTree } from '../helpers/generatedTree';

type Doc = { _id: string } & Record<string, unknown>;

const fixture = readFixture();
const fixtureGraph = () => buildGraph(fixture.characters!, fixture.unions!, fixture.parentLinks!);
const everyone = (g: TreeGraph) => new Set(g.people.map((p) => p.id));
const pos = (g: TreeGraph, shown = everyone(g)) =>
  Object.fromEntries([...layoutTree(g, shown).nodes].map(([id, p]) => [id, [p.x, p.y]]));

let seq = 0;
const at = () => `2026-02-01T00:00:${String(seq++).padStart(2, '0')}.000Z`;
const person = (id: string, born: number | null, died: number | null = null): Doc => ({
  _id: id,
  title: id,
  status: 'canon',
  createdAt: at(),
  names: { full: id },
  birth: born === null ? { unknown: true } : { year: born },
  death: died === null ? null : { year: died },
  familyIds: [],
});
const link = (parentId: string, childId: string, type = 'biological'): Doc => ({
  _id: `L-${parentId}-${childId}`,
  createdAt: at(),
  parentId,
  childId,
  type,
  startYear: null,
});
const union = (
  a: string,
  b: string,
  startYear: number | null = null,
  endYear: number | null = null,
): Doc => ({
  _id: `U-${a}-${b}`,
  createdAt: at(),
  partnerIds: [a, b],
  type: 'married',
  startYear,
  endYear,
});

describe('FT-1 FT-4 the graph from the fixture', () => {
  test('FT-4 H5 has parents H3 and Z3, and is in both families', () => {
    const g = fixtureGraph();
    const r = relativesOf(g, 'H5');
    expect(r.parents.map((p) => p.id).sort()).toEqual(['H3', 'Z3']);
    expect(g.byId.get('H5')!.familyIds).toEqual(['FAM-HALE', 'FAM-ZHOU']);
    expect(r.partners).toEqual([
      {
        id: 'X1',
        unionId: 'UN-H5-X1',
        type: 'partnered',
        startYear: 2056,
        endYear: 2064,
        endReason: 'separated',
      },
    ]);
    expect(r.children.map((c) => c.id)).toEqual(['Z5']);
  });

  test('FT-4 H6 has one known parent, H4, by an adoptive link from 2015', () => {
    const r = relativesOf(fixtureGraph(), 'H6');
    expect(r.parents).toEqual([
      { id: 'H4', linkId: 'PL-H4-H6', type: 'adoptive', startYear: 2015 },
    ]);
    expect(r.siblings).toEqual([]);
  });

  test('FT-4 X1 and U1 have no family and no parents; U1 has unknown years', () => {
    const g = fixtureGraph();
    for (const id of ['X1', 'U1']) {
      expect(g.byId.get(id)!.familyIds).toEqual([]);
      expect(relativesOf(g, id).parents).toEqual([]);
    }
    expect(g.byId.get('U1')!.birth).toEqual({ unknown: true });
  });

  test('FT-4 siblings: full when both parents are shared, half when one is', () => {
    expect(relativesOf(fixtureGraph(), 'H3').siblings).toEqual([
      { id: 'H4', kind: 'full', sharedParentIds: ['H1', 'H2'] },
    ]);
    const g = buildGraph(
      [
        person('M', 1960),
        person('F1', 1958),
        person('F2', 1962),
        person('A', 1985),
        person('B', 1990),
      ],
      [],
      [link('M', 'A'), link('F1', 'A'), link('M', 'B'), link('F2', 'B')],
    );
    expect(relativesOf(g, 'A').siblings).toEqual([
      { id: 'B', kind: 'half', sharedParentIds: ['M'] },
    ]);
  });

  test('FT-1 ancestors and descendants of H5', () => {
    const g = fixtureGraph();
    expect([...ancestorsOf(g, 'H5')].sort()).toEqual(['H1', 'H2', 'H3', 'Z1', 'Z2', 'Z3']);
    expect([...descendantsOf(g, 'H5')]).toEqual(['Z5']);
    expect([...descendantsOf(g, 'H1')].sort()).toEqual(['H3', 'H4', 'H5', 'H6', 'Z5']);
  });

  test('FT-1 filters: all, one family (with the people in both), and a lineage with partners', () => {
    const g = fixtureGraph();
    expect(filterPeople(g, { kind: 'all' }).size).toBe(13);
    expect([...filterPeople(g, { kind: 'family', familyId: 'FAM-ZHOU' })].sort()).toEqual([
      'H5',
      'Z1',
      'Z2',
      'Z3',
      'Z4',
      'Z5',
    ]);
    expect([...filterPeople(g, { kind: 'lineage', personId: 'H5' })].sort()).toEqual([
      'H1',
      'H2',
      'H3',
      'H5',
      'X1',
      'Z1',
      'Z2',
      'Z3',
      'Z5',
    ]);
  });

  test('FT-1 the trash is left out of the tree, with the links that name it', () => {
    const chars = fixture.characters!.map((c) => (c._id === 'H4' ? { ...c, deletedAt: at() } : c));
    const g = buildGraph(chars, fixture.unions!, fixture.parentLinks!);
    expect(g.byId.has('H4')).toBe(false);
    expect(relativesOf(g, 'H6').parents).toEqual([]);
  });
});

describe('FT-8 FT-10 generations and layout', () => {
  test('FT-8 generations come from parent links; partners who married in share their row', () => {
    const gen = Object.fromEntries(generations(fixtureGraph()));
    expect(gen).toEqual({
      H1: 0,
      H2: 0,
      Z1: 0,
      Z2: 0,
      U1: 0,
      H3: 1,
      H4: 1,
      Z3: 1,
      Z4: 1,
      H5: 2,
      H6: 2,
      X1: 2,
      Z5: 3,
    });
  });

  test('FT-10 the layout of the subtree H1, H2, H4, H6 is as written by hand', () => {
    const g = fixtureGraph();
    // Couple side by side; Ruth centred under the couple; Sam under Ruth.
    expect(pos(g, new Set(['H1', 'H2', 'H4', 'H6']))).toEqual({
      H1: [0, 0],
      H2: [NODE_W + 26, 0],
      H4: [97, ROW_H],
      H6: [97, 2 * ROW_H],
    });
  });

  test('FT-10 the whole fixture lays out as written by hand: couples adjacent, children under their parents', () => {
    expect(pos(fixtureGraph())).toEqual({
      H1: [9, 0],
      H2: [203, 0],
      Z1: [415, 0],
      Z2: [609, 0],
      H4: [0, 132],
      H3: [212, 132],
      Z3: [406, 132],
      Z4: [618, 132],
      H6: [0, 264],
      H5: [309, 264],
      X1: [503, 264],
      Z5: [406, 396],
      // Tied to no one: the row above the tree.
      U1: [0, -132],
    });
  });

  test('FT-10 the layout is the same however the input is ordered', () => {
    const g1 = fixtureGraph();
    const g2 = buildGraph(
      [...fixture.characters!].reverse(),
      [...fixture.unions!].reverse(),
      [...fixture.parentLinks!].reverse(),
    );
    expect(pos(g2)).toEqual(pos(g1));
  });

  test('FT-10 adding a person on their own moves nobody', () => {
    const before = pos(fixtureGraph());
    const g = buildGraph(
      [...fixture.characters!, { ...person('NEW', 2000), createdAt: '2027-01-01T00:00:00.000Z' }],
      fixture.unions!,
      fixture.parentLinks!,
    );
    const after = pos(g);
    for (const [id, p] of Object.entries(before)) expect(after[id], id).toEqual(p);
    expect(after.NEW).toEqual([NODE_W + 26, -132]);
  });

  test('FT-10 adding a child to Zhou Jun moves only the child, Zhou Jun, and his parents', () => {
    const before = pos(fixtureGraph());
    const kid = { ...person('KID', 2020), createdAt: '2027-01-01T00:00:00.000Z' };
    const g = buildGraph([...fixture.characters!, kid], fixture.unions!, [
      ...fixture.parentLinks!,
      { ...link('Z4', 'KID'), createdAt: '2027-01-01T00:00:01.000Z' },
    ]);
    const after = pos(g);
    const moved = Object.keys(before).filter(
      (id) => JSON.stringify(after[id]) !== JSON.stringify(before[id]),
    );
    expect(moved.sort()).toEqual(['Z1', 'Z2', 'Z4']);
    // The child sits right of everyone in its row, under its father.
    expect(after.KID![1]).toBe(2 * ROW_H);
    expect(after.Z4![0]).toBe(after.KID![0]);
  });

  test('FT-10 adding a child to Sam Hale moves nobody else', () => {
    const before = pos(fixtureGraph());
    const kid = { ...person('KID', 2040), createdAt: '2027-01-01T00:00:00.000Z' };
    const g = buildGraph([...fixture.characters!, kid], fixture.unions!, [
      ...fixture.parentLinks!,
      { ...link('H6', 'KID'), createdAt: '2027-01-01T00:00:01.000Z' },
    ]);
    const after = pos(g);
    for (const [id, p] of Object.entries(before)) expect(after[id], id).toEqual(p);
    expect(after.KID).toEqual([0, 3 * ROW_H]);
  });

  test('FT-8 collapsing Daniel hides his branch and the partner who married into it', () => {
    const g = fixtureGraph();
    const shown = hideCollapsed(g, everyone(g), new Set(['H3']));
    expect(['H5', 'Z5', 'X1'].filter((id) => shown.has(id))).toEqual([]);
    expect(shown.has('H3')).toBe(true);
    expect(shown.size).toBe(10);
  });

  test('FT-8 a generated tree of 200 people over six generations lays out well under 500 ms', () => {
    const { characters, unions, parentLinks } = generatedTree(200, 6);
    const start = performance.now();
    const g = buildGraph(characters, unions, parentLinks);
    const layout = layoutTree(g, everyone(g));
    treeEdges(g, layout, 2050);
    treeWarnings(g);
    const ms = performance.now() - start;
    expect(layout.nodes.size).toBe(200);
    expect(new Set([...layout.nodes.values()].map((p) => p.gen)).size).toBe(6);
    expect(ms).toBeLessThan(100);
    // No two nodes in a row overlap.
    const rows = new Map<number, number[]>();
    for (const p of layout.nodes.values()) rows.set(p.y, [...(rows.get(p.y) ?? []), p.x]);
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++)
        expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(NODE_W);
    }
  });
});

describe('FT-6 warnings and the self-ancestor refusal', () => {
  test('FT-6 the fixture has no tree warnings', () => {
    expect(treeWarnings(fixtureGraph())).toEqual([]);
  });

  test('FT-6 a parent under 12 or over 60 at a biological birth warns; 12 and 60 do not', () => {
    const g = (parentBorn: number, type = 'biological') =>
      buildGraph([person('Mum', parentBorn), person('Kid', 2000)], [], [link('Mum', 'Kid', type)]);
    expect(treeWarnings(g(1989)).map((w) => w.message)).toEqual([
      'Mum would be 11 when Kid is born, under 12.',
    ]);
    expect(treeWarnings(g(1988))).toEqual([]);
    expect(treeWarnings(g(1940))).toEqual([]);
    expect(treeWarnings(g(1939)).map((w) => w.message)).toEqual([
      'Mum would be 61 when Kid is born, over 60.',
    ]);
    // An adoptive parent may be any age.
    expect(treeWarnings(g(1930, 'adoptive'))).toEqual([]);
  });

  test('FT-6 a child born more than a year after a parent died warns', () => {
    const g = (died: number) =>
      buildGraph([person('Dad', 1960, died), person('Kid', 2000)], [], [link('Dad', 'Kid')]);
    expect(treeWarnings(g(1999))).toEqual([]);
    expect(treeWarnings(g(1998))).toEqual([
      {
        code: 'born-after-parent-death',
        message: 'Kid is born in 2000, more than a year after Dad dies in 1998.',
        personIds: ['Dad', 'Kid'],
        entryIds: ['L-Dad-Kid'],
      },
    ]);
  });

  test('FT-6 overlapping unions of one person warn; one after the other does not', () => {
    const g = (secondStart: number) =>
      buildGraph(
        [person('Ann', 1960), person('Bo', 1960), person('Cy', 1960)],
        [union('Ann', 'Bo', 1985, 2000), union('Ann', 'Cy', secondStart)],
        [],
      );
    expect(treeWarnings(g(2000))).toEqual([]);
    expect(treeWarnings(g(1995))).toEqual([
      {
        code: 'overlapping-unions',
        message: 'Ann has overlapping unions: with Bo (1985 to 2000) and with Cy (from 1995).',
        personIds: ['Ann', 'Bo', 'Cy'],
        entryIds: ['U-Ann-Bo', 'U-Ann-Cy'],
      },
    ]);
  });

  test('FT-6 an open union ends at the first death for the overlap check', () => {
    const g = buildGraph(
      [person('Ann', 1960), person('Bo', 1960, 1990), person('Cy', 1960)],
      [union('Ann', 'Bo', 1985), union('Ann', 'Cy', 1992)],
      [],
    );
    expect(treeWarnings(g)).toEqual([]);
  });

  test('FT-6 a child of both partners born before their union started warns', () => {
    const g = buildGraph(
      [person('Ann', 1960), person('Bo', 1960), person('Kid', 1984)],
      [union('Ann', 'Bo', 1985)],
      [link('Ann', 'Kid'), link('Bo', 'Kid')],
    );
    expect(treeWarnings(g).map((w) => [w.code, w.message])).toEqual([
      ['born-before-union', "Kid is born in 1984, before Ann and Bo's union starts in 1985."],
    ]);
  });

  test('FT-6 nobody can be their own ancestor', () => {
    const links = fixture.parentLinks!.map((l) => ({
      parentId: String(l.parentId),
      childId: String(l.childId),
    }));
    expect(wouldBeOwnAncestor(links, 'H5', 'H1')).toBe(true);
    expect(wouldBeOwnAncestor(links, 'Z5', 'Z1')).toBe(true);
    expect(wouldBeOwnAncestor(links, 'H1', 'H1')).toBe(true);
    expect(wouldBeOwnAncestor(links, 'H1', 'X1')).toBe(false);
    expect(() =>
      planLinkExisting(
        fixtureGraph(),
        { kind: 'child', anchorId: 'H5', otherId: 'H1', type: 'biological', status: 'idea' },
        () => 'NEW',
      ),
    ).toThrow(
      'This link was not made: Margaret Hale is already an ancestor of Iris Hale-Zhou, so it would make someone their own ancestor.',
    );
  });
});

describe('FT-4 FT-5 drawing', () => {
  test('FT-5 unions are active, ended, or not yet begun in a year', () => {
    const g = fixtureGraph();
    const u = g.unions.find((x) => x.id === 'UN-H5-X1')!;
    expect(unionStateIn(u, 2050)).toBe('future');
    expect(unionStateIn(u, 2060)).toBe('active');
    expect(unionStateIn(u, 2064)).toBe('active');
    expect(unionStateIn(u, 2065)).toBe('ended');
    expect(
      unionStateIn(
        g.unions.find((x) => x.id === 'UN-Z1-Z2')!,
        1900,
      ),
    ).toBe('active');
  });

  test('FT-4 each link keeps its type; a couple draws one line to each shared child', () => {
    const g = fixtureGraph();
    const { unions, links } = treeEdges(g, layoutTree(g, everyone(g)), 2040);
    expect(unions.map((u) => [u.id, u.type, u.state, u.endYear])).toEqual([
      ['UN-H1-H2', 'married', 'ended', 2030],
      ['UN-H3-Z3', 'married', 'active', null],
      ['UN-H5-X1', 'partnered', 'future', 2064],
      ['UN-Z1-Z2', 'partnered', 'active', null],
    ]);
    expect(unions.filter((u) => u.label).map((u) => u.id)).toEqual(['UN-H1-H2', 'UN-H5-X1']);
    const byChild = Object.fromEntries(links.map((l) => [l.childId, [l.type, l.ids.length]]));
    expect(byChild).toEqual({
      H3: ['biological', 2],
      H4: ['biological', 2],
      H5: ['biological', 2],
      H6: ['adoptive', 1],
      Z3: ['biological', 2],
      Z4: ['biological', 2],
      Z5: ['biological', 2],
    });
  });

  test('FT-4 tree.get data rebuilds the same graph', () => {
    const g = fixtureGraph();
    const again = assembleGraph(g.people, g.unions, g.links);
    expect(pos(again)).toEqual(pos(g));
  });
});

describe('FT-2 in-tree actions', () => {
  const base: Omit<AddRelative, 'kind' | 'anchorId'> = {
    name: 'New Person',
    birthYear: 2060,
    status: 'idea',
    linkType: 'biological',
    unionType: 'married',
    coParentId: null,
  };
  const ids = () => {
    let i = 0;
    return () => `N${i++}`;
  };

  test('FT-2 add a child of Iris with Tomas as the other parent', () => {
    const plan = planAddRelative(
      fixtureGraph(),
      { ...base, kind: 'child', anchorId: 'H5', coParentId: 'X1' },
      ids(),
    );
    expect(plan.map((p) => p.collection)).toEqual(['characters', 'parentLinks', 'parentLinks']);
    expect(plan[0]!.data).toMatchObject({
      _id: 'N0',
      names: { full: 'New Person' },
      birth: { year: 2060 },
      familyIds: ['FAM-HALE', 'FAM-ZHOU'],
    });
    expect(plan.slice(1).map((p) => [p.data.parentId, p.data.childId, p.data.startYear])).toEqual([
      ['H5', 'N0', 2060],
      ['X1', 'N0', 2060],
    ]);
  });

  test('FT-2 add a parent, a sibling, a partner, and a person on their own', () => {
    const g = fixtureGraph();
    const parent = planAddRelative(
      g,
      { ...base, kind: 'parent', anchorId: 'X1', birthYear: null },
      ids(),
    );
    expect(parent[0]!.data.birth).toEqual({ unknown: true });
    expect([parent[1]!.data.parentId, parent[1]!.data.childId]).toEqual(['N0', 'X1']);
    const sib = planAddRelative(g, { ...base, kind: 'sibling', anchorId: 'Z3' }, ids());
    expect(sib.slice(1).map((p) => p.data.parentId)).toEqual(['Z1', 'Z2']);
    const mate = planAddRelative(
      g,
      { ...base, kind: 'partner', anchorId: 'H6', unionType: 'partnered' },
      ids(),
    );
    expect(mate[1]).toEqual({
      collection: 'unions',
      data: {
        _id: 'N1',
        title: 'Sam Hale and New Person',
        status: 'idea',
        partnerIds: ['H6', 'N0'],
        type: 'partnered',
        startYear: null,
        endYear: null,
      },
    });
    expect(mate[0]!.data.familyIds).toEqual([]);
    expect(planAddRelative(g, { ...base, kind: 'person', anchorId: null }, ids())).toHaveLength(1);
    expect(() => planAddRelative(g, { ...base, kind: 'sibling', anchorId: 'X1' }, ids())).toThrow(
      'Tomas Reyes has no known parents, so a sibling has no one to link to. Add a parent first.',
    );
  });
});
