import { describe, expect, test } from 'vitest';
import { getSchema } from '@tiptap/core';
import {
  asMarkdown,
  escapeMarkdown,
  htmlToMarkdown,
  looksLikeHtml,
  markdownToText,
  plainText,
} from '../../src/shared/domain/markdown';
import { plain } from '../../src/shared/domain/brief/selection';
import { richExtensions } from '../../src/renderer/src/workspace/richText/extensions';
import {
  parseMarkdown,
  serializeMarkdown,
} from '../../src/renderer/src/workspace/richText/markdown';

const full = getSchema(richExtensions('full'));
const inline = getSchema(richExtensions('inline'));
const roundTrip = (md: string, schema = full) => serializeMarkdown(parseMarkdown(schema, md));

describe('A44 HTML to Markdown, the shapes the importer wrote', () => {
  test('paragraphs, headings at two levels, bold and italic', () => {
    expect(
      htmlToMarkdown(
        '<h1>The east wind</h1><h2>Part one</h2><h3>Fog</h3><h4>Deep</h4><p>The <strong>harbour</strong> was <em>quiet</em>.</p><p>Second paragraph.</p>',
      ),
    ).toBe(
      '## The east wind\n\n## Part one\n\n### Fog\n\n### Deep\n\nThe **harbour** was *quiet*.\n\nSecond paragraph.',
    );
  });

  test('bullet and numbered lists, scene breaks, line breaks and quotes', () => {
    expect(
      htmlToMarkdown(
        '<ul><li>Fish</li><li><em>Rice</em></li></ul><hr><ol><li>One</li><li>Two</li></ol><p>Line one<br>Line two</p><blockquote>Said once.</blockquote>',
      ),
    ).toBe('- Fish\n- *Rice*\n\n---\n\n1. One\n2. Two\n\nLine one\nLine two\n\n> Said once.');
  });

  test('a numbered list past nine lines its numbers up as the editor does', () => {
    const items = Array.from({ length: 10 }, (_, i) => `<li>Item ${i + 1}</li>`).join('');
    const md = htmlToMarkdown(`<ol>${items}</ol>`);
    expect(md.split('\n')[0]).toBe(' 1. Item 1');
    expect(md.split('\n')[9]).toBe('10. Item 10');
    expect(roundTrip(md)).toBe(md);
  });

  test('a scene break at the start or the end, or two in a row, adds nothing', () => {
    expect(htmlToMarkdown('<hr><p>One</p><hr><hr><p>Two</p><hr>')).toBe('One\n\n---\n\nTwo');
  });

  test('entities are decoded and Markdown characters in the text are escaped', () => {
    expect(htmlToMarkdown('<p>Fish &amp; chips &lt;3, 5 * 3, snake_case, _under_</p>')).toBe(
      'Fish & chips <3, 5 \\* 3, snake_case, \\_under\\_',
    );
    expect(htmlToMarkdown('<p># not a heading</p><p>- not a list</p><p>1. not a number</p>')).toBe(
      '\\# not a heading\n\n\\- not a list\n\n1\\. not a number',
    );
  });

  test('other tags keep their text; space inside a mark moves outside it', () => {
    expect(
      htmlToMarkdown(
        '<div><p><span style="color:red">Red</span> <u>under</u> <a href="x">link</a><strong> bold </strong>end</p></div>',
      ),
    ).toBe('Red under link **bold** end');
  });

  test('bold a style turns off, as Google Docs wraps a paste, is not bold', () => {
    expect(htmlToMarkdown('<b style="font-weight:normal"><p>Plain</p></b>')).toBe('Plain');
  });

  test('looksLikeHtml finds stored HTML and not a tag the writer escaped', () => {
    expect(looksLikeHtml('<p>Body</p>')).toBe(true);
    expect(looksLikeHtml('Line<br>line')).toBe(true);
    expect(looksLikeHtml('Plain text with 3 < 4 and a > b')).toBe(false);
    expect(looksLikeHtml('Typed \\<b> by hand')).toBe(false);
    expect(asMarkdown('Already *Markdown*')).toBe('Already *Markdown*');
    expect(asMarkdown('<p>Was <em>HTML</em></p>')).toBe('Was *HTML*');
  });
});

