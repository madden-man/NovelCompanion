/**
 * IPC channels for the session selection and the manuscript (M7: MS-1 to
 * MS-5, SB-1 to SB-9). Kept apart from `ipc.ts` so
 * other milestones can add channels there without touching these; `ipc.ts`
 * spreads this object into its contract, so every rule there (zod on both
 * sides, preload validation) applies.
 */
import { z } from 'zod';
import { Year } from './schema/common';

const EntryId = z.string().min(1).max(64);
/**
 * AI-1: a run ID the renderer picks before a Claude-written summary starts, so it follows the stream (`claude.stream`) and can stop the run
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
  'moments',
  'era',
  'eventsWindow',
  'eventsFormative',
  'culture',
  'places',
  'plannedAhead',
  'previousChapters',
  'glossary',
  'openQuestions',
  'decidedQuestions',
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
  /** a47-model (IP-9): the status kind SB-5 reads. */
  kind: z.enum(['canon', 'planned', 'idea']).optional(),
  note: z.string(),
  detail: z.string(),
  refs: z.array(z.string()),
  state: LifeState.optional(),
  year: z.number().nullable().optional(),
  endYear: z.number().optional(),
  community: z.string().optional(),
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
      endYear: z.number().nullable(),
      setting: z.strictObject({
        placeIds: z.array(z.string()),
        source: z.enum(['strand', 'livesIn', 'none']),
        characterId: z.string().nullable(),
        note: z.string(),
      }),
      communities: z.array(z.strictObject({ id: z.string(), label: z.string() })),
      backstory: z.strictObject({
        from: z.number(),
        to: z.number(),
        label: z.string(),
        people: z.array(
          z.strictObject({
            characterId: z.string(),
            name: z.string(),
            ages: z.string(),
            /** SM-3: the character's moments in the backstory years. */
            rows: z.array(
              z.strictObject({
                id: z.string(),
                year: z.number(),
                endYear: z.number().nullable(),
                title: z.string(),
                body: z.string(),
                worldContext: z.string(),
                status: z.string(),
              }),
            ),
          }),
        ),
      }),
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
  /** a47-model (IP-11): years the window looks past the story year. */
  ahead: z.number().optional(),
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

const BriefSettings = z.strictObject({
  window: z.int().min(0).max(200),
  budget: z.int().min(0).max(10_000_000),
});

const DiffLineWire = z.strictObject({
  kind: z.enum(['same', 'added', 'removed']),
  text: z.string(),
  line: z.int(),
});

export const sessionContract = {
  /**
   * The "Relevant to Session" view and SB-2: the deterministic selection for
   * a chapter, a strand, a part, or a year and point of view.
   */
  'session.relevant': {
    request: z.strictObject({ input: BriefInputWire, ...Overrides }),
    response: z.strictObject({ selection: SelectionWire }),
  },
  /** SB-2 window and SB-6 budget. */
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
  /** MS-1: where chapters can be imported from. */
  'manuscript.sources': {
    request: z.strictObject({}),
    response: z.strictObject({
      sources: z.array(
        z.strictObject({
          id: z.string(),
          label: z.string(),
          /** Where the document is chosen: a file dialog in main. */
          picker: z.enum(['dialog']),
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
} as const;
