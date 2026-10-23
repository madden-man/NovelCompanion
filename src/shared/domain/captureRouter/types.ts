/**
 * Capture routing (A48, CR-1 to CR-10): the contract between the pure router
 * (`src/shared/domain/captureRouter/`), the capture box (renderer) and the
 * capture features (main). The renderer and main both build a `RouterIndex`
 * from the bible's lists and entries and run the same `routeCapture`, so the
 * facts, candidates and routes they see are identical. Only `CaptureHint`
 * crosses IPC, and it carries IDs and numbers, never free text (AI-4).
 */
import { z } from 'zod';
import type { EntryCollection } from '../../schema';

/** Where a fact goes: filed from the box (A), one small Haiku call (B), or today's capture with tools (C). */
export type CaptureRoute = 'local' | 'fast' | 'full';
export const CAPTURE_ROUTES = ['local', 'fast', 'full'] as const;

/** The sections a capture can file into. */
export const CAPTURE_SECTIONS = [
  'culturalEntries',
  'moments',
  'worldEvents',
  'places',
  'glossaryTerms',
  'openQuestions',
  'characters',
] as const satisfies readonly EntryCollection[];
export type CaptureSection = (typeof CAPTURE_SECTIONS)[number];

/** What `buildIndex` takes: plain documents, as main's read model and the renderer's store hold them. */
export interface RouterIndexInput {
  lists: { _id: string; items: { id: string; label: string; parentId?: string | null }[] }[];
  entries: Partial<Record<EntryCollection, Record<string, unknown>[]>>;
  /** `bibleSettings.numbers.timelineEnd`: the open end of a cultural line. */
  timelineEnd: number;
}

export interface IndexedCharacter {
  id: string;
  name: string;
  /** Lowercase: the full name, the first name, the Chinese name, and lexicon aliases. */
  aliases: string[];
  /** a48-router: aliases that are ordinary English words ("mark"), matched only when capitalised. */
  capitalOnly?: string[];
}
export interface IndexedPlace {
  id: string;
  name: string;
  communityId: string | null;
  aliases: string[];
  /** a48-router: the place it sits in, so a world event can take the region of a larger place. */
  parentId?: string | null;
}
export interface IndexedCommunity {
  id: string;
  label: string;
  parentId: string | null;
  aliases: string[];
  /** Words for its people ("chinese" for china-national). */
  demonyms: string[];
}
export interface IndexedCategory {
  id: string;
  label: string;
  parentId: string | null;
  /** Words that suggest this category. */
  cues: string[];
}
export interface IndexedAgeGroup {
  id: string;
  label: string;
  words: string[];
}
export interface IndexedLine {
  id: string;
  communityId: string;
  startYear: number | null;
  endYear: number | null;
  title: string;
}
export interface IndexedMoment {
  id: string;
  characterId: string;
  year: number | null;
  title: string;
}

/** Everything the router matches against. Pure data, built once per capture. */
export interface RouterIndex {
  characters: IndexedCharacter[];
  places: IndexedPlace[];
  communities: IndexedCommunity[];
  categories: IndexedCategory[];
  glossary: { id: string; characters: string; romanization: string }[];
  ageGroups: IndexedAgeGroup[];
  culturalLines: IndexedLine[];
  moments: IndexedMoment[];
  timelineEnd: number;
  /** a48-router: the `regions` list, so a world event's regions are item IDs (IP-8) or new items (IP-17). */
  regions?: { id: string; label: string }[];
  /** A51: the `momentKinds` list's item IDs, so a move is drafted as a move only when the list holds it. */
  momentKinds?: string[];
}

export type CandidateKind =
  | 'character'
  | 'place'
  | 'community'
  | 'demonym'
  | 'category'
  | 'glossary'
  | 'ageGroup'
  | 'unknown';

/** A name the router resolved (or could not) in one fact. */
export interface CaptureCandidate {
  kind: CandidateKind;
  /** The entry or list item ID; null for an unknown name. */
  id: string | null;
  label: string;
  /** The alias that matched, lowercase. */
  matched: string;
  /** For a place: its community. For a demonym: the community it names. */
  communityId?: string | null;
}

/**
 * What a fact would write, in the shape of main's `ProposalDraft` so the
 * same validation runs on every route. Route A writes `create` and `listAdd`
 * drafts from the box; routes B and C hand them to Claude as the starting
 * point.
 */
export interface CaptureDraft {
  op: 'create' | 'update' | 'listAdd';
  collection?: EntryCollection;
  targetId?: string | null;
  data?: Record<string, unknown>;
  listId?: string;
  label?: string;
  parentId?: string | null;
  /** IP-17: "new:jinan", used as the value in the drafts that need the new item. */
  ref?: string;
}

/** One sentence of a capture, routed. */
export interface CaptureFact {
  /** Position in the capture, from 0. */
  index: number;
  /** The sentence as typed. */
  text: string;
  years: {
    start: number;
    /** null is open. */
    end: number | null;
    /** Plain words: "a year in the text", "the story year", "the year of the sentence before". */
    source: string;
  };
  sentences: number;
  candidates: CaptureCandidate[];
  /** Points per section, highest first in `ranked`. */
  scores: Partial<Record<CaptureSection, number>>;
  /** The cue labels that scored, per section, for the box to show. */
  cues: Partial<Record<CaptureSection, string[]>>;
  ranked: [CaptureSection, number][];
  section: CaptureSection;
  /** The top section's share of all points, 0 to 1, and its lead over the runner-up in points. */
  share: number;
  margin: number;
  /** Community candidates in preference order, with why. */
  communities: { id: string; why: string }[];
  /** Required fields the router could not fill. */
  missing: string[];
  /** The chips the box must ask for before Route A can file ("Community", "Character"). */
  asks: string[];
  /** Why this fact needs judgment (an unknown name, a category to pick, two subjects). Empty on Route A. */
  reasons: string[];
  drafts: CaptureDraft[];
  route: CaptureRoute;
}

export interface CaptureRouting {
  text: string;
  storyYear: number;
  facts: CaptureFact[];
}

/** The thresholds of CR-5. Constants now; a setting later. */
export interface RouteThresholds {
  /** Route A needs this share of the points (0.55) and this lead in points (20). */
  localShare: number;
  localMargin: number;
  /** Route B needs this share (0.40). */
  fastShare: number;
}
export const DEFAULT_THRESHOLDS: RouteThresholds = {
  localShare: 0.55,
  localMargin: 20,
  fastShare: 0.4,
};

/**
 * A chip the writer changed, or a route they forced, for one fact. It crosses
 * IPC with `claude.capture`, so it holds IDs and numbers only; main reruns
 * the router on the text with these applied and gets the same facts.
 */
export const CaptureHint = z.strictObject({
  fact: z.number().int().min(0),
  route: z.enum(CAPTURE_ROUTES).optional(),
  section: z.enum(CAPTURE_SECTIONS).optional(),
  communityId: z.string().min(1).max(64).optional(),
  characterId: z.string().min(1).max(64).optional(),
  categoryId: z.string().min(1).max(64).optional(),
  demographic: z.string().min(1).max(64).optional(),
  startYear: z.number().int().min(-10000).max(10000).optional(),
  endYear: z.number().int().min(-10000).max(10000).nullable().optional(),
});
export type CaptureHint = z.infer<typeof CaptureHint>;

export interface RouteOptions {
  storyYear: number;
  /** The community of the writing strand's place, when one is picked; the last resort for a missing community. */
  povCommunityId?: string | null;
  thresholds?: RouteThresholds;
  hints?: CaptureHint[];
}
