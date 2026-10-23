/**
 * The plot outline: the chapter-by-year grid, reorder logic, and the chapter
 * page (arcs, beats, themes, and facts in play went with A39). Pure functions over plain entries. Reading order and
 * story year are separate fields (PL-3): the grid can show either order and
 * reordering changes only the reading order.
 */
import { groupLabel } from './numbering';
import type { LifeState } from './ages';
import { placePath } from './culture';
import { chapterYear } from './position';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import { characterName, stateIn } from './timeline';

export interface OutlineData {
  all(collection: string): Doc[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc) => !d.deletedAt;
const title = (d: Doc | undefined, fallback = '') =>
  str(d?.title).trim() || str(d?.name).trim() || fallback;
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export interface OutlineStrand {
  id: string;
  label: string;
  primary: boolean;
  startYear: number;
  endYear: number;
  /** The point-of-view character's name, or null. */
  pov: string | null;
  /** The names of the characters present, in order. */
  present: string[];
}

export interface OutlineChapter {
  kind: 'chapter';
  id: string;
  title: string;
  readingOrder: number;
  partId: string;
  storyYear: number | null;
  written: boolean;
  strands: OutlineStrand[];
}

/**
 * `label` is what a heading shows: the number from the number field and the
 * name ("Part 2: Lost Spirits", PL-3). `missing` marks a heading for chapters
 * whose part is gone (in the trash or never made); it cannot be renamed or
 * added to.
 */
export interface OutlinePart {
  kind: 'part';
  id: string;
  title: string;
  number: number | null;
  label: string;
  missing: boolean;
  chapterCount: number;
}

export type OutlineRow = OutlinePart | OutlineChapter;

export interface Outline {
  order: 'reading' | 'story';
  years: number[];
  rows: OutlineRow[];
  /** The cursor year when it falls inside the grid, else null. */
  cursorYear: number | null;
}

function strandsOf(chapter: Doc, characters: Map<string, Doc>): OutlineStrand[] {
  const raw = Array.isArray(chapter.strands) ? chapter.strands.filter(isPlainObject) : [];
  const out: OutlineStrand[] = [];
  for (const s of raw) {
    const start = num(s.startYear);
    if (start === null) continue;
    const end = num(s.endYear) ?? start;
    const pov = str(s.povCharacterId);
    out.push({
      id: str(s.id),
      label: str(s.label),
      primary: s.primary === true,
      startYear: Math.min(start, end),
      endYear: Math.max(start, end),
      pov: pov ? characterName(characters.get(pov), pov) : null,
      present: idList(s.characterIds).map((id) => characterName(characters.get(id), id)),
    });
  }
  return out;
}

/**
 * KB-3: the reading-order rows. Every live part has a heading, even with
 * nothing in it yet, so a chapter can be made under it. Parts sort by number,
 * chapters by reading order. Chapters whose part is gone sit under a "No part"
 * heading marked missing, first, as before.
 */
function groupedRows(
  parts: readonly Doc[],
  chapters: readonly OutlineChapter[],
  byReading: (a: OutlineChapter, b: OutlineChapter) => number,
): OutlineRow[] {
  const partById = new Map(parts.map((p) => [str(p._id), p]));
  const byNumber = (a: Doc | undefined, b: Doc | undefined) =>
    (num(a?.number) ?? 0) - (num(b?.number) ?? 0) || title(a).localeCompare(title(b));

  const partIdSet = new Set<string>(parts.map((p) => str(p._id)));
  for (const c of chapters) partIdSet.add(c.partId);
  const partIds = [...partIdSet].sort((a, b) => {
    const da = partById.get(a);
    const db = partById.get(b);
    if (!da || !db) return (da ? 1 : 0) - (db ? 1 : 0) || a.localeCompare(b);
    return byNumber(da, db);
  });

  const rows: OutlineRow[] = [];
  for (const partId of partIds) {
    const part = partById.get(partId);
    const inPart = chapters.filter((c) => c.partId === partId).sort(byReading);
    const pt = title(part, 'No part');
    const pn = part ? num(part.number) : null;
    rows.push({
      kind: 'part',
      id: partId,
      title: pt,
      number: pn,
      label: part ? groupLabel('part', pn, pt) : pt,
      missing: !part,
      chapterCount: inPart.length,
    });
    rows.push(...inPart);
  }
  return rows;
}

/**
 * PL-2: one row per chapter, columns are years. In reading order the rows are
 * grouped by part; in story-year order they are one flat list sorted
 * by the chapter's story year, then reading order.
 */
export function outlineGrid(
  data: OutlineData,
  opts: { order: 'reading' | 'story'; cursorYear?: number | null },
): Outline {
  const parts = data.all('parts').filter(live);
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));

  const chapters: OutlineChapter[] = data
    .all('chapters')
    .filter(live)
    .map((c) => {
      const strands = strandsOf(c, characters);
      return {
        kind: 'chapter' as const,
        id: str(c._id),
        title: title(c, 'Untitled chapter'),
        readingOrder: num(c.readingOrder) ?? 0,
        partId: str(c.partId),
        storyYear: chapterYear(c),
        written: c.written === true,
        strands,
      };
    });

  const byReading = (a: OutlineChapter, b: OutlineChapter) =>
    a.readingOrder - b.readingOrder || a.title.localeCompare(b.title);

  const rows: OutlineRow[] =
    opts.order === 'story'
      ? [...chapters].sort(
          (a, b) => (a.storyYear ?? Infinity) - (b.storyYear ?? Infinity) || byReading(a, b),
        )
      : groupedRows(parts, chapters, byReading);

  const years = new Set<number>();
  for (const c of chapters) {
    for (const s of c.strands) {
      years.add(s.startYear);
      years.add(s.endYear);
    }
  }
  const cursor = opts.cursorYear ?? null;
  if (cursor !== null) years.add(cursor);
  const lo = years.size ? Math.min(...years) : 0;
  const hi = years.size ? Math.max(...years) : -1;
  const axis: number[] = [];
  for (let y = lo; y <= hi && axis.length < 400; y++) axis.push(y);
  return { order: opts.order, years: axis, rows, cursorYear: cursor !== null ? cursor : null };
}

