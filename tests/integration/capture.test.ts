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
  test('KB-6 SM-3 AI-3 AI-5 a recorded capture queues a Lives in moment and a world event in the story year, from Claude, as ideas naming the capture, and writes nothing', async () => {
    const eventsBefore = bible.model.all('worldEvents').length;
    const momentsBefore = bible.model.all('moments').length;
    const { fake, turn, run } = await capture(MOVE);
    expect(turn.status).toBe('done');
    expect(run.feature).toBe('capture');
    expect(turn.answer).toMatch(/^I proposed a moment for Zhou Lan, Lives in Seattle from 2034/);
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
      op: 'create',
      collection: 'moments',
    });
    expect(place!.data).toMatchObject({
      characterId: 'Z3',
      year: 2034,
      title: 'Lives in Seattle',
      status: 'idea',
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
    expect(bible.model.all('moments')).toHaveLength(momentsBefore);
  });

  test('KB-6 ED-3 File it approves the ticked proposal, rejects the unticked one, and the filing is one undo step', async () => {
    const { turn } = await capture(MOVE);
    const [place, event] = proposalsOf(turn.proposalIds).map(asCapture);
    const eventsBefore = bible.model.all('worldEvents').filter((e) => !e.deletedAt).length;

    // The writer unticks the moment and files the world event.
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
    expect(
      bible.model.all('moments').some((m) => !m.deletedAt && m.title === 'Lives in Seattle'),
    ).toBe(false);

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

  test('KB-6 ED-3 SM-3 filing a moment and a world event together undoes both in one step', async () => {
    const { turn } = await capture(MOVE);
    const ticked = proposalsOf(turn.proposalIds).map(asCapture);
    const filing = await fileCapture(invoke, ticked, []);
    expect(filing.filed.map((f) => f.collection)).toEqual(['moments', 'worldEvents']);
    const moment = () => bible.model.get('moments', filing.filed[0]!.id);
    expect(moment()).toMatchObject({ characterId: 'Z3', title: 'Lives in Seattle', year: 2034 });
    const undo = new UndoManager();
    undo.record(filing.command!);
    expect(await undo.step('undo', undoIO(invoke))).toMatchObject({ status: 'applied' });
    expect(moment()?.deletedAt).toBeTruthy();
    expect(bible.model.get('worldEvents', filing.filed[1]!.id)?.deletedAt).toBeTruthy();
  });

  test('KB-6 SM-3 a fact about two characters is proposed as a moment for each of them, never a dropped kind', async () => {
    const { turn } = await capture(RECIPE);
    const proposals = proposalsOf(turn.proposalIds);
    expect(turn.proposalIds).toHaveLength(2);
    expect(proposals.map((p) => [p!.collection, p!.data.characterId, p!.data.status])).toEqual([
      ['moments', 'Z1', 'idea'],
      ['moments', 'H4', 'idea'],
    ]);
    const filing = await fileCapture(
      invoke,
      proposals.map((p) => asCapture(p!)),
      [],
    );
    const backlinks = bible.model.backlinks('Z1').map((b) => b.id);
    expect(backlinks).toContain(filing.filed[0]!.id);
    expect(bible.model.get('moments', filing.filed[1]!.id)).toMatchObject({
      characterId: 'H4',
      year: 2034,
    });
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

describe('SM-2 a capture never files to a dropped kind', () => {
  test('SM-2 AI-3 propose_change refuses a fact, a beat, or a voice note list, and queues nothing', async () => {
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
    for (const collection of ['facts', 'plotBeats']) {
      const out = await tool.handler({
        op: 'create',
        collection,
        data: { title: 'Meiling and Ruth shared one recipe box' },
        reason: 'r',
      });
      expect(out.isError, collection).toBe(true);
    }
    const voice = await tool.handler({
      op: 'update',
      collection: 'characters',
      targetId: 'Z3',
      data: { voiceNotes: [{ at: { year: 2034 }, text: 'Quiet.' }] },
      reason: 'r',
    });
    expect(voice.isError).toBe(true);
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

// ---------- a47-guard: IP-17 capture can mint vocabulary ----------

describe('IP-17 capture can mint a list item', () => {
  const JINAN = 'Add culture for Jinan, 2045';
  const communities = () =>
    (bible.model.get('lists', 'communities')!.items as { id: string; label: string }[]).map(
      (i) => i.label,
    );

  /** The recorded run: the new community, then the cultural line that uses it by its ref. */
  async function jinan() {
    const { turn, fake } = await capture(JINAN);
    expect(turn.status).toBe('done');
    expect(turn.rejected).toEqual([]);
    const [add, line] = proposalsOf(turn.proposalIds) as unknown as {
      _id: string;
      op: string;
      collection: string;
      targetId: string | null;
      state: string;
      data: Record<string, unknown>;
      listAdd: { listId: string; label: string; ref: string } | null;
      uses: { ref: string; proposalId: string }[];
    }[];
    return { add: add!, line: line!, fake };
  }

  test('IP-17 KB-6 "Add culture for Jinan, 2045" proposes the community and the line, and the diff shows the item as a field', async () => {
    const before = communities();
    const { add, line, fake } = await jinan();
    // The tool description tells Claude it may add a list item when none fits.
    const propose = fake.requests.at(-1)!.tools.find((t) => t.name === 'propose_change')!;
    expect(propose.description).toMatch(
      /community, event category, region, language or tag fits, first propose a new one/,
    );
    expect(add).toMatchObject({
      op: 'listAdd',
      collection: 'lists',
      state: 'pending',
      listAdd: { listId: 'communities', label: 'Jinan', ref: 'new:jinan' },
    });
    expect(line).toMatchObject({
      op: 'create',
      collection: 'culturalEntries',
      data: { communityId: 'new:jinan', startYear: 2045 },
      uses: [{ ref: 'new:jinan', proposalId: add._id }],
    });
    // AI-3: nothing is written before approval.
    expect(communities()).toEqual(before);
    const diff = await invoke('proposal.diff', { id: add._id });
    expect(diff.changes).toEqual([{ path: 'Community', before: null, after: '+ Jinan' }]);
    const lineDiff = await invoke('proposal.diff', { id: line._id });
    expect(lineDiff.changes).toContainEqual({
      path: 'communityId',
      before: undefined,
      after: '+ Jinan',
    });
  });

  test('IP-17 KB-6 ED-3 File it creates the item before the line that uses it, as one undo step', async () => {
    const { add, line } = await jinan();
    const filing = await fileCapture(invoke, [asCapture(line), asCapture(add)], []);
    expect(filing.failed).toEqual([]);
    expect(communities()).toContain('Jinan');
    const item = (
      bible.model.get('lists', 'communities')!.items as { id: string; label: string }[]
    ).find((i) => i.label === 'Jinan')!;
    expect(item.id).toBe('jinan');
    const made = bible.model.get('culturalEntries', filing.filed[0]!.id)!;
    expect(made).toMatchObject({ communityId: 'jinan', startYear: 2045, status: 'idea' });
    expect(bible.model.get('proposals', add._id)).toMatchObject({
      state: 'approved',
      appliedItemId: 'jinan',
    });
    expect(filing.command!.label).toBe('Filed a capture: Jinan in 2045 and Jinan');
    const undo = new UndoManager();
    undo.record(filing.command!);
    const io = undoIO(invoke);
    expect(await undo.step('undo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('culturalEntries', made._id)?.deletedAt).toBeTruthy();
    expect(communities()).not.toContain('Jinan');
    expect(await undo.step('redo', io)).toMatchObject({ status: 'applied' });
    expect(communities()).toContain('Jinan');
    expect(bible.model.get('culturalEntries', made._id)?.deletedAt).toBeFalsy();
    // Leave the list as the fixture had it for the tests that follow.
    await undo.step('undo', io);
  });

  test('IP-17 approving the line alone creates the pending item first, in the same write', async () => {
    const { add, line } = await jinan();
    const { proposal } = await invoke('proposal.approve', { id: line._id });
    expect(bible.model.get('culturalEntries', proposal.appliedEntryId!)!.communityId).toBe('jinan');
    expect(proposal.data.communityId).toBe('jinan');
    expect(bible.model.get('proposals', add._id)).toMatchObject({ state: 'approved' });
    expect(communities()).toContain('Jinan');
    await invoke('entry.delete', { collection: 'culturalEntries', id: proposal.appliedEntryId! });
    const item = (
      bible.model.get('lists', 'communities')!.items as { id: string; label: string }[]
    ).find((i) => i.label === 'Jinan')!;
    await invoke('lists.removeItem', { listId: 'communities', itemId: item.id });
  });

  test('IP-17 an item added to the list meanwhile, in any case, is used as it is and undo leaves it there', async () => {
    const { add, line } = await jinan();
    const { item } = await invoke('lists.addItem', { listId: 'communities', label: 'JINAN' });
    const filing = await fileCapture(invoke, [asCapture(add), asCapture(line)], []);
    expect(filing.failed).toEqual([]);
    expect(communities().filter((l) => l.toLowerCase() === 'jinan')).toEqual(['JINAN']);
    expect(bible.model.get('proposals', add._id)).toMatchObject({
      state: 'approved',
      appliedItemId: item.id,
      appliedItemExisted: true,
    });
    const made = bible.model.get('culturalEntries', filing.filed[0]!.id)!;
    expect(made.communityId).toBe(item.id);
    const undo = new UndoManager();
    undo.record(filing.command!);
    expect(await undo.step('undo', undoIO(invoke))).toMatchObject({ status: 'applied' });
    expect(bible.model.get('culturalEntries', made._id)?.deletedAt).toBeTruthy();
    // The item was the writer's, not the capture's: it stays.
    expect(communities()).toContain('JINAN');
    await invoke('lists.removeItem', { listId: 'communities', itemId: item.id });
  });

  test('IP-17 ED-7 the name of a proposed item edits before approval: blank, too long and a name the list has are refused, and a good name lands on the proposal only', async () => {
    const { add, line } = await jinan();
    const before = communities();
    await expect(invoke('proposal.edit', { id: add._id, data: { label: '   ' } })).rejects.toThrow(
      'A list item needs a name.',
    );
    await expect(
      invoke('proposal.edit', { id: add._id, data: { label: 'J'.repeat(201) } }),
    ).rejects.toThrow('A list item name is at most 200 characters.');
    // Only the case differs from an item the list has: refused, like a proposal of it.
    await expect(
      invoke('proposal.edit', { id: add._id, data: { label: 'GUANGZHOU' } }),
    ).rejects.toThrow(
      'The Communities list already has Guangzhou. Reject this proposal and use it instead.',
    );
    expect(bible.model.get('proposals', add._id)).toMatchObject({
      listAdd: { label: 'Jinan' },
      edited: false,
    });
    const { proposal } = await invoke('proposal.edit', {
      id: add._id,
      data: { label: '  Jinan City ' },
    });
    expect(proposal).toMatchObject({
      state: 'pending',
      edited: true,
      listAdd: { listId: 'communities', label: 'Jinan City', ref: 'new:jinan' },
    });
    // The proposal only: the list is as it was, and the line now shows the new name.
    expect(communities()).toEqual(before);
    const lineDiff = await invoke('proposal.diff', { id: line._id });
    expect(lineDiff.changes).toContainEqual({
      path: 'communityId',
      before: undefined,
      after: '+ Jinan City',
    });
    await invoke('proposal.reject', { id: line._id });
    await invoke('proposal.reject', { id: add._id });
  });

  test('IP-17 proposal.reject drops the item, and a line that uses it is then refused with a plain reason', async () => {
    const { add, line } = await jinan();
    await invoke('proposal.reject', { id: add._id });
    expect(communities()).not.toContain('Jinan');
    await expect(invoke('proposal.approve', { id: line._id })).rejects.toThrow(
      /uses Jinan, a new item for Communities that was rejected/,
    );
    expect(bible.model.get('proposals', line._id)).toMatchObject({ state: 'pending' });
    // In the capture box, an unticked item is rejected before the line, which then stays pending.
    const again = await jinan();
    const filing = await fileCapture(invoke, [asCapture(again.line)], [asCapture(again.add)]);
    expect(filing.rejected).toEqual([again.add._id]);
    expect(filing.failed.map((f) => f.id)).toEqual([again.line._id]);
    expect(communities()).not.toContain('Jinan');
    await invoke('proposal.reject', { id: line._id });
    await invoke('proposal.reject', { id: again.line._id });
  });
});
