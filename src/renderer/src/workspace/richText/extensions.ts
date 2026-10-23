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
import { Plugin } from '@tiptap/pm/state';

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

export function richExtensions(mode: RichMode): AnyExtension[] {
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
    ...(full ? [HeadingKeys] : []),
  ];
}
