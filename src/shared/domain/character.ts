/**
 * The character page (CH-1 to CH-4) as one pure function over the bible's
 * entries: names, families, the age at the current position, a personal
 * timeline, relatives, and what the character knows. Ages come from the same
 * functions as the tree and the timeline (TL-1).
 */
import type { StoryDate } from '../schema/common';
import { ageAt, lifeState, lifeYears } from './ages';
import type { LifeState } from './ages';
import { isKnown, yearOf } from './dates';
import { isKnownBy } from './knowledge';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import type { Position } from './position';
import { buildGraph, relativesOf } from './tree';

export interface PageData {
  all(collection: string): Doc[];
}

export type TimelineKind =
  'birth' | 'death' | 'union' | 'union-end' | 'child' | 'beat' | 'event' | 'chapter';

export interface TimelineItem {
  kind: TimelineKind;
  year: number | null;
  /** Age in that year, or null when the birth is unknown (CH-4), or they are dead or unborn. */
  age: number | null;
  /** Their state in that year: dead after death, not yet born before birth, unknown only for an unknown birth. */
  state: LifeState['state'] | null;
  collection: string;
  id: string;
  title: string;
  detail: string;
}

export interface CharacterPage {
  id: string;
  name: string;
  names: {
    full: string;
    chinese: string;
    romanization: string;
    order: string;
    birthName: string;
    marriedName: string;
    nicknames: string[];
    calledBy: { characterId: string; characterName: string; name: string }[];
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
  /** The year "what they know" is judged at: the story time, else the current position. */
  knowledgeYear: number | null;
  timeline: TimelineItem[];
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
  knowledge: {
    recordId: string;
    factId: string;
    fact: string;
    yearLearned: number | null;
    chapterId: string | null;
    chapter: string | null;
    how: string;
    /** Whether they know it at the current position, or null when either year is missing. */
    knownAtPosition: boolean | null;
  }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const live = (d: Doc) => !d.deletedAt;
const title = (d: Doc | undefined, fallback: string) => {
  const t = str(d?.title).trim() || str(d?.name).trim();
  return t || fallback;
};
const asDate = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);

/** Events overlap a lifetime when any of their years fall between birth and death. */
function eventYears(e: Doc): [number, number] | null {
  const s = yearOf(asDate(e.start));
  if (s === null) return null;
  const end = yearOf(asDate(e.end));
  return [s, end ?? s];
}

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
  const knowledgeYear = storyTime?.year ?? current.year;
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
  const born = yearOf(birth);
  const died = yearOf(death);
  const ageIn = (y: number | null) => (y === null ? null : ageAt(life, y));
  const byId = (c: string) => new Map(data.all(c).map((d) => [String(d._id), d]));
  const families = byId('families');
  const facts = byId('facts');
  const chapters = data.all('chapters').filter(live);
  const chapterById = new Map(chapters.map((c) => [String(c._id), c]));

  const graph = buildGraph(chars, data.all('unions'), data.all('parentLinks'));
  const rel = relativesOf(graph, id);