describe('A44 the editor reads and writes the same Markdown', () => {
  const stable = [
    'Plain text, as written before A44.',
    'Line one\nLine two\n\nA second paragraph.',
    '## Heading\n\nBody with **bold**, *italic* and ~~struck~~ words.',
    '### Lower heading\n\n- One\n- Two\n  - Nested\n\n1. First\n2. Second',
    '> A quote\n> over two lines\n\n---\n\nAfter the break.',
    'Escaped \\*stars\\* and \\_underscores\\_, snake_case, a \\\\ backslash.',
    '\\# not a heading\n\n\\- not a list\n\n1\\. not a list either',
    '@Wei Li met @Margaret Hale at the ferry.',
    'Brackets [stay] and `backticks` too, and \\<b> is typed text.',
    '晓曦和月饼 at **中秋**.',
  ];
  test.each(stable)('%j comes back the same', (md) => {
    expect(roundTrip(md)).toBe(md);
  });

  test('every shape the importer wrote, converted, comes back the same', () => {
    const shapes = [
      '<h1>T</h1><p>a <strong>b</strong> <em>c</em></p><ul><li>x</li><li>y</li></ul><hr><p>p<br>q</p>',
      '<h3>Deep</h3><ol><li>One</li><li><strong>Two</strong></li></ol><blockquote>q</blockquote>',
      '<p>Fish &amp; chips, 5 * 3, # one</p><p>- dash</p>',
    ];
    for (const html of shapes) {
      const md = htmlToMarkdown(html);
      expect(roundTrip(md)).toBe(md);
    }
  });

  test('a top-level heading reads as the upper level; deeper ones as the lower', () => {
    expect(roundTrip('# Top\n\n#### Deep')).toBe('## Top\n\n### Deep');
  });

  test('the parser keeps typed text: no code, links, images, tables or HTML', () => {
    const md = 'A `tick`, a [link](http://x), ![img](y), <b>tag</b>, &amp; an entity';
    const doc = parseMarkdown(full, md);
    expect(doc.textContent).toBe(
      'A `tick`, a [link](http://x), ![img](y), <b>tag</b>, &amp; an entity',
    );
    expect(roundTrip(roundTrip(md))).toBe(roundTrip(md));
  });

  test('an inline box keeps bold, italic and strikethrough and reads blocks as paragraphs', () => {
    expect(roundTrip('**Bold** and *italic*', inline)).toBe('**Bold** and *italic*');
    expect(roundTrip('## Heading\n\n- item', inline)).toBe('Heading\n\nitem');
  });

  test('an empty box is an empty string', () => {
    expect(roundTrip('')).toBe('');
    expect(serializeMarkdown(full.topNodeType.createAndFill()!)).toBe('');
  });
});

describe('A44 Markdown as plain text, for search and briefs', () => {
  test('marks go, blocks are lines, a scene break is * * *', () => {
    expect(markdownToText('## Fog\n\nThe **harbour** was *quiet*.\n\n---\n\n- Fish\n- Rice')).toBe(
      'Fog\nThe harbour was quiet.\n* * *\nFish\nRice',
    );
    expect(plainText('Escaped \\*stars\\*')).toBe('Escaped *stars*');
  });

  test('HTML stored before A44 reads as it did', () => {
    const html = '<p>One &amp; two</p><hr><p>Three<br>four</p>';
    expect(plainText(html)).toBe('One & two\n* * *\nThree\nfour');
    expect(plain(html)).toBe(plainText(html));
  });

  test('plain text with no marks is only tidied', () => {
    expect(plainText('  One  two\n\n\nthree ')).toBe('One two\nthree');
  });

  test('the escape leaves what this Markdown does not read', () => {
    expect(escapeMarkdown('[a] `b` 3 < 4', false)).toBe('[a] `b` 3 < 4');
    expect(escapeMarkdown('<p>', false)).toBe('\\<p>');
  });
});
