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
import { MATERIAL_RULE, PROSE_PROHIBITION } from '../../src/main/claude/prompts';
import { RunStore } from '../../src/main/claude/store';
import { runtimeSessionClaude } from '../../src/main/claude/session';
import { DriveService } from '../../src/main/drive/service';
import { endpointsAt } from '../../src/main/drive/oauth';
import { memoryStore } from '../../src/main/drive/secrets';
import { gdocSource } from '../../src/main/session/sources';
import { missingLeadSections } from '../../src/shared/domain/brief/render';
import type { ClaudeStreamEvent } from '../../src/shared/claude';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import { startFakeGoogle } from '../helpers/fakeGoogle';
import type { FakeGoogle } from '../helpers/fakeGoogle';
import type { Invoke } from '../helpers/t5';

/**
 * M7's Claude seam wired to M6's runtime (integration step): briefs and
 * chapter summaries run as recorded feature runs (T-3, no API call), and
 * chapters are read from a Google Doc through M9's Drive service against the
 * fake Google.
 */

const ROOT = join(import.meta.dirname, '../..');
const KEY = 'sk-ant-api03-integration-test-key-0123456789abcdef';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';

let store: Store;
let bible: OpenBible;
let invoke: Invoke;
let fake: FakeClaudeClient;
let keys: MemoryKeyStore;
let settings: MemorySettingsStore;
let runtime: ClaudeRuntime;
let google: FakeGoogle;
let drive: DriveService;
const events: ClaudeStreamEvent[] = [];

let n = 0;
const runId = () => `brief${Date.now()}${n++}`.padEnd(16, '0');

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

  google = await startFakeGoogle({ email: 'tommy@example.com' });
  google.addFile({
    id: 'gdocCh6',
    name: 'Chapter 6 The Letter',
    mimeType: GDOC,
    content: await chapterDoc('Daniel said nothing at dinner.'),
  });
  google.addFile({ id: 'sheetWorld', name: 'World', mimeType: GSHEET, content: Buffer.from('x') });
  drive = new DriveService({
    secrets: memoryStore(),
    endpoints: endpointsAt(google.base),
    openBrowser: async (url) => void (await fetch(url)),
    authTimeoutMs: 5000,
  });
  drive.setClient(google.clientId, google.clientSecret);
  await drive.connect();

  const claude = runtimeSessionClaude(runtime, () => bible, keys);
  invoke = ipcFor(() => bible, {
    claude: () => claude,
    sources: [gdocSource((fileId) => drive.fetchFile(fileId))],
    now: () => new Date(2026, 9, 11, 9, 30),
  });
});
afterAll(async () => {
  await google?.close();
  await store.close();
});

const finished = (id: string) => events.find((e) => e.runId === id && e.kind === 'finished');

