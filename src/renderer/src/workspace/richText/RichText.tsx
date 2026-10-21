/**
 * A44: the rich text box every long text field uses. It stores Markdown and
 * shows it formatted, never as marks or tags. Typing `## `, `**bold**`,
 * `- ` and the like formats as you go; Cmd+B, Cmd+I and Cmd+Alt+2, 3 and 0
 * do the same; selecting text shows a small toolbar. The box grows with its
 * text up to about two thirds of the window, then scrolls.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { PickerList, pickerKeys, useSearch } from '../pickers';
import { registerTextTarget } from '../undo';
import { mentionKey, richExtensions } from './extensions';
import type { RichMode } from './extensions';
import { parseMarkdown, serializeMarkdown } from './markdown';
import './richText.css';

/** What ProseMirror reads a non-text node as, so a mention query never spans one. */
const OBJECT_CHAR = String.fromCharCode(0xfffc);

export type RichSize = 'prose' | 'notes' | 'quick';

/** What an owner can do to the box: put the caret in it, at the end. */
export interface RichTextHandle {
  focus(): void;
}

type Hit = Parameters<Parameters<typeof PickerList>[0]['onPick']>[0];

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
  /** ED-9: `@` opens a search; a pick inserts `@Title` and calls this with the entry. */
  onMention?: (hit: { id: string; title: string }) => void;
  /** Titles of linked entries, shown as chips where the text says `@Title`. */
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
    onMention,
  } = props;
  const listId = useId();
  const readOnly = useReadOnly();
  const editable = !disabled && readOnly === null;

  // The editor is made once; this ref lets its callbacks see the latest props and state.
  const [mention, setMention] = useState<{ from: number; to: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const hits = useSearch(mention ? mention.query : null);
  const latest = {
    onChange: props.onChange,
    onBlur: props.onBlur,
    onFocus: props.onFocus,
    onKeyDown: props.onKeyDown,
    onMention,
    mention,
    hits,
    active,
  };
  const live = useRef(latest);
  useEffect(() => {
    live.current = latest;
  });
  /** The last Markdown this box sent or was given, so its own echo never resets it. */
  const last = useRef(value);
  /** Linked titles the chips look for, read by the editor's plugin when it draws them. */
  const [titles] = useState(() => {
    let list: readonly string[] = props.mentionTitles ?? [];
    return {
      get: () => list,
      set: (next: readonly string[]) => {
        list = next;
      },
    };
  });

  const extensions = useMemo(() => richExtensions(mode, titles.get), [mode, titles]);
  const initial = useMemo(
    () => parseMarkdown(getSchema(extensions), asMarkdown(value)).toJSON(),
    // Only the first value seeds the editor; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensions],
  );

  const detect = (e: Editor) => {
    if (!live.current.onMention) return;
    const { $from, empty } = e.state.selection;
    if (!empty || !e.isFocused) {
      setMention(null);
      return;
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, OBJECT_CHAR);
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
    const query = m?.[2];
    if (query === undefined) setMention(null);
    else {
      setMention((cur) =>
        cur && cur.query === query
          ? cur
          : { from: $from.pos - query.length - 1, to: $from.pos, query },
      );
      if (live.current.mention?.query !== query) setActive(0);
    }
  };

  const pickRef = useRef<(hit: Hit) => void>(() => {});

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
        handleKeyDown: (_view, event) => {
          const l = live.current;
          if (!l.mention) return l.onKeyDown?.(event) ?? false;
          return pickerKeys(
            event,
            l.hits,
            l.active,
            setActive,
            (h) => pickRef.current(h),
            () => setMention(null),
          );
        },
        handleDOMEvents: {
          // ProseMirror marks Escape as handled; here it closes the `@` list, or else goes on
          // to the dialog or panel around the box, which close on it.
          keydown: (_view, event) => {
            if (event.key !== 'Escape') return false;
            const l = live.current;
            if (l.mention) {
              event.preventDefault();
              setMention(null);
            } else l.onKeyDown?.(event);
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
        detect(e);
      },
      onSelectionUpdate: ({ editor: e }) => detect(e),
      onFocus: () => live.current.onFocus?.(),
      onBlur: () => {
        setMention(null);
        live.current.onBlur?.();
      },
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

  useEffect(() => {
    pickRef.current = (hit: Hit) => {
      const m = live.current.mention;
      if (!editor || !m) return;
      titles.set([...titles.get(), hit.title]);
      editor.view.dispatch(editor.state.tr.insertText(`@${hit.title} `, m.from, m.to));
      setMention(null);
      live.current.onMention?.({ id: hit.id, title: hit.title });
      editor.commands.focus();
    };
  }, [editor, titles]);

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

  const titleKey = (props.mentionTitles ?? []).join('\u0000');
  useEffect(() => {
    titles.set(props.mentionTitles ?? []);
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(mentionKey, true));
    // titleKey stands for the titles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, titleKey]);

  const empty = useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true });

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.setAttribute('aria-disabled', String(!editable));
    dom.setAttribute('aria-readonly', String(!editable));
    if (mention) dom.setAttribute('aria-controls', listId);
    else dom.removeAttribute('aria-controls');
    // ARCH-6: while a snapshot is open read-only the box says why, as other write controls do.
    const described = [props.describedBy, readOnly ? READ_ONLY_NOTE_ID : null].filter(Boolean);
    if (described.length) dom.setAttribute('aria-describedby', described.join(' '));
    else dom.removeAttribute('aria-describedby');
    if (readOnly) dom.setAttribute('title', readOnly);
    else dom.removeAttribute('title');
  }, [editor, editable, mention, listId, props.describedBy, readOnly]);

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
      {mention && (
        <PickerList
          hits={hits}
          active={active}
          onPick={(h) => pickRef.current(h)}
          id={listId}
          query={mention.query}
        />
      )}
    </div>
  );
}
