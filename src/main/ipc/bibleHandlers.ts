import { entryTitle, isEntryCollection } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { Channel, WireEntry } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { Handler } from './validate';
import { ancestorsOf, buildGraph, descendantsOf, treeWarnings } from '../../shared/domain/tree';
import { characterPage } from '../../shared/domain/character';
import { positionYear } from '../../shared/domain/position';

/** Channels that act on the open bible. */
export type BibleChannel =
  | 'entry.list'
  | 'entry.get'
  | 'entry.create'
  | 'entry.createMany'
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
  | 'search.query'
  | 'proposal.list'
  | 'proposal.diff'
  | 'proposal.approve'
  | 'proposal.edit'
  | 'proposal.reject'
  | 'proposal.refresh'
  | 'tree.get'
  | 'tree.lineage'
  | 'tree.savePositions'
  | 'character.page'
  | 'storyTime.get'
  | 'storyTime.set';

/** Channels that exist only outside a packaged app. */
export type TestChannel = 'test.propose';

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

  const graph = () => {
    const { model } = session();
    return buildGraph(model.all('characters'), model.all('unions'), model.all('parentLinks'));
  };
  const position = () => {
    const { model, repo } = session();
    return positionYear(repo.storyTime(), model.all('chapters'));
  };

  const proposalView = (id: string) => {
    const { repo, model } = session();
    const d = repo.proposalDiff(id);
    const target = d.proposal.targetId
      ? model.get(d.proposal.collection, d.proposal.targetId)
      : undefined;
    return { ...d, targetTitle: target ? entryTitle(target) : null };
  };

  return {
    'proposal.list': ({ state }) => ({
      proposals: session()
        .repo.listProposals(state)
        .map((p) => proposalView(p._id)),
    }),
    'proposal.diff': ({ id }) => proposalView(id),
    'proposal.approve': async ({ id }) => ({ proposal: await session().repo.applyProposal(id) }),
    'proposal.edit': async ({ id, data }) => ({
      proposal: await session().repo.editProposal(id, data),
    }),
    'proposal.reject': async ({ id }) => ({ proposal: await session().repo.rejectProposal(id) }),
    'proposal.refresh': async ({ id }) => {
      await session().repo.refreshProposal(id);
      return proposalView(id);
    },
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
    'entry.createMany': async ({ items }) => {
      const created = await session().repo.createMany(items);
      return {
        entries: created.map((entry, i) =>
          withWarnings((items[i] as { collection: EntryCollection }).collection, entry),
        ),
      };
    },
    'tree.get': () => {
      const g = graph();
      return {
        people: g.people,
        unions: g.unions,
        links: g.links,
        warnings: treeWarnings(g),
        positions: session().repo.treePositions(),
      };
    },
    'tree.savePositions': async ({ positions }) => {
      await session().repo.setTreePositions(positions);
      return { ok: true as const };
    },
    'tree.lineage': ({ id }) => {
      const g = graph();
      if (!g.byId.has(id)) throw new Error(`No character has the ID ${id}.`);
      const order = (ids: Set<string>) =>
        [...ids].sort((a, b) => (g.rank.get(a) ?? 0) - (g.rank.get(b) ?? 0));
      return { ancestors: order(ancestorsOf(g, id)), descendants: order(descendantsOf(g, id)) };
    },
    'character.page': ({ id }) => {
      const { model, repo } = session();
      // The current position is the last written chapter, whatever the story time (CH-3).
      const current = positionYear(null, model.all('chapters'));
      const page = characterPage(model, id, current, repo.storyTime());
      if (!page) throw new Error(`No character has the ID ${id}.`);
      return { page };
    },
    'storyTime.get': () => ({ time: session().repo.storyTime(), position: position() }),
    'storyTime.set': async ({ time }) => {
      const saved = await session().repo.setStoryTime(time);
      return { time: saved, position: position() };
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

/** Test-only handlers: never registered in a packaged app. */
export function testHandlers(current: () => OpenBible | null): { [C in TestChannel]: Handler<C> } {
  return {
    'test.propose': async (req) => {
      const s = current();
      if (!s) throw new Error(NO_BIBLE);
      return { proposal: await s.repo.propose(req) };
    },
  };
}

export const BIBLE_CHANNELS = Object.keys(bibleHandlers(() => null)) as (BibleChannel & Channel)[];
