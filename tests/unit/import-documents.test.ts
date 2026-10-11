import { describe, expect, test } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import {
  documentTitle,
  erasFromBlocks,
  htmlToBody,
  isSceneBreak,
  parseBlocks,
  planDocument,
  planEraDocument,
  sectionsAt,
  yearsInHeading,
} from '../../src/shared/domain/import';
import { parseDocxBuffer, parseDocxFile } from '../../src/main/import/docx';
import { splitManuscript } from '../../src/main/import/eastwinds';
import { join } from 'node:path';

const FILE = { fileName: 'chapter-03.docx', modifiedAt: '2026-01-15T09:00:00.000Z' };
const FIXTURE_DOCX = join(import.meta.dirname, '../../fixtures/files/chapter-03.docx');

async function docxOf(children: Paragraph[]) {
  const buf = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return parseDocxBuffer(buf, FILE);
}

describe('IM-4 Word documents keep their headings, italics, and scene breaks', () => {
  test('IM-4 the fixture chapter becomes a heading, a paragraph with italics, a rule, and a paragraph', async () => {
    const doc = await parseDocxFile(FIXTURE_DOCX);
    expect(doc.blocks.map((b) => [b.index, b.kind, b.level])).toEqual([
      [1, 'heading', 1],
      [2, 'paragraph', 0],
      [3, 'scene', 0],
      [4, 'paragraph', 0],
    ]);
    expect(htmlToBody(doc.html)).toBe(
      '<h1>Chapter 3: Wedding Weather</h1><p>It rained on the wedding, and Peter said that was <em>lucky</em>. Meiling said nothing at all.</p><hr><p>Daniel found her later on the porch, watching the river rise.</p>',
    );
    expect(documentTitle(doc.blocks, doc.fileName)).toBe('Chapter 3: Wedding Weather');
  });

  test('IM-4 a paragraph of only ***, #, three or more dashes, or three or more spaces is a scene break', () => {
    for (const text of [
      '***',
      '* * *',
      '#',
      '---',
      '- - -',
      '\u2013\u2013\u2013',
      '   ',
      '     ',
    ]) {
      expect(isSceneBreak(text), JSON.stringify(text)).toBe(true);
    }
    for (const text of ['', '  ', '**', '--', 'a ***', '# Heading', 'Dashes - inside', '2']) {
      expect(isSceneBreak(text), JSON.stringify(text)).toBe(false);
    }
  });

  test('IM-4 scene breaks, italics, bold, headings, lists, and entities come through a real .docx', async () => {
    const doc = await docxOf([
      new Paragraph({ text: 'Part One', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: 'A section', heading: HeadingLevel.HEADING_3 }),
      new Paragraph({
        children: [
          new TextRun('Tom & Jerry, '),
          new TextRun({ text: 'slowly', italics: true }),
          new TextRun(' and '),
          new TextRun({ text: 'loudly', bold: true }),
          new TextRun(' <ran>.'),
        ],
      }),
      new Paragraph({ text: '***' }),
      new Paragraph({ text: '#' }),
      new Paragraph({ text: 'After the break.' }),
      new Paragraph({ text: '   ' }),
      new Paragraph({ text: 'And after spaces.' }),
      new Paragraph({ text: 'One', bullet: { level: 0 } }),
      new Paragraph({ text: 'Two', bullet: { level: 0 } }),
    ]);
    const body = htmlToBody(doc.html);
    expect(body).toBe(
      '<h1>Part One</h1><h3>A section</h3><p>Tom &amp; Jerry, <em>slowly</em> and <strong>loudly</strong> &lt;ran&gt;.</p><hr><p>After the break.</p><hr><p>And after spaces.</p><ul><li>One</li><li>Two</li></ul>',
    );
  });

  test('IM-4 paragraph numbers count every paragraph, empty ones too, so a source location matches the document', async () => {
    const doc = await docxOf([
      new Paragraph({ text: 'First' }),
      new Paragraph({ text: '' }),
      new Paragraph({ text: 'Third' }),
    ]);
    expect(doc.blocks.map((b) => [b.index, b.text])).toEqual([
      [1, 'First'],
      [3, 'Third'],
    ]);
  });

  test('IM-4 a scene break at the start or end, or two in a row, adds no extra rules', () => {
    const blocks = parseBlocks('<p>***</p><p>One</p><p>***</p><p>***</p><p>Two</p><p>***</p>');
    expect(htmlToBody(`<p>***</p><p>One</p><p>***</p><p>***</p><p>Two</p><p>***</p>`)).toBe(
      '<p>One</p><hr><p>Two</p>',
    );
    expect(blocks.filter((b) => b.kind === 'scene')).toHaveLength(4);
  });

  test('IM-4 nested lists, quotes, links, and tables reduce to plain structure', () => {
    const html =
      '<ol><li>First<ul><li>Inner</li></ul></li><li>Second</li></ol><blockquote><p>Said</p></blockquote><p>See <a href="http://x">the page</a><sup>1</sup></p><table><tr><td>A</td><td>B</td></tr></table>';
    expect(htmlToBody(html)).toBe(
      '<ol><li>First</li></ol><ul><li>Inner</li></ul><ol><li>Second</li></ol><blockquote>Said</blockquote><p>See the page1</p><p>AB</p>',
    );
  });

  test('IM-4 headings split a document into sections', () => {
    const blocks = parseBlocks(
      '<p>Before</p><h1>A</h1><p>a1</p><h2>A.1</h2><p>a2</p><h1>B</h1><p>b1</p>',
    );
    expect(sectionsAt(blocks, 1).map((s) => [s.heading?.text ?? null, s.blocks.length])).toEqual([
      [null, 1],
      ['A', 3],
      ['B', 1],
    ]);
  });
});

