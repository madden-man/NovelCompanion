/**
 * The family tree as pure functions (FT-1 to FT-10). Everything here works on
 * plain objects: the graph built from characters, unions, and parent links;
 * generations; a deterministic layout; filters; relatives; the FT-6 warnings;
 * and the one hard refusal, a person as their own ancestor. The renderer
 * draws what these functions return, and the write path calls the refusal.
 */
import type { StoryDate } from '../schema/common';
import { isKnown, yearOf } from './dates';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import { lifeState } from './ages';
import type { LifeState } from './ages';

export interface TreePerson {
  id: string;
  name: string;
  chinese: string;
  birth: StoryDate | null;
  death: StoryDate | null;
  familyIds: string[];
  status: string;
  createdAt: string;
}

export interface TreeUnion {
  id: string;
  a: string;
  b: string;
  type: string;
  startYear: number | null;
  endYear: number | null;
  endReason: string;
  createdAt: string;
}

export interface TreeLink {
  id: string;
  parentId: string;
  childId: string;
  type: string;
  startYear: number | null;
  createdAt: string;
}

export interface TreeGraph {
  /** Live people in creation order (created time, then ID). */
  people: TreePerson[];
  unions: TreeUnion[];
  links: TreeLink[];
  byId: Map<string, TreePerson>;
  /** Creation rank of each person, the tie-break that keeps layouts stable (FT-10). */
  rank: Map<string, number>;
  parentLinks: Map<string, TreeLink[]>;
  childLinks: Map<string, TreeLink[]>;
  unionsOf: Map<string, TreeUnion[]>;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const date = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);
const live = (d: Doc) => !d.deletedAt;
const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function toPerson(d: Doc): TreePerson {
  const names = isPlainObject(d.names) ? d.names : {};
  const title = str(d.title).trim();
  return {
    id: String(d._id),
    name: str(names.full).trim() || title || 'Unnamed',
    chinese: str(names.chinese),
    birth: date(d.birth),
    death: date(d.death),
    familyIds: Array.isArray(d.familyIds) ? d.familyIds.map(String) : [],
    status: str(d.status, 'idea'),
    createdAt: str(d.createdAt),
  };
}

/**
 * Build the graph from stored entries. Entries in the trash are left out, and
 * so are unions and links that name someone who is not a live character.
 */
export function buildGraph(
  characters: readonly Doc[],
  unions: readonly Doc[],
  parentLinks: readonly Doc[],
): TreeGraph {
  const people = characters.filter(live).map(toPerson);
  const us: TreeUnion[] = unions.filter(live).map((u) => {
    const pair = Array.isArray(u.partnerIds) ? u.partnerIds.map(String) : [];
    return {
      id: String(u._id),
      a: pair[0] ?? '',
      b: pair[1] ?? '',
      type: str(u.type, 'other'),
      startYear: num(u.startYear),
      endYear: num(u.endYear),
      endReason: str(u.endReason),
      createdAt: str(u.createdAt),
    };
  });
  const ls: TreeLink[] = parentLinks.filter(live).map((l) => ({
    id: String(l._id),
    parentId: str(l.parentId),
    childId: str(l.childId),
    type: str(l.type, 'biological'),
    startYear: num(l.startYear),
    createdAt: str(l.createdAt),
  }));
  return assembleGraph(people, us, ls);
}

/** The graph from people, unions, and links already in tree form (as `tree.get` sends them). */
export function assembleGraph(
  peopleIn: readonly TreePerson[],
  unionsIn: readonly TreeUnion[],
  linksIn: readonly TreeLink[],
): TreeGraph {
  const people = [...peopleIn].sort(byCreation);
  const byId = new Map(people.map((p) => [p.id, p]));
  const rank = new Map(people.map((p, i) => [p.id, i]));
  const us = unionsIn.filter((u) => u.a !== u.b && byId.has(u.a) && byId.has(u.b)).sort(byCreation);
  const ls = linksIn
    .filter((l) => l.parentId !== l.childId && byId.has(l.parentId) && byId.has(l.childId))
    .sort(byCreation);
  const parentLinksOf = new Map<string, TreeLink[]>();
  const childLinks = new Map<string, TreeLink[]>();
  const unionsOf = new Map<string, TreeUnion[]>();
  for (const l of ls) {
    push(parentLinksOf, l.childId, l);
    push(childLinks, l.parentId, l);
  }
  for (const u of us) {
    push(unionsOf, u.a, u);
    push(unionsOf, u.b, u);
  }
  return {
    people,
    unions: us,
    links: ls,
    byId,
    rank,
    parentLinks: parentLinksOf,
    childLinks,
    unionsOf,
  };
}

