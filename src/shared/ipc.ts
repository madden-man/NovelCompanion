import { z } from 'zod';
import { BibleName, BibleSlug } from './bible';
import { ENTRY_COLLECTIONS, ListIdParam, Proposal, entrySchemas } from './schema';
import { StoryTimeValue } from './storyTime';
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
  const r = entrySchemas[v.collection].safeParse({
    ...v.data,
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
    const field = shape[k];
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
    romanization: z.string(),
    order: z.string(),
    birthName: z.string(),
    marriedName: z.string(),
    nicknames: z.array(z.string()),
    calledBy: z.array(
      z.strictObject({ characterId: z.string(), characterName: z.string(), name: z.string() }),
    ),
  }),
  families: z.array(z.strictObject({ id: z.string(), name: z.string(), color: z.string() })),
  years: z.string(),
  birthKnown: z.boolean(),
  position: PositionWire.extend({ state: LifeStateWire.nullable() }),
  timeline: z.array(
    z.strictObject({
      kind: z.enum(['birth', 'death', 'union', 'union-end', 'child', 'beat', 'event', 'chapter']),
      year: z.number().nullable(),
      age: z.number().nullable(),
      collection: z.string(),
      id: z.string(),
      title: z.string(),
      detail: z.string(),
    }),
  ),
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
  knowledge: z.array(
    z.strictObject({
      recordId: z.string(),
      factId: z.string(),
      fact: z.string(),
      yearLearned: z.number().nullable(),
      chapterId: z.string().nullable(),
      chapter: z.string().nullable(),
      how: z.string(),
      knownAtPosition: z.boolean().nullable(),
    }),
  ),
});

const RevisionSummary = z.strictObject({
  _id: z.string(),
  op: z.enum(['create', 'update', 'softDelete', 'restore']),
  at: z.string(),
  note: z.string().nullable(),
  proposalId: z.string().nullable(),
});

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
    }),
    response: z.strictObject({
      item: z.strictObject({ id: z.string(), label: z.string(), parentId: z.string().nullable() }),
    }),
  },
  'lists.removeItem': {
    request: z.strictObject({ listId: ListIdParam, itemId: z.string().min(1) }),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /** Search the open bible (ARCH-2); used by the `@` link picker (ED-9). */
  'search.query': {
    request: z.strictObject({
      query: z.string().max(200),
      collections: z.array(CollectionName).optional(),
      limit: z.int().min(1).max(100).default(20),
    }),
    response: z.strictObject({
      hits: z.array(
        z.strictObject({
          collection: CollectionName,
          id: z.string(),
          title: z.string(),
          score: z.number(),
        }),
      ),
    }),
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
    }),
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
  /** Everything the character page shows (CH-1 to CH-4), computed in main from the read model. */
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
  /** Open a link in the system browser. Only allowlisted hosts are opened. */
  'app.openExternal': {
    request: z.strictObject({ url: z.string().min(1).max(2000) }),
    response: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), message: z.string() }),
    ]),
  },
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
  /** Cmd+Z and Shift+Cmd+Z, caught in main before the page or the menu sees them (ED-3). */
  'app.command': z.strictObject({ command: z.enum(['undo', 'redo']) }),
  'proposals.changed': z.strictObject({ bible: z.string() }),
  /** A list changed: an item added, renamed, or removed, or a new tag. */
  'lists.changed': z.strictObject({ bible: z.string() }),
  /** The story time was set or cleared (TM-3). */
  'storyTime.changed': z.strictObject({ bible: z.string() }),
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
