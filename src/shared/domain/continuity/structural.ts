/**
 * Structural continuity checks (CC-2, CC-5), in code, over the bible's
 * entries. Pure: the same entries always give the same findings, in the same
 * order, each with a stable key so a re-run finds it again and a dismissal
 * sticks (CC-4). Ages and alive-or-dead come from `ages.ts` (TL-3, TL-4), so
 * a character is alive in the year they die.
 *
 * The checks, per chapter strand (A5) or per chapter at its story year:
 * - a character present in a strand while dead or unborn in that strand's
 *   year (for a year range: dead before it starts, or born after it ends);
 * - a character acting on a fact in play (KN-3) before the year their
 *   knowledge record says they learn it;
 * - an event linked to the chapter as having happened, dated after its story year;
 * - a strand year outside its point of view character's lifetime;
 * and, for the whole manuscript, the FT-6 tree warnings.
 */
import { lifeState } from '../ages';
import type { LifeState } from '../ages';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { characterName, eventSpans } from '../timeline';
import type { TimelineData } from '../timeline';
import { buildGraph, treeWarnings } from '../tree';
import type { StoryDate } from '../../schema/common';

export const STRUCTURAL_CHECKS = [
  'character-present-while-dead',
  'character-present-while-unborn',
  'fact-acted-on-before-learned',
  'event-linked-as-happened-after-story-year',
  'strand-year-outside-pov-lifetime',
  'tree-warning',
] as const;
export type StructuralCheck = (typeof STRUCTURAL_CHECKS)[number];

/** Plain labels for the checks, as the findings list shows them. */
export const CHECK_LABELS: Record<StructuralCheck, string> = {
  'character-present-while-dead': 'Present while dead',
  'character-present-while-unborn': 'Present before birth',
  'fact-acted-on-before-learned': 'Acts on a fact before learning it',
  'event-linked-as-happened-after-story-year': 'Event linked before it happens',
  'strand-year-outside-pov-lifetime': 'Point of view outside their lifetime',
  'tree-warning': 'Family tree warning',
};

export interface StructuralFinding {
  /** Stable across runs: check, chapter, strand, and the entries on the other side. */
  key: string;
  check: StructuralCheck;
  chapterId: string | null;
  strandId: string | null;
  storyYear: number | null;
  /** The entries the finding cites, besides the chapter: the other side of the conflict. */
  entryIds: string[];
  /** One line for lists. */
  title: string;
  /** Plain words, naming both sides. */
  explanation: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc | undefined): d is Doc => !!d && !d.deletedAt;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
const asDate = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);

/** The stable key of a finding (CC-4: what a dismissal is stored against). */
export function findingKey(
  check: string,
  chapterId: string | null,
  strandId: string | null,
  entryIds: readonly string[],
): string {
  return ['structural', check, chapterId ?? '-', strandId ?? '-', entryIds.join('+')].join(':');
}

interface StrandOf {
  id: string;
  label: string;
  primary: boolean;
  startYear: number;
  endYear: number;
  povCharacterId: string | null;
  characterIds: string[];
}

function strandsOf(chapter: Doc): StrandOf[] {
  const list = Array.isArray(chapter.strands) ? chapter.strands.filter(isPlainObject) : [];
  const out: StrandOf[] = [];
  for (const s of list) {
    const start = num(s.startYear);
    if (start === null) continue;
    const end = num(s.endYear);
    out.push({
      id: str(s.id),
      label: str(s.label) || 'strand',
      primary: s.primary === true,
      startYear: start,
      endYear: end !== null && end >= start ? end : start,
      povCharacterId: str(s.povCharacterId) || null,
      characterIds: ids(s.characterIds),
    });
  }
  return out;
}

/** The primary strand, or the first when none is marked (the chapter's story year, A5). */
function primaryOf(strands: StrandOf[]): StrandOf | undefined {
  return strands.find((s) => s.primary) ?? strands[0];
}

const chapterLabel = (c: Doc) => `Chapter ${num(c.readingOrder) ?? str(c.title)}`;
const yearText = (s: StrandOf) =>
  s.startYear === s.endYear ? String(s.startYear) : `${s.startYear} to ${s.endYear}`;

/** "Chapter 4 is set in 2032", or "Chapter 2's backstory strand is set in 2032". */
function setIn(c: Doc, s: StrandOf): string {
  return s.primary
    ? `${chapterLabel(c)} is set in ${yearText(s)}`
    : `${chapterLabel(c)}'s ${s.label} strand is set in ${yearText(s)}`;
}

/** Dead or unborn for the whole of a strand's years, or null when alive at some point or unknown. */
function outsideLife(
  person: Doc,
  s: StrandOf,
): Extract<LifeState, { state: 'dead' } | { state: 'unborn' }> | null {
  const span = { birth: asDate(person.birth), death: asDate(person.death) };
  const atStart = lifeState(span, s.startYear);
  if (atStart.state === 'dead') return atStart;
  const atEnd = lifeState(span, s.endYear);
  if (atEnd.state === 'unborn') return atEnd;
  return null;
}

