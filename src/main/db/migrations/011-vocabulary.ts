import type { Document } from 'mongodb';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

export const MIGRATION11_META_ID = 'migration11';

/** What migration 11 did, kept in `meta`. */
export interface Migration11Summary {
  _id: typeof MIGRATION11_META_ID;
  /** Items made in the `regions` list from the region names events used. */
  regionsMade: number;
  /** World events (trashed ones too) whose regions became item IDs. */
  eventsRewritten: number;
  /** Families whose colour token became a hex colour. */
  familiesRecoloured: number;
  /** Items added to or given a colour or kind in `statuses`, `provenance` and `ageGroups`. */
  itemsSeeded: number;
  takenAt: string;
}

interface Item {
  id: string;
  label: string;
  parentId: string | null;
  color?: string | null;
  extra?: Record<string, string | number>;
}
interface List {
  _id: string;
  label: string;
  items: Item[];
}

/*
 * The values below are written out because migrations never change. The
 * colours are the light theme values of the tokens in `theme.css` as of A47;
 * the renderer draws these hex values through the same tokens, so they still
 * follow the theme.
 */

/** IP-9: the statuses, each with the kind SB-5 reads. */
export const STATUS_SEED: Item[] = [
  { id: 'canon', label: 'Canon', parentId: null, color: '#1b705f', extra: { kind: 'canon' } },
  { id: 'planned', label: 'Planned', parentId: null, color: '#4a3aa7', extra: { kind: 'planned' } },
  { id: 'idea', label: 'Idea', parentId: null, color: '#7a611b', extra: { kind: 'idea' } },
];

/** IP-9: provenance (series-1 and serious-ink, which pass contrast in both themes). */
export const PROVENANCE_SEED: Item[] = [
  { id: 'researched', label: 'Researched', parentId: null, color: '#2a78d6', extra: {} },
  { id: 'invented', label: 'Invented', parentId: null, color: '#b84f25', extra: {} },
];

/** IP-10: the six age groups of A41, with their ages; the open bands have no `to`. */
export const AGE_GROUP_SEED: Item[] = [
  { id: 'all', label: 'Everyone', parentId: null, color: null, extra: { from: 0 } },
  { id: '0-18', label: 'Ages 0 to 18', parentId: null, color: null, extra: { from: 0, to: 18 } },
  { id: '18-30', label: 'Ages 18 to 30', parentId: null, color: null, extra: { from: 18, to: 30 } },
  { id: '30-50', label: 'Ages 30 to 50', parentId: null, color: null, extra: { from: 30, to: 50 } },
  { id: '50-70', label: 'Ages 50 to 70', parentId: null, color: null, extra: { from: 50, to: 70 } },
  { id: '70+', label: 'Ages 70 and over', parentId: null, color: null, extra: { from: 70 } },
];

/** IP-12: the four family colour tokens and their light theme hex values. */
export const FAMILY_TOKEN_SEED: Record<string, string> = {
  'series-1': '#2a78d6',
  'series-2': '#eb6834',
  'series-3': '#1baf7a',
  'series-4': '#4a3aa7',
};

const HEX = /^#[0-9a-f]{6}$/i;

