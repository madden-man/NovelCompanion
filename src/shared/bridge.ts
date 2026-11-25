/**
 * The phone bridge, Novel Companion's half (A55, NB-1 to NB-3). FlowState's
 * Netlify function writes what the phone sends into `bridge_up` and reads
 * what this app writes into `bridge_worlds` and `bridge_down`. The shapes
 * here are FlowState's contract (`src/bridge/protocol.ts` and
 * `docs/BRIDGE.md` in the FlowState repository), copied, not shared: a
 * change there is a change here, by hand.
 *
 * The three collections sit in `novel_companion` beside `bibles`, outside
 * every bible's `<bibleId>.` prefix, so ARCH-8's one database holds.
 */
import { BIBLE_SLUG_PATTERN } from './bible';

export const BRIDGE_WORLDS = 'bridge_worlds';
export const BRIDGE_DOWN = 'bridge_down';
export const BRIDGE_UP = 'bridge_up';
export const BRIDGE_COLLECTIONS = [BRIDGE_WORLDS, BRIDGE_DOWN, BRIDGE_UP] as const;
export type BridgeCollection = (typeof BRIDGE_COLLECTIONS)[number];

/** FlowState's world ID rule (protocol.ts `WORLD_ID`). */
export const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** FlowState's stamp rule (protocol.ts `STAMP`). */
export const STAMP = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * A bible's world ID: its own ID, with an underscore (which a bible ID may
 * hold and a world ID may not) written as a dash. `eastwinds` stays
 * `eastwinds`. Null for an ID that cannot be one.
 */
export function worldIdFor(bibleId: string): string | null {
  if (!BIBLE_SLUG_PATTERN.test(bibleId)) return null;
  const id = bibleId.replace(/_/g, '-');
  return WORLD_ID.test(id) ? id : null;
}

/** The registry row (`bridge_worlds`), exactly as FlowState reads it. */
export interface WorldRow {
  _id: string;
  name: string;
  kind: 'novel';
}

/** One character as the phone wears it (protocol.ts `PocketCharacter`). */
export interface PocketCharacter {
  id: string;
  fullName: string;
  firstName: string;
  chineseName?: string;
  /** The family's colour, a six-digit hex string. */
  familyColour?: string;
  born?: number;
  died?: number;
}

export interface PocketQuestion {
  id: string;
  question: string;
  state: 'open' | 'decided';
  decision?: string;
  /** Milliseconds since 1970, the question's last change. */
  changedAt: number;
}

/** The pocket for a novel (protocol.ts `NovelPocket`). */
export interface NovelPocket {
  kind: 'novel';
  characters: PocketCharacter[];
  places: { id: string; name: string; community?: string }[];
  chapters: { id: string; title: string; year?: number }[];
  events: { id: string; title: string; year: number }[];
  storyYear?: number;
  span?: { from: number; to: number };
  questions: PocketQuestion[];
}

/** The pocket row (`bridge_down`). */
export interface DownRow {
  _id: string;
  stamp: string;
  pocket: NovelPocket;
}

/** The tables an envelope may come from (protocol.ts `TRAVELS`). */
export const TRAVELS = ['pages', 'messages', 'inquiries', 'songs', 'takes'] as const;
export type TravelTable = (typeof TRAVELS)[number];

/**
 * One row of `bridge_up` as the function stores it:
 * `{ _id: "<world>:<table>:<id>", world, table, id, rev, deleted, row, at }`.
 * The newest rev for an ID is the only one kept; a delete has `row: null`.
 */
export interface UpRow {
  _id: string;
  world: string;
  table: TravelTable;
  id: string;
  rev: number;
  deleted: boolean;
  row: Record<string, unknown> | null;
  at: number;
}

/**
 * The world ID a bible is published under, given every bible's ID: null
 * when its ID cannot be one or another bible's ID gives the same world ID
 * (`a_b` and `a-b`), so two bibles never share a world.
 */
export function worldForBible(bibleId: string, allBibleIds: readonly string[]): string | null {
  const world = worldIdFor(bibleId);
  if (!world) return null;
  const clash = allBibleIds.some((other) => other !== bibleId && worldIdFor(other) === world);
  return clash ? null : world;
}
