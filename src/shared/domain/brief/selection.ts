/**
 * Session selection (SB-1 to SB-3, SB-5, SB-6, SB-9, SM-3). The one
 * deterministic query that decides which entries a session is about. The
 * "Relevant to Session" view and the alignment check's material (CC-3) both
 * come from `selectForSession`, so they can never disagree.
 *
 * SB-2 steps 1 to 6 run once per strand, the primary strand first (A5); steps
 * 7 and 9 run once for the section. Every list is sorted on explicit keys so
 * the same inputs and data give the same manifest every time (SB-3). Nothing
 * here calls a model or reads the clock.
 *
 * Readings this module chose where SPEC left room (reported to the architect):
 * - A strand's setting is its places; with none, the place the point of view
 *   (else the first character present) lived in that year, read from their
 *   "Lives in" moments and matched to a place by name (A35, SM-3). A "Lives in"
 *   moment with no end year runs on until a later one. The setting feeds
 *   steps 4 and 5.
 * - SM-3: step 1 also takes the moments of the characters present up to the
 *   story year, as their backstory. A character's voice is their latest
 *   moment titled "Voice" at or before the story year: how they speak at that
 *   age. Facts and knowledge (step 6), beats and arcs (steps 7 and 8), themes
 *   (step 9), and custom sections (CS-3) went with A39.
 * - The setting's communities are every `communityId` from the place out to
 *   the outermost place, nearest first, then each one's parent in the
 *   communities list (A35, step 4).
 * - "Partners" in the step 1 fallback are partners in a union that has begun
 *   by the story year and not ended before it; everyone in the fallback is
 *   alive in the story year.
 * - The events of the year after the story year go under "Planned ahead"
 *   (SB-5) (A33: the window looks one year ahead, and SB-5 keeps anything
 *   after the story year under that heading). World events have no places
 *   since A39, so step 3 no longer takes events linked to the setting.
 * - Step 9 lists still-open questions and decided questions (A24) apart.
 * - With a year and point of view but no chapter, step 7 is the chapter with
 *   that point of view whose strand year is latest at or before the story
 *   year.
 * - SB-6 does not rank planned-ahead items; they drop first. Moments drop
 *   where beats did. The DB-2 lead sections never drop (A25). Entries you add
 *   (SB-9) never drop.
 * - An entry is reported as left out only once it leaves the manifest.
 */
import { groupLabel } from '../numbering';
import type { LifeState } from '../ages';
import { describeState } from '../ages';
import { descriptionFor, entriesFor, placeForText, placePath } from '../culture';
import { yearOf } from '../dates';
import { plainText } from '../markdown';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { characterName, eraFor, eventSpans, eventsAhead, eventsUpTo, stateIn } from '../timeline';
import type { EventSpan, TimelineData } from '../timeline';
import { ENTRY_COLLECTIONS } from '../../schema';
import { LIVES_IN_PREFIX, VOICE_MOMENT_TITLE } from '../../schema/moment';

// ---------- inputs and settings ----------

/** SB-1 and DB-2: what a session is about. */
export type BriefInput =
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'strand'; chapterId: string; strandId: string }
  | { kind: 'part'; partId: string }
  | {
      kind: 'pov';
      year: number;
      povCharacterId: string;
      placeIds?: string[];
      characterIds?: string[];
    };

export interface SelectionSettings {
  /** SB-2 step 3 (A33): years before the story year that world events are taken from. */
  window: number;
  /** SB-6: the most characters of selected text a brief takes. */
  budget: number;
  /** A47 (IP-11): years after the story year the window looks ahead; WINDOW_AHEAD when not given. */
  ahead?: number;
}

export const DEFAULT_SELECTION_SETTINGS: SelectionSettings = { window: 3, budget: 40_000 };

/**
 * A33: the window also looks this many years past the story year, so a five
 * year window around 2051 runs from 2048 to 2052. Those later events sit under
 * "Planned ahead" (SB-5), never among the events in the window.
 */
export const WINDOW_AHEAD = 1;

/** SB-9: entries the person added to, or removed from, the selection. */
export interface SelectionOverrides {
  add?: readonly string[];
  remove?: readonly string[];
}

// ---------- output ----------

export type GroupKind =
  | 'characters'
  | 'moments'
  | 'era'
  | 'eventsWindow'
  | 'eventsFormative'
  | 'culture'
  | 'places'
  | 'plannedAhead'
  | 'previousChapters'
  | 'glossary'
  | 'openQuestions'
  | 'decidedQuestions'
  | 'added';

export const GROUP_TITLES: Record<GroupKind, string> = {
  characters: 'Characters present',
  moments: 'Backstory',
  era: 'Era state',
  eventsWindow: 'World events in the window',
  eventsFormative: 'Formative events in a lifetime',
  culture: 'Cultural expectations',
  places: 'Place descriptions',
  plannedAhead: 'Planned ahead',
  previousChapters: 'Previous chapters',
  glossary: 'Glossary terms',
  openQuestions: 'Open questions',
  decidedQuestions: 'Decided',
  added: 'Added by you',
};

/** The SB-2 step each group answers. Planned ahead is part of step 3; added entries are SB-9. */
export const GROUP_STEP: Record<GroupKind, number> = {
  characters: 1,
  moments: 1,
  era: 2,
  eventsWindow: 3,
  eventsFormative: 3,
  plannedAhead: 3,
  culture: 4,
  places: 5,
  previousChapters: 7,
  glossary: 9,
  openQuestions: 9,
  decidedQuestions: 9,
  added: 0,
};