export const parentsOf = (g: TreeGraph, id: string): string[] =>
  (g.parentLinks.get(id) ?? []).map((l) => l.parentId);
export const childrenOf = (g: TreeGraph, id: string): string[] =>
  (g.childLinks.get(id) ?? []).map((l) => l.childId);
export const partnersOf = (g: TreeGraph, id: string): string[] =>
  (g.unionsOf.get(id) ?? []).map((u) => (u.a === id ? u.b : u.a));

function walk(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(start)];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id) || id === start) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

export const ancestorsOf = (g: TreeGraph, id: string): Set<string> =>
  walk(id, (x) => parentsOf(g, x));
export const descendantsOf = (g: TreeGraph, id: string): Set<string> =>
  walk(id, (x) => childrenOf(g, x));

// ---------- the hard refusal (FT-6) ----------

/**
 * True when linking `parentId` as a parent of `childId` would make someone
 * their own ancestor: the child is the parent, or already one of the parent's
 * ancestors. `links` are every parent link in force, whoever they name.
 */
export function wouldBeOwnAncestor(
  links: readonly { parentId: string; childId: string }[],
  parentId: string,
  childId: string,
): boolean {
  if (parentId === childId) return true;
  const up = new Map<string, string[]>();
  for (const l of links) push(up, l.childId, l.parentId);
  const seen = new Set<string>();
  const stack = [parentId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === childId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(up.get(id) ?? []));
  }
  return false;
}

/** The plain message shown when the refusal applies. */
export function ownAncestorMessage(parentName: string, childName: string): string {
  return parentName === childName
    ? `${parentName} cannot be their own parent.`
    : `This link was not made: ${childName} is already an ancestor of ${parentName}, so it would make someone their own ancestor.`;
}

// ---------- generations ----------

/**
 * Generation of every person from parent links: a child sits one row below
 * its lowest parent, partners share a row, and a person with no parents sits
 * just above their highest child, so people who marry in line up with their
 * partner. Generation 0 is the top row.
 */
