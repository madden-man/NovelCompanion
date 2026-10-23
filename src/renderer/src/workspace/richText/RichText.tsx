/**
 * A44: the rich text box every long text field uses. It stores Markdown and
 * shows it formatted, never as marks or tags. Typing `## `, `**bold**`,
 * `- ` and the like formats as you go; Cmd+B, Cmd+I and Cmd+Alt+2, 3 and 0
 * do the same; selecting text shows a small toolbar. The box grows with its
 * text up to about two thirds of the window, then scrolls.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { Ref } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { getSchema } from '@tiptap/core';
import { redo, undo, undoDepth, redoDepth } from '@tiptap/pm/history';
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import { asMarkdown } from '../../../../shared/domain/markdown';
import { READ_ONLY_NOTE_ID, useReadOnly } from '../../connection';
import { registerTextTarget } from '../undo';
import { richExtensions } from './extensions';
import type { RichMode } from './extensions';
import { parseMarkdown, serializeMarkdown } from './markdown';
import './richText.css';

export type RichSize = 'prose' | 'notes' | 'quick';

/** What an owner can do to the box: put the caret in it, at the end. */
export interface RichTextHandle {
  focus(): void;
}

export interface RichTextProps {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  /** A key the box's owner handles first (Enter to save a table cell); true when it did. */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** `full` for prose; `inline` keeps to bold, italic and strikethrough. */
  mode?: RichMode;
  /** The smallest height: prose about six lines, notes three, quick inputs two. */
  size?: RichSize;
  /** The ID of the visible label, or a label when there is none to point at. */
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  testId?: string;
  className?: string;
  placeholder?: string;
  /** A53 shim, wave 3 deletes it: `@` types an `@` (A52), so nothing calls this. */
  onMention?: (hit: { id: string; title: string }) => void;
  /** A53 shim, wave 3 deletes it: no mention chips are drawn (A52). */
  mentionTitles?: readonly string[];
  handle?: Ref<RichTextHandle>;
}

/** Headings pasted from Word or Google Docs land on the two levels the box has. */
function pastedHeadings(html: string): string {
  return html.replace(/<(\/?)h1(\s|>)/gi, '<$1h2$2').replace(/<(\/?)h[4-6](\s|>)/gi, '<$1h3$2');
}

function BubbleButtons({ editor, mode }: { editor: Editor; mode: RichMode }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      list: e.isActive('bulletList'),
      quote: e.isActive('blockquote'),
    }),
  });
  const button = (label: string, pressed: boolean, run: () => void, title?: string) => (
    <button
      key={label}
      type="button"
      className="rich-tool"
      aria-pressed={pressed}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  const chain = () => editor.chain().focus();
  return (
    <>
      {button('Bold', active.bold, () => chain().toggleBold().run(), 'Bold (Cmd+B)')}
      {button('Italic', active.italic, () => chain().toggleItalic().run(), 'Italic (Cmd+I)')}
      {mode === 'full' &&
        button(
          active.h3 ? 'Heading 3' : 'Heading',
          active.h2 || active.h3,
          () =>
            active.h2
              ? chain().setHeading({ level: 3 }).run()
              : active.h3
                ? chain().setParagraph().run()
                : chain().setHeading({ level: 2 }).run(),
          'Heading (Cmd+Alt+2, Cmd+Alt+3; Cmd+Alt+0 for body text)',
        )}
      {mode === 'full' && button('List', active.list, () => chain().toggleBulletList().run())}
      {mode === 'full' && button('Quote', active.quote, () => chain().toggleBlockquote().run())}
      {button('Strike', active.strike, () => chain().toggleStrike().run(), 'Strikethrough')}
    </>
  );
}

