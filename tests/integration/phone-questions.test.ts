import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { BridgeStore } from '../../src/main/db/bridge';
import { BridgeService } from '../../src/main/bridge/service';
import { BRIDGE_DOWN, BRIDGE_UP, worldIdFor } from '../../src/shared/bridge';
import type { NovelPocket, UpRow } from '../../src/shared/bridge';
import type { QuestionStep } from '../../src/shared/domain/phoneQuestions';
import { questionCommand } from '../../src/shared/domain/phoneQuestions';
import { UndoManager } from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { dumpBible, replaceBible } from '../../src/main/backup/dump';
import { reloadSession } from '../../src/main/backup/restore';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

async function open(prefix: string) {
  const slug = freshSlug(prefix);
  await loadFixture(store, slug);
  const session = await openBibleSession(store, slug);
  const world = worldIdFor(slug)!;
  const steps: QuestionStep[] = [];
  const errors: unknown[] = [];
  const service = new BridgeService({
    store: new BridgeStore(store.bridge),
    session,
    world,
    name: 'Fixture novel',
    publishAfterMs: 20,
    pullEveryMs: 60 * 60 * 1000,
    onError: (e) => errors.push(e),
    onQuestions: (s) => steps.push(...s),
  });
  return { slug, session, world, service, steps, errors, invoke: ipcFor(() => session) };
}

async function send(
  world: string,
  table: UpRow['table'],
  id: string,
  rev: number,
  row: Record<string, unknown> | null,
): Promise<void> {
  const _id = `${world}:${table}:${id}`;
  const doc = { world, table, id, rev, deleted: row === null, row, at: rev };
  await store.bridge.collection(BRIDGE_UP).replaceOne({ _id } as Document, doc, { upsert: true });
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting');
};

const question = (ctx: Awaited<ReturnType<typeof open>>, id: string) =>
  ctx.session.model.get('openQuestions', id);

