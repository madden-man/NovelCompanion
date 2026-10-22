import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import type { ClaudeRun } from '../../src/shared/claude';
import { recordAlignment } from '../../src/main/continuity';
import { textHash } from '../../src/shared/domain/continuity/lines';
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
let snapshotRoot: string;
let n = 0;
const runId = () => `align${Date.now()}${n++}`;

beforeAll(async () => {
  store = await localStore();
  snapshotRoot = await mkdtemp(join(tmpdir(), 'nc-m8-'));
  bible = await openBibleSession(store, (await loadBriefFixture(store, freshSlug('m8'))).id, {
    snapshotRoot,
  });
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
  await rm(snapshotRoot, { recursive: true, force: true });
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
  test('CC-1 CC-2 CC-5 the structural checks record exactly S1 and S3, and a re-run adds nothing', async () => {
    const first = await invoke('continuity.check', { chapterId: null });
    expect(first.found).toBe(2);
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
    expect(again.found).toBe(2);
    const fs = (await open()).filter((f) => f.kind === 'structural');
    expect(fs.map((f) => [f.chapterId, f.check, f.entries.map((e) => e.id)])).toEqual([
      ['CH4', 'character-present-while-dead', ['H2']],
      ['CH6', 'event-linked-as-happened-after-story-year', ['E10']],
    ]);
    expect(bible.model.all('findings').filter((f) => !f.deletedAt)).toHaveLength(2);
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
      ['title', 'Lives in Guangzhou', 'Lives in Shanghai'],
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
    // AI-5: the plot and the selected entries are material too, never loose in the prompt.
    const blocks = [
      ...req.prompt.matchAll(/<material source="([^"]*)">\n([\s\S]*?)\n<\/material>/g),
    ];
    expect(blocks.map((b) => b[1])).toEqual([
      'Stored plot for Chapter 6: The Letter [CH6]',
      'Selected entries for Chapter 6: The Letter [CH6]',
      'Chapter 6: The Letter [CH6]',
    ]);
    // SM-3: the moments arrive with the selected entries; the stored plot has no beats or facts.
    expect(blocks[0]![2]).not.toMatch(/Beat|fact/);
    expect(blocks[1]![2]).toMatch(/\[B4\] Iris finds the letter \(moments; /);
    expect(blocks[1]![2]).toMatch(/\[E3\] /);
    const outside = req.prompt.replace(/<material[\s\S]*?<\/material>/g, '');
    expect(outside).not.toMatch(/\[B4\]|\[E3\]/);
    expect(req.prompt).toContain(
      '<material source="Chapter 6: The Letter [CH6]">\n1: Iris asked her father',
    );
    expect(req.prompt).toContain(
      'Strand [CH6-present] "present" (primary): story year 2045; point of view Iris Hale-Zhou [H5] (age 14)',
    );
    // Iris's moments up to 2045 only: B5 (2050) is not given.
    expect(req.prompt).not.toContain('[B5]');
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
    const takeSnapshot = bible.repo.beforeBulk;
    bible.repo.beforeBulk = async (reason) => {
      snapshots.push(
        `${reason}:${String(bible.model.get('characters', 'H1')!.birth && (bible.model.get('characters', 'H1')!.birth as { year: number }).year)}`,
      );
      await takeSnapshot?.(reason);
    };
    const r = await invoke('continuity.resolve', {
      id: p1.id,
      action: 'manuscriptWins',
      shown: p1.shown,
    });
    bible.repo.beforeBulk = takeSnapshot;
    // A real snapshot record exists, taken before the write: it still holds the old birth year.
    const taken = (await bible.snapshots!.list()).find(
      (x) => x.reason === 'bulk' && x.label === 'manuscript wins',
    )!;
    expect(taken).toBeTruthy();
    const dumped = JSON.parse(
      await readFile(join(snapshotRoot, bible.handle.id, taken.id, 'characters.json'), 'utf8'),
    ) as { _id: string; birth?: { year: number } }[];
    expect(dumped.find((c) => c._id === 'H1')!.birth).toEqual({ year: 1958 });
    expect(r.warnings.filter((w) => w.code === 'death-before-birth')).toEqual([]);
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
    expect(bible.model.get('moments', 'Z3-lives-0')!.title).toBe('Lives in Guangzhou');
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
    // IP-18: the text changes only through the importer.
    await bible.repo.update(
      'chapters',
      'CH5',
      { manuscriptText: text.replace('Sam held', 'Sam quietly held') },
      { importer: true },
    );
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
    expect((await open('CH6')).map((f) => f.check)).toEqual([]);

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

    // AI-1: Stop ends a streaming alignment run; it is saved as stopped and records nothing.
    const waiting = new FakeClaudeClient([
      {
        name: 'waits',
        feature: 'alignment',
        steps: [{ text: '{"findings": [' }, { waitForAbort: true }],
      },
    ]);
    const rt = new ClaudeRuntime({
      client: waiting,
      keys,
      settings: new MemorySettingsStore(),
      emit: () => undefined,
    });
    rt.acknowledge(bible.handle.id);
    const h2 = claudeHandlers(() => bible, { runtime: rt, keys, catalog: new FakeModelCatalog() });
    const id = runId();
    const pending = runHandler('claude.alignment', h2['claude.alignment'], {
      runId: id,
      chapterId: 'CH5',
    });
    for (let i = 0; i < 100 && !rt.isActive(id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(rt.stop(id)).toBe(true);
    expect(await pending).toMatchObject({ status: 'stopped', found: 0 });
    expect(bible.model.all('findings').length).toBe(before);
  });
});

describe('CC-3 CC-4 ED-10 recording and resolving guards', () => {
  const synthetic = (chapterId: string, hash: string, findings: unknown[]): ClaudeRun =>
    ({
      turns: [{ id: 'synthetic', status: 'done' }],
      output: { findings },
      input: { chapterId, textHash: hash },
    }) as unknown as ClaudeRun;
  const dateFinding = {
    kind: 'date',
    lineStart: 1,
    lineEnd: 1,
    quote: 'Her mother was seventy',
    citedIds: ['H1'],
    explanation: 'The text and the bible disagree about when Margaret was born.',
    mustChange: 'The stated age must match the bible.',
    changeSet: [{ collection: 'characters', id: 'H1', field: 'birth', value: '{"year": 2100}' }],
  };
  const textOf = () => String(bible.model.get('chapters', 'CH5')!.manuscriptText);

  test('CC-3 a run records nothing, and says why, when the chapter text changed after Claude was sent it', async () => {
    const before = bible.model.all('findings').length;
    const stale = await recordAlignment(
      bible,
      'CH5',
      synthetic('CH5', textHash(`${textOf()} changed`), [dateFinding]),
      'synthetic',
    );
    expect(stale).toMatchObject({ found: 0, hidden: 0, rejected: [] });
    expect(stale.skipped).toMatch(/chapter text changed while Claude was reading/);
    expect(bible.model.all('findings').length).toBe(before);
    // A run with no hash at all is treated the same way.
    const unhashed = await recordAlignment(
      bible,
      'CH5',
      { ...synthetic('CH5', '', [dateFinding]), input: { chapterId: 'CH5' } } as ClaudeRun,
      'synthetic',
    );
    expect(unhashed.skipped).not.toBeNull();
    const ok = await recordAlignment(
      bible,
      'CH5',
      synthetic('CH5', textHash(textOf()), [dateFinding]),
      'synthetic',
    );
    expect(ok).toMatchObject({ found: 1, skipped: null });
  });

  test('CC-4 ED-3 ED-10 a stale diff is refused, Manuscript wins returns the entry warnings, and a second apply or a wrong-state action is refused', async () => {
    const f = byCheck(await open('CH5'), 'CH5', 'date');
    // The shown revision is behind an edit made since: nothing is applied.
    const oldShown = f.shown;
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H1',
      patch: { backstory: 'Edited after the diff was shown.' },
    });
    await expect(
      invoke('continuity.resolve', { id: f.id, action: 'manuscriptWins', shown: oldShown }),
    ).rejects.toThrow(/changed after this comparison was shown, so nothing was applied/);
    expect(bible.model.get('characters', 'H1')!.birth).not.toEqual({ year: 2100 });
    expect(bible.model.get('findings', f.id)!.state).toBe('open');

    const fresh = byCheck(await open('CH5'), 'CH5', 'date');
    const r = await invoke('continuity.resolve', {
      id: f.id,
      action: 'manuscriptWins',
      shown: fresh.shown,
    });
    // ED-10: Margaret dies in 2041, so a birth in 2100 carries the warning the editor would show.
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ id: 'H1', entry: 'Margaret Hale', code: 'death-before-birth' }),
    );
    // Applied once: a second apply, a dismiss, a rewrite, and a Done are all refused.
    for (const action of ['manuscriptWins', 'dismiss', 'rewrite', 'done'] as const) {
      await expect(invoke('continuity.resolve', { id: f.id, action })).rejects.toThrow(
        /already updated|not a rewrite task/,
      );
    }
    expect(bible.model.get('findings', f.id)!.state).toBe('manuscriptWins');
  });

  test('CC-4 Done only works on a rewrite task, and a dismissed or rewrite finding cannot be applied', async () => {
    const p2 = byCheck(await open('CH7'), 'CH7', 'place');
    expect(p2.state).toBe('rewrite');
    await expect(
      invoke('continuity.resolve', { id: p2.id, action: 'manuscriptWins' }),
    ).rejects.toThrow(/already a rewrite task/);
    await expect(invoke('continuity.resolve', { id: p2.id, action: 'rewrite' })).rejects.toThrow(
      /already a rewrite task/,
    );
    const done = await invoke('continuity.resolve', { id: p2.id, action: 'done' });
    expect(done.finding.state).toBe('dismissed');
    await expect(invoke('continuity.resolve', { id: p2.id, action: 'done' })).rejects.toThrow(
      /not a rewrite task/,
    );
    await expect(
      invoke('continuity.resolve', { id: p2.id, action: 'manuscriptWins' }),
    ).rejects.toThrow(/already dismissed/);
  });
});
