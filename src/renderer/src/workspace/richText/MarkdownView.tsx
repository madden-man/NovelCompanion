/**
 * A44: the one read-only view of a stored long text, so a body looks the same
 * on every screen: headings, bold, italic, strikethrough, lists, quotes and
 * scene breaks, with Chinese runs that show their meaning (GL-3). Text from
 * before A44 that is still HTML is read as Markdown first. Nothing is ever
 * set as raw HTML.
 */
import { Fragment, useMemo } from 'react';
import type { ReactNode } from 'react';
import { asMarkdown, headingLevel, markdownTokens } from '../../../../shared/domain/markdown';
import type { MarkdownToken } from '../../../../shared/domain/markdown';
import { Zh, hasCjk } from '../Zh';
import './richText.css';

interface El {
  tag: string;
  start?: number;
  kids: (El | string)[];
}

const BLOCK_TAGS: Record<string, string> = {
  paragraph_open: 'p',
  bullet_list_open: 'ul',
  ordered_list_open: 'ol',
  list_item_open: 'li',
  blockquote_open: 'blockquote',
  strong_open: 'strong',
  em_open: 'em',
  s_open: 's',
};

function walk(tokens: readonly MarkdownToken[], stack: El[]): void {
  for (const t of tokens) {
    const top = stack[stack.length - 1] as El;
    if (t.type === 'inline') walk(t.children ?? [], stack);
    else if (t.type === 'text') top.kids.push(t.content);
    else if (t.type === 'softbreak' || t.type === 'hardbreak')
      top.kids.push({ tag: 'br', kids: [] });
    else if (t.type === 'hr') top.kids.push({ tag: 'hr', kids: [] });
    else if (t.nesting === 1) {
      const tag =
        t.type === 'heading_open'
          ? `h${headingLevel(t.tag)}`
          : t.hidden
            ? '#fragment'
            : (BLOCK_TAGS[t.type] ?? 'span');
      const el: El = { tag, kids: [] };
      if (t.type === 'ordered_list_open') el.start = Number(t.attrGet('start')) || 1;
      top.kids.push(el);
      stack.push(el);
    } else if (t.nesting === -1 && stack.length > 1) stack.pop();
  }
}

function tree(text: string): El {
  const root: El = { tag: '#root', kids: [] };
  walk(markdownTokens(asMarkdown(text)), [root]);
  return root;
}

/** In a line of text, blocks become runs separated by spaces and a scene break a mark. */
const INLINE_BLOCKS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);

const isRun = (n: El | string) =>
  typeof n !== 'string' && (INLINE_BLOCKS.has(n.tag) || n.tag === 'hr' || n.tag === '#fragment');

/** Children in order; in a line of text, a space between two blocks that run on. */
function children(nodes: readonly (El | string)[], key: string, inline: boolean): ReactNode[] {
  return nodes.map((k, i) => {
    const r = render(k, `${key}.${i}`, inline);
    const prev = nodes[i - 1];
    return inline && prev !== undefined && isRun(prev) && isRun(k) ? (
      <Fragment key={`${key}.${i}`}> {r}</Fragment>
    ) : (
      r
    );
  });
}

function render(node: El | string, key: string, inline: boolean): ReactNode {
  if (typeof node === 'string') return <Zh key={key} text={node} />;
  const kids = children(node.kids, key, inline);
  if (node.tag === '#fragment') return <Fragment key={key}>{kids}</Fragment>;
  if (inline) {
    if (node.tag === 'br') return ' ';
    if (node.tag === 'hr') return <span key={key}>* * *</span>;
    if (INLINE_BLOCKS.has(node.tag)) return <span key={key}>{kids}</span>;
  }
  switch (node.tag) {
    case 'br':
      return <br key={key} />;
    case 'hr':
      return <hr key={key} />;
    case 'ol':
      return (
        <ol key={key} start={node.start === 1 ? undefined : node.start}>
          {kids}
        </ol>
      );
    default: {
      const Tag = node.tag as 'p';
      return <Tag key={key}>{kids}</Tag>;
    }
  }
}

/**
 * A stored long text, formatted. `inline` keeps it inside a line (a table
 * cell, a list row): bold, italic and strikethrough stay, blocks run on.
 */
export function MarkdownView(props: { text: string; inline?: boolean; className?: string }) {
  const { text, inline = false } = props;
  const root = useMemo(() => tree(text), [text]);
  const kids = children(root.kids, 'md', inline);
  if (inline) return <span className={props.className}>{kids}</span>;
  return <div className={`md-body${props.className ? ` ${props.className}` : ''}`}>{kids}</div>;
}

/**
 * GL-3: a read-only preview beside a long text box that holds Chinese
 * characters, so the characters can be hovered or focused for their meaning.
 */
export function ZhPreview({ text }: { text: string }) {
  if (!hasCjk(text)) return null;
  return (
    <div className="zh-preview" data-testid="zh-preview" aria-label="Preview with meanings">
      <span className="eyebrow">Preview with meanings</span>
      <MarkdownView text={text} className="zh-html" />
    </div>
  );
}