export interface Reorder {
  id: string;
  value: number;
}

/**
 * PL-3: move one item to a new position among its siblings. `reuse` hands the
 * existing numbers back out in the new order, so siblings in other groups keep
 * theirs (reading order runs across the whole outline); `sequence` numbers 1 to n.
 * Returns only the items whose number changes.
 */
export function reorder(
  items: readonly { id: string; value: number }[],
  movedId: string,
  toIndex: number,
  mode: 'reuse' | 'sequence',
): Reorder[] {
  const from = items.findIndex((i) => i.id === movedId);
  if (from < 0) return [];
  const ids = items.map((i) => i.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, moved as string);
  const values =
    mode === 'sequence'
      ? ids.map((_, i) => i + 1)
      : items.map((i) => i.value).sort((a, b) => a - b);
  const before = new Map(items.map((i) => [i.id, i.value]));
  return ids
    .map((id, i) => ({ id, value: values[i] as number }))
    .filter((r) => before.get(r.id) !== r.value);
}

export interface ChapterPatch {
  id: string;
  readingOrder: number;
  partId: string;
}

/**
 * PL-3: move a chapter to a place in a part, in its own part or another one.
 * Within a part the numbers of that part are reused, so other parts keep
 * theirs. Into another part the chapter takes the target position and the
 * target part, and the reading order is renumbered across all the chapters,
 * handing the same numbers back out in the new order.
 * Returns the chapters whose reading order or part changes.
 */
export function moveChapter(
  chapters: readonly Doc[],
  parts: readonly Doc[],
  movedId: string,
  toPartId: string,
  toIndex: number,
): ChapterPatch[] {
  const liveChapters = chapters.filter(live);
  const moved = liveChapters.find((c) => str(c._id) === movedId);
  if (!moved) return [];
  const partById = new Map(parts.map((p) => [str(p._id), p]));
  const rank = (partId: string): number => num(partById.get(partId)?.number) ?? 0;
  const cmp = (a: { partId: string; readingOrder: number; title: string }, b: typeof a) =>
    rank(a.partId) - rank(b.partId) ||
    a.readingOrder - b.readingOrder ||
    a.title.localeCompare(b.title);
  const item = (c: Doc) => ({
    id: str(c._id),
    partId: str(c.partId),
    readingOrder: num(c.readingOrder) ?? 0,
    title: title(c),
  });

  if (str(moved.partId) === toPartId) {
    const siblings = liveChapters
      .filter((c) => str(c.partId) === toPartId)
      .map(item)
      .sort(cmp);
    return reorder(
      siblings.map((c) => ({ id: c.id, value: c.readingOrder })),
      movedId,
      toIndex,
      'reuse',
    ).map((r) => ({ id: r.id, readingOrder: r.value, partId: toPartId }));
  }

  const scope = liveChapters.map(item).sort(cmp);
  const before = new Map(scope.map((c) => [c.id, c]));
  const values = scope.map((c) => c.readingOrder).sort((a, b) => a - b);
  const rest = scope.filter((c) => c.id !== movedId);
  const tp = rank(toPartId);
  const ahead = rest.filter((c) => rank(c.partId) < tp).length;
  const inTarget = rest.filter((c) => c.partId === toPartId).length;
  const at = ahead + Math.max(0, Math.min(inTarget, toIndex));
  const next = [...rest];
  next.splice(at, 0, { ...(before.get(movedId) as ReturnType<typeof item>), partId: toPartId });
  const out: ChapterPatch[] = [];
  next.forEach((c, i) => {
    const was = before.get(c.id) as ReturnType<typeof item>;
    const value = values[i] as number;
    if (was.readingOrder !== value || was.partId !== c.partId) {
      out.push({ id: c.id, readingOrder: value, partId: c.partId });
    }
  });
  return out;
}

