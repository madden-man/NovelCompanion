/**
 * A55 (NB-2): the pocket, what the phone needs to wear a bible as a world,
 * built from the bible's live entries. Pure (ARCHITECTURE rule 1): main
 * hashes it into the stamp and writes it to `bridge_down`. The shape is
 * FlowState's `NovelPocket`, and every list is in a fixed order, so the same
 * bible always gives the same pocket and the stamp moves only when what the
 * phone would see moves.
 */
import type { NovelPocket, PocketCharacter, PocketQuestion } from '../bridge';
import { LEXICON } from './captureRouter/lexicon';
import { foldAlias, withoutParenthetical } from './captureRouter/text';
import { yearOf } from './dates';
import { plainText } from './markdown';
import { chapterYear } from './position';
import { chapterNumbers } from './numbering';
import type { StoryDate } from '../schema';

type Doc = Record<string, unknown> & { _id: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const live = (docs: readonly Doc[]) => docs.filter((d) => !d.deletedAt);
const HEX = /^#?[0-9a-f]{6}$/i;

/**
 * The name a character is called by: the first word of the full name, or the
 * second when the name is written family name first (a Chinese name, as the
 * Capture Router reads it in `characterAliases`); the whole name when that
 * word is an ordinary word such as "The".
 */
export function firstNameOf(full: string, chinese: string): string {
  const words = withoutParenthetical(full).split(' ').filter(Boolean);
  if (words.length < 2) return words[0] ?? full;
  const surnameFirst =
    !!chinese && words.length === 2 && LEXICON.chineseSurnames.includes(foldAlias(words[0] ?? ''));
  const first = (surnameFirst ? words[1] : words[0]) ?? full;
  // "The Archivist" is called by the whole name, as the router reads it.
  return LEXICON.stopWords.includes(foldAlias(first)) ? full : first;
}

export interface PocketInput {
  characters: readonly Doc[];
  families: readonly Doc[];
  places: readonly Doc[];
  chapters: readonly Doc[];
  worldEvents: readonly Doc[];
  openQuestions: readonly Doc[];
  /** The `communities` list's items, for a place's community by name. */
  communities: readonly { id: string; label: string }[];
  storyYear: number | null;
  span: { from: number; to: number } | null;
  /**
   * Plan question 6: every open question, and any decided after this time
   * (milliseconds), when the bible was first given to the phone.
   */
  decidedSince: number;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** NB-2: the pocket for a novel. */
export function buildPocket(input: PocketInput): NovelPocket {
  const colourOf = new Map<string, string>();
  for (const f of live(input.families)) {
    const c = str(f.color);
    if (HEX.test(c)) colourOf.set(f._id, c.startsWith('#') ? c : `#${c}`);
  }
  const characters: PocketCharacter[] = live(input.characters)
    .map((c) => {
      const names = (c.names ?? {}) as Record<string, unknown>;
      const fullName = str(names.full).trim() || str(c.title).trim() || c._id;
      const chineseName = str(names.chinese).trim();
      const families = Array.isArray(c.familyIds) ? (c.familyIds as unknown[]) : [];
      // NB-2: the first family's colour; none when the first family has none.
      const familyColour = families.length ? colourOf.get(String(families[0])) : undefined;
      const born = yearOf(c.birth as StoryDate | null);
      const died = yearOf(c.death as StoryDate | null);
      const out: PocketCharacter = {
        id: c._id,
        fullName,
        firstName: firstNameOf(fullName, chineseName),
      };
      if (chineseName) out.chineseName = chineseName;
      if (familyColour) out.familyColour = familyColour;
      if (born !== null) out.born = born;
      if (died !== null) out.died = died;
      return out;
    })
    .sort((a, b) => byText(a.fullName, b.fullName) || byText(a.id, b.id));

  const community = new Map(input.communities.map((i) => [i.id, i.label]));
  const places = live(input.places)
    .map((p) => {
      const out: NovelPocket['places'][number] = { id: p._id, name: str(p.title) || p._id };
      const c = community.get(str(p.communityId));
      if (c) out.community = c;
      return out;
    })
    .sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));

  const numbers = chapterNumbers(input.chapters);
  const chapters = live(input.chapters)
    .sort(
      (a, b) =>
        (numbers.get(a._id) ?? Infinity) - (numbers.get(b._id) ?? Infinity) || byText(a._id, b._id),
    )
    .map((c) => {
      const out: NovelPocket['chapters'][number] = { id: c._id, title: str(c.title) || c._id };
      const y = chapterYear(c);
      if (y !== null) out.year = y;
      return out;
    });

  const events = live(input.worldEvents)
    .flatMap((e) => {
      const y = yearOf(e.start as StoryDate | null);
      return y === null ? [] : [{ id: e._id, title: str(e.title) || e._id, year: y }];
    })
    .sort((a, b) => a.year - b.year || byText(a.title, b.title) || byText(a.id, b.id));

  const questions: PocketQuestion[] = live(input.openQuestions)
    .flatMap((q) => {
      const decided = q.state === 'decided';
      const changedAt = Date.parse(str(q.modifiedAt)) || 0;
      if (decided && changedAt < input.decidedSince) return [];
      const text = plainText(q.question).trim() || str(q.title).trim();
      if (!text) return [];
      const out: PocketQuestion = {
        id: q._id,
        question: text,
        state: decided ? 'decided' : 'open',
        changedAt,
      };
      const decision = plainText(q.decision).trim();
      if (decision) out.decision = decision;
      return [out];
    })
    .sort((a, b) => byText(a.id, b.id));

  const pocket: NovelPocket = { kind: 'novel', characters, places, chapters, events, questions };
  if (input.storyYear !== null) pocket.storyYear = input.storyYear;
  if (input.span) pocket.span = input.span;
  return pocket;
}

/** The pocket as one text, keys in a fixed order, for its stamp. */
export function pocketText(pocket: NovelPocket): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(pocket));
}
