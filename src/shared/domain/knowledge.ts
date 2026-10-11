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
 * KN-1: every character who learns a fact, earliest first, once each (the
 * earliest record counts). With a year, only those who have learned it by then.
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
    .sort(
      (a, b) =>
        byYear(a, b) ||
        a.name.localeCompare(b.name) ||
        (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    )
    .filter((k, i, all) => all.findIndex((o) => o.characterId === k.characterId) === i)
    .filter((k) => year === undefined || isKnownBy(k.yearLearned, year) === true);
}

export interface KnownFact {
  recordId: string;
  factId: string;
  fact: string;
  yearLearned: number;
  chapterLearnedId: string | null;
  how: string;
}

/**
 * A fact a character does not know in a year. `not-yet` when they learn it in
 * a later year (`yearLearned` is the earliest such year, the label names the
 * year asked about: "not yet in 2059"); `never` when no
 * record says they learn it. A record with no year cannot be placed, so it
 * never counts as known and is listed as `never`.
 */
export interface UnknownFact {
  factId: string;
  fact: string;
  reason: 'not-yet' | 'never';
  yearLearned: number | null;
  /** "not yet in 2059" (the year asked about) or "never". */
  label: string;
}

export interface Knowledge {
  known: KnownFact[];
  unknown: UnknownFact[];
}

/**
 * KN-1: for a character and a year, the facts they know (from when) and every
 * other fact in the bible as one they do not know: "not yet in Y" (Y is the year
 * asked about) when a later
 * record exists, "never" otherwise. Known facts come earliest first; unknown
 * facts list the "not yet" ones first, by year, then the rest by title.
 */
export function knownBy(data: TimelineData, characterId: string, year: number): Knowledge {
  const facts = data.all('facts').filter(live);
  const known: KnownFact[] = [];
  const later = new Map<string, number>();
  const knownIds = new Set<string>();
  const byFact = new Map(facts.map((f) => [str(f._id), f]));
  // SB-3: records in ID order, so of two records with the same year the lower ID counts, whatever the stored order.
  const records = data
    .all('knowledgeRecords')
    .filter(live)
    .sort((a, b) => (str(a._id) < str(b._id) ? -1 : str(a._id) > str(b._id) ? 1 : 0));
  for (const k of records) {
    if (k.characterId !== characterId) continue;
    const fact = byFact.get(str(k.factId));
    if (!fact) continue;
    const learned = num(k.yearLearned);
    if (learned === null) continue;
    if (learned <= year) {
      knownIds.add(str(k.factId));
      // Two records of one character learning one fact count once, the earliest.
      const seen = known.findIndex((x) => x.factId === str(k.factId));
      if (seen >= 0 && (known[seen]?.yearLearned ?? Infinity) <= learned) continue;
      if (seen >= 0) known.splice(seen, 1);
      known.push({
        recordId: str(k._id),
        factId: str(k.factId),
        fact: title(fact, str(k.factId)),
        yearLearned: learned,
        chapterLearnedId: str(k.chapterLearnedId) || null,
        how: str(k.how),
      });
    } else {
      const prev = later.get(str(k.factId));
      if (prev === undefined || learned < prev) later.set(str(k.factId), learned);
    }
  }
  const unknown: UnknownFact[] = facts
    .filter((f) => !knownIds.has(str(f._id)))
    .map((f) => {
      const y = later.get(str(f._id));
      const fact = title(f, str(f._id));
      return y === undefined
        ? { factId: str(f._id), fact, reason: 'never' as const, yearLearned: null, label: 'never' }
        : {
            factId: str(f._id),
            fact,
            reason: 'not-yet' as const,
            yearLearned: y,
            label: `not yet in ${year}`,
          };
    })
    .sort(
      (a, b) =>
        (a.yearLearned ?? Infinity) - (b.yearLearned ?? Infinity) || a.fact.localeCompare(b.fact),
    );
  return { known: known.sort(byYear), unknown };
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
