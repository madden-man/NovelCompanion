import { entryTitle } from '../../schema';
import type { EntryCollection, FieldSpec } from '../../schema';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import type { MapContext, MappedRow } from './types';

const STUBBABLE: Partial<Record<EntryCollection, (name: string) => Doc>> = {
  characters: (name) => ({ title: name, names: { full: name }, birth: { unknown: true } }),
  families: (name) => ({ title: name, name }),
  places: (name) => ({ title: name }),
};

const ALL_COLLECTIONS: EntryCollection[] = [
  'characters',
  'families',
  'places',
  'chapters',
  'parts',
  'books',
  'worldEvents',
  'eraStates',
  'culturalEntries',
  'glossaryTerms',
];

/** The names an entry answers to: its title, and for people their full and Chinese names. */
function namesOf(doc: Doc): string[] {
  const out = [entryTitle(doc)];
  const names = doc.names;
  if (isPlainObject(names)) {
    for (const key of ['full', 'chinese']) {
      if (typeof names[key] === 'string') out.push(names[key]);
    }
  }
  return out.map((n) => n.trim().toLowerCase()).filter(Boolean);
}

export interface NameResolver {
  resolve(spec: FieldSpec, name: string): string | null | 'ambiguous';
  /** Stub entries made so far for names that matched nothing. */
  stubs: MappedRow[];
  /** A point to return to when the row that made new stubs fails. */
  mark(): number;
  rollback(mark: number): void;
}

/**
 * Resolve a name in a cell to the ID of an existing entry (by title or by a
 * person's names). With `createMissing`, a name that matches nothing becomes a
 * stub entry that the import creates first, once per name.
 */
export function nameResolver(
  ctx: MapContext,
  opts: { createMissing: boolean; ref: () => string; where: () => string },
): NameResolver {
  const stubs: MappedRow[] = [];
  const made = new Map<string, string>();
  return {
    stubs,
    mark: () => stubs.length,
    rollback(mark) {
      for (const dropped of stubs.splice(mark)) {
        for (const [key, id] of made) if (id === dropped.newId) made.delete(key);
      }
    },
    resolve(spec, name) {
      const want = name.trim().toLowerCase();
      const collections = (spec.target ?? []).includes('*')
        ? ALL_COLLECTIONS
        : ((spec.target ?? []) as EntryCollection[]);
      const hits = new Set<string>();
      for (const c of collections) {
        for (const doc of ctx.entries(c)) {
          if (doc._id === name || namesOf(doc).includes(want)) hits.add(String(doc._id));
        }
      }
      if (hits.size > 1) return 'ambiguous';
      const [only] = [...hits];
      if (hits.size === 1 && only !== undefined) return only;
      const key = `${collections.join(',')}:${want}`;
      const prior = made.get(key);
      if (prior) return prior;
      if (!opts.createMissing) return null;
      const target = collections.find((c) => STUBBABLE[c]);
      const stub = target ? STUBBABLE[target] : undefined;
      if (!target || !stub) return null;
      const id = ctx.newId();
      made.set(key, id);
      stubs.push({
        ref: opts.ref(),
        where: opts.where(),
        ok: true,
        collection: target,
        newId: id,
        fields: {},
        data: {
          ...stub(name.trim()),
          status: 'planned',
          sourceRef: opts.ref(),
          _id: id,
        },
        identity: want,
        kind: 'entry',
      });
      return id;
    },
  };
}
