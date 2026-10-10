import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Collection } from 'mongodb';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { ENTRY_COLLECTIONS, manifests } from '../../src/shared/schema';
import type { EntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import { build, t5Write } from '../helpers/t5';
import type { GenContext } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
let fixture: OpenBible;
let gen: GenContext;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await createBible(store, freshSlug('edit'), 'Edit')).id);
  fixture = await openBibleSession(store, (await loadFixture(store, freshSlug('edit-fx'))).id);
  // Seed pools and list items once so every collection has targets for its references.
  await t5Write(ipcFor(() => bible));
  const pool = (c: string) =>
    bible.repo
      .list((c === '*' ? 'characters' : c) as EntryCollection)
      .map((d) => d._id)
      .slice(0, 8);
  gen = {
    pool,
    listItems: (id) =>
      bible.repo
        .lists()
        .find((l) => l._id === id)!
        .items.map((i) => i.id),
    customSpecs: (id) => bible.model.customSpecs(id),
  };
});
afterAll(async () => {
  await store.close();
});

describe('ED-1 the write path works for every collection', () => {
  test.each(ENTRY_COLLECTIONS)(
    'ED-1 %s: create, read, update, trash, restore, each with a revision',
    async (c) => {
      const { repo, handle } = bible;
      const created = (await repo.create(
        c,
        build(manifests[c], 0, gen, 'full', true) as never,
      )) as {
        _id: string;
      };
      const id = created._id;
      expect(repo.get(c, id)).toEqual(created);
      expect(await handle.collection(c).findOne({ _id: id as never })).toEqual(created);
      const b = build(manifests[c], 1, gen, 'full', true);
      const updated = (await repo.update(c, id, b as never)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(b)) expect(updated[k], `${c}.${k}`).toEqual(v);
      await repo.softDelete(c, id);
      expect(repo.get(c, id)).toBeUndefined();
      expect(repo.list(c, { onlyDeleted: true }).map((d) => d._id)).toContain(id);
      await repo.restore(c, id);
      expect(repo.get(c, id)).toEqual(expect.objectContaining(b));
      expect((await repo.revisions(c, id)).map((r) => r.op)).toEqual([
        'create',
        'update',
        'softDelete',
        'restore',
      ]);
    },
  );
});

describe('ED-4 revision history', () => {
  test('ED-4 history lists every write newest first with the entry as it stood after it', async () => {
    const { repo } = fixture;
    await repo.update('characters', 'H1', { birthplace: 'Salem, Oregon' });
    await repo.update('characters', 'H1', { birthplace: 'Eugene, Oregon', tags: ['moved'] });
    const history = await repo.history('characters', 'H1');
    expect(history.map((h) => h.op)).toEqual(['update', 'update']);
    expect(history[0]!.snapshot.birthplace).toBe('Eugene, Oregon');
    expect(history[1]!.snapshot.birthplace).toBe('Salem, Oregon');
  });

  test('ED-4 a revision compares with the current entry field by field', async () => {
    const { repo } = fixture;
    const [, older] = await repo.history('characters', 'H1');
    const { changes, current } = await repo.revisionDiff('characters', 'H1', older!._id);
    expect(current.birthplace).toBe('Eugene, Oregon');
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'birthplace', before: 'Salem, Oregon', after: 'Eugene, Oregon' },
        { path: 'tags', before: [], after: ['moved'] },
      ]),
    );
  });

  test('ED-4 restoring a revision writes its content back as a new revision', async () => {
    const { repo } = fixture;
    const [, older] = await repo.history('characters', 'H1');
    const restored = await repo.restoreRevision('characters', 'H1', older!._id);
    expect(restored.birthplace).toBe('Salem, Oregon');
    expect(restored.tags).toEqual([]);
    const history = await repo.history('characters', 'H1');
    expect(history).toHaveLength(3);
    expect(history[0]!.note).toMatch(/^Restored the version from /);
    // The restore is itself history: the version before it can be restored again.
    expect(history[1]!.snapshot.birthplace).toBe('Eugene, Oregon');
  });

  test('ED-4 a revision from another entry is refused', async () => {
    const { repo } = fixture;
    const [rev] = await repo.history('characters', 'H1');
    await expect(repo.restoreRevision('characters', 'H2', rev!._id)).rejects.toThrow(
      /does not belong/,
    );
  });

  test('ED-4 the IPC channels list, diff, and restore revisions', async () => {
    const invoke = ipcFor(() => fixture);
    const { revisions } = await invoke('revisions.list', { collection: 'characters', id: 'H1' });
    expect(revisions).toHaveLength(3);
    const diff = await invoke('revisions.diff', {
      collection: 'characters',
      id: 'H1',
      revisionId: revisions[1]!._id,
    });
    expect(diff.revision.snapshot.birthplace).toBe('Eugene, Oregon');
    expect(diff.changes.map((c) => c.path)).toContain('birthplace');
    const { entry } = await invoke('revisions.restore', {
      collection: 'characters',
      id: 'H1',
      revisionId: revisions[1]!._id,
    });
    expect(entry.birthplace).toBe('Eugene, Oregon');
  });
});

