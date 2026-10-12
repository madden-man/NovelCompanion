import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import { claudeHandlers } from '../../src/main/claude/handlers';
import type { ClaudeChannel } from '../../src/main/claude/handlers';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import { FakeClaudeClient, FakeModelCatalog, loadRecordings } from '../../src/main/claude/fake';
import { MemoryKeyStore } from '../../src/main/claude/keys';
import { MemorySettingsStore } from '../../src/main/claude/settings';
import { PROSE_PROHIBITION } from '../../src/main/claude/prompts';
import { FEATURES } from '../../src/main/claude/features';
import { CAPTURE_NO_DELETE } from '../../src/main/claude/features/capture';
import type { ClaudeRun, ClaudeStreamEvent } from '../../src/shared/claude';
import type { Request, Response } from '../../src/shared/ipc';
import type { EntryCollection } from '../../src/shared/schema';
import { captureQuestionData, fileCapture } from '../../src/shared/domain/capture';
import type { CaptureProposal } from '../../src/shared/domain/capture';
import { UndoManager } from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

/**
 * KB-6 and KB-7 through the same channels the capture box uses, with the
 * recorded Claude: a capture queues proposals and writes nothing (AI-3),
 * File it approves the ticked ones and rejects the rest as one undo step
 * (ED-3), and a capture Claude cannot file becomes an open question.
 */
const ROOT = join(import.meta.dirname, '../..');
const RECORDINGS = loadRecordings(join(ROOT, 'fixtures/claude/recordings.json'));
const KEY = 'sk-ant-api03-integration-test-key-0123456789abcdef';
const MOVE = 'Zhou Lan moved to Seattle when Portland started rationing water.';
const RECIPE = 'Meiling and Ruth kept the same recipe box, passed between the families.';
const FERRY = 'The ferry to Macau stopped running in winter.';

let store: Store;
let bible: OpenBible;
let invoke: Invoke;

