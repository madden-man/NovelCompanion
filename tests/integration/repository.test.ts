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
  names: { full: 'Margaret Hale' },
  birth: { year: 1958 },
  death: { year: 2041 },
};

describe('ARCH-2 one write path for entries', () => {
  test('ARCH-2 create, update, soft delete, and restore a character, and no revision is written', async () => {
    const { repo, handle, model } = bible;
    const created = await repo.create('characters', margaret);
    expect(created._id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.createdAt).toBe(created.modifiedAt);
    expect(created.body).toBe('');
    const id = created._id;

    // Stored as zod accepted it, and in the read model.
    expect(await handle.collection('characters').findOne({ _id: id as never })).toEqual(created);
    expect(model.get('characters', id)).toEqual(created);

    const updated = await repo.update('characters', id, {
      title: 'Margaret Doyle Hale',
    });
    expect(updated.title).toBe('Margaret Doyle Hale');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.modifiedAt > created.modifiedAt).toBe(true);

    const trashed = await repo.softDelete('characters', id);
    expect(trashed.deletedAt).toBeDefined();
    expect(repo.get('characters', id)).toBeUndefined();
    expect(repo.get('characters', id, { includeDeleted: true })?.deletedAt).toBe(trashed.deletedAt);
    expect(repo.list('characters').map((c) => c._id)).not.toContain(id);
    expect(repo.list('characters', { includeDeleted: true }).map((c) => c._id)).toContain(id);

    const restored = await repo.restore('characters', id);
    expect(restored.deletedAt).toBeUndefined();
    expect(repo.get('characters', id)?.title).toBe('Margaret Doyle Hale');
    const stored = await handle.collection('characters').findOne({ _id: id as never });
    expect(stored).not.toHaveProperty('deletedAt');

    // A53: no history is kept beside the entries.
    expect(await handle.collectionNames()).not.toContain('revisions');

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
    const before = await handle.collection('characters').countDocuments();
    await expect(
      repo.create('characters', { ...margaret, status: 'canon' } as never),
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
    expect(await handle.collection('characters').countDocuments()).toBe(before + 1);
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
    // The new stamp is later than the other writer's, so the update read the stored document.
    expect(mine.modifiedAt > '2099-01-01T00:00:00.000Z').toBe(true);
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

  beforeAll(async () => {
    fx = await openBibleSession(store, (await loadFixture(store, freshSlug('guard'))).id);
    fx.repo.onChange((e) => fxEvents.push(e));
    invoke = ipcFor(() => fx);
  });

  /** A place written three times, then moved to the trash. */
  async function trashedPlace(title: string) {
    const place = await invoke('entry.create', {
      collection: 'places',
      data: { title },
    });
    const id = place.entry._id;
    await invoke('entry.update', { collection: 'places', id, patch: { body: '<p>Wet.</p>' } });
    await invoke('entry.delete', { collection: 'places', id });
    return id;
  }

  test('IP-16 entry.purge deletes an entry in the trash in one go and counts entries only', async () => {
    const id = await trashedPlace('The porch by the river');
    fx.search.rebuild(fx.model);
    const counts = await invoke('entry.purge', { collection: 'places', id });
    expect(counts).toEqual({ entries: 1 });
    expect(await fx.handle.collection('places').findOne({ _id: id as never })).toBeNull();
    // The read model and the search index drop it.
    expect(fx.model.get('places', id)).toBeUndefined();
    expect(fx.repo.trash().some((t) => t.entry._id === id)).toBe(false);
    expect(fx.search.search('porch river').some((h) => h.id === id)).toBe(false);
    expect(fxEvents.at(-1)).toMatchObject({ collection: 'places', id, op: 'purge' });
  });

  test('IP-16 a purged entry leaves its backlinks as dangling links the warnings report', async () => {
    const id = await trashedPlace('The boathouse');
    const question = await invoke('entry.create', {
      collection: 'openQuestions',
      data: { title: 'Who owns the boathouse?', aboutIds: [id] },
    });
    await invoke('entry.purge', { collection: 'places', id });
    const q = await invoke('entry.get', { collection: 'openQuestions', id: question.entry._id });
    expect(q.entry.aboutIds).toContain(id);
    expect(q.warnings).toContainEqual(
      expect.objectContaining({
        code: 'missing-target',
        message: `No entry has the ID ${id}. It may have been deleted for good.`,
      }),
    );
  });

  test('IP-16 entry.purge refuses an entry that is not in the trash, and writes nothing', async () => {
    const before = await fx.handle.collection('characters').findOne({ _id: 'H2' as never });
    await expect(invoke('entry.purge', { collection: 'characters', id: 'H2' })).rejects.toThrow(
      'Only an entry in the trash can be deleted forever. Move it to the trash first.',
    );
    expect(fx.model.get('characters', 'H2')).toBeDefined();
    expect(await fx.handle.collection('characters').findOne({ _id: 'H2' as never })).toEqual(
      before,
    );
  });

  test('IP-16 trash.empty deletes every trashed entry across sections, in one transaction', async () => {
    const place = await trashedPlace('The old ferry dock');
    await invoke('entry.delete', { collection: 'culturalEntries', id: 'CU1' });
    const trashed = fx.repo.trash();
    expect(trashed.map((t) => t.entry._id)).toEqual(expect.arrayContaining([place, 'CU1']));
    const counts = await invoke('trash.empty', {});
    expect(counts).toEqual({ entries: trashed.length });
    expect(fx.repo.trash()).toEqual([]);
    expect(fx.model.get('culturalEntries', 'CU1')).toBeUndefined();
    expect(
      await fx.handle.collection('culturalEntries').findOne({ _id: 'CU1' as never }),
    ).toBeNull();
    // Nothing left to empty.
    expect(await invoke('trash.empty', {})).toEqual({ entries: 0 });
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
    expect(fx.model.get('places', id)?.deletedAt).toBeTruthy();
  });

  test('IP-18 the write path refuses a change to the manuscript text from anything but the importer, with a plain error', async () => {
    const before = fx.model.get('chapters', 'CH5')!;
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
    // A save that repeats the stored text, as a whole entry saved back, is not a change.
    const ok = await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH5',
      patch: { summary: 'Ruth counts candles.', manuscriptText: before.manuscriptText },
    });
    expect(ok.entry.summary).toBe('Ruth counts candles.');
    expect(ok.entry.manuscriptText).toBe(before.manuscriptText);
  });

  test('IP-18 the importer still writes the manuscript fields', async () => {
    const text = String(fx.model.get('chapters', 'CH4')!.manuscriptText);
    const next = `${text}<p>Imported again.</p>`;
    const written = await fx.repo.update(
      'chapters',
      'CH4',
      { manuscriptText: next, sourceFile: 'chapter-04.docx' },
      { importer: true },
    );
    expect(written.manuscriptText).toBe(next);
    expect(written.sourceFile).toBe('chapter-04.docx');
  });
});

