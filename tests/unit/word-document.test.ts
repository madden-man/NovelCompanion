import { describe, expect, test } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { blocksToBody, isSceneBreak, parseBlocks } from '../../src/shared/domain/wordDocument';
import { parseDocxBuffer, parseDocxFile } from '../../src/main/session/docx';
import { join } from 'node:path';

const FILE = { fileName: 'chapter-03.docx', modifiedAt: '2026-01-15T09:00:00.000Z' };
const FIXTURE_DOCX = join(import.meta.dirname, '../../fixtures/files/chapter-03.docx');

/** The stored manuscript text for mammoth's HTML. */
const bodyOf = (html: string) => blocksToBody(parseBlocks(html));

async function docxOf(children: Paragraph[]) {
  const buf = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return parseDocxBuffer(buf, FILE);
}

describe('MS-1 Word documents keep their headings, italics, and scene breaks', () => {
  test('MS-1 the fixture chapter becomes a heading, a paragraph with italics, a rule, and a paragraph', async () => {
    const doc = await parseDocxFile(FIXTURE_DOCX);
    expect(doc.blocks.map((b) => [b.index, b.kind, b.level])).toEqual([
      [1, 'heading', 1],
      [2, 'paragraph', 0],
      [3, 'scene', 0],
      [4, 'paragraph', 0],
    ]);
    expect(bodyOf(doc.html)).toBe(
      '<h1>Chapter 3: Wedding Weather</h1><p>It rained on the wedding, and Peter said that was <em>lucky</em>. Meiling said nothing at all.</p><hr><p>Daniel found her later on the porch, watching the river rise.</p>',
    );
  });

  test('MS-1 a paragraph of only ***, #, three or more dashes, or three or more spaces is a scene break', () => {
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

  test('MS-1 scene breaks, italics, bold, headings, lists, and entities come through a real .docx', async () => {
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
    const body = bodyOf(doc.html);
    expect(body).toBe(
      '<h1>Part One</h1><h3>A section</h3><p>Tom &amp; Jerry, <em>slowly</em> and <strong>loudly</strong> &lt;ran&gt;.</p><hr><p>After the break.</p><hr><p>And after spaces.</p><ul><li>One</li><li>Two</li></ul>',
    );
  });

  test('MS-1 paragraph numbers count every paragraph, empty ones too, so a source location matches the document', async () => {
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

  test('MS-1 a scene break at the start or end, or two in a row, adds no extra rules', () => {
    const blocks = parseBlocks('<p>***</p><p>One</p><p>***</p><p>***</p><p>Two</p><p>***</p>');
    expect(bodyOf(`<p>***</p><p>One</p><p>***</p><p>***</p><p>Two</p><p>***</p>`)).toBe(
      '<p>One</p><hr><p>Two</p>',
    );
    expect(blocks.filter((b) => b.kind === 'scene')).toHaveLength(4);
  });

  test('MS-1 nested lists, quotes, links, and tables reduce to plain structure', () => {
    const html =
      '<ol><li>First<ul><li>Inner</li></ul></li><li>Second</li></ol><blockquote><p>Said</p></blockquote><p>See <a href="http://x">the page</a><sup>1</sup></p><table><tr><td>A</td><td>B</td></tr></table>';
    expect(bodyOf(html)).toBe(
      '<ol><li>First</li></ol><ul><li>Inner</li></ul><ol><li>Second</li></ol><blockquote>Said</blockquote><p>See the page1</p><p>AB</p>',
    );
  });
});
