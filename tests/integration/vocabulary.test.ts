import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
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
import { DEFAULT_BIBLE_SETTINGS, DEFAULT_BRIEF_HEADINGS } from '../../src/shared/schema';
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

describe('IP-9 statuses and provenance are lists the write path holds entries to', () => {
  test('IP-9 the write path refuses a status or provenance that is not in its list, in plain words', async () => {
    await expect(
      invoke('entry.create', {
        collection: 'places',
        data: { title: 'Somewhere', status: 'maybe' },
      }),
    ).rejects.toThrow('Status maybe is not in the statuses list.');
    await expect(
      invoke('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { provenance: 'guessed' },
      }),
    ).rejects.toThrow('Provenance guessed is not in the provenance list.');
    expect(fx.repo.get('characters', 'H1')!.provenance).toBe('invented');
  });

  test('IP-9 a status is added with a colour and a kind, used by an entry, recoloured with undo, and kept while in use', async () => {
    const lists = await invoke('lists.get', {});
    expect(lists.lists.find((l) => l._id === 'statuses')!.fixedItems).toBe(false);
    await expect(
      invoke('lists.addItem', {
        listId: 'statuses',
        label: 'Maybe',
        parentId: null,
        extra: { kind: 'perhaps' },
      }),
    ).rejects.toThrow('A status is canon, planned or idea to the brief rules.');
    const { item } = await invoke('lists.addItem', {
      listId: 'statuses',
      label: 'Settled',
      parentId: null,
      color: '#0b6e4f',
      extra: { kind: 'canon' },
    });
    expect(item).toEqual({
      id: 'settled',
      label: 'Settled',
      parentId: null,
      color: '#0b6e4f',
      extra: { kind: 'canon' },
    });
    const { item: loose } = await invoke('lists.addItem', {
      listId: 'statuses',
      label: 'Loose end',
      parentId: null,
    });
    expect(loose.extra).toEqual({ kind: 'idea' });
    const { entry } = await invoke('entry.create', {
      collection: 'places',
      data: { title: 'The ferry dock', status: 'settled' },
    });
    expect(entry.status).toBe('settled');

    const undo = new UndoManager();
    const io = undoIO(invoke);
    const before = { color: item.color, extra: item.extra };
    const { item: after } = await invoke('lists.setItem', {
      listId: 'statuses',
      itemId: 'settled',
      color: '#2a78d6',
      extra: { kind: 'planned' },
    });
    undo.record(
      listLookCommand(invoke, 'Statuses', 'statuses', item, before, {
        color: after.color,
        extra: after.extra,
      }),
    );
    expect((await undo.step('undo', io)).status).toBe('applied');
    const back = (await items('statuses')).find((i) => i.id === 'settled')!;
    expect([back.color, back.extra]).toEqual(['#0b6e4f', { kind: 'canon' }]);

    await expect(
      invoke('lists.removeItem', { listId: 'statuses', itemId: 'settled' }),
    ).rejects.toThrow('1 entry uses Settled. Change them first, or rename the item instead.');
    await expect(
      invoke('lists.setItem', { listId: 'statuses', itemId: 'settled', color: 'green' }),
    ).rejects.toThrow();
  });

  test('IP-9 removing an unused status undoes with its colour and kind', async () => {
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const loose = (await items('statuses')).find((i) => i.id === 'loose-end')!;
    await invoke('lists.removeItem', { listId: 'statuses', itemId: 'loose-end' });
    undo.record(listRemoveCommand(invoke, 'Statuses', 'statuses', loose));
    expect((await undo.step('undo', io)).status).toBe('applied');
    const again = (await items('statuses')).find((i) => i.id === 'loose-end')!;
    expect(again.extra).toEqual({ kind: 'idea' });
  });

  test('IP-9 SB-5 an entry under a canon-kind status is selected as canon', async () => {
    const input = { kind: 'chapter' as const, chapterId: 'CH6' };
    const first = (await invoke('session.relevant', { input })).selection.strands[0]!.groups.find(
      (g) => g.kind === 'characters',
    )!.items[0]!;
    await invoke('entry.update', {
      collection: 'characters',
      id: first.id,
      patch: { status: 'settled' },
    });
    const again = (await invoke('session.relevant', { input })).selection.strands[0]!.groups.find(
      (g) => g.kind === 'characters',
    )!.items.find((i) => i.id === first.id)!;
    expect([again.status, again.kind]).toEqual(['settled', 'canon']);
    await invoke('entry.update', {
      collection: 'characters',
      id: first.id,
      patch: { status: first.status },
    });
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
      'The autosave delay is at most 750.',
    );
    await expect(invoke('settings.set', { numbers: { windowAfter: -1 } })).rejects.toThrow(
      'The years after is at least 0.',
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
        status: 'idea',
        communityId: 'portland',
        startYear: 2040,
        endYear: 2049,
        demographic: '18-30',
      },
    });
    expect(entry.demographic).toBe('18-30');
  });

  test('IP-14 the new chapter strand and the brief headings read the templates, with undo', async () => {
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

    const headings: string[] = [...DEFAULT_BRIEF_HEADINGS];
    headings[0] = '1. Who is in the scene';
    await invoke('settings.set', { templates: { briefHeadings: headings } });
    const { structured } = await invoke('session.relevant', {
      input: { kind: 'chapter', chapterId: 'CH6' },
    });
    expect(structured).toContain('## 1. Who is in the scene');
    await invoke('settings.set', { templates: { briefHeadings: [...DEFAULT_BRIEF_HEADINGS] } });
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
