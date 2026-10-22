/**
 * Capture routing in the box (A48, CR-6, CR-9): what the box needs around the
 * pure router. The index is built from the bible as main builds it (the same
 * collections, live entries only, every list, the timeline end), so the facts
 * the box shows are the facts main routes again when the text is sent. Hints
 * carry IDs and numbers only (AI-4). No writes here: Route A files through
 * `fileLocalDrafts` in `src/shared/domain/capture.ts`.
 */
import type { Channel, Request, Response } from '../../../shared/ipc';
import type { EntryCollection } from '../../../shared/schema';
import type { StoryTimeValue } from '../../../shared/storyTime';
import { buildIndex, routeCapture } from '../../../shared/domain/captureRouter';
import type {
  CaptureDraft,
  CaptureFact,
  CaptureHint,
  CaptureRoute,
  RouterIndex,
  RouterIndexInput,
} from '../../../shared/domain/captureRouter';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/** The entry collections the router reads; main reads the same ones (`captureIndex.ts`). */
const ROUTER_COLLECTIONS = [
  'characters',
  'places',
  'culturalEntries',
  'moments',
  'glossaryTerms',
] as const satisfies readonly EntryCollection[];

/** The most sentences one capture may hold; main refuses more with the same words. */
export const CAPTURE_MAX_FACTS = 50;
export const CAPTURE_TOO_MANY_FACTS = `This capture has more than ${CAPTURE_MAX_FACTS} sentences, more than the app sends at once. Split it into smaller captures and send each one.`;

/** What the box keeps of the bible for one capture: the index and what built it. */
export interface CaptureBible {
  index: RouterIndex;
  input: RouterIndexInput;
  povCommunityId: string | null;
}

/** Read the lists and the live entries the router matches against, fresh from main. */
export async function loadCaptureBible(
  invoke: Invoke,
  timelineEnd: number,
  time: StoryTimeValue,
): Promise<CaptureBible> {
  const [{ lists }, ...lots] = await Promise.all([
    invoke('lists.get', {}),
    ...ROUTER_COLLECTIONS.map((collection) =>
      invoke('entry.list', { collection, trash: 'exclude' }),
    ),
  ]);
  const entries: RouterIndexInput['entries'] = {};
  ROUTER_COLLECTIONS.forEach((c, i) => {
    entries[c] = (lots[i]?.entries ?? [])
      .map((e) => e.entry as Record<string, unknown>)
      .filter((d) => !d.deletedAt);
  });
  const input: RouterIndexInput = {
    lists: lists.map((l) => ({
      _id: l._id,
      items: l.items.map((i) => ({ id: i.id, label: i.label, parentId: i.parentId })),
    })),
    entries,
    timelineEnd,
  };
  const chapter = time.chapterId
    ? (await invoke('entry.get', { collection: 'chapters', id: time.chapterId }).catch(() => null))
        ?.entry
    : undefined;
  return {
    index: buildIndex(input),
    input,
    povCommunityId: povCommunityId(
      time,
      chapter as Record<string, unknown> | undefined,
      entries.places ?? [],
    ),
  };
}

/** The community of the writing strand's first place, as main reads it (`captureIndex.ts`). */
export function povCommunityId(
  time: StoryTimeValue,
  chapter: Record<string, unknown> | undefined,
  places: readonly Record<string, unknown>[],
): string | null {
  if (!time.chapterId || !time.strandId || !chapter || chapter.deletedAt) return null;
  const strands = Array.isArray(chapter.strands)
    ? (chapter.strands as { id: string; placeIds?: string[] }[])
    : [];
  const placeId = strands.find((s) => s.id === time.strandId)?.placeIds?.[0];
  const place = places.find((p) => p._id === placeId);
  return place && !place.deletedAt && typeof place.communityId === 'string'
    ? place.communityId
    : null;
}

