/**
 * Who knows what (KN-1 to KN-3). Pure queries over knowledge records: a record
 * says a character learned a fact in a year. A record with no year is kept in
 * the lists but never counts as known by a given year, because nobody can say
 * when it happened.
 */
import { characterName } from './timeline';
import type { TimelineData } from './timeline';
import type { Doc } from './paths';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc) => !d.deletedAt;
const title = (d: Doc | undefined, fallback: string) => str(d?.title).trim() || fallback;

/** True or false when both years are known, else null. A character knows a fact from the year learned onward. */
export function isKnownBy(yearLearned: number | null, year: number | null): boolean | null {
  return yearLearned === null || year === null ? null : yearLearned <= year;
}

export interface Knower {
  recordId: string;
  characterId: string;
  name: string;
  yearLearned: number | null;
  chapterLearnedId: string | null;
  how: string;
}

const byYear = (a: { yearLearned: number | null }, b: { yearLearned: number | null }) =>
  (a.yearLearned ?? Infinity) - (b.yearLearned ?? Infinity);

/**
 * KN-1: every character who learns a fact, earliest first. With a year, only
 * those who have learned it by then.
 */
export function whoKnows(data: TimelineData, factId: string, year?: number): Knower[] {
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));
  return data
    .all('knowledgeRecords')
    .filter(live)
    .filter((k) => k.factId === factId)
    .filter((k) => {
      const c = characters.get(str(k.characterId));
      return c !== undefined && live(c);
    })
    .map((k) => ({
      recordId: str(k._id),
      characterId: str(k.characterId),
      name: characterName(characters.get(str(k.characterId)), str(k.characterId)),
      yearLearned: num(k.yearLearned),
      chapterLearnedId: str(k.chapterLearnedId) || null,
      how: str(k.how),
    }))
    .filter((k) => year === undefined || isKnownBy(k.yearLearned, year) === true)
    .sort((a, b) => byYear(a, b) || a.name.localeCompare(b.name));
}

export interface KnownFact {
  recordId: string;
  factId: string;
  fact: string;
  yearLearned: number;
  chapterLearnedId: string | null;
  how: string;
}

/** KN-1: the facts a character has learned by a year, earliest first. */
export function knownBy(data: TimelineData, characterId: string, year: number): KnownFact[] {
  const facts = new Map(data.all('facts').map((f) => [str(f._id), f]));
  const out: KnownFact[] = [];
  for (const k of data.all('knowledgeRecords').filter(live)) {
    if (k.characterId !== characterId) continue;
    const learned = num(k.yearLearned);
    if (learned === null || learned > year) continue;
    const fact = facts.get(str(k.factId));
    if (!fact || !live(fact)) continue;
    out.push({
      recordId: str(k._id),
      factId: str(k.factId),
      fact: title(fact, str(k.factId)),
      yearLearned: learned,
      chapterLearnedId: str(k.chapterLearnedId) || null,
      how: str(k.how),
    });
  }
  return out.sort(byYear);
}

export interface FactPage {
  id: string;
  title: string;
  body: string;
  /** Everyone who learns it, earliest first. */
  knowers: (Knower & { chapter: string | null })[];
  /** Chapters where a character acts on it (KN-3). */
  inPlay: {
    chapterId: string;
    chapter: string;
    characterId: string;
    character: string;
    note: string;
  }[];
}

/** KN-1, KN-3: a fact with who learns it, when, and the chapters that act on it. */
export function factPage(data: TimelineData, id: string): FactPage | null {
  const fact = data.all('facts').find((f) => str(f._id) === id);
  if (!fact) return null;
  const chapters = data.all('chapters').filter(live);
  const chapterById = new Map(chapters.map((c) => [str(c._id), c]));
  const characters = new Map(data.all('characters').map((c) => [str(c._id), c]));
  const inPlay = chapters
    .sort((a, b) => (num(a.readingOrder) ?? 0) - (num(b.readingOrder) ?? 0))
    .flatMap((c) =>
      (Array.isArray(c.factsInPlay) ? c.factsInPlay : [])
        .filter((f): f is Doc => typeof f === 'object' && f !== null)
        .filter((f) => f.factId === id)
        .map((f) => ({
          chapterId: str(c._id),
          chapter: title(c, str(c._id)),
          characterId: str(f.characterId),
          character: characterName(characters.get(str(f.characterId)), str(f.characterId)),
          note: str(f.note),
        })),
    );
  return {
    id,
    title: title(fact, id),
    body: str(fact.body),
    knowers: whoKnows(data, id).map((k) => ({
      ...k,
      chapter: k.chapterLearnedId
        ? title(chapterById.get(k.chapterLearnedId), k.chapterLearnedId)
        : null,
    })),
    inPlay,
  };
}
