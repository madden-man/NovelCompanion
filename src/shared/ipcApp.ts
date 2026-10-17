import { z } from 'zod';

/**
 * App-wide channels for M10, spread into the one IPC contract in `ipc.ts`:
 * the MongoDB connection (ST-1, ARCH-5), offline behaviour (ARCH-6), and
 * appearance (ST-1). No response carries the connection string; the
 * renderer sees only a masked form of it.
 */

/** ST-1: light, dark, or follow the system. Applied through `data-theme` on the root. */
export const APPEARANCES = ['system', 'light', 'dark'] as const;
export const Appearance = z.enum(APPEARANCES);
export type Appearance = z.infer<typeof Appearance>;

const SnapshotRef = z.strictObject({
  /** The bible the snapshot belongs to (its ID). */
  bible: z.string().min(1),
  /** The bible's name, as people know it (the ID for a snapshot taken before names were kept). */
  name: z.string().min(1),
  /** When it was taken (ISO time). */
  takenAt: z.string().min(1),
});

/**
 * ARCH-6: where the app stands with MongoDB.
 * - `connected`: reads and writes go to MongoDB.
 * - `unavailable`: MongoDB cannot be reached. `snapshot` is the most recent
 *   local snapshot the person may open read-only, or null when there is none.
 * - `readOnly`: a snapshot is open read-only; `snapshot` is the one open.
 */
export const ConnectionStatus = z.strictObject({
  state: z.enum(['connected', 'unavailable', 'readOnly']),
  /** What happened and what to do next, in plain words. Null when connected. */
  message: z.string().nullable(),
  snapshot: SnapshotRef.nullable(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

const MongoSettingsWire = z.strictObject({
  /** True when a connection string is stored. */
  set: z.boolean(),
  /** The scheme and the last characters of the host only, never the user or password. */
  masked: z.string().nullable(),
  /** Where it is kept, in plain words. */
  where: z.string(),
});
export type MongoSettingsWire = z.infer<typeof MongoSettingsWire>;

const Outcome = z.strictObject({ ok: z.boolean(), message: z.string() });

/** A pasted connection string. Kept short of anything absurd; checked in main. */
const UriInput = z.string().max(2000);

export const appContract = {
  /** ARCH-6: the connection state, and the newest local snapshot when MongoDB is out of reach. */
  'connection.status': { request: z.strictObject({}), response: ConnectionStatus },
  /** ARCH-6: try MongoDB again. A snapshot open read-only is closed when the connection comes back. */
  'connection.retry': { request: z.strictObject({}), response: ConnectionStatus },
  /** ARCH-6: open the most recent local snapshot read-only. */
  'connection.openSnapshot': {
    request: z.strictObject({}),
    response: z.strictObject({
      bible: z.strictObject({ id: z.string(), name: z.string() }),
      status: ConnectionStatus,
    }),
  },
  /** ST-1, ARCH-5: whether a connection string is stored, shown masked. */
  'mongo.status': { request: z.strictObject({}), response: MongoSettingsWire },
  /** ST-1: connect with a string (or the stored one when none is given) and report plainly. Saves nothing. */
  'mongo.test': {
    request: z.strictObject({ uri: UriInput.optional() }),
    response: Outcome,
  },
  /**
   * ST-1: replace the stored connection string. It is tested first; only a
   * string that connects is stored in the keychain, and only then does the
   * app switch over to it.
   */
  'mongo.replace': {
    request: z.strictObject({ uri: UriInput }),
    response: z.strictObject({
      ok: z.boolean(),
      message: z.string(),
      mongo: MongoSettingsWire,
    }),
  },
  /** ST-1: the appearance setting. */
  'appearance.get': {
    request: z.strictObject({}),
    response: z.strictObject({ appearance: Appearance }),
  },
  'appearance.set': {
    request: z.strictObject({ appearance: Appearance }),
    response: z.strictObject({ appearance: Appearance }),
  },
} as const;

export const appEvents = {
  /** ARCH-6: the connection was lost, came back, or a snapshot opened read-only. */
  'connection.changed': ConnectionStatus,
} as const;

/**
 * ARCH-6: every channel that changes a bible (or runs Claude, which saves its
 * runs in the bible). While a snapshot is open read-only, main refuses these
 * before anything runs, and the renderer disables the controls that send them.
 * tests/unit/write-channels.test.ts checks this list against every main
 * handler that reaches a write, in both directions. `backup.export` only
 * reads, so it works on a read-only snapshot too.
 */
export const WRITE_CHANNELS = [
  'bible.create',
  'entry.create',
  'entry.createMany',
  'entry.update',
  'entry.delete',
  'entry.restore',
  'revisions.restore',
  'lists.rename',
  'lists.addItem',
  'lists.removeItem',
  'proposal.approve',
  'proposal.edit',
  'proposal.reject',
  'proposal.refresh',
  'test.propose',
  'tree.savePositions',
  'storyTime.set',
  'sceneOutline.set',
  'storyTime.promote',
  'plot.reorder',
  'outline.newChapter',
  'romanization.set',
  'import.apply',
  'snapshot.take',
  'snapshot.restore',
  'snapshot.keep',
  'backup.import',
  'brief.settings.set',
  'session.start',
  'brief.regenerate',
  'manuscript.apply',
  'chapter.summarize',
  'claude.ask',
  'claude.importProposals',
  'claude.alignment',
  'claude.capture',
  'continuity.check',
  'continuity.resolve',
  'drive.link',
  'drive.unlink',
  'drive.markSeen',
  'drive.export',
] as const;

const WRITES: ReadonlySet<string> = new Set(WRITE_CHANNELS);
export const isWriteChannel = (channel: string): boolean => WRITES.has(channel);

/** ARCH-6: the reason every write control shows while a snapshot is open read-only. */
export const READ_ONLY_REASON =
  'This is a read-only snapshot, because MongoDB cannot be reached. Nothing can be changed or saved until the connection is back. Click Try again when your network is back.';

/** ARCH-6, NF-3: a write that failed because MongoDB went away mid-session. */
export const CONNECTION_LOST_MESSAGE =
  'The app lost its connection to MongoDB, so this change was not saved. Check your network connection, then click Try again at the top of the window. You can also open the latest snapshot read-only.';
