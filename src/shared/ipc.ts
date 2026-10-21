import { z } from 'zod';
import { BibleName, BibleSlug } from './bible';
import {
  ENTRY_COLLECTIONS,
  ListIdParam,
  Proposal,
  Provenance,
  Status,
  entrySchemas,
  manifests,
} from './schema';
import { StoryTimeValue } from './storyTime';
import { sessionContract } from './ipcSession';
import { claudeContract, claudeEvents } from './claude';
import { Cell, Mapping } from './domain/import/types';
import { SnapshotManifest } from './domain/snapshots';
import { driveContract } from './ipcDrive';
import { continuityContract } from './ipcContinuity';
import { appContract, appEvents } from './ipcApp';
import { wordsContract } from './ipcWords';
import type { EntryCollection } from './schema';

const BibleSummary = z.strictObject({ id: z.string().min(1), name: z.string().min(1) });

export const CollectionName = z.enum(ENTRY_COLLECTIONS as [EntryCollection, ...EntryCollection[]]);

const EntryId = z.string().min(1).max(64);

/** An entry as it travels to the renderer. Main has already validated it with its schema. */
export const WireEntry = z.looseObject({ _id: z.string().min(1), modifiedAt: z.string() });
export type WireEntry = z.output<typeof WireEntry>;

export const WireWarning = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

const WireBacklink = z.strictObject({
  collection: CollectionName,
  id: z.string(),
  kind: z.string(),
  title: z.string(),
});

const WithWarnings = z.strictObject({ entry: WireEntry, warnings: z.array(WireWarning) });

const SYSTEM_FIELDS = ['createdAt', 'modifiedAt', 'deletedAt'];

/** Derived fields (read from other entries) take a list of IDs and are not part of the stored schema. */
const derivedNames = (c: EntryCollection) =>
  manifests[c].filter((s) => s.derived).map((s) => s.name);
const DerivedIds = z.array(z.string().min(1));
const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';

/** Check a whole new entry against its collection's schema, as the write path will. */
function checkNewEntry(
  v: { collection: EntryCollection; data: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  for (const k of SYSTEM_FIELDS) {
    if (k in v.data)
      ctx.addIssue({ code: 'custom', path: ['data', k], message: `${k} is set by the app` });
  }
  const derived = derivedNames(v.collection);
  const stored = Object.fromEntries(Object.entries(v.data).filter(([k]) => !derived.includes(k)));
  for (const k of derived) {
    if (k in v.data && !DerivedIds.safeParse(v.data[k]).success) {
      ctx.addIssue({ code: 'custom', path: ['data', k], message: `${k} must be a list of IDs` });
    }
  }
  const r = entrySchemas[v.collection].safeParse({
    ...stored,
    _id: typeof v.data._id === 'string' ? v.data._id : 'NEW',
    createdAt: PLACEHOLDER_TIME,
    modifiedAt: PLACEHOLDER_TIME,
  });
  if (!r.success) {
    for (const issue of r.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', ...issue.path.map(String)],
        message: issue.message,
      });
    }
  }
}

/** Check each field of a patch against its collection's schema. */
function checkPatch(
  v: { collection: EntryCollection; patch: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const shape = (entrySchemas[v.collection] as unknown as { shape: Record<string, z.ZodType> })
    .shape;
  for (const [k, value] of Object.entries(v.patch)) {
    if (k === '_id' || SYSTEM_FIELDS.includes(k)) {
      ctx.addIssue({ code: 'custom', path: ['patch', k], message: `${k} is set by the app` });
      continue;
    }
    const field = derivedNames(v.collection).includes(k) ? DerivedIds : shape[k];
    if (!field) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch', k],
        message: `${v.collection} has no field ${k}`,
      });
      continue;
    }
    const r = field.safeParse(value);
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['patch', k, ...issue.path.map(String)],
          message: issue.message,
        });
      }
    }
  }
}

const EntryRef = z.strictObject({ collection: CollectionName, id: EntryId });

export const WireListItem = z.strictObject({
  id: z.string(),
  label: z.string(),
  parentId: z.string().nullable(),
  usage: z.int().min(0),
  detail: z.string().optional(),
});

export const WireList = z.strictObject({
  _id: ListIdParam,
  label: z.string(),
  derived: z.boolean(),
  fixedItems: z.boolean(),
  items: z.array(WireListItem),
});
export type WireList = z.output<typeof WireList>;

/** A proposal with what it would change against the entry as it is now. */
const ProposalView = z.strictObject({
  proposal: Proposal,
  targetTitle: z.string().nullable(),
  changes: z.array(z.strictObject({ path: z.string(), before: z.unknown(), after: z.unknown() })),
  conflict: z.boolean(),
});
export type ProposalView = z.output<typeof ProposalView>;

const StoryDateWire = z.union([
  z.strictObject({
    year: z.number(),
    month: z.number().optional(),
    day: z.number().optional(),
  }),
  z.strictObject({ unknown: z.literal(true) }),
]);

const TreePersonWire = z.strictObject({
  id: z.string(),
  name: z.string(),
  chinese: z.string(),
  birth: StoryDateWire.nullable(),
  death: StoryDateWire.nullable(),
  familyIds: z.array(z.string()),
  status: z.string(),
  createdAt: z.string(),
});

const TreeUnionWire = z.strictObject({
  id: z.string(),
  a: z.string(),
  b: z.string(),
  type: z.string(),
  startYear: z.number().nullable(),
  endYear: z.number().nullable(),
  endReason: z.string(),
  createdAt: z.string(),
});

const TreeLinkWire = z.strictObject({
  id: z.string(),
  parentId: z.string(),
  childId: z.string(),
  type: z.string(),
  startYear: z.number().nullable(),
  createdAt: z.string(),
});

