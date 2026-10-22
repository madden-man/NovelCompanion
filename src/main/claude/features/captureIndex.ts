import { z } from 'zod';
import {
  CAPTURE_ROUTES,
  CAPTURE_SECTIONS,
  buildIndex,
  routeCapture,
} from '../../../shared/domain/captureRouter';
import type {
  CaptureFact,
  CaptureHint,
  CaptureRouting,
  RouterIndexInput,
} from '../../../shared/domain/captureRouter';
import type { EntryCollection } from '../../../shared/schema';
import type { StoryTimeValue } from '../../../shared/storyTime';
import type { OpenBible } from '../../db/session';

/**
 * Capture routing on main's side (A48, CR-1, CR-9). Main builds the same
 * `RouterIndex` the renderer builds, from the same documents, and reruns the
 * router on the text with the box's hints, so both see the same facts. The
 * facts a run handles go into its input (saved with the run, never over IPC).
 */

/** The entry collections the router reads. */
const ROUTER_COLLECTIONS = [
  'characters',
  'places',
  'culturalEntries',
  'moments',
  'glossaryTerms',
] as const satisfies readonly EntryCollection[];

/** The lists and the live entries the router matches against, and the timeline end. */
export function indexFromSession(session: OpenBible): RouterIndexInput {
  const lists = session.model.all('lists').map((doc) => ({
    _id: String(doc._id),
    items: Array.isArray(doc.items)
      ? (doc.items as { id: string; label: string; parentId?: string | null }[])
      : [],
  }));
  const entries: RouterIndexInput['entries'] = {};
  for (const c of ROUTER_COLLECTIONS) {
    entries[c] = session.model.all(c).filter((d) => !d.deletedAt);
  }
  return { lists, entries, timelineEnd: session.repo.bibleSettings().numbers.timelineEnd };
}

/** The community of the writing strand's first place, when a strand is picked. */
export function povCommunityId(session: OpenBible, t: StoryTimeValue): string | null {
  if (!t.chapterId || !t.strandId) return null;
  const chapter = session.model.get('chapters', t.chapterId);
  if (!chapter || chapter.deletedAt) return null;
  const strands = Array.isArray(chapter.strands)
    ? (chapter.strands as { id: string; placeIds?: string[] }[])
    : [];
  const placeId = strands.find((s) => s.id === t.strandId)?.placeIds?.[0];
  const place = placeId ? session.model.get('places', placeId) : undefined;
  return place && !place.deletedAt && typeof place.communityId === 'string'
    ? place.communityId
    : null;
}

/** CR-9: the router rerun on the text with the box's hints. */
export function routeForCapture(
  session: OpenBible,
  text: string,
  storyTime: StoryTimeValue,
  hints: CaptureHint[] = [],
): CaptureRouting {
  return routeCapture(text, buildIndex(indexFromSession(session)), {
    storyYear: storyTime.year,
    povCommunityId: povCommunityId(session, storyTime),
    hints,
  });
}

const Section = z.enum(CAPTURE_SECTIONS);
const Year = z.number().int().min(-10000).max(10000);

/**
 * A routed fact as a run's input holds it: the `CaptureFact` of the contract,
 * checked when the run starts. Loose objects, so a field the router adds is
 * kept in the saved input rather than dropped.
 */
export const CaptureFactInput = z.looseObject({
  index: z.number().int().min(0),
  text: z.string().trim().min(1).max(8000),
  years: z.looseObject({ start: Year, end: Year.nullable(), source: z.string() }),
  sentences: z.number().int().min(0),
  candidates: z.array(
    z.looseObject({
      kind: z.enum([
        'character',
        'place',
        'community',
        'demonym',
        'category',
        'glossary',
        'ageGroup',
        'unknown',
      ]),
      id: z.string().nullable(),
      label: z.string(),
      matched: z.string(),
      communityId: z.string().nullable().optional(),
    }),
  ),
  scores: z.partialRecord(Section, z.number()),
  cues: z.partialRecord(Section, z.array(z.string())),
  ranked: z.array(z.tuple([Section, z.number()])),
  section: Section,
  share: z.number(),
  margin: z.number(),
  communities: z.array(z.looseObject({ id: z.string(), why: z.string() })),
  missing: z.array(z.string()),
  asks: z.array(z.string()),
  reasons: z.array(z.string()),
  drafts: z.array(
    z.looseObject({
      op: z.enum(['create', 'update', 'listAdd']),
      collection: z.string().optional(),
      targetId: z.string().nullable().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      listId: z.string().optional(),
      label: z.string().optional(),
      parentId: z.string().nullable().optional(),
      ref: z.string().optional(),
    }),
  ),
  route: z.enum(CAPTURE_ROUTES),
}) as unknown as z.ZodType<CaptureFact>;

/** The facts one run handles, with the story year and the bible's timeline end. */
export const RunRouting = z.strictObject({
  storyYear: Year,
  timelineEnd: Year,
  facts: z.array(CaptureFactInput).max(50),
});
export type RunRouting = z.infer<typeof RunRouting>;

/** The facts of a routing on one route, ready for a run's input. */
export function routingFor(
  routing: CaptureRouting,
  route: 'fast' | 'full',
  timelineEnd: number,
): RunRouting {
  return {
    storyYear: routing.storyYear,
    timelineEnd,
    facts: routing.facts.filter((f) => f.route === route),
  };
}

/** The IDs of one kind of candidate in a fact. */
export const candidateIds = (fact: CaptureFact, kind: CaptureFact['candidates'][number]['kind']) =>
  fact.candidates.flatMap((c) => (c.kind === kind && c.id ? [c.id] : []));

/** A share of the points in words, for the prompt: "72% of the points". */
export const shareWords = (share: number): string =>
  `${Math.round(Math.max(0, Math.min(1, share)) * 100)}% of the points`;

/** A fact's years in words: "2065 to 2069", "from 2065, open ended", with where they came from. */
export function yearWords(years: CaptureFact['years']): string {
  const span =
    years.end === null
      ? `from ${years.start}, open ended`
      : years.end === years.start
        ? `${years.start}`
        : `${years.start} to ${years.end}`;
  return `${span} (${years.source})`;
}