describe('IM-4 the plan for a document', () => {
  const body = '<h1>Mark</h1><p>He was born.</p>';
  const empty = () => [];

  test('IM-4 a backstory becomes one change to the character, with the old and new text', () => {
    const mark = {
      _id: 'C1',
      title: 'Mark',
      names: { full: 'Mark' },
      birth: { unknown: true },
      backstory: '',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'planned',
    };
    const set = planDocument({
      file: FILE,
      body,
      span: { first: 1, last: 2 },
      target: { kind: 'backstory', characterId: 'C1' },
      entries: (c) => (c === 'characters' ? [mark] : []),
      sources: empty,
      newId: () => 'N1',
    });
    expect(set.failed).toEqual([]);
    expect(set.items).toHaveLength(1);
    expect(set.items[0]).toMatchObject({
      kind: 'changed',
      entryId: 'C1',
      ref: 'chapter-03.docx#p1-p2',
      patch: { backstory: body, sourceRef: 'chapter-03.docx#p1-p2' },
      deltas: [{ path: 'backstory', before: '', after: body, outcome: 'apply' }],
    });
  });

  test('IM-4 an empty document or a missing target is reported, not dropped', () => {
    const base = {
      file: FILE,
      span: { first: 1, last: 1 },
      entries: empty,
      sources: empty,
      newId: () => 'N',
    };
    expect(
      planDocument({ ...base, body: '<p> </p>', target: { kind: 'backstory', characterId: 'C1' } })
        .failed[0]!.reason,
    ).toBe('The document has no text to import');
    expect(
      planDocument({ ...base, body, target: { kind: 'backstory', characterId: 'C1' } }).failed[0]!
        .reason,
    ).toBe('That character is not in the bible');
    expect(
      planDocument({ ...base, body, target: { kind: 'chapter', chapterId: 'nope' } }).failed[0]!
        .reason,
    ).toBe('That chapter is not in the bible');
  });
});

