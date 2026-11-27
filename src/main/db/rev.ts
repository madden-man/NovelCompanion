import type { ClientSession, Document } from 'mongodb';
import { REV_META_ID } from '../../shared/freshness';
import type { BibleHandle } from './bibles';

type RevStored = { _id: string; rev?: number };

const revOf = (doc: RevStored | null): number =>
  typeof doc?.rev === 'number' && Number.isInteger(doc.rev) && doc.rev >= 0 ? doc.rev : 0;

/** PH-6: the bible's `rev` as stored now; 0 before the first write. */
export async function readRev(handle: BibleHandle, session?: ClientSession): Promise<number> {
  const doc = await handle
    .collection<RevStored>('meta')
    .findOne({ _id: REV_META_ID }, session ? { session } : {});
  return revOf(doc);
}

/**
 * PH-6: raise the bible's `rev` by one, atomically, inside `session` when
 * the write has a transaction. Returns the number this write made.
 */
export async function raiseRev(handle: BibleHandle, session?: ClientSession): Promise<number> {
  const doc = await handle
    .collection<RevStored>('meta')
    .findOneAndUpdate(
      { _id: REV_META_ID } as Document,
      { $inc: { rev: 1 } },
      { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
    );
  return revOf(doc);
}

/**
 * PH-8: which `rev` this process has seen. `loaded` is the number read just
 * before the read model last loaded; each number one of this process's own
 * writes made is noted, so the process never reloads for its own writes, even
 * when two of them finish out of order. A number nobody here made means the
 * bible changed somewhere else.
 */
export class RevTracker {
  private known = 0;
  private readonly own = new Set<number>();

  /** The number this process has caught up to. */
  get current(): number {
    return this.known;
  }

  /** The read model was loaded after `rev` read this number. */
  loadedAt(rev: number): void {
    this.known = rev;
    for (const n of this.own) if (n <= rev) this.own.delete(n);
    this.advance();
  }

  /** One of this process's writes raised `rev` to this number. */
  wrote(rev: number): void {
    if (rev > this.known) this.own.add(rev);
    this.advance();
  }

  /** True when the stored number is one this process has accounted for. */
  settled(stored: number): boolean {
    this.advance();
    return stored === this.known;
  }

  private advance(): void {
    while (this.own.has(this.known + 1)) {
      this.own.delete(this.known + 1);
      this.known += 1;
    }
  }
}
