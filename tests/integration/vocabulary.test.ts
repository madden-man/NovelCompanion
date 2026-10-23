import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBible } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import { exportBibleJson, importBibleJson } from '../../src/main/backup/json';
import type { OpenBible } from '../../src/main/db/session';
import { UndoManager } from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import {
  cultureUnitCommand,
  eraDefaultsCommand,
  listLookCommand,
  listMoveCommand,
  listParentCommand,
  listRemoveCommand,
  numberSettingCommand,
  templateCommand,
} from '../../src/shared/undoCommands';
import { DEFAULT_BIBLE_SETTINGS } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let fx: OpenBible;
let invoke: Invoke;

beforeAll(async () => {
  store = await localStore();
  fx = await openBibleSession(store, (await loadFixture(store, freshSlug('vocab'))).id);
  invoke = ipcFor(() => fx);
});
afterAll(async () => {
  await store.close();
});

const items = async (listId: string) =>
  (await invoke('lists.get', {})).lists.find((l) => l._id === listId)!.items;
const ids = async (listId: string) => (await items(listId)).map((i) => i.id);

describe('IP-8 lists reorder and re-parent, with undo', () => {
  test('IP-8 lists.move puts an item at an index of the stored order, and undo and redo move it back and forth', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    expect(await ids('communities')).toEqual(['portland', 'guangzhou']);
    const moved = await invoke('lists.move', {
      listId: 'communities',
      itemId: 'guangzhou',
      index: 0,
    });
    expect(moved).toEqual({ from: 1, to: 0 });
    expect(await ids('communities')).toEqual(['guangzhou', 'portland']);
    undo.record(
      listMoveCommand(
        invoke,
        'Communities',
        'communities',
        { id: 'guangzhou', label: 'Guangzhou' },
        moved.from,
        moved.to,
      ),
    );
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Moved Guangzhou in Communities',
    });
    expect(await ids('communities')).toEqual(['portland', 'guangzhou']);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await ids('communities')).toEqual(['guangzhou', 'portland']);
    // Moved by hand since: the undo is skipped and writes nothing.
    await invoke('lists.move', { listId: 'communities', itemId: 'guangzhou', index: 1 });
    expect(await undo.step('undo', io)).toEqual(
      expect.objectContaining({ status: 'skipped', reason: 'Guangzhou was moved since' }),
    );
    expect(await ids('communities')).toEqual(['portland', 'guangzhou']);
  });

  test('IP-8 lists.setParent re-parents an item, refuses a loop in plain words, and undoes', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const parentOf = async (id: string) =>
      (await items('eventCategories')).find((i) => i.id === id)!.parentId;
    await expect(
      invoke('lists.setParent', {
        listId: 'eventCategories',
        itemId: 'technology',
        parentId: 'robotics',
      }),
    ).rejects.toThrow('Technology cannot sit under Robotics, which is already under it.');
    const r = await invoke('lists.setParent', {
      listId: 'eventCategories',
      itemId: 'climate',
      parentId: 'geopolitics',
    });
    expect(r).toEqual({ from: null, to: 'geopolitics' });
    expect(await parentOf('climate')).toBe('geopolitics');
    undo.record(
      listParentCommand(
        invoke,
        'Event categories',
        'eventCategories',
        { id: 'climate', label: 'Climate' },
        r.from,
        r.to,
      ),
    );
    expect((await undo.step('undo', io)).status).toBe('applied');
    expect(await parentOf('climate')).toBeNull();
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await parentOf('climate')).toBe('geopolitics');
    await invoke('lists.setParent', {
      listId: 'eventCategories',
      itemId: 'climate',
      parentId: null,
    });
  });

  test('IP-8 the families and eras lists come from entries, so they are not moved here', async () => {
    await expect(
      invoke('lists.move', { listId: 'families', itemId: 'FAM-HALE', index: 1 }),
    ).rejects.toThrow('Items in this list come from the entries themselves.');
  });

  test('IP-8 renaming a region renames it on every event at once, because events store its ID', async () => {
    const oregonEvents = fx.repo
      .list('worldEvents')
      .filter((e) => e.regions.includes('oregon'))
      .map((e) => e._id);
    expect(oregonEvents.length).toBeGreaterThan(0);
    const r = await invoke('lists.rename', {
      listId: 'regions',
      itemId: 'oregon',
      label: 'State of Oregon',
    });
    // No entry needs a write: they hold the ID.
    expect(r).toEqual({ updated: 0, from: 'Oregon' });
    const region = (await items('regions')).find((i) => i.id === 'oregon')!;
    expect([region.label, region.usage]).toEqual(['State of Oregon', oregonEvents.length]);
    for (const id of oregonEvents)
      expect(fx.repo.get('worldEvents', id)!.regions).toContain('oregon');
    await expect(
      invoke('lists.removeItem', { listId: 'regions', itemId: 'oregon' }),
    ).rejects.toThrow(/use State of Oregon/);
    await invoke('lists.rename', { listId: 'regions', itemId: 'oregon', label: 'Oregon' });
  });
});