export function generations(g: TreeGraph, ids?: ReadonlySet<string>): Map<string, number> {
  const inSet = (id: string) => !ids || ids.has(id);
  const people = g.people.filter((p) => inSet(p.id));
  const gen = new Map(people.map((p) => [p.id, 0]));
  const parents = new Map(people.map((p) => [p.id, parentsOf(g, p.id).filter(inSet)]));
  const kids = new Map(people.map((p) => [p.id, childrenOf(g, p.id).filter(inSet)]));
  const mates = new Map(people.map((p) => [p.id, partnersOf(g, p.id).filter(inSet)]));
  const at = (id: string) => gen.get(id) ?? 0;
  // Each pass only moves people down; a bound guards against a cycle in bad data.
  for (let pass = 0; pass <= people.length + 1; pass++) {
    let changed = false;
    for (const p of people) {
      let next = at(p.id);
      for (const q of parents.get(p.id) ?? []) next = Math.max(next, at(q) + 1);
      for (const q of mates.get(p.id) ?? []) next = Math.max(next, at(q));
      const ps = parents.get(p.id) ?? [];
      const cs = kids.get(p.id) ?? [];
      if (ps.length === 0 && cs.length > 0) {
        next = Math.max(next, Math.min(...cs.map(at)) - 1);
      }
      if (next !== at(p.id)) {
        gen.set(p.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const min = Math.min(0, ...[...gen.values()]);
  if (min !== 0) for (const [k, v] of gen) gen.set(k, v - min);
  return gen;
}

// ---------- filters and collapse (FT-1, FT-8) ----------

export type TreeFilter =
  { kind: 'all' } | { kind: 'family'; familyId: string } | { kind: 'lineage'; personId: string };

/** The people a filter shows, before collapsed branches are hidden. */
export function filterPeople(g: TreeGraph, filter: TreeFilter): Set<string> {
  if (filter.kind === 'family') {
    return new Set(g.people.filter((p) => p.familyIds.includes(filter.familyId)).map((p) => p.id));
  }
  if (filter.kind === 'lineage') {
    if (!g.byId.has(filter.personId)) return new Set();
    const id = filter.personId;
    const down = descendantsOf(g, id);
    const keep = new Set([id, ...ancestorsOf(g, id), ...down]);
    // Partners of the person and of their descendants, so every child shows both parents.
    for (const k of [id, ...down]) for (const p of partnersOf(g, k)) keep.add(p);
    return keep;
  }
  return new Set(g.people.map((p) => p.id));
}

/**
 * Hide the branches under collapsed people: their descendants, and anyone
 * whose only ties are to hidden people (a partner who married in).
 */
export function hideCollapsed(
  g: TreeGraph,
  visible: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  for (const c of collapsed) {
    if (!visible.has(c)) continue;
    for (const d of descendantsOf(g, c)) if (d !== c) hidden.add(d);
  }
  for (const c of collapsed) hidden.delete(c);
  for (const id of visible) {
    if (hidden.has(id) || collapsed.has(id)) continue;
    const ps = parentsOf(g, id).filter((x) => visible.has(x));
    const ties = [...partnersOf(g, id), ...childrenOf(g, id)].filter((x) => visible.has(x));
    if (ps.length === 0 && ties.length > 0 && ties.every((x) => hidden.has(x))) hidden.add(id);
  }
  return new Set([...visible].filter((id) => !hidden.has(id)));
}

/** People with children shown in the tree, who can be collapsed. */
export function hasBranch(g: TreeGraph, id: string): boolean {
  return childrenOf(g, id).length > 0;
}

// ---------- layout (FT-8, FT-10) ----------

export const NODE_W = 168;
export const NODE_H = 66;
export const COUPLE_GAP = 26;
export const SIBLING_GAP = 26;
export const BLOCK_GAP = 44;
export const COMPONENT_GAP = 80;
export const ROW_H = 132;

export interface NodePos {
  x: number;
  y: number;
  gen: number;
}

export interface TreeLayout {
  nodes: Map<string, NodePos>;
  /** The top of the drawing: below zero when a row of people tied to no one is shown. */
  minY: number;
  width: number;
  height: number;
}

/** Groups of people connected by any union or parent link, in creation order. */
function components(g: TreeGraph, ids: readonly string[], inSet: (id: string) => boolean) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c) as string;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // The earlier-created root wins, so a group is named by its first member.
    if ((g.rank.get(ra) ?? 0) < (g.rank.get(rb) ?? 0)) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const l of g.links) if (inSet(l.parentId) && inSet(l.childId)) join(l.parentId, l.childId);
  for (const u of g.unions) if (inSet(u.a) && inSet(u.b)) join(u.a, u.b);
  const groups = new Map<string, string[]>();
  for (const id of ids) push(groups, find(id), id);
  return [...groups.values()];
}

/** Partners in the same row chained side by side, so couples are adjacent. */
function rowBlocks(g: TreeGraph, row: readonly string[]): string[][] {
  const inRow = new Set(row);
  const placed = new Set<string>();
  const blocks: string[][] = [];
  for (const start of row) {
    if (placed.has(start)) continue;
    const chain = [start];
    placed.add(start);
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i] as string;
      for (const p of partnersOf(g, m)) {
        if (!inRow.has(p) || placed.has(p)) continue;
        placed.add(p);
        if (chain[chain.length - 1] === m) chain.push(p);
        else chain.unshift(p);
      }
    }
    blocks.push(chain);
  }
  return blocks;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function layoutComponent(
  g: TreeGraph,
  ids: readonly string[],
  gen: Map<string, number>,
  inSet: (id: string) => boolean,
): Map<string, { x: number; gen: number }> {
  const rank = (id: string) => g.rank.get(id) ?? 0;
  const rows = new Map<number, string[]>();
  for (const id of [...ids].sort((a, b) => rank(a) - rank(b))) push(rows, gen.get(id) ?? 0, id);
  const levels = [...rows.keys()].sort((a, b) => a - b);
  const x = new Map<string, number>();
  const center = (id: string) => (x.get(id) ?? 0) + NODE_W / 2;
  const parentCenter = (id: string): number | null => {
    const ps = parentsOf(g, id).filter((p) => inSet(p) && x.has(p));
    return ps.length ? mean(ps.map(center)) : null;
  };
  const placedBlocks = new Map<number, string[][]>();

  levels.forEach((level, li) => {
    let blocks = rowBlocks(g, rows.get(level) ?? []);
    // Order members of a couple by where their parents sit, when all have parents.
    blocks = blocks.map((b) => {
      const keys = b.map(parentCenter);
      if (b.length < 2 || keys.some((k) => k === null)) return b;
      return [...b].sort(
        (p, q) => (parentCenter(p) ?? 0) - (parentCenter(q) ?? 0) || rank(p) - rank(q),
      );
    });
    const blockKey = (b: string[]) => {
      const ks = b.map(parentCenter).filter((k): k is number => k !== null);
      return ks.length ? mean(ks) : Number.POSITIVE_INFINITY;
    };
    const first = (b: string[]) => Math.min(...b.map(rank));
    if (li > 0) {
      blocks.sort((a, b) => {
        const d = blockKey(a) - blockKey(b);
        return Number.isFinite(d) && d !== 0 ? d : first(a) - first(b);
      });
    }
    // Consecutive blocks under the same parents form a sibling group, centred under them.
    const groups: string[][][] = [];
    for (const b of blocks) {
      const last = groups[groups.length - 1];
      const k = blockKey(b);
      if (last && Number.isFinite(k) && Math.abs(blockKey(last[0] as string[]) - k) < 0.5) {
        last.push(b);
      } else groups.push([b]);
    }
    let right = Number.NEGATIVE_INFINITY;
    for (const group of groups) {
      const offsets = new Map<string, number>();
      let w = 0;
      group.forEach((b, bi) => {
        if (bi > 0) w += SIBLING_GAP;
        b.forEach((id, i) => {
          if (i > 0) w += COUPLE_GAP;
          offsets.set(id, w);
          w += NODE_W;
        });
      });
      const wants = [...offsets].flatMap(([id, off]) => {
        const pc = parentCenter(id);
        return pc === null ? [] : [pc - NODE_W / 2 - off];
      });
      const desired = wants.length ? mean(wants) : Number.NEGATIVE_INFINITY;
      const left = Number.isFinite(right) ? Math.max(desired, right + BLOCK_GAP) : desired;
      const start = Number.isFinite(left) ? left : 0;
      for (const [id, off] of offsets) x.set(id, start + off);
      right = start + w;
    }
    placedBlocks.set(level, groups.flat());
  });

  // Bottom up: move a couple right, never left, to sit over its children.
  for (const level of [...levels].reverse()) {
    const blocks = placedBlocks.get(level) ?? [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i] as string[];
      const kids = [...new Set(b.flatMap((m) => childrenOf(g, m)))].filter(
        (c) => inSet(c) && x.has(c),
      );
      if (!kids.length) continue;
      const left = x.get(b[0] as string) ?? 0;
      const rightEdge = (x.get(b[b.length - 1] as string) ?? 0) + NODE_W;
      const want = mean(kids.map(center)) - (rightEdge - left) / 2;
      const next = blocks[i + 1];
      const limit = next
        ? (x.get(next[0] as string) ?? 0) - BLOCK_GAP - (rightEdge - left)
        : Infinity;
      const shift = Math.min(want, limit) - left;
      if (shift > 0.5) for (const m of b) x.set(m, (x.get(m) ?? 0) + shift);
    }
  }
  const out = new Map<string, { x: number; gen: number }>();
  for (const id of ids) out.set(id, { x: x.get(id) ?? 0, gen: gen.get(id) ?? 0 });
  return out;
}