/** What the writer changed on one fact: chips as hint fields, and typed names for the drafts. */
export interface FactChoice {
  hint: Omit<CaptureHint, 'fact'>;
  /** A typed value for a required text field the router could not fill, by its path. */
  typed: Record<string, string>;
}

export const NO_CHOICE: FactChoice = { hint: {}, typed: {} };

/** The hints for a routing: one per fact the writer changed, numbered. */
export function choiceHints(choices: readonly FactChoice[]): CaptureHint[] {
  return choices.flatMap((c, fact) => (Object.keys(c.hint).length ? [{ fact, ...c.hint }] : []));
}

/** Route the text again with the writer's choices (CR-6: a chip change re-routes). */
export function routeWith(
  text: string,
  bible: CaptureBible,
  storyYear: number,
  choices: readonly FactChoice[],
): CaptureFact[] {
  return routeCapture(text, bible.index, {
    storyYear,
    povCommunityId: bible.povCommunityId,
    hints: choiceHints(choices),
  }).facts;
}

/**
 * CR-9: the hints sent with the text. Every fact the box keeps carries
 * `route: 'local'`, so main skips it (Route A facts, and facts already sent);
 * each fact being sent carries its chips and its route, forced to `full` by
 * Ask Claude instead.
 */
export function sendHints(
  facts: readonly CaptureFact[],
  choices: readonly FactChoice[],
  sending: ReadonlySet<number>,
  force?: Exclude<CaptureRoute, 'local'>,
): CaptureHint[] {
  return facts.map((f) => {
    if (!sending.has(f.index)) return { fact: f.index, route: 'local' as const };
    const route = force ?? (f.route === 'local' ? 'full' : f.route);
    return { fact: f.index, ...(choices[f.index]?.hint ?? {}), route };
  });
}

/**
 * The asks a typed value answers: a place's name, a glossary term, a
 * character's name. Community and Character are chips over the bible's
 * entries and lists, sent as hints.
 */
export const TYPED_ASKS: Record<string, { key: string; paths: readonly string[]; label: string }> =
  {
    'Place name': { key: 'title', paths: ['title'], label: 'Place name' },
    Term: { key: 'title', paths: ['title', 'characters'], label: 'Term' },
    Name: { key: 'title', paths: ['title', 'names.full'], label: 'Name' },
  };

/** The asks of a fact the writer has not answered yet; Route A waits for them. */
export function openAsks(fact: CaptureFact, choice: FactChoice): string[] {
  return fact.asks.filter((ask) => {
    const typed = TYPED_ASKS[ask];
    if (typed) return !choice.typed[typed.key]?.trim();
    if (ask === 'Community') return !choice.hint.communityId;
    if (ask === 'Character') return !choice.hint.characterId;
    return true;
  });
}

function setPath(data: Record<string, unknown>, path: string, value: unknown) {
  const [head, ...rest] = path.split('.');
  if (!head) return;
  if (!rest.length) {
    data[head] = value;
    return;
  }
  const inner = data[head] && typeof data[head] === 'object' ? { ...(data[head] as object) } : {};
  setPath(inner as Record<string, unknown>, rest.join('.'), value);
  data[head] = inner;
}

/** The fact's drafts with the writer's typed names in place. */
export function draftsWith(fact: CaptureFact, choice: FactChoice): CaptureDraft[] {
  const typed = Object.entries(TYPED_ASKS).filter(
    ([ask, t]) => fact.asks.includes(ask) && choice.typed[t.key]?.trim(),
  );
  if (!typed.length) return fact.drafts;
  return fact.drafts.map((d, i) => {
    if (d.op !== 'create' || i !== fact.drafts.findIndex((x) => x.op === 'create')) return d;
    const data = { ...(d.data ?? {}) };
    for (const [, t] of typed) {
      const value = (choice.typed[t.key] ?? '').trim();
      for (const path of t.paths) setPath(data, path, value);
    }
    return { ...d, data };
  });
}
