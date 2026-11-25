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
      updatedAt: at - 100,
      text: 'After the flood, in the spring.',
      wise: true,
      kept: false,
    });
    await send(ctx.world, 'messages', 'w0', 1, {
      id: 'w0',
      pageId: qid,
      at: at - 900,
      updatedAt: at - 900,
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
