/**
 * The plot outline (PL-1 to PL-4): the chapter-by-year grid, reorder logic,
 * and the chapter page. Pure functions over plain entries. Reading order and
 * story year are separate fields (PL-3): the grid can show either order and
 * reordering changes only the reading order.
 */
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
/** An arc is shown by its name; its title is only the entry label. */
const arcName = (a: Doc | undefined, fallback: string) => str(a?.name).trim() || title(a, fallback);
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export interface OutlineStrand {
  id: string;
  label: string;
  primary: boolean;
  startYear: number;
  endYear: number;
}

export interface OutlineArcSpan {
  arcId: string;
  name: string;
  scope: string;
  /** A series token such as `series-1`, from the owner's family. */
  color: string;
  from: number;
  to: number;
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
  arcSpans: OutlineArcSpan[];
}

export type OutlineRow =
  | { kind: 'book'; id: string; title: string }
  | { kind: 'part'; id: string; title: string }
  | OutlineChapter;

export interface Outline {
  order: 'reading' | 'story';
  years: number[];
  rows: OutlineRow[];
  /** The cursor year when it falls inside the grid, else null. */
  cursorYear: number | null;
}

function strandsOf(chapter: Doc): OutlineStrand[] {
  const raw = Array.isArray(chapter.strands) ? chapter.strands.filter(isPlainObject) : [];
  const out: OutlineStrand[] = [];
  for (const s of raw) {
    const start = num(s.startYear);
    if (start === null) continue;
    const end = num(s.endYear) ?? start;
    out.push({
      id: str(s.id),
      label: str(s.label),
      primary: s.primary === true,
      startYear: Math.min(start, end),
      endYear: Math.max(start, end),
    });
  }
  return out;
}

/** The series token for an arc: its family, else its owner's first family, else the fourth series. */
function arcColor(arc: Doc, families: Map<string, Doc>, characters: Map<string, Doc>): string {
  const own = families.get(str(arc.familyId));
  if (own) return str(own.color) || 'series-4';
  const owner = characters.get(str(arc.ownerCharacterId));
  for (const fid of idList(owner?.familyIds)) {
    const f = families.get(fid);
    if (f) return str(f.color) || 'series-4';
  }
  return 'series-4';
}

/**
 * PL-2: one row per chapter, columns are years. In reading order the rows are
 * grouped by book and part; in story-year order they are one flat list sorted
 * by the chapter's story year, then reading order.
 */