export function RichText(props: RichTextProps) {
  const {
    value,
    mode = 'full',
    size = mode === 'inline' ? 'quick' : 'prose',
    disabled = false,
  } = props;
  const readOnly = useReadOnly();
  const editable = !disabled && readOnly === null;

  // The editor is made once; this ref lets its callbacks see the latest props and state.
  const latest = {
    onChange: props.onChange,
    onBlur: props.onBlur,
    onFocus: props.onFocus,
    onKeyDown: props.onKeyDown,
  };
  const live = useRef(latest);
  useEffect(() => {
    live.current = latest;
  });
  /** The last Markdown this box sent or was given, so its own echo never resets it. */
  const last = useRef(value);
  const extensions = useMemo(() => richExtensions(mode), [mode]);
  const initial = useMemo(
    () => parseMarkdown(getSchema(extensions), asMarkdown(value)).toJSON(),
    // Only the first value seeds the editor; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensions],
  );

  const editor = useEditor(
    {
      extensions,
      content: initial,
      editable,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          ...(props.labelledBy ? { 'aria-labelledby': props.labelledBy } : {}),
          ...(props.label ? { 'aria-label': props.label } : {}),
          ...(props.testId ? { 'data-testid': props.testId } : {}),
          ...(props.placeholder ? { 'data-placeholder': props.placeholder } : {}),
          class: `rich-text-input rich-${size}`,
          spellcheck: 'true',
        },
        transformPastedHTML: pastedHeadings,
        clipboardTextParser: (text, _context, plain, view) => {
          // Pasted Markdown reads as formatting; Shift+Cmd+V pastes the characters as they are.
          if (plain) return null as unknown as Slice;
          const doc = parseMarkdown(view.state.schema, text);
          return Slice.maxOpen(doc.content);
        },
        handleKeyDown: (_view, event) => live.current.onKeyDown?.(event) ?? false,
        handleDOMEvents: {
          // ProseMirror marks Escape as handled; here it goes on to the dialog or panel
          // around the box, which close on it.
          keydown: (_view, event) => {
            if (event.key !== 'Escape') return false;
            live.current.onKeyDown?.(event);
            return true;
          },
        },
      },
      onUpdate: ({ editor: e }) => {
        const md = serializeMarkdown(e.state.doc);
        if (md !== last.current) {
          last.current = md;
          live.current.onChange(md);
        }
      },
      onFocus: () => live.current.onFocus?.(),
      onBlur: () => live.current.onBlur?.(),
    },
    [extensions],
  );

  // The caret goes to the end at once; the editor's own focus command waits a frame, which a
  // hidden or busy window may hold back.
  const focusEnd = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
  }, [editor]);
  useImperativeHandle(props.handle, () => ({ focus: focusEnd }), [focusEnd]);
  const autoFocus = props.autoFocus === true;
  useEffect(() => {
    if (autoFocus) focusEnd();
  }, [autoFocus, focusEnd]);

  // A value from outside (an undo, another screen, a re-import) replaces the text and
  // starts the box's own history afresh, as a native text area does.
  useEffect(() => {
    if (!editor || value === last.current) return;
    last.current = value;
    const doc = parseMarkdown(editor.schema, asMarkdown(value));
    const state = EditorState.create({ doc, plugins: editor.state.plugins });
    const at = Math.min(editor.state.selection.from, doc.content.size);
    editor.view.updateState(
      state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(at)))),
    );
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  const empty = useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true });

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.setAttribute('aria-disabled', String(!editable));
    dom.setAttribute('aria-readonly', String(!editable));
    // ARCH-6: while a snapshot is open read-only the box says why, as other write controls do.
    const described = [props.describedBy, readOnly ? READ_ONLY_NOTE_ID : null].filter(Boolean);
    if (described.length) dom.setAttribute('aria-describedby', described.join(' '));
    else dom.removeAttribute('aria-describedby');
    if (readOnly) dom.setAttribute('title', readOnly);
    else dom.removeAttribute('title');
  }, [editor, editable, props.describedBy, readOnly]);

  // ED-3: Cmd+Z steps this box's history while it holds unsaved typing.
  useEffect(() => {
    if (!editor) return;
    return registerTextTarget(editor.view.dom, {
      value: () => serializeMarkdown(editor.state.doc),
      undo: () => undoDepth(editor.state) > 0 && undo(editor.state, editor.view.dispatch),
      redo: () => redoDepth(editor.state) > 0 && redo(editor.state, editor.view.dispatch),
    });
  }, [editor]);

  return (
    <div
      className={`rich-text${editable ? '' : ' is-disabled'}${empty ? ' is-empty' : ''}${props.className ? ` ${props.className}` : ''}`}
      data-rich={mode}
    >
      {editor && editable && (
        <BubbleMenu
          editor={editor}
          className="rich-bubble"
          role="toolbar"
          aria-label="Formatting"
          options={{ placement: 'top', offset: 6 }}
        >
          <BubbleButtons editor={editor} mode={mode} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
