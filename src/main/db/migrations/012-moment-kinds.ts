import type { Document } from 'mongodb';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

export const MIGRATION12_META_ID = 'migration12';

/** What migration 12 did, kept in `meta`. */
export interface Migration12Summary {
  _id: typeof MIGRATION12_META_ID;
  /** True when the bible had no `momentKinds` list and the seeded one was written. */
  listSeeded: boolean;
  /** Moments (trashed ones too) given the kind `move` from a "Lives in " title. */
  movesSorted: number;
  /** Moments (trashed ones too) given the kind `voice` from the title "Voice". */
  voicesSorted: number;
  takenAt: string;
}

interface Item {
  id: string;
  label: string;
  parentId: string | null;
  color: string | null;
  extra: Record<string, string | number>;
}

/*
 * The values below are written out because migrations never change. The
 * colours are the light theme values of the `--kind-*` tokens in `theme.css`
 * as of A51; the renderer draws these hex values through the same tokens, so
 * they follow the theme. The titles are `LIVES_IN_PREFIX` and
 * `VOICE_MOMENT_TITLE` of `moment.ts` as of A51.
 */

/** A51 (SM-3): the seeded moment kinds, all at the plain weight. */
export const MOMENT_KIND_SEED: Item[] = [
  { id: 'move', label: 'Moves', parentId: null, color: '#008300', extra: {} },
  { id: 'life', label: 'Life event', parentId: null, color: '#e34948', extra: {} },
  { id: 'work', label: 'Work and study', parentId: null, color: '#4a3aa7', extra: {} },
  { id: 'voice', label: 'Voice', parentId: null, color: null, extra: {} },
];

const LIVES_IN = 'Lives in ';
const VOICE = 'Voice';

/** The kind migration 12 gives a moment with this title, or null for none. */
export function kindFromTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  if (title.startsWith(LIVES_IN)) return 'move';
  if (title === VOICE) return 'voice';
  return null;
}

/**
 * A51 (schema version 12): a moment has a kind.
 * - A bible with no `momentKinds` list gets the seeded one; a bible that has
 *   the list keeps it as it is.
 * - A moment with no kind yet whose title starts with "Lives in " becomes a
 *   move, and one titled exactly "Voice" a voice note; the rest get a null
 *   kind. A kind already set is never changed.
 * Modified times are not touched and revisions keep what they held.
 * `openBibleSession` takes a snapshot first. Running it again changes nothing.
 */
export const momentKinds: Migration = {
  version: 12,
  name: 'moment kinds: the momentKinds list, and kinds from moment titles',
  async up(bible: BibleHandle) {
    const lists = bible.collection<{ _id: string; label: string; items: Item[] }>('lists');
    let listSeeded = false;
    if (!(await lists.findOne({ _id: 'momentKinds' }))) {
      await lists.insertOne({
        _id: 'momentKinds',
        label: 'Moment kinds',
        items: MOMENT_KIND_SEED.map((i) => ({ ...i, extra: { ...i.extra } })),
      });
      listSeeded = true;
    }

    let movesSorted = 0;
    let voicesSorted = 0;
    if ((await bible.collectionNames()).includes('moments')) {
      const moments = bible.collection<Document>('moments');
      for (const m of await moments.find({}).toArray()) {
        if (typeof m.kind === 'string' && m.kind) continue;
        const kind = kindFromTitle(m.title);
        // The rest store an explicit null, as the schema default would.
        if (kind === null && m.kind === null) continue;
        await moments.updateOne({ _id: m._id }, { $set: { kind } });
        if (kind === 'move') movesSorted++;
        else if (kind === 'voice') voicesSorted++;
      }
    }

    const summary: Migration12Summary = {
      _id: MIGRATION12_META_ID,
      listSeeded,
      movesSorted,
      voicesSorted,
      takenAt: new Date().toISOString(),
    };
    await bible
      .collection<Document>('meta')
      .updateOne({ _id: MIGRATION12_META_ID } as Document, { $setOnInsert: summary } as Document, {
        upsert: true,
      });
  },
};
