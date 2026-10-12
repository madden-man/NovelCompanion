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
import { RunStore } from '../../src/main/claude/store';
import { PROSE_PROHIBITION } from '../../src/main/claude/prompts';
import { resolutionCommand } from '../../src/shared/domain/continuity/findings';
import { UndoManager } from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import type { EntryCollection } from '../../src/shared/schema';
import type { Request, Response } from '../../src/shared/ipc';
import type { FindingWire } from '../../src/shared/ipcContinuity';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import type { Invoke } from '../helpers/t5';

const ROOT = join(import.meta.dirname, '../..');
const RECORDINGS = loadRecordings(join(ROOT, 'fixtures/claude/recordings.json'));

let store: Store;
let bible: OpenBible;
let invoke: Invoke;
let fake: FakeClaudeClient;
let claude: <C extends ClaudeChannel>(channel: C, req: Request<C>) => Promise<Response<C>>;
let n = 0;
const runId = () => `align${Date.now()}${n++}`;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await loadBriefFixture(store, freshSlug('m8'))).id);
  invoke = ipcFor(() => bible);
  fake = new FakeClaudeClient(RECORDINGS);
  const keys = new MemoryKeyStore('sk-ant-api03-integration-test-key-0123456789abcdef');
  const runtime = new ClaudeRuntime({
    client: fake,
    keys,
    settings: new MemorySettingsStore(),
    emit: () => undefined,
  });
  runtime.acknowledge(bible.handle.id);
  const handlers = claudeHandlers(() => bible, { runtime, keys, catalog: new FakeModelCatalog() });
  claude = async (channel, req) =>
    JSON.parse(
      JSON.stringify(
        await runHandler(channel, handlers[channel] as unknown as Handler<typeof channel>, req),
      ),
    );
});
afterAll(async () => {
  await store.close();
});

/** What the dashboard and the alignment screen do: structural checks, then Claude on each chapter with text. */
async function checkAll(chapterId: string | null = null) {
  const s = await invoke('continuity.check', { chapterId });
  const runs = [];
  for (const c of s.chapters.filter((x) => x.lines > 0)) {
    runs.push({
      chapterId: c.id,
      ...(await claude('claude.alignment', { runId: runId(), chapterId: c.id })),
    });
  }
  return { structural: s, runs };
}

const open = async (chapterId: string | null = null) =>
  (await invoke('continuity.findings', { chapterId })).findings;
const byCheck = (fs: FindingWire[], chapterId: string, check: string) =>
  fs.find((f) => f.chapterId === chapterId && f.check === check)!;

