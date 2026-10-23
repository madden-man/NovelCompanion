import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { outgoingRefs } from '../../src/shared/domain/refs';
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
  };
});
afterAll(async () => {
  await store.close();
});

describe('ED-1 the write path works for every collection', () => {
  test.each(ENTRY_COLLECTIONS)('ED-1 %s: create, read, update, trash, restore', async (c) => {
    const { repo, handle } = bible;
    // A derived field (chapter Themes) is not stored on the entry; TH-1 tests cover it.
    const stored = (doc: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(doc).filter(([k]) => !manifests[c].find((s) => s.name === k)?.derived),
      );
    const created = (await repo.create(
      c,
      stored(build(manifests[c], 0, gen, 'full', true)) as never,
    )) as {
      _id: string;
    };
    const id = created._id;
    expect(repo.get(c, id)).toEqual(created);
    expect(await handle.collection(c).findOne({ _id: id as never })).toEqual(created);
    const b = stored(build(manifests[c], 1, gen, 'full', true));
    const updated = (await repo.update(c, id, b as never)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) expect(updated[k], `${c}.${k}`).toEqual(v);
    await repo.softDelete(c, id);
    expect(repo.get(c, id)).toBeUndefined();
    expect(repo.list(c, { onlyDeleted: true }).map((d) => d._id)).toContain(id);
    await repo.restore(c, id);
    expect(repo.get(c, id)).toEqual(expect.objectContaining(b));
  });
});

describe('ED-5 trash', () => {
  test('ED-5 a deleted entry goes to the trash and comes back with its references intact', async () => {
    const { repo, model } = fixture;
    const before = repo.get('chapters', 'CH6')!;
    const named = (id: string) => model.backlinks(id).some((b) => b.id === 'CH6');
    const target = outgoingRefs(manifests.chapters, before)[0]!.targetId;
    expect(named(target)).toBe(true);
    await repo.softDelete('chapters', 'CH6');
    expect(repo.get('chapters', 'CH6')).toBeUndefined();
    expect(repo.trash().map((t) => `${t.collection}:${t.entry._id}`)).toContain('chapters:CH6');
    // Its references no longer count while it is in the trash.
    expect(named(target)).toBe(false);
    const restored = await repo.restore('chapters', 'CH6');
    expect(restored.strands).toEqual(before.strands);
    expect(named(target)).toBe(true);
  });

  test('ED-5 entries that point at a trashed entry warn, and stop warning after a restore', async () => {
    const { repo } = fixture;
    await repo.softDelete('characters', 'Z3');
    const moment = repo.get('moments', 'Z3-lives-0')!;
    expect(repo.warnings('moments', moment as never)).toContainEqual(
      expect.objectContaining({ path: 'characterId', code: 'missing-target' }),
    );
    await repo.restore('characters', 'Z3');
    expect(
      repo.warnings('moments', moment as never).filter((w) => w.code === 'missing-target'),
    ).toEqual([]);
  });

  test('ED-5 the IPC channels delete, list the trash, and restore', async () => {
    const invoke = ipcFor(() => fixture);
    await invoke('entry.delete', { collection: 'glossaryTerms', id: 'GL1' });
    const { entries } = await invoke('trash.list', {});
    expect(entries.map((e) => e.entry._id)).toContain('GL1');
    const list = await invoke('entry.list', { collection: 'glossaryTerms', trash: 'only' });
    expect(list.entries.map((e) => e.entry._id)).toEqual(['GL1']);
    await invoke('entry.restore', { collection: 'glossaryTerms', id: 'GL1' });
    expect(
      (await invoke('entry.get', { collection: 'glossaryTerms', id: 'GL1' })).entry,
    ).not.toHaveProperty('deletedAt');
    await expect(
      invoke('entry.restore', { collection: 'glossaryTerms', id: 'GL1' }),
    ).rejects.toThrow(/not in the trash/);
  });
});