/**
 * A deterministic layout of the shown people (FT-10). Each connected group is
 * laid out on its own, so an edit in one group never rearranges another; the
 * groups sit left to right in creation order, and people tied to no one sit in
 * a row of their own above, so adding a person on their own moves nobody.
 * Inside a group, rows are generations, couples are adjacent, children are
 * centred under their parents, ties follow creation order, and parents only
 * ever move right to sit over their children, so a new person moves only
 * people to their right in the same rows and their own ancestors.
 */
export function layoutTree(g: TreeGraph, shown: ReadonlySet<string>): TreeLayout {
  const inSet = (id: string) => shown.has(id);
  const ids = g.people.map((p) => p.id).filter(inSet);
  const gen = generations(g, shown);
  const nodes = new Map<string, NodePos>();
  let offset = 0;
  let maxGen = -1;
  let loose = 0;
  for (const comp of components(g, ids, inSet)) {
    if (comp.length === 1) {
      // People tied to no one shown sit in their own row above the tree, in creation order.
      nodes.set(comp[0] as string, { x: loose * (NODE_W + SIBLING_GAP), y: -ROW_H, gen: -1 });
      loose += 1;
      continue;
    }
    const local = layoutComponent(g, comp, gen, inSet);
    const minX = Math.min(...[...local.values()].map((p) => p.x));
    let maxX = Number.NEGATIVE_INFINITY;
    for (const [id, p] of local) {
      const xx = Math.round(p.x - minX + offset);
      nodes.set(id, { x: xx, y: p.gen * ROW_H, gen: p.gen });
      maxX = Math.max(maxX, xx + NODE_W);
      maxGen = Math.max(maxGen, p.gen);
    }
    offset = maxX + COMPONENT_GAP;
  }
  const looseW = loose ? loose * (NODE_W + SIBLING_GAP) - SIBLING_GAP : 0;
  return {
    nodes,
    minY: loose ? -ROW_H : 0,
    width: Math.max(nodes.size && offset ? offset - COMPONENT_GAP : 0, looseW),
    height: (maxGen >= 0 ? maxGen * ROW_H + NODE_H : 0) + (loose ? ROW_H : 0),
  };
}

