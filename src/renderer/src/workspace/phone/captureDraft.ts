import type { EditMarks } from '../capture';

/**
 * A58 U5 (PH-27): what is typed in the phone's capture page, kept outside the
 * page. Back, an edge swipe or another tab takes the page away, and iOS may
 * drop a hidden app; the sentence, its chips and the IDs of a keep that was
 * not answered stay here (and in the tab's sessionStorage) until a press
 * lands or the field is emptied. One draft per bible.
 */
export interface PhoneCaptureDraft {
  text: string;
  marks: EditMarks;
  /** The ID each sentence was kept under on a press that was not answered, so a second press is the same keep. */
  keepIds: Record<string, string>;
}

const PREFIX = 'nc.phoneCaptureDraft:';
const EMPTY: PhoneCaptureDraft = { text: '', marks: {}, keepIds: {} };

let bible = '';
const held = new Map<string, PhoneCaptureDraft>();

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(raw: string | null): PhoneCaptureDraft {
  if (!raw) return EMPTY;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || typeof v.text !== 'string') return EMPTY;
    const keepIds = isRecord(v.keepIds)
      ? Object.fromEntries(
          Object.entries(v.keepIds).filter((e): e is [string, string] => typeof e[1] === 'string'),
        )
      : {};
    return { text: v.text, marks: isRecord(v.marks) ? (v.marks as EditMarks) : {}, keepIds };
  } catch {
    return EMPTY;
  }
}

/** The bible the drafts belong to, set by the phone's frame before the page draws. */
export function setDraftBible(id: string): void {
  bible = id;
}

export function readDraft(): PhoneCaptureDraft {
  const have = held.get(bible);
  if (have) return have;
  let d = EMPTY;
  try {
    d = parse(storage()?.getItem(PREFIX + bible) ?? null);
  } catch {
    // Storage refused: the draft lives in memory only.
  }
  held.set(bible, d);
  return d;
}

export function writeDraft(change: Partial<PhoneCaptureDraft>): void {
  const next = { ...readDraft(), ...change };
  held.set(bible, next);
  try {
    const s = storage();
    if (!next.text && !Object.keys(next.keepIds).length) s?.removeItem(PREFIX + bible);
    else s?.setItem(PREFIX + bible, JSON.stringify(next));
  } catch {
    // Storage full or refused: memory still holds it for this visit.
  }
}

/** Sign out: no typed sentence stays behind for any bible. */
export function clearDrafts(): void {
  held.clear();
  try {
    const s = storage();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // Nothing to clear.
  }
}