export interface ChapterPage {
  id: string;
  title: string;
  readingOrder: number;
  storyYear: number | null;
  written: boolean;
  strands: {
    id: string;
    label: string;
    primary: boolean;
    startYear: number;
    endYear: number | null;
    pov: { id: string; name: string } | null;
    characters: { id: string; name: string; state: LifeState }[];
    places: { id: string; name: string }[];
  }[];
}

/** A chapter with who is present and how old in each strand, and its places. */
export function chapterPage(data: OutlineData, id: string): ChapterPage | null {
  const chapter = data.all('chapters').find((c) => str(c._id) === id);
  if (!chapter) return null;
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));
  const places = data.all('places');
  const nameOf = (cid: string) => characterName(characters.get(cid), cid);

  const strands = (Array.isArray(chapter.strands) ? chapter.strands.filter(isPlainObject) : []).map(
    (s) => {
      const year = num(s.startYear) ?? 0;
      const pov = str(s.povCharacterId);
      return {
        id: str(s.id),
        label: str(s.label),
        primary: s.primary === true,
        startYear: year,
        endYear: num(s.endYear),
        pov: pov ? { id: pov, name: nameOf(pov) } : null,
        characters: idList(s.characterIds).map((cid) => {
          const c = characters.get(cid);
          const state: LifeState = c ? stateIn(c, year) : { state: 'unknown' };
          return { id: cid, name: nameOf(cid), state };
        }),
        places: idList(s.placeIds).map((pid) => ({ id: pid, name: placePath(places, pid) || pid })),
      };
    },
  );

  return {
    id,
    title: title(chapter, 'Untitled chapter'),
    readingOrder: num(chapter.readingOrder) ?? 0,
    storyYear: chapterYear(chapter),
    written: chapter.written === true,
    strands,
  };
}

export interface NumberPatch {
  id: string;
  number: number;
}

/**
 * KB-3: move a part among the parts. The numbers already in use are handed
 * back out in the new order, so the parts keep their range; when two share a
 * number the group is numbered from its lowest number up instead. Returns
 * only the entries whose number changes.
 */
export function moveNumbered(
  siblings: readonly Doc[],
  movedId: string,
  toIndex: number,
): NumberPatch[] {
  const items = siblings
    .filter(live)
    .map((d) => ({ id: str(d._id), value: num(d.number) ?? 0, title: title(d) }))
    .sort((a, b) => a.value - b.value || a.title.localeCompare(b.title));
  const distinct = new Set(items.map((i) => i.value)).size === items.length;
  if (distinct) {
    return reorder(items, movedId, toIndex, 'reuse').map((r) => ({ id: r.id, number: r.value }));
  }
  const lo = Math.max(1, Math.min(...items.map((i) => i.value)));
  return reorder(items, movedId, toIndex, 'sequence').map((r) => ({
    id: r.id,
    number: r.value + lo - 1,
  }));
}

/** KB-3: the number a new part takes: one past the highest. */
export function nextNumber(siblings: readonly Doc[]): number {
  const used = siblings.filter(live).map((d) => num(d.number) ?? 0);
  return used.length ? Math.max(...used) + 1 : 1;
}

/**
 * KB-3: where a new chapter goes when it is made from a part heading: last in
 * that part; or, made from the scene outline (A37), right after the chapter
 * named by `afterId` when that chapter is in the part. Reading order runs across the whole outline, so it takes the
 * number after the chapter before it, and the chapters after it move up only
 * as far as they must to stay after it. Returns the new reading order and the
 * chapters whose reading order changes.
 */
export function newChapterPlace(
  chapters: readonly Doc[],
  parts: readonly Doc[],
  partId: string,
  afterId?: string,
): { readingOrder: number; shifts: ChapterPatch[] } {
  const partById = new Map(parts.map((p) => [str(p._id), p]));
  const rank = (pid: string): number => num(partById.get(pid)?.number) ?? 0;
  const sorted = chapters
    .filter(live)
    .map((c) => ({ id: str(c._id), partId: str(c.partId), order: num(c.readingOrder) ?? 0 }))
    .sort((a, b) => rank(a.partId) - rank(b.partId) || a.order - b.order);
  const tp = rank(partId);
  const following = sorted.findIndex((c) => c.id === afterId && c.partId === partId);
  const at = following >= 0 ? following + 1 : sorted.filter((c) => rank(c.partId) <= tp).length;
  const before = sorted[at - 1];
  const after = sorted[at];
  const readingOrder = before ? before.order + 1 : Math.max(1, after ? after.order : 1);
  const shifts: ChapterPatch[] = [];
  let last = readingOrder;
  for (const c of sorted.slice(at)) {
    if (c.order > last) break;
    last += 1;
    shifts.push({ id: c.id, readingOrder: last, partId: c.partId });
  }
  return { readingOrder, shifts };
}