// ---------- drawing geometry (FT-4, FT-5) ----------

export type UnionState = 'active' | 'ended' | 'future';

/** Whether a union is in force in a year (FT-5). Unknown years count as open ends. */
export function unionStateIn(u: TreeUnion, year: number): UnionState {
  if (u.startYear !== null && year < u.startYear) return 'future';
  if (u.endYear !== null && year > u.endYear) return 'ended';
  return 'active';
}

export interface UnionEdge {
  id: string;
  type: string;
  path: string;
  state: UnionState;
  endYear: number | null;
  /** Where the end year label sits. */
  label: { x: number; y: number } | null;
}

export interface LinkEdge {
  /** The parent links this line draws: one, or two drawn from a couple's midpoint. */
  ids: string[];
  type: string;
  path: string;
  childId: string;
}

export function treeEdges(
  g: TreeGraph,
  layout: TreeLayout,
  year: number,
): { unions: UnionEdge[]; links: LinkEdge[] } {
  const pos = layout.nodes;
  const unions: UnionEdge[] = [];
  const adjacent = (a: NodePos, b: NodePos) =>
    a.y === b.y && Math.abs(a.x - b.x) <= NODE_W + COUPLE_GAP + 1;
  for (const u of g.unions) {
    const A = pos.get(u.a);
    const B = pos.get(u.b);
    if (!A || !B) continue;
    const [L, R] = A.x <= B.x ? [A, B] : [B, A];
    let path: string;
    let label: { x: number; y: number };
    const my = L.y + NODE_H / 2;
    if (L.y === R.y) {
      const x1 = L.x + NODE_W;
      const x2 = R.x;
      if (adjacent(L, R)) path = `M${x1},${my} L${x2},${my}`;
      else
        path = `M${x1 - 20},${L.y + NODE_H} L${x1 - 20},${L.y + NODE_H + 12} L${x2 + 20},${L.y + NODE_H + 12} L${x2 + 20},${R.y + NODE_H}`;
      label = { x: (x1 + x2) / 2, y: my };
    } else {
      const [T, D] = A.y < B.y ? [A, B] : [B, A];
      path = `M${T.x + NODE_W - 16},${T.y + NODE_H} L${T.x + NODE_W - 16},${D.y - 24} L${D.x + 16},${D.y - 24} L${D.x + 16},${D.y}`;
      label = { x: (T.x + NODE_W + D.x) / 2, y: D.y - 24 };
    }
    unions.push({
      id: u.id,
      type: u.type,
      path,
      state: unionStateIn(u, year),
      endYear: u.endYear,
      label: u.endYear !== null ? label : null,
    });
  }
  const links: LinkEdge[] = [];
  for (const p of g.people) {
    const C = pos.get(p.id);
    if (!C) continue;
    const ls = (g.parentLinks.get(p.id) ?? []).filter((l) => pos.has(l.parentId));
    if (!ls.length) continue;
    const busY = C.y - 28;
    const toChild = `L${C.x + NODE_W / 2},${busY} L${C.x + NODE_W / 2},${C.y}`;
    const done = new Set<string>();
    if (ls.length >= 2) {
      for (const u of g.unions) {
        const la = ls.find((l) => l.parentId === u.a);
        const lb = ls.find((l) => l.parentId === u.b);
        if (!la || !lb || la.type !== lb.type || done.has(la.id) || done.has(lb.id)) continue;
        const A = pos.get(u.a) as NodePos;
        const B = pos.get(u.b) as NodePos;
        if (!adjacent(A, B)) continue;
        const mx = (Math.min(A.x, B.x) + NODE_W + Math.max(A.x, B.x)) / 2;
        const my = A.y + NODE_H / 2;
        links.push({
          ids: [la.id, lb.id],
          type: la.type,
          path: `M${mx},${my} L${mx},${busY} ${toChild}`,
          childId: p.id,
        });
        done.add(la.id);
        done.add(lb.id);
      }
    }
    for (const l of ls) {
      if (done.has(l.id)) continue;
      const P = pos.get(l.parentId) as NodePos;
      links.push({
        ids: [l.id],
        type: l.type,
        path: `M${P.x + NODE_W / 2},${P.y + NODE_H} L${P.x + NODE_W / 2},${busY} ${toChild}`,
        childId: p.id,
      });
    }
  }
  return { unions, links };
}