describe('IP-18 the manuscript lock on the create paths', () => {
  let fx: OpenBible;
  let invoke: Invoke;
  const chapter = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    partId: 'PT1',
    readingOrder: 90,
    strands: [{ id: 'S1', label: 'present', startYear: 2040, primary: true }],
    ...extra,
  });

  beforeAll(async () => {
    fx = await openBibleSession(store, (await loadFixture(store, freshSlug('guardnew'))).id);
    invoke = ipcFor(() => fx);
  });

  test('IP-18 entry.create, entry.createMany, a batch create and an edited create proposal cannot set the manuscript fields', async () => {
    const before = fx.model.all('chapters').length;
    for (const extra of [
      { manuscriptText: '<p>Typed here.</p>' },
      { manuscriptSource: 'word:/tmp/x.docx' },
      { sourceFile: 'x.docx' },
    ]) {
      await expect(
        invoke('entry.create', { collection: 'chapters', data: chapter('New', extra) }),
      ).rejects.toThrow(MANUSCRIPT_LOCKED);
      await expect(
        invoke('entry.createMany', {
          items: [{ collection: 'chapters', data: chapter('New', extra) }],
        }),
      ).rejects.toThrow(MANUSCRIPT_LOCKED);
      await expect(
        fx.repo.writeBatch([{ op: 'create', collection: 'chapters', data: chapter('New', extra) }]),
      ).rejects.toThrow(MANUSCRIPT_LOCKED);
    }
    // A pending chapter create cannot be edited into one that carries text.
    const proposal = await fx.repo.propose({
      source: 'claude',
      op: 'create',
      collection: 'chapters',
      data: chapter('Proposed'),
    });
    expect(proposal.state).toBe('pending');
    await expect(
      invoke('proposal.edit', {
        id: proposal._id,
        data: chapter('Proposed', { manuscriptText: '<p>Typed here.</p>' }),
      }),
    ).rejects.toThrow(MANUSCRIPT_LOCKED);
    // Blank manuscript fields are the defaults, not a change.
    const blank = await invoke('entry.create', {
      collection: 'chapters',
      data: chapter('Blank', { manuscriptText: '', sourceFile: null }),
    });
    expect(blank.entry.manuscriptText).toBe('');
    expect(fx.model.all('chapters').length).toBe(before + 1);
  });

  test('IP-18 the importer still creates a chapter with its manuscript text', async () => {
    const made = await fx.repo.create(
      'chapters',
      chapter('Imported', {
        manuscriptText: '<p>From Word.</p>',
        sourceFile: 'imported.docx',
      }) as never,
      { importer: true },
    );
    expect(made).toMatchObject({
      manuscriptText: '<p>From Word.</p>',
      sourceFile: 'imported.docx',
    });
  });
});