describe('IP-10 IP-11 IP-14 the bible settings', () => {
  test('IP-11 settings.get gives the defaults, and the brief window is the bible window before', async () => {
    const fresh = await createBibleWithDefaults(store, freshSlug('vocab-set'), 'Settings');
    const ipc = ipcFor(() => fresh);
    expect(await ipc('settings.get', {})).toEqual(DEFAULT_BIBLE_SETTINGS);
    await ipc('settings.set', { numbers: { windowBefore: 6 } });
    expect((await ipc('brief.settings.get', {})).window).toBe(6);
    await ipc('brief.settings.set', { window: 2 });
    expect((await ipc('settings.get', {})).numbers.windowBefore).toBe(2);
  });

  test('IP-11 a number change is one undo step, and a value that does not fit is refused in plain words', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const before = (await invoke('settings.get', {})).numbers.timelineStart;
    const after = (await invoke('settings.set', { numbers: { timelineStart: 2010 } })).numbers;
    expect(after.timelineStart).toBe(2010);
    undo.record(numberSettingCommand(invoke, 'timelineStart', before, 2010));
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the first year of the timeline',
    });
    expect((await invoke('settings.get', {})).numbers.timelineStart).toBe(2025);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect((await invoke('settings.get', {})).numbers.timelineStart).toBe(2010);
    await invoke('settings.set', { numbers: { timelineStart: 2025 } });

    await expect(invoke('settings.set', { numbers: { timelineEnd: 2000 } })).rejects.toThrow(
      'The last year of the timeline comes after the first.',
    );
    await expect(invoke('settings.set', { numbers: { autosaveMs: 5000 } })).rejects.toThrow(
      'The autosave delay is at most 750 milliseconds, so a change saves within a second.',
    );
    await expect(invoke('settings.set', { numbers: { windowAfter: -1 } })).rejects.toThrow(
      'Years after is 0 or more.',
    );
    expect((await invoke('settings.get', {})).numbers).toEqual(DEFAULT_BIBLE_SETTINGS.numbers);
  });

  test('IP-11 SB-2 the selection looks ahead the bible years after', async () => {
    const input = { kind: 'chapter' as const, chapterId: 'CH6' };
    expect((await invoke('session.relevant', { input })).selection.ahead).toBe(1);
    await invoke('settings.set', { numbers: { windowAfter: 4 } });
    expect((await invoke('session.relevant', { input })).selection.ahead).toBe(4);
    await invoke('settings.set', { numbers: { windowAfter: 1 } });
  });

  test('IP-10 the cultural time unit is a setting with undo, and age groups are a list with ages', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    await invoke('settings.set', { cultureUnit: 'five' });
    undo.record(cultureUnitCommand(invoke, 'decade', 'five'));
    expect((await invoke('settings.get', {})).cultureUnit).toBe('five');
    expect((await undo.step('undo', io)).status).toBe('applied');
    expect((await invoke('settings.get', {})).cultureUnit).toBe('decade');
    expect((await items('ageGroups')).map((i) => i.id)).toEqual([
      'all',
      '0-18',
      '18-30',
      '30-50',
      '50-70',
      '70+',
    ]);
    await expect(
      invoke('lists.setItem', { listId: 'ageGroups', itemId: '18-30', extra: { to: 10 } }),
    ).rejects.toThrow('An age group ends at or after the age it starts.');
    const { entry } = await invoke('entry.create', {
      collection: 'culturalEntries',
      data: {
        title: 'Rent shares',
        communityId: 'portland',
        startYear: 2040,
        endYear: 2049,
        demographic: '18-30',
      },
    });
    expect(entry.demographic).toBe('18-30');
  });

  test('IP-14 the new chapter strand reads the templates, with undo', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    await invoke('settings.set', { templates: { strandPresent: 'now' } });
    undo.record(
      templateCommand(invoke, 'strandPresent', 'the present strand label', 'present', 'now'),
    );
    const { entry } = await invoke('outline.newChapter', {
      partId: 'PT1',
      title: 'A new one',
      year: 2045,
    });
    expect((entry.strands as { label: string }[])[0]!.label).toBe('now');
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the present strand label',
    });
    expect((await invoke('settings.get', {})).templates.strandPresent).toBe('present');

    await expect(invoke('settings.set', { templates: { chapterTitle: '  ' } })).rejects.toThrow(
      'A default name cannot be empty.',
    );
  });
});