  const timeline: TimelineItem[] = [];
  const item = (t: Omit<TimelineItem, 'age' | 'state'> & { age?: number | null }) =>
    timeline.push({
      ...t,
      age: t.age === undefined ? ageIn(t.year) : t.age,
      state: t.year === null ? null : lifeState(life, t.year).state,
    });
  if (born !== null) {
    item({
      kind: 'birth',
      year: born,
      age: 0,
      collection: 'characters',
      id,
      title: 'Born',
      detail: str(me.birthplace),
    });
  }
  if (died !== null) {
    item({ kind: 'death', year: died, collection: 'characters', id, title: 'Dies', detail: '' });
  }
  for (const p of rel.partners) {
    const with_ = nameOf(p.id);
    if (p.startYear !== null) {
      item({
        kind: 'union',
        year: p.startYear,
        collection: 'unions',
        id: p.unionId,
        title: `Union with ${with_} begins`,
        detail: p.type,
      });
    }
    if (p.endYear !== null) {
      item({
        kind: 'union-end',
        year: p.endYear,
        collection: 'unions',
        id: p.unionId,
        title: `Union with ${with_} ends`,
        detail: p.endReason,
      });
    }
  }
  for (const c of rel.children) {
    const child = chars.find((x) => x._id === c.id);
    const childBorn = yearOf(asDate(child?.birth));
    const y = c.type === 'biological' ? childBorn : (c.startYear ?? childBorn);
    const verb = c.type === 'biological' ? 'is born' : `joins the family (${c.type})`;
    item({
      kind: 'child',
      year: y,
      collection: 'parentLinks',
      id: c.linkId,
      title: `${nameOf(c.id)} ${verb}`,
      detail: '',
    });
  }
  for (const b of data.all('plotBeats').filter(live)) {
    if (b.povCharacterId !== id) continue;
    const y = typeof b.year === 'number' ? b.year : null;
    item({
      kind: 'beat',
      year: y,
      collection: 'plotBeats',
      id: String(b._id),
      title: title(b, 'Plot beat'),
      detail: str(b.description),
    });
  }
  if (born !== null) {
    for (const e of data.all('worldEvents').filter(live)) {
      const ys = eventYears(e);
      if (!ys) continue;
      const [s, end] = ys;
      if (end < born || (died !== null && s > died)) continue;
      const y = Math.max(s, born);
      item({
        kind: 'event',
        year: y,
        collection: 'worldEvents',
        id: String(e._id),
        title: title(e, 'World event'),
        detail: e.formative === true ? 'formative' : '',
      });
    }
  }
  for (const c of chapters) {
    const strands = Array.isArray(c.strands) ? c.strands.filter(isPlainObject) : [];
    for (const s of strands) {
      const present = Array.isArray(s.characterIds) && s.characterIds.includes(id);
      const pov = s.povCharacterId === id;
      if (!present && !pov) continue;
      const y = typeof s.startYear === 'number' ? s.startYear : null;
      item({
        kind: 'chapter',
        year: y,
        collection: 'chapters',
        id: String(c._id),
        title: `Chapter ${String(c.readingOrder)}: ${title(c, 'Untitled')}`,
        detail: `${str(s.label)}${pov ? ', point of view' : ''}`,
      });
    }
  }
  const order: TimelineKind[] = [
    'birth',
    'event',
    'union',
    'child',
    'beat',
    'chapter',
    'union-end',
    'death',
  ];
  timeline.sort((a, b) => {
    if (a.year === null || b.year === null) return a.year === null ? (b.year === null ? 0 : 1) : -1;
    return a.year - b.year || order.indexOf(a.kind) - order.indexOf(b.kind);
  });

  const knowledge = data
    .all('knowledgeRecords')
    .filter(live)
    .filter((k) => k.characterId === id)
    .map((k) => {
      const y = typeof k.yearLearned === 'number' ? k.yearLearned : null;
      const chId = typeof k.chapterLearnedId === 'string' ? k.chapterLearnedId : null;
      return {
        recordId: String(k._id),
        factId: str(k.factId),
        fact: title(facts.get(str(k.factId)), str(k.factId)),
        yearLearned: y,
        chapterId: chId,
        chapter: chId ? title(chapterById.get(chId), chId) : null,
        how: str(k.how),
        knownAtPosition: isKnownBy(y, knowledgeYear),
      };
    })
    .sort((a, b) => (a.yearLearned ?? Infinity) - (b.yearLearned ?? Infinity));

  const calledBy = (Array.isArray(names.calledBy) ? names.calledBy : [])
    .filter(isPlainObject)
    .map((c) => ({
      characterId: str(c.characterId),
      characterName: nameOf(str(c.characterId)),
      name: str(c.name),
    }));

  return {
    id,
    name: nameOf(id),
    names: {
      full: str(names.full),
      chinese: str(names.chinese),
      romanization: str(names.romanization),
      order: str(names.order) || 'family-last',
      birthName: str(names.birthName),
      marriedName: str(names.marriedName),
      nicknames: Array.isArray(names.nicknames) ? names.nicknames.map(String) : [],
      calledBy,
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
    knowledgeYear,
    timeline,
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
    knowledge,
  };
}
