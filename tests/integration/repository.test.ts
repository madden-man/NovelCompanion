import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RepositoryError, ValidationError, createBible } from '../../src/main/db';
import type { ChangeEvent } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Store } from '../../src/main/db';
import { freshSlug, localStore } from '../helpers/db';
// a47-guard
import { MANUSCRIPT_LOCKED, Repository } from '../../src/main/db/repository';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
const events: ChangeEvent[] = [];

beforeAll(async () => {
  store = await localStore();
  const { id } = await createBible(store, freshSlug('repo'), 'repo');
  bible = await openBibleSession(store, id);
  bible.repo.onChange((e) => events.push(e));
});
afterAll(async () => {
  await store.close();
});

const margaret = {
  title: 'Margaret Hale',
  status: 'canon' as const,
  provenance: 'invented' as const,
  names: { full: 'Margaret Hale' },
  birth: { year: 1958 },
  death: { year: 2041 },
  links: [{ targetId: 'H2', kind: 'spouse' }],
};

describe('ARCH-2 one write path for entries', () => {
  test('ARCH-2 create, update, soft delete, and restore a character, with a revision for each write', async () => {
    const { repo, handle, model } = bible;
    const created = await repo.create('characters', margaret);
    expect(created._id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.createdAt).toBe(created.modifiedAt);
    expect(created.body).toBe('');
    expect(created.tags).toEqual([]);
    const id = created._id;

    // Stored as zod accepted it, and in the read model.
    expect(await handle.collection('characters').findOne({ _id: id as never })).toEqual(created);
    expect(model.get('characters', id)).toEqual(created);

    const updated = await repo.update('characters', id, {
      title: 'Margaret Doyle Hale',
      tags: ['matriarch'],
    });
    expect(updated.title).toBe('Margaret Doyle Hale');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.modifiedAt > created.modifiedAt).toBe(true);
    expect(repo.get('characters', id)?.tags).toEqual(['matriarch']);

    const trashed = await repo.softDelete('characters', id);
    expect(trashed.deletedAt).toBeDefined();
    expect(repo.get('characters', id)).toBeUndefined();
    expect(repo.get('characters', id, { includeDeleted: true })?.deletedAt).toBe(trashed.deletedAt);
    expect(repo.list('characters').map((c) => c._id)).not.toContain(id);
    expect(repo.list('characters', { includeDeleted: true }).map((c) => c._id)).toContain(id);

    const restored = await repo.restore('characters', id);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.links).toEqual(margaret.links);
    expect(repo.get('characters', id)?.title).toBe('Margaret Doyle Hale');
    const stored = await handle.collection('characters').findOne({ _id: id as never });
    expect(stored).not.toHaveProperty('deletedAt');

    const revisions = await repo.revisions('characters', id);
    expect(revisions.map((r) => r.op)).toEqual(['create', 'update', 'softDelete', 'restore']);
    expect(revisions[0]!.prior).toBeNull();
    expect(revisions[1]!.prior).toEqual(created);
    expect(revisions[2]!.prior).toEqual(updated);
    expect(revisions[3]!.prior).toEqual(trashed);

    expect(events.filter((e) => e.id === id)).toEqual(
      ['create', 'update', 'softDelete', 'restore'].map((op) => ({
        bible: handle.id,
        collection: 'characters',
        id,
        op,
      })),
    );
  });

  test('ARCH-2 invalid writes are rejected with zod and leave no trace', async () => {
    const { repo, handle } = bible;
    const before = await handle.collection('revisions').countDocuments();
    await expect(
      repo.create('characters', { ...margaret, status: 'maybe' as never }),
    ).rejects.toThrow(ValidationError);
    await expect(repo.create('characters', { ...margaret, names: { full: '' } })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      repo.create('characters', { ...margaret, unexpected: true } as never),
    ).rejects.toThrow(ValidationError);
    const ok = await repo.create('characters', margaret);
    await expect(
      repo.update('characters', ok._id, { birth: { year: 'old' } as never }),
    ).rejects.toThrow(ValidationError);
    expect(repo.get('characters', ok._id)?.birth).toEqual({ year: 1958 });
    expect(await handle.collection('revisions').countDocuments()).toBe(before + 1);
  });

  test('ARCH-2 writes to unknown entries or sections fail plainly', async () => {
    const { repo } = bible;
    await expect(repo.update('characters', 'NOPE', { title: 'x' })).rejects.toThrow(
      RepositoryError,
    );
    await expect(repo.softDelete('characters', 'NOPE')).rejects.toThrow(/No characters entry/);
    await expect(repo.create('nonsense' as never, {} as never)).rejects.toThrow(/Unknown section/);
    const c = await repo.create('characters', margaret);
    await expect(repo.restore('characters', c._id)).rejects.toThrow(/not in the trash/);
  });

  test('ARCH-2 an update builds on the newest stored document, not a cached copy', async () => {
    const { repo, handle } = bible;
    const c = await repo.create('characters', margaret);
    // Simulate another writer changing the document after the repository read it.
    await handle
      .collection('characters')
      .updateOne({ _id: c._id as never }, { $set: { modifiedAt: '2099-01-01T00:00:00.000Z' } });
    const mine = await repo.update('characters', c._id, { title: 'Mine' });
    expect(mine.modifiedAt > '2099-01-01T00:00:00.000Z').toBe(true);
    const revs = await repo.revisions('characters', c._id);
    expect(revs.at(-1)!.prior?.modifiedAt).toBe('2099-01-01T00:00:00.000Z');
  });

  test('ARCH-2 the read model loads every collection of the bible on open', async () => {
    const reopened = await openBibleSession(store, bible.handle.id);
    expect(reopened.model.collections()).toEqual(
      expect.arrayContaining(['characters', 'lists', 'chapters', 'worldEvents']),
    );
    expect(reopened.model.collections()).not.toContain('revisions');
    expect(reopened.model.size('characters')).toBe(bible.model.size('characters'));
    expect(reopened.model.size('lists')).toBeGreaterThan(0);
  });
});

