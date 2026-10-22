/**
 * Capture routing (A48, CR-1, CR-3): the index the router matches against,
 * built from the bible's lists and entries. The renderer and main build it
 * from the same documents, so they agree. Trashed entries are left out.
 */
import { LEXICON } from './lexicon';
import type { Lexicon } from './lexicon';
import { foldAlias, hasHan, withoutParenthetical } from './text';
import type {
  IndexedAgeGroup,
  IndexedCategory,
  IndexedCharacter,
  IndexedCommunity,
  IndexedLine,
  IndexedMoment,
  IndexedPlace,
  RouterIndex,
  RouterIndexInput,
} from './types';

type Doc = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const live = (docs: Doc[] | undefined): Doc[] =>
  (docs ?? []).filter((d) => !d.deletedAt && typeof d._id === 'string');

/** Folded, deduplicated aliases; a Latin alias needs two letters, a Chinese one two characters. */
function aliasesOf(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const a = foldAlias(r);
    if ([...a].length < 2 || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

/**
 * CR-3: the names a character answers to. The full name (and the name
 * without a parenthetical such as "(unnamed)"), the first name (the given
 * name of a surname-first Chinese name, so "Li Qin" gives "qin"), the
 * Chinese name and its given-name part, and the lexicon's aliases.
 */
export function characterAliases(
  full: string,
  chinese: string,
  extra: readonly string[],
  lexicon: Lexicon = LEXICON,
): string[] {
  const raw = [full];
  const plain = withoutParenthetical(full);
  raw.push(plain);
  const words = plain.split(' ').filter(Boolean);
  const simple = words.length >= 2 && words.length <= 3 && !plain.includes("'s ");
  if (simple) {
    const surnameFirst =
      !!chinese &&
      lexicon.chineseSurnames.includes(foldAlias(words[0] ?? '')) &&
      words.length === 2;
    const first = foldAlias((surnameFirst ? words[1] : words[0]) ?? '');
    if (first && !lexicon.stopWords.includes(first)) raw.push(first);
  }
  if (chinese) {
    raw.push(chinese);
    const chars = [...chinese];
    if (chars.length >= 3 && chars.every((c) => hasHan(c))) raw.push(chars.slice(1).join(''));
  }
  raw.push(...extra);
  return aliasesOf(raw);
}

/** CR-1: build the router's index once per capture. */
export function buildIndex(input: RouterIndexInput, lexicon: Lexicon = LEXICON): RouterIndex {
  const list = (id: string) => input.lists.find((l) => l._id === id)?.items ?? [];
  const e = input.entries;

  const characters: IndexedCharacter[] = live(e.characters).map((d) => {
    const names = (d.names ?? {}) as Doc;
    const name = str(names.full) || str(d.title);
    const id = d._id as string;
    return {
      id,
      name,
      aliases: characterAliases(name, str(names.chinese), lexicon.characters[id] ?? [], lexicon),
    };
  });

  const places: IndexedPlace[] = live(e.places).map((d) => {
    const name = str(d.title);
    const key = foldAlias(name);
    return {
      id: d._id as string,
      name,
      communityId: str(d.communityId) || null,
      aliases: aliasesOf([name, withoutParenthetical(name), ...(lexicon.places[key] ?? [])]),
      parentId: str(d.parentId) || null,
    };
  });

  const communities: IndexedCommunity[] = list('communities').map((i) => {
    const words = lexicon.communities[i.id];
    return {
      id: i.id,
      label: i.label,
      parentId: i.parentId ?? null,
      aliases: aliasesOf([i.label, withoutParenthetical(i.label), ...(words?.aliases ?? [])]),
      demonyms: aliasesOf(words?.demonyms ?? []),
    };
  });

  const categories: IndexedCategory[] = list('eventCategories').map((i) => ({
    id: i.id,
    label: i.label,
    parentId: i.parentId ?? null,
    cues: aliasesOf([i.label, ...(lexicon.categories[i.id] ?? [])]),
  }));

  const ageGroups: IndexedAgeGroup[] = list('ageGroups')
    .filter((i) => i.id !== 'all')
    .map((i) => ({
      id: i.id,
      label: i.label,
      words: aliasesOf([i.label, ...(lexicon.ageGroups[i.id] ?? [])]),
    }));

  const glossary = live(e.glossaryTerms).map((d) => ({
    id: d._id as string,
    characters: str(d.characters),
    romanization: str(d.romanization),
  }));

  const culturalLines: IndexedLine[] = live(e.culturalEntries).map((d) => ({
    id: d._id as string,
    communityId: str(d.communityId),
    startYear: num(d.startYear),
    endYear: num(d.endYear),
    title: str(d.title),
  }));

  const moments: IndexedMoment[] = live(e.moments).map((d) => ({
    id: d._id as string,
    characterId: str(d.characterId),
    year: num(d.year),
    title: str(d.title),
  }));

  const regions = list('regions').map((i) => ({ id: i.id, label: i.label }));

  return {
    characters,
    places,
    communities,
    categories,
    glossary,
    ageGroups,
    culturalLines,
    moments,
    timelineEnd: input.timelineEnd,
    regions,
  };
}
