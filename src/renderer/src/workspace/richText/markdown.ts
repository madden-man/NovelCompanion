/**
 * A44: the editor's document to and from the app's Markdown string. The
 * parser reads the shared dialect (`src/shared/domain/markdown`); the
 * serializer writes the same dialect back, so a body read and written with
 * no edit comes back as the same string once it is in this form.
 */
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import type { ParseSpec } from 'prosemirror-markdown';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { escapeMarkdown, headingLevel, markdown } from '../../../../shared/domain/markdown';

// The app's escaping: only what this dialect reads as markup, so brackets,
// backticks and the like stay as typed. A line after a line break counts as
// the start of a line, since a single break is a break here.
const state = MarkdownSerializerState.prototype as unknown as {
  esc(str: string, startOfLine?: boolean): string;
  out: string;
};
state.esc = function esc(this: { out: string }, str: string, startOfLine?: boolean) {
  return escapeMarkdown(str, Boolean(startOfLine) || /(^|\n)[ >]*$/.test(this.out));
};

const parsers = new WeakMap<Schema, MarkdownParser>();

function parserFor(schema: Schema): MarkdownParser {
  const cached = parsers.get(schema);
  if (cached) return cached;
  const has = (n: string) => Boolean(schema.nodes[n]);
  const ignore: ParseSpec = { ignore: true };
  const tokens: Record<string, ParseSpec> = {
    paragraph: { block: 'paragraph' },
    heading: has('heading')
      ? { block: 'heading', getAttrs: (tok) => ({ level: headingLevel(tok.tag) }) }
      : { block: 'paragraph' },
    bullet_list: has('bulletList') ? { block: 'bulletList' } : ignore,
    ordered_list: has('orderedList')
      ? { block: 'orderedList', getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1 }) }
      : ignore,
    list_item: has('listItem') ? { block: 'listItem' } : ignore,
    blockquote: has('blockquote') ? { block: 'blockquote' } : ignore,
    hr: has('horizontalRule') ? { node: 'horizontalRule' } : { ignore: true, noCloseToken: true },
    hardbreak: { node: 'hardBreak' },
    softbreak: { node: 'hardBreak' },
    strong: { mark: 'bold' },
    em: { mark: 'italic' },
    s: { mark: 'strike' },
  };
  const parser = new MarkdownParser(schema, markdown, tokens);
  parsers.set(schema, parser);
  return parser;
}

/** The editor document for a Markdown string. */
export function parseMarkdown(schema: Schema, text: string): PMNode {
  return parserFor(schema).parse(text);
}

const serializer = new MarkdownSerializer(
  {
    paragraph(s, node) {
      s.renderInline(node);
      s.closeBlock(node);
    },
    heading(s, node) {
      s.write(`${'#'.repeat(node.attrs.level === 3 ? 3 : 2)} `);
      s.renderInline(node, false);
      s.closeBlock(node);
    },
    blockquote(s, node) {
      s.wrapBlock('> ', null, node, () => s.renderContent(node));
    },
    horizontalRule(s, node) {
      s.write('---');
      s.closeBlock(node);
    },
    bulletList(s, node) {
      s.renderList(node, '  ', () => '- ');
    },
    orderedList(s, node) {
      const start = Number(node.attrs.start) || 1;
      const width = String(start + node.childCount - 1).length;
      const space = ' '.repeat(width + 2);
      s.renderList(node, space, (i) => `${String(start + i).padStart(width, ' ')}. `);
    },
    listItem(s, node) {
      s.renderContent(node);
    },
    hardBreak(s, node, parent, index) {
      // A break at the very end of a block adds nothing; in a heading it is a space.
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          s.write(parent.type.name === 'heading' ? ' ' : '\n');
          return;
        }
      }
    },
    text(s, node) {
      s.text(node.text ?? '');
    },
  },
  {
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  },
  { hardBreakNodeName: 'hardBreak', strict: false },
);

/** The Markdown string for an editor document. Empty paragraphs and trailing space go. */
export function serializeMarkdown(doc: PMNode): string {
  return serializer.serialize(doc, { tightLists: true }).replace(/\s+$/, '');
}
