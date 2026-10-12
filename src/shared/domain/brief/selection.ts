/**
 * Session brief selection (SB-1 to SB-3, SB-5, SB-6, SB-9, CS-3). The one
 * deterministic query that decides which entries a session is about. The
 * "Relevant to Session" view, the structured brief (SB-7), the saved
 * manifest (SB-3), and the input Claude synthesizes from (SB-4) all come from
 * `selectForSession`, so they can never disagree.
 *
 * SB-2 steps 1 to 6 run once per strand, the primary strand first (A5); steps
 * 7 to 10 run once for the section. Every list is sorted on explicit keys so
 * the same inputs and data give the same manifest every time (SB-3). Nothing
 * here calls a model or reads the clock.
 *
 * Readings this module chose where SPEC left room (reported to the architect):
 * - A place's community is its own `communityId`, else the nearest enclosing
 *   place's (step 4).
 * - "Partners" in the step 1 fallback are partners in a union that has begun
 *   by the story year and not ended before it; everyone in the fallback is
 *   alive in the story year.
 * - World events linked to the strand's places that start after the story
 *   year go under "Planned ahead" (SB-5) instead of being left out.
 * - Step 9 lists still-open questions and decided questions (A24) apart.
 * - With a year and point of view but no chapter, step 7 is the chapter with
 *   that point of view whose strand year is latest at or before the story
 *   year, and step 8 is empty (there are no arcs to follow).
 * - SB-6 does not rank planned-ahead items or custom entries (CS-3); they drop
 *   first. The DB-2 lead sections never drop (A25). Entries you add (SB-9) never drop.
 * - An entry is reported as left out only once it leaves the manifest.
 */
import type { LifeState } from '../ages';
import { describeState } from '../ages';
import { descriptionFor, entriesFor, placePath } from '../culture';
import { yearOf } from '../dates';
import { knownBy } from '../knowledge';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { latestLog } from '../sessionLog';
import { characterName, eraFor, eventSpans, eventsUpTo, stateIn } from '../timeline';
import type { EventSpan, TimelineData } from '../timeline';
import { ENTRY_COLLECTIONS } from '../../schema';

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
  /** SB-2 step 3: years before the story year that world events are taken from. */
  window: number;
  /** SB-6: the most characters of selected text a brief takes. */
  budget: number;
}

export const DEFAULT_SELECTION_SETTINGS: SelectionSettings = { window: 10, budget: 40_000 };

/** SB-9: entries the person added to, or removed from, the selection. */
export interface SelectionOverrides {
  add?: readonly string[];
  remove?: readonly string[];
}

// ---------- output ----------

export type GroupKind =
  | 'characters'
  | 'era'
  | 'eventsWindow'
  | 'eventsFormative'
  | 'eventsPlaces'
  | 'culture'
  | 'places'
  | 'knowledge'
  | 'povUnknown'
  | 'plannedAhead'
  | 'previousChapters'
  | 'beats'
  | 'glossary'
  | 'themes'
  | 'openQuestions'
  | 'decidedQuestions'
  | 'custom'
  | 'sessionNote'
  | 'added';

export const GROUP_TITLES: Record<GroupKind, string> = {
  characters: 'Characters present',
  era: 'Era state',
  eventsWindow: 'World events in the window',
  eventsFormative: 'Formative events in a lifetime',
  eventsPlaces: 'Events at these places',
  culture: 'Cultural expectations',
  places: 'Place descriptions',
  knowledge: 'What the characters know',
  povUnknown: 'What the point of view character does not know',
  plannedAhead: 'Planned ahead',
  previousChapters: 'Previous chapters',
  beats: 'Beats',
  glossary: 'Glossary terms',
  themes: 'Themes',
  openQuestions: 'Open questions',
  decidedQuestions: 'Decided',
  custom: 'Custom entries',
  sessionNote: 'Last session note',
  added: 'Added by you',
};

/** The SB-2 step each group answers. Planned ahead is part of step 3; added entries are SB-9. */
export const GROUP_STEP: Record<GroupKind, number> = {
  characters: 1,
  era: 2,
  eventsWindow: 3,
  eventsFormative: 3,
  eventsPlaces: 3,
  plannedAhead: 3,
  culture: 4,
  places: 5,
  knowledge: 6,
  povUnknown: 6,
  previousChapters: 7,
  beats: 8,
  glossary: 9,
  themes: 9,
  openQuestions: 9,
  decidedQuestions: 9,
  custom: 9,
  sessionNote: 10,
  added: 0,
};

