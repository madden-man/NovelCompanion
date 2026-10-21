/**
 * A44: what a rich text box can hold. Full boxes (prose) take headings at two
 * levels, bold, italic, strikethrough, lists, quotes and scene breaks; inline
 * boxes (line notes, moment notes) take bold, italic and strikethrough only.
 * No code, links, underline, fonts or colours.
 */
import { Extension } from '@tiptap/core';
import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { history } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export type RichMode = 'full' | 'inline';

/**
 * The editor's own history, with no keys: Cmd+Z and Shift+Cmd+Z go through
 * the app's undo (ED-3, `undo.tsx`), which steps this history while the box
 * holds unsaved typing and the app's history after that.
 */
const TextHistory = Extension.create({
  name: 'textHistory',
  addProseMirrorPlugins() {
    return [history({ depth: 200, newGroupDelay: 500 })];
  },
});

export const mentionKey = new PluginKey<DecorationSet>('mentionChips');

/** Where `@Title` names a linked entry, longest title first. */
export function mentionRanges(doc: PMNode, titles: readonly string[]) {
  const sorted = [...new Set(titles.filter((t) => t.trim()))].sort((a, b) => b.length - a.length);
  const out: { from: number; to: number }[] = [];
  if (!sorted.length) return out;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
      const hit = sorted.find((t) => text.startsWith(t, i + 1));
      if (hit) {
        out.push({ from: pos + i, to: pos + i + 1 + hit.length });
        i += hit.length;
      }
    }
  });
  return out;
}

function chips(state: EditorState, titles: readonly string[]): DecorationSet {
  return DecorationSet.create(
    state.doc,
    mentionRanges(state.doc, titles).map((r) =>
      Decoration.inline(r.from, r.to, { class: 'mention-chip', 'data-mention': '' }),
    ),
  );
}

/** `@Title` of a linked entry shows as a chip; the text stays `@Title` (ED-9). */
function MentionChips(titles: () => readonly string[]) {
  return Extension.create({
    name: 'mentionChips',
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: mentionKey,
          state: {
            init: (_, state) => chips(state, titles()),
            apply: (tr, old, _prev, state) =>
              tr.docChanged || tr.getMeta(mentionKey) ? chips(state, titles()) : old,
          },
          props: {
            decorations: (state) => mentionKey.getState(state),
          },
        }),
      ];
    },
  });
}

/**
 * Cmd+Alt+2 and 3 make a heading and Cmd+Alt+0 body text, read from the key's
 * place on the keyboard: with Alt held a Mac types a symbol, not the digit.
 */
const HeadingKeys = Extension.create({
  name: 'headingKeys',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, event) => {
            if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return false;
            const digit = /^Digit([023])$/.exec(event.code)?.[1];
            if (!digit) return false;
            event.preventDefault();
            if (digit === '0') return editor.commands.setParagraph();
            return editor.commands.toggleHeading({ level: digit === '2' ? 2 : 3 });
          },
        },
      }),
    ];
  },
});

export function richExtensions(
  mode: RichMode,
  titles: () => readonly string[] = () => [],
): AnyExtension[] {
  const full = mode === 'full';
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      link: false,
      underline: false,
      undoRedo: false,
      trailingNode: false,
      dropcursor: false,
      heading: full ? { levels: [2, 3] } : false,
      bulletList: full ? {} : false,
      orderedList: full ? {} : false,
      listItem: full ? {} : false,
      listKeymap: full ? {} : false,
      blockquote: full ? {} : false,
      horizontalRule: full ? {} : false,
    }),
    TextHistory,
    MentionChips(titles),
    ...(full ? [HeadingKeys] : []),
  ];
}