const TreePositions = z
  .record(
    z.string().min(1).max(64),
    z.strictObject({ x: z.number(), y: z.number(), loose: z.boolean().optional() }),
  )
  .refine((r) => Object.keys(r).length <= 20_000, 'Too many positions');

const TreeWarningWire = z.strictObject({
  code: z.enum([
    'parent-age',
    'born-after-parent-death',
    'overlapping-unions',
    'born-before-union',
  ]),
  message: z.string(),
  personIds: z.array(z.string()),
  entryIds: z.array(z.string()),
});

const LifeStateWire = z.union([
  z.strictObject({ state: z.literal('alive'), age: z.number(), dyingThisYear: z.boolean() }),
  z.strictObject({ state: z.literal('dead'), deathYear: z.number() }),
  z.strictObject({ state: z.literal('unborn'), birthYear: z.number() }),
  z.strictObject({ state: z.literal('unknown') }),
]);

const PositionWire = z.strictObject({
  year: z.number().nullable(),
  source: z.enum(['storyTime', 'lastWritten', 'none']),
  chapterId: z.string().nullable(),
});

const StoryTimeResponse = z.strictObject({
  time: StoryTimeValue.nullable(),
  position: PositionWire,
});

const CharacterPageWire = z.strictObject({
  id: z.string(),
  name: z.string(),
  names: z.strictObject({
    full: z.string(),
    chinese: z.string(),
  }),
  families: z.array(z.strictObject({ id: z.string(), name: z.string(), color: z.string() })),
  years: z.string(),
  birthKnown: z.boolean(),
  current: z.strictObject({
    year: z.number().nullable(),
    chapterId: z.string().nullable(),
    chapter: z.string().nullable(),
    readingOrder: z.number().nullable(),
    state: LifeStateWire.nullable(),
  }),
  storyTime: z
    .strictObject({
      year: z.number(),
      month: z.number().optional(),
      day: z.number().optional(),
      state: LifeStateWire,
    })
    .nullable(),
  relatives: z.strictObject({
    parents: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        startYear: z.number().nullable(),
      }),
    ),
    children: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        startYear: z.number().nullable(),
      }),
    ),
    siblings: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        kind: z.enum(['full', 'half', 'sibling']),
      }),
    ),
    partners: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        unionId: z.string(),
        type: z.string(),
        startYear: z.number().nullable(),
        endYear: z.number().nullable(),
        endReason: z.string(),
      }),
    ),
  }),
});

const Moment = z.strictObject({
  year: z.int().min(-10000).max(10000),
  month: z.int().min(1).max(12).optional(),
  day: z.int().min(1).max(31).optional(),
});

const EraWire = z.strictObject({
  id: z.string(),
  name: z.string(),
  startYear: z.number(),
  endYear: z.number(),
  body: z.string(),
});

const EventWire = z.strictObject({
  id: z.string(),
  title: z.string(),
  start: StoryDateWire.nullable(),
  end: StoryDateWire.nullable(),
  startYear: z.number(),
  endYear: z.number(),
  categoryId: z.string(),
  regions: z.array(z.string()),
  characterIds: z.array(z.string()),
  formative: z.boolean(),
  status: z.string(),
});

const ChartEventWire = EventWire.extend({ categoryPath: z.string(), categoryRoot: z.string() });

const StrandWire = z.strictObject({
  chapterId: z.string(),
  chapterTitle: z.string(),
  readingOrder: z.number().nullable(),
  chapterStatus: z.string(),
  written: z.boolean(),
  strandId: z.string(),
  label: z.string(),
  primary: z.boolean(),
  startYear: z.number(),
  endYear: z.number(),
  povCharacterId: z.string().nullable(),
  characterIds: z.array(z.string()),
  placeIds: z.array(z.string()),
});

const CoverageWire = z.strictObject({
  from: z.number(),
  to: z.number(),
  gaps: z.array(z.strictObject({ from: z.number(), to: z.number() })),
  overlaps: z.array(
    z.strictObject({
      ids: z.tuple([z.string(), z.string()]),
      names: z.tuple([z.string(), z.string()]),
      from: z.number(),
      to: z.number(),
    }),
  ),
  backwards: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});

const PersonInYearWire = z.strictObject({
  id: z.string(),
  name: z.string(),
  chinese: z.string(),
  familyIds: z.array(z.string()),
  status: z.string(),
  birthYear: z.number().nullable(),
  state: LifeStateWire,
});

const YearViewWire = z.strictObject({
  year: z.number(),
  at: Moment,
  alive: z.array(z.strictObject({ id: z.string(), age: z.number(), dyingThisYear: z.boolean() })),
  dead: z.array(z.strictObject({ id: z.string(), deathYear: z.number() })),
  unborn: z.array(z.string()),
  unknown: z.array(z.string()),
  rows: z.array(PersonInYearWire),
  era: EraWire.nullable(),
  /** Every era covering the year; more than one is an overlap (WE-2). */
  eras: z.array(EraWire),
  events: z.array(EventWire),
  strands: z.array(StrandWire),
});

const ChartFiltersWire = z.strictObject({
  familyId: z.string().min(1).nullable().default(null),
  placeId: z.string().min(1).nullable().default(null),
  status: z.string().min(1).nullable().default(null),
  categoryId: z.string().min(1).nullable().default(null),
});

const OutlineStrandWire = z.strictObject({
  id: z.string(),
  label: z.string(),
  primary: z.boolean(),
  startYear: z.number(),
  endYear: z.number(),
  pov: z.string().nullable(),
  present: z.array(z.string()),
});