describe('IM-4 World Development: era states by their headings', () => {
  test('IM-4 headings with years become eras, and the text before them is kept apart', () => {
    const blocks = parseBlocks(
      '<h1>How the world gets here</h1><p>Intro.</p><h2>2025\u20132038: The automation divide</h2><p>It starts quietly.</p><h3>Technology</h3><p>Robots.</p><h3>Climate</h3><p>Floods.</p><h2>2039: The hinge</h2><p>The event.</p><h2>The 2030s</h2><p>A decade.</p><h2>A note</h2><p>Last.</p>',
    );
    const { eras, skipped } = erasFromBlocks(blocks);
    expect(eras.map((e) => [e.name, e.startYear, e.endYear])).toEqual([
      ['2025\u20132038: The automation divide', 2025, 2038],
      ['2039: The hinge', 2039, 2039],
      ['The 2030s', 2030, 2039],
    ]);
    expect(eras[0]!.fields).toEqual({ technology: '<p>Robots.</p>', climate: '<p>Floods.</p>' });
    expect(eras[0]!.body).toBe('<p>It starts quietly.</p>');
    expect(skipped.map((s) => s.heading?.text ?? null)).toEqual(['A note']);
    expect(yearsInHeading('2040-2049')).toEqual({ start: 2040, end: 2049 });
    expect(yearsInHeading('Nothing here')).toBeNull();
  });

  test('IM-4 a document with no heading styles uses its capital letter lines as headings', () => {
    const blocks = parseBlocks(
      '<p>THE PREMISE, IN ONE LINE</p><p>Between 2025 and 2100, things happen and then more.</p><p>2025\u20132038: THE AUTOMATION DIVIDE</p><p>It starts quietly. In 2025, a factory.</p><p>2039: THE HINGE</p><p>2039 was bad.</p>',
    );
    const { eras, skipped } = erasFromBlocks(blocks);
    expect(eras.map((e) => [e.name, e.startYear, e.endYear, e.first, e.last])).toEqual([
      ['2025\u20132038: THE AUTOMATION DIVIDE', 2025, 2038, 3, 4],
      ['2039: THE HINGE', 2039, 2039, 5, 6],
    ]);
    expect(skipped).toHaveLength(1);
  });

  test('IM-3 IM-6 eras are matched by name on re-import and record their paragraph span', () => {
    const blocks = parseBlocks('<h2>2025-2038: One</h2><p>Text.</p><h2>2039: Two</h2><p>More.</p>');
    const { eras } = erasFromBlocks(blocks);
    const file = { fileName: 'World.docx', modifiedAt: '2026-01-15T09:00:00.000Z' };
    let n = 0;
    const first = planEraDocument({
      file,
      eras,
      entries: () => [],
      sources: () => [],
      newId: () => `E${++n}`,
    });
    expect(
      first.items.map((i) => [i.title, (i.data as Record<string, unknown>).sourceRef]),
    ).toEqual([
      ['2025-2038: One', 'World.docx#p1-p2'],
      ['2039: Two', 'World.docx#p3-p4'],
    ]);
    const docs = first.items.map((i) => ({
      ...(i.data as Record<string, unknown>),
      _id: i.entryId,
    }));
    const again = planEraDocument({
      file,
      eras,
      entries: () => docs as never,
      sources: () => [],
      newId: () => `E${++n}`,
    });
    expect(again.items).toEqual([]);
    expect(again.unchanged).toBe(2);
  });
});

describe('IM-4 the East Winds manuscript is split at its chapter headings', () => {
  test('IM-4 the introduction, chapter 1, and the rest are separate runs of paragraphs', () => {
    const blocks = parseBlocks(
      '<h1>East Winds</h1><p>Title page.</p><h1>Introduction</h1><p>Intro text.</p><h1>1: Laid the Foundation</h1><p>Chapter text.</p><h1>Characters</h1><p>Notes.</p>',
    );
    const split = splitManuscript(blocks)!;
    expect(split.introduction.map((b) => b.text)).toEqual([
      'East Winds',
      'Title page.',
      'Introduction',
      'Intro text.',
    ]);
    expect(split.chapterOne.map((b) => b.text)).toEqual([
      '1: Laid the Foundation',
      'Chapter text.',
    ]);
    expect(split.rest.map((b) => b.text)).toEqual(['Characters', 'Notes.']);
    expect(split.chapterTitle).toBe('1: Laid the Foundation');
    expect(splitManuscript(parseBlocks('<p>No headings</p>'))).toBeNull();
  });
});
