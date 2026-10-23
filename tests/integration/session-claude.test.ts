import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import { FakeClaudeClient, loadRecordings } from '../../src/main/claude/fake';
import { MemoryKeyStore } from '../../src/main/claude/keys';
import { MemorySettingsStore } from '../../src/main/claude/settings';
import { PROSE_PROHIBITION } from '../../src/main/claude/prompts';
import { RunStore } from '../../src/main/claude/store';
import { runtimeSessionClaude } from '../../src/main/claude/session';
import type { ClaudeStreamEvent } from '../../src/shared/claude';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import type { Invoke } from '../helpers/t5';

/**
 * M7's Claude seam wired to M6's runtime (integration step): chapter
 * summaries run as recorded feature runs (T-3, no API call), over a chapter
 * read from a Word file.
 */

const ROOT = join(import.meta.dirname, '../..');
const KEY = 'sk-ant-api03-integration-test-key-0123456789abcdef';

let store: Store;
let bible: OpenBible;
let invoke: Invoke;
let fake: FakeClaudeClient;
let keys: MemoryKeyStore;
let settings: MemorySettingsStore;
let runtime: ClaudeRuntime;
const events: ClaudeStreamEvent[] = [];

let n = 0;
const runId = () => `summary${Date.now()}${n++}`.padEnd(16, '0');

async function chapterDoc(last: string): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'The Letter', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('Iris found the envelope under the '),
              new TextRun({ text: 'attic', italics: true }),
              new TextRun(' boards.'),
            ],
          }),
          new Paragraph({ text: '* * *' }),
          new Paragraph({ text: last }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

beforeAll(async () => {
  store = await localStore();
  const { id } = await loadBriefFixture(store, freshSlug('m7claude'));
  bible = await openBibleSession(store, id);
  fake = new FakeClaudeClient(loadRecordings(join(ROOT, 'fixtures/claude/recordings.json')));
  keys = new MemoryKeyStore(KEY);
  settings = new MemorySettingsStore();
  runtime = new ClaudeRuntime({ client: fake, keys, settings, emit: (e) => events.push(e) });
  runtime.acknowledge(bible.handle.id);

  // MS-1: CH6's text comes from a Word file, so the summary has the chapter to read.
  const path = join(mkdtempSync(join(tmpdir(), 'nc-m7claude-')), 'Chapter 6 The Letter.docx');
  writeFileSync(path, await chapterDoc('Daniel said nothing at dinner.'));
  const claude = runtimeSessionClaude(runtime, () => bible, keys);
  invoke = ipcFor(() => bible, { claude: () => claude, pickFile: async () => path });
  const read = await invoke('manuscript.read', { chapterId: 'CH6', sourceId: 'word' });
  await invoke('manuscript.apply', {
    token: read.token!,
    baseModifiedAt: String(bible.model.get('chapters', 'CH6')!.modifiedAt),
  });
});
afterAll(async () => {
  await store.close();
});

const finished = (id: string) => events.find((e) => e.runId === id && e.kind === 'finished');

describe('ARCH-4 a rejected key sends the writer to Settings', () => {
  test('ARCH-4 AI-7 a key Anthropic rejects says so in the summary note, and asks for the Settings link', async () => {
    const badKeys = new MemoryKeyStore(KEY);
    const rejecting = new ClaudeRuntime({
      client: new FakeClaudeClient([
        { name: 'rejected summary', feature: 'summaries', steps: [{ fail: 'badKey' }] },
      ]),
      keys: badKeys,
      settings: new MemorySettingsStore(),
      emit: () => undefined,
    });
    rejecting.acknowledge(bible.handle.id);
    const bad = ipcFor(() => bible, {
      claude: () => runtimeSessionClaude(rejecting, () => bible, badKeys),
    });
    const sum = await bad('chapter.summarize', { chapterId: 'CH6' });
    expect(sum.message).toMatch(/rejected the stored API key/);
    expect(sum.needsSettings).toBe(true);
  });
});

describe('MS-2 a chapter summary through the Claude runtime', () => {
  test('MS-2 AI-1 AI-5 the summary is drafted from the chapter text as material, saved as a summaries run, and nothing is saved to the chapter', async () => {
    const before = bible.model.get('chapters', 'CH6')!.summary;
    const id = runId();
    const r = await invoke('chapter.summarize', { chapterId: 'CH6', runId: id });
    expect(r).toMatchObject({
      available: true,
      draft: 'Iris finds an envelope under the attic boards. Daniel says nothing at dinner.',
      model: 'claude-sonnet-5-5',
      message: null,
    });
    expect(bible.model.get('chapters', 'CH6')!.summary).toBe(before);
    const req = fake.requests.at(-1)!;
    expect(req.feature).toBe('summaries');
    expect(req.system).toContain(PROSE_PROHIBITION);
    expect(req.prompt).toContain('<material source="The Letter">');
    expect(req.prompt).toContain('Iris found the envelope under the attic boards.');
    expect(finished(id)).toMatchObject({ status: 'done' });
    const run = new RunStore(bible).list('summaries').find((x) => x.turns[0]?.id === id)!;
    expect(run.turns[0]!.entries).toEqual([
      { collection: 'chapters', id: 'CH6', title: 'The Letter' },
    ]);
  });
});

describe('AI-1 a chapter summary streams and can be stopped', () => {
  test('AI-1 MS-2 the summary streams its text under the run ID, and Stop ends it with nothing saved to the chapter', async () => {
    const slowEvents: ClaudeStreamEvent[] = [];
    const slowKeys = new MemoryKeyStore(KEY);
    const slow = new ClaudeRuntime({
      client: new FakeClaudeClient(
        loadRecordings(join(ROOT, 'fixtures/claude/recordings.json')),
        400,
      ),
      keys: slowKeys,
      settings: new MemorySettingsStore(),
      emit: (e) => slowEvents.push(e),
    });
    slow.acknowledge(bible.handle.id);
    const slowInvoke = ipcFor(() => bible, {
      claude: () => runtimeSessionClaude(slow, () => bible, slowKeys),
    });
    const before = bible.model.get('chapters', 'CH6')!.summary;
    const id = runId();
    const started = slowInvoke('chapter.summarize', { chapterId: 'CH6', runId: id });
    for (let i = 0; i < 300 && !slowEvents.some((e) => e.runId === id && e.kind === 'text'); i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(slowEvents.some((e) => e.runId === id && e.kind === 'text')).toBe(true);
    expect(slow.stop(id)).toBe(true);
    const r = await started;
    expect(r.draft).toBe('');
    expect(r.message).toMatch(/you stopped it/);
    expect(r.needsSettings).toBe(false);
    expect(slowEvents.find((e) => e.runId === id && e.kind === 'finished')).toMatchObject({
      status: 'stopped',
    });
    expect(bible.model.get('chapters', 'CH6')!.summary).toBe(before);
  });
});

describe('AI-1 a Stop that arrives before the run starts is not lost', () => {
  test('AI-1 stopping a run ID the runtime has not seen yet ends the run at once when it does start', async () => {
    const id = runId();
    expect(runtime.stop(id)).toBe(false);
    const r = await invoke('chapter.summarize', { chapterId: 'CH6', runId: id });
    expect(r.draft).toBe('');
    expect(r.message).toMatch(/you stopped it/);
    expect(finished(id)).toMatchObject({ status: 'stopped' });
    expect(events.some((e) => e.runId === id && e.kind === 'text')).toBe(false);
    // Only that ID was stopped: the next run is untouched.
    const next = await invoke('chapter.summarize', { chapterId: 'CH6' });
    expect(next.draft).not.toBe('');
  });
});
