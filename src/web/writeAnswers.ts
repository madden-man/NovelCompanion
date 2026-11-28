import type { Request, Response } from '../shared/ipc';
import type { WrittenRead } from './readStore';

/**
 * A58 L1 (PH-25): the reads a write's own answer already holds. These write
 * channels answer with exactly what the matching read answers afterwards, so
 * the phone keeps that answer as the read's in the same step the write
 * succeeds, and the thing just edited reads offline as it did online.
 *
 * - `entry.create`, `entry.update`, `entry.delete`, `entry.restore`: the entry
 *   with its warnings, as `entry.get` answers it (trashed entries included);
 * - `entry.createMany`, `entry.batch`: one such entry per item, in order;
 * - `storyTime.set`, `sceneOutline.set`, `sceneOutline.restore`,
 *   `romanization.set`, `community.notes.set`, `settings.set`,
 *   `eraDefaults.set`, `brief.settings.set`: the whole of what their `get`
 *   reads.
 *
 * Every other write answers with a part only (a list item, a count, `ok`), and
 * the store reads those screens again in the background.
 */

type Entry = Response<'entry.get'>;

const entryRead = (collection: string, value: Entry): WrittenRead => ({
  channel: 'entry.get',
  request: { collection, id: value.entry._id },
  value,
});

/** Whole answers: the write answers what this read answers. */
const WHOLE: Readonly<Record<string, string>> = {
  'storyTime.set': 'storyTime.get',
  'sceneOutline.set': 'sceneOutline.get',
  'sceneOutline.restore': 'sceneOutline.get',
  'romanization.set': 'romanization.get',
  'community.notes.set': 'community.notes.get',
  'settings.set': 'settings.get',
  'eraDefaults.set': 'eraDefaults.get',
  'brief.settings.set': 'brief.settings.get',
};

export function writtenReads(channel: string, request: unknown, result: unknown): WrittenRead[] {
  const whole = WHOLE[channel];
  if (whole) return [{ channel: whole, request: {}, value: result }];
  switch (channel) {
    case 'entry.create':
    case 'entry.update':
    case 'entry.delete':
    case 'entry.restore': {
      const { collection } = request as { collection: string };
      return [entryRead(collection, result as Entry)];
    }
    case 'entry.createMany': {
      const { items } = request as Request<'entry.createMany'>;
      const { entries } = result as Response<'entry.createMany'>;
      return entries.flatMap((e, i) => {
        const item = items[i];
        return item ? [entryRead(item.collection, e)] : [];
      });
    }
    case 'entry.batch': {
      const { ops } = request as Request<'entry.batch'>;
      const { entries } = result as Response<'entry.batch'>;
      return entries.flatMap((e, i) => {
        const op = ops[i];
        return op ? [entryRead(op.collection, e)] : [];
      });
    }
    default:
      return [];
  }
}
