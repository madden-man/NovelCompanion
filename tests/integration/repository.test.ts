import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RepositoryError, ValidationError, createBible } from '../../src/main/db';
import type { ChangeEvent } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Store } from '../../src/main/db';
import { freshSlug, localStore } from '../helpers/db';

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