describe('SB-4 DB-2 DB-4 AI-1 briefs through the Claude runtime', () => {
  test('SB-4 DB-2 DB-4 AI-1 AI-4 AI-5 the brief is synthesized from the manifest only, opens with the three lead sections, streams, and is saved as a briefs run', async () => {
    const id = runId();
    const r = await invoke('session.start', {
      input: { kind: 'chapter', chapterId: 'CH6' },
      runId: id,
    });
    expect(r.synthesized).toBe(true);
    expect(r.note).toBeNull();
    expect(r.problems).toEqual([]);
    expect(r.uncited).toEqual([]);
    const brief = bible.model.get('briefs', r.brief._id)!;
    expect(brief.model).toBe('claude-opus-5-5');
    const content = String(brief.content);
    expect(missingLeadSections(content)).toEqual([]);
    const headings = content.split('\n').filter((l) => l.startsWith('## '));
    expect(headings.slice(0, 3)).toEqual([
      '## 1. Characters and their ages',
      '## 2. World events ongoing',
      '## 3. Cultural expectations',
    ]);
    // SB-5: canon and planned apart; the 2072 event only under Planned ahead.
    expect(content).toContain('Canon:');
    expect(content).toContain('Planned or idea:');
    const ahead = content.indexOf('## Planned ahead (after 2045)');
    expect(ahead).toBeGreaterThan(0);
    expect(content.indexOf('[[E9]]')).toBeGreaterThan(ahead);
    // A24: the recorded "Decided: Iris is left-handed" is under a code-written Decided block, after the open ones.
    const decidedAt = content.indexOf('### Decided');
    expect(decidedAt).toBeGreaterThan(0);
    expect(content.indexOf('Decided: Iris is left-handed.')).toBeGreaterThan(decidedAt);
    expect(content.indexOf('Open: does Daniel know')).toBeLessThan(decidedAt);

    // The request: the brief model, the AI-4 and AI-5 rules, no tools, the material wrapped,
    // and nothing in it but entries of the manifest.
    const req = fake.requests.at(-1)!;
    expect(req.feature).toBe('briefs');
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.system).toContain(PROSE_PROHIBITION);
    expect(req.system).toContain(MATERIAL_RULE);
    expect(req.tools).toEqual([]);
    expect(req.outputSchema).toBeTruthy();
    expect(req.prompt).toContain('<material source="session selection">');
    const given = [...req.prompt.matchAll(/^\[([A-Za-z0-9_-]+)\] /gm)].map((m) => m[1]);
    expect(given.length).toBeGreaterThan(0);
    for (const g of given) expect(brief.entryIds).toContain(g);

    // AI-1: it streamed under the renderer's run ID and is saved with its feature.
    expect(events.some((e) => e.runId === id && e.kind === 'text')).toBe(true);
    expect(finished(id)).toMatchObject({ status: 'done' });
    const run = new RunStore(bible).list('briefs').find((x) => x.turns[0]?.id === id)!;
    expect(run.feature).toBe('briefs');
    expect(run.title).toBe('Brief for Chapter 6: The Letter');
    expect((run.input as { manifest: string[] }).manifest).toEqual(brief.entryIds);
    expect(run.output).toBeTruthy();
    // AI-2: the run lists the entries it was given, each in the manifest.
    const material = (run.input as { material: { id: string }[] }).material;
    expect(run.turns[0]!.entries.map((e) => e.id).sort()).toEqual(
      [...new Set(material.map((m) => m.id))].sort(),
    );
    for (const e of run.turns[0]!.entries) expect(brief.entryIds).toContain(e.id);
  });

  test('SB-4 SB-5 code flags an uncited line and a foreign citation, keeps planned material out of canon, and moves a later event under Planned ahead', async () => {
    const r = await invoke('session.start', {
      input: { kind: 'chapter', chapterId: 'CH2' },
      runId: runId(),
    });
    expect(r.synthesized).toBe(true);
    expect(r.uncited).toEqual(['Daniel has always hated rain.']);
    expect(r.problems).toEqual(['Z2']);
    const content = String(bible.model.get('briefs', r.brief._id)!.content);
    // Two strands, primary first (A5).
    expect(content).toContain('### present, 2045 (primary)');
    expect(content).toContain('### backstory, 2032');
    // ERA-2030 is planned in the bible, so its line is not canon, whatever Claude said.
    const era = content.split('\n').findIndex((l) => l.includes('[[ERA-2030]]'));
    const before = content.split('\n').slice(0, era).reverse();
    expect(before.find((l) => l === 'Canon:' || l === 'Planned or idea:')).toBe('Planned or idea:');
    // E9 (2072) was put among world events; it lands under Planned ahead.
    const ahead = content.indexOf('## Planned ahead (after 2045)');
    expect(ahead).toBeGreaterThan(0);
    expect(content.indexOf('[[E9]]')).toBeGreaterThan(ahead);
  });

  test('DB-4 the brief model is the briefs setting, the same key the settings screen writes', async () => {
    runtime.setModel('briefs', 'claude-sonnet-5-5', bible.handle.id);
    try {
      expect((await invoke('brief.settings.get', {})).model).toBe('claude-sonnet-5-5');
      const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
      expect(bible.model.get('briefs', r.brief._id)!.model).toBe('claude-sonnet-5-5');
      expect(fake.requests.at(-1)!.model).toBe('claude-sonnet-5-5');
    } finally {
      runtime.setModel('briefs', 'claude-opus-5-5', bible.handle.id);
    }
  });

  test('AI-1 SB-7 stopping a brief keeps the run as stopped and saves the structured brief', async () => {
    const id = runId();
    const started = invoke('session.start', {
      input: { kind: 'chapter', chapterId: 'CH5' },
      runId: id,
    });
    for (let i = 0; i < 200 && !events.some((e) => e.runId === id && e.kind === 'text'); i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(runtime.stop(id)).toBe(true);
    const r = await started;
    expect(r.synthesized).toBe(false);
    expect(r.note).toMatch(/Claude could not write the brief \(you stopped it\)/);
    expect(String(bible.model.get('briefs', r.brief._id)!.content)).toContain(
      'The selected entries, with no synthesis.',
    );
    expect(finished(id)).toMatchObject({ status: 'stopped' });
    const run = new RunStore(bible).list('briefs').find((x) => x.turns[0]?.id === id)!;
    expect(run.turns[0]!.status).toBe('stopped');
  });

  test('ARCH-4 SB-7 with no key stored Claude is unavailable and the brief is the structured one', async () => {
    keys.clear();
    try {
      expect((await invoke('brief.settings.get', {})).claudeAvailable).toBe(false);
      const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
      expect(r.synthesized).toBe(false);
      expect((await invoke('chapter.summarize', { chapterId: 'CH6' })).available).toBe(false);
    } finally {
      keys.set(KEY);
    }
    expect((await invoke('brief.settings.get', {})).claudeAvailable).toBe(true);
  });
});