export function outlineGrid(
  data: OutlineData,
  opts: { order: 'reading' | 'story'; cursorYear?: number | null },
): Outline {
  const books = data.all('books').filter(live);
  const parts = data.all('parts').filter(live);
  const arcs = new Map(
    data
      .all('arcs')
      .filter(live)
      .map((a) => [str(a._id), a]),
  );
  const families = new Map(data.all('families').map((f) => [str(f._id), f]));
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));
  const partById = new Map(parts.map((p) => [str(p._id), p]));
  const bookById = new Map(books.map((b) => [str(b._id), b]));

  const chapters: OutlineChapter[] = data
    .all('chapters')
    .filter(live)
    .map((c) => {
      const strands = strandsOf(c);
      const lo = strands.length ? Math.min(...strands.map((s) => s.startYear)) : null;
      const hi = strands.length ? Math.max(...strands.map((s) => s.endYear)) : null;
      const spans: OutlineArcSpan[] = [];
      for (const id of idList(c.arcIds)) {
        const arc = arcs.get(id);
        if (!arc) continue;
        const from = num(arc.startYear) ?? lo;
        const to = num(arc.endYear) ?? hi;
        if (from === null || to === null) continue;
        spans.push({
          arcId: id,
          name: str(arc.name) || title(arc),
          scope: str(arc.scope),
          color: arcColor(arc, families, characters),
          from: Math.min(from, to),
          to: Math.max(from, to),
        });
      }
      return {
        kind: 'chapter' as const,
        id: str(c._id),
        title: title(c, 'Untitled chapter'),
        readingOrder: num(c.readingOrder) ?? 0,
        partId: str(c.partId),
        storyYear: chapterYear(c),
        written: c.written === true,
        strands,
        arcSpans: spans,
      };
    });

  const byReading = (a: OutlineChapter, b: OutlineChapter) =>
    a.readingOrder - b.readingOrder || a.title.localeCompare(b.title);

  let rows: OutlineRow[] = [];
  if (opts.order === 'story') {
    rows = [...chapters].sort(
      (a, b) => (a.storyYear ?? Infinity) - (b.storyYear ?? Infinity) || byReading(a, b),
    );
  } else {
    const bookNo = (partId: string) =>
      num(bookById.get(str(partById.get(partId)?.bookId))?.number) ?? 0;
    const partNo = (partId: string) => num(partById.get(partId)?.number) ?? 0;
    const sorted = [...chapters].sort(
      (a, b) =>
        bookNo(a.partId) - bookNo(b.partId) ||
        partNo(a.partId) - partNo(b.partId) ||
        byReading(a, b),
    );
    let lastBook: string | null = null;
    let lastPart: string | null = null;
    for (const c of sorted) {
      const part = partById.get(c.partId);
      const bookId = str(part?.bookId);
      if (bookId !== lastBook) {
        lastBook = bookId;
        lastPart = null;
        rows.push({ kind: 'book', id: bookId, title: title(bookById.get(bookId), 'No book') });
      }
      if (c.partId !== lastPart) {
        lastPart = c.partId;
        rows.push({ kind: 'part', id: c.partId, title: title(part, 'No part') });
      }
      rows.push(c);
    }
  }

  const years = new Set<number>();
  for (const c of chapters) {
    for (const s of c.strands) {
      years.add(s.startYear);
      years.add(s.endYear);
    }
    for (const a of c.arcSpans) {
      years.add(a.from);
      years.add(a.to);
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
 * theirs (reading order runs across a whole book); `sequence` numbers 1 to n
 * (beats within an arc). Returns only the items whose number changes.
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

export interface ChapterPage {
  id: string;
  title: string;
  readingOrder: number;
  storyYear: number | null;
  written: boolean;
  arcs: { id: string; name: string }[];
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
  beats: { id: string; title: string; year: number | null; description: string; arcs: string[] }[];
  themes: { id: string; title: string; note: string }[];
  factsInPlay: {
    factId: string;
    fact: string;
    characterId: string;
    character: string;
    note: string;
  }[];
}

/** PL-4: a chapter with its beats, who is present and how old, places, themes, and facts in play. */
export function chapterPage(data: OutlineData, id: string): ChapterPage | null {
  const chapter = data.all('chapters').find((c) => str(c._id) === id);
  if (!chapter) return null;
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));
  const places = data.all('places');
  const arcs = new Map(data.all('arcs').map((a) => [str(a._id), a]));
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

  const beats = data
    .all('plotBeats')
    .filter((b) => live(b) && b.chapterId === id)
    .sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0) || title(a).localeCompare(title(b)))
    .map((b) => ({
      id: str(b._id),
      title: title(b, 'Untitled beat'),
      year: num(b.year),
      description: str(b.description),
      arcs: idList(b.arcIds).map((a) => arcName(arcs.get(a), a)),
    }));

  const themeNotes = new Map<string, string>();
  for (const tid of idList(chapter.themeIds)) themeNotes.set(tid, '');
  for (const t of data.all('themes').filter(live)) {
    const app = (Array.isArray(t.appearances) ? t.appearances.filter(isPlainObject) : []).find(
      (a) => a.chapterId === id,
    );
    if (app) themeNotes.set(str(t._id), str(app.note));
  }
  const themeDocs = new Map(data.all('themes').map((t) => [str(t._id), t]));
  const themes = [...themeNotes].map(([tid, note]) => ({
    id: tid,
    title: title(themeDocs.get(tid), tid),
    note,
  }));

  const facts = new Map(data.all('facts').map((f) => [str(f._id), f]));
  const factsInPlay = (
    Array.isArray(chapter.factsInPlay) ? chapter.factsInPlay.filter(isPlainObject) : []
  ).map((f) => ({
    factId: str(f.factId),
    fact: title(facts.get(str(f.factId)), str(f.factId)),
    characterId: str(f.characterId),
    character: nameOf(str(f.characterId)),
    note: str(f.note),
  }));

  return {
    id,
    title: title(chapter, 'Untitled chapter'),
    readingOrder: num(chapter.readingOrder) ?? 0,
    storyYear: chapterYear(chapter),
    written: chapter.written === true,
    arcs: idList(chapter.arcIds).map((a) => ({ id: a, name: arcName(arcs.get(a), a) })),
    strands,
    beats,
    themes,
    factsInPlay,
  };
}