/** What a node shows for a year (FT-5, FT-7). */
export function nodeState(p: TreePerson, year: number): LifeState {
  return lifeState(p, year);
}

// ---------- relatives (CH-3) ----------

export interface Relatives {
  parents: { id: string; linkId: string; type: string; startYear: number | null }[];
  children: { id: string; linkId: string; type: string; startYear: number | null }[];
  siblings: { id: string; kind: 'full' | 'half' | 'sibling'; sharedParentIds: string[] }[];
  partners: {
    id: string;
    unionId: string;
    type: string;
    startYear: number | null;
    endYear: number | null;
    endReason: string;
  }[];
}

/** Parents, children, siblings and half-siblings, and partners, from unions and parent links. */
export function relativesOf(g: TreeGraph, id: string): Relatives {
  const rank = (x: string) => g.rank.get(x) ?? 0;
  const parents = (g.parentLinks.get(id) ?? []).map((l) => ({
    id: l.parentId,
    linkId: l.id,
    type: l.type,
    startYear: l.startYear,
  }));
  const children = (g.childLinks.get(id) ?? [])
    .map((l) => ({ id: l.childId, linkId: l.id, type: l.type, startYear: l.startYear }))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const mine = new Set(parents.map((p) => p.id));
  const sibIds = new Set<string>();
  for (const p of mine) for (const c of childrenOf(g, p)) if (c !== id) sibIds.add(c);
  const siblings = [...sibIds]
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => {
      const theirs = new Set(parentsOf(g, s));
      const shared = [...mine].filter((p) => theirs.has(p));
      const unshared = [...mine, ...theirs].some((p) => !(mine.has(p) && theirs.has(p)));
      const kind: 'full' | 'half' | 'sibling' =
        shared.length >= 2 ? 'full' : unshared ? 'half' : 'sibling';
      return { id: s, kind, sharedParentIds: shared };
    });
  const partners = (g.unionsOf.get(id) ?? []).map((u) => ({
    id: u.a === id ? u.b : u.a,
    unionId: u.id,
    type: u.type,
    startYear: u.startYear,
    endYear: u.endYear,
    endReason: u.endReason,
  }));
  return { parents, children, siblings, partners };
}

// ---------- FT-6 warnings ----------

export const MIN_PARENT_AGE = 12;
export const MAX_PARENT_AGE = 60;

export interface TreeWarning {
  code: 'parent-age' | 'born-after-parent-death' | 'overlapping-unions' | 'born-before-union';
  message: string;
  /** People the warning is about. */
  personIds: string[];
  /** Unions and parent links it is about. */
  entryIds: string[];
}

type Named = { name: string; birth: StoryDate | null; death: StoryDate | null };

/** A biological parent under 12 or over 60 at the child's birth, or null. */
export function parentAgeWarning(parent: Named, child: Named): string | null {
  const pb = yearOf(parent.birth);
  const cb = yearOf(child.birth);
  if (pb === null || cb === null) return null;
  const age = cb - pb;
  if (age < MIN_PARENT_AGE) {
    return `${parent.name} would be ${age} when ${child.name} is born, under ${MIN_PARENT_AGE}.`;
  }
  if (age > MAX_PARENT_AGE) {
    return `${parent.name} would be ${age} when ${child.name} is born, over ${MAX_PARENT_AGE}.`;
  }
  return null;
}

