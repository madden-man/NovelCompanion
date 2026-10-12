import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { missingLeadSections } from '../../src/shared/domain/brief/render';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadBriefFixture } from '../helpers/briefFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
let claude: SessionClaude = { briefs: null, summaries: null };
let picked: string | null = null;
let printed: string | null = null;
let exportTo: string | null = null;
const outDir = mkdtempSync(join(tmpdir(), 'nc-m7-'));
let invoke: Invoke;

const CH6_IDS = [
  'B1',
  'B3',
  'B4',
  'B7',
  'CE3',
  'CH1',
  'CH3',
  'CH4',
  'CH5',
  'CH6',
  'CU4',
  'E1',
  'E2',
  'E3',
  'E5',
  'E9',
  'ERA-2040',
  'F2',
  'GL1',
  'GL3',
  'H3',
  'H5',
  'K4',
  'PLC2',
  'Q1',
  'Q2',
  'Q4',
  'SL2',
  'TH1',
  'TH2',
];

beforeAll(async () => {
  store = await localStore();
  const { id } = await loadBriefFixture(store, freshSlug('m7'));
  bible = await openBibleSession(store, id);
  invoke = ipcFor(() => bible, {
    claude: () => claude,
    pickFile: async () => picked,
    pickExportPath: async (name) => exportTo ?? join(outDir, name),
    printPdf: async (html) => {
      printed = html;
      return Buffer.from('%PDF-1.4 fake');
    },
    now: () => new Date(2026, 9, 11, 9, 30),
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
    // The view and the brief share one implementation: the pure function on the read model.
    expect(a.selection).toEqual(
      JSON.parse(
        JSON.stringify(selectForSession(bible.model, { kind: 'chapter', chapterId: 'CH6' })),
      ),
    );
    expect(missingLeadSections(a.structured)).toEqual([]);
  });

  test('SB-6 SB-2 the window and the budget are settings that change the selection', async () => {
    expect(await invoke('brief.settings.get', {})).toEqual({
      window: 3,
      budget: 40_000,
      model: 'claude-opus-5-5',
      claudeAvailable: false,
    });
    try {
      await invoke('brief.settings.set', { budget: 0 });
      const tight = await invoke('session.relevant', {
        input: { kind: 'chapter', chapterId: 'CH6' },
      });
      // A25: the lead sections stay, and the brief says it is over budget.
      expect(tight.selection.ids).toEqual(['CH6', 'CU4', 'E1', 'E3', 'E5', 'H3', 'H5']);
      expect(tight.selection.overBudget).toBe(true);
      expect(tight.selection.omitted[0]).toMatchObject({ id: 'E9', reason: 'budget' });
      expect(tight.structured).toContain('## Left out');
      expect(tight.structured).toContain('## Over budget');
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

describe('DB-2 DB-3 SB-7 Start session without Claude', () => {
  test('DB-2 DB-3 SB-7 SB-8 starting a session saves a structured brief, logs the session, and sets the story time', async () => {
    claude = { briefs: null, summaries: null };
    const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(r.synthesized).toBe(false);
    expect(r.note).toMatch(/No Anthropic API key is stored, so this is the structured brief/);
    expect(r.problems).toEqual([]);
    const brief = bible.model.get('briefs', r.brief._id)!;
    expect(brief.chapterId).toBe('CH6');
    expect(brief.entryIds).toEqual(CH6_IDS);
    expect(brief.model).toBe('');
    expect(brief.sectionKind).toBe('chapter');
    expect((brief.selection as { ids: string[] }).ids).toEqual(CH6_IDS);
    expect(missingLeadSections(String(brief.content))).toEqual([]);
    expect(String(brief.content)).toContain('## Planned ahead (after 2045)');
    // DB-3: one session log entry linked to the section and the brief.
    const log = bible.model.get('sessionLogs', r.log._id)!;
    expect(log).toMatchObject({
      chapterId: 'CH6',
      briefId: r.brief._id,
      storyYear: 2045,
      povCharacterId: 'H5',
      date: '2026-10-11',
      // SL-1, step 10: the record of a start carries no note, so it never shows as where you stopped.
      stoppedAt: '',
      notes: '',
    });
    const again = await invoke('session.relevant', {
      input: { kind: 'chapter', chapterId: 'CH6' },
    });
    const note = again.selection.shared.find((g) => g.kind === 'sessionNote')!;
    expect(note.items.map((i) => i.id)).toEqual(['SL2']);
    expect((await invoke('dashboard.get', {})).lastLog?.id).toBe('SL3');
    expect(r.time).toEqual({ year: 2045, chapterId: 'CH6', strandId: 'CH6-present' });
    expect(bible.repo.storyTime()).toEqual({
      year: 2045,
      chapterId: 'CH6',
      strandId: 'CH6-present',
    });
    // SB-8: linked to its chapter, so the chapter lists it.
    const linked = await invoke('entry.backlinks', { id: 'CH6' });
    expect(linked.backlinks.map((b) => b.id)).toContain(r.brief._id);
  });

  test('DB-3 a start that cannot save leaves no brief, no log, and the story time as it was', async () => {
    const time = bible.repo.storyTime();
    const briefs = bible.model.all('briefs').length;
    const logs = bible.model.all('sessionLogs').length;
    const original = bible.repo.createMany.bind(bible.repo);
    bible.repo.createMany = async () => {
      throw new Error('the database refused the write');
    };
    try {
      await expect(
        invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH2' } }),
      ).rejects.toThrow(
        'The session was not started, and nothing was saved: the database refused the write.',
      );
    } finally {
      bible.repo.createMany = original;
    }
    expect(bible.repo.storyTime()).toEqual(time);
    expect(bible.model.all('briefs')).toHaveLength(briefs);
    expect(bible.model.all('sessionLogs')).toHaveLength(logs);
  });

  test('DB-3 a part and a year with point of view set the story time to the section year', async () => {
    const part = await invoke('session.start', { input: { kind: 'part', partId: 'PT2' } });
    expect(part.time).toEqual({ year: 2040, chapterId: 'CH5', strandId: 'CH5-present' });
    expect(bible.model.get('sessionLogs', part.log._id)!.partId).toBe('PT2');
    const pov = await invoke('session.start', {
      input: { kind: 'pov', year: 2041, povCharacterId: 'H4' },
    });
    expect(pov.time).toEqual({ year: 2041 });
    expect(bible.model.get('briefs', pov.brief._id)!.sectionKind).toBe('pov');
  });
});

describe('SB-4 DB-4 Claude writes the brief from the manifest only', () => {
  test('SB-4 DB-4 a synthesized brief uses the brief model, cites only manifest IDs, and opens with the three sections', async () => {
    claude = fakeSessionClaude();
    const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH2' } });
    expect(r.synthesized).toBe(true);
    expect(r.note).toBeNull();
    expect(r.problems).toEqual([]);
    expect(r.uncited).toEqual([]);
    const brief = bible.model.get('briefs', r.brief._id)!;
    expect(brief.model).toBe('claude-opus-5-5');
    expect(brief.synthesized).toBe(true);
    expect(missingLeadSections(String(brief.content))).toEqual([]);
  });

  test('SB-4 a line of a Claude-written brief that cites nothing is reported', async () => {
    claude = fakeSessionClaude({ uncitedLine: 'Iris has always loved the rain.' });
    const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(r.uncited).toEqual(['Iris has always loved the rain.']);
    expect(r.problems).toEqual([]);
  });

  test('SB-4 a cited ID outside the manifest is reported', async () => {
    claude = fakeSessionClaude({ foreignCitation: 'Z2' });
    const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(r.problems).toEqual(['Z2']);
  });

  test('SB-7 AI-7 when Claude fails, the structured brief is saved and the reason is given', async () => {
    claude = fakeSessionClaude({ fail: 'rate limited' });
    const r = await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } });
    expect(r.synthesized).toBe(false);
    expect(r.note).toMatch(/Claude could not write the brief \(rate limited\)/);
    expect(bible.model.get('briefs', r.brief._id)!.content).toContain('# Brief: Chapter 6');
    claude = { briefs: null, summaries: null };
  });
});

describe('SB-8 SB-9 saved briefs: edit, regenerate, export', () => {
  let id = '';
  beforeAll(async () => {
    claude = { briefs: null, summaries: null };
    id = (await invoke('session.start', { input: { kind: 'chapter', chapterId: 'CH6' } })).brief
      ._id;
  });

  test('SB-9 removing and adding entries, then regenerating, keeps the brief and changes its manifest', async () => {
    const before = (await invoke('revisions.list', { collection: 'briefs', id })).revisions.length;
    const r = await invoke('brief.regenerate', { id, remove: ['E5', 'GL1'], add: ['Z4'] });
    expect(r.brief._id).toBe(id);
    const brief = bible.model.get('briefs', id)!;
    expect(brief.entryIds).not.toContain('E5');
    expect(brief.entryIds).not.toContain('GL1');
    expect(brief.entryIds).toContain('Z4');
    expect(brief.removed).toEqual(['E5', 'GL1']);
    expect(brief.added).toEqual(['Z4']);
    expect(String(brief.content)).toContain('## 11. Added by you');
    expect(String(brief.content)).toContain('removed by you');
    const after = (await invoke('revisions.list', { collection: 'briefs', id })).revisions.length;
    expect(after).toBe(before + 1);
  });

  test('SB-8 ED-6 a brief is edited like any entry, and exports as Markdown and PDF', async () => {
    await invoke('entry.update', {
      collection: 'briefs',
      id,
      patch: { content: '# My brief\n\n- Iris is fourteen. [[H5]]\n' },
    });
    const md = await invoke('brief.export', { id, format: 'markdown' });
    expect(md.saved).toBe(true);
    expect(readFileSync(md.path!, 'utf8')).toBe('# My brief\n\n- Iris is fourteen. [[H5]]\n');
    const pdf = await invoke('brief.export', { id, format: 'pdf' });
    expect(pdf.path).toMatch(/\.pdf$/);
    expect(readFileSync(pdf.path!, 'utf8')).toBe('%PDF-1.4 fake');
    expect(printed).toContain('<h1>My brief</h1>');
    expect(printed).toContain('<span class="cite" data-cite="H5">H5</span>');
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
    // The brief's previous-chapter list warns about it when CH6 is an earlier chapter.
    const sel = await invoke('session.relevant', { input: { kind: 'chapter', chapterId: 'CH7' } });
    const prev = sel.selection.shared.find((g) => g.kind === 'previousChapters')!;
    expect(prev.items.find((i) => i.id === 'CH6')!.note).toMatch(/summary may be out of date/);
  });

  test('MS-4 reading an unchanged file reports no change', async () => {
    const read = await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(read.changed).toBe(false);
    expect(read.diff.every((d) => d.kind === 'same')).toBe(true);
  });

  test('MS-5 a brief export is refused onto a linked manuscript or any Word file', async () => {
    const brief = bible.model.all('briefs').find((b) => !b.deletedAt)!;
    exportTo = path;
    const bytes = readFileSync(path);
    await expect(invoke('brief.export', { id: brief._id, format: 'markdown' })).rejects.toThrow(
      /That file is a manuscript/,
    );
    expect(readFileSync(path).equals(bytes)).toBe(true);
    exportTo = join(outDir, 'Another.docx');
    await expect(invoke('brief.export', { id: brief._id, format: 'pdf' })).rejects.toThrow(
      /That file is a manuscript/,
    );
    exportTo = null;
  });

  test('MS-5 importing never writes to the manuscript file', async () => {
    const bytes = readFileSync(path);
    await invoke('manuscript.read', { chapterId: 'CH6' });
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});

describe('MS-2 MS-3 marking a chapter as written', () => {
  test('MS-2 without Claude the summary is written by hand; with Claude a draft is offered and nothing is saved', async () => {
    claude = { briefs: null, summaries: null };
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
    claude = { briefs: null, summaries: null };
  });

  test('MS-3 the planned entries the chapter establishes are listed, and promote one at a time', async () => {
    const r = await invoke('chapter.establishes', { chapterId: 'CH6' });
    // Hand-checked: B4 is CH6's beat and F2 its fact in play, both planned. E10 (2090) is after the chapter.
    expect(r.items.map((i) => [i.id, i.why])).toEqual([
      ['B4', 'a beat of this chapter'],
      ['F2', 'a fact in play'],
    ]);
    await invoke('entry.update', { collection: 'plotBeats', id: 'B4', patch: { status: 'canon' } });
    const again = await invoke('chapter.establishes', { chapterId: 'CH6' });
    expect(again.items.map((i) => i.id)).toEqual(['F2']);
  });
});

describe('DB-1 the dashboard', () => {
  test('DB-1 the dashboard reports the last note, position, open questions, and rewrite tasks', async () => {
    await invoke('entry.create', {
      collection: 'findings',
      data: {
        title: 'Lan grew up in Guangzhou',
        status: 'planned',
        kind: 'alignment',
        chapterId: 'CH7',
        text: 'Change Shanghai to Guangzhou.',
        quote: 'grew up in Shanghai',
        lineStart: 12,
        lineEnd: 12,
        state: 'rewrite',
      },
    });
    const d = await invoke('dashboard.get', {});
    // SL-1: the newest note you wrote, not a session's start record.
    expect(d.lastLog).toMatchObject({ id: 'SL3', stoppedAt: 'Margaret blows out the candles.' });
    expect(d.recentLogs.some((l) => l.text === 'Started a session' && l.briefId)).toBe(true);
    expect(d.position).toEqual({ chapterId: 'CH5', title: 'Candles', readingOrder: 5, year: 2040 });
    expect(d.openQuestions).toBe(3);
    expect(d.rewriteTasks).toEqual([
      expect.objectContaining({
        chapter: 'Rain in Guangzhou',
        quote: 'grew up in Shanghai',
        lines: 'line 12',
      }),
    ]);
    expect(d.recentLogs.length).toBeGreaterThan(0);
  });
});
