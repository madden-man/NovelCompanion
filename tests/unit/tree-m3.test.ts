import { describe, expect, test } from 'vitest';
import {
  NODE_H,
  NODE_W,
  ROW_H,
  UNION_LABEL_BELOW,
  assembleGraph,
  layoutFromPositions,
  lowUnionLine,
  treeEdges,
  treeNodeKey,
} from '../../src/shared/domain/tree';
import type { TreePerson } from '../../src/shared/domain/tree';

const person = (id: string, born: number): TreePerson => ({
  id,
  name: id,
  chinese: '',
  birth: { year: born },
  death: null,
  familyIds: [],
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
});

/** Partners A and B in one row with M between them, and their child C in the row below. */
function apart() {
  const g = assembleGraph(
    [person('A', 1990), person('M', 1991), person('B', 1992), person('C', 2020)],
    [
      {
        id: 'U-AB',
        a: 'A',
        b: 'B',
        type: 'married',
        startYear: 2015,
        endYear: 2030,
        endReason: 'divorce',
        createdAt: '2026-01-01T00:00:10.000Z',
      },
    ],
    [
      {
        id: 'L-A',
        parentId: 'A',
        childId: 'C',
        type: 'biological',
        startYear: null,
        createdAt: '2026-01-01T00:00:11.000Z',
      },
      {
        id: 'L-B',
        parentId: 'B',
        childId: 'C',
        type: 'biological',
        startYear: null,
        createdAt: '2026-01-01T00:00:12.000Z',
      },
    ],
  );
  const step = NODE_W + 26;
  const layout = layoutFromPositions(
    new Map([
      ['A', { x: 0, y: 0 }],
      ['M', { x: step, y: 0 }],
      ['B', { x: 2 * step, y: 0 }],
      ['C', { x: step, y: ROW_H }],
    ]),
  );
  return { g, layout };
}

/** The box the "ended 2030" label takes, drawn 6 above its point and centred (11 px text). */
function labelBox(p: { x: number; y: number }) {
  const w = 'ended 2030'.length * 6.5;
  return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 6 - 11, y1: p.y - 6 + 3 };
}

describe('FT-4 FT-5 union lines when partners are not adjacent (M2 review)', () => {
  test('FT-4 the end-year label sits beside the union line below the row, over no node', () => {
    const { g, layout } = apart();
    const { unions } = treeEdges(g, layout, 2040);
    const u = unions.find((x) => x.id === 'U-AB')!;
    const A = layout.nodes.get('A')!;
    const B = layout.nodes.get('B')!;
    const low = lowUnionLine(A, B);
    expect(u.path).toBe(
      `M${low.x1},${NODE_H} L${low.x1},${low.y} L${low.x2},${low.y} L${low.x2},${NODE_H}`,
    );
    expect(u.label).toEqual({ x: (low.x1 + low.x2) / 2, y: low.y + UNION_LABEL_BELOW });
    const box = labelBox(u.label!);
    // Beside the line: just under it, within its span.
    expect(box.y0).toBeGreaterThan(low.y);
    expect(box.y0 - low.y).toBeLessThan(12);
    expect(box.x0).toBeGreaterThan(low.x1);
    expect(box.x1).toBeLessThan(low.x2);
    for (const [id, n] of layout.nodes) {
      const overlaps =
        box.x0 < n.x + NODE_W && box.x1 > n.x && box.y0 < n.y + NODE_H && box.y1 > n.y;
      expect(overlaps, `the label covers ${id}`).toBe(false);
    }
  });

  test('FT-4 their child hangs from the midpoint of the union line routed below the row', () => {
    const { g, layout } = apart();
    const { links } = treeEdges(g, layout, 2040);
    const toC = links.filter((l) => l.childId === 'C');
    expect(toC).toHaveLength(1);
    expect(toC[0]!.ids.sort()).toEqual(['L-A', 'L-B']);
    const low = lowUnionLine(layout.nodes.get('A')!, layout.nodes.get('B')!);
    const mx = (low.x1 + low.x2) / 2;
    const C = layout.nodes.get('C')!;
    const busY = C.y - 28;
    expect(toC[0]!.path).toBe(
      `M${mx},${low.y} L${mx},${busY} L${C.x + NODE_W / 2},${busY} L${C.x + NODE_W / 2},${C.y}`,
    );
    // The drop starts below the partners' row and above the child's bus.
    expect(low.y).toBeGreaterThan(NODE_H);
    expect(low.y).toBeLessThan(busY);
  });

  test('FT-4 adjacent partners keep the short line and the child drop from between them', () => {
    const { g } = apart();
    const layout = layoutFromPositions(
      new Map([
        ['A', { x: 0, y: 0 }],
        ['B', { x: NODE_W + 26, y: 0 }],
        ['M', { x: 2 * (NODE_W + 26), y: 0 }],
        ['C', { x: 0, y: ROW_H }],
      ]),
    );
    const { unions, links } = treeEdges(g, layout, 2040);
    expect(unions[0]!.path).toBe(`M${NODE_W},${NODE_H / 2} L${NODE_W + 26},${NODE_H / 2}`);
    expect(
      links.find((l) => l.childId === 'C')!.path.startsWith(`M${NODE_W + 13},${NODE_H / 2}`),
    ).toBe(true);
  });
});

describe('NF-2 FT-8 keys on a focused tree node (M2 review)', () => {
  test('NF-2 Enter or Space toggles the branch when the person has children, else opens the inspector', () => {
    expect(treeNodeKey('Enter', true)).toBe('toggle');
    expect(treeNodeKey(' ', true)).toBe('toggle');
    expect(treeNodeKey('Enter', false)).toBe('inspect');
    expect(treeNodeKey(' ', false)).toBe('inspect');
  });
  test('NF-2 I opens the inspector for anyone, and other keys do nothing', () => {
    expect(treeNodeKey('i', true)).toBe('inspect');
    expect(treeNodeKey('I', false)).toBe('inspect');
    expect(treeNodeKey('x', true)).toBeNull();
    expect(treeNodeKey('ArrowLeft', false)).toBeNull();
  });
});