const STRAND_KINDS: GroupKind[] = [
  'characters',
  'moments',
  'era',
  'eventsWindow',
  'eventsFormative',
  'culture',
  'places',
  'plannedAhead',
];

/**
 * DB-2 lead sections (A25): characters present with ages, world events
 * ongoing (in the window and formative), and cultural expectations. SB-6
 * never drops them; when they alone exceed the budget the brief says so.
 */
export const LEAD_KINDS: GroupKind[] = ['characters', 'eventsWindow', 'eventsFormative', 'culture'];

/**
 * SB-6: the order items are dropped in when the selection is over budget,
 * lowest priority first. Added entries and the lead sections are never dropped.
 */
export const DROP_ORDER: GroupKind[] = [
  'plannedAhead',
  'decidedQuestions',
  'openQuestions',
  'glossary',
  'places',
  'previousChapters',
  'moments',
  'era',
];

export interface SelectedItem {
  id: string;
  collection: string;
  title: string;
  /** Why it was selected, or the computed fact about it (an age, a year). */
  note: string;
  /** The entry's text as the brief shows it; its length is what SB-6 counts. */
  detail: string;
  /** Other entries this item draws on, such as a character's voice moment. They are in the manifest too. */
  refs: string[];
  /** For characters: the state in the strand's year (TL-2). */
  state?: LifeState;
  /** For events and moments: the year it starts. */
  year?: number | null;
  /** For events: the year it ends (the start year for a single date). */
  endYear?: number;
  /** For cultural entries: the community it was selected for (A35). */
  community?: string;
}

/** A35: where a strand is set, which step 4 and step 5 read. */
export interface StrandSetting {
  placeIds: string[];
  /** strand: the strand's own places; livesIn: where a character lived that year (SM-3); none. */
  source: 'strand' | 'livesIn' | 'none';
  /** For livesIn, whose moment it came from. */
  characterId: string | null;
  /** "from Mark Sullivan's Lives in San Francisco, 2055 to 2060", or empty. */
  note: string;
}

/** SM-3: one moment of a character's backstory, as Relevant to Session lists it. */
export interface BackstoryRow {
  id: string;
  year: number;
  endYear: number | null;
  /** What happens. */
  title: string;
  /** How they experience it, plain. */
  body: string;
  worldContext: string;
}

/** A35, SM-3: the moments of the chapter's backstory years, for Relevant to Session. Not in the manifest. */
export interface StrandBackstory {
  from: number;
  to: number;
  /** "High school", from the backstory strand's label, or "The three years before". */
  label: string;
  people: {
    characterId: string;
    name: string;
    /** "ages 14 to 17", "age 14", or "age unknown". */
    ages: string;
    rows: BackstoryRow[];
  }[];
}

export interface SelectionGroup {
  kind: GroupKind;
  step: number;
  title: string;
  items: SelectedItem[];
}

export interface StrandSelection {
  chapterId: string | null;
  strandId: string | null;
  label: string;
  primary: boolean;
  year: number;
  povCharacterId: string | null;
  povName: string | null;
  placeIds: string[];
  /** The last year of the strand, when it spans years (A35). */
  endYear: number | null;
  /** Where the strand is set (A35). */
  setting: StrandSetting;
  /** The communities of the setting, nearest first (step 4, A35). */
  communities: { id: string; label: string }[];
  /** A35, SM-3: the moments of the chapter's backstory years. */
  backstory: StrandBackstory;
  groups: SelectionGroup[];
}

export interface OmittedItem {
  id: string;
  title: string;
  kind: GroupKind;
  reason: 'budget' | 'removed';
}

export interface Selection {
  input: BriefInput;
  label: string;
  /** The section's story year: the primary strand's, or the year asked for. */
  year: number;
  /** The chapters the section covers, in reading order. */
  chapterIds: string[];
  strands: StrandSelection[];
  /** Steps 7 and 9, and SB-9 additions. */
  shared: SelectionGroup[];
  /** What SB-6 or the person left out. The brief says so. */
  omitted: OmittedItem[];
  /** Strands left out because they have no start year (the brief says so). */
  skippedStrands: string[];
  added: string[];
  removed: string[];
  window: number;
  /** A47 (IP-11): years the window looks past the story year. */
  ahead: number;
  budget: number;
  /** Characters of selected text after any drops (SB-6). */
  size: number;
  /** Characters of the lead sections alone (A25), without entries you added. */
  leadSize: number;
  /** A25: true when the lead sections alone are over the budget, so the brief is too. */
  overBudget: boolean;
  /** The manifest (SB-3): every selected entry ID, sorted. */
  ids: string[];
}

// ---------- small helpers ----------

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc | undefined): d is Doc => !!d && !d.deletedAt;
const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Plain text of a stored long text, for the selection and its budget: Markdown since
 * A44, and the HTML stored before it reads the same way.
 */
export function plain(text: unknown): string {
  return plainText(text);
}