describe('IP-12 era defaults for a new bible', () => {
  test('IP-12 eraDefaults.get and set read and replace the rows, refuse a bad one, and undo', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const before = (await invoke('eraDefaults.get', {})).rows;
    expect(before[0]).toEqual({ name: 'The late 2020s', startYear: 2025, endYear: 2029 });
    expect(before).toHaveLength(8);
    const after = [
      { name: 'The thaw', startYear: 2025, endYear: 2039 },
      { name: 'The long summer', startYear: 2040, endYear: 2100 },
    ];
    expect((await invoke('eraDefaults.set', { rows: after })).rows).toEqual(after);
    undo.record(eraDefaultsCommand(invoke, before, after));
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the default eras',
    });
    expect((await invoke('eraDefaults.get', {})).rows).toEqual(before);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect((await invoke('eraDefaults.get', {})).rows).toEqual(after);
    await expect(
      invoke('eraDefaults.set', { rows: [{ name: 'Backwards', startYear: 2050, endYear: 2040 }] }),
    ).rejects.toThrow('Backwards ends in 2040, before it starts in 2050.');
  });

  test('IP-12 New bible copies the stored era defaults into its own eras', async () => {
    const rows = (await invoke('eraDefaults.get', {})).rows;
    const made = await createBibleWithDefaults(store, freshSlug('vocab-new'), 'New', rows);
    const eras = made.repo
      .list('eraStates')
      .map((e) => [e.name, e.startYear, e.endYear])
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    expect(eras).toEqual(rows.map((r) => [r.name, r.startYear, r.endYear]));
    expect((await ipcFor(() => made)('eraDefaults.get', {})).rows).toEqual(rows);
  });
});

describe('IP-9 IP-10 list item looks', () => {
  test('IP-9 removing an unused item undoes with its colour and extra values', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const { item } = await invoke('lists.addItem', {
      listId: 'momentKinds',
      label: 'Travel',
      parentId: null,
      color: '#2a78d6',
      extra: { weight: 'big' },
    });
    await invoke('lists.removeItem', { listId: 'momentKinds', itemId: item.id });
    undo.record(listRemoveCommand(invoke, 'Moment kinds', 'momentKinds', item));
    expect((await undo.step('undo', io)).status).toBe('applied');
    const again = (await items('momentKinds')).find((i) => i.id === item.id)!;
    expect([again.color, again.extra]).toEqual(['#2a78d6', { weight: 'big' }]);
  });

  test('IP-9 IP-10 an undo of a look compares extra values whatever their order', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const item = (await items('ageGroups')).find((i) => i.id === '18-30')!;
    const before = { color: item.color, extra: { to: 30, from: 18 } };
    const { item: after } = await invoke('lists.setItem', {
      listId: 'ageGroups',
      itemId: '18-30',
      extra: { to: 31 },
    });
    undo.record(
      listLookCommand(invoke, 'Age groups', 'ageGroups', item, before, {
        color: after.color,
        extra: { to: 31, from: 18 },
      }),
    );
    expect((await undo.step('undo', io)).status).toBe('applied');
    expect((await items('ageGroups')).find((i) => i.id === '18-30')!.extra).toEqual({
      from: 18,
      to: 30,
    });
  });
});

describe('IP-8 IP-12 files from before A47', () => {
  test('IP-8 a bible file is held to its own regions list', async () => {
    const { text } = await exportBibleJson(fx.handle);
    const file = () =>
      JSON.parse(text) as {
        collections: {
          lists: { _id: string }[];
          worldEvents: { regions: string[] }[];
        };
      };
    const target = async () => createBible(store, freshSlug('vocab-file'), 'File');

    const badRegion = file();
    badRegion.collections.worldEvents[0]!.regions = ['nowhere-land'];
    await expect(importBibleJson(await target(), JSON.stringify(badRegion))).rejects.toThrow(
      'region nowhere-land is not in the list.',
    );
  });
});

describe('IP-11 WE-2 the era coverage reads the timeline span', () => {
  test('IP-11 WE-2 era gaps are checked across the bible first and last years', async () => {
    const fresh = await createBibleWithDefaults(store, freshSlug('vocab-era'), 'Eras');
    const ipc = ipcFor(() => fresh);
    expect((await ipc('timeline.eraCoverage', {})).messages).toEqual([]);
    await ipc('settings.set', { numbers: { timelineStart: 2020, timelineEnd: 2110 } });
    const r = await ipc('timeline.eraCoverage', {});
    expect([r.coverage.from, r.coverage.to]).toEqual([2020, 2110]);
    expect(r.messages).toEqual(['No era covers 2020 to 2024.', 'No era covers 2101 to 2110.']);
  });
});