function rig(key: string | null = KEY) {
  const fake = new FakeClaudeClient(RECORDINGS);
  const keys = new MemoryKeyStore(key);
  const events: ClaudeStreamEvent[] = [];
  const runtime = new ClaudeRuntime({
    client: fake,
    keys,
    settings: new MemorySettingsStore(),
    emit: (e) => events.push(e),
  });
  runtime.acknowledge(bible.handle.id);
  const handlers = claudeHandlers(() => bible, { runtime, keys, catalog: new FakeModelCatalog() });
  const call = async <C extends ClaudeChannel>(channel: C, req: Request<C>) =>
    JSON.parse(
      JSON.stringify(
        await runHandler(
          channel,
          handlers[channel] as unknown as Handler<C>,
          JSON.parse(JSON.stringify(req)),
        ),
      ),
    ) as Response<C>;
  const finished = async (runId: string): Promise<ClaudeRun> => {
    for (let i = 0; i < 500; i++) {
      const done = events.find((e) => e.runId === runId && e.kind === 'finished');
      if (done) return (await call('claude.run', { id: done.conversationId })).run;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Run ${runId} did not finish`);
  };
  return { fake, events, call, finished };
}

let n = 0;
const runId = () => `capture${Date.now()}${n++}`.padEnd(16, '0');

async function capture(text: string, key: string | null = KEY) {
  const r = rig(key);
  const id = runId();
  await r.call('claude.capture', { runId: id, text, storyTime: { year: 2034 } });
  const run = await r.finished(id);
  return { ...r, id, run, turn: run.turns[0]! };
}

const proposalsOf = (ids: string[]) =>
  ids.map(
    (id) =>
      bible.model.get('proposals', id) as unknown as CaptureProposal & {
        _id: string;
        source: string;
        state: string;
        data: Record<string, unknown>;
        reason: string;
      },
  );

const asCapture = (p: { _id: string; op: string; collection: string; targetId: string | null }) =>
  ({
    id: p._id,
    op: p.op as CaptureProposal['op'],
    collection: p.collection as EntryCollection,
    targetId: p.targetId,
  }) satisfies CaptureProposal;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await loadFixture(store, freshSlug('capture'))).id);
  invoke = ipcFor(() => bible);
});
afterAll(async () => {
  await store.close();
});

describe('KB-6 capture', () => {
  test('KB-6 AI-3 AI-5 a recorded capture queues a place lived and a world event in the story year, from Claude, as ideas naming the capture, and writes nothing', async () => {
    const eventsBefore = bible.model.all('worldEvents').length;
    const lanBefore = bible.model.get('characters', 'Z3');
    const { fake, turn, run } = await capture(MOVE);
    expect(turn.status).toBe('done');
    expect(run.feature).toBe('capture');
    expect(turn.answer).toMatch(/^I proposed Seattle from 2034 in Zhou Lan's places lived/);
    // AI-4, AI-5: the system prompt and the material.
    const req = fake.requests[0]!;
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(req.system).toContain(PROSE_PROHIBITION);
    expect(req.prompt).toContain(`<material source="capture box">\n${MOVE}\n</material>`);
    expect(req.prompt).toContain('Story year 2034.');
    // AI-2: the read-only tools and propose_change.
    expect(req.tools.map((t) => t.name)).toEqual([
      'search_entries',
      'get_entry',
      'timeline_for_year',
      'relatives_of',
      'get_chapter',
      'propose_change',
    ]);
    expect(turn.entries.map((e) => e.id)).toContain('Z3');

    const [place, event] = proposalsOf(turn.proposalIds);
    expect(turn.proposalIds).toHaveLength(2);
    expect(place).toMatchObject({
      source: 'claude',
      state: 'pending',
      op: 'update',
      collection: 'characters',
      targetId: 'Z3',
    });
    expect(place!.data.placesLived).toContainEqual({
      place: 'Seattle',
      startYear: 2034,
      endYear: null,
    });
    expect(place!.reason).toMatch(/\(Claude, capture, run /);
    expect(event).toMatchObject({ source: 'claude', op: 'create', collection: 'worldEvents' });
    expect(event!.data).toMatchObject({
      title: 'Portland rations water',
      start: { year: 2034 },
      status: 'idea',
    });
    expect(event!.data.sourceNote).toMatch(/^From a capture on \d{4}-\d{2}-\d{2}\.$/);

    // AI-3: nothing is written before File it.
    expect(bible.model.all('worldEvents')).toHaveLength(eventsBefore);
    expect(bible.model.get('characters', 'Z3')).toEqual(lanBefore);
  });

  test('KB-6 ED-3 File it approves the ticked proposal, rejects the unticked one, and the filing is one undo step', async () => {
    const { turn } = await capture(MOVE);
    const [place, event] = proposalsOf(turn.proposalIds).map(asCapture);
    const eventsBefore = bible.model.all('worldEvents').filter((e) => !e.deletedAt).length;

    // The writer unticks the place lived and files the world event.
    const filing = await fileCapture(invoke, [event!], [place!]);
    expect(filing.failed).toEqual([]);
    expect(filing.filed).toEqual([
      expect.objectContaining({ collection: 'worldEvents', title: 'Portland rations water' }),
    ]);
    const filedId = filing.filed[0]!.id;
    expect(bible.model.get('worldEvents', filedId)).toMatchObject({
      status: 'idea',
      start: { year: 2034 },
    });
    expect(bible.model.get('proposals', event!.id)).toMatchObject({ state: 'approved' });
    expect(bible.model.get('proposals', place!.id)).toMatchObject({ state: 'rejected' });
    const lan = bible.model.get('characters', 'Z3') as unknown as {
      placesLived: { place: string }[];
    };
    expect(lan.placesLived.map((p) => p.place)).not.toContain('Seattle');

    // One undo step takes the whole filing back; redo files it again.
    const undo = new UndoManager();
    undo.record(filing.command!);
    const io = undoIO(invoke);
    expect(await undo.step('undo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('worldEvents', filedId)?.deletedAt).toBeTruthy();
    expect(bible.model.all('worldEvents').filter((e) => !e.deletedAt)).toHaveLength(eventsBefore);
    expect(await undo.step('redo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('worldEvents', filedId)?.deletedAt).toBeFalsy();
  });

  test('KB-6 ED-3 filing a change and a new entry together undoes both in one step', async () => {
    const { turn } = await capture(MOVE);
    const ticked = proposalsOf(turn.proposalIds).map(asCapture);
    const filing = await fileCapture(invoke, ticked, []);
    expect(filing.filed.map((f) => f.collection)).toEqual(['characters', 'worldEvents']);
    const lan = () =>
      (bible.model.get('characters', 'Z3') as unknown as { placesLived: { place: string }[] })
        .placesLived;
    expect(lan().map((p) => p.place)).toContain('Seattle');
    const undo = new UndoManager();
    undo.record(filing.command!);
    expect(await undo.step('undo', undoIO(invoke))).toMatchObject({ status: 'applied' });
    expect(lan().map((p) => p.place)).toEqual(['Guangzhou', 'Portland, Oregon']);
    expect(bible.model.get('worldEvents', filing.filed[1]!.id)?.deletedAt).toBeTruthy();
  });

  test('KB-6 a fact about two characters is proposed linked to both', async () => {
    const { turn } = await capture(RECIPE);
    const [fact] = proposalsOf(turn.proposalIds);
    expect(turn.proposalIds).toHaveLength(1);
    expect(fact).toMatchObject({ source: 'claude', op: 'create', collection: 'facts' });
    expect(fact!.data).toMatchObject({
      title: 'Meiling and Ruth shared one recipe box',
      status: 'idea',
      links: [
        { targetId: 'Z1', kind: 'concerns' },
        { targetId: 'H4', kind: 'concerns' },
      ],
    });
    const filing = await fileCapture(invoke, [asCapture(fact!)], []);
    const backlinks = bible.model.backlinks('Z1').map((b) => b.id);
    expect(backlinks).toContain(filing.filed[0]!.id);
  });
});

describe('KB-6 a capture never deletes', () => {
  test('KB-6 AI-3 propose_change refuses a delete in a capture and says why, and queues nothing', async () => {
    const rejected: { summary: string; reason: string }[] = [];
    const proposed: string[] = [];
    const sink = {
      label: 'capture, run test',
      now: () => new Date(),
      read: () => undefined,
      proposed: (id: string) => proposed.push(id),
      rejected: (summary: string, reason: string) => rejected.push({ summary, reason }),
    };
    const input = { text: 'x', storyTime: { year: 2034 }, capturedOn: '2026-10-12' };
    const tool = FEATURES.capture.tools!(input, bible, sink).find(
      (t) => t.name === 'propose_change',
    )!;
    const before = bible.model.all('proposals').length;
    const out = await tool.handler({
      op: 'delete',
      collection: 'characters',
      targetId: 'U1',
      reason: 'The capture says the Archivist never existed.',
    });
    expect(out).toEqual({ text: `Not queued: ${CAPTURE_NO_DELETE}`, isError: true });
    expect(rejected).toEqual([{ summary: 'delete characters: U1', reason: CAPTURE_NO_DELETE }]);
    expect(proposed).toEqual([]);
    expect(bible.model.all('proposals')).toHaveLength(before);
  });
});

describe('KB-7 capture offline', () => {
  test('KB-7 AI-7 a failed run proposes nothing, keeps the text, and the box saves it as an open question tagged capture with the story time', async () => {
    const { turn } = await capture(FERRY);
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'network' }, proposalIds: [] });
    // AI-7: the input is kept in the saved run.
    expect(turn.question).toContain('The ferry to Macau');
    const data = captureQuestionData(FERRY, 'Story time 2034', '2026-10-12');
    const { entry } = await invoke('entry.create', { collection: 'openQuestions', data });
    expect(bible.model.get('openQuestions', entry._id)).toMatchObject({
      title: FERRY,
      question: FERRY,
      tags: ['capture'],
      status: 'idea',
    });
    expect(String(bible.model.get('openQuestions', entry._id)?.body)).toContain('Story time 2034');
  });

  test('KB-7 without a key nothing is sent and the run says so', async () => {
    const { fake, turn } = await capture(MOVE, null);
    expect(fake.requests).toHaveLength(0);
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'noKey' }, proposalIds: [] });
  });
});