describe('CC-1 CC-2 CC-3 a whole-manuscript run with the recorded Claude', () => {
  test('CC-1 CC-2 CC-5 the structural checks record exactly S1, S2, S3, and a re-run adds nothing', async () => {
    const first = await invoke('continuity.check', { chapterId: null });
    expect(first.found).toBe(3);
    expect(first.chapters.map((c) => c.id)).toEqual([
      'CH1',
      'CH2',
      'CH3',
      'CH4',
      'CH5',
      'CH6',
      'CH7',
      'CH8',
    ]);
    const again = await invoke('continuity.check', { chapterId: null });
    expect(again.found).toBe(3);
    const fs = (await open()).filter((f) => f.kind === 'structural');
    expect(fs.map((f) => [f.chapterId, f.check, f.entries.map((e) => e.id)])).toEqual([
      ['CH4', 'character-present-while-dead', ['H2']],
      ['CH6', 'fact-acted-on-before-learned', ['H5', 'F2', 'K2']],
      ['CH6', 'event-linked-as-happened-after-story-year', ['E10']],
    ]);
    expect(bible.model.all('findings').filter((f) => !f.deletedAt)).toHaveLength(3);
  });

  test('CC-1 CC-3 every chapter with text is read by Claude; the recorded P1 and P2 are stored with lines, quote, citation, kind, explanation, and change set', async () => {
    const { runs } = await checkAll();
    expect(runs.map((r) => [r.chapterId, r.status])).toEqual(
      ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8'].map((id) => [id, 'done']),
    );
    const fs = await open();
    const p1 = byCheck(fs, 'CH5', 'age');
    expect(p1).toMatchObject({
      kind: 'alignment',
      label: 'Age',
      lineStart: 1,
      lineEnd: 1,
      lines: [
        {
          n: 1,
          text: 'Ruth counted the candles twice. Her mother was seventy and still refused to let anyone else light them.',
        },
      ],
      entries: [{ collection: 'characters', id: 'H1', title: 'Margaret Hale', found: true }],
      state: 'open',
      changes: [
        {
          collection: 'characters',
          id: 'H1',
          field: 'birth',
          label: 'Birth',
          before: '1958',
          after: '1970',
        },
      ],
    });
    expect(p1.text).toMatch(/seventy.*82/);
    expect(p1.mustChange).toMatch(/82/);
    const p2 = byCheck(fs, 'CH7', 'place');
    expect(p2).toMatchObject({ lineStart: 1, entries: [{ id: 'Z3' }] });
    expect(p2.lines[0]!.text).toMatch(/^Lan had grown up in Shanghai/);
    // CC-3: the change to a real field is kept; the one to a field that does not exist is shown, never applied.
    expect(p2.changes.map((c) => [c.field, c.before, c.after])).toEqual([
      ['birthplace', 'Guangzhou', 'Shanghai'],
    ]);
    expect(p2.rejectedChanges).toEqual([
      {
        summary: 'characters Z3 hometown: "Shanghai"',
        reason: 'hometown is not a field of characters',
      },
    ]);
    // CC-3: a finding citing an ID that is not in the bible is refused and reported.
    const ch7 = runs.find((r) => r.chapterId === 'CH7')!;
    expect(ch7.found).toBe(1);
    expect(ch7.rejected).toEqual([
      {
        summary: 'Other: A character the bible does not hold.',
        reason: 'It cites Z9, which is not in the bible.',
      },
    ]);
    expect(fs.filter((f) => f.kind === 'alignment')).toHaveLength(2);
  });

  test('CC-3 DB-4 AI-1 AI-5 each run reads the numbered text as material with the selection and the stored plot, on Opus, and is saved', async () => {
    const req = fake.requests.find(
      (r) =>
        r.feature === 'alignment' &&
        r.prompt.includes('<material source="Chapter 6: The Letter [CH6]">'),
    )!;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.system).toContain(PROSE_PROHIBITION);
    expect(req.tools).toEqual([]);
    expect(req.prompt).toContain(
      '<material source="Chapter 6: The Letter [CH6]">\n1: Iris asked her father',
    );
    expect(req.prompt).toContain(
      'Strand [CH6-present] "present" (primary): story year 2045; point of view Iris Hale-Zhou [H5] (age 14)',
    );
    expect(req.prompt).toContain('acts on fact [F2]');
    expect(req.prompt).toContain('knowledge record [K2] says they learn it in 2060');
    expect(req.prompt).toContain(
      'Beats planned for this chapter:\n- Beat [B4] (2045, chapter CH6)',
    );
    // Beats in its arcs dated at or before 2045, and none after.
    expect(req.prompt).toContain('- Beat [B1] (2029)');
    expect(req.prompt).not.toContain('Beat [B5]');
    expect(req.prompt).toContain('6. The Letter [CH6], 2045 (this chapter)');
    // The M7 selection for the chapter (SB-2).
    expect(req.prompt).toMatch(/\[E3\] .*\(worldEvents; /);
    const runs = new RunStore(bible).list('alignment');
    expect(runs.length).toBeGreaterThanOrEqual(8);
    expect(
      runs[0]!.turns[0]!.entries.some((e) => e.id === 'CH6' || e.collection === 'chapters'),
    ).toBe(true);
  });
});