const STRAND_KINDS: GroupKind[] = [
  'characters',
  'era',
  'eventsWindow',
  'eventsFormative',
  'eventsPlaces',
  'culture',
  'places',
  'knowledge',
  'povUnknown',
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
  'custom',
  'decidedQuestions',
  'openQuestions',
  'themes',
  'glossary',
  'places',
  'eventsPlaces',
  'previousChapters',
  'beats',
  'povUnknown',
  'knowledge',
  'era',
  'sessionNote',
];

export interface SelectedItem {
  id: string;
  collection: string;
  title: string;
  /** canon, planned, or idea (SB-5 keeps them apart). */
  status: string;
  /** Why it was selected, or the computed fact about it (an age, a year learned). */
  note: string;
  /** The entry's text as the brief shows it; its length is what SB-6 counts. */
  detail: string;
  /** Other entries this item draws on, such as knowledge records. They are in the manifest too. */
  refs: string[];
  /** For characters: the state in the strand's year (TL-2). */
  state?: LifeState;
  /** For events and beats: the year it starts. */
  year?: number | null;
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
  /** The communities of the strand's places (step 4). */
  communities: { id: string; label: string }[];
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
  /** Steps 7 to 10, CS-3 custom entries, and SB-9 additions. */
  shared: SelectionGroup[];
  /** What SB-6 or the person left out. The brief says so. */
  omitted: OmittedItem[];
  /** Strands left out because they have no start year (the brief says so). */
  skippedStrands: string[];
  added: string[];
  removed: string[];
  window: number;
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

/** Plain text from the editor's HTML, for briefs and the budget. */
export function plain(html: unknown): string {
  return str(html)
    .replace(/<hr\s*\/?>/gi, '\n* * *\n')
    .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
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

function linksOf(d: Doc | undefined): string[] {
  return (Array.isArray(d?.links) ? d.links : [])
    .filter(isPlainObject)
    .map((l) => str(l.targetId))
    .filter(Boolean);
}

interface StrandSpec {
  chapter: Doc | null;
  strandId: string | null;
  label: string;
  primary: boolean;
  year: number;
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
      label: title(part, 'Untitled part'),
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

function characterItem(c: Doc, year: number): SelectedItem {
  const id = str(c._id);
  const state = stateIn(c, year);
  const names = isPlainObject(c.names) ? c.names : {};
  const voice = (Array.isArray(c.voiceNotes) ? c.voiceNotes : [])
    .filter(isPlainObject)
    .map((v) => str(v.text));
  return {
    id,
    collection: 'characters',
    title: characterName(c, id),
    status: str(c.status),
    note: describeState(state),
    detail: joinText(str(names.chinese), plain(c.backstory), ...voice),
    refs: [],
    state,
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
  const characters = index(data, 'characters');
  const places = data.all('places');
  const placeById = index(data, 'places');
  const lists = index(data, 'lists');
  const communityLabel = (id: string) => {
    const items = (lists.get('communities')?.items ?? []) as { id: string; label: string }[];
    return items.find((i) => i.id === id)?.label ?? id;
  };
  const communityOf = (placeId: string): string | null => {
    const seen = new Set<string>();
    let cur = placeById.get(placeId);
    while (cur && !seen.has(str(cur._id))) {
      seen.add(str(cur._id));
      if (str(cur.communityId)) return str(cur.communityId);
      cur = placeById.get(str(cur.parentId));
    }
    return null;
  };
  const events = eventSpans(data);
  const eventDocs = index(data, 'worldEvents');
  const factDocs = index(data, 'facts');

  const eventItem = (e: EventSpan, note: string): SelectedItem => ({
    id: e.id,
    collection: 'worldEvents',
    title: e.title,
    status: e.status,
    note: joinText(eventDates(e) + (note ? ',' : ''), note),
    detail: joinText(plain(eventDocs.get(e.id)?.body), e.regions.join(', ')),
    refs: [],
    year: e.startYear,
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
      if (c) push('characters', characterItem(c, Y));
    }

    // 2. The era state covering the year.
    const era = eraFor(data, Y);
    if (era) {
      push('era', {
        id: era.id,
        collection: 'eraStates',
        title: era.name,
        status: str(data.all('eraStates').find((d) => d._id === era.id)?.status),
        note: rangeText(era.startYear, era.endYear),
        detail: [
          ['Technology', era.technology],
          ['Climate', era.climate],
          ['Economy', era.economy],
          ['Politics', era.politics],
          ['Daily life', era.dailyLife],
        ]
          .filter(([, v]) => v?.trim())
          .map(([k, v]) => `${k}: ${(v ?? '').trim()}`)
          .join(' '),
        refs: [],
      });
    }

    // 3. World events: the window, formative in a lifetime, and linked to the places.
    const taken = new Set<string>();
    for (const e of eventsUpTo(data, Y, settings.window)) {
      taken.add(e.id);
      push('eventsWindow', eventItem(e, ''));
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
    for (const e of events) {
      if (taken.has(e.id)) continue;
      const at = e.placeIds.filter((p) => spec.placeIds.includes(p));
      if (!at.length) continue;
      taken.add(e.id);
      const where = `at ${at.map((p) => placePath(places, p) || p).join(', ')}`;
      if (e.startYear <= Y) push('eventsPlaces', eventItem(e, where));
      else push('plannedAhead', eventItem(e, where));
    }

    // 4. Cultural entries for the places' communities and the year.
    const communities: string[] = [];
    for (const p of spec.placeIds) {
      const c = communityOf(p);
      if (c && !communities.includes(c)) communities.push(c);
    }
    for (const community of communities) {
      for (const c of entriesFor(data.all('culturalEntries'), community, Y)) {
        push('culture', {
          id: str(c._id),
          collection: 'culturalEntries',
          title: title(c),
          status: str(c.status),
          note: `${communityLabel(community)}, ${rangeText(num(c.startYear), num(c.endYear))}`,
          detail: joinText(plain(c.body), str(c.generationNotes)),
          refs: [],
        });
      }
    }

    // 5. Place descriptions for the year.
    for (const p of spec.placeIds) {
      const place = placeById.get(p);
      if (!live(place)) continue;
      const d = descriptionFor(place as never, Y);
      if (!d) continue;
      push('places', {
        id: p,
        collection: 'places',
        title: placePath(places, p) || title(place),
        status: str(place.status),
        note: rangeText(d.startYear, d.endYear),
        detail: d.text,
        refs: [],
      });
    }

    // 6. What each character present knows, and what the point of view does not.
    const knowers = new Map<
      string,
      { name: string; who: string; year: number; record: string }[]
    >();
    for (const id of present) {
      for (const k of knownBy(data, id, Y).known) {
        const list = knowers.get(k.factId) ?? [];
        list.push({
          name: characterName(characters.get(id), id),
          who: id,
          year: k.yearLearned,
          record: k.recordId,
        });
        knowers.set(k.factId, list);
      }
    }
    const factIds = [...knowers.keys()].sort(
      (a, b) => byText(title(factDocs.get(a), a), title(factDocs.get(b), b)) || byText(a, b),
    );
    const factItem = (fid: string, note: string, refs: string[]): SelectedItem => ({
      id: fid,
      collection: 'facts',
      title: title(factDocs.get(fid), fid),
      status: str(factDocs.get(fid)?.status),
      note,
      detail: plain(factDocs.get(fid)?.body),
      refs: [...new Set(refs)].sort(byText),
    });
    for (const fid of factIds) {
      const list = knowers.get(fid) ?? [];
      push(
        'knowledge',
        factItem(
          fid,
          `known by ${list.map((k) => `${k.name} (since ${k.year})`).join(', ')}`,
          list.map((k) => k.record),
        ),
      );
    }
    if (spec.pov && live(characters.get(spec.pov))) {
      const povKnows = new Set(knownBy(data, spec.pov, Y).known.map((k) => k.factId));
      const povName = characterName(characters.get(spec.pov), spec.pov);
      for (const fid of factIds) {
        if (povKnows.has(fid)) continue;
        const others = (knowers.get(fid) ?? []).filter((k) => k.who !== spec.pov);
        if (!others.length) continue;
        push(
          'povUnknown',
          factItem(
            fid,
            `${others.map((k) => k.name).join(', ')} ${others.length > 1 ? 'know' : 'knows'}; ${povName} does not`,
            others.map((k) => k.record),
          ),
        );
      }
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
      communities: communities.map((id) => ({ id, label: communityLabel(id) })),
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
      status: str(found.doc.status),
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

const SKIP_KEYS = new Set([
  '_id',
  'createdAt',
  'modifiedAt',
  'deletedAt',
  'status',
  'provenance',
  'links',
  'sourceRef',
  'tags',
  'manuscriptText',
  'selection',
]);

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

// ---------- steps 7 to 10, and CS-3 ----------

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
  const arcs = index(data, 'arcs');
  const sectionIds = section.chapters.map((c) => str(c._id));
  const order = (c: Doc) => num(c.readingOrder) ?? 0;
  const byOrder = (a: Doc, b: Doc) => order(a) - order(b) || byText(str(a._id), str(b._id));
  const povs = [...new Set(section.strands.map((s) => s.pov).filter((p): p is string => !!p))];
  const hasPov = (c: Doc, pov: string) => strandsOf(c).some((s) => s.povCharacterId === pov);

  // 7. Previous chapters: three in reading order, the previous in each arc, the previous with the same point of view.
  const reasons = new Map<string, string[]>();
  const note = (id: string, why: string) => {
    const list = reasons.get(id) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(id, list);
  };
  const sectionArcs = [...new Set(section.chapters.flatMap((c) => idList(c.arcIds)))].sort(
    (a, b) => byText(title(arcs.get(a), a), title(arcs.get(b), b)) || byText(a, b),
  );
  if (section.chapters.length) {
    const first = section.chapters[0] as Doc;
    const before = chapters
      .filter((c) => !sectionIds.includes(str(c._id)) && order(c) < order(first))
      .sort(byOrder);
    for (const c of before.slice(-3)) note(str(c._id), 'previous in reading order');
    for (const arc of sectionArcs) {
      const prev = [...before].reverse().find((c) => idList(c.arcIds).includes(arc));
      if (prev) note(str(prev._id), `previous in the arc ${title(arcs.get(arc), arc)}`);
    }
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
      status: str(c.status),
      note:
        (reasons.get(str(c._id)) ?? []).join('; ') +
        (c.summaryOutOfDate === true ? '; the summary may be out of date' : ''),
      detail: plain(c.summary),
      refs: [],
    }));

  // 8. Beats planned for this chapter, and unresolved beats in its arcs (A18).
  const beats: SelectedItem[] = [];
  const beatDocs = data.all('plotBeats').filter(live);
  const arcNames = (b: Doc) =>
    idList(b.arcIds)
      .map((a) => title(arcs.get(a), a))
      .join(', ');
  const beatItem = (b: Doc, why: string): SelectedItem => ({
    id: str(b._id),
    collection: 'plotBeats',
    title: title(b, 'Untitled beat'),
    status: str(b.status),
    note: joinText(num(b.year) === null ? '' : `${num(b.year)},`, why),
    detail: joinText(plain(b.description), plain(b.experienceNote), plain(b.worldContext)),
    refs: [],
    year: num(b.year),
  });
  const beatOrder = (a: Doc, b: Doc) =>
    (num(a.year) ?? Infinity) - (num(b.year) ?? Infinity) ||
    byText(title(a), title(b)) ||
    byText(str(a._id), str(b._id));
  // SB-5: a beat of the section dated after the story year is planned ahead, not a beat now.
  const beatsAhead: SelectedItem[] = [];
  for (const b of beatDocs.filter((b) => sectionIds.includes(str(b.chapterId))).sort(beatOrder)) {
    const y = num(b.year);
    if (y !== null && y > Y) beatsAhead.push(beatItem(b, 'planned for a chapter of this section'));
    else beats.push(beatItem(b, 'planned for this chapter'));
  }
  if (sectionArcs.length) {
    const unresolved = beatDocs
      .filter((b) => !sectionIds.includes(str(b.chapterId)))
      .filter((b) => idList(b.arcIds).some((a) => sectionArcs.includes(a)))
      .filter((b) => num(b.year) !== null && (num(b.year) as number) <= Y)
      .filter((b) => {
        const ch = chapterById.get(str(b.chapterId));
        return !str(b.chapterId) || !ch || ch.written !== true;
      })
      .sort(beatOrder);
    for (const b of unresolved) beats.push(beatItem(b, `unresolved in ${arcNames(b)}`));
  }

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
  beats.forEach((b) => selected.add(b.id));
  const selectedDocs = [...selected].map((id) => findEntry(id)?.doc).filter((d): d is Doc => !!d);
  const linkedFrom = new Set(selectedDocs.flatMap(linksOf));
  const isLinked = (d: Doc) =>
    linkedFrom.has(str(d._id)) || linksOf(d).some((t) => selected.has(t));
  const linkedTo = (d: Doc) => {
    const names = [...new Set(linksOf(d).filter((t) => selected.has(t)))]
      .concat(selectedDocs.filter((s) => linksOf(s).includes(str(d._id))).map((s) => str(s._id)))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort(byText)
      .map((id) => {
        const f = findEntry(id);
        return f?.collection === 'characters' ? characterName(f.doc, id) : title(f?.doc, id);
      });
    return names.length ? `linked to ${names.join(', ')}` : '';
  };

  // 9. Glossary terms, themes, and open questions linked to anything selected (A18).
  const selectedCharacters = strands
    .flatMap((s) => s.groups.find((g) => g.kind === 'characters')?.items ?? [])
    .map((it) => it.id)
    .filter((id, i, a) => a.indexOf(id) === i)
    .map((id) => characters.get(id))
    .filter((c): c is Doc => !!c);
  const nameStrings = (c: Doc): string[] => {
    const n = isPlainObject(c.names) ? c.names : {};
    return [
      str(n.full),
      str(n.chinese),
      str(n.birthName),
      str(n.marriedName),
      ...idList(n.nicknames),
      ...(Array.isArray(n.calledBy) ? n.calledBy : [])
        .filter(isPlainObject)
        .map((x) => str(x.name)),
    ].filter(Boolean);
  };
  const glossary: SelectedItem[] = data
    .all('glossaryTerms')
    .filter(live)
    .map((g) => {
      const chars = str(g.characters);
      const inNames = chars
        ? selectedCharacters.filter((c) => nameStrings(c).some((n) => n.includes(chars)))
        : [];
      const why = [
        isLinked(g) ? linkedTo(g) : '',
        inNames.length
          ? `in the name of ${inNames.map((c) => characterName(c, str(c._id))).join(', ')}`
          : '',
      ].filter(Boolean);
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
      status: str(g.status),
      note: why.join('; '),
      detail: joinText(str(g.meaning), str(g.usageNote)),
      refs: [],
    }));

  const themeChapters = new Set([...sectionIds, ...previous.map((p) => p.id)]);
  const themes: SelectedItem[] = data
    .all('themes')
    .filter(live)
    .map((t) => {
      const apps = (Array.isArray(t.appearances) ? t.appearances : [])
        .filter(isPlainObject)
        .filter((a) => themeChapters.has(str(a.chapterId)));
      return { t, apps };
    })
    .filter((x) => x.apps.length)
    .sort((a, b) => byText(title(a.t), title(b.t)) || byText(str(a.t._id), str(b.t._id)))
    .map(({ t, apps }) => ({
      id: str(t._id),
      collection: 'themes',
      title: title(t),
      status: str(t.status),
      note: `appears in ${[...new Set(apps.map((a) => str(a.chapterId)))]
        .map((id) => chapterById.get(id))
        .filter((c): c is Doc => !!c)
        .sort(byOrder)
        .map(chapterLabel)
        .join(', ')}`,
      detail: joinText(plain(t.description), ...apps.map((a) => str(a.note))),
      refs: [],
    }));

  // A24: decided questions are included too, under their own heading, with their decision.
  const decided: SelectedItem[] = data
    .all('openQuestions')
    .filter(live)
    .filter((q) => q.state === 'decided' && isLinked(q))
    .sort((a, b) => byText(title(a), title(b)) || byText(str(a._id), str(b._id)))
    .map((q) => ({
      id: str(q._id),
      collection: 'openQuestions',
      title: title(q),
      status: str(q.status),
      note: linkedTo(q),
      detail: joinText(plain(q.question), `Decision: ${plain(q.decision) || 'not recorded'}`),
      refs: [],
    }));
  const questions: SelectedItem[] = data
    .all('openQuestions')
    .filter(live)
    .filter((q) => q.state !== 'decided' && isLinked(q))
    .sort((a, b) => byText(title(a), title(b)) || byText(str(a._id), str(b._id)))
    .map((q) => ({
      id: str(q._id),
      collection: 'openQuestions',
      title: title(q),
      status: str(q.status),
      note: linkedTo(q),
      detail: plain(q.question),
      refs: [],
    }));

  // CS-3: custom sections by their brief rule.
  const sections = data
    .all('customSections')
    .filter(live)
    .sort((a, b) => byText(str(a.name), str(b.name)) || byText(str(a._id), str(b._id)));
  const custom: SelectedItem[] = [];
  for (const sec of sections) {
    const rule = str(sec.briefRule) || 'linked';
    if (rule === 'never') continue;
    const fields = (Array.isArray(sec.fields) ? sec.fields : []).filter(isPlainObject);
    const entries = data
      .all('customEntries')
      .filter(live)
      .filter((e) => e.sectionId === sec._id)
      .filter((e) => {
        const values = isPlainObject(e.values) ? e.values : {};
        if (rule === 'always') return true;
        if (rule === 'linked') {
          return (
            linksOf(e).some((t) => sectionIds.includes(t)) ||
            fields.some((f) => f.type === 'link' && sectionIds.includes(str(values[str(f.id)])))
          );
        }
        // storyYear: a year field equal to the year, or a year range covering it.
        return fields.some((f) => {
          const v = values[str(f.id)];
          if (f.type === 'year') return v === Y;
          if (f.type === 'yearRange' && isPlainObject(v)) {
            const s = num(v.startYear);
            const t = num(v.endYear);
            return (s === null || s <= Y) && (t === null || t >= Y) && (s !== null || t !== null);
          }
          return false;
        });
      })
      .sort((a, b) => byText(title(a), title(b)) || byText(str(a._id), str(b._id)));
    for (const e of entries) {
      custom.push({
        id: str(e._id),
        collection: 'customEntries',
        title: title(e),
        status: str(e.status),
        note: `${str(sec.name)}, ${rule === 'always' ? 'always included' : rule === 'linked' ? 'linked to the chapter' : `matches ${Y}`}`,
        detail: genericText({ values: e.values, body: e.body }),
        refs: [],
      });
    }
  }

  // 10. The last session log note for this chapter.
  const logs = data
    .all('sessionLogs')
    .filter(live)
    .filter((l) => sectionIds.includes(str(l.chapterId)));
  const last = sectionIds.length ? latestLog(logs) : null;
  const sessionNote: SelectedItem[] = last
    ? [
        {
          id: str(last._id),
          collection: 'sessionLogs',
          title: title(last, 'Session'),
          status: str(last.status),
          note: str(last.date),
          detail: joinText(str(last.stoppedAt), str(last.notes)),
          refs: [],
        },
      ]
    : [];

  const group = (kind: GroupKind, items: SelectedItem[]): SelectionGroup => ({
    kind,
    step: GROUP_STEP[kind],
    title: GROUP_TITLES[kind],
    items,
  });
  return [
    group('previousChapters', previous),
    group('beats', beats),
    group('glossary', glossary),
    group('themes', themes),
    group('openQuestions', questions),
    group('decidedQuestions', decided),
    group('custom', custom),
    group('sessionNote', sessionNote),
    group('plannedAhead', beatsAhead),
  ];
}

/** Every group of a selection, strands first (primary first) then the shared steps. */
export function allGroups(sel: Selection): SelectionGroup[] {
  return [...sel.strands.flatMap((s) => s.groups), ...sel.shared];
}

/** True when the entry is in the selection's manifest (SB-3, SB-4). */
export function inManifest(sel: Pick<Selection, 'ids'>, id: string): boolean {
  return sel.ids.includes(id);
}