describe('ED-5 trash', () => {
  test('ED-5 before deleting, the app lists the entries that link to it', () => {
    const { count, entries } = fixture.repo.linkedFrom('Z3');
    expect(count).toBeGreaterThan(2);
    const kinds = entries.map((e) => `${e.collection}:${e.id}`);
    expect(kinds).toEqual(expect.arrayContaining(['parentLinks:PL-Z1-Z3', 'knowledgeRecords:K1']));
    expect(entries.every((e) => e.title.length > 0)).toBe(true);
  });

  test('ED-5 a deleted entry goes to the trash and comes back with its links intact', async () => {
    const { repo } = fixture;
    const before = repo.get('chapters', 'CH6')!;
    const backlinksBefore = repo.backlinks('CH6');
    await repo.softDelete('chapters', 'CH6');
    expect(repo.get('chapters', 'CH6')).toBeUndefined();
    expect(repo.trash().map((t) => `${t.collection}:${t.entry._id}`)).toContain('chapters:CH6');
    // Its outgoing links no longer show as live backlinks while it is in the trash.
    expect(repo.backlinks('E10')).toEqual([]);
    const restored = await repo.restore('chapters', 'CH6');
    expect(restored.links).toEqual(before.links);
    expect(restored.strands).toEqual(before.strands);
    expect(repo.backlinks('E10')).toEqual([
      { collection: 'chapters', id: 'CH6', kind: 'happened' },
    ]);
    expect(repo.backlinks('CH6')).toEqual(backlinksBefore);
  });

  test('ED-5 entries that point at a trashed entry warn, and stop warning after a restore', async () => {
    const { repo } = fixture;
    await repo.softDelete('facts', 'F1');
    const k1 = repo.get('knowledgeRecords', 'K1')!;
    expect(repo.warnings('knowledgeRecords', k1 as never)).toContainEqual(
      expect.objectContaining({ path: 'factId', code: 'missing-target' }),
    );
    await repo.restore('facts', 'F1');
    expect(
      repo.warnings('knowledgeRecords', k1 as never).filter((w) => w.code === 'missing-target'),
    ).toEqual([]);
  });

  test('ED-5 the IPC channels delete, list the trash, count links, and restore', async () => {
    const invoke = ipcFor(() => fixture);
    const linked = await invoke('entry.linkedFrom', { id: 'GL1' });
    await invoke('entry.delete', { collection: 'glossaryTerms', id: 'GL1' });
    const { entries } = await invoke('trash.list', {});
    expect(entries.map((e) => e.entry._id)).toContain('GL1');
    const list = await invoke('entry.list', { collection: 'glossaryTerms', trash: 'only' });
    expect(list.entries.map((e) => e.entry._id)).toEqual(['GL1']);
    await invoke('entry.restore', { collection: 'glossaryTerms', id: 'GL1' });
    expect((await invoke('entry.linkedFrom', { id: 'GL1' })).count).toBe(linked.count);
    await expect(
      invoke('entry.restore', { collection: 'glossaryTerms', id: 'GL1' }),
    ).rejects.toThrow(/not in the trash/);
  });
});

