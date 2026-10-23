import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { fakeSessionClaude } from '../../src/main/session/claude';
import type { SessionClaude } from '../../src/main/session/claude';
import { selectForSession } from '../../src/shared/domain/brief/selection';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
let claude: SessionClaude = { summaries: null };
let picked: string | null = null;
const outDir = mkdtempSync(join(tmpdir(), 'nc-m7-'));
let invoke: Invoke;

// fixtures/expected/sb2-selection.json, the CH6 case with the supplement (SM-3: B4 is Iris's moment).
const CH6_IDS = [
  'B4',
  'CH1',
  'CH3',
  'CH4',
  'CH5',
  'CH6',
  'CU4',
  'E1',
  'E3',
  'E5',
  'ERA-2040',
  'GL1',
  'GL3',
  'H3',
  'H5',
  'PLC2',
  'Q1',
  'Q2',
  'Q4',
];

beforeAll(async () => {
  store = await localStore();
  const { id } = await loadBriefFixture(store, freshSlug('m7'));
  bible = await openBibleSession(store, id);
  invoke = ipcFor(() => bible, {
    claude: () => claude,
    pickFile: async () => picked,
  });
});
afterAll(async () => {
  await store.close();
});

describe('SB-2 SB-3 the selection over IPC, from the read model', () => {
  test('SB-2 SB-3 session.relevant for CH6 gives the hand-written manifest, identical on every call', async () => {
    const a = await invoke('session.relevant', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(a.selection.ids).toEqual(CH6_IDS);
    const b = await invoke('session.relevant', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(b).toEqual(a);
    // The view and the alignment check share one implementation: the pure function on the read model.
    expect(a.selection).toEqual(
      JSON.parse(
        JSON.stringify(selectForSession(bible.model, { kind: 'chapter', chapterId: 'CH6' })),
      ),
    );
  });

  test('SB-6 SB-2 the window and the budget are settings that change the selection', async () => {
    expect(await invoke('brief.settings.get', {})).toEqual({ window: 3, budget: 40_000 });
    try {
      await invoke('brief.settings.set', { budget: 0 });
      const tight = await invoke('session.relevant', {
        input: { kind: 'chapter', chapterId: 'CH6' },
      });
      // A25: the lead sections stay, and the selection is over budget.
      expect(tight.selection.ids).toEqual(['CH6', 'CU4', 'E1', 'E3', 'E5', 'H3', 'H5']);
      expect(tight.selection.overBudget).toBe(true);
      expect(tight.selection.omitted[0]).toMatchObject({ id: 'Q2', reason: 'budget' });
      await invoke('brief.settings.set', { budget: 40_000, window: 3 });
      const narrow = await invoke('session.relevant', {
        input: { kind: 'chapter', chapterId: 'CH6' },
      });
      const win = narrow.selection.strands[0]!.groups.find((g) => g.kind === 'eventsWindow')!;
      expect(win.items.map((i) => i.id)).toEqual(['E5']);
    } finally {
      // Restore the defaults even when an assertion fails, so later tests do not inherit a budget of 0.
      await invoke('brief.settings.set', { budget: 40_000, window: 3 });
    }
    await expect(invoke('brief.settings.set', { window: 500 } as never)).rejects.toThrow();
  });
});

async function docx(paragraphs: Paragraph[]): Promise<Buffer> {
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
}

describe('MS-1 MS-4 MS-5 manuscript import from Word, re-import, and the diff', () => {
  const path = join(outDir, 'Chapter 6 The Letter.docx');

  test('MS-1 a Word chapter is imported with italics and scene breaks, linked to its file', async () => {
    writeFileSync(
      path,
      await docx([
        new Paragraph({ text: 'The Letter', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({
          children: [
            new TextRun('Iris found the envelope under the '),
            new TextRun({ text: 'attic', italics: true }),
            new TextRun(' boards.'),
          ],
        }),
        new Paragraph({ text: '* * *' }),
        new Paragraph({ text: 'Daniel said nothing at dinner.' }),
      ]),
    );
    const sources = await invoke('manuscript.sources', {});
    expect(sources.sources.map((s) => s.id)).toContain('word');
    picked = path;
    const read = await invoke('manuscript.read', { chapterId: 'CH6', sourceId: 'word' });
    expect(read.token).not.toBeNull();
    expect(read.name).toBe('Chapter 6 The Letter.docx');
    expect(read.source).toBe(`word:${path}`);
    expect(read.body).toContain('<em>attic</em>');
    expect(read.body).toContain('<hr>');
    // The fixture's earlier text is replaced: the diff shows it going and the Word text arriving.
    const fixtureText = String(bible.model.get('chapters', 'CH6')!.manuscriptText);
    expect(read.diff.filter((d) => d.kind === 'removed').map((d) => d.text)).toEqual([
      'Iris asked her father about the uncle nobody mentioned. Outside, the old flood line was still painted on the wall.',
    ]);
    expect(read.diff.filter((d) => d.kind === 'added').map((d) => d.text)).toEqual([
      'The Letter',
      'Iris found the envelope under the attic boards.',
      '* * *',
      'Daniel said nothing at dinner.',
    ]);
    // Nothing is written until applied.
    expect(bible.model.get('chapters', 'CH6')!.manuscriptText).toBe(fixtureText);
    const base = String(bible.model.get('chapters', 'CH6')!.modifiedAt);
    const applied = await invoke('manuscript.apply', { token: read.token!, baseModifiedAt: base });
    expect(applied.before).toMatchObject({ manuscriptText: fixtureText, summaryOutOfDate: false });
    const ch = bible.model.get('chapters', 'CH6')!;
    expect(ch.manuscriptText).toContain('<em>attic</em>');
    expect(ch.sourceFile).toBe('Chapter 6 The Letter.docx');
    expect(ch.manuscriptSource).toBe(`word:${path}`);
    // The text the summary was written for changed.
    expect(ch.summaryOutOfDate).toBe(true);
    // Approving a fresh summary clears the mark (what the Mark as written flow saves).
    await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH6',
      patch: { summary: 'Iris finds the letter.', summaryOutOfDate: false },
    });
  });

  test('MS-4 re-importing a changed chapter shows a text diff and marks the summary as possibly out of date', async () => {
    writeFileSync(
      path,
      await docx([
        new Paragraph({ text: 'The Letter', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({
          children: [
            new TextRun('Iris found the envelope under the '),
            new TextRun({ text: 'attic', italics: true }),
            new TextRun(' boards.'),
          ],
        }),
        new Paragraph({ text: '* * *' }),
        new Paragraph({ text: 'Daniel left the table before dessert.' }),
      ]),
    );
    picked = null; // the linked file is read again with no dialog
    const read = await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(read.changed).toBe(true);
    expect(read.diff.filter((d) => d.kind !== 'same')).toEqual([
      { kind: 'removed', text: 'Daniel said nothing at dinner.', line: 4 },
      { kind: 'added', text: 'Daniel left the table before dessert.', line: 4 },
    ]);
    expect(read.summaryOutOfDate).toBe(true);
    // A stale comparison is refused (ED-7).
    await expect(
      invoke('manuscript.apply', { token: read.token!, baseModifiedAt: '2000-01-01T00:00:00Z' }),
    ).rejects.toThrow(/changed after you saw the comparison/);
    const base = String(bible.model.get('chapters', 'CH6')!.modifiedAt);
    await invoke('manuscript.apply', { token: read.token!, baseModifiedAt: base });
    const ch = bible.model.get('chapters', 'CH6')!;
    expect(ch.summaryOutOfDate).toBe(true);
    expect(ch.manuscriptText).toContain('before dessert');
    // The selection's previous-chapter list warns about it when CH6 is an earlier chapter.
    const sel = await invoke('session.relevant', { input: { kind: 'chapter', chapterId: 'CH7' } });
    const prev = sel.selection.shared.find((g) => g.kind === 'previousChapters')!;
    expect(prev.items.find((i) => i.id === 'CH6')!.note).toMatch(/summary may be out of date/);
  });

  test('MS-4 reading an unchanged file reports no change', async () => {
    const read = await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(read.changed).toBe(false);
    expect(read.diff.every((d) => d.kind === 'same')).toBe(true);
  });

  test('MS-5 importing never writes to the manuscript file', async () => {
    const bytes = readFileSync(path);
    await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});

describe('MS-2 MS-3 marking a chapter as written', () => {
  test('MS-2 without Claude the summary is written by hand; with Claude a draft is offered and nothing is saved', async () => {
    claude = { summaries: null };
    const none = await invoke('chapter.summarize', { chapterId: 'CH6' });
    expect(none).toMatchObject({ available: false, draft: '' });
    expect(none.message).toMatch(/write the summary yourself/);
    claude = fakeSessionClaude({ summary: 'Iris finds the letter; Daniel leaves the table.' });
    const before = bible.model.get('chapters', 'CH6')!.summary;
    const r = await invoke('chapter.summarize', { chapterId: 'CH6' });
    expect(r).toMatchObject({
      available: true,
      draft: 'Iris finds the letter; Daniel leaves the table.',
      model: 'claude-sonnet-5-5',
    });
    expect(bible.model.get('chapters', 'CH6')!.summary).toBe(before);
    claude = { summaries: null };
  });

  test('MS-3 SM-3 the planned entries the chapter establishes are listed, and promote one at a time', async () => {
    const r = await invoke('chapter.establishes', { chapterId: 'CH6' });
    // Hand-checked: B4 is Iris's planned moment of 2045, CH6's year and point of view (SM-3: beats
    // became moments, found by year and strand). E10 (2090) is after the chapter.
    expect(r.items.map((i) => [i.id, i.why])).toEqual([
      ['B4', 'a moment of the point of view in these years'],
    ]);
    await invoke('entry.update', { collection: 'moments', id: 'B4', patch: { status: 'canon' } });
    const again = await invoke('chapter.establishes', { chapterId: 'CH6' });
    expect(again.items.map((i) => i.id)).toEqual([]);
  });
});

// ---------- a47-guard: IP-18 Re-import ----------

describe('IP-18 manuscript.reimport reads the linked file again and stores it in one call', () => {
  const path = join(outDir, 'chapter-03.docx');

  test('IP-18 MS-1 MS-4 Re-import of the fixture Word chapter returns the Manuscript tab diff and stores the text through the importer', async () => {
    // The fixture's Word chapter, linked to CH3 through the MS-1 import.
    copyFileSync(join(import.meta.dirname, '../../fixtures/files/chapter-03.docx'), path);
    await expect(invoke('manuscript.reimport', { chapterId: 'CH3' })).rejects.toThrow(
      'This chapter has no linked manuscript yet. Import it from a file first.',
    );
    picked = path;
    const read = await invoke('manuscript.read', { chapterId: 'CH3', sourceId: 'word' });
    await invoke('manuscript.apply', {
      token: read.token!,
      baseModifiedAt: String(bible.model.get('chapters', 'CH3')!.modifiedAt),
    });
    picked = null;
    const linked = bible.model.get('chapters', 'CH3')!;
    expect(linked.manuscriptSource).toBe(`word:${path}`);

    // Unchanged file: nothing to store.
    const same = await invoke('manuscript.reimport', { chapterId: 'CH3' });
    expect(same).toMatchObject({ changed: false, applied: false, before: {} });
    expect(same.diff.every((d) => d.kind === 'same')).toBe(true);
    expect(bible.model.get('chapters', 'CH3')!.modifiedAt).toBe(linked.modifiedAt);

    // The writer changes the Word file; Re-import is one call.
    writeFileSync(
      path,
      await docx([
        new Paragraph({ text: 'Wedding Weather', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: 'It rained on the wedding, and nobody minded.' }),
      ]),
    );
    const again = await invoke('manuscript.reimport', { chapterId: 'CH3' });
    expect(again.changed).toBe(true);
    expect(again.applied).toBe(true);
    expect(again.source).toBe(`word:${path}`);
    expect(again.name).toBe('chapter-03.docx');
    expect(again.diff.filter((d) => d.kind === 'added').map((d) => d.text)).toEqual([
      'Wedding Weather',
      'It rained on the wedding, and nobody minded.',
    ]);
    expect(again.before).toMatchObject({ manuscriptText: linked.manuscriptText });
    const stored = bible.model.get('chapters', 'CH3')!;
    expect(stored.manuscriptText).toBe(again.body);
    expect(again.entry).toMatchObject({ _id: 'CH3', manuscriptText: again.body });
    // The same text may not be written any other way.
    await expect(
      invoke('entry.update', {
        collection: 'chapters',
        id: 'CH3',
        patch: { manuscriptText: '<p>By hand.</p>' },
      }),
    ).rejects.toThrow('The manuscript text is imported, not edited here. Use Re-import.');
  });
});
