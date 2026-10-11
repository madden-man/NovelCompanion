import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

type Beat = { _id: string; arcIds?: string[]; order?: number; arcOrders?: unknown };

/**
 * A beat can belong to several arcs, so its position is stored per arc
 * (PL-3). The single `order` number becomes one `{ arcId, order }` pair for
 * each arc the beat belongs to.
 */
export const beatArcOrders: Migration = {
  version: 4,
  name: 'plot beat order per arc',
  async up(bible: BibleHandle) {
    const beats = bible.collection<Beat>('plotBeats');
    for (const b of await beats.find({}).toArray()) {
      const order = typeof b.order === 'number' ? b.order : 0;
      const arcOrders = Array.isArray(b.arcOrders)
        ? b.arcOrders
        : (b.arcIds ?? []).map((arcId) => ({ arcId, order }));
      await beats.updateOne({ _id: b._id }, { $set: { arcOrders }, $unset: { order: '' } });
    }
  },
};