describe('FN-7 questions from the phone, through the bridge pull', () => {
  let ctx: Awaited<ReturnType<typeof open>>;
  let qid: string;
  beforeAll(async () => {
    ctx = await open('fn7');
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Does Siyuan leave before the flood?',
      question: 'Does Siyuan leave before the flood?',
    });
    qid = q._id;
    await ctx.service.start();
  });
  afterAll(() => ctx.service.stop());

  test('FN-7 This answers it fills Decision and sets Decided through the write path, the thread is linked, and the pocket carries it down', async () => {
    const at = Date.now() + 1000;
    await send(ctx.world, 'pages', qid, 2, {
      id: qid,
      kind: 'question',
      title: 'Does Siyuan leave before the flood?',
      state: 'answered',
      answeredAt: at,
      createdAt: at - 5000,
      updatedAt: at,
    });
    await send(ctx.world, 'messages', 'w1', 1, {
      id: 'w1',
      pageId: qid,
      at: at - 100,
      // Written before the page was answered, so the page's time is the change.
      updatedAt: Date.now() - 5000,
      text: 'After the flood, in the spring.',
      wise: true,
      kept: false,
    });
    await send(ctx.world, 'messages', 'w0', 1, {
      id: 'w0',
      pageId: qid,
      at: at - 900,
      updatedAt: Date.now() - 6000,
      text: 'Before the flood.',
      wise: true,
      kept: false,
    });
    await ctx.service.pull();
    const q = question(ctx, qid)!;
    expect(q.state).toBe('decided');
    expect(q.decision).toBe('After the flood, in the spring.');
    // The one write path: validated, in the read model and MongoDB.
    const stored = await ctx.session.handle
      .collection('openQuestions')
      .findOne({ _id: qid } as Document);
    expect(stored?.decision).toBe('After the flood, in the spring.');
    expect(ctx.steps).toEqual([
      {
        id: qid,
        title: 'Does Siyuan leave before the flood?',
        before: { state: 'open', decision: '' },
        after: { state: 'decided', decision: 'After the flood, in the spring.' },
      },
    ]);
    expect(ctx.session.repo.notebookPage(qid)?.questionId).toBe(qid);
    await until(async () => {
      const down = await store.bridge.collection(BRIDGE_DOWN).findOne({ _id: ctx.world as never });
      const pq = (down?.pocket as NovelPocket | undefined)?.questions.find((x) => x.id === qid);
      return pq?.state === 'decided' && pq.decision === 'After the flood, in the spring.';
    });
    // A second pull with nothing new changes nothing.
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(ctx.steps).toEqual([]);
  });

  test('FN-7 each change is one undo step: undo puts the question back open with no decision', async () => {
    const manager = new UndoManager();
    const io = undoIO(ctx.invoke);
    manager.record(
      questionCommand({
        id: qid,
        title: 'Does Siyuan leave before the flood?',
        before: { state: 'open', decision: '' },
        after: { state: 'decided', decision: 'After the flood, in the spring.' },
      }),
    );
    await manager.step('undo', io);
    expect(question(ctx, qid)).toMatchObject({ state: 'open', decision: '' });
    await manager.step('redo', io);
    expect(question(ctx, qid)).toMatchObject({
      state: 'decided',
      decision: 'After the flood, in the spring.',
    });
  });

  test('FN-7 a desktop edit made after the phone change stands; a later phone change then wins', async () => {
    await ctx.session.repo.update('openQuestions', qid, { decision: 'Edited on the desk.' });
    const old = Date.parse(String(question(ctx, qid)!.modifiedAt)) - 10_000;
    ctx.steps.length = 0;
    await send(ctx.world, 'pages', qid, 3, {
      id: qid,
      kind: 'question',
      title: 'Does Siyuan leave before the flood?',
      state: 'open',
      createdAt: old - 5000,
      updatedAt: old,
    });
    await ctx.service.pull();
    expect(question(ctx, qid)).toMatchObject({ state: 'decided', decision: 'Edited on the desk.' });
    expect(ctx.steps).toEqual([]);
    // Taken back on the phone after the desk edit: it reopens and keeps the decision text.
    const later = Date.now() + 5000;
    await send(ctx.world, 'pages', qid, 4, {
      id: qid,
      kind: 'question',
      title: 'Does Siyuan leave before the flood?',
      state: 'open',
      createdAt: old - 5000,
      updatedAt: later,
    });
    await ctx.service.pull();
    expect(question(ctx, qid)).toMatchObject({ state: 'open', decision: 'Edited on the desk.' });
    expect(ctx.steps.map((s) => s.after.state)).toEqual(['open']);
  });

  test('FN-7 Resolve with no wise line sets Decided and leaves the decision', async () => {
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Is the river named?',
      question: 'Is the river named?',
    });
    const later = Date.now() + 5000;
    await send(ctx.world, 'pages', q._id, 1, {
      id: q._id,
      kind: 'question',
      title: 'Is the river named?',
      state: 'answered',
      resolvedByTap: true,
      answeredAt: later,
      updatedAt: later,
    });
    await ctx.service.pull();
    expect(question(ctx, q._id)).toMatchObject({ state: 'decided', decision: '' });
  });

  test('FN-7 a question asked on the phone is a new open question with the phone ID, its thread linked, in the pocket', async () => {
    const id = '0b9e2f1c-8d3a-4c55-9f7e-2a1d3c4b5e6f';
    const at = Date.now();
    await send(ctx.world, 'pages', id, 1, {
      id,
      kind: 'question',
      title: 'Who keeps the temple key after 2071?',
      state: 'open',
      createdAt: at,
      updatedAt: at,
      year: 2071,
    });
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(question(ctx, id)).toMatchObject({
      title: 'Who keeps the temple key after 2071?',
      question: 'Who keeps the temple key after 2071?',
      state: 'open',
      decision: '',
    });
    expect(ctx.steps).toEqual([
      {
        id,
        title: 'Who keeps the temple key after 2071?',
        before: null,
        after: { state: 'open', decision: '' },
      },
    ]);
    expect(ctx.session.repo.notebookPage(id)).toMatchObject({ kind: 'thread', questionId: id });
    await until(async () => {
      const down = await store.bridge.collection(BRIDGE_DOWN).findOne({ _id: ctx.world as never });
      return !!(down?.pocket as NovelPocket | undefined)?.questions.some((x) => x.id === id);
    });
    // Moved to the trash in the bible, it is not asked again by the next pull.
    await ctx.session.repo.softDelete('openQuestions', id);
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(question(ctx, id)?.deletedAt).toBeTruthy();
    expect(ctx.steps).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });
});