/** A37: the line each chapter's section starts on, 0-based. */
const SceneBreaksWire = z.record(EntryId, z.int().min(0));
/** SM-5: the line of a scene's bullet, 0-based, to the scene's own story year. */
const SceneYearsWire = z.record(z.string().regex(/^(0|[1-9]\d*)$/), z.int().min(-10000).max(10000));
/** PL-5: the scene outline text, the chapters' breaks, the scenes' years, and when it was last saved. */
const SceneOutlineWire = z.strictObject({
  text: z.string(),
  breaks: SceneBreaksWire,
  years: SceneYearsWire,
  modifiedAt: z.string().nullable(),
});
/** PL-5: one saved version of the scene outline. */
const SceneVersionSummary = z.strictObject({
  id: z.string().min(1),
  /** First and last save in this version. */
  at: z.string(),
  until: z.string(),
  scenes: z.int().min(0),
  chars: z.int().min(0),
});

const OutlineWire = z.strictObject({
  order: z.enum(['reading', 'story']),
  years: z.array(z.number()),
  cursorYear: z.number().nullable(),
  rows: z.array(
    z.union([
      z.strictObject({
        kind: z.literal('book'),
        id: z.string(),
        title: z.string(),
        number: z.number().nullable(),
        label: z.string(),
        missing: z.boolean(),
        partCount: z.number(),
      }),
      z.strictObject({
        kind: z.literal('part'),
        id: z.string(),
        bookId: z.string(),
        title: z.string(),
        number: z.number().nullable(),
        label: z.string(),
        missing: z.boolean(),
        chapterCount: z.number(),
      }),
      z.strictObject({
        kind: z.literal('chapter'),
        id: z.string(),
        title: z.string(),
        readingOrder: z.number(),
        partId: z.string(),
        storyYear: z.number().nullable(),
        written: z.boolean(),
        strands: z.array(OutlineStrandWire),
      }),
    ]),
  ),
});

const Year = z.int().min(-10000).max(10000);

const SearchFiltersWire = z.strictObject({
  sections: z.array(CollectionName).optional(),
  status: z.array(Status).optional(),
  provenance: z.array(Provenance).optional(),
  familyId: EntryId.nullable().optional(),
  placeId: EntryId.nullable().optional(),
  tag: z.string().min(1).max(100).nullable().optional(),
  yearFrom: Year.nullable().optional(),
  yearTo: Year.nullable().optional(),
});

const ChapterPageWire = z.strictObject({
  id: z.string(),
  title: z.string(),
  readingOrder: z.number(),
  storyYear: z.number().nullable(),
  written: z.boolean(),
  strands: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      primary: z.boolean(),
      startYear: z.number(),
      endYear: z.number().nullable(),
      pov: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
      characters: z.array(
        z.strictObject({ id: z.string(), name: z.string(), state: LifeStateWire }),
      ),
      places: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    }),
  ),
});

const RomanizationWire = z.strictObject({
  languages: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      /** The system item ID in force for this language, or null for none. */
      systemId: z.string().nullable(),
      /** The checker for that system. Null with a system set means the app has no checker for it. */
      kind: z.enum(['pinyin', 'jyutping']).nullable(),
      /** Set when a system is in force but has no checker. */
      note: z.string().nullable(),
    }),
  ),
  systems: z.array(z.strictObject({ id: z.string(), label: z.string() })),
});

const RevisionSummary = z.strictObject({
  _id: z.string(),
  op: z.enum(['create', 'update', 'softDelete', 'restore']),
  at: z.string(),
  note: z.string().nullable(),
  proposalId: z.string().nullable(),
});

// ---------- import, snapshots, and backup (M5) ----------

/** A file the person picked. Main keeps the path; the page holds only this ID. */
export const ImportFileWire = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1),
  kind: z.enum(['workbook', 'document']),
  modifiedAt: z.iso.datetime({ offset: true }),
});

const ImportSheetWire = z.strictObject({
  name: z.string(),
  rows: z.int().min(0),
  columns: z.int().min(0),
  shape: z.enum(['table', 'grid']),
  headerRow: z.int().min(1),
  /** The first rows and columns, for choosing a shape and a header row. */
  preview: z.array(z.array(Cell)),
});

const ImportRowWire = z.strictObject({
  where: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  title: z.string(),
  values: z.array(z.strictObject({ label: z.string(), text: z.string() })),
});

const ConflictWire = z.strictObject({
  winner: z.enum(['incoming', 'existing']),
  claims: z.array(
    z.strictObject({ ref: z.string(), at: z.string(), value: z.string(), kept: z.boolean() }),
  ),
});

const ChangeItemWire = z.strictObject({
  id: z.string(),
  kind: z.enum(['new', 'changed']),
  collection: CollectionName,
  title: z.string(),
  ref: z.string(),
  note: z.string().optional(),
  /** IDs of the new items this one points at (a part, a book, a character stub). Approving it approves them too. */
  needs: z.array(z.string()).optional(),
  deltas: z.array(
    z.strictObject({
      path: z.string(),
      label: z.string(),
      before: z.string(),
      after: z.string(),
      outcome: z.enum(['apply', 'keep']),
      conflict: ConflictWire.optional(),
    }),
  ),
});

const FailedRowWire = z.strictObject({ where: z.string(), ref: z.string(), reason: z.string() });

export const ImportPlanWire = z.strictObject({
  planId: z.string().min(1),
  file: z.string(),
  created: z.int().min(0),
  changed: z.int().min(0),
  unchanged: z.int().min(0),
  conflicts: z.int().min(0),
  listAdds: z.array(z.string()),
  failed: z.array(FailedRowWire),
  items: z.array(ChangeItemWire),
  notes: z.array(z.string()),
});

const DocumentTargetWire = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('backstory'), characterId: EntryId }),
  z.strictObject({
    kind: z.literal('chapter'),
    chapterId: EntryId.nullable(),
    title: z.string().max(500).optional(),
    partId: EntryId.optional(),
    year: z.int().min(-10000).max(10000).optional(),
  }),
  z.strictObject({ kind: z.literal('note'), title: z.string().trim().min(1).max(500) }),
]);

