/**
 * IPC channels for sessions, briefs, the dashboard, and the manuscript (M7:
 * MS-1 to MS-5, SB-1 to SB-9, DB-1 to DB-4). Kept apart from `ipc.ts` so
 * other milestones can add channels there without touching these; `ipc.ts`
 * spreads this object into its contract, so every rule there (zod on both
 * sides, preload validation) applies.
 */
import { z } from 'zod';
import { Year } from './schema/common';
import { StoryTimeValue } from './storyTime';

const EntryId = z.string().min(1).max(64);
/**
 * AI-1: a run ID the renderer picks before a Claude-written brief or summary
 * starts, so it follows the stream (`claude.stream`) and can stop the run
 * (`claude.stop`). The same shape as `RUN_ID` in src/main/claude/runtime.ts.
 */
const RunId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Entry = z.looseObject({ _id: z.string().min(1), modifiedAt: z.string() });

export const BriefInputWire = z.union([
  z.strictObject({ kind: z.literal('chapter'), chapterId: EntryId }),
  z.strictObject({
    kind: z.literal('strand'),
    chapterId: EntryId,
    strandId: z.string().min(1).max(64),
  }),
  z.strictObject({ kind: z.literal('part'), partId: EntryId }),
  z.strictObject({
    kind: z.literal('pov'),
    year: Year,
    povCharacterId: EntryId,
    placeIds: z.array(EntryId).max(200).optional(),
    characterIds: z.array(EntryId).max(500).optional(),
  }),
]);

const GROUP_KINDS = [
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
  'previousChapters',
  'beats',
  'glossary',
  'themes',
  'openQuestions',
  'decidedQuestions',
  'custom',
  'sessionNote',
  'added',
] as const;

const LifeState = z.union([
  z.strictObject({ state: z.literal('alive'), age: z.number(), dyingThisYear: z.boolean() }),
  z.strictObject({ state: z.literal('dead'), deathYear: z.number() }),
  z.strictObject({ state: z.literal('unborn'), birthYear: z.number() }),
  z.strictObject({ state: z.literal('unknown') }),
]);

const ItemWire = z.strictObject({
  id: z.string(),
  collection: z.string(),
  title: z.string(),
  status: z.string(),
  note: z.string(),
  detail: z.string(),
  refs: z.array(z.string()),
  state: LifeState.optional(),
  year: z.number().nullable().optional(),
  endYear: z.number().optional(),
});

const GroupWire = z.strictObject({
  kind: z.enum(GROUP_KINDS),
  step: z.int(),
  title: z.string(),
  items: z.array(ItemWire),
});

export const SelectionWire = z.strictObject({
  input: BriefInputWire,
  label: z.string(),
  year: z.number(),
  chapterIds: z.array(z.string()),
  strands: z.array(
    z.strictObject({
      chapterId: z.string().nullable(),
      strandId: z.string().nullable(),
      label: z.string(),
      primary: z.boolean(),
      year: z.number(),
      povCharacterId: z.string().nullable(),
      povName: z.string().nullable(),
      placeIds: z.array(z.string()),
      communities: z.array(z.strictObject({ id: z.string(), label: z.string() })),
      groups: z.array(GroupWire),
    }),
  ),
  shared: z.array(GroupWire),
  omitted: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      kind: z.enum(GROUP_KINDS),
      reason: z.enum(['budget', 'removed']),
    }),
  ),
  /** Strands left out because they have no start year. */
  skippedStrands: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  window: z.number(),
  budget: z.number(),
  size: z.number(),
  leadSize: z.number(),
  overBudget: z.boolean(),
  ids: z.array(z.string()),
});

const Overrides = {
  add: z.array(EntryId).max(500).default([]),
  remove: z.array(EntryId).max(5000).default([]),
};

const BriefResult = z.strictObject({
  brief: Entry,
  /** True when Claude wrote it (SB-4); false for the structured brief (SB-7). */
  synthesized: z.boolean(),
  /** Why the brief is the structured one, in plain words, or null. */
  note: z.string().nullable(),
  /** ARCH-4: the note is about a missing or rejected key, so the screen links to Settings. */
  needsSettings: z.boolean(),
  /** SB-4: cited IDs that are not in the manifest. */
  problems: z.array(z.string()),
  /** SB-4: lines of a Claude-written brief that cite nothing. */
  uncited: z.array(z.string()),
});

const BriefSettings = z.strictObject({
  window: z.int().min(0).max(200),
  budget: z.int().min(0).max(10_000_000),
  /** DB-4: the model briefs are written with (M6 owns the setting). */
  model: z.string(),
  /** False until the Claude runtime registers a brief writer. */
  claudeAvailable: z.boolean(),
});

const DiffLineWire = z.strictObject({
  kind: z.enum(['same', 'added', 'removed']),
  text: z.string(),
  line: z.int(),
});