describe('FN-7 review fixes: a question never comes back, steps wait to be claimed, a desk edit mid-pull stands', () => {
  const answered = (id: string, at: number, title = 'Is the bridge held?') => ({
    id,
    kind: 'question',
    title,
    state: 'answered',
    answeredAt: at,
    createdAt: at - 1000,
    updatedAt: at,
  });

  test('FN-7 a question answered on the phone, then deleted forever on the desk, is not made again by the next pull', async () => {
    const ctx = await open('fn7-purge');
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Is the bridge held?',
      question: 'Is the bridge held?',
    });
    await ctx.service.start();
    await send(ctx.world, 'pages', q._id, 1, answered(q._id, Date.now() + 1000));
    await ctx.service.pull();
    expect(question(ctx, q._id)?.state).toBe('decided');
    await ctx.session.repo.softDelete('openQuestions', q._id);
    await ctx.session.repo.emptyTrash();
    expect(question(ctx, q._id)).toBeUndefined();
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(question(ctx, q._id)).toBeUndefined();
    expect(ctx.steps).toEqual([]);
    ctx.service.stop();
  });

  test('FN-7 a question asked on the phone, taken back by undo and deleted forever, is not made again', async () => {
    const ctx = await open('fn7-undo');
    await ctx.service.start();
    const id = 'a1b2c3d4-0000-4000-8000-00000000000a';
    await send(ctx.world, 'pages', id, 1, { ...answered(id, Date.now()), state: 'open' });
    await ctx.service.pull();
    expect(question(ctx, id)).toBeTruthy();
    // Undo of "Asked on the phone" moves it to the trash; Empty trash deletes it forever.
    const manager = new UndoManager();
    manager.record(questionCommand(ctx.steps[0]!));
    await manager.step('undo', undoIO(ctx.invoke));
    await ctx.session.repo.emptyTrash();
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(question(ctx, id)).toBeUndefined();
    expect(ctx.steps).toEqual([]);
    ctx.service.stop();
  });

  test('FN-7 a snapshot restored from before a question asked on the phone does not bring the question back from its page', async () => {
    const ctx = await open('fn7-restore');
    await ctx.service.start();
    const before = await dumpBible(ctx.session.handle);
    const version = before.bible.schemaVersion;
    const id = 'a1b2c3d4-0000-4000-8000-00000000000b';
    await send(ctx.world, 'pages', id, 1, { ...answered(id, Date.now()), state: 'open' });
    await ctx.service.pull();
    expect(question(ctx, id)).toBeTruthy();
    await replaceBible(ctx.session.handle, before.collections, version);
    await reloadSession(ctx.session, 'Restored.');
    ctx.steps.length = 0;
    await ctx.service.pull();
    expect(question(ctx, id)).toBeUndefined();
    expect(ctx.steps).toEqual([]);
    expect(ctx.session.repo.bridgeQuestionIds().has(id)).toBe(true);
    ctx.service.stop();
  });

  test('FN-7 steps wait in the service until claimed, once', async () => {
    const ctx = await open('fn7-claim');
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Is the bridge held?',
      question: 'Is the bridge held?',
    });
    await send(ctx.world, 'pages', q._id, 1, answered(q._id, Date.now() + 1000));
    await ctx.service.start();
    const claimed = ctx.service.claimSteps();
    expect(claimed.map((s) => [s.id, s.after.state])).toEqual([[q._id, 'decided']]);
    expect(ctx.service.claimSteps()).toEqual([]);
    ctx.service.stop();
  });

  test('FN-7 a desk edit that lands while the pull is writing stands: the planned write is skipped', async () => {
    const ctx = await open('fn7-race');
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Is the bridge held?',
      question: 'Is the bridge held?',
    });
    await send(ctx.world, 'pages', q._id, 1, answered(q._id, Date.now() + 60_000));
    await send(ctx.world, 'messages', 'rw1', 1, {
      id: 'rw1',
      pageId: q._id,
      at: Date.now(),
      text: 'From the phone.',
      wise: true,
      kept: false,
    });
    const repo = ctx.session.repo;
    const update = repo.update.bind(repo);
    let edited = false;
    // The desk edit lands after the pull planned and before it writes.
    repo.update = (async (...args: Parameters<typeof update>) => {
      if (!edited && args[0] === 'openQuestions' && args[3]?.expectModifiedAt) {
        edited = true;
        await update('openQuestions', q._id, { decision: 'Typed on the desk.' });
      }
      return update(...args);
    }) as typeof repo.update;
    await ctx.service.pull();
    repo.update = update;
    expect(edited).toBe(true);
    expect(question(ctx, q._id)).toMatchObject({ state: 'open', decision: 'Typed on the desk.' });
    expect(ctx.steps).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });
});