// ---------- a47-guard: IP-16 housekeeping and IP-18 the manuscript lock, on the fixture bible ----------

describe('IP-16 IP-18 housekeeping and the manuscript lock on the fixture', () => {
  let fx: OpenBible;
  let invoke: Invoke;
  const fxEvents: ChangeEvent[] = [];
  const revisionsOf = (collection: string, entryId: string) =>
    fx.handle.collection('revisions').countDocuments({ collection, entryId });

  beforeAll(async () => {
    fx = await openBibleSession(store, (await loadFixture(store, freshSlug('guard'))).id);
    fx.repo.onChange((e) => fxEvents.push(e));
    invoke = ipcFor(() => fx);
  });

  /** A place written three times, linked from Margaret (H1), then moved to the trash. */
  async function trashedPlace(title: string) {
    const place = await invoke('entry.create', {
      collection: 'places',
      data: { title, status: 'idea' },
    });
    const id = place.entry._id;
    await invoke('entry.update', { collection: 'places', id, patch: { body: '<p>Wet.</p>' } });
    const h1 = fx.model.get('characters', 'H1')!;
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H1',
      patch: { links: [...(h1.links as object[]), { targetId: id, kind: 'related' }] },
    });
    await invoke('entry.delete', { collection: 'places', id });
    return id;
  }

  test('IP-16 entry.purge deletes an entry in the trash and its revisions in one go, and is not a revision itself', async () => {
    const id = await trashedPlace('The porch by the river');
    expect(await revisionsOf('places', id)).toBe(3);
    fx.search.rebuild(fx.model);
    const before = await fx.handle.collection('revisions').countDocuments({});
    const counts = await invoke('entry.purge', { collection: 'places', id });
    expect(counts).toEqual({ entries: 1, revisions: 3 });
    expect(await fx.handle.collection('places').findOne({ _id: id as never })).toBeNull();
    expect(await revisionsOf('places', id)).toBe(0);
    // A purge writes no revision of its own (A40: not an undo step).
    expect(await fx.handle.collection('revisions').countDocuments({})).toBe(before - 3);
    // The read model and the search index drop it.
    expect(fx.model.get('places', id)).toBeUndefined();
    expect(fx.repo.trash().some((t) => t.entry._id === id)).toBe(false);
    expect(fx.search.search('porch river').some((h) => h.id === id)).toBe(false);
    expect(fxEvents.at(-1)).toMatchObject({ collection: 'places', id, op: 'purge' });
  });

  test('IP-16 a purged entry leaves its backlinks as dangling links the warnings report', async () => {
    const id = await trashedPlace('The boathouse');
    await invoke('entry.purge', { collection: 'places', id });
    const h1 = await invoke('entry.get', { collection: 'characters', id: 'H1' });
    expect((h1.entry.links as { targetId: string }[]).map((l) => l.targetId)).toContain(id);
    expect(h1.warnings).toContainEqual(
      expect.objectContaining({
        code: 'missing-target',
        message: `No entry has the ID ${id}. It may have been deleted for good.`,
      }),
    );
  });

  test('IP-16 entry.purge refuses an entry that is not in the trash, and writes nothing', async () => {
    const before = await revisionsOf('characters', 'H2');
    await expect(invoke('entry.purge', { collection: 'characters', id: 'H2' })).rejects.toThrow(
      'Only an entry in the trash can be deleted forever. Move it to the trash first.',
    );
    expect(fx.model.get('characters', 'H2')).toBeDefined();
    expect(await revisionsOf('characters', 'H2')).toBe(before);
  });

  test('IP-16 trash.empty deletes every trashed entry across sections and their revisions, in one transaction', async () => {
    const place = await trashedPlace('The old ferry dock');
    await invoke('entry.delete', { collection: 'culturalEntries', id: 'CU1' });
    const trashed = fx.repo.trash();
    expect(trashed.map((t) => t.entry._id)).toEqual(expect.arrayContaining([place, 'CU1']));
    let revisions = 0;
    for (const t of trashed) revisions += await revisionsOf(t.collection, t.entry._id);
    const counts = await invoke('trash.empty', {});
    expect(counts).toEqual({ entries: trashed.length, revisions });
    expect(fx.repo.trash()).toEqual([]);
    expect(fx.model.get('culturalEntries', 'CU1')).toBeUndefined();
    expect(
      await fx.handle.collection('culturalEntries').findOne({ _id: 'CU1' as never }),
    ).toBeNull();
    // Nothing left to empty.
    expect(await invoke('trash.empty', {})).toEqual({ entries: 0, revisions: 0 });
  });

  test('IP-16 trash.empty writes nothing when the transaction fails part way', async () => {
    const id = await trashedPlace('The tea house');
    const failing = new Repository(fx.handle, fx.model, fx.search, () => new Date(), {
      midTransaction: async () => {
        throw new Error('killed');
      },
    });
    await expect(failing.emptyTrash()).rejects.toThrow();
    expect(await fx.handle.collection('places').findOne({ _id: id as never })).not.toBeNull();
    expect(await revisionsOf('places', id)).toBe(3);
    expect(fx.model.get('places', id)?.deletedAt).toBeTruthy();
  });

  test('IP-16 revisions.prune counts first with dryRun, then removes the revisions before a date, for one entry or the whole bible', async () => {
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H3',
      patch: { body: '<p>One.</p>' },
    });
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H3',
      patch: { body: '<p>Two.</p>' },
    });
    const all = await fx.handle.collection('revisions').countDocuments({});
    const mine = await revisionsOf('characters', 'H3');
    expect(mine).toBe(2);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const dry = await invoke('revisions.prune', {
      collection: 'characters',
      id: 'H3',
      before: tomorrow,
      dryRun: true,
    });
    expect(dry).toEqual({ count: 2 });
    expect(await revisionsOf('characters', 'H3')).toBe(2);
    // Nothing is older than a date long past.
    expect(
      await invoke('revisions.prune', { collection: 'characters', id: 'H3', before: '2000-01-01' }),
    ).toEqual({ count: 0 });
    expect(
      await invoke('revisions.prune', { collection: 'characters', id: 'H3', before: tomorrow }),
    ).toEqual({ count: 2 });
    expect(await revisionsOf('characters', 'H3')).toBe(0);
    // The history still opens; the entry is as it was.
    expect(await invoke('revisions.list', { collection: 'characters', id: 'H3' })).toEqual({
      revisions: [],
    });
    expect(fx.model.get('characters', 'H3')!.body).toBe('<p>Two.</p>');
    // The whole bible.
    const rest = all - 2;
    expect(await invoke('revisions.prune', { before: tomorrow, dryRun: true })).toEqual({
      count: rest,
    });
    expect(await invoke('revisions.prune', { before: tomorrow })).toEqual({ count: rest });
    expect(await fx.handle.collection('revisions').countDocuments({})).toBe(0);
    await expect(invoke('revisions.prune', { id: 'H3', before: tomorrow })).rejects.toThrow(
      /Say which section the entry is in/,
    );
  });

  test('IP-18 the write path refuses a change to the manuscript text from anything but the importer, with a plain error', async () => {
    const before = fx.model.get('chapters', 'CH5')!;
    const revs = await revisionsOf('chapters', 'CH5');
    for (const patch of [
      { manuscriptText: '<p>Rewritten here.</p>' },
      { manuscriptSource: 'word:/tmp/other.docx' },
      { sourceFile: 'other.docx' },
    ]) {
      await expect(
        invoke('entry.update', { collection: 'chapters', id: 'CH5', patch }),
      ).rejects.toThrow('The manuscript text is imported, not edited here. Use Re-import.');
      await expect(fx.repo.update('chapters', 'CH5', patch)).rejects.toThrow(MANUSCRIPT_LOCKED);
    }
    // A batch is the same write path.
    await expect(
      fx.repo.writeBatch([
        { op: 'update', collection: 'chapters', id: 'CH5', patch: { manuscriptText: 'x' } },
      ]),
    ).rejects.toThrow(MANUSCRIPT_LOCKED);
    expect(fx.model.get('chapters', 'CH5')).toEqual(before);
    expect(await revisionsOf('chapters', 'CH5')).toBe(revs);
    // A save that repeats the stored text, as a whole entry saved back, is not a change.
    const ok = await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH5',
      patch: { summary: 'Ruth counts candles.', manuscriptText: before.manuscriptText },
    });
    expect(ok.entry.summary).toBe('Ruth counts candles.');
    expect(ok.entry.manuscriptText).toBe(before.manuscriptText);
  });

  test('IP-18 the importer still writes the manuscript fields, and restoring an older revision keeps them', async () => {
    const text = String(fx.model.get('chapters', 'CH4')!.manuscriptText);
    const next = `${text}<p>Imported again.</p>`;
    const written = await fx.repo.update(
      'chapters',
      'CH4',
      { manuscriptText: next, sourceFile: 'chapter-04.docx' },
      { importer: true },
    );
    expect(written.manuscriptText).toBe(next);
    const history = await invoke('revisions.list', { collection: 'chapters', id: 'CH4' });
    const first = history.revisions.at(-1)!;
    await invoke('entry.update', { collection: 'chapters', id: 'CH4', patch: { summary: 'S.' } });
    // The oldest revision holds the old text; a restore brings back the rest, never the text.
    const restored = await invoke('revisions.restore', {
      collection: 'chapters',
      id: 'CH4',
      revisionId: first._id,
    });
    expect(restored.entry.manuscriptText).toBe(next);
  });
});
