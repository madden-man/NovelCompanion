import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document as DocxDocument, Packer, Paragraph } from 'docx';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { connect, openBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { readRev } from '../../src/main/db/rev';
import { BridgeService } from '../../src/main/bridge/service';
import { BridgeStore } from '../../src/main/db/bridge';
import { claudeHandlers } from '../../src/main/claude/handlers';
import { runtimeSessionClaude } from '../../src/main/claude/session';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import { FakeClaudeClient, FakeModelCatalog, loadRecordings } from '../../src/main/claude/fake';
import { MemoryKeyStore } from '../../src/main/claude/keys';
import { MemorySettingsStore } from '../../src/main/claude/settings';
import type { Host } from '../../src/main/host/types';
import { MemoryMongoUriStore, TEST_URI_ENV } from '../../src/main/host/uri';
import { freshenOpenBible, registerHandlers } from '../../src/main/ipc/handlers';
import { runHandler } from '../../src/main/ipc/validate';
import type { HandlerTable } from '../../src/main/ipc/validate';
import { WRITE_CHANNELS } from '../../src/shared/ipcApp';
import type { Channel, EventName, Request, Response } from '../../src/shared/ipc';
import type { ClaudeStreamEvent } from '../../src/shared/claude';
import { BRIDGE_DOWN, worldIdFor } from '../../src/shared/bridge';
import { blankEntry } from '../../src/shared/domain/blank';
import { manifests } from '../../src/shared/schema';
import { ELSEWHERE_MESSAGE, ENTRY_MOVED_MESSAGE } from '../../src/shared/freshness';
import { UndoManager, editCommand, stepNotice } from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import { loadFixture } from '../helpers/loadFixture';

/**
 * A58, P2: one number per bible (PH-6), and a second repository on the same
 * database seeing the first one's writes (PH-7, PH-8), over the real handler
 * table the Electron main process serves.
 */
const ROOT = join(import.meta.dirname, '../..');
const RECORDINGS = loadRecordings(join(ROOT, 'fixtures/claude/recordings.json'));
const KEY = 'sk-ant-api03-integration-test-key-0123456789abcdef';

let store: Store;
/** A second client: another process on the same database. */
let other: Store;

beforeAll(async () => {
  store = await localStore();
  other = await connect(inject('mongoUri'));
});
afterAll(async () => {
  await store.close();
  await other.close();
});

describe('PH-7 PH-8 two repositories on one database see each other’s writes', () => {
  test('PH-8 A writes and B reloads and reads it, then B writes and A reloads and reads it; own writes never reload', async () => {
    const slug = freshSlug('ph8-two');
    await loadFixture(store, slug);
    const a = await openBibleSession(store, slug);
    const b = await openBibleSession(other, slug);
    const seen: { who: string; what: string }[] = [];
    for (const [who, s] of [
      ['a', a],
      ['b', b],
    ] as const) {
      s.repo.onChange((e) => seen.push({ who, what: `change ${e.collection} ${e.id} ${e.op}` }));
      s.repo.onStoryTimeChange(() => seen.push({ who, what: 'storyTime' }));
      s.repo.onReload((message, elsewhere) =>
        seen.push({ who, what: `reload ${String(elsewhere)} ${message}` }),
      );
    }

    expect(await a.repo.freshen()).toBe(false);
    expect(await b.repo.freshen()).toBe(false);
    await a.repo.update('characters', 'H1', { role: 'Lighthouse keeper' });
    expect(await a.repo.freshen()).toBe(false);
    expect(b.repo.get('characters', 'H1')?.role).not.toBe('Lighthouse keeper');
    seen.length = 0;
    expect(await b.repo.freshen()).toBe(true);
    expect(b.repo.get('characters', 'H1')?.role).toBe('Lighthouse keeper');
    expect(b.search.search('Lighthouse').map((h) => h.id)).toContain('H1');
    // Every view hears what changed, then the reload from elsewhere.
    expect(seen).toEqual([
      { who: 'b', what: 'change characters H1 update' },
      { who: 'b', what: `reload true ${ELSEWHERE_MESSAGE}` },
    ]);
    expect(await b.repo.freshen()).toBe(false);

    seen.length = 0;
    await b.repo.setStoryTime({ year: 2041 });
    await b.repo.create('places', { ...blankEntry(manifests.places), title: 'Harbour mouth' });
    expect(await b.repo.freshen()).toBe(false);
    expect(a.repo.storyTime()).toBeNull();
    expect(await a.repo.freshen()).toBe(true);
    expect(a.repo.storyTime()).toEqual({ year: 2041 });
    expect(a.repo.list('places').some((p) => p.title === 'Harbour mouth')).toBe(true);
    expect(seen.filter((s) => s.who === 'a').map((s) => s.what)).toEqual([
      expect.stringMatching(/^change places \S+ create$/),
      'storyTime',
      `reload true ${ELSEWHERE_MESSAGE}`,
    ]);
    expect(seen.filter((s) => s.who === 'b').map((s) => s.what)).toEqual(['storyTime']);
    expect(a.repo.rev).toBe(b.repo.rev);
    expect(a.repo.rev).toBe(await readRev(a.handle));
  });

  test('PH-8 a write on both sides at once: each reloads for the other’s, never for its own', async () => {
    const slug = freshSlug('ph8-both');
    await loadFixture(store, slug);
    const a = await openBibleSession(store, slug);
    const b = await openBibleSession(other, slug);
    await Promise.all([
      a.repo.update('characters', 'H1', { role: 'From A' }),
      b.repo.update('characters', 'H2', { role: 'From B' }),
      a.repo.setTrayMarks(['k1'], 'dismissed'),
    ]);
    expect(await a.repo.freshen()).toBe(true);
    expect(await b.repo.freshen()).toBe(true);
    for (const s of [a, b]) {
      expect(s.repo.get('characters', 'H1')?.role).toBe('From A');
      expect(s.repo.get('characters', 'H2')?.role).toBe('From B');
      expect(await s.repo.freshen()).toBe(false);
    }
  });

  test('PH-8 the reload republishes the pocket, so the phone notebook follows an edit made elsewhere', async () => {
    const slug = freshSlug('ph8-pocket');
    await loadFixture(store, slug);
    const a = await openBibleSession(store, slug);
    const b = await openBibleSession(other, slug);
    const world = worldIdFor(slug)!;
    const service = new BridgeService({
      store: new BridgeStore(store.bridge),
      session: b,
      world,
      name: 'Fixture novel',
      publishAfterMs: 20,
      pullEveryMs: 60 * 60 * 1000,
    });
    await service.start();
    const stamp = async () =>
      (
        (await store.bridge.collection(BRIDGE_DOWN).findOne({ _id: world as never })) as {
          stamp: string;
        } | null
      )?.stamp;
    const before = await stamp();
    expect(before).toBeTruthy();
    await a.repo.update('characters', 'H1', { title: 'Margaret Hale-Rowe' });
    expect(await b.repo.freshen()).toBe(true);
    await expect.poll(stamp, { timeout: 10_000 }).not.toBe(before);
    service.stop();
  });

  test('PH-11 an undo whose entry changed on the other side writes nothing, says so, and the rest of the stack works', async () => {
    const slug = freshSlug('ph11');
    await loadFixture(store, slug);
    const a = await openBibleSession(store, slug);
    const b = await openBibleSession(other, slug);
    const invoke = ipcFor(() => a);
    const manager = new UndoManager();
    const io = undoIO(invoke);
    const edit = async (id: string, patch: Record<string, unknown>, label: string) => {
      const before = (await invoke('entry.get', { collection: 'characters', id })).entry;
      const after = (await invoke('entry.update', { collection: 'characters', id, patch })).entry;
      manager.record(editCommand(label, 'characters', id, before, after));
    };
    await edit('H1', { role: 'First' }, 'Changed Role on H1');
    await edit('H2', { role: 'Second' }, 'Changed Role on H2');
    await edit('H2', { notes: 'Third' }, 'Changed Notes on H2');

    // The other side changes H2 in another field; A has not reloaded yet.
    await b.repo.update('characters', 'H2', { title: 'Renamed elsewhere' });
    const stored = async () =>
      store.db.collection(`${slug}.characters`).findOne({ _id: 'H2' as never });
    const atB = await stored();
    const r = await manager.step('undo', io);
    expect(r).toMatchObject({ status: 'skipped', why: 'moved', reason: ENTRY_MOVED_MESSAGE });
    expect(stepNotice('undo', r)).toBe(
      'Undo skipped: this entry changed somewhere else since that step, so nothing was written.',
    );
    expect(await stored()).toEqual(atB);
    // The step is dropped; the steps below it still undo and redo.
    expect(manager.stack.history().undo.map((c) => c.label)).toEqual([
      'Changed Role on H2',
      'Changed Role on H1',
    ]);
    await a.repo.freshen();
    expect(await manager.step('undo', io)).toMatchObject({ status: 'applied' });
    expect((await stored())?.role).not.toBe('Second');
    expect((await stored())?.title).toBe('Renamed elsewhere');
    expect(await manager.step('undo', io)).toMatchObject({ status: 'applied' });
    expect(await manager.step('redo', io)).toMatchObject({ status: 'applied' });

    // A redo whose entry moved elsewhere is refused the same way.
    await b.repo.update('characters', 'H2', { title: 'Renamed again' });
    const redo = await manager.step('redo', io);
    expect(redo).toMatchObject({ status: 'skipped', why: 'moved' });
    expect((await stored())?.title).toBe('Renamed again');
    expect(await manager.step('undo', io)).toMatchObject({ status: 'applied' });
  });
});

/** A memory host with the recorded Claude, as `registerHandlers` gets from Electron under test. */
function testHost(userData: string) {
  const sent: { event: EventName; payload: unknown }[] = [];
  const streamed: ClaudeStreamEvent[] = [];
  const keys = new MemoryKeyStore(KEY);
  const runtimes: ClaudeRuntime[] = [];
  const host: Host = {
    userData,
    isPackaged: false,
    secrets: { mongoUris: () => new MemoryMongoUriStore(null) },
    broadcast: (event, payload) => sent.push({ event, payload }),
    dialogs: null,
    openExternal: null,
    setTheme: () => undefined,
    claude: {
      attach({ current, emit }) {
        const runtime = new ClaudeRuntime({
          client: new FakeClaudeClient(RECORDINGS),
          keys,
          settings: new MemorySettingsStore(),
          emit: (e) => {
            streamed.push(e);
            emit(e);
          },
        });
        runtimes.push(runtime);
        const s = (): OpenBible | null => current();
        return {
          runtime,
          handlers: claudeHandlers(s, { runtime, keys, catalog: new FakeModelCatalog() }),
          sessionClaude: runtimeSessionClaude(runtime, s, keys),
        };
      },
    },
  };
  /** AI-6: the disclosure confirmed for a bible, as the person does once. */
  const acknowledge = (bible: string) => {
    for (const r of runtimes) r.acknowledge(bible);
  };
  return { host, sent, streamed, acknowledge };
}

async function chapterDoc(text: string): Promise<Buffer> {
  const doc = new DocxDocument({
    sections: [{ children: [new Paragraph(text), new Paragraph('The tide came in.')] }],
  });
  return Packer.toBuffer(doc);
}

describe('PH-6 every write channel moves rev, through the handler table main serves', () => {
  const ENV = [
    TEST_URI_ENV,
    'NOVEL_COMPANION_TEST_PICK_DOCUMENT',
    'NOVEL_COMPANION_TEST_SAVE_PATH',
    'NOVEL_COMPANION_TEST_BIBLE_FILE',
  ];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  let table: HandlerTable;
  let rig: ReturnType<typeof testHost>;
  let slug: string;
  let dir: string;
  let manuscript: string;

  const call = async <C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> => {
    const handler = table.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    const wire = JSON.parse(JSON.stringify(request)) as unknown;
    return JSON.parse(JSON.stringify(await runHandler(channel, handler as never, wire)));
  };
  const revOf = async (bible: string) => readRev(await openBible(store, bible));
  /** Wait until nothing in the background (the bridge's first publish and pull) moves rev. */
  const settle = async () => {
    for (let last = -1, n = await revOf(slug); n !== last;) {
      last = n;
      await new Promise((r) => setTimeout(r, 600));
      n = await revOf(slug);
    }
  };
  const finished = async (runId: string) =>
    expect
      .poll(() => rig.streamed.some((e) => e.runId === runId && e.kind === 'finished'), {
        timeout: 30_000,
      })
      .toBe(true);
  let n = 0;
  const runId = () => `fresh${Date.now()}${n++}`.padEnd(16, '0');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nc-ph6-'));
    manuscript = join(dir, 'Chapter 6 The Letter.docx');
    writeFileSync(manuscript, await chapterDoc('Daniel said nothing at dinner.'));
    process.env[TEST_URI_ENV] = inject('mongoUri');
    process.env.NOVEL_COMPANION_TEST_PICK_DOCUMENT = manuscript;
    process.env.NOVEL_COMPANION_TEST_SAVE_PATH = join(dir, 'export.json');
    process.env.NOVEL_COMPANION_TEST_BIBLE_FILE = join(dir, 'export.json');
    slug = freshSlug('ph6-walk');
    await loadBriefFixture(store, slug);
    rig = testHost(dir);
    table = registerHandlers(rig.host);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  test('PH-8 with no bible open, freshen answers that nothing moved', async () => {
    expect(await freshenOpenBible()).toEqual({ moved: false });
  });

  type WriteChannel = (typeof WRITE_CHANNELS)[number];
  interface Step {
    /** What the channel needs first (an entry in the trash, a proposal, a snapshot). */
    setup?: () => Promise<void>;
    run: () => Promise<unknown>;
    /** The bible whose rev must move, when it is not the open one (a new bible). */
    bible?: string;
  }
  const state: Record<string, string> = {};
  const created = (r: { entry: { _id: string } }) => r.entry._id;

  /** Every write channel, each with a request that writes. A channel left out does not compile. */
  const WALK: Record<WriteChannel, Step> = {
    'tray.mark': { run: () => call('tray.mark', { keys: ['fact-1'], mark: 'dismissed' }) },
    'bible.create': {
      run: () => call('bible.create', { slug: state.newBible!, name: 'Made in the walk' }),
      get bible() {
        return state.newBible;
      },
    },
    'entry.create': {
      run: async () => {
        state.place = created(
          await call('entry.create', {
            collection: 'places',
            data: { ...blankEntry(manifests.places), title: 'Walk place' },
          }),
        );
      },
    },
    'entry.createMany': {
      run: () =>
        call('entry.createMany', {
          items: [
            { collection: 'places', data: { ...blankEntry(manifests.places), title: 'Walk two' } },
          ],
        }),
    },
    'entry.update': {
      run: () =>
        call('entry.update', { collection: 'characters', id: 'H1', patch: { role: 'Walked' } }),
    },
    'entry.delete': {
      run: () => call('entry.delete', { collection: 'places', id: state.place! }),
    },
    'entry.restore': {
      run: () => call('entry.restore', { collection: 'places', id: state.place! }),
    },
    'lists.rename': {
      run: () =>
        call('lists.rename', { listId: 'communities', itemId: 'portland', label: 'Portland OR' }),
    },
    'lists.addItem': {
      run: async () => {
        state.item = (
          await call('lists.addItem', { listId: 'communities', label: 'Seattle', parentId: null })
        ).item.id;
      },
    },
    'lists.removeItem': {
      run: () => call('lists.removeItem', { listId: 'communities', itemId: state.item! }),
    },
    'test.propose': {
      run: async () => {
        state.proposal = (
          await call('test.propose', {
            source: 'import',
            op: 'update',
            collection: 'characters',
            targetId: 'Z2',
            data: { role: 'Foshan' },
            reason: 'The walk',
          })
        ).proposal._id;
      },
    },
    'proposal.edit': {
      run: () => call('proposal.edit', { id: state.proposal!, data: { role: 'Foshan city' } }),
    },
    'proposal.refresh': { run: () => call('proposal.refresh', { id: state.proposal! }) },
    'proposal.approve': { run: () => call('proposal.approve', { id: state.proposal! }) },
    'proposal.reject': {
      setup: async () => {
        state.reject = (
          await call('test.propose', {
            source: 'import',
            op: 'update',
            collection: 'characters',
            targetId: 'Z2',
            data: { role: 'Nowhere' },
            reason: 'To reject',
          })
        ).proposal._id;
      },
      run: () => call('proposal.reject', { id: state.reject! }),
    },
    'test.seed': {
      run: () =>
        call('test.seed', {
          items: [
            { collection: 'places', data: { ...blankEntry(manifests.places), title: 'Seeded' } },
          ],
        }),
    },
    'tree.savePositions': {
      run: () => call('tree.savePositions', { positions: { H1: { x: 10, y: 20 } } }),
    },
    'storyTime.set': { run: () => call('storyTime.set', { time: { year: 2040 } }) },
    'sceneOutline.set': {
      run: () => call('sceneOutline.set', { text: '- The walk begins', breaks: {}, years: {} }),
    },
    'sceneOutline.restore': {
      setup: async () => {
        await call('sceneOutline.set', { text: '- The walk goes on', breaks: {}, years: {} });
        state.version = (await call('sceneOutline.versions', {})).versions.at(-1)!.id;
      },
      run: () => call('sceneOutline.restore', { id: state.version! }),
    },
    'storyTime.promote': {
      run: async () => {
        const p = await call('storyTime.promotePreview', {
          chapterId: 'CH1',
          strandId: 'CH1-present',
        });
        await call('storyTime.promote', {
          chapterId: 'CH1',
          strandId: 'CH1-present',
          baseModifiedAt: p.baseModifiedAt,
        });
      },
    },
    'plot.reorder': {
      run: () =>
        call('plot.reorder', { kind: 'chapters', groupId: 'PT1', movedId: 'CH1', toIndex: 1 }),
    },
    'outline.newChapter': {
      run: () => call('outline.newChapter', { partId: 'PT1', title: 'Walk chapter', year: 2040 }),
    },
    'romanization.set': {
      run: () => call('romanization.set', { languageId: 'mandarin', systemId: 'cantonese' }),
    },
    'community.notes.set': {
      run: () => call('community.notes.set', { communityId: 'portland', text: 'Wet.' }),
    },
    'snapshot.take': {
      // Writes a snapshot folder on this Mac, never the bible, so rev stays where it was.
      run: () => call('snapshot.take', {}),
    },
    'snapshot.restore': {
      setup: async () => {
        state.snapshot = (await call('snapshot.take', {})).snapshot.id;
      },
      run: () => call('snapshot.restore', { id: state.snapshot! }),
    },
    'snapshot.keep': { run: () => call('snapshot.keep', { keep: 25 }) },
    'backup.import': {
      setup: async () => {
        await call('backup.export', {});
      },
      run: () => call('backup.import', { slug: state.imported!, name: 'Imported in the walk' }),
      get bible() {
        return state.imported;
      },
    },
    'brief.settings.set': { run: () => call('brief.settings.set', { budget: 12_345 }) },
    'manuscript.apply': {
      run: async () => {
        const read = await call('manuscript.read', { chapterId: 'CH6', sourceId: 'word' });
        const chapter = (await call('entry.get', { collection: 'chapters', id: 'CH6' })).entry;
        await call('manuscript.apply', {
          token: read.token!,
          baseModifiedAt: String(chapter.modifiedAt),
        });
      },
    },
    'manuscript.reimport': {
      setup: async () => {
        writeFileSync(join(dir, 'next.docx'), await chapterDoc('Daniel spoke at last.'));
        copyFileSync(join(dir, 'next.docx'), manuscript);
      },
      run: () => call('manuscript.reimport', { chapterId: 'CH6' }),
    },
    'chapter.summarize': {
      run: () => call('chapter.summarize', { chapterId: 'CH6', runId: runId() }),
    },
    'claude.ask': {
      run: async () => {
        const id = runId();
        const r = await call('claude.ask', {
          runId: id,
          conversationId: null,
          question: 'How old is Margaret in 2040?',
        });
        await finished(id);
        state.conversation = r.conversationId;
      },
    },
    'claude.alignment': {
      run: async () => {
        const id = runId();
        await call('claude.alignment', { runId: id, chapterId: 'CH5' });
        await finished(id);
      },
    },
    'claude.capture': {
      run: async () => {
        const id = runId();
        await call('claude.capture', {
          runId: id,
          text: 'Zhou Lan moved to Seattle when Portland started rationing water.',
          storyTime: { year: 2034 },
        });
        await finished(id);
      },
    },
    'continuity.check': { run: () => call('continuity.check', { chapterId: null }) },
    'continuity.resolve': {
      run: async () => {
        const found = (await call('continuity.findings', { chapterId: null })).findings;
        const open = found.find((f) => f.state === 'open')!;
        await call('continuity.resolve', { id: open.id, action: 'dismiss' });
      },
    },
    'entry.purge': {
      setup: async () => {
        await call('entry.delete', { collection: 'places', id: state.place! });
      },
      run: () => call('entry.purge', { collection: 'places', id: state.place! }),
    },
    'trash.empty': {
      setup: async () => {
        const id = created(
          await call('entry.create', {
            collection: 'places',
            data: { ...blankEntry(manifests.places), title: 'To empty' },
          }),
        );
        await call('entry.delete', { collection: 'places', id });
      },
      run: () => call('trash.empty', {}),
    },
    'claude.instructions.set': {
      run: () => call('claude.instructions.set', { feature: 'panel', text: 'Short answers.' }),
    },
    'claude.conversation.rename': {
      run: () => call('claude.conversation.rename', { id: state.conversation!, title: 'The walk' }),
    },
    'claude.conversation.clear': {
      run: () => call('claude.conversation.clear', { id: state.conversation! }),
    },
    'claude.conversation.delete': {
      run: () => call('claude.conversation.delete', { id: state.conversation! }),
    },
    'lists.move': {
      run: () => call('lists.move', { listId: 'eventCategories', itemId: 'energy', index: 0 }),
    },
    'lists.setParent': {
      run: () =>
        call('lists.setParent', {
          listId: 'eventCategories',
          itemId: 'energy',
          parentId: null,
        }),
    },
    'lists.setItem': {
      run: () =>
        call('lists.setItem', { listId: 'communities', itemId: 'portland', color: '#2a78d6' }),
    },
    'settings.set': { run: () => call('settings.set', { numbers: { autosaveMs: 600 } }) },
    'eraDefaults.set': {
      run: () =>
        call('eraDefaults.set', { rows: [{ name: 'Long ago', startYear: 1900, endYear: 1950 }] }),
    },
  };

  /** A write channel that writes nothing of the bible's, with why. */
  const NOT_THE_BIBLE: Partial<Record<WriteChannel, string>> = {
    'snapshot.take': 'Writes a snapshot folder on this Mac; the bible is unchanged.',
  };

  /** Order matters only where one step uses what another made. */
  const ORDER: WriteChannel[] = [
    'entry.create',
    'entry.delete',
    'entry.restore',
    'lists.addItem',
    'lists.removeItem',
    'test.propose',
    'proposal.edit',
    'proposal.refresh',
    'proposal.approve',
    'storyTime.set',
    'storyTime.promote',
    'manuscript.apply',
    'manuscript.reimport',
    'continuity.check',
    'continuity.resolve',
    'claude.ask',
    'claude.conversation.rename',
    'claude.conversation.clear',
    'claude.conversation.delete',
    'entry.purge',
  ];

  test('PH-6 the walk names every write channel', () => {
    expect(Object.keys(WALK).sort()).toEqual([...WRITE_CHANNELS].sort());
  });

  test('PH-6 each write channel raises rev in the open bible (or the bible it makes), and freshen follows a write made elsewhere', async () => {
    state.newBible = freshSlug('ph6-new');
    state.imported = freshSlug('ph6-imp');
    await call('bible.open', { slug });
    rig.acknowledge(slug);
    await settle();
    // The process's own writes are its own: nothing to reload.
    expect(await freshenOpenBible()).toEqual({ moved: false });

    const rest = WRITE_CHANNELS.filter((c) => !ORDER.includes(c));
    const missed: string[] = [];
    for (const channel of [...ORDER, ...rest]) {
      const step = WALK[channel];
      await step.setup?.();
      await settle();
      const bible = step.bible ?? slug;
      const before = step.bible ? 0 : await revOf(slug);
      await step.run();
      if (step.bible === undefined) await settle();
      const after = await revOf(bible);
      if (NOT_THE_BIBLE[channel]) {
        expect(after, channel).toBe(before);
        continue;
      }
      if (!(after > before)) missed.push(`${channel}: ${before} to ${after}`);
      // bible.create and backup.import left the open bible alone; open it again if a step switched.
    }
    expect(missed).toEqual([]);
    // Nothing the walk did needs a reload here: every number was this process's own.
    expect(await freshenOpenBible()).toEqual({ moved: false });

    // Another process writes: the open bible follows, and every window hears it.
    rig.sent.length = 0;
    const elsewhere = await openBibleSession(other, slug);
    await elsewhere.repo.update('characters', 'H2', { role: 'From the phone' });
    expect(await freshenOpenBible()).toEqual({ moved: true });
    expect((await call('entry.get', { collection: 'characters', id: 'H2' })).entry.role).toBe(
      'From the phone',
    );
    expect(rig.sent).toEqual(
      expect.arrayContaining([
        {
          event: 'bible.changed',
          payload: { bible: slug, collection: 'characters', id: 'H2', op: 'update' },
        },
        {
          event: 'bible.reloaded',
          payload: { bible: slug, message: ELSEWHERE_MESSAGE, elsewhere: true },
        },
      ]),
    );
    expect(await freshenOpenBible()).toEqual({ moved: false });

    // PH-11: a write planned against the old entry is refused, and the window shows the newer one.
    const stale = (await call('entry.get', { collection: 'characters', id: 'H2' })).entry;
    await elsewhere.repo.update('characters', 'H2', { role: 'From the phone again' });
    await expect(
      call('entry.update', {
        collection: 'characters',
        id: 'H2',
        patch: { role: 'Old value' },
        expectModifiedAt: String(stale.modifiedAt),
      }),
    ).rejects.toThrow(ENTRY_MOVED_MESSAGE);
    await expect
      .poll(
        async () => (await call('entry.get', { collection: 'characters', id: 'H2' })).entry.role,
      )
      .toBe('From the phone again');
  });
});
