/**
 * The character page (CH-1, CH-4, SM-1) as one pure function over the bible's
 * entries: names, families, the age at the current position and at the story
 * time, and relatives. Ages come from the same functions as the tree and the
 * timeline (TL-1). The personal timeline and what they know went with A39.
 */
import type { StoryDate } from '../schema/common';
import { lifeState, lifeYears } from './ages';
import type { LifeState } from './ages';
import { isKnown } from './dates';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import type { Position } from './position';
import { buildGraph, relativesOf } from './tree';

export interface PageData {
  all(collection: string): Doc[];
}

export interface CharacterPage {
  id: string;
  name: string;
  names: {
    full: string;
    chinese: string;
  };
  families: { id: string; name: string; color: string }[];
  years: string;
  birthKnown: boolean;
  /** The current position: the last chapter in reading order marked written (CH-3). */
  current: {
    year: number | null;
    chapterId: string | null;
    chapter: string | null;
    readingOrder: number | null;
    state: LifeState | null;
  };
  /** The story time, when one is set (TM-3): a year, or a full date judged exactly. */
  storyTime: { year: number; month?: number; day?: number; state: LifeState } | null;
  relatives: {
    parents: { id: string; name: string; type: string; startYear: number | null }[];
    children: { id: string; name: string; type: string; startYear: number | null }[];
    siblings: { id: string; name: string; kind: 'full' | 'half' | 'sibling' }[];
    partners: {
      id: string;
      name: string;
      unionId: string;
      type: string;
      startYear: number | null;
      endYear: number | null;
      endReason: string;
    }[];
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const live = (d: Doc) => !d.deletedAt;
const title = (d: Doc | undefined, fallback: string) => {
  const t = str(d?.title).trim() || str(d?.name).trim();
  return t || fallback;
};
const asDate = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);

/**
 * The state at the story time. A full date (month and day) is judged exactly,
 * as the Story Time dialog judges it, so the page and the dialog agree before
 * a birthday; a year or a year and month uses year arithmetic (TL-3).
 */
export function storyTimeState(
  life: { birth: StoryDate | null; death: StoryDate | null },
  t: { year: number; month?: number; day?: number },
): { year: number; month?: number; day?: number; state: LifeState } {
  if (t.month !== undefined && t.day !== undefined) {
    const at = { year: t.year, month: t.month, day: t.day };
    return { ...at, state: lifeState(life, at) };
  }
  return { year: t.year, state: lifeState(life, t.year) };
}

export function characterPage(
  data: PageData,
  id: string,
  current: Position,
  storyTime: { year: number; month?: number; day?: number } | null = null,
): CharacterPage | null {
  const chars = data.all('characters');
  const me = chars.find((c) => c._id === id);
  if (!me) return null;
  const nameOf = (cid: string) => {
    const d = chars.find((c) => c._id === cid);
    const n = isPlainObject(d?.names) ? str(d.names.full) : '';
    return n || title(d, cid);
  };
  const names = isPlainObject(me.names) ? me.names : {};
  const birth = asDate(me.birth);
  const death = asDate(me.death);
  const life = { birth, death };
  const byId = (c: string) => new Map(data.all(c).map((d) => [String(d._id), d]));
  const families = byId('families');
  const chapters = data.all('chapters').filter(live);
  const chapterById = new Map(chapters.map((c) => [String(c._id), c]));

  const graph = buildGraph(chars, data.all('unions'), data.all('parentLinks'));
  const rel = relativesOf(graph, id);

  return {
    id,
    name: nameOf(id),
    names: {
      full: str(names.full),
      chinese: str(names.chinese),
    },
    families: (Array.isArray(me.familyIds) ? me.familyIds.map(String) : []).map((fid) => {
      const f = families.get(fid);
      return { id: fid, name: str(f?.name) || fid, color: str(f?.color) || 'series-4' };
    }),
    years: lifeYears(life),
    birthKnown: isKnown(birth),
    current: {
      year: current.year,
      chapterId: current.chapterId,
      chapter: current.chapterId
        ? title(chapterById.get(current.chapterId), current.chapterId)
        : null,
      readingOrder: current.chapterId
        ? ((chapterById.get(current.chapterId)?.readingOrder as number | undefined) ?? null)
        : null,
      state: current.year === null ? null : lifeState(life, current.year),
    },
    storyTime: storyTime ? storyTimeState(life, storyTime) : null,
    relatives: {
      parents: rel.parents.map((p) => ({
        id: p.id,
        name: nameOf(p.id),
        type: p.type,
        startYear: p.startYear,
      })),
      children: rel.children.map((c) => ({
        id: c.id,
        name: nameOf(c.id),
        type: c.type,
        startYear: c.startYear,
      })),
      siblings: rel.siblings.map((s) => ({ id: s.id, name: nameOf(s.id), kind: s.kind })),
      partners: rel.partners.map((p) => ({ ...p, name: nameOf(p.id) })),
    },
  };
}
