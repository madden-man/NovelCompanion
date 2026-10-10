import { entryTitle, isEntryCollection } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { Channel, WireEntry } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { Handler } from './validate';

/** Channels that act on the open bible. */
export type BibleChannel =
  | 'entry.list'
  | 'entry.get'
  | 'entry.create'
  | 'entry.update'
  | 'entry.delete'
  | 'entry.restore'
  | 'entry.linkedFrom'
  | 'entry.backlinks'
  | 'entry.lookup'
  | 'trash.list'
  | 'revisions.list'
  | 'revisions.diff'
  | 'revisions.restore'
  | 'lists.get'
  | 'lists.rename'
  | 'lists.addItem'
  | 'lists.removeItem'
  | 'search.query';

export type BibleHandlers = { [C in BibleChannel]: Handler<C> };

export const NO_BIBLE = 'Open a bible first.';

/**
 * Handlers for every bible channel, independent of Electron so the
 * integration suite can drive the same IPC layer (zod on both sides through
 * `runHandler`) that the renderer uses.
 */
export function bibleHandlers(current: () => OpenBible | null): BibleHandlers {
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };
  // Stored entries carry modifiedAt; the response schema checks it on the way out.
  const wire = (d: StoredDoc) => d as unknown as WireEntry;
  const withWarnings = (c: EntryCollection, entry: StoredDoc) => ({
    entry: wire(entry),
    warnings: session().repo.warnings(c, entry),
  });
  const titled = (links: { collection: string; id: string; kind: string }[]) =>
    links
      .filter((b): b is typeof b & { collection: EntryCollection } =>
        isEntryCollection(b.collection),
      )
      .map((b) => ({
        ...b,
        title: entryTitle(session().model.get(b.collection, b.id)),
      }));

  return {
    'entry.list': ({ collection, trash }) => {
      const { repo } = session();
      const entries = repo.list(collection, {
        includeDeleted: trash === 'include',
        onlyDeleted: trash === 'only',
      }) as StoredDoc[];
      return { entries: entries.map((e) => withWarnings(collection, e)) };
    },
    'entry.get': ({ collection, id }) => {
      const { repo } = session();
      const entry = repo.get(collection, id, { includeDeleted: true }) as StoredDoc | undefined;
      if (!entry) throw new Error(`No ${collection} entry has the ID ${id}.`);
      return { ...withWarnings(collection, entry), backlinks: titled(repo.backlinks(id)) };
    },
    'entry.create': async ({ collection, data }) => {
      const entry = (await session().repo.create(collection, data as never)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.update': async ({ collection, id, patch }) => {
      const entry = (await session().repo.update(collection, id, patch as never)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.delete': async ({ collection, id }) => {
      const entry = (await session().repo.softDelete(collection, id)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.restore': async ({ collection, id }) => {
      const entry = (await session().repo.restore(collection, id)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.linkedFrom': ({ id }) => {
      const { count, entries } = session().repo.linkedFrom(id);
      return { count, entries: titled(entries) };
    },
    'entry.backlinks': ({ id }) => ({ backlinks: titled(session().repo.backlinks(id)) }),
    'entry.lookup': ({ ids }) => {
      const { model } = session();
      const entries = [];
      for (const id of new Set(ids)) {
        const found = model.find(id);
        if (found && isEntryCollection(found.collection)) {
          entries.push({
            id,
            collection: found.collection,
            title: entryTitle(found.doc),
            inTrash: Boolean(found.doc.deletedAt),
          });
        }
      }
      return { entries };
    },
    'trash.list': () => ({
      entries: session()
        .repo.trash()
        .map((t) => ({ collection: t.collection, entry: wire(t.entry) })),
    }),
    'revisions.list': async ({ collection, id }) => {
      const history = await session().repo.history(collection, id);
      return { revisions: history.map(({ snapshot: _s, ...r }) => r) };
    },
    'revisions.diff': async ({ collection, id, revisionId }) => {
      const d = await session().repo.revisionDiff(collection, id, revisionId);
      return {
        revision: { ...d.revision, snapshot: wire(d.revision.snapshot) },
        current: wire(d.current),
        changes: d.changes,
      };
    },
    'revisions.restore': async ({ collection, id, revisionId }) => {
      const entry = (await session().repo.restoreRevision(collection, id, revisionId)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'lists.get': () => ({ lists: session().repo.lists() }),
    'lists.rename': ({ listId, itemId, label }) =>
      session().repo.renameListItem(listId, itemId, label),
    'lists.addItem': async ({ listId, label, parentId }) => ({
      item: await session().repo.addListItem(listId, label, parentId),
    }),
    'lists.removeItem': async ({ listId, itemId }) => {
      await session().repo.removeListItem(listId, itemId);
      return { ok: true as const };
    },
    'search.query': ({ query, collections, limit }) => {
      const { search, model } = session();
      const hits = search
        .search(query)
        .filter((h): h is typeof h & { collection: EntryCollection } =>
          isEntryCollection(h.collection),
        )
        .filter((h) => !collections || collections.includes(h.collection))
        .filter((h) => !model.get(h.collection, h.id)?.deletedAt)
        .slice(0, limit)
        .map((h) => ({ ...h, title: entryTitle(model.get(h.collection, h.id)) }));
      return { hits };
    },
  };
}

export const BIBLE_CHANNELS = Object.keys(bibleHandlers(() => null)) as (BibleChannel & Channel)[];