const joinText = (...parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');

function title(d: Doc | undefined, fallback = 'Untitled'): string {
  const t = str(d?.title).trim() || str(d?.name).trim();
  return t || fallback;
}

function rangeText(start: number | null, end: number | null): string {
  if (start === null && end === null) return 'any year';
  if (start === null) return `until ${end}`;
  if (end === null) return `from ${start}`;
  return start === end ? String(start) : `${start} to ${end}`;
}

function eventDates(e: EventSpan): string {
  return e.startYear === e.endYear ? String(e.startYear) : `${e.startYear} to ${e.endYear}`;
}

function index(data: TimelineData, collection: string): Map<string, Doc> {
  return new Map(data.all(collection).map((d) => [str(d._id), d]));
}

/** A53: what an open question is about (`aboutIds`). */
function aboutOf(d: Doc | undefined): string[] {
  return (Array.isArray(d?.aboutIds) ? d.aboutIds : []).map(str).filter(Boolean);
}

interface StrandSpec {
  chapter: Doc | null;
  strandId: string | null;
  label: string;
  primary: boolean;
  year: number;
  endYear: number | null;
  /** The strand's own label, such as "Backstory: High School". */
  strandLabel: string;
  pov: string | null;
  characterIds: string[];
  placeIds: string[];
}

interface Section {
  label: string;
  year: number;
  chapters: Doc[];
  strands: StrandSpec[];
  /** Strands skipped because they have no start year. */
  skipped: string[];
}

function strandsOf(chapter: Doc): Doc[] {
  const list = (Array.isArray(chapter.strands) ? chapter.strands : []).filter(isPlainObject);
  // Primary first, then the order they are stored in (A5).
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.primary === true) - Number(a.s.primary === true) || a.i - b.i)
    .map((x) => x.s);
}

function chapterLabel(c: Doc): string {
  return `Chapter ${num(c.readingOrder) ?? '?'}: ${title(c, 'Untitled chapter')}`;
}

function strandSpec(chapter: Doc, s: Doc, prefix = true): StrandSpec {
  const year = num(s.startYear) ?? 0;
  const label = `${str(s.label) || 'strand'}, ${year}`;
  return {
    chapter,
    strandId: str(s.id) || null,
    label: prefix ? `${chapterLabel(chapter)}, ${label}` : label,
    primary: s.primary === true,
    year,
    endYear: num(s.endYear),
    strandLabel: str(s.label),
    pov: str(s.povCharacterId) || null,
    characterIds: [...new Set(idList(s.characterIds))],
    placeIds: [...new Set(idList(s.placeIds))],
  };
}

function resolveSection(data: TimelineData, input: BriefInput): Section {
  const chapters = index(data, 'chapters');
  const characters = index(data, 'characters');
  if (input.kind === 'chapter' || input.kind === 'strand') {
    const ch = chapters.get(input.chapterId);
    if (!live(ch)) throw new Error('That chapter is not in the bible.');
    let strands = strandsOf(ch);
    if (input.kind === 'strand') {
      strands = strands.filter((s) => s.id === input.strandId);
      if (!strands.length) throw new Error('That strand is not in the chapter.');
    }
    const skipped = strands
      .filter((s) => num(s.startYear) === null)
      .map((s) => str(s.label) || 'strand');
    const specs = strands
      .filter((s) => num(s.startYear) !== null)
      .map((s) => strandSpec(ch, s, false));
    const first = specs[0];
    const label =
      input.kind === 'strand' && first ? `${chapterLabel(ch)}, ${first.label}` : chapterLabel(ch);
    return { label, year: first?.year ?? 0, chapters: [ch], strands: specs, skipped };
  }
  if (input.kind === 'part') {
    const part = data.all('parts').find((p) => p._id === input.partId);
    if (!live(part)) throw new Error('That part is not in the bible.');
    const list = [...chapters.values()]
      .filter((c) => live(c) && c.partId === input.partId)
      .sort(
        (a, b) =>
          (num(a.readingOrder) ?? 0) - (num(b.readingOrder) ?? 0) || byText(str(a._id), str(b._id)),
      );
    const dated = (s: Doc) => num(s.startYear) !== null;
    const skipped = list.flatMap((c) =>
      strandsOf(c)
        .filter((s) => !dated(s))
        .map((s) => `${chapterLabel(c)}, ${str(s.label) || 'strand'}`),
    );
    const specs = list.flatMap((c) =>
      strandsOf(c)
        .filter(dated)
        .map((s) => strandSpec(c, s)),
    );
    return {
      skipped,
      label: groupLabel('part', part.number, title(part, 'Untitled part')),
      year: specs[0]?.year ?? 0,
      chapters: list,
      strands: specs,
    };
  }
  const pov = characters.get(input.povCharacterId);
  if (!live(pov)) throw new Error('That point of view character is not in the bible.');
  const name = characterName(pov, input.povCharacterId);
  return {
    label: `${input.year}, point of view ${name}`,
    year: input.year,
    chapters: [],
    skipped: [],
    strands: [
      {
        chapter: null,
        strandId: null,
        label: `${input.year}, point of view ${name}`,
        primary: true,
        year: input.year,
        endYear: null,
        strandLabel: '',
        pov: input.povCharacterId,
        characterIds: [...new Set(input.characterIds ?? [])],
        placeIds: [...new Set(input.placeIds ?? [])],
      },
    ],
  };
}

// ---------- step 1: characters ----------

