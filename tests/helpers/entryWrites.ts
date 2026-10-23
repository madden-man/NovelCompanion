import type { ReadModel } from '../../src/main/readmodel';
import { ENTRY_COLLECTIONS } from '../../src/shared/schema';

/** Every entry's modified time by `collection:id`, trashed ones too. */
export type EntryStamps = Map<string, string>;

export function entryStamps(model: ReadModel): EntryStamps {
  const out: EntryStamps = new Map();
  for (const c of ENTRY_COLLECTIONS) {
    for (const d of model.all(c)) out.set(`${c}:${d._id}`, String(d.modifiedAt));
  }
  return out;
}

/** How many entries were created, changed or removed since `before`. */
export function entriesWritten(model: ReadModel, before: EntryStamps): number {
  const now = entryStamps(model);
  let n = 0;
  for (const [key, at] of now) if (before.get(key) !== at) n++;
  for (const key of before.keys()) if (!now.has(key)) n++;
  return n;
}
