/**
 * Manuscript chapters (MS-1 to MS-5): the text diff shown on re-import, the
 * "summary may be out of date" rule, and the planned entries a written
 * chapter establishes. Pure functions; nothing here writes anywhere, and no
 * code path in the app writes to a manuscript file or document (MS-5, A4).
 */
import { plain } from './brief/selection';
import { characterName } from './timeline';
import type { TimelineData } from './timeline';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import { entryTitle } from '../schema';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc | undefined): d is Doc => !!d && !d.deletedAt;
const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** The manuscript as lines of plain text, one per paragraph; a scene break is `* * *`. */
export function manuscriptLines(body: string): string[] {
  return plain(body)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Line number in the old text (removed, same) or the new text (added). */
  line: number;
}

/**
 * MS-4: a line diff of two texts (longest common subsequence), in reading
 * order: removed lines before the added lines that replace them.
 */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // LCS lengths from the end, so the walk below goes forward.
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => table[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i] ?? '', line: i + 1 });
      i++;
      j++;
    } else if (j >= m || (i < n && at(i + 1, j) >= at(i, j + 1))) {
      out.push({ kind: 'removed', text: before[i] ?? '', line: i + 1 });
      i++;
    } else {
      out.push({ kind: 'added', text: after[j] ?? '', line: j + 1 });
      j++;
    }
  }
  return out;
}

export interface ManuscriptChange {
  changed: boolean;
  diff: DiffLine[];
  added: number;
  removed: number;
  /** MS-4: true when the text changed and the chapter has a summary to doubt. */
  summaryOutOfDate: boolean;
}

/** MS-4: what re-importing a chapter changes, and whether its summary may be out of date. */
export function manuscriptChange(
  chapter: Record<string, unknown>,
  nextBody: string,
): ManuscriptChange {
  const before = manuscriptLines(str(chapter.manuscriptText));
  const after = manuscriptLines(nextBody);
  const diff = lineDiff(before, after);
  const added = diff.filter((d) => d.kind === 'added').length;
  const removed = diff.filter((d) => d.kind === 'removed').length;
  const changed = added + removed > 0;
  const hadText = before.length > 0;
  return {
    changed,
    diff,
    added,
    removed,
    summaryOutOfDate:
      chapter.summaryOutOfDate === true ||
      (changed && hadText && str(chapter.summary).trim() !== ''),
  };
}

export interface Establishment {
  id: string;
  collection: string;
  title: string;
  /** How the chapter establishes it, in plain words. */
  why: string;
}

/**
 * MS-3: the planned entries a written chapter establishes, for promotion to
 * canon one by one. They are the chapter's planned point-of-view characters,
 * characters present, and places; beats assigned to it; facts in play and the
 * knowledge records learned in it; themes that appear in it; and entries it
 * links to. World events dated after the chapter's latest strand year are
 * left out: a chapter cannot establish something that has not happened yet.
 */
export function establishedPlanned(data: TimelineData, chapterId: string): Establishment[] {
  const chapter = data.all('chapters').find((c) => c._id === chapterId);
  if (!live(chapter)) return [];
  const strands = (Array.isArray(chapter.strands) ? chapter.strands : []).filter(isPlainObject);
  const latestYear = Math.max(
    ...strands.map((s) => num(s.endYear) ?? num(s.startYear) ?? -Infinity),
  );
  const found = new Map<string, Establishment>();
  const all = new Map<string, { collection: string; doc: Doc }>();
  for (const c of [
    'characters',
    'places',
    'plotBeats',
    'facts',
    'knowledgeRecords',
    'themes',
    'worldEvents',
    'culturalEntries',
    'glossaryTerms',
    'eraStates',
    'arcs',
    'customEntries',
    'openQuestions',
    'relationships',
    'unions',
    'parentLinks',
    'families',
  ]) {
    for (const d of data.all(c)) if (live(d)) all.set(str(d._id), { collection: c, doc: d });
  }
  const add = (id: string, why: string) => {
    const e = all.get(id);
    if (!e || e.doc.status !== 'planned') return;
    if (e.collection === 'worldEvents') {
      const start = isPlainObject(e.doc.start) ? num(e.doc.start.year) : null;
      if (start !== null && start > latestYear) return;
    }
    const prev = found.get(id);
    if (prev) {
      if (!prev.why.split('; ').includes(why)) prev.why = `${prev.why}; ${why}`;
      return;
    }
    found.set(id, {
      id,
      collection: e.collection,
      title: e.collection === 'characters' ? characterName(e.doc, id) : entryTitle(e.doc),
      why,
    });
  };
  for (const s of strands) {
    if (str(s.povCharacterId)) add(str(s.povCharacterId), 'point of view');
    for (const c of idList(s.characterIds)) add(c, 'present');
    for (const p of idList(s.placeIds)) add(p, 'a place in the chapter');
  }
  for (const b of data.all('plotBeats').filter(live)) {
    if (b.chapterId === chapterId) add(str(b._id), 'a beat of this chapter');
  }
  for (const f of (Array.isArray(chapter.factsInPlay) ? chapter.factsInPlay : []).filter(
    isPlainObject,
  )) {
    add(str(f.factId), 'a fact in play');
  }
  for (const k of data.all('knowledgeRecords').filter(live)) {
    if (k.chapterLearnedId === chapterId) add(str(k._id), 'learned in this chapter');
  }
  for (const t of data.all('themes').filter(live)) {
    const apps = (Array.isArray(t.appearances) ? t.appearances : []).filter(isPlainObject);
    if (apps.some((a) => a.chapterId === chapterId)) add(str(t._id), 'appears in this chapter');
  }
  for (const l of (Array.isArray(chapter.links) ? chapter.links : []).filter(isPlainObject)) {
    add(str(l.targetId), `linked as ${str(l.kind) || 'a link'}`);
  }
  const order = ['characters', 'places', 'plotBeats', 'facts', 'knowledgeRecords', 'themes'];
  const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length);
  return [...found.values()].sort(
    (a, b) =>
      rank(a.collection) - rank(b.collection) ||
      a.title.localeCompare(b.title) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