describe('MS-1 MS-4 MS-5 a chapter from a Google Doc', () => {
  test('MS-1 the Google Docs source is offered, picked in the Drive browser, and keeps italics and scene breaks', async () => {
    expect((await invoke('manuscript.sources', {})).sources).toEqual([
      { id: 'gdoc', label: 'Google Doc', picker: 'drive' },
    ]);
    // Nothing chosen in the browser: nothing read.
    expect(
      (await invoke('manuscript.read', { chapterId: 'CH6', sourceId: 'gdoc' })).token,
    ).toBeNull();
    const r = await invoke('manuscript.read', {
      chapterId: 'CH6',
      sourceId: 'gdoc',
      locator: 'gdocCh6',
    });
    expect(r.name).toBe('Chapter 6 The Letter (Google Doc)');
    expect(r.source).toBe('gdoc:gdocCh6');
    expect(r.body).toContain('<em>attic</em>');
    expect(r.body).toContain('<hr>');
    expect(r.changed).toBe(true);
    const ch = bible.model.get('chapters', 'CH6')!;
    const applied = await invoke('manuscript.apply', {
      token: r.token!,
      baseModifiedAt: String(ch.modifiedAt),
    });
    expect(applied.entry.manuscriptSource).toBe('gdoc:gdocCh6');
    expect(applied.entry.sourceFile).toBe('Chapter 6 The Letter (Google Doc)');
  });

  test('MS-4 the Doc changes in Drive; reading the linked Doc again shows the diff and marks the summary', async () => {
    google.touch('gdocCh6', undefined, await chapterDoc('Daniel left the table before dessert.'));
    const r = await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(r.diff.filter((d) => d.kind === 'removed').map((d) => d.text)).toEqual([
      'Daniel said nothing at dinner.',
    ]);
    expect(r.diff.filter((d) => d.kind === 'added').map((d) => d.text)).toEqual([
      'Daniel left the table before dessert.',
    ]);
    expect(r.summaryOutOfDate).toBe(true);
  });

  test('MS-1 a Drive file that is not a document is refused', async () => {
    await expect(
      invoke('manuscript.read', { chapterId: 'CH6', sourceId: 'gdoc', locator: 'sheetWorld' }),
    ).rejects.toThrow(/not a Google Doc or a Word file/);
  });

  test('MS-5 reading a Google Doc only reads: no write ever reaches Drive', () => {
    const writes = google.calls.filter(
      (c) => /^(POST|PATCH|PUT|DELETE) /.test(c) && c.includes('/drive/'),
    );
    expect(writes).toEqual([]);
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