describe('SR-1 search', () => {
  test('SR-1 search finds entries, narrowed to the sections asked for', async () => {
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

  test('ED-10 SM-3 a moment before the character is born saves with a warning', async () => {
    const res = await ipcFor(() => fixture)('entry.update', {
      collection: 'moments',
      id: 'H1-voice-0',
      patch: { year: 1800 },
    });
    expect(res.entry.year).toBe(1800);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ path: 'year', code: 'outside-lifetime' }),
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
  test('ED-8 renaming a union type changes the label every union shows, without touching the unions', async () => {
    const { repo } = fixture;
    const before = repo.get('unions', 'UN-H1-H2')!.modifiedAt;
    await repo.renameListItem('unionTypes', 'married', 'Wed');
    const list = repo.lists().find((l) => l._id === 'unionTypes')!;
    const married = list.items.find((i) => i.id === 'married')!;
    expect(married.label).toBe('Wed');
    expect(married.usage).toBeGreaterThan(0);
    expect(repo.get('unions', 'UN-H1-H2')!.type).toBe('married');
    expect(repo.get('unions', 'UN-H1-H2')!.modifiedAt).toBe(before);
  });

  test('ED-8 renaming a family or an era renames the entry', async () => {
    const { repo } = fixture;
    await repo.renameListItem('families', 'FAM-HALE', 'Hale-Doyle');
    expect(repo.get('families', 'FAM-HALE')).toEqual(
      expect.objectContaining({ name: 'Hale-Doyle', title: 'Hale-Doyle family' }),
    );
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
    expect(item).toEqual({
      id: 'jinan-shandong',
      label: 'Jinan, Shandong',
      parentId: null,
      color: null,
      extra: {},
    });
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
});

describe('ED-7 proposals wait for approval', () => {
  const stored = async (c: string, id: string) =>
    fixture.handle.collection(c).findOne({ _id: id as never });

  test('ED-7 a proposal changes nothing in MongoDB until approved, and approval is recorded on the proposal', async () => {
    const { repo, handle } = fixture;
    const before = await stored('characters', 'Z2');
    const invoke = ipcFor(() => fixture);
    const p = await repo.propose({
      source: 'import',
      op: 'update',
      collection: 'characters',
      targetId: 'Z2',
      data: { role: 'Foshan' },
      reason: 'The workbook says Foshan.',
    });
    expect(p.state).toBe('pending');
    // The database, not the read model, is unchanged.
    expect(await stored('characters', 'Z2')).toEqual(before);
    const view = await invoke('proposal.diff', { id: p._id });
    expect(view.changes).toEqual([{ path: 'role', before: before!.role, after: 'Foshan' }]);
    expect(view.conflict).toBe(false);
    expect(
      (await invoke('proposal.list', { state: 'pending' })).proposals.map((v) => v.proposal._id),
    ).toContain(p._id);

    const { proposal: approved } = await invoke('proposal.approve', { id: p._id });
    expect(approved).toEqual(
      expect.objectContaining({ state: 'approved', edited: false, appliedEntryId: 'Z2' }),
    );
    expect(approved.decidedAt).not.toBeNull();
    expect((await stored('characters', 'Z2'))!.role).toBe('Foshan');
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
    expect((await invoke('proposal.diff', { id: p._id })).conflict).toBe(true);
    await expect(invoke('proposal.approve', { id: p._id })).rejects.toThrow(
      /This entry changed after the proposal was made, so it was not approved\. Compare again/,
    );
    expect((await stored('characters', 'Z2'))!.backstory).toBe('My own words.');
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
      data: { role: 'x' },
    });
    await expect(fixture.repo.editProposal(p._id, { birth: { year: 'old' } })).rejects.toThrow(
      /not valid/,
    );
    await fixture.repo.rejectProposal(p._id);
  });

  test('ED-7 a rejected proposal leaves MongoDB unchanged; create and delete proposals apply through the write path', async () => {
    const { repo } = fixture;
    const invoke = ipcFor(() => fixture);
    const before = await stored('places', 'PLC4');
    const rejected = await repo.propose({
      source: 'bulk',
      op: 'delete',
      collection: 'places',
      targetId: 'PLC4',
    });
    await invoke('proposal.reject', { id: rejected._id });
    expect(await stored('places', 'PLC4')).toEqual(before);
    expect(
      (await invoke('proposal.list', { state: 'rejected' })).proposals.map((v) => v.proposal._id),
    ).toContain(rejected._id);

    const create = await repo.propose({
      source: 'import',
      op: 'create',
      collection: 'places',
      data: { title: 'A new place' },
    });
    const { proposal: done } = await invoke('proposal.approve', { id: create._id });
    expect((await stored('places', done.appliedEntryId!))!.title).toBe('A new place');
    const del = await repo.propose({
      source: 'import',
      op: 'delete',
      collection: 'places',
      targetId: done.appliedEntryId,
    });
    await invoke('proposal.approve', { id: del._id });
    expect((await stored('places', done.appliedEntryId!))!.deletedAt).toBeDefined();
  });
});