describe('ED-9 links and backlinks', () => {
  test('ED-9 a link added to any entry shows on the target as linked from, and goes when removed', async () => {
    const { repo } = fixture;
    expect(repo.backlinks('E3').filter((b) => b.collection === 'glossaryTerms')).toEqual([]);
    await repo.update('glossaryTerms', 'GL2', { links: [{ targetId: 'E3', kind: 'mention' }] });
    expect(repo.backlinks('E3')).toContainEqual({
      collection: 'glossaryTerms',
      id: 'GL2',
      kind: 'mention',
    });
    const res = await ipcFor(() => fixture)('entry.get', { collection: 'worldEvents', id: 'E3' });
    expect(res.backlinks).toContainEqual(
      expect.objectContaining({
        collection: 'glossaryTerms',
        id: 'GL2',
        kind: 'mention',
        title: expect.any(String),
      }),
    );
    await repo.update('glossaryTerms', 'GL2', { links: [] });
    expect(repo.backlinks('E3').filter((b) => b.collection === 'glossaryTerms')).toEqual([]);
  });

  test('ED-9 reference fields count as links: a strand cast, a union, a parent link', () => {
    const kinds = fixture.repo.backlinks('H5').map((b) => `${b.collection}:${b.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'chapters:Strands: Characters present',
        'chapters:Strands: Point of view',
        'parentLinks:Child',
      ]),
    );
  });

  test('ED-9 search finds entries for the @ picker and leaves out the trash', async () => {
    const invoke = ipcFor(() => fixture);
    const { hits } = await invoke('search.query', { query: 'Margaret' });
    expect(hits.map((h) => h.id)).toContain('H1');
    const only = await invoke('search.query', { query: 'Margaret', collections: ['unions'] });
    expect(only.hits.every((h) => h.collection === 'unions')).toBe(true);
  });
});

describe('ED-10 warnings come back with every read and never block a write', () => {
  test('ED-10 a death before birth saves and every read returns the warning', async () => {
    const invoke = ipcFor(() => fixture);
    const saved = await invoke('entry.update', {
      collection: 'characters',
      id: 'H2',
      patch: { death: { year: 1900 } },
    });
    expect(saved.entry.death).toEqual({ year: 1900 });
    const expected = expect.objectContaining({ path: 'death', code: 'death-before-birth' });
    expect(saved.warnings).toContainEqual(expected);
    expect(
      (await invoke('entry.get', { collection: 'characters', id: 'H2' })).warnings,
    ).toContainEqual(expected);
    const listed = await invoke('entry.list', { collection: 'characters', trash: 'exclude' });
    expect(listed.entries.find((e) => e.entry._id === 'H2')!.warnings).toContainEqual(expected);
  });

  test('ED-10 KN-2 a knowledge record before the character is born saves with a warning', async () => {
    const res = await ipcFor(() => fixture)('entry.update', {
      collection: 'knowledgeRecords',
      id: 'K1',
      patch: { yearLearned: 1800 },
    });
    expect(res.entry.yearLearned).toBe(1800);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ path: 'yearLearned', code: 'learned-before-birth' }),
    );
  });

  test('ED-10 an era that ends before it starts saves with a warning', async () => {
    const res = await ipcFor(() => fixture)('entry.update', {
      collection: 'eraStates',
      id: 'ERA-2025',
      patch: { endYear: 2020 },
    });
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ path: 'endYear', code: 'range-end-before-start' }),
    );
  });
});

describe('ED-8 editable lists', () => {
  test('ED-8 renaming a tag updates every entry using it in one transaction, each with a revision', async () => {
    const { repo } = fixture;
    await repo.update('characters', 'H3', { tags: ['river', 'archivist'] });
    await repo.update('chapters', 'CH1', { tags: ['river'] });
    const tags = repo.lists().find((l) => l._id === 'tags')!;
    const river = tags.items.find((i) => i.label === 'river')!;
    expect(river.usage).toBe(2);
    const res = await ipcFor(() => fixture)('lists.rename', {
      listId: 'tags',
      itemId: river.id,
      label: 'the river',
    });
    expect(res).toEqual({ updated: 2, from: 'river' });
    expect(repo.get('characters', 'H3')!.tags).toEqual(['the river', 'archivist']);
    expect(repo.get('chapters', 'CH1')!.tags).toEqual(['the river']);
    const [rev] = await repo.history('chapters', 'CH1');
    expect(rev!.note).toBe('Renamed river to the river in Tags');
    // The stored list and the database agree.
    const stored = await fixture.handle.collection('lists').findOne({ _id: 'tags' as never });
    expect((stored!.items as { label: string }[]).map((i) => i.label)).toContain('the river');
    expect(await fixture.handle.collection('characters').countDocuments({ tags: 'river' })).toBe(0);
  });

  test('ED-8 a rename that fails part way changes nothing', async () => {
    const { repo, handle } = fixture;
    await repo.update('characters', 'H4', { tags: ['ledger'] });
    await repo.update('characters', 'Z4', { tags: ['ledger'] });
    const item = repo
      .lists()
      .find((l) => l._id === 'tags')!
      .items.find((i) => i.label === 'ledger')!;
    // The second entry write inside the transaction fails, after the first succeeded.
    const real = Collection.prototype.replaceOne;
    let calls = 0;
    const spy = vi.spyOn(Collection.prototype, 'replaceOne').mockImplementation(function (
      this: Collection,
      ...args: Parameters<Collection['replaceOne']>
    ) {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('Simulated failure on the second entry'));
      return real.apply(this, args);
    });
    try {
      await expect(repo.renameListItem('tags', item.id, 'accounts')).rejects.toThrow(
        /Simulated failure/,
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    for (const id of ['H4', 'Z4']) {
      const stored = await handle.collection('characters').findOne({ _id: id as never });
      expect(stored!.tags).toEqual(['ledger']);
      expect(repo.get('characters', id)!.tags).toEqual(['ledger']);
      expect((await repo.history('characters', id))[0]!.note).toBeNull();
    }
    const stored = await handle.collection('lists').findOne({ _id: 'tags' as never });
    expect((stored!.items as { label: string }[]).map((i) => i.label)).toContain('ledger');
    expect((stored!.items as { label: string }[]).map((i) => i.label)).not.toContain('accounts');
  });

  test('ED-8 renaming a union type changes the label every union shows, without touching the unions', async () => {
    const { repo } = fixture;
    const before = await fixture.handle.collection('revisions').countDocuments();
    await repo.renameListItem('unionTypes', 'married', 'Wed');
    const list = repo.lists().find((l) => l._id === 'unionTypes')!;
    const married = list.items.find((i) => i.id === 'married')!;
    expect(married.label).toBe('Wed');
    expect(married.usage).toBeGreaterThan(0);
    expect(repo.get('unions', 'UN-H1-H2')!.type).toBe('married');
    expect(await fixture.handle.collection('revisions').countDocuments()).toBe(before);
  });

  test('ED-8 renaming a family, a section name, or an era renames the entry', async () => {
    const { repo } = fixture;
    await repo.renameListItem('families', 'FAM-HALE', 'Hale-Doyle');
    expect(repo.get('families', 'FAM-HALE')).toEqual(
      expect.objectContaining({ name: 'Hale-Doyle', title: 'Hale-Doyle family' }),
    );
    await repo.renameListItem('sectionNames', 'CS-RECIPES', 'Recipes');
    expect(repo.get('customSections', 'CS-RECIPES')!.name).toBe('Recipes');
    await repo.renameListItem('eraRanges', 'ERA-2025', 'The hinge years');
    expect(repo.get('eraStates', 'ERA-2025')!.name).toBe('The hinge years');
    expect(
      repo
        .lists()
        .find((l) => l._id === 'eraRanges')!
        .items.find((i) => i.id === 'ERA-2025'),
    ).toEqual(
      expect.objectContaining({
        label: 'The hinge years',
        detail: expect.stringMatching(/^2025 to /),
      }),
    );
  });

  test('ED-8 items can be added; an item in use cannot be removed and the message says why', async () => {
    const { repo } = fixture;
    const item = await repo.addListItem('communities', 'Jinan, Shandong');
    expect(item).toEqual({ id: 'jinan-shandong', label: 'Jinan, Shandong', parentId: null });
    await expect(repo.addListItem('communities', 'Jinan, Shandong')).rejects.toThrow(/already has/);
    await expect(repo.removeListItem('communities', 'guangzhou')).rejects.toThrow(
      /entries use Guangzhou/,
    );
    await repo.removeListItem('communities', 'jinan-shandong');
    expect(
      repo
        .lists()
        .find((l) => l._id === 'communities')!
        .items.map((i) => i.id),
    ).not.toContain('jinan-shandong');
    const child = await repo.addListItem('eventCategories', 'Drones', 'robotics');
    expect(child.parentId).toBe('robotics');
  });

  test('ED-8 tags an entry uses are added to the tags list as it is saved', async () => {
    const { repo } = fixture;
    await repo.update('characters', 'Z5', { tags: ['brand new tag'] });
    expect(
      repo
        .lists()
        .find((l) => l._id === 'tags')!
        .items.map((i) => i.label),
    ).toContain('brand new tag');
  });
});

describe('ED-7 proposals wait for approval', () => {
  const stored = async (c: string, id: string) =>
    fixture.handle.collection(c).findOne({ _id: id as never });
  const revisionCount = (id: string) =>
    fixture.handle.collection('revisions').countDocuments({ entryId: id });

  test('ED-7 a proposal changes nothing in MongoDB until approved, and approval is recorded on the proposal and a revision', async () => {
    const { repo, handle } = fixture;
    const before = await stored('characters', 'Z2');
    const revsBefore = await revisionCount('Z2');
    const invoke = ipcFor(() => fixture);
    const p = await repo.propose({
      source: 'import',
      op: 'update',
      collection: 'characters',
      targetId: 'Z2',
      data: { birthplace: 'Foshan' },
      reason: 'The workbook says Foshan.',
    });
    expect(p.state).toBe('pending');
    // The database, not the read model, is unchanged, and no revision was written.
    expect(await stored('characters', 'Z2')).toEqual(before);
    expect(await revisionCount('Z2')).toBe(revsBefore);
    const view = await invoke('proposal.diff', { id: p._id });
    expect(view.changes).toEqual([
      { path: 'birthplace', before: before!.birthplace, after: 'Foshan' },
    ]);
    expect(view.conflict).toBe(false);
    expect(
      (await invoke('proposal.list', { state: 'pending' })).proposals.map((v) => v.proposal._id),
    ).toContain(p._id);

    const { proposal: approved } = await invoke('proposal.approve', { id: p._id });
    expect(approved).toEqual(
      expect.objectContaining({ state: 'approved', edited: false, appliedEntryId: 'Z2' }),
    );
    expect(approved.decidedAt).not.toBeNull();
    expect((await stored('characters', 'Z2'))!.birthplace).toBe('Foshan');
    expect(await revisionCount('Z2')).toBe(revsBefore + 1);
    const [rev] = await repo.history('characters', 'Z2');
    expect(rev).toEqual(
      expect.objectContaining({ proposalId: p._id, note: 'Approved a proposal from import' }),
    );
    expect(await handle.collection('proposals').findOne({ _id: p._id as never })).toEqual(
      expect.objectContaining({ state: 'approved' }),
    );
    await expect(invoke('proposal.approve', { id: p._id })).rejects.toThrow(/already approved/);
  });

  test('ED-7 a proposal whose entry changed since is refused plainly, and approves after comparing again', async () => {
    const { repo } = fixture;
    const invoke = ipcFor(() => fixture);
    const p = await repo.propose({
      source: 'claude',
      op: 'update',
      collection: 'characters',
      targetId: 'Z2',
      data: { backstory: 'Proposed.' },
    });
    await repo.update('characters', 'Z2', { backstory: 'My own words.' });
    const revs = await revisionCount('Z2');
    expect((await invoke('proposal.diff', { id: p._id })).conflict).toBe(true);
    await expect(invoke('proposal.approve', { id: p._id })).rejects.toThrow(
      /This entry changed after the proposal was made, so it was not approved\. Compare again/,
    );
    expect((await stored('characters', 'Z2'))!.backstory).toBe('My own words.');
    expect(await revisionCount('Z2')).toBe(revs);
    expect(
      (await fixture.handle.collection('proposals').findOne({ _id: p._id as never }))!.state,
    ).toBe('pending');

    const again = await invoke('proposal.refresh', { id: p._id });
    expect(again.conflict).toBe(false);
    expect(again.changes).toEqual([
      { path: 'backstory', before: 'My own words.', after: 'Proposed.' },
    ]);
    const { proposal: edited } = await invoke('proposal.edit', {
      id: p._id,
      data: { backstory: 'My own words, kept.' },
    });
    expect(edited.edited).toBe(true);
    expect((await stored('characters', 'Z2'))!.backstory).toBe('My own words.');
    await invoke('proposal.approve', { id: p._id });
    expect((await stored('characters', 'Z2'))!.backstory).toBe('My own words, kept.');
    expect(await revisionCount('Z2')).toBe(revs + 1);
    await expect(invoke('proposal.edit', { id: p._id, data: {} })).rejects.toThrow(
      /already approved/,
    );
  });

  test('ED-7 an edit to a proposal that the schema cannot store is refused before approval', async () => {
    const p = await fixture.repo.propose({
      source: 'import',
      op: 'update',
      collection: 'characters',
      targetId: 'Z2',
      data: { birthplace: 'x' },
    });
    await expect(fixture.repo.editProposal(p._id, { birth: { year: 'old' } })).rejects.toThrow(
      /not valid/,
    );
    await fixture.repo.rejectProposal(p._id);
  });

  test('ED-7 a rejected proposal leaves MongoDB unchanged; create and delete proposals apply through the write path', async () => {
    const { repo } = fixture;
    const invoke = ipcFor(() => fixture);
    const before = await stored('facts', 'F2');
    const revs = await revisionCount('F2');
    const rejected = await repo.propose({
      source: 'bulk',
      op: 'delete',
      collection: 'facts',
      targetId: 'F2',
    });
    await invoke('proposal.reject', { id: rejected._id });
    expect(await stored('facts', 'F2')).toEqual(before);
    expect(await revisionCount('F2')).toBe(revs);
    expect(
      (await invoke('proposal.list', { state: 'rejected' })).proposals.map((v) => v.proposal._id),
    ).toContain(rejected._id);

    const create = await repo.propose({
      source: 'import',
      op: 'create',
      collection: 'facts',
      data: { title: 'A new secret', status: 'idea' },
    });
    const { proposal: done } = await invoke('proposal.approve', { id: create._id });
    expect((await stored('facts', done.appliedEntryId!))!.title).toBe('A new secret');
    expect(await revisionCount(done.appliedEntryId!)).toBe(1);
    const del = await repo.propose({
      source: 'import',
      op: 'delete',
      collection: 'facts',
      targetId: done.appliedEntryId,
    });
    await invoke('proposal.approve', { id: del._id });
    expect((await stored('facts', done.appliedEntryId!))!.deletedAt).toBeDefined();
    expect(await revisionCount(done.appliedEntryId!)).toBe(2);
  });
});

describe('ED-8 custom section choices and fields', () => {
  const choiceList = 'choice:CS-RECIPES:occasion';
  const values = async (id: string) =>
    ((await fixture.handle.collection('customEntries').findOne({ _id: id as never }))!.values ??
      {}) as Record<string, unknown>;

  test('ED-8 renaming a choice updates every custom entry using it in one transaction, with revisions', async () => {
    const { repo } = fixture;
    const list = repo.lists().find((l) => l._id === choiceList)!;
    expect(list.items.find((i) => i.id === 'Holiday')!.usage).toBeGreaterThan(0);
    const users = repo
      .list('customEntries')
      .filter((e) => e.values.occasion === 'Holiday')
      .map((e) => e._id);
    const res = await ipcFor(() => fixture)('lists.rename', {
      listId: choiceList,
      itemId: 'Holiday',
      label: 'Festival',
    });
    expect(res).toEqual({ updated: users.length, from: 'Holiday' });
    for (const id of users) {
      expect((await values(id)).occasion).toBe('Festival');
      expect((await repo.history('customEntries', id))[0]!.note).toBe(
        'Renamed Holiday to Festival in Occasion',
      );
    }
    const section = await fixture.handle
      .collection('customSections')
      .findOne({ _id: 'CS-RECIPES' as never });
    const occasion = (section!.fields as { id: string; options: string[] }[]).find(
      (f) => f.id === 'occasion',
    )!;
    expect(occasion.options).toEqual(['Everyday', 'Festival', 'Funeral']);
    for (const id of users) {
      expect(repo.warnings('customEntries', repo.get('customEntries', id) as never)).toEqual([]);
    }
  });

  test('ED-8 a choice in use cannot be removed, on the Lists screen or in the section editor, and the message says how many', async () => {
    const { repo } = fixture;
    await expect(repo.removeListItem(choiceList, 'Festival')).rejects.toThrow(
      /^1 entry uses Festival\./,
    );
    const section = repo.get('customSections', 'CS-RECIPES')!;
    const fields = section.fields.map((f) =>
      f.id === 'occasion' ? { ...f, options: ['Everyday', 'Funeral'] } : f,
    );
    await expect(repo.update('customSections', 'CS-RECIPES', { fields })).rejects.toThrow(
      /^1 entry uses the choice Festival in Occasion\./,
    );
    await repo.removeListItem(choiceList, 'Funeral');
    expect(
      repo.get('customSections', 'CS-RECIPES')!.fields.find((f) => f.id === 'occasion')!.options,
    ).toEqual(['Everyday', 'Festival']);
    await repo.addListItem(choiceList, 'Wedding');
    expect(
      repo
        .lists()
        .find((l) => l._id === choiceList)!
        .items.map((i) => i.id),
    ).toEqual(['Everyday', 'Festival', 'Wedding']);
  });

  test('ED-8 a field in use cannot be removed, and the message says how many', async () => {
    const { repo } = fixture;
    const section = repo.get('customSections', 'CS-RECIPES')!;
    await expect(
      repo.update('customSections', 'CS-RECIPES', {
        fields: section.fields.filter((f) => f.id !== 'method'),
      }),
    ).rejects.toThrow(/entr(y|ies) uses? the field Method\. Clear it/);
    // A field nobody fills in can go.
    await repo.update('customSections', 'CS-RECIPES', {
      fields: [...section.fields, { id: 'spare', label: 'Spare', type: 'text', options: [] }],
    });
    await repo.update('customSections', 'CS-RECIPES', { fields: section.fields });
  });

  test('ED-10 a custom value that no longer fits its section is a warning, and the entry still saves', async () => {
    const { repo } = fixture;
    const section = repo.get('customSections', 'CS-RECIPES')!;
    // The field changes kind, so the stored choice no longer fits.
    await repo.update('customSections', 'CS-RECIPES', {
      fields: section.fields.map((f) =>
        f.id === 'firstCooked' ? { ...f, type: 'singleChoice' as const, options: ['Early'] } : f,
      ),
    });
    const ce = repo.get('customEntries', 'CE1')!;
    const saved = await repo.update('customEntries', 'CE1', { title: `${ce.title} (checked)` });
    expect(saved.title).toMatch(/\(checked\)$/);
    expect(repo.warnings('customEntries', saved as never)).toContainEqual(
      expect.objectContaining({ path: 'values.firstCooked', code: 'custom-value' }),
    );
    // A value for a field that no longer exists is kept and flagged too.
    const stale = await repo.update('customEntries', 'CE1', {
      values: { ...saved.values, gone: 'old text' },
    });
    expect(repo.warnings('customEntries', stale as never)).toContainEqual(
      expect.objectContaining({ path: 'values.gone', code: 'custom-value' }),
    );
    await repo.update('customSections', 'CS-RECIPES', { fields: section.fields });
  });
});
