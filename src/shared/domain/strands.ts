/**
 * Moving one chapter strand to a new story year (TM-5). The preview the
 * Story Time dialog shows and the write the repository makes both come from
 * this one function, so what is shown is exactly what is written. A range
 * keeps its length; a single year stays a single year.
 */
import { isPlainObject } from './paths';

export interface StrandYears {
  startYear: number;
  endYear: number | null;
}

export interface StrandShift<S> {
  strand: S & { id: string; label: string } & StrandYears;
  from: StrandYears;
  to: StrandYears;
  /** Every strand of the chapter, with the one strand moved. */
  next: S[];
  unchanged: boolean;
}

type StrandLike = { id: string; label: string; startYear: number; endYear: number | null };

function isStrand(v: unknown): v is StrandLike {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.startYear === 'number' &&
    (v.endYear === null || v.endYear === undefined || typeof v.endYear === 'number')
  );
}

/** Move one strand to start in `year`. Null when the chapter has no such strand. */
export function shiftStrand<S extends object>(
  strands: readonly S[],
  strandId: string,
  year: number,
): StrandShift<S> | null {
  const strand = strands.find((s) => isStrand(s) && s.id === strandId) as
    (S & StrandLike) | undefined;
  if (!strand) return null;
  const end = strand.endYear ?? null;
  const shift = year - strand.startYear;
  const to: StrandYears = { startYear: year, endYear: end === null ? null : end + shift };
  const next = strands.map((s) =>
    s === strand ? ({ ...s, startYear: to.startYear, endYear: to.endYear } as S) : s,
  );
  return {
    strand: { ...strand, label: String(strand.label ?? ''), endYear: end },
    from: { startYear: strand.startYear, endYear: end },
    to,
    next,
    unchanged: shift === 0,
  };
}

// ---------- a47-desk: the writing strand edited on Relevant to Session (IP-2) ----------

/** A strand as stored on a chapter: at least an ID; the rest is the schema's. */
export type StrandDoc = Record<string, unknown> & { id: string };

/** The strands of a chapter as an array of stored strands, whatever the entry holds. */
export function strandsOf(chapter: Record<string, unknown> | null | undefined): StrandDoc[] {
  const list = chapter?.strands;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is StrandDoc => isPlainObject(s) && typeof s.id === 'string');
}

/** One strand of a chapter by ID, or undefined. */
export function strandById(strands: readonly StrandDoc[], strandId: string): StrandDoc | undefined {
  return strands.find((s) => s.id === strandId);
}

/** The characters present on a strand, as stored. */
export function strandCharacters(strand: StrandDoc | undefined): string[] {
  const ids = strand?.characterIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

function change(
  strands: readonly StrandDoc[],
  strandId: string,
  edit: (s: StrandDoc) => StrandDoc,
): StrandDoc[] | null {
  if (!strandById(strands, strandId)) return null;
  return strands.map((s) => (s.id === strandId ? edit(s) : s));
}

/**
 * IP-2: the strand's story year. A range keeps its length, as the Story time
 * dialog moves it (TM-5). Null when the chapter has no such strand.
 */
export function setStrandYear(
  strands: readonly StrandDoc[],
  strandId: string,
  year: number,
): StrandDoc[] | null {
  return shiftStrand(strands, strandId, year)?.next ?? null;
}

/** IP-2: the strand's point of view character, or none. */
export function setStrandPov(
  strands: readonly StrandDoc[],
  strandId: string,
  characterId: string | null,
): StrandDoc[] | null {
  return change(strands, strandId, (s) => ({ ...s, povCharacterId: characterId }));
}

/** IP-2: the characters present on the strand, in the order given, each once. */
export function setStrandCharacters(
  strands: readonly StrandDoc[],
  strandId: string,
  characterIds: readonly string[],
): StrandDoc[] | null {
  return change(strands, strandId, (s) => ({ ...s, characterIds: [...new Set(characterIds)] }));
}

/** IP-2: add one character to the strand; adding one already there changes nothing. */
export function addStrandCharacter(
  strands: readonly StrandDoc[],
  strandId: string,
  characterId: string,
): StrandDoc[] | null {
  const s = strandById(strands, strandId);
  if (!s) return null;
  return setStrandCharacters(strands, strandId, [...strandCharacters(s), characterId]);
}

/** IP-2: take one character off the strand. */
export function removeStrandCharacter(
  strands: readonly StrandDoc[],
  strandId: string,
  characterId: string,
): StrandDoc[] | null {
  const s = strandById(strands, strandId);
  if (!s) return null;
  return setStrandCharacters(
    strands,
    strandId,
    strandCharacters(s).filter((c) => c !== characterId),
  );
}

/** Who a change of the characters present adds and takes away. */
export function charactersChange(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  };
}

/**
 * The undo label for a change of the characters present (IP-2): "Added Iris
 * to The Letter", "Removed Iris from The Letter", or "Changed who is in The
 * Letter" when several change at once.
 */
export function charactersChangeLabel(
  before: readonly string[],
  after: readonly string[],
  nameOf: (id: string) => string,
  chapterTitle: string,
): string {
  const { added, removed } = charactersChange(before, after);
  const [one] = added;
  const [gone] = removed;
  if (added.length === 1 && removed.length === 0 && one !== undefined) {
    return `Added ${nameOf(one)} to ${chapterTitle}`;
  }
  if (removed.length === 1 && added.length === 0 && gone !== undefined) {
    return `Removed ${nameOf(gone)} from ${chapterTitle}`;
  }
  return `Changed who is in ${chapterTitle}`;
}

/** A chapter strand as a screen reads it (IP-2, IP-3): every field typed, defaults filled. */
export interface StrandView {
  id: string;
  label: string;
  startYear: number | null;
  endYear: number | null;
  primary: boolean;
  povCharacterId: string | null;
  characterIds: string[];
  placeIds: string[];
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** One stored strand as a `StrandView`. */
export function strandView(s: StrandDoc): StrandView {
  return {
    id: s.id,
    label: typeof s.label === 'string' ? s.label : '',
    startYear: typeof s.startYear === 'number' ? s.startYear : null,
    endYear: typeof s.endYear === 'number' ? s.endYear : null,
    primary: s.primary === true,
    povCharacterId: typeof s.povCharacterId === 'string' ? s.povCharacterId : null,
    characterIds: ids(s.characterIds),
    placeIds: ids(s.placeIds),
  };
}

/** The strands of a chapter as `StrandView`s, in stored order. */
export function readStrands(chapter: Record<string, unknown> | null | undefined): StrandView[] {
  return strandsOf(chapter).map(strandView);
}

/** One strand of a chapter by ID as a `StrandView`, or undefined. */
export function findStrand(
  chapter: Record<string, unknown> | null | undefined,
  strandId: string,
): StrandView | undefined {
  const s = strandById(strandsOf(chapter), strandId);
  return s ? strandView(s) : undefined;
}

/** IP-3: the strand's label ("present", "backstory"). */
export function setStrandLabel(
  strands: readonly StrandDoc[],
  strandId: string,
  label: string,
): StrandDoc[] | null {
  return change(strands, strandId, (s) => ({ ...s, label }));
}

/** IP-3: the strand's places, in the order given, each once. */
export function setStrandPlaces(
  strands: readonly StrandDoc[],
  strandId: string,
  placeIds: readonly string[],
): StrandDoc[] | null {
  return change(strands, strandId, (s) => ({ ...s, placeIds: [...new Set(placeIds)] }));
}