function birthYear(c: Doc | undefined): number | null {
  return yearOf(isPlainObject(c?.birth) ? (c.birth as never) : null);
}
function deathYear(c: Doc | undefined): number | null {
  return yearOf(isPlainObject(c?.death) ? (c.death as never) : null);
}

function sortPeople(ids: string[], characters: Map<string, Doc>): string[] {
  return [...ids].sort(
    (a, b) =>
      (birthYear(characters.get(a)) ?? Infinity) - (birthYear(characters.get(b)) ?? Infinity) ||
      byText(characterName(characters.get(a), a), characterName(characters.get(b), b)) ||
      byText(a, b),
  );
}

/** Step 1 fallback: the point of view and their living parents, partners, children, and siblings. */
function family(data: TimelineData, pov: string, year: number): string[] {
  const characters = index(data, 'characters');
  // A parent link counts from its start year; one with no start year always counts.
  const links = data
    .all('parentLinks')
    .filter(live)
    .filter((l) => {
      const s = num(l.startYear);
      return s === null || s <= year;
    });
  const parents = links.filter((l) => l.childId === pov).map((l) => str(l.parentId));
  const children = links.filter((l) => l.parentId === pov).map((l) => str(l.childId));
  const siblings = links
    .filter((l) => parents.includes(str(l.parentId)) && l.childId !== pov)
    .map((l) => str(l.childId));
  const partners = data
    .all('unions')
    .filter(live)
    .filter((u) => idList(u.partnerIds).includes(pov))
    .filter((u) => {
      const s = num(u.startYear);
      const e = num(u.endYear);
      return (s === null || s <= year) && (e === null || e >= year);
    })
    .flatMap((u) => idList(u.partnerIds).filter((p) => p !== pov));
  const alive = (id: string) => {
    const c = characters.get(id);
    return live(c) && stateIn(c, year).state === 'alive';
  };
  const out: string[] = [pov];
  for (const group of [parents, partners, children, siblings]) {
    for (const id of sortPeople([...new Set(group)].filter(alive), characters)) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** SM-3: a character's live moments, by year, then title and ID. */
export function momentsOf(data: TimelineData, characterId: string): Doc[] {
  return data
    .all('moments')
    .filter(live)
    .filter((m) => m.characterId === characterId && num(m.year) !== null)
    .sort(
      (a, b) =>
        (num(a.year) as number) - (num(b.year) as number) ||
        byText(title(a), title(b)) ||
        byText(str(a._id), str(b._id)),
    );
}

/** SM-3: a "Voice" moment says how the character speaks from its year on. */
export const isVoiceMoment = (m: Doc) => title(m, '').trim() === VOICE_MOMENT_TITLE;

/** SM-3: a "Lives in" moment says where the character lives from its year on. */
export const isLivesInMoment = (m: Doc) => title(m, '').startsWith(LIVES_IN_PREFIX);

/** The place a "Lives in" moment names. */
export const livesInPlace = (m: Doc) => title(m, '').slice(LIVES_IN_PREFIX.length).trim();

/**
 * SB-2 step 1 (SB-3 intent, SM-3): how the character speaks at that age, from
 * the latest "Voice" moment at or before the year. Null when none is.
 */
export function voiceAt(moments: readonly Doc[], year: number): Doc | null {
  const voices = moments.filter((m) => isVoiceMoment(m) && (num(m.year) as number) <= year);
  return voices[voices.length - 1] ?? null;
}

function characterItem(c: Doc, year: number, voice: Doc | null): SelectedItem {
  const id = str(c._id);
  const state = stateIn(c, year);
  const names = isPlainObject(c.names) ? c.names : {};
  return {
    id,
    collection: 'characters',
    title: characterName(c, id),
    note: describeState(state),
    detail: joinText(
      str(names.chinese),
      plain(c.backstory),
      voice ? `Voice from ${num(voice.year)}: ${plain(voice.body)}` : '',
    ),
    refs: voice ? [str(voice._id)] : [],
    state,
  };
}

function momentItem(m: Doc, c: Doc): SelectedItem {
  const y = num(m.year) as number;
  const end = num(m.endYear);
  const born = birthYear(c);
  const age = born === null ? '' : `age ${y - born}`;
  const when = end !== null && end !== y ? `${y} to ${end}` : String(y);
  return {
    id: str(m._id),
    collection: 'moments',
    title: title(m, 'Untitled moment'),
    note: joinText(`${characterName(c, str(c._id))}, ${when}${age ? ',' : ''}`, age),
    detail: joinText(plain(m.body), plain(m.worldContext)),
    refs: [],
    year: y,
    ...(end !== null && end >= y ? { endYear: end } : {}),
  };
}

// ---------- the main query ----------

/**
 * SB-2: the entries a session about `input` needs, per strand, primary first.
 * Deterministic: the same input, settings, overrides, and data always give an
 * identical result (SB-3).
 */
export function selectForSession(
  data: TimelineData,
  input: BriefInput,
  settings: SelectionSettings = DEFAULT_SELECTION_SETTINGS,
  overrides: SelectionOverrides = {},
): Selection {
  const section = resolveSection(data, input);
  const ahead = settings.ahead ?? WINDOW_AHEAD;
  const characters = index(data, 'characters');
  const places = data.all('places');
  const placeById = index(data, 'places');
  const lists = index(data, 'lists');
  const communityLabel = (id: string) => {
    const items = (lists.get('communities')?.items ?? []) as { id: string; label: string }[];
    return items.find((i) => i.id === id)?.label ?? id;
  };
  /** Every community from a place out to the outermost place, nearest first (A35). */
  const communitiesOf = (placeId: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = placeById.get(placeId);
    while (cur && !seen.has(str(cur._id))) {
      seen.add(str(cur._id));
      const c = str(cur.communityId);
      if (c && !out.includes(c)) out.push(c);
      cur = placeById.get(str(cur.parentId));
    }
    return out;
  };
  /** A community's parents in the communities list, nearest first. */
  const communityParents = (id: string): string[] => {
    const items = (lists.get('communities')?.items ?? []) as {
      id: string;
      parentId?: string | null;
    }[];
    const out: string[] = [];
    let cur = items.find((i) => i.id === id)?.parentId ?? null;
    while (cur && !out.includes(cur) && cur !== id) {
      out.push(cur);
      cur = items.find((i) => i.id === cur)?.parentId ?? null;
    }
    return out;
  };
  /** A35: the strand's places, else where the point of view (or the first one present) lived. */
  const settingFor = (spec: StrandSpec, present: string[], Y: number): StrandSetting => {
    if (spec.placeIds.length) {
      return { placeIds: spec.placeIds, source: 'strand', characterId: null, note: '' };
    }
    const who = [...new Set([spec.pov, ...present].filter((x): x is string => !!x))];
    for (const id of who) {
      const c = characters.get(id);
      if (!live(c)) continue;
      // A "Lives in" moment with no end runs on; the latest one begun by the year wins.
      const rows = momentsOf(data, id)
        .filter(isLivesInMoment)
        .filter((m) => (num(m.year) as number) <= Y && Y <= (num(m.endYear) ?? Infinity))
        .reverse();
      for (const m of rows) {
        const p = placeForText(places, livesInPlace(m));
        if (!p) continue;
        return {
          placeIds: [p],
          source: 'livesIn',
          characterId: id,
          note: `from ${characterName(c, id)}'s ${title(m)}, ${rangeText(num(m.year), num(m.endYear))}`,
        };
      }
    }
    return { placeIds: [], source: 'none', characterId: spec.pov, note: '' };
  };
  /** A35, SM-3: the moments of the chapter's backstory years. */
  const backstoryFor = (spec: StrandSpec, present: string[], Y: number): StrandBackstory => {
    const clean = (l: string) => l.replace(/^backstory\s*:\s*/i, '').trim();
    let from = Y - 3;
    let to = Y - 1;
    let label = 'The three years before';
    const extra: string[] = [];
    if (spec.chapter) {
      const others = strandsOf(spec.chapter).filter(
        (s) => num(s.startYear) !== null && s.primary !== true && str(s.id) !== spec.strandId,
      );
      if (!spec.primary) {
        from = Y;
        to = Math.max(Y, spec.endYear ?? Y);
        label = clean(spec.strandLabel) || 'Backstory';
      } else if (others.length) {
        from = Math.min(...others.map((s) => num(s.startYear) as number));
        to = Math.max(...others.map((s) => num(s.endYear) ?? (num(s.startYear) as number)));
        label = others.map((s) => clean(str(s.label)) || 'Backstory').join(' · ');
        for (const s of others) extra.push(...idList(s.characterIds));
      }
    }
    const people: StrandBackstory['people'] = [];
    for (const id of [...new Set([...present, ...extra])]) {
      const c = characters.get(id);
      if (!live(c)) continue;
      const born = birthYear(c);
      const rows: BackstoryRow[] = momentsOf(data, id)
        .filter((m) => {
          const y = num(m.year) as number;
          return y <= to && Math.max(y, num(m.endYear) ?? y) >= from;
        })
        .map((m) => ({
          id: str(m._id),
          year: num(m.year) as number,
          endYear: num(m.endYear),
          title: title(m, 'Untitled moment'),
          body: plain(m.body),
          worldContext: plain(m.worldContext),
        }));
      if (!rows.length) continue;
      const ages =
        born === null
          ? 'age unknown'
          : from === to
            ? `age ${from - born}`
            : `ages ${from - born} to ${to - born}`;
      people.push({
        characterId: id,
        name: characterName(c, id),
        ages,
        rows,
      });
    }
    return { from, to, label, people };
  };
  const events = eventSpans(data);
  const eventDocs = index(data, 'worldEvents');
  // A47 (IP-8): events store region item IDs; the brief names them by label.
  const regionItems = (lists.get('regions')?.items ?? []) as { id: string; label: string }[];
  const regionLabel = (id: string) => regionItems.find((i) => i.id === id)?.label ?? id;

  const eventItem = (e: EventSpan, note: string): SelectedItem => ({
    id: e.id,
    collection: 'worldEvents',
    title: e.title,
    note: joinText(eventDates(e) + (note ? ',' : ''), note),
    detail: joinText(plain(eventDocs.get(e.id)?.body), e.regions.map(regionLabel).join(', ')),
    refs: [],
    year: e.startYear,
    endYear: e.endYear,
  });

  const strands: StrandSelection[] = section.strands.map((spec) => {
    const Y = spec.year;
    const groups = new Map<GroupKind, SelectedItem[]>(STRAND_KINDS.map((k) => [k, []]));
    const bucket = (k: GroupKind): SelectedItem[] => {
      let list = groups.get(k);
      if (!list) groups.set(k, (list = []));
      return list;
    };
    const push = (k: GroupKind, item: SelectedItem) => bucket(k).push(item);

    // 1. Characters present, with ages; else the point of view and family.
    let present = spec.characterIds.filter((id) => live(characters.get(id)));
    const povLive = !!spec.pov && live(characters.get(spec.pov));
    if (!present.length && spec.pov && povLive) {
      present = family(data, spec.pov, Y);
    } else if (spec.pov && povLive) {
      // SB-1: the point of view character is always present, first.
      present = [spec.pov, ...present.filter((id) => id !== spec.pov)];
    }
    for (const id of present) {
      const c = characters.get(id);
      if (!c) continue;
      const moments = momentsOf(data, id);
      const voice = voiceAt(moments, Y);
      push('characters', characterItem(c, Y, voice));
      // SM-3: their moments up to the story year are their backstory; the voice is on the character.
      // SB-5, A33: a moment of the year after sits under Planned ahead, as events do; later ones wait.
      for (const m of moments) {
        if (str(m._id) === str(voice?._id)) continue;
        const year = num(m.year) as number;
        if (year <= Y) push('moments', momentItem(m, c));
        else if (year <= Y + ahead) push('plannedAhead', momentItem(m, c));
      }
    }

    // 2. The era state covering the year.
    const era = eraFor(data, Y);
    if (era) {
      push('era', {
        id: era.id,
        collection: 'eraStates',
        title: era.name,
        note: rangeText(era.startYear, era.endYear),
        detail: plain(data.all('eraStates').find((d) => d._id === era.id)?.body),
        refs: [],
      });
    }

    // 3. World events: the window (A33: `window` years back and WINDOW_AHEAD
    // years on), formative in a lifetime, and linked to the places.
    const taken = new Set<string>();
    for (const e of eventsUpTo(data, Y, settings.window)) {
      taken.add(e.id);
      push('eventsWindow', eventItem(e, ''));
    }
    for (const e of eventsAhead(data, Y, ahead)) {
      taken.add(e.id);
      push('plannedAhead', eventItem(e, e.startYear === Y ? 'later this year' : 'next year'));
    }
    const lifetimes = present
      .map((id) => characters.get(id))
      .filter((c): c is Doc => !!c)
      .map((c) => ({ c, born: birthYear(c), died: deathYear(c) }))
      .filter((x) => x.born !== null);
    for (const e of events) {
      if (!e.formative || taken.has(e.id) || e.startYear > Y) continue;
      const who = lifetimes.filter(
        (x) => e.endYear >= (x.born as number) && (x.died === null || e.startYear <= x.died),
      );
      if (!who.length) continue;
      taken.add(e.id);
      const names = who.map((x) => characterName(x.c, str(x.c._id))).join(', ');
      push('eventsFormative', eventItem(e, `formative for ${names}`));
    }

    // 4. Cultural entries for the setting's communities and the year (A35).
    const setting = settingFor(spec, present, Y);
    const communities: string[] = [];
    for (const p of setting.placeIds) {
      for (const c of communitiesOf(p)) if (!communities.includes(c)) communities.push(c);
    }
    for (const c of [...communities]) {
      for (const parent of communityParents(c)) {
        if (!communities.includes(parent)) communities.push(parent);
      }
    }
    const seenCulture = new Set<string>();
    for (const community of communities) {
      for (const c of entriesFor(data.all('culturalEntries'), community, Y)) {
        if (seenCulture.has(str(c._id))) continue;
        seenCulture.add(str(c._id));
        push('culture', {
          id: str(c._id),
          collection: 'culturalEntries',
          title: title(c),
          note: `${communityLabel(community)}, ${rangeText(num(c.startYear), num(c.endYear))}`,
          detail: plain(c.body),
          refs: [],
          community,
        });
      }
    }

    // 5. Place descriptions for the year.
    for (const p of setting.placeIds) {
      const place = placeById.get(p);
      if (!live(place)) continue;
      const d = descriptionFor(place as never, Y);
      if (!d) continue;
      push('places', {
        id: p,
        collection: 'places',
        title: placePath(places, p) || title(place),
        note: rangeText(d.startYear, d.endYear),
        detail: d.text,
        refs: [],
      });
    }

    return {
      chapterId: spec.chapter ? str(spec.chapter._id) : null,
      strandId: spec.strandId,
      label: spec.label,
      primary: spec.primary,
      year: Y,
      povCharacterId: spec.pov,
      povName: spec.pov ? characterName(characters.get(spec.pov), spec.pov) : null,
      placeIds: spec.placeIds,
      endYear: spec.endYear,
      setting,
      communities: communities.map((id) => ({ id, label: communityLabel(id) })),
      backstory: backstoryFor(spec, present, Y),
      groups: STRAND_KINDS.map((k) => ({
        kind: k,
        step: GROUP_STEP[k],
        title: GROUP_TITLES[k],
        items: bucket(k),
      })),
    };
  });

  const findEntry = entryLookup(data);
  const shared = sharedSteps(data, section, strands, findEntry);

  // SB-9: the person's additions and removals.
  const remove = new Set(overrides.remove ?? []);
  const added: string[] = [];
  const addedItems: SelectedItem[] = [];
  for (const id of overrides.add ?? []) {
    if (remove.has(id) || added.includes(id)) continue;
    const found = findEntry(id);
    if (!found) continue;
    added.push(id);
    addedItems.push({
      id,
      collection: found.collection,
      title:
        found.collection === 'characters'
          ? characterName(found.doc, id)
          : title(found.doc, 'Untitled'),
      note: 'added by you',
      detail: genericText(found.doc),
      refs: [],
    });
  }
  shared.push({ kind: 'added', step: 0, title: GROUP_TITLES.added, items: addedItems });

  const all = () => [...strands.flatMap((s) => s.groups), ...shared];
  const omitted: OmittedItem[] = [];
  const removed: string[] = [];
  if (remove.size) {
    for (const g of all()) {
      if (g.kind === 'added') continue;
      g.items = g.items.filter((it) => {
        if (!remove.has(it.id)) return true;
        if (!removed.includes(it.id)) {
          removed.push(it.id);
          omitted.push({ id: it.id, title: it.title, kind: g.kind, reason: 'removed' });
        }
        return false;
      });
    }
  }

  // SB-6: drop the lowest priority items until the text fits the budget.
  const sizeOf = () => {
    const seen = new Set<string>();
    let n = 0;
    for (const g of all()) {
      for (const it of g.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        n += itemSize(it);
      }
    }
    return n;
  };
  let size = sizeOf();
  for (const kind of DROP_ORDER) {
    if (size <= settings.budget) break;
    const groups = all()
      .filter((g) => g.kind === kind)
      .reverse();
    for (const g of groups) {
      while (g.items.length && size > settings.budget) {
        const it = g.items.pop();
        if (!it) break;
        // Left out only once it leaves the manifest: it may still be in another strand or group.
        const still = all().some((x) =>
          x.items.some((y) => y.id === it.id || y.refs.includes(it.id)),
        );
        if (!still && !omitted.some((o) => o.id === it.id)) {
          omitted.push({ id: it.id, title: it.title, kind, reason: 'budget' });
        }
        size = sizeOf();
      }
      if (size <= settings.budget) break;
    }
  }

  const leadSeen = new Set<string>();
  let leadSize = 0;
  for (const g of all()) {
    if (!LEAD_KINDS.includes(g.kind)) continue;
    for (const it of g.items) {
      if (leadSeen.has(it.id)) continue;
      leadSeen.add(it.id);
      leadSize += itemSize(it);
    }
  }

  const ids = new Set<string>(section.chapters.map((c) => str(c._id)));
  for (const g of all()) {
    for (const it of g.items) {
      ids.add(it.id);
      for (const r of it.refs) ids.add(r);
    }
  }

  return {
    input,
    label: section.label,
    year: section.year,
    chapterIds: section.chapters.map((c) => str(c._id)),
    strands,
    shared,
    omitted,
    skippedStrands: section.skipped,
    added,
    removed: removed.sort(byText),
    window: settings.window,
    ahead,
    budget: settings.budget,
    size,
    leadSize,
    overBudget: leadSize > settings.budget,
    ids: [...ids].sort(byText),
  };
}

/** SB-6 counts the characters of an item's text: its title, note, and detail. */
export function itemSize(it: SelectedItem): number {
  return it.title.length + it.note.length + it.detail.length;
}

type Lookup = (id: string) => { collection: string; doc: Doc } | null;

/** Find any live entry by ID, building the index once per selection. */
function entryLookup(data: TimelineData): Lookup {
  let map: Map<string, { collection: string; doc: Doc }> | null = null;
  return (id) => {
    if (!map) {
      map = new Map();
      for (const c of ENTRY_COLLECTIONS) {
        for (const doc of data.all(c)) {
          if (live(doc) && !map.has(str(doc._id))) map.set(str(doc._id), { collection: c, doc });
        }
      }
    }
    return map.get(id) ?? null;
  };
}

const SKIP_KEYS = new Set(['_id', 'createdAt', 'modifiedAt', 'deletedAt', 'manuscriptText']);

/** Every string an entry holds, for entries added by hand (SB-9). */
function genericText(doc: Doc): string {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (SKIP_KEYS.has(key) || /Ids?$/.test(key)) return;
    if (typeof v === 'string') out.push(plain(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, ''));
    else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const [k, v] of Object.entries(doc)) if (k !== 'title') walk(v, k);
  return joinText(...out);
}

// ---------- steps 7 and 9 ----------

function sharedSteps(
  data: TimelineData,
  section: Section,
  strands: StrandSelection[],
  findEntry: Lookup,
): SelectionGroup[] {
  const Y = section.year;
  const characters = index(data, 'characters');
  const chapters = data.all('chapters').filter(live);
  const chapterById = new Map(chapters.map((c) => [str(c._id), c]));
  const sectionIds = section.chapters.map((c) => str(c._id));
  const order = (c: Doc) => num(c.readingOrder) ?? 0;
  const byOrder = (a: Doc, b: Doc) => order(a) - order(b) || byText(str(a._id), str(b._id));
  const povs = [...new Set(section.strands.map((s) => s.pov).filter((p): p is string => !!p))];
  const hasPov = (c: Doc, pov: string) => strandsOf(c).some((s) => s.povCharacterId === pov);

  // 7. Previous chapters: three in reading order and the previous with the same point of view.
  const reasons = new Map<string, string[]>();
  const note = (id: string, why: string) => {
    const list = reasons.get(id) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(id, list);
  };
  if (section.chapters.length) {
    const first = section.chapters[0] as Doc;
    const before = chapters
      .filter((c) => !sectionIds.includes(str(c._id)) && order(c) < order(first))
      .sort(byOrder);
    for (const c of before.slice(-3)) note(str(c._id), 'previous in reading order');
    for (const pov of povs) {
      const prev = [...before].reverse().find((c) => hasPov(c, pov));
      if (prev) {
        note(
          str(prev._id),
          `previous with ${characterName(characters.get(pov), pov)} as point of view`,
        );
      }
    }
  } else {
    for (const pov of povs) {
      const candidates = chapters
        .flatMap((c) =>
          strandsOf(c)
            .filter((s) => s.povCharacterId === pov && (num(s.startYear) ?? Infinity) <= Y)
            .map((s) => ({ c, year: num(s.startYear) as number })),
        )
        .sort((a, b) => b.year - a.year || order(b.c) - order(a.c));
      const best = candidates[0];
      if (best) {
        note(
          str(best.c._id),
          `latest with ${characterName(characters.get(pov), pov)} as point of view by ${Y}`,
        );
      }
    }
  }
  const previous: SelectedItem[] = [...reasons.keys()]
    .map((id) => chapterById.get(id))
    .filter((c): c is Doc => !!c)
    .sort(byOrder)
    .map((c) => ({
      id: str(c._id),
      collection: 'chapters',
      title: chapterLabel(c),
      note:
        (reasons.get(str(c._id)) ?? []).join('; ') +
        (c.summaryOutOfDate === true ? '; the summary may be out of date' : ''),
      detail: plain(c.summary),
      refs: [],
    }));

  // The entries selected so far, for step 9.
  const selected = new Set<string>(sectionIds);
  for (const s of strands) {
    for (const g of s.groups) {
      for (const it of g.items) {
        selected.add(it.id);
        it.refs.forEach((r) => selected.add(r));
      }
    }
  }
  previous.forEach((p) => selected.add(p.id));
  const isAbout = (q: Doc) => aboutOf(q).some((t) => selected.has(t));
  const aboutNote = (q: Doc) => {
    const names = [...new Set(aboutOf(q).filter((t) => selected.has(t)))].sort(byText).map((id) => {
      const f = findEntry(id);
      return f?.collection === 'characters' ? characterName(f.doc, id) : title(f?.doc, id);
    });
    return names.length ? `about ${names.join(', ')}` : '';
  };

  // 9. Glossary terms in the names of selected characters, and open questions about anything selected (A18, A53).
  const selectedCharacters = strands
    .flatMap((s) => s.groups.find((g) => g.kind === 'characters')?.items ?? [])
    .map((it) => it.id)
    .filter((id, i, a) => a.indexOf(id) === i)
    .map((id) => characters.get(id))
    .filter((c): c is Doc => !!c);
  const nameStrings = (c: Doc): string[] => {
    const n = isPlainObject(c.names) ? c.names : {};
    return [str(n.full), str(n.chinese)].filter(Boolean);
  };
  const glossary: SelectedItem[] = data
    .all('glossaryTerms')
    .filter(live)
    .map((g) => {
      const chars = str(g.characters);
      const inNames = chars
        ? selectedCharacters.filter((c) => nameStrings(c).some((n) => n.includes(chars)))
        : [];
      const why = inNames.length
        ? [`in the name of ${inNames.map((c) => characterName(c, str(c._id))).join(', ')}`]
        : [];
      return { g, why };
    })
    .filter((x) => x.why.length)
    .sort(
      (a, b) =>
        byText(str(a.g.characters), str(b.g.characters)) || byText(str(a.g._id), str(b.g._id)),
    )
    .map(({ g, why }) => ({
      id: str(g._id),
      collection: 'glossaryTerms',
      title: joinText(str(g.characters), str(g.romanization)),
      note: why.join('; '),
      detail: joinText(str(g.meaning), str(g.usageNote)),
      refs: [],
    }));

  // A24: decided questions are included too, under their own heading, with their decision.
  const decided: SelectedItem[] = data
    .all('openQuestions')
    .filter(live)
    .filter((q) => q.state === 'decided' && isAbout(q))
    .sort((a, b) => byText(title(a), title(b)) || byText(str(a._id), str(b._id)))
    .map((q) => ({
      id: str(q._id),
      collection: 'openQuestions',
      title: title(q),
      note: aboutNote(q),
      detail: joinText(plain(q.question), `Decision: ${plain(q.decision) || 'not recorded'}`),
      refs: [],
    }));
  const questions: SelectedItem[] = data
    .all('openQuestions')
    .filter(live)
    .filter((q) => q.state !== 'decided' && isAbout(q))
    .sort((a, b) => byText(title(a), title(b)) || byText(str(a._id), str(b._id)))
    .map((q) => ({
      id: str(q._id),
      collection: 'openQuestions',
      title: title(q),
      note: aboutNote(q),
      detail: plain(q.question),
      refs: [],
    }));

  const group = (kind: GroupKind, items: SelectedItem[]): SelectionGroup => ({
    kind,
    step: GROUP_STEP[kind],
    title: GROUP_TITLES[kind],
    items,
  });
  return [
    group('previousChapters', previous),
    group('glossary', glossary),
    group('openQuestions', questions),
    group('decidedQuestions', decided),
  ];
}