describe('CC-4 the three resolutions', () => {
  test('CC-4 ED-3 Manuscript wins applies the whole change set after a snapshot in one transaction, with revisions, and undoes from the stack', async () => {
    const p1 = byCheck(await open('CH5'), 'CH5', 'age');
    const snapshots: string[] = [];
    bible.repo.beforeBulk = async (reason) => {
      snapshots.push(
        `${reason}:${String(bible.model.get('characters', 'H1')!.birth && (bible.model.get('characters', 'H1')!.birth as { year: number }).year)}`,
      );
    };
    const r = await invoke('continuity.resolve', { id: p1.id, action: 'manuscriptWins' });
    bible.repo.beforeBulk = null;
    // The snapshot is taken before anything is written.
    expect(snapshots).toEqual(['manuscript wins:1958']);
    expect(bible.model.get('characters', 'H1')!.birth).toEqual({ year: 1970 });
    expect(r.finding.state).toBe('manuscriptWins');
    const revs = await bible.repo.revisions('characters', 'H1');
    expect(revs.at(-1)).toMatchObject({
      op: 'update',
      note: 'Manuscript wins: Age: The text calls Margaret seventy. The bible has her born in 1958, so in 2040 she is 82.',
    });
    const findingRev = (await bible.repo.revisions('findings', p1.id)).at(-1)!;
    expect(findingRev.note).toBe(revs.at(-1)!.note);

    const undo = new UndoManager();
    undo.record(
      resolutionCommand(
        'Manuscript wins',
        r.changes.map((c) => ({ ...c, collection: c.collection as EntryCollection })),
      ),
    );
    const io = undoIO(invoke);
    expect(await undo.step('undo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('characters', 'H1')!.birth).toEqual({ year: 1958 });
    expect(bible.model.get('findings', p1.id)!.state).toBe('open');
    expect(await undo.step('redo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('characters', 'H1')!.birth).toEqual({ year: 1970 });
    expect(await undo.step('undo', io)).toMatchObject({ status: 'applied' });
    expect(bible.model.get('characters', 'H1')!.birth).toEqual({ year: 1958 });
  });

  test('CC-4 AI-4 Rewrite recommended makes a rewrite task with chapter, lines, quoted lines, and what must change, and no prose; it shows on the dashboard and the chapter', async () => {
    const p2 = byCheck(await open('CH7'), 'CH7', 'place');
    const r = await invoke('continuity.resolve', { id: p2.id, action: 'rewrite' });
    expect(r.finding).toMatchObject({
      state: 'rewrite',
      chapter: 'Rain in Guangzhou',
      lineStart: 1,
      lineEnd: 1,
      mustChange: 'The city Lan grew up in must be Guangzhou, as the bible records.',
    });
    expect(r.finding.lines[0]!.text).toMatch(/grown up in Shanghai/);
    // Nothing in the bible changed but the finding.
    expect(bible.model.get('characters', 'Z3')!.birthplace).toBe('Guangzhou');
    const stored = bible.model.get('findings', p2.id)!;
    expect(
      Object.keys(stored).filter((k) => /suggest|replace|prose|draft|rewritten|newText/i.test(k)),
    ).toEqual([]);
    const tasks = (await invoke('continuity.findings', { chapterId: 'CH7', states: ['rewrite'] }))
      .findings;
    expect(tasks.map((t) => t.id)).toEqual([p2.id]);
    const d = await invoke('dashboard.get', {});
    expect(d.rewriteTasks).toContainEqual(
      expect.objectContaining({
        id: p2.id,
        chapterId: 'CH7',
        lines: 'line 1',
        quote: expect.stringMatching(/Shanghai/),
      }),
    );
    // A re-run leaves the task as it is and adds no duplicate.
    await claude('claude.alignment', { runId: runId(), chapterId: 'CH7' });
    expect(
      (await open('CH7')).filter((f) => f.kind === 'alignment').map((f) => [f.id, f.state]),
    ).toEqual([[p2.id, 'rewrite']]);
  });

  test('CC-4 Dismiss hides a structural finding across re-runs until a cited entry changes', async () => {
    const s1 = byCheck(await open('CH4'), 'CH4', 'character-present-while-dead');
    await invoke('continuity.resolve', { id: s1.id, action: 'dismiss' });
    const again = await invoke('continuity.check', { chapterId: null });
    expect(again.hidden).toBe(1);
    const listed = await invoke('continuity.findings', { chapterId: 'CH4' });
    expect(listed.findings.map((f) => f.id)).not.toContain(s1.id);
    expect(listed.dismissed).toBe(1);
    // An edit to the cited entry (Peter Hale) brings it back as open.
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H2',
      patch: { backstory: 'Edited after the dismissal.' },
    });
    const back = await invoke('continuity.check', { chapterId: 'CH4' });
    expect(back.hidden).toBe(0);
    expect(byCheck(await open('CH4'), 'CH4', 'character-present-while-dead')).toMatchObject({
      id: s1.id,
      state: 'open',
    });
  });

  test('CC-4 Dismiss hides an alignment finding across re-runs until the chapter text changes', async () => {
    const p1 = byCheck(await open('CH5'), 'CH5', 'age');
    await invoke('continuity.resolve', { id: p1.id, action: 'dismiss' });
    const rerun = await claude('claude.alignment', { runId: runId(), chapterId: 'CH5' });
    expect(rerun).toMatchObject({ status: 'done', found: 1, hidden: 1 });
    expect((await open('CH5')).map((f) => f.id)).not.toContain(p1.id);
    const text = String(bible.model.get('chapters', 'CH5')!.manuscriptText);
    await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH5',
      patch: { manuscriptText: text.replace('Sam held', 'Sam quietly held') },
    });
    const after = await claude('claude.alignment', { runId: runId(), chapterId: 'CH5' });
    expect(after.hidden).toBe(0);
    expect(byCheck(await open('CH5'), 'CH5', 'age')).toMatchObject({ id: p1.id, state: 'open' });
  });

  test('CC-2 CC-4 an open finding the bible no longer conflicts with goes to the trash on the next run; a stopped or failed run records nothing', async () => {
    const s3 = byCheck(await open('CH6'), 'CH6', 'event-linked-as-happened-after-story-year');
    await invoke('entry.update', {
      collection: 'worldEvents',
      id: 'E10',
      patch: { start: { year: 2044 } },
    });
    await invoke('continuity.check', { chapterId: 'CH6' });
    expect(bible.model.get('findings', s3.id)!.deletedAt).toBeTruthy();
    expect((await open('CH6')).map((f) => f.check)).toEqual(['fact-acted-on-before-learned']);

    const before = bible.model.all('findings').length;
    const failing = new FakeClaudeClient([
      { name: 'fails', feature: 'alignment', steps: [{ fail: 'network' }] },
    ]);
    const keys = new MemoryKeyStore('sk-ant-api03-integration-test-key-0123456789abcdef');
    const runtime = new ClaudeRuntime({
      client: failing,
      keys,
      settings: new MemorySettingsStore(),
      emit: () => undefined,
    });
    runtime.acknowledge(bible.handle.id);
    const h = claudeHandlers(() => bible, { runtime, keys, catalog: new FakeModelCatalog() });
    const res = await runHandler('claude.alignment', h['claude.alignment'], {
      runId: runId(),
      chapterId: 'CH5',
    });
    expect(res).toMatchObject({ status: 'failed', error: { kind: 'network' }, found: 0 });
    expect(bible.model.all('findings').length).toBe(before);
  });
});