export const SnapshotWire = SnapshotManifest.extend({ id: z.string().min(1) });

/**
 * The IPC contract (ARCHITECTURE rule 3). Every channel the renderer can call
 * has a zod request and response schema. The preload validates both sides,
 * and the main process validates both sides again.
 */
export const contract = {
  'app.ping': {
    request: z.strictObject({ message: z.string().min(1).max(200) }),
    response: z.strictObject({ message: z.string(), receivedAt: z.iso.datetime() }),
  },
  'bible.list': {
    request: z.strictObject({}),
    response: z.strictObject({
      connection: z.enum(['connected', 'unavailable']),
      /** A plain-language explanation when the connection is unavailable. */
      message: z.string().optional(),
      bibles: z.array(BibleSummary),
    }),
  },
  /** Register a new, empty bible (ARCH-8). It does not open it. */
  'bible.create': {
    request: z.strictObject({ slug: BibleSlug, name: BibleName }),
    response: z.strictObject({ bible: BibleSummary }),
  },
  /** Make a bible the current one; main loads its read model and search index. */
  'bible.open': {
    request: z.strictObject({ slug: BibleSlug }),
    response: z.strictObject({ bible: BibleSummary }),
  },
  'bible.current': {
    request: z.strictObject({}),
    response: z.strictObject({ bible: BibleSummary.nullable() }),
  },
  /** Entries in one collection, each with its field warnings (ED-10). */
  'entry.list': {
    request: z.strictObject({
      collection: CollectionName,
      trash: z.enum(['exclude', 'only', 'include']).default('exclude'),
    }),
    response: z.strictObject({ entries: z.array(WithWarnings) }),
  },
  /** One entry with its warnings and what links to it (ED-9, ED-10). */
  'entry.get': {
    request: EntryRef,
    response: z.strictObject({
      entry: WireEntry,
      warnings: z.array(WireWarning),
      backlinks: z.array(WireBacklink),
    }),
  },
  'entry.create': {
    request: z
      .strictObject({ collection: CollectionName, data: z.record(z.string(), z.unknown()) })
      .superRefine(checkNewEntry),
    response: WithWarnings,
  },
  /**
   * Create several entries in one transaction: an in-tree action that makes a
   * person and the link to them (FT-2), or a batch load. All or nothing.
   */
  'entry.createMany': {
    request: z.strictObject({
      items: z
        .array(
          z
            .strictObject({ collection: CollectionName, data: z.record(z.string(), z.unknown()) })
            .superRefine(checkNewEntry),
        )
        .min(1)
        .max(2000),
    }),
    response: z.strictObject({ entries: z.array(WithWarnings) }),
  },
  /** Change some fields. Warnings come back; they never block the write (ED-10). */
  'entry.update': {
    request: z
      .strictObject({
        collection: CollectionName,
        id: EntryId,
        patch: z.record(z.string(), z.unknown()),
      })
      .superRefine(checkPatch),
    response: WithWarnings,
  },
  /** Move an entry to the trash (ED-5). */
  'entry.delete': { request: EntryRef, response: WithWarnings },
  'entry.restore': { request: EntryRef, response: WithWarnings },
  /** What links to an entry, shown before it is deleted (ED-5). */
  'entry.linkedFrom': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ count: z.int().min(0), entries: z.array(WireBacklink) }),
  },
  'entry.backlinks': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ backlinks: z.array(WireBacklink) }),
  },
  /** Titles and sections for entry IDs, for link chips that may point anywhere. */
  'entry.lookup': {
    request: z.strictObject({ ids: z.array(EntryId).max(500) }),
    response: z.strictObject({
      entries: z.array(
        z.strictObject({
          id: z.string(),
          collection: CollectionName,
          title: z.string(),
          inTrash: z.boolean(),
        }),
      ),
    }),
  },
  'trash.list': {
    request: z.strictObject({}),
    response: z.strictObject({
      entries: z.array(z.strictObject({ collection: CollectionName, entry: WireEntry })),
    }),
  },
  /** Revision history of one entry, newest first (ED-4). */
  'revisions.list': {
    request: EntryRef,
    response: z.strictObject({ revisions: z.array(RevisionSummary) }),
  },
  'revisions.diff': {
    request: EntryRef.extend({ revisionId: z.string().min(1) }),
    response: z.strictObject({
      revision: RevisionSummary.extend({ snapshot: WireEntry }),
      current: WireEntry,
      changes: z.array(
        z.strictObject({ path: z.string(), before: z.unknown(), after: z.unknown() }),
      ),
    }),
  },
  'revisions.restore': {
    request: EntryRef.extend({ revisionId: z.string().min(1) }),
    response: WithWarnings,
  },
  /** Every editable list with usage counts (ED-8). */
  'lists.get': {
    request: z.strictObject({}),
    response: z.strictObject({ lists: z.array(WireList) }),
  },
  /** Rename an item and every entry that uses it, in one transaction (ED-8). */
  'lists.rename': {
    request: z.strictObject({
      listId: ListIdParam,
      itemId: z.string().min(1),
      label: z.string().trim().min(1, 'A list item needs a name.').max(200),
    }),
    response: z.strictObject({ updated: z.int().min(0), from: z.string() }),
  },
  'lists.addItem': {
    request: z.strictObject({
      listId: ListIdParam,
      label: z.string().trim().min(1, 'A list item needs a name.').max(200),
      parentId: z.string().min(1).nullable().default(null),
      /** ED-3: an undo step puts an item back under the ID the entries still hold, when that ID is free. */
      id: z.string().min(1).max(64).optional(),
    }),
    response: z.strictObject({
      item: z.strictObject({ id: z.string(), label: z.string(), parentId: z.string().nullable() }),
    }),
  },
  'lists.removeItem': {
    request: z.strictObject({ listId: ListIdParam, itemId: z.string().min(1) }),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /**
   * Search the open bible (ARCH-2, SR-1, SR-2); also used by the `@` link
   * picker (ED-9). Filters narrow the matches by section, status,
   * provenance, family, place, tag, and a year range.
   */
  'search.query': {
    request: z.strictObject({
      query: z.string().max(200),
      collections: z.array(CollectionName).optional(),
      filters: SearchFiltersWire.optional(),
      limit: z.int().min(1).max(100).default(20),
    }),
    response: z.strictObject({
      hits: z.array(
        z.strictObject({
          collection: CollectionName,
          id: z.string(),
          title: z.string(),
          score: z.number(),
          status: z.string().nullable().default(null),
          provenance: z.string().nullable().default(null),
          snippet: z.string().default(''),
        }),
      ),
      /** How many entries matched before the limit cut the list. */
      total: z.int().min(0).default(0),
    }),
  },
  /** SL-1: the newest session log with a note, for the launch panel. */
  'sessionLog.latest': {
    request: z.strictObject({}),
    response: z.strictObject({
      log: z
        .strictObject({
          id: z.string(),
          date: z.string(),
          chapterId: z.string().nullable(),
          chapter: z.string().nullable(),
          stoppedAt: z.string(),
          notes: z.string(),
        })
        .nullable(),
    }),
  },
  /** SL-1: the stop prompt is answered (or skipped); main closes the window (or quits) when `proceed` is true, and stays open when it is false. */
  'app.confirmClose': {
    request: z.strictObject({ proceed: z.boolean() }),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /** SL-1: the page is showing the stop prompt, so main stops its 10 second wait and waits for the answer. */
  'app.closePromptShown': {
    request: z.strictObject({}),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /** The review queue (ED-7): proposals with their diff against the live entry. */
  'proposal.list': {
    request: z.strictObject({ state: z.enum(['pending', 'approved', 'rejected']).optional() }),
    response: z.strictObject({ proposals: z.array(ProposalView) }),
  },
  'proposal.diff': {
    request: z.strictObject({ id: EntryId }),
    response: ProposalView,
  },
  /** Approve: apply through the write path. Refused when the entry changed since (a conflict). */
  'proposal.approve': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ proposal: Proposal }),
  },
  /** Change the proposed values before approving. */
  'proposal.edit': {
    request: z.strictObject({ id: EntryId, data: z.record(z.string(), z.unknown()) }),
    response: z.strictObject({ proposal: Proposal }),
  },
  'proposal.reject': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ proposal: Proposal }),
  },
  /** Compare again after a conflict: the entry as it is now becomes the base. */
  'proposal.refresh': {
    request: z.strictObject({ id: EntryId }),
    response: ProposalView,
  },
  /**
   * Development and test builds only: record a proposal as an importer or
   * Claude will (M5, M6). A packaged app does not register this channel.
   */
  'test.propose': {
    request: z.strictObject({
      source: z.enum(['import', 'claude', 'bulk']),
      op: z.enum(['create', 'update', 'delete']),
      collection: CollectionName,
      targetId: EntryId.nullable().default(null),
      data: z.record(z.string(), z.unknown()).default({}),
      reason: z.string().max(2000).default(''),
    }),
    response: z.strictObject({ proposal: Proposal }),
  },
  /** The family tree from the read model: people, unions, parent links, FT-6 warnings. */
  'tree.get': {
    request: z.strictObject({}),
    response: z.strictObject({
      people: z.array(TreePersonWire),
      unions: z.array(TreeUnionWire),
      links: z.array(TreeLinkWire),
      warnings: z.array(TreeWarningWire),
      /** Stored node positions keyed by character ID (FT-10), or null before the first layout. */
      positions: TreePositions.nullable(),
    }),
  },
  /** Store the tree's node positions, after a new person is placed or the layout is tidied (FT-10). */
  'tree.savePositions': {
    request: z.strictObject({ positions: TreePositions }),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /** Ancestors and descendants of one person (FT-1). */
  'tree.lineage': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ ancestors: z.array(z.string()), descendants: z.array(z.string()) }),
  },
  /** Save the tree as an image or a PDF through a save dialog (FT-9). */
  'tree.export': {
    request: z.strictObject({
      format: z.enum(['png', 'pdf']),
      /** The tree as standalone SVG markup with its styles inlined. */
      svg: z.string().min(1).max(30_000_000),
      /** For PNG: the rasterized image as a base64 data URL. */
      png: z
        .string()
        .regex(/^data:image\/png;base64,/)
        .max(60_000_000)
        .optional(),
      width: z.number().positive().max(100_000),
      height: z.number().positive().max(100_000),
      fileName: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9 _.-]+$/),
    }),
    response: z.strictObject({ saved: z.boolean(), path: z.string().nullable() }),
  },
  /** Everything the character page shows (SM-1, CH-4), computed in main from the read model. */
  'character.page': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ page: CharacterPageWire }),
  },
  /** The current story time and the year ages are shown at (TM-3). */
  'storyTime.get': {
    request: z.strictObject({}),
    response: StoryTimeResponse,
  },
  /** Set or clear the story time. It writes no entry (TM-5). */
  'storyTime.set': {
    request: z.strictObject({ time: StoryTimeValue.nullable() }),
    response: StoryTimeResponse,
  },
  /**
   * TL-2, TM-2, WE-3: everyone's state at a year or date, the era, the events
   * of that year, and the strands in it. Without a year, the story time.
   */
  'timeline.year': {
    request: z.strictObject({ at: Moment.optional() }),
    response: YearViewWire,
  },
  /** TL-5: the world events a character has lived through by a year, with ages. */
  'timeline.livedThrough': {
    request: z.strictObject({ characterId: EntryId, year: z.int().min(-10000).max(10000) }),
    response: z.strictObject({
      characterId: z.string(),
      year: z.number(),
      birthKnown: z.boolean(),
      state: LifeStateWire,
      events: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          startYear: z.number(),
          endYear: z.number(),
          year: z.number(),
          age: z.number(),
          categoryId: z.string(),
          categoryPath: z.string(),
          formative: z.boolean(),
        }),
      ),
    }),
  },
  /** TL-7: two characters side by side across a year range, every year or every five. */
  'timeline.compare': {
    request: z.strictObject({
      a: EntryId,
      b: EntryId,
      from: z.int().min(-10000).max(10000),
      to: z.int().min(-10000).max(10000),
      step: z.union([z.literal(1), z.literal(5)]),
    }),
    response: z.strictObject({
      rows: z.array(
        z.strictObject({
          year: z.number(),
          a: LifeStateWire,
          b: LifeStateWire,
          gap: z.number().nullable(),
        }),
      ),
    }),
  },
  /** TL-6: everything the timeline draws, with the filters applied in main. */
  'timeline.chart': {
    request: z.strictObject({ filters: ChartFiltersWire.default(ChartFiltersWire.parse({})) }),
    response: z.strictObject({
      eras: z.array(EraWire),
      events: z.array(ChartEventWire),
      strands: z.array(StrandWire),
      lifespans: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          familyIds: z.array(z.string()),
          placeNames: z.array(z.string()),
          birthYear: z.number(),
          deathYear: z.number().nullable(),
        }),
      ),
      undrawn: z.array(z.strictObject({ id: z.string(), name: z.string() })),
      coverage: CoverageWire,
    }),
  },
  /** WE-2: era gaps and overlaps across 2025 to 2100, in plain words. Never blocking. */
  'timeline.eraCoverage': {
    request: z.strictObject({}),
    response: z.strictObject({ coverage: CoverageWire, messages: z.array(z.string()) }),
  },
  /** TM-4: the year a character is an age. Null with a reason when the birth is unknown. */
  'storyTime.anchorAge': {
    request: z.strictObject({ characterId: EntryId, age: z.int().min(0).max(300) }),
    response: z.strictObject({ year: z.number().nullable(), message: z.string() }),
  },
  /** TM-5: what "Use as strand year" would change, shown before it is written (ED-7). */
  'storyTime.promotePreview': {
    request: z.strictObject({ chapterId: EntryId, strandId: EntryId }),
    response: z.strictObject({
      chapterId: z.string(),
      chapterTitle: z.string(),
      strandId: z.string(),
      strandLabel: z.string(),
      year: z.number(),
      from: z.strictObject({ startYear: z.number(), endYear: z.number().nullable() }),
      to: z.strictObject({ startYear: z.number(), endYear: z.number().nullable() }),
      baseModifiedAt: z.string(),
      unchanged: z.boolean(),
    }),
  },
  /** TM-5: write the story time year into the strand, after the person approved the change. */
  'storyTime.promote': {
    request: z.strictObject({
      chapterId: EntryId,
      strandId: EntryId,
      baseModifiedAt: z.string().min(1),
    }),
    response: WithWarnings,
  },
  /** PL-5 (A36), SM-5: the scene outline, one bulleted text per bible with the chapters' breaks and the scenes' years, kept in meta and never an entry. */
  'sceneOutline.get': {
    request: z.strictObject({}),
    response: SceneOutlineWire,
  },
  /** Replace the text, breaks and years. Saves closer than ten minutes share one version. */
  'sceneOutline.set': {
    request: z.strictObject({
      text: z.string().max(2_000_000),
      breaks: SceneBreaksWire.default({}),
      years: SceneYearsWire.default({}),
    }),
    response: SceneOutlineWire,
  },
  /** The saved versions, newest first, without their text. */
  'sceneOutline.versions': {
    request: z.strictObject({}),
    response: z.strictObject({ versions: z.array(SceneVersionSummary) }),
  },
  /** One version with its text, breaks and years. */
  'sceneOutline.version': {
    request: z.strictObject({ id: z.string().min(1) }),
    response: SceneVersionSummary.extend({
      text: z.string(),
      breaks: SceneBreaksWire,
      years: SceneYearsWire,
    }),
  },
  /** Make a version the current outline again; the restore is a new version of its own. */
  'sceneOutline.restore': {
    request: z.strictObject({ id: z.string().min(1) }),
    response: SceneOutlineWire,
  },
  /** PL-2: the outline grid, in reading order or story-year order, with the story-time cursor. */
  'outline.get': {
    request: z.strictObject({
      order: z.enum(['reading', 'story']).default('reading'),
      cursorYear: z.int().min(-10000).max(10000).nullable().default(null),
    }),
    response: OutlineWire,
  },
  /** One chapter with its strands, the characters present and their ages, and its places. */
  'chapter.page': {
    request: z.strictObject({ id: EntryId }),
    response: z.strictObject({ page: ChapterPageWire }),
  },
  /**
   * PL-3: move a chapter to a place in a part (its own or another, where it
   * takes the target part). Story years never change. Returns what changed,
   * for undo. KB-3: also a part among the parts of its book, and a book among
   * the books.
   */
  'plot.reorder': {
    request: z.union([
      z.strictObject({
        kind: z.literal('chapters'),
        groupId: EntryId,
        movedId: EntryId,
        toIndex: z.int().min(0).max(5000),
      }),
      z.strictObject({
        kind: z.literal('parts'),
        /** The book. */
        groupId: EntryId,
        movedId: EntryId,
        toIndex: z.int().min(0).max(5000),
      }),
      z.strictObject({
        kind: z.literal('books'),
        movedId: EntryId,
        toIndex: z.int().min(0).max(5000),
      }),
    ]),
    response: z.strictObject({
      collection: z.enum(['chapters', 'parts', 'books']),
      /** For each entry that changed, the order fields before and after (a chapter's reading order and part, a part's or book's number). */
      changes: z.array(
        z.strictObject({
          id: z.string(),
          before: z.record(z.string(), z.unknown()),
          after: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  },
  /**
   * KB-3: a new chapter made from a part heading, last in that part, with one
   * primary strand at the given story year. Chapters after it move up in
   * reading order as far as they must; all of it is one transaction. Returns
   * the new chapter and the reading-order changes, for one undo step.
   */
  'outline.newChapter': {
    request: z.strictObject({
      partId: EntryId,
      title: z.string().trim().min(1).max(500),
      year: z.int().min(-10000).max(10000),
      /** A37: place it right after this chapter of the part, else last in the part. */
      afterId: EntryId.optional(),
    }),
    response: z.strictObject({
      entry: WireEntry,
      changes: z.array(
        z.strictObject({
          id: z.string(),
          before: z.record(z.string(), z.unknown()),
          after: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  },
  /** CU-2: the cultural entries of a community that apply in a year. */
  'culture.entriesFor': {
    request: z.strictObject({
      communityId: z.string().min(1),
      year: z.int().min(-10000).max(10000),
    }),
    response: z.strictObject({ entries: z.array(WireEntry) }),
  },
  /** PC-1: a place in a year, with the places it sits in and the places inside it. */
  'place.describe': {
    request: z.strictObject({ id: EntryId, year: z.int().min(-10000).max(10000) }),
    response: z.strictObject({
      id: z.string(),
      path: z.string(),
      description: z
        .strictObject({
          startYear: z.number().nullable(),
          endYear: z.number().nullable(),
          text: z.string(),
        })
        .nullable(),
      children: z.array(z.strictObject({ id: z.string(), title: z.string() })),
    }),
  },
  /** GL-1: the romanization system for each language, and the choices available. */
  'romanization.get': { request: z.strictObject({}), response: RomanizationWire },
  'romanization.set': {
    request: z.strictObject({
      languageId: z.string().min(1),
      systemId: z.string().min(1).nullable(),
    }),
    response: RomanizationWire,
  },
  /** GL-1: check a romanization against its language's system, for a form before it saves. */
  'romanization.check': {
    request: z.strictObject({ languageId: z.string().min(1), text: z.string().max(500) }),
    response: z.strictObject({ ok: z.boolean(), message: z.string() }),
  },
  /** A41: what each community is like overall, by community ID (kept in meta, not an entry). */
  'community.notes.get': {
    request: z.strictObject({}),
    response: z.strictObject({ notes: z.record(z.string(), z.string()) }),
  },
  'community.notes.set': {
    request: z.strictObject({
      communityId: z.string().min(1),
      text: z.string().max(20_000),
    }),
    response: z.strictObject({ notes: z.record(z.string(), z.string()) }),
  },
  /** IM-1: open the file picker for a workbook or a Word document. Null when cancelled. */
  'import.pickFile': {
    request: z.strictObject({ kind: z.enum(['workbook', 'document']) }),
    response: z.strictObject({ file: ImportFileWire.nullable() }),
  },
  /** IM-1: the sheets of a picked workbook and the mappings saved for this file. */
  'import.workbook': {
    request: z.strictObject({ fileId: z.string().min(1) }),
    response: z.strictObject({
      file: ImportFileWire,
      sheets: z.array(ImportSheetWire),
      saved: z.array(z.strictObject({ sheet: z.string(), mapping: Mapping })),
    }),
  },
  /** IM-1: a starting mapping for a sheet, columns matched to fields by their headers. */
  'import.guess': {
    request: z.strictObject({
      fileId: z.string().min(1),
      sheet: z.string().min(1),
      shape: z.enum(['table', 'grid']),
      collection: CollectionName,
    }),
    response: z.strictObject({ mapping: Mapping }),
  },
  /** IM-1: the fields a column can fill in a section. */
  'import.fields': {
    request: z.strictObject({ collection: CollectionName }),
    response: z.strictObject({
      fields: z.array(z.strictObject({ path: z.string(), label: z.string() })),
    }),
  },
  /** IM-1, IM-2: the first rows of a sheet as the mapping would import them, each with its result. */
  'import.preview': {
    request: z.strictObject({
      fileId: z.string().min(1),
      mapping: Mapping,
      limit: z.int().min(1).max(200).default(12),
    }),
    response: z.strictObject({
      rows: z.array(ImportRowWire),
      total: z.int().min(0),
      ok: z.int().min(0),
      failed: z.int().min(0),
      notes: z.array(z.string()),
    }),
  },
  /** IM-3: compare the sheet with the bible. Nothing is written. */
  'import.plan': {
    request: z.strictObject({ fileId: z.string().min(1), mapping: Mapping }),
    response: ImportPlanWire,
  },
  /** ED-7, IM-3: write the changes the person approved, after a snapshot (BK-1). */
  'import.apply': {
    request: z.strictObject({
      planId: z.string().min(1),
      approved: z.array(z.string().min(1)).max(100000),
      saveMapping: z.boolean().default(true),
    }),
    response: z.strictObject({
      created: z.int().min(0),
      updated: z.int().min(0),
      unchanged: z.int().min(0),
      questions: z.int().min(0),
      failed: z.array(FailedRowWire),
      snapshot: z.string().nullable(),
    }),
  },
  /** IM-4: a Word document as the editor will store it, with its headings. */
  'import.document': {
    request: z.strictObject({ fileId: z.string().min(1) }),
    response: z.strictObject({
      file: ImportFileWire,
      title: z.string(),
      headings: z.array(z.strictObject({ level: z.int(), text: z.string(), index: z.int() })),
      paragraphs: z.int().min(0),
      sceneBreaks: z.int().min(0),
      body: z.string(),
    }),
  },
  /** IM-4, IM-3: what importing the document into an entry would change. */
  'import.documentPlan': {
    request: z.strictObject({ fileId: z.string().min(1), target: DocumentTargetWire }),
    response: ImportPlanWire,
  },
  /** BK-1: the snapshots of the open bible, newest first, and how many are kept. */
  'snapshot.list': {
    request: z.strictObject({}),
    response: z.strictObject({ snapshots: z.array(SnapshotWire), keep: z.int().min(1) }),
  },
  'snapshot.take': {
    request: z.strictObject({}),
    response: z.strictObject({ snapshot: SnapshotWire }),
  },
  /** BK-2: restore a snapshot after taking one of the present state. */
  'snapshot.restore': {
    request: z.strictObject({ id: z.string().min(1).max(64) }),
    response: z.strictObject({ restored: SnapshotWire, safety: SnapshotWire }),
  },
  'snapshot.keep': {
    request: z.strictObject({ keep: z.int().min(1).max(1000) }),
    response: z.strictObject({ keep: z.int().min(1) }),
  },
  /** BK-3: write the whole bible to one JSON file the person chooses. Null path when cancelled. */
  'backup.export': {
    request: z.strictObject({}),
    response: z.strictObject({
      path: z.string().nullable(),
      counts: z.record(z.string(), z.int().min(0)),
    }),
  },
  /** BK-3: make a new bible from an exported file the person chooses. Null bible when cancelled. */
  'backup.import': {
    request: z.strictObject({ slug: BibleSlug, name: BibleName }),
    response: z.strictObject({
      bible: BibleSummary.nullable(),
      counts: z.record(z.string(), z.int().min(0)),
    }),
  },
  /** Open a link in the system browser. Only allowlisted hosts are opened. */
  'app.openExternal': {
    request: z.strictObject({ url: z.string().min(1).max(2000) }),
    response: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Google Drive (M9): see `ipcDrive.ts`. */
  ...driveContract,
  ...appContract,
  /** WT-1 writing tools over Datamuse (src/shared/ipcWords.ts). */
  ...wordsContract,
  /** M7 sessions, briefs, dashboard, and manuscript (src/shared/ipcSession.ts). */
  ...sessionContract,
  ...claudeContract,
  /** M8 alignment check (src/shared/ipcContinuity.ts). */
  ...continuityContract,
} as const;

export type Channel = keyof typeof contract;
export type Request<C extends Channel> = z.input<(typeof contract)[C]['request']>;
export type Response<C extends Channel> = z.output<(typeof contract)[C]['response']>;

export const CHANNELS = Object.keys(contract) as Channel[];

export function isChannel(name: unknown): name is Channel {
  return typeof name === 'string' && Object.hasOwn(contract, name);
}

/** Events the main process pushes to the renderer. */
export const events = {
  /** The list of bibles or the current bible changed. */
  'bibles.changed': z.strictObject({ current: BibleSummary.nullable() }),
  'bible.changed': z.strictObject({
    bible: z.string(),
    collection: z.string(),
    id: z.string(),
    op: z.enum(['create', 'update', 'softDelete', 'restore']),
  }),
  /** Cmd+Z and Shift+Cmd+Z (ED-3), and Cmd+T for the Story Time dialog (TM-1), caught in main before the page or the menu sees them. */
  'app.command': z.strictObject({ command: z.enum(['undo', 'redo', 'storyTime']) }),
  /** SL-1: the window is closing or the app is quitting; ask "Where did you stop?" first. */
  'app.closeRequested': z.strictObject({ hasBible: z.boolean(), quitting: z.boolean() }),
  'proposals.changed': z.strictObject({ bible: z.string() }),
  /** A list changed: an item added, renamed, or removed, or a new tag. */
  'lists.changed': z.strictObject({ bible: z.string() }),
  /** The story time was set or cleared (TM-3). */
  'storyTime.changed': z.strictObject({ bible: z.string() }),
  /** The tree's stored positions changed: a move, a tidy, or an undo of one (FT-11, ED-3). */
  'tree.changed': z.strictObject({ bible: z.string() }),
  /** The whole bible was replaced by a restore or a file import; views reload everything. */
  'bible.reloaded': z.strictObject({ bible: z.string(), message: z.string() }),
  ...claudeEvents,
  ...appEvents,
} as const;

export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.output<(typeof events)[E]>;

export function isEventName(name: unknown): name is EventName {
  return typeof name === 'string' && Object.hasOwn(events, name);
}

/** IPC wire channel names are prefixed so nothing else can collide with them. */
export const wireChannel = (c: Channel): string => `nc:${c}`;
export const wireEvent = (e: EventName): string => `nc-event:${e}`;

export class IpcValidationError extends Error {
  override name = 'IpcValidationError';
}

export function parseRequest<C extends Channel>(channel: C, payload: unknown) {
  const result = contract[channel].request.safeParse(payload);
  if (!result.success) {
    throw new IpcValidationError(
      `The request for ${channel} is not valid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data as z.output<(typeof contract)[C]['request']>;
}

export function parseResponse<C extends Channel>(channel: C, payload: unknown): Response<C> {
  const result = contract[channel].response.safeParse(payload);
  if (!result.success) {
    throw new IpcValidationError(
      `The response for ${channel} is not valid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data as Response<C>;
}

/** The shape of `window.api`, the only thing the preload exposes. */
export interface Api {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>>;
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void;
}