/** A region item ID from its name, unique within the list (as `newItemId` does). */
function regionId(taken: readonly Item[], label: string): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'region';
  let id = base;
  for (let n = 2; taken.some((i) => i.id === id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Add the seeded items a list lacks, and give each seeded item that has
 * none its colour and extra values. Labels the writer changed are kept.
 * Returns the number of items changed.
 */
function seedInto(list: List, seed: readonly Item[]): number {
  let n = 0;
  for (const s of seed) {
    const i = list.items.findIndex((x) => x.id === s.id);
    const cur = list.items[i];
    if (!cur) {
      list.items.push({ ...s, extra: { ...s.extra } });
      n++;
      continue;
    }
    const extra = { ...(s.extra ?? {}), ...(cur.extra ?? {}) };
    const color = cur.color ?? s.color ?? null;
    if (
      color !== (cur.color ?? null) ||
      Object.keys(extra).length !== Object.keys(cur.extra ?? {}).length
    ) {
      list.items[i] = { ...cur, color, extra };
      n++;
    }
  }
  return n;
}

/**
 * A47 (schema version 11): the vocabulary belongs to the writer.
 * - `regions` becomes a list, made from every region name world events use
 *   (trashed events too), in name order; each event then stores the item IDs.
 * - `statuses` and `provenance` hold their items with colours, and each
 *   status its kind (IP-9); `ageGroups` is a list of the six A41 bands with
 *   their ages, under the IDs cultural lines already store (IP-10).
 * - A family's colour token becomes its hex colour (IP-12).
 * - The brief window stored before A47 becomes the bible's `windowBefore` (IP-11).
 * Modified times are not touched and revisions keep what they held.
 * `openBibleSession` takes a snapshot first. Running it again changes nothing.
 */
export const vocabulary: Migration = {
  version: 11,
  name: 'regions, statuses, provenance and age groups as lists; family colours as hex',
  async up(bible: BibleHandle) {
    const lists = bible.collection<List>('lists');
    const existing = new Set(await bible.collectionNames());

    // Regions: a list from every name events use, then the events store IDs.
    const regions: List = (await lists.findOne({ _id: 'regions' })) ?? {
      _id: 'regions',
      label: 'Regions',
      items: [],
    };
    const events = existing.has('worldEvents')
      ? await bible.collection<Document>('worldEvents').find({}).toArray()
      : [];
    const names = new Set<string>();
    for (const e of events) {
      for (const r of Array.isArray(e.regions) ? (e.regions as unknown[]) : []) {
        if (typeof r === 'string' && r.trim()) names.add(r.trim());
      }
    }
    const idFor = new Map<string, string>();
    let regionsMade = 0;
    const byLabel = (name: string) =>
      regions.items.find((i) => i.label === name) ??
      regions.items.find((i) => i.label.toLowerCase() === name.toLowerCase());
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      // An ID already in the list (this migration ran before) stays as it is.
      const known = regions.items.find((i) => i.id === name) ?? byLabel(name);
      if (known) {
        idFor.set(name, known.id);
        continue;
      }
      const id = regionId(regions.items, name);
      regions.items.push({ id, label: name, parentId: null, color: null, extra: {} });
      idFor.set(name, id);
      regionsMade++;
    }
    await lists.replaceOne({ _id: 'regions' }, regions, { upsert: true });
    let eventsRewritten = 0;
    for (const e of events) {
      if (!Array.isArray(e.regions)) continue;
      const before = e.regions as unknown[];
      const after = [
        ...new Set(
          before
            .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
            .map((r) => idFor.get(r.trim()) ?? r),
        ),
      ];
      if (after.length === before.length && after.every((r, i) => r === before[i])) continue;
      await bible
        .collection<Document>('worldEvents')
        .updateOne({ _id: e._id }, { $set: { regions: after } });
      eventsRewritten++;
    }

    // Statuses, provenance and age groups hold their items, with colours and kinds.
    let itemsSeeded = 0;
    const seeds: [string, string, Item[]][] = [
      ['statuses', 'Statuses', STATUS_SEED],
      ['provenance', 'Provenance', PROVENANCE_SEED],
      ['ageGroups', 'Age groups', AGE_GROUP_SEED],
    ];
    for (const [id, label, seed] of seeds) {
      const list: List = (await lists.findOne({ _id: id })) ?? { _id: id, label, items: [] };
      const n = seedInto(list, seed);
      if (n > 0) await lists.replaceOne({ _id: id }, list, { upsert: true });
      itemsSeeded += n;
    }

    // Family colours: a token becomes its hex; anything else that is not a hex becomes the first.
    let familiesRecoloured = 0;
    if (existing.has('families')) {
      const families = bible.collection<Document>('families');
      for (const f of await families.find({}).toArray()) {
        const c = f.color;
        if (typeof c === 'string' && HEX.test(c)) continue;
        const hex =
          (typeof c === 'string' ? FAMILY_TOKEN_SEED[c] : undefined) ??
          (FAMILY_TOKEN_SEED['series-1'] as string);
        await families.updateOne({ _id: f._id }, { $set: { color: hex } });
        familiesRecoloured++;
      }
    }

    // The brief window before A47 becomes the one world window of the bible's numbers.
    const meta = bible.collection<Document>('meta');
    const brief = await meta.findOne({ _id: 'briefSettings' } as Document);
    const w = brief?.window;
    const settings = await meta.findOne({ _id: 'bibleSettings' } as Document);
    const has = (settings?.numbers as Record<string, unknown> | undefined)?.windowBefore;
    if (typeof w === 'number' && Number.isInteger(w) && w >= 0 && w <= 200 && has === undefined) {
      await meta.updateOne(
        { _id: 'bibleSettings' } as Document,
        { $set: { 'numbers.windowBefore': w } },
        { upsert: true },
      );
    }

    const summary: Migration11Summary = {
      _id: MIGRATION11_META_ID,
      regionsMade,
      eventsRewritten,
      familiesRecoloured,
      itemsSeeded,
      takenAt: new Date().toISOString(),
    };
    await meta.updateOne(
      { _id: MIGRATION11_META_ID } as Document,
      { $setOnInsert: summary } as Document,
      { upsert: true },
    );
  },
};