function chapterFindings(data: TimelineData, chapter: Doc): StructuralFinding[] {
  const out: StructuralFinding[] = [];
  const chapterId = str(chapter._id);
  const characters = new Map(
    data
      .all('characters')
      .filter(live)
      .map((c) => [str(c._id), c]),
  );
  const strands = strandsOf(chapter);
  const add = (
    check: StructuralCheck,
    s: StrandOf | undefined,
    entryIds: string[],
    title: string,
    explanation: string,
  ) =>
    out.push({
      key: findingKey(check, chapterId, s?.id ?? null, entryIds),
      check,
      chapterId,
      strandId: s?.id ?? null,
      storyYear: s?.startYear ?? null,
      entryIds,
      title,
      explanation,
    });

  for (const s of strands) {
    for (const cid of s.characterIds) {
      const person = characters.get(cid);
      if (!person) continue;
      const state = outsideLife(person, s);
      if (!state) continue;
      const name = characterName(person, cid);
      if (state.state === 'dead') {
        add(
          'character-present-while-dead',
          s,
          [cid],
          `${name} is present after their death`,
          `${setIn(chapter, s)} and lists ${name} (${cid}) as present. ${name} died in ${state.deathYear}.`,
        );
      } else {
        add(
          'character-present-while-unborn',
          s,
          [cid],
          `${name} is present before their birth`,
          `${setIn(chapter, s)} and lists ${name} (${cid}) as present. ${name} is born in ${state.birthYear}.`,
        );
      }
    }
    const pov = s.povCharacterId ? characters.get(s.povCharacterId) : undefined;
    if (pov && s.povCharacterId) {
      const state = outsideLife(pov, s);
      if (state) {
        const name = characterName(pov, s.povCharacterId);
        const life =
          state.state === 'dead' ? `died in ${state.deathYear}` : `is born in ${state.birthYear}`;
        add(
          'strand-year-outside-pov-lifetime',
          s,
          [s.povCharacterId],
          `${name} tells a strand outside their lifetime`,
          `${setIn(chapter, s)} with ${name} (${s.povCharacterId}) as the point of view. ${name} ${life}.`,
        );
      }
    }
  }

  // Facts in play and linked events belong to the chapter, so they use its story year.
  const primary = primaryOf(strands);
  if (!primary) return out;
  const year = primary.startYear;
  const records = data.all('knowledgeRecords').filter(live);
  const facts = Array.isArray(chapter.factsInPlay) ? chapter.factsInPlay.filter(isPlainObject) : [];
  for (const fip of facts) {
    const factId = str(fip.factId);
    const cid = str(fip.characterId);
    if (!factId || !cid) continue;
    const mine = records.filter(
      (r) => str(r.factId) === factId && str(r.characterId) === cid && num(r.yearLearned) !== null,
    );
    // The earliest record decides; no record with a year means the bible does not say.
    const first = mine.sort(
      (a, b) =>
        (num(a.yearLearned) as number) - (num(b.yearLearned) as number) ||
        str(a._id).localeCompare(str(b._id)),
    )[0];
    if (!first || (num(first.yearLearned) as number) <= year) continue;
    const name = characterName(characters.get(cid), cid);
    const recordId = str(first._id);
    add(
      'fact-acted-on-before-learned',
      primary,
      [cid, factId, recordId],
      `${name} acts on a fact before learning it`,
      `${setIn(chapter, primary)} and has ${name} (${cid}) acting on fact ${factId}. Knowledge record ${recordId} says ${name} learns it in ${num(first.yearLearned)}.`,
    );
  }

  const events = new Map(eventSpans(data).map((e) => [e.id, e]));
  const links = Array.isArray(chapter.links) ? chapter.links.filter(isPlainObject) : [];
  for (const l of links) {
    if (str(l.kind) !== 'happened') continue;
    const e = events.get(str(l.targetId));
    if (!e || e.startYear <= year) continue;
    add(
      'event-linked-as-happened-after-story-year',
      primary,
      [e.id],
      `${e.title} is linked before it happens`,
      `${setIn(chapter, primary)} and links event ${e.id} as having happened. ${e.id} is dated ${e.startYear}.`,
    );
  }
  return out;
}

/** The live chapters in reading order. */
export function chaptersInOrder(data: TimelineData): Doc[] {
  return data
    .all('chapters')
    .filter(live)
    .sort(
      (a, b) =>
        (num(a.readingOrder) ?? 0) - (num(b.readingOrder) ?? 0) ||
        str(a._id).localeCompare(str(b._id)),
    );
}

/**
 * CC-2: every structural finding for one chapter, or for the whole
 * manuscript (every chapter in reading order, then the FT-6 tree warnings,
 * which belong to no chapter).
 */
export function structuralFindings(
  data: TimelineData,
  scope: { chapterId: string | null } = { chapterId: null },
): StructuralFinding[] {
  const chapters = chaptersInOrder(data).filter(
    (c) => scope.chapterId === null || str(c._id) === scope.chapterId,
  );
  const out = chapters.flatMap((c) => chapterFindings(data, c));
  if (scope.chapterId !== null) return out;
  const g = buildGraph(data.all('characters'), data.all('unions'), data.all('parentLinks'));
  for (const w of treeWarnings(g)) {
    const entryIds = [...w.entryIds, ...w.personIds];
    out.push({
      key: findingKey('tree-warning', null, null, [w.code, ...entryIds]),
      check: 'tree-warning',
      chapterId: null,
      strandId: null,
      storyYear: null,
      entryIds,
      title: 'Family tree warning',
      explanation: w.message,
    });
  }
  return out;
}