export const sessionContract = {
  /**
   * The "Relevant to Session" view and SB-2: the deterministic selection for
   * a chapter, a strand, a part, or a year and point of view, and the
   * structured brief made from it (SB-7).
   */
  'session.relevant': {
    request: z.strictObject({ input: BriefInputWire, ...Overrides }),
    response: z.strictObject({ selection: SelectionWire, structured: z.string() }),
  },
  /** SB-2 window and SB-6 budget, plus the brief model (DB-4). */
  'brief.settings.get': {
    request: z.strictObject({}),
    response: BriefSettings,
  },
  'brief.settings.set': {
    request: z.strictObject({
      window: z.int().min(0).max(200).optional(),
      budget: z.int().min(0).max(10_000_000).optional(),
    }),
    response: BriefSettings,
  },
  /**
   * DB-2, DB-3: start a session for a section. Runs the selection, writes the
   * brief (Claude when available, else the structured brief), saves it, makes
   * a session log entry linked to the section and the brief, and sets the
   * story time to the section's year.
   */
  'session.start': {
    request: z.strictObject({ input: BriefInputWire, ...Overrides, runId: RunId.optional() }),
    response: BriefResult.extend({ log: Entry, time: StoryTimeValue.nullable() }),
  },
  /** SB-9: change what the brief selects and write it again. The brief keeps its ID. */
  'brief.regenerate': {
    request: z.strictObject({ id: EntryId, ...Overrides, runId: RunId.optional() }),
    response: BriefResult,
  },
  /** SB-8: save a brief as Markdown or PDF where the person chooses. */
  'brief.export': {
    request: z.strictObject({ id: EntryId, format: z.enum(['markdown', 'pdf']) }),
    response: z.strictObject({ saved: z.boolean(), path: z.string().nullable() }),
  },
  /** MS-1: where chapters can be imported from. */
  'manuscript.sources': {
    request: z.strictObject({}),
    response: z.strictObject({
      sources: z.array(
        z.strictObject({
          id: z.string(),
          label: z.string(),
          /** Where the document is chosen: a file dialog in main, or the Drive browser in the page. */
          picker: z.enum(['dialog', 'drive']),
        }),
      ),
    }),
  },
  /**
   * MS-1, MS-4: read a chapter's manuscript, from a new document (a source
   * ID) or again from its linked one, and compare it with the text the bible
   * holds. Nothing is written. Null token when the person cancelled.
   */
  'manuscript.read': {
    request: z.strictObject({
      chapterId: EntryId,
      sourceId: z.string().min(1).max(32).optional(),
      /** For a source picked in the page (Google Docs): the document chosen there. */
      locator: z.string().min(1).max(256).optional(),
    }),
    response: z.strictObject({
      token: z.string().nullable(),
      name: z.string(),
      source: z.string(),
      modifiedAt: z.string(),
      body: z.string(),
      changed: z.boolean(),
      added: z.int(),
      removed: z.int(),
      summaryOutOfDate: z.boolean(),
      diff: z.array(DiffLineWire),
    }),
  },
  /** MS-1, MS-4: store what was read into the chapter (its text, source, and the summary flag). */
  'manuscript.apply': {
    request: z.strictObject({ token: z.string().min(1), baseModifiedAt: z.string().min(1) }),
    response: z.strictObject({ entry: Entry, before: z.record(z.string(), z.unknown()) }),
  },
  /** MS-3: the planned entries a chapter establishes, for promotion to canon one by one. */
  'chapter.establishes': {
    request: z.strictObject({ chapterId: EntryId }),
    response: z.strictObject({
      items: z.array(
        z.strictObject({
          id: z.string(),
          collection: z.string(),
          title: z.string(),
          why: z.string(),
        }),
      ),
    }),
  },
  /** MS-2: a generated summary to approve or edit. Nothing is saved. */
  'chapter.summarize': {
    request: z.strictObject({ chapterId: EntryId, runId: RunId.optional() }),
    response: z.strictObject({
      available: z.boolean(),
      draft: z.string(),
      model: z.string().nullable(),
      message: z.string().nullable(),
      needsSettings: z.boolean(),
    }),
  },
  /** DB-1: what the dashboard shows. */
  'dashboard.get': {
    request: z.strictObject({}),
    response: z.strictObject({
      lastLog: z
        .strictObject({
          id: z.string(),
          date: z.string(),
          chapter: z.string().nullable(),
          stoppedAt: z.string(),
          notes: z.string(),
          briefId: z.string().nullable(),
        })
        .nullable(),
      position: z
        .strictObject({
          chapterId: z.string(),
          title: z.string(),
          readingOrder: z.number(),
          year: z.number().nullable(),
        })
        .nullable(),
      openQuestions: z.int().min(0),
      rewriteTasks: z.array(
        z.strictObject({
          id: z.string(),
          chapterId: z.string().nullable(),
          chapter: z.string().nullable(),
          text: z.string(),
          quote: z.string(),
          lines: z.string(),
        }),
      ),
      recentLogs: z.array(
        z.strictObject({
          id: z.string(),
          date: z.string(),
          chapter: z.string().nullable(),
          text: z.string(),
          briefId: z.string().nullable(),
        }),
      ),
    }),
  },
} as const;
