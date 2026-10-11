import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations';
import { openBibleForApp, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { dumpBible } from '../../src/main/backup/dump';
import { exportBibleJson, importBibleJson, isEmptyBible } from '../../src/main/backup/json';
import { loadBibleFile, restoreSnapshot } from '../../src/main/backup/restore';
import { SnapshotService } from '../../src/main/backup/snapshots';
import { SnapshotManifest } from '../../src/shared/domain/snapshots';
import { ENTRY_COLLECTIONS } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture, readFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-backup-'));
});
afterAll(async () => {
  await store.close();
});

async function fixtureSession(
  label: string,
  options: Parameters<typeof openBibleSession>[2] = { snapshotRoot: root },
): Promise<OpenBible> {
  const handle = await loadFixture(store, freshSlug(label));
  return openBibleSession(store, handle.id, options);
}

describe('BK-1 a snapshot is a complete JSON dump of every collection', () => {
  test('BK-1 a snapshot writes one file per collection and a manifest with counts and the schema version', async () => {
    const open = await fixtureSession('bk-dump');
    const info = await open.snapshots!.take('manual');
    const dir = join(root, open.handle.id, info.id);
    expect(info.id).toBe(info.takenAt);
    expect(info.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const files = (await readdir(dir)).sort();
    const names = await open.handle.collectionNames();
    expect(files).toEqual([...names.map((n) => `${n}.json`), 'manifest.json'].sort());
    const manifest = SnapshotManifest.parse(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      bible: open.handle.id,
      reason: 'manual',
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
    const fixture = readFixture();
    for (const c of ENTRY_COLLECTIONS) {
      expect(manifest.counts[c], c).toBe(fixture[c]?.length ?? 0);
      const docs = JSON.parse(await readFile(join(dir, `${c}.json`), 'utf8')) as unknown[];
      expect(docs, c).toHaveLength(manifest.counts[c]!);
    }
    expect(manifest.counts.lists).toBeGreaterThan(0);
  });

  test('BK-1 a snapshot is taken before a list rename and before an approved proposal', async () => {
    const open = await fixtureSession('bk-bulk');
    expect(await open.snapshots!.list()).toHaveLength(0);
    await open.repo.renameListItem('communities', 'portland', 'Portland, OR');
    const afterRename = await open.snapshots!.list();
    expect(afterRename.map((s) => [s.reason, s.label])).toEqual([['bulk', 'list rename']]);
    // The snapshot holds the state before the rename.
    const dir = join(root, open.handle.id, afterRename[0]!.id);
    const lists = JSON.parse(await readFile(join(dir, 'lists.json'), 'utf8')) as {
      _id: string;
      items: { label: string }[];
    }[];
    expect(lists.find((l) => l._id === 'communities')!.items[0]!.label).toBe('Portland, Oregon');

    const proposal = await open.repo.propose({
      source: 'claude',
      op: 'update',
      collection: 'characters',
      targetId: 'H1',
      data: { tags: ['reviewed'] },
    });
    await open.repo.applyProposal(proposal._id);
    const labels = (await open.snapshots!.list()).map((s) => s.label);
    expect(labels).toEqual(['approved proposal', 'list rename']);
  });

  test('BK-1 only the newest N snapshots are kept, and N is a setting', async () => {
    const open = await fixtureSession('bk-keep');
    expect(open.repo.snapshotKeep()).toBe(30);
    expect(await open.repo.setSnapshotKeep(3)).toBe(3);
    expect(open.repo.snapshotKeep()).toBe(3);
    for (let i = 0; i < 5; i++) await open.snapshots!.take('manual', `n${i}`);
    const kept = await open.snapshots!.list();
    expect(kept.map((s) => s.label)).toEqual(['n4', 'n3', 'n2']);
    expect(await readdir(join(root, open.handle.id))).toHaveLength(3);
    await expect(open.repo.setSnapshotKeep(0)).rejects.toThrow(/between 1 and 1000/);
  });

  test('BK-1 the snapshot folders and IPC list, take, change the limit, and restore', async () => {
    const open = await fixtureSession('bk-ipc');
    const invoke = ipcFor(() => open);
    const taken = await invoke('snapshot.take', {});
    expect(taken.snapshot.reason).toBe('manual');
    expect((await invoke('snapshot.list', {})).snapshots.map((s) => s.id)).toEqual([
      taken.snapshot.id,
    ]);
    expect(await invoke('snapshot.keep', { keep: 7 })).toEqual({ keep: 7 });
    expect((await invoke('snapshot.list', {})).keep).toBe(7);
  });
});

describe('BK-2 any snapshot can be restored, after a snapshot of the present, in one transaction', () => {
  test('BK-2 restore brings back deleted and changed entries, replaces the read model, and takes a snapshot first', async () => {
    const open = await fixtureSession('bk-restore');
    const before = await dumpBible(open.handle);
    const snap = await open.snapshots!.take('manual', 'before edits');
    await open.repo.update('characters', 'H1', { tags: ['edited'] });
    await open.repo.softDelete('characters', 'H2');
    const made = await open.repo.create('facts', { title: 'A new fact', status: 'idea' });
    const reloads: string[] = [];
    open.repo.onReload((m) => reloads.push(m));

    const out = await restoreSnapshot(open, snap.id);
    expect(out.restored.id).toBe(snap.id);
    expect(out.safety.reason).toBe('restore');
    expect(out.safety.counts.facts).toBe(before.collections.facts!.length + 1);
    const after = await dumpBible(open.handle);
    expect(after.collections).toEqual(before.collections);
    expect(open.repo.get('characters', 'H2')).toBeDefined();
    expect(open.repo.get('characters', 'H1')!.tags).toEqual([]);
    expect(open.repo.get('facts', made._id)).toBeUndefined();
    expect(open.search.search('A new fact').map((h) => h.id)).not.toContain(made._id);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toContain('Restored the snapshot from');
    // The safety snapshot can bring the edits back.
    await restoreSnapshot(open, out.safety.id);
    expect(open.repo.get('facts', made._id)).toBeDefined();
    expect(open.repo.get('characters', 'H2')).toBeUndefined();
  });

  test('BK-2 a snapshot whose manifest does not validate changes nothing and takes no snapshot', async () => {
    const open = await fixtureSession('bk-bad-manifest');
    const good = await open.snapshots!.take('manual');
    const before = await dumpBible(open.handle);
    const base = join(root, open.handle.id);
    const corrupt = async (
      id: string,
      edit: (m: Record<string, unknown>) => void | Promise<void>,
      extra?: () => Promise<void>,
    ) => {
      const dir = join(base, id);
      await mkdir(dir, { recursive: true });
      const manifest = JSON.parse(
        await readFile(join(base, good.id, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      manifest.takenAt = `${id}`;
      await edit(manifest);
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
      for (const f of await readdir(join(base, good.id))) {
        if (f !== 'manifest.json')
          await writeFile(join(dir, f), await readFile(join(base, good.id, f)));
      }
      await extra?.();
    };
    await corrupt('2000-01-01T00:00:00.000Z', (m) => {
      m.counts = { ...(m.counts as object), characters: 999 };
    });
    await corrupt('2000-01-02T00:00:00.000Z', (m) => {
      m.version = 2;
    });
    await corrupt('2000-01-03T00:00:00.000Z', (m) => {
      m.schemaVersion = LATEST_SCHEMA_VERSION + 1;
    });
    await corrupt(
      '2000-01-04T00:00:00.000Z',
      () => undefined,
      () => writeFile(join(base, '2000-01-04T00:00:00.000Z', 'characters.json'), '[{"_id":"X"}'),
    );
    await corrupt('2000-01-05T00:00:00.000Z', (m) => {
      m.bible = 'another-bible';
    });
    const failures = [
      /does not match the manifest/,
      /manifest is not valid/,
      /newer version of the app/,
      /cannot read characters\.json/,
      /belongs to the bible/,
    ];
    const ids = [
      '2000-01-01T00:00:00.000Z',
      '2000-01-02T00:00:00.000Z',
      '2000-01-03T00:00:00.000Z',
      '2000-01-04T00:00:00.000Z',
      '2000-01-05T00:00:00.000Z',
    ];
    const countBefore = (await open.snapshots!.list()).length;
    for (const [i, id] of ids.entries()) {
      await expect(restoreSnapshot(open, id)).rejects.toThrow(failures[i]!);
    }
    await expect(restoreSnapshot(open, 'not-a-snapshot')).rejects.toThrow(/not a snapshot/);
    await expect(restoreSnapshot(open, '2001-01-01T00:00:00.000Z')).rejects.toThrow(/no manifest/);
    expect((await dumpBible(open.handle)).collections).toEqual(before.collections);
    // The invalid snapshots are not listed as snapshots and none was taken for them.
    expect((await open.snapshots!.list()).length).toBe(countBefore);
  });

  test('BK-2 a restore that fails part way leaves every collection as it was', async () => {
    const open = await fixtureSession('bk-atomic');
    const snap = await open.snapshots!.take('manual');
    const dir = join(root, open.handle.id, snap.id);
    // Two documents share an ID in one file: the insert fails after other collections were already replaced.
    const chapters = JSON.parse(await readFile(join(dir, 'chapters.json'), 'utf8')) as {
      _id: string;
    }[];
    chapters.push({ ...chapters[0]! });
    await writeFile(join(dir, 'chapters.json'), JSON.stringify(chapters));
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      counts: Record<string, number>;
    };
    manifest.counts.chapters = chapters.length;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await open.repo.update('characters', 'H1', { tags: ['kept'] });
    const before = await dumpBible(open.handle);
    await expect(restoreSnapshot(open, snap.id)).rejects.toThrow();
    expect((await dumpBible(open.handle)).collections).toEqual(before.collections);
    expect(open.repo.get('characters', 'H1')!.tags).toEqual(['kept']);
  });

  test('BK-2 an unfinished snapshot folder is not listed or kept as a snapshot', async () => {
    const open = await fixtureSession('bk-partial');
    await mkdir(join(root, open.handle.id, '2020-01-01T00:00:00.000Z.partial'), {
      recursive: true,
    });
    await mkdir(join(root, open.handle.id, '2020-01-02T00:00:00.000Z'), { recursive: true });
    expect(await open.snapshots!.list()).toEqual([]);
  });
});

describe('BK-3 the JSON export loads into an empty bible with nothing lost', () => {
  test('BK-3 every collection, revision, list, setting, and entry is identical after the round trip', async () => {
    const a = await fixtureSession('bk-export');
    // Give it history and settings so the round trip has something to lose.
    await a.repo.update('characters', 'H1', { tags: ['kept', 'second'] });
    await a.repo.softDelete('facts', 'F2');
    await a.repo.setStoryTime({ year: 2045 });
    await a.repo.setTreePositions({ H1: { x: 10, y: 20 } });
    await a.repo.setRomanization('mandarin', 'mandarin');
    await a.repo.setSnapshotKeep(12);
    await a.repo.saveMapping('book.xlsx#Sheet 1', { shape: 'table' });
    const exported = await exportBibleJson(a.handle, new Date('2026-10-10T12:00:00Z'));
    expect(exported.counts.revisions).toBeGreaterThan(0);
    expect(exported.counts.meta).toBeGreaterThanOrEqual(5);
    expect(exported.text).not.toMatch(/mongodb(\+srv)?:\/\//);

    const handle = await createBible(store, freshSlug('bk-import'), 'Imported');
    expect(await isEmptyBible(handle)).toBe(true);
    await importBibleJson(handle, exported.text);
    const original = await dumpBible(a.handle);
    const copy = await dumpBible(handle);
    expect(Object.keys(copy.collections).sort()).toEqual(Object.keys(original.collections).sort());
    for (const [name, docs] of Object.entries(original.collections)) {
      expect(copy.collections[name], name).toEqual(docs);
    }
    // Entries equal the fixture as loaded; settings equal what was set.
    const fixture = readFixture();
    const b = await openBibleSession(store, handle.id);
    for (const c of ENTRY_COLLECTIONS) {
      if (c === 'characters' || c === 'facts') continue;
      expect(b.repo.list(c, { includeDeleted: true }).length, c).toBe(fixture[c]?.length ?? 0);
    }
    expect(b.repo.storyTime()).toEqual({ year: 2045 });
    expect(b.repo.treePositions()).toEqual({ H1: { x: 10, y: 20 } });
    expect(b.repo.snapshotKeep()).toBe(12);
    expect(b.repo.savedMappings()).toEqual({ 'book.xlsx#Sheet 1': { shape: 'table' } });
    expect(b.repo.get('facts', 'F2')).toBeUndefined();
    expect(b.repo.get('facts', 'F2', { includeDeleted: true })).toBeDefined();
    expect((await b.repo.revisions('characters', 'H1')).map((r) => r.op)).toEqual(['update']);
    expect(b.search.search('周美玲').map((h) => h.id)).toContain('Z1');
  });

  test('CS-2 BK-3 custom sections and custom entries survive the export and import round trip', async () => {
    const a = await fixtureSession('bk-custom');
    const exported = await exportBibleJson(a.handle);
    const file = JSON.parse(exported.text) as {
      collections: Record<string, { _id: string; values?: unknown }[]>;
    };
    expect(file.collections.customSections!.map((d) => d._id)).toEqual(['CS-RECIPES']);
    expect(file.collections.customEntries!.map((d) => d._id).sort()).toEqual(['CE1', 'CE2']);
    const handle = await createBible(store, freshSlug('bk-custom-in'), 'Imported');
    await importBibleJson(handle, exported.text);
    const b = await openBibleSession(store, handle.id);
    expect(b.repo.get('customEntries', 'CE1')).toEqual(a.repo.get('customEntries', 'CE1'));
    expect(b.repo.get('customSections', 'CS-RECIPES')).toEqual(
      a.repo.get('customSections', 'CS-RECIPES'),
    );
    expect(b.search.search('mooncakes').map((h) => h.id)).toContain('CE1');
  });

  test('BK-3 a file that is not a bible, is invalid, or targets a bible with entries changes nothing', async () => {
    const a = await fixtureSession('bk-bad-file');
    const exported = await exportBibleJson(a.handle);
    const handle = await createBible(store, freshSlug('bk-bad-in'), 'Empty');
    const untouched = await dumpBible(handle);
    await expect(importBibleJson(handle, 'not json')).rejects.toThrow(/not valid JSON/);
    await expect(importBibleJson(handle, '{"format":"other"}')).rejects.toThrow(
      /not a bible export/,
    );
    const broken = JSON.parse(exported.text) as {
      collections: { characters: Record<string, unknown>[] };
    };
    broken.collections.characters[0]!.status = 'maybe';
    await expect(importBibleJson(handle, JSON.stringify(broken))).rejects.toThrow(
      /is not valid, so nothing was imported/,
    );
    const newer = JSON.parse(exported.text) as { bible: { schemaVersion: number } };
    newer.bible.schemaVersion = LATEST_SCHEMA_VERSION + 1;
    await expect(importBibleJson(handle, JSON.stringify(newer))).rejects.toThrow(/newer version/);
    expect((await dumpBible(handle)).collections).toEqual(untouched.collections);
    await importBibleJson(handle, exported.text);
    await expect(importBibleJson(handle, exported.text)).rejects.toThrow(/empty bible/);
  });

  test('BK-3 the IPC export writes the file, and the file loads into a new bible through the app', async () => {
    const a = await fixtureSession('bk-ipc-export');
    const dir = await mkdtemp(join(tmpdir(), 'nc-export-'));
    const path = join(dir, 'bible.json');
    const invoke = ipcFor(() => a, {
      pickSavePath: async () => path,
      pickBibleFile: async () => path,
    });
    const out = await invoke('backup.export', {});
    expect(out.path).toBe(path);
    expect(out.counts.characters).toBe(readFixture().characters!.length);
    const slug = freshSlug('bk-ipc-in');
    const loaded = await invoke('backup.import', { slug, name: 'From file' });
    expect(loaded.bible).toEqual({ id: slug, name: 'From file' });
    const b = await openBibleSession(store, slug);
    expect(b.repo.list('characters')).toHaveLength(readFixture().characters!.length);
    // Cancelling the picker writes nothing and returns null.
    const none = ipcFor(() => a, {});
    expect((await none('backup.export', {})).path).toBeNull();
    expect(
      (await none('backup.import', { slug: freshSlug('bk-none'), name: 'None' })).bible,
    ).toBeNull();
    // Loading into the open (empty) bible replaces it and reloads the read model.
    const empty = await openBibleSession(
      store,
      (await createBible(store, freshSlug('bk-load'), 'Load')).id,
      { snapshotRoot: root },
    );
    await loadBibleFile(empty, await readFile(path, 'utf8'));
    expect(empty.repo.get('characters', 'H1')).toBeDefined();
  });
});

describe('BK-4 a write is a single document or a transaction, so a forced quit never leaves a partial edit', () => {
  test('BK-4 a write killed mid-transaction by a session abort leaves the entry, its history, and the read model unchanged', async () => {
    let kill = false;
    const open = await fixtureSession('bk-kill', {
      repository: {
        midTransaction: async (session) => {
          if (!kill) return;
          await session.abortTransaction();
        },
      },
    });
    const before = await open.handle.collection('characters').findOne({ _id: 'H1' as never });
    const revisionsBefore = await open.repo.revisions('characters', 'H1');
    kill = true;
    await expect(
      open.repo.update('characters', 'H1', { tags: ['half written'], backstory: 'Half.' }),
    ).rejects.toThrow(/cancelled before it finished/);
    expect(await open.handle.collection('characters').findOne({ _id: 'H1' as never })).toEqual(
      before,
    );
    expect(await open.repo.revisions('characters', 'H1')).toEqual(revisionsBefore);
    expect(open.repo.get('characters', 'H1')).toEqual(before);
    expect(open.search.search('Half').map((h) => h.id)).not.toContain('H1');
    // A multi-document write is all or nothing too.
    await expect(
      open.repo.createMany([
        { collection: 'facts', data: { _id: 'KILL1', title: 'One', status: 'idea' } },
        { collection: 'facts', data: { _id: 'KILL2', title: 'Two', status: 'idea' } },
      ]),
    ).rejects.toThrow(/cancelled before it finished/);
    expect(
      await open.handle
        .collection('facts')
        .countDocuments({ _id: { $in: ['KILL1', 'KILL2'] } as never }),
    ).toBe(0);
    kill = false;
    await open.repo.update('characters', 'H1', { tags: ['written'] });
    expect(open.repo.get('characters', 'H1')!.tags).toEqual(['written']);
  });

  test('BK-4 two windows saving one entry never merge: the later save replaces the whole document', async () => {
    const open = await fixtureSession('bk-stale');
    const dup = await openBibleSession(store, open.handle.id);
    await dup.repo.update('characters', 'H1', { tags: ['other window'] });
    await expect(open.repo.update('characters', 'H1', { tags: ['stale'] })).resolves.toBeDefined();
    // The first window's read model was stale, but the write read the current document, so the later save wins whole.
    expect(
      (await open.handle.collection('characters').findOne({ _id: 'H1' as never }))!.tags,
    ).toEqual(['stale']);
  });
});

describe('M4 review: a trashed theme keeps its appearances when a chapter field changes', () => {
  test('TH-1 setting a chapter Themes field skips themes in the trash', async () => {
    const open = await fixtureSession('m4-theme');
    const theme = await open.repo.create('themes', { title: 'Water', status: 'idea' });
    const chapter = open.repo.list('chapters')[0]!;
    await open.repo.update('chapters', chapter._id, { themeIds: [theme._id] } as never);
    expect(
      open.repo.get('themes', theme._id)!.appearances.some((a) => a.chapterId === chapter._id),
    ).toBe(true);
    await open.repo.softDelete('themes', theme._id);
    const trashed = open.repo.get('themes', theme._id, { includeDeleted: true })!;
    // Clearing the chapter's themes would have removed the appearance from the trashed theme before.
    await open.repo.update('chapters', chapter._id, { themeIds: [] } as never);
    expect(open.repo.get('themes', theme._id, { includeDeleted: true })).toEqual(trashed);
    expect((await open.repo.revisions('themes', theme._id)).map((r) => r.op)).toEqual([
      'create',
      'update',
      'softDelete',
    ]);
  });
});

describe('BK-1 SnapshotService is bound to one bible', () => {
  test('BK-1 snapshots of two bibles go to separate folders', async () => {
    const one = await fixtureSession('bk-sep-a');
    const two = await fixtureSession('bk-sep-b');
    await one.snapshots!.take('manual');
    expect(await two.snapshots!.list()).toEqual([]);
    expect(new SnapshotService(two.handle, root).folder).toBe(join(root, two.handle.id));
  });
});

describe('BK-1 the first open of the day takes one snapshot', () => {
  test('BK-1 opening a bible twice on one day and once the next day takes exactly one snapshot per day', async () => {
    const handle = await loadFixture(store, freshSlug('bk-daily'));
    const daily = join(root, 'bk-daily-root');
    let clock = new Date('2026-03-10T10:00:00.000Z');
    const options = { snapshotRoot: daily, now: () => clock };
    const taken = async () => {
      const list = await new SnapshotService(handle, daily).list();
      return list.filter((s) => s.reason === 'daily').map((s) => s.takenAt.slice(0, 10));
    };
    await openBibleForApp(store, handle.id, options);
    expect(await taken()).toEqual(['2026-03-10']);
    clock = new Date('2026-03-10T10:20:00.000Z');
    await openBibleForApp(store, handle.id, options);
    expect(await taken()).toEqual(['2026-03-10']);
    clock = new Date('2026-03-11T10:00:00.000Z');
    await openBibleForApp(store, handle.id, options);
    expect((await taken()).sort()).toEqual(['2026-03-10', '2026-03-11']);
  });

  test('BK-1 a snapshot that cannot be written never stops the bible from opening', async () => {
    const handle = await loadFixture(store, freshSlug('bk-daily-fail'));
    const blocked = join(root, 'bk-daily-blocked');
    await writeFile(blocked, 'a file where the snapshot folder should be');
    const open = await openBibleForApp(store, handle.id, { snapshotRoot: blocked });
    expect(open.repo.get('characters', 'H1')).toBeDefined();
  });
});