function dayNo(d: { year: number; month?: number; day?: number }): number | null {
  if (d.month === undefined || d.day === undefined) return null;
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/** A child born more than a year after a biological parent died, or null. */
export function bornAfterDeathWarning(parent: Named, child: Named): string | null {
  if (!isKnown(parent.death) || !isKnown(child.birth)) return null;
  const dd = dayNo(parent.death);
  const cd = dayNo(child.birth);
  const late =
    dd !== null && cd !== null ? cd - dd > 366 : child.birth.year > parent.death.year + 1;
  return late
    ? `${child.name} is born in ${child.birth.year}, more than a year after ${parent.name} dies in ${parent.death.year}.`
    : null;
}

/** The years a union is in force for the overlap check: unknown start skips the check. */
function unionSpan(g: TreeGraph, u: TreeUnion): [number, number] | null {
  if (u.startYear === null) return null;
  let end = u.endYear;
  if (end === null) {
    const deaths = [u.a, u.b]
      .map((id) => yearOf(g.byId.get(id)?.death ?? null))
      .filter((y): y is number => y !== null);
    end = deaths.length ? Math.min(...deaths) : Number.POSITIVE_INFINITY;
  }
  return [u.startYear, end];
}

const span = (s: [number, number]) =>
  Number.isFinite(s[1]) ? `${s[0]} to ${s[1]}` : `from ${s[0]}`;

/** Two unions of the same person that overlap in time, as a message, or null. */
export function overlapWarning(g: TreeGraph, u: TreeUnion, v: TreeUnion): string | null {
  const shared = [u.a, u.b].find((x) => x === v.a || x === v.b);
  if (!shared) return null;
  const su = unionSpan(g, u);
  const sv = unionSpan(g, v);
  if (!su || !sv || !(su[0] < sv[1] && sv[0] < su[1])) return null;
  const name = (id: string) => g.byId.get(id)?.name ?? id;
  const other = (w: TreeUnion) => name(w.a === shared ? w.b : w.a);
  return `${name(shared)} has overlapping unions: with ${other(u)} (${span(su)}) and with ${other(v)} (${span(sv)}).`;
}

/**
 * Every FT-6 warning in the tree. They never block a save: this is fiction,
 * and the writer may mean it. Age checks apply to biological links only; an
 * adoptive, step, or guardian parent may be any age at the child's birth.
 */
export function treeWarnings(g: TreeGraph): TreeWarning[] {
  const out: TreeWarning[] = [];
  for (const l of g.links) {
    if (l.type !== 'biological') continue;
    const P = g.byId.get(l.parentId) as TreePerson;
    const C = g.byId.get(l.childId) as TreePerson;
    const age = parentAgeWarning(P, C);
    if (age)
      out.push({ code: 'parent-age', message: age, personIds: [P.id, C.id], entryIds: [l.id] });
    const late = bornAfterDeathWarning(P, C);
    if (late) {
      out.push({
        code: 'born-after-parent-death',
        message: late,
        personIds: [P.id, C.id],
        entryIds: [l.id],
      });
    }
  }
  g.unions.forEach((u, i) => {
    for (const v of g.unions.slice(i + 1)) {
      const msg = overlapWarning(g, u, v);
      if (msg) {
        const ids = [...new Set([u.a, u.b, v.a, v.b])];
        out.push({
          code: 'overlapping-unions',
          message: msg,
          personIds: ids,
          entryIds: [u.id, v.id],
        });
      }
    }
  });
  for (const u of g.unions) {
    const msg = bornBeforeUnion(g, u);
    for (const m of msg) out.push(m);
  }
  return out;
}

/** Children of both partners, by biological links, born before the union started. */
function bornBeforeUnion(g: TreeGraph, u: TreeUnion): TreeWarning[] {
  if (u.startYear === null) return [];
  const start = u.startYear;
  const bio = (parent: string) =>
    new Set(
      (g.childLinks.get(parent) ?? []).filter((l) => l.type === 'biological').map((l) => l.childId),
    );
  const fromB = bio(u.b);
  const out: TreeWarning[] = [];
  for (const c of bio(u.a)) {
    if (!fromB.has(c)) continue;
    const C = g.byId.get(c) as TreePerson;
    const born = yearOf(C.birth);
    if (born === null || born >= start) continue;
    const A = g.byId.get(u.a) as TreePerson;
    const B = g.byId.get(u.b) as TreePerson;
    out.push({
      code: 'born-before-union',
      message: `${C.name} is born in ${born}, before ${A.name} and ${B.name}'s union starts in ${start}.`,
      personIds: [c, u.a, u.b],
      entryIds: [u.id],
    });
  }
  return out;
}

// ---------- in-tree actions (FT-2) ----------

export type RelativeKind = 'person' | 'parent' | 'child' | 'sibling' | 'partner';

export interface AddRelative {
  kind: RelativeKind;
  /** The node the action starts from; not needed to add a person on their own. */
  anchorId: string | null;
  name: string;
  birthYear: number | null;
  status: 'canon' | 'planned' | 'idea';
  /** Parent link type for a parent, child, or sibling. */
  linkType: string;
  /** Union type for a partner. */
  unionType: string;
  /** For a child: the anchor's partner who is the other parent, if any. */
  coParentId: string | null;
}

export interface PlannedEntry {
  collection: 'characters' | 'unions' | 'parentLinks';
  data: Doc & { _id: string };
}

export class TreeActionError extends Error {
  override name = 'TreeActionError';
}

function linkData(
  id: string,
  parent: { id: string; name: string },
  child: { id: string; name: string; birthYear: number | null },
  type: string,
  status: string,
): PlannedEntry {
  return {
    collection: 'parentLinks',
    data: {
      _id: id,
      title: `${parent.name} parent of ${child.name}`,
      status,
      parentId: parent.id,
      childId: child.id,
      type,
      startYear: type === 'biological' ? child.birthYear : null,
    },
  };
}

/**
 * The entries an in-tree action creates, written together in one
 * transaction: the new person and the link or union that ties them to the
 * node the action started from.
 */
export function planAddRelative(
  g: TreeGraph,
  req: AddRelative,
  newId: () => string,
): PlannedEntry[] {
  const name = req.name.trim();
  if (!name) throw new TreeActionError('A new person needs a name.');
  const anchor = req.anchorId ? g.byId.get(req.anchorId) : undefined;
  if (req.kind !== 'person' && !anchor) {
    throw new TreeActionError('Pick a person in the tree first.');
  }
  const id = newId();
  const person = { id, name, birthYear: req.birthYear };
  const familyIds = req.kind === 'partner' || !anchor ? [] : anchor.familyIds;
  const out: PlannedEntry[] = [
    {
      collection: 'characters',
      data: {
        _id: id,
        title: name,
        status: req.status,
        names: { full: name },
        birth: req.birthYear === null ? { unknown: true } : { year: req.birthYear },
        familyIds,
      },
    },
  ];
  if (!anchor) return out;
  const a = { id: anchor.id, name: anchor.name, birthYear: yearOf(anchor.birth) };
  switch (req.kind) {
    case 'parent':
      out.push(linkData(newId(), person, a, req.linkType, req.status));
      break;
    case 'child': {
      out.push(linkData(newId(), a, person, req.linkType, req.status));
      if (req.coParentId) {
        const co = g.byId.get(req.coParentId);
        if (!co) throw new TreeActionError('The other parent is not in the tree.');
        out.push(linkData(newId(), { id: co.id, name: co.name }, person, req.linkType, req.status));
      }
      break;
    }
    case 'sibling': {
      const ps = parentsOf(g, anchor.id);
      if (!ps.length) {
        throw new TreeActionError(
          `${anchor.name} has no known parents, so a sibling has no one to link to. Add a parent first.`,
        );
      }
      for (const p of ps) {
        const P = g.byId.get(p) as TreePerson;
        out.push(linkData(newId(), { id: P.id, name: P.name }, person, req.linkType, req.status));
      }
      break;
    }
    case 'partner':
      out.push({
        collection: 'unions',
        data: {
          _id: newId(),
          title: `${anchor.name} and ${name}`,
          status: req.status,
          partnerIds: [anchor.id, id],
          type: req.unionType,
          startYear: null,
          endYear: null,
        },
      });
      break;
    default:
      break;
  }
  return out;
}

export interface LinkExisting {
  /** The other person is the anchor's parent, child, or partner. */
  kind: 'parent' | 'child' | 'partner';
  anchorId: string;
  otherId: string;
  type: string;
  status: 'canon' | 'planned' | 'idea';
}

/** One parent link or union between two people already in the tree. Refuses self-ancestry. */
export function planLinkExisting(
  g: TreeGraph,
  req: LinkExisting,
  newId: () => string,
): PlannedEntry {
  const A = g.byId.get(req.anchorId);
  const O = g.byId.get(req.otherId);
  if (!A || !O) throw new TreeActionError('Pick two people in the tree.');
  if (req.kind === 'partner') {
    if (A.id === O.id) throw new TreeActionError('A person cannot be their own partner.');
    return {
      collection: 'unions',
      data: {
        _id: newId(),
        title: `${A.name} and ${O.name}`,
        status: req.status,
        partnerIds: [A.id, O.id],
        type: req.type,
        startYear: null,
        endYear: null,
      },
    };
  }
  const [parent, child] = req.kind === 'parent' ? [O, A] : [A, O];
  if (wouldBeOwnAncestor(g.links, parent.id, child.id)) {
    throw new TreeActionError(ownAncestorMessage(parent.name, child.name));
  }
  if (g.links.some((l) => l.parentId === parent.id && l.childId === child.id)) {
    throw new TreeActionError(`${parent.name} is already a parent of ${child.name}.`);
  }
  return linkData(
    newId(),
    { id: parent.id, name: parent.name },
    { id: child.id, name: child.name, birthYear: yearOf(child.birth) },
    req.type,
    req.status,
  );
}
