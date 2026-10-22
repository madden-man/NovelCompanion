/**
 * IP-1: the one editing primitive. A stored value reads as text (or a
 * placeholder in the primary text colour) until it is picked with a click,
 * Enter or Space; then a field of the same font and size takes its place.
 * Enter or blur saves, Escape puts the old value back, and nothing around it
 * moves, scrolls or is covered by a dialog. A tick shows for about a second
 * after a save; a value that cannot be stored keeps the field open with the
 * reason under it. Read-only (ARCH-6, or `disabled` with a `reason`) shows the
 * text and never opens.
 */
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { DateBox } from '../../../../shared/domain/dates';
import { deepEqual } from '../../../../shared/domain/paths';
import type { StoryDate } from '../../../../shared/schema';
import { READ_ONLY_NOTE_ID, useReadOnly } from '../../connection';
import { plainError } from '../../api';
import { MarkdownView } from '../richText/MarkdownView';
import { RichText } from '../richText/RichText';
import type { RichSize } from '../richText/RichText';
import type { RichMode } from '../richText/extensions';
import { useUndo } from '../undo';
import {
  ADD_NEW,
  ADD_NEW_LABEL,
  addNewReducer,
  chipChoices,
  draftText,
  parseDate,
  parseNumber,
  parseText,
  parseYear,
  shownText,
} from './model';
import type { AddedItem, EditableOption, Parsed, SaveInfo } from './model';
import './editable.css';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** How long the saved tick shows. */
export const SAVED_TICK_MS = 1200;

/** A note shown under the field after it saved, such as an ED-10 warning. */
export interface EditableNote {
  message: string;
  code?: string;
}

export interface EditableCommonProps {
  /** The accessible name, the visible label with `showLabel`, and the noun of the undo step. */
  label: string;
  /** What the closed field shows when it holds nothing. Drawn in the primary text colour. */
  placeholder?: string;
  /** Read-only: the text shows, the field never opens, and `reason` is its title. */
  disabled?: boolean;
  reason?: string;
  /** `inline` sits in a line of text; `block` takes its own box. Rich text and chips default to block. */
  layout?: 'inline' | 'block';
  /** Draw `label` before the value, for a line of labelled values such as Birth and Death. */
  showLabel?: boolean;
  testId?: string;
  /** Passed through to the root, so Cmd+Z and `undo.markSaved` find the field (ED-3). */
  'data-field'?: string;
  className?: string;
  /** How the closed field draws its text (for example with Chinese runs); gets the shown text. */
  display?: (shown: string) => ReactNode;
  /** Notes to show under the field, such as the ED-10 warnings at its path. */
  notes?: readonly EditableNote[];
  /** Open the field as soon as it mounts, for a rename or a new row. */
  autoOpen?: boolean;
  /** Called when the field closes: after a save, or with nothing saved. */
  onClose?: (how: 'saved' | 'unchanged') => void;
}

type Save<T> = (next: T, info: SaveInfo) => Promise<void>;

export type EditableKindProps =
  | { kind: 'text'; value: string; onSave: Save<string>; allowEmpty?: boolean }
  | { kind: 'year'; value: number | null; onSave: Save<number | null>; allowEmpty?: boolean }
  | {
      kind: 'number';
      value: number | null;
      onSave: Save<number | null>;
      allowEmpty?: boolean;
      integer?: boolean;
      min?: number;
      max?: number;
    }
  | {
      kind: 'rich';
      value: string;
      onSave: Save<string>;
      allowEmpty?: boolean;
      mode?: RichMode;
      size?: RichSize;
    }
  | {
      kind: 'select';
      value: string | null;
      onSave: Save<string | null>;
      options: readonly EditableOption[];
      /** Shows "Add new..." last; makes the item and returns it, then the field saves its ID. */
      onAddNew?: (label: string) => Promise<AddedItem>;
      /** Offer a None choice that saves null. */
      allowEmpty?: boolean;
      emptyLabel?: string;
    }
  | {
      kind: 'chips';
      value: readonly string[];
      onSave: Save<string[]>;
      options: readonly EditableOption[];
      onAddNew?: (label: string) => Promise<AddedItem>;
      /** The add button's words, "Add to <label>" when not given. */
      addLabel?: string;
      /** The picker box's accessible name, "<addLabel>" when not given. */
      pickerLabel?: string;
    }
  | {
      kind: 'date';
      value: StoryDate | null;
      onSave: Save<StoryDate | null>;
      /** Blank means unknown for a birth (`birth`), no date for anything else (`death`, the default). */
      dateBox?: DateBox;
    };

export type EditableProps = EditableCommonProps & EditableKindProps;

/**
 * Where every scrolled box above an element sits, and a function that holds
 * them there for a moment. Traced (2026-10-22): when the text of an open
 * field shrinks (Backspace, or Cmd+Z stepping typing back, ED-3), Chromium
 * starts a smooth scroll of the editor pane to its foot. No script calls a
 * scroll API (every scroll method and the scrollTop setter were logged), no
 * element remounts, and a plain input in the same heading does not do it, so
 * the cause sits in the browser. The hold puts the pane back and lets go
 * after 800 ms, or at once when the writer scrolls, touches, or presses a key
 * anywhere but in the field.
 */
function scrollHold(el: Element): () => void {
  const saved: [Element, number, number][] = [];
  for (let e = el.parentElement; e; e = e.parentElement) {
    if (e.scrollTop || e.scrollLeft || e.scrollHeight > e.clientHeight) {
      saved.push([e, e.scrollTop, e.scrollLeft]);
    }
  }
  return () => {
    const hold = () => {
      for (const [e, top, left] of saved) {
        if (e.scrollTop !== top || e.scrollLeft !== left) {
          e.scrollTo({ top, left, behavior: 'instant' });
        }
      }
    };
    const release = (e?: Event) => {
      // Keys typed into the field itself never scroll the pane; any other key may.
      if (e?.type === 'keydown' && e.target === el) return;
      clearTimeout(timer);
      for (const [e] of saved) e.removeEventListener('scroll', hold);
      for (const t of ['wheel', 'touchstart', 'keydown'] as const) {
        window.removeEventListener(t, release, true);
      }
    };
    const timer = setTimeout(release, 800);
    hold();
    for (const [e] of saved) e.addEventListener('scroll', hold);
    for (const t of ['wheel', 'touchstart', 'keydown'] as const) {
      window.addEventListener(t, release, true);
    }
  };
}

/** Read what was typed into the value this kind stores. */
function parse(p: EditableKindProps, text: string, label: string): Parsed<unknown> {
  switch (p.kind) {
    case 'text':
      return parseText(text, p.allowEmpty ?? true, label);
    case 'rich':
      return parseText(text, p.allowEmpty ?? true, label);
    case 'year':
      return parseYear(text, p.allowEmpty ?? false);
    case 'number':
      return parseNumber(text, p);
    case 'date':
      return parseDate(text, p.dateBox ?? 'death');
    case 'select':
    case 'chips':
      return { ok: true, value: text };
  }
}

/** The stored value as a save compares it: a missing birth is an unknown one. */
function storedFor(p: EditableKindProps, value: unknown): unknown {
  if (p.kind === 'date' && p.dateBox === 'birth') return value ?? { unknown: true };
  return value ?? null;
}

function useSaveState() {
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const set = (s: SaveState) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState(s);
    if (s === 'saved') timer.current = setTimeout(() => setState('idle'), SAVED_TICK_MS);
  };
  return [state, set] as const;
}

export function Editable(props: EditableProps) {
  const { label, kind } = props;
  const readOnly = useReadOnly();
  const undo = useUndo();
  const off = props.disabled === true || readOnly !== null;
  const why = props.disabled ? props.reason : (readOnly ?? undefined);
  const layout = props.layout ?? (kind === 'rich' || kind === 'chips' ? 'block' : 'inline');
  const errorId = useId();
  const labelId = useId();
  // `autoOpen` opens the field on its first render, for a rename or a new row.
  const startsOpen = props.autoOpen === true && !off;
  const [open, setOpen] = useState(startsOpen && kind !== 'chips');
  const [draft, setDraft] = useState(() => (startsOpen ? draftText(kind, props.value) : ''));
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useSaveState();
  const [addNew, dispatch] = useReducer(
    addNewReducer,
    startsOpen && kind === 'chips' ? { step: 'choosing', query: '' } : { step: 'closed' },
  );
  /** The value just saved, shown until the host's value catches up. */
  const [pending, setPending] = useState<{ value: unknown } | null>(null);
  const valueKey = JSON.stringify(props.value ?? null);
  const [seenKey, setSeenKey] = useState(valueKey);
  if (seenKey !== valueKey) {
    // Adjusted during render: a new value from the host (a save landing, an undo) replaces the pending one.
    setSeenKey(valueKey);
    setPending(null);
  }
  const value = pending ? pending.value : props.value;

  const displayRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Set while a save runs or after Escape, so the blur that follows does not save again. */
  const busy = useRef(false);
  /** An item Add new made whose pick has not saved yet; a retry picks it again. */
  const created = useRef<AddedItem | null>(null);
  const settled = useRef(false);
  const refocus = useRef<'display' | 'add' | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (open || addNew.step !== 'closed') return;
    const target = refocus.current;
    refocus.current = null;
    // The focus comes back where it was; nothing scrolls (IP-1).
    if (target === 'display') displayRef.current?.focus({ preventScroll: true });
    if (target === 'add') addButtonRef.current?.focus({ preventScroll: true });
  }, [open, addNew.step]);

  // An opened field takes the focus without scrolling the page (IP-1), so no autoFocus.
  const typing = (open && kind !== 'select' && kind !== 'rich') || addNew.step === 'naming';
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!typing || !el || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [typing]);

  // Every edit of the open text keeps the pane where it was (see scrollHold).
  useEffect(() => {
    const el = inputRef.current;
    if (!typing || !el) return;
    let hold: () => void = () => undefined;
    const before = () => {
      hold = scrollHold(el);
    };
    const after = () => hold();
    el.addEventListener('beforeinput', before);
    el.addEventListener('input', after);
    return () => {
      el.removeEventListener('beforeinput', before);
      el.removeEventListener('input', after);
    };
  }, [typing]);

  const selectOpen = kind === 'select' && open && addNew.step === 'closed';
  useEffect(() => {
    const el = selectRef.current;
    if (!selectOpen || !el) return;
    el.focus({ preventScroll: true });
    try {
      el.showPicker();
    } catch {
      // Not every window can show the list at once; the focused select opens on Space.
    }
  }, [selectOpen]);

  const options = props.kind === 'select' || props.kind === 'chips' ? props.options : [];
  const shown = shownText(kind, value, options);
  const chipIds = Array.isArray(value) ? (value as string[]) : [];

  const startEdit = () => {
    if (off) return;
    settled.current = false;
    busy.current = false;
    setError(null);
    setDraft(draftText(kind, value));
    if (kind === 'chips') dispatch({ type: 'open' });
    else setOpen(true);
    if (saveState === 'error') setSaveState('idle');
  };

  const close = (how: 'saved' | 'unchanged', focus: 'display' | 'add' | null) => {
    // An item made on the way that the field never took keeps its own step, so it can be undone.
    const orphan = created.current;
    created.current = null;
    if (orphan?.command) undo.record(orphan.command);
    settled.current = true;
    refocus.current = focus;
    setOpen(false);
    dispatch({ type: 'cancel' });
    setError(null);
    props.onClose?.(how);
  };

  /** Write a value; true when it saved. Errors stay at the field in plain words. */
  const write = async (next: unknown, info: SaveInfo): Promise<boolean> => {
    busy.current = true;
    setSaveState('saving');
    try {
      await (props.onSave as Save<unknown>)(next, info);
      if (!mounted.current) return true;
      setPending({ value: next });
      setSaveState('saved');
      return true;
    } catch (e) {
      if (!mounted.current) return false;
      setError(plainError(e));
      setSaveState('error');
      return false;
    } finally {
      busy.current = false;
    }
  };

  /** Save the typed text (text, year, number, rich, date). */
  const commit = async (how: 'enter' | 'blur') => {
    if (busy.current || settled.current) return;
    const parsed = parse(props, draft, label);
    if (!parsed.ok) {
      setError(parsed.message);
      setSaveState('error');
      return;
    }
    if (deepEqual(parsed.value, storedFor(props, value))) {
      close('unchanged', how === 'enter' ? 'display' : null);
      return;
    }
    const ok = await write(parsed.value, {});
    if (ok) close('saved', how === 'enter' ? 'display' : null);
    else if (how === 'enter') inputRef.current?.focus({ preventScroll: true });
  };

  const cancel = () => {
    if (busy.current) return;
    close('unchanged', 'display');
  };

  /** A select choice or a chip change saves at once. */
  const pickValue = async (next: unknown, focus: 'display' | 'add' | null) => {
    if (busy.current) return;
    if (deepEqual(next, value ?? null)) {
      close('unchanged', focus);
      return;
    }
    const ok = await write(next, {});
    if (ok) close('saved', focus);
  };

  /** Add new: make the item, then save the value that picks it, as one step for the writer. */
  const addAndPick = async (how: 'enter' | 'blur' = 'enter') => {
    if (props.kind !== 'select' && props.kind !== 'chips') return;
    if (addNew.step !== 'naming' || busy.current) return;
    const name = addNew.label.trim();
    dispatch({ type: 'submit' });
    if (!name || !props.onAddNew) return;
    busy.current = true;
    setError(null);
    // A retry after a failed pick picks the item already made, and makes no second one.
    let added = created.current;
    if (!added) {
      try {
        added = await props.onAddNew(name);
      } catch (e) {
        busy.current = false;
        dispatch({ type: 'failed', message: plainError(e) });
        setSaveState('error');
        return;
      }
      created.current = added;
    }
    dispatch({ type: 'added', added });
    const next = props.kind === 'select' ? added.id : [...chipIds, added.id];
    const ok = await write(next, { added });
    if (ok) {
      created.current = null;
      dispatch({ type: 'saved' });
      // After a blur the focus stays where the writer put it.
      close('saved', how === 'blur' ? null : props.kind === 'chips' ? 'add' : 'display');
      return;
    }
    dispatch({
      type: 'failed',
      message: `${added.label} was made, but the field did not take it. Press Enter to try again.`,
    });
  };

  const onTextKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void commit('enter');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const openKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') {
      e.preventDefault();
      startEdit();
    }
  };

  const describedBy =
    [error ? errorId : null, off && readOnly ? READ_ONLY_NOTE_ID : null]
      .filter(Boolean)
      .join(' ') || undefined;

  // ---- the closed text, shared by every kind but chips ----
  const closedText = (block: boolean) => {
    const Tag = block ? 'div' : 'span';
    const empty = shown === '';
    return (
      <Tag
        ref={(el: HTMLElement | null) => {
          displayRef.current = el;
        }}
        role="button"
        tabIndex={0}
        className={`editable-text${empty ? ' is-placeholder' : ''}`}
        aria-label={`${label}: ${empty ? (props.placeholder ?? 'empty') : shown}`}
        aria-disabled={off || undefined}
        aria-describedby={describedBy}
        title={off ? why : undefined}
        data-testid={props.testId ? `${props.testId}-text` : undefined}
        onClick={(e) => {
          // A link inside the text (a glossary run) acts on its own.
          if ((e.target as Element).closest('a, [role="link"]')) return;
          startEdit();
        }}
        onKeyDown={openKey}
      >
        {empty ? (
          (props.placeholder ?? '')
        ) : kind === 'rich' ? (
          <MarkdownView text={shown} />
        ) : props.display ? (
          props.display(shown)
        ) : (
          shown
        )}
      </Tag>
    );
  };

  /** An input sized by its text, so the line around it does not move. */
  const sizedInput = (inputProps: {
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    ariaLabel: string;
    placeholder?: string;
    numeric?: boolean;
  }) => (
    <span className="editable-sizer" data-value={inputProps.value || inputProps.placeholder || ' '}>
      <input
        ref={inputRef}
        className="editable-input"
        value={inputProps.value}
        autoComplete="off"
        spellCheck={!inputProps.numeric}
        inputMode={inputProps.numeric ? 'numeric' : undefined}
        size={1}
        aria-label={inputProps.ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={inputProps.placeholder}
        onChange={(e) => inputProps.onChange(e.target.value)}
        onKeyDown={inputProps.onKeyDown}
        onBlur={inputProps.onBlur}
      />
    </span>
  );

  let body: ReactNode;
  if (props.kind === 'chips') {
    body = (
      <ChipRow
        label={label}
        options={props.options}
        placeholder={props.placeholder}
        addLabel={props.addLabel}
        pickerLabel={props.pickerLabel}
        canAddNew={Boolean(props.onAddNew)}
        value={chipIds}
        off={off}
        addNew={addNew}
        dispatch={dispatch}
        addButton={(el) => {
          addButtonRef.current = el;
        }}
        busy={saveState === 'saving'}
        errorId={error ? errorId : undefined}
        onRemove={(id) =>
          void pickValue(
            chipIds.filter((x) => x !== id),
            'add',
          )
        }
        onPick={(id) => void pickValue([...chipIds, id], 'add')}
        onSubmitNew={() => void addAndPick()}
        onOpen={startEdit}
        onCancel={() => {
          if (busy.current) return;
          close('unchanged', 'add');
        }}
        onBlurOut={() => {
          if (busy.current || addNew.step === 'adding' || addNew.step === 'saving') return;
          // A typed name saves on blur, as Enter does (IP-1).
          if (addNew.step === 'naming' && addNew.label.trim()) {
            void addAndPick('blur');
            return;
          }
          close('unchanged', null);
        }}
      />
    );
  } else if (props.kind === 'select' && open && addNew.step === 'closed') {
    const sel = props;
    const current = typeof value === 'string' ? value : '';
    body = (
      <span className="editable-sizer" data-value={`${shown || props.placeholder || ' '}`}>
        <select
          ref={selectRef}
          className="editable-input editable-select"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={current}
          onChange={(e) => {
            const v = e.target.value;
            if (v === ADD_NEW) {
              dispatch({ type: 'pickAddNew', label: '' });
              return;
            }
            void pickValue(v === '' ? null : v, 'display');
          }}
          onBlur={() => {
            if (busy.current || settled.current) return;
            close('unchanged', null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        >
          {sel.allowEmpty ? (
            <option value="">{sel.emptyLabel ?? 'None'}</option>
          ) : current === '' ? (
            <option value="" disabled>
              {props.placeholder ?? 'Choose one'}
            </option>
          ) : null}
          {sel.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {sel.onAddNew && <option value={ADD_NEW}>{ADD_NEW_LABEL}</option>}
        </select>
      </span>
    );
  } else if (props.kind === 'select' && addNew.step !== 'closed' && addNew.step !== 'done') {
    const naming = addNew.step === 'naming' ? addNew : null;
    const text = 'label' in addNew ? addNew.label : '';
    body = sizedInput({
      value: text,
      onChange: (v) => dispatch({ type: 'label', label: v }),
      ariaLabel: `Name of the new item for ${label}`,
      placeholder: 'Name the new item',
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void addAndPick();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      },
      onBlur: () => {
        if (busy.current || settled.current) return;
        if (naming && naming.label.trim()) void addAndPick('blur');
        else close('unchanged', null);
      },
    });
  } else if (open && props.kind === 'rich') {
    body = (
      <RichText
        value={draft}
        onChange={setDraft}
        autoFocus
        label={label}
        mode={props.mode ?? 'full'}
        size={props.size ?? 'quick'}
        placeholder={props.placeholder}
        describedBy={error ? errorId : undefined}
        className="editable-rich-box"
        onBlur={() => void commit('blur')}
        onKeyDown={(e) => {
          // Cmd+Enter always saves; Enter saves too, except inside a list, where it
          // starts the next item as the box does everywhere (A44); Shift+Enter is a new line.
          const mod = e.metaKey || e.ctrlKey;
          const inList = Boolean(
            (window.getSelection()?.anchorNode?.parentElement ?? null)?.closest('li'),
          );
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey && (mod || !inList)) {
            e.preventDefault();
            void commit('enter');
            return true;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
            return true;
          }
          return false;
        }}
      />
    );
  } else if (open) {
    body = sizedInput({
      value: draft,
      onChange: (v) => {
        setDraft(v);
        if (error) setError(null);
        if (saveState === 'error') setSaveState('idle');
      },
      onKeyDown: onTextKey,
      onBlur: () => void commit('blur'),
      ariaLabel: label,
      placeholder: props.placeholder,
      numeric: kind === 'year' || kind === 'number' || kind === 'date',
    });
  } else {
    body = closedText(layout === 'block');
  }

  const addError = addNew.step === 'naming' ? addNew.error : null;
  const message = error ?? addError;
  const Root = layout === 'block' ? 'div' : 'span';
  return (
    <Root
      className={[
        'editable',
        `editable-${kind}`,
        `editable-${layout}`,
        open || addNew.step !== 'closed' ? 'is-open' : '',
        off ? 'is-disabled' : '',
        props.showLabel ? 'editable-labelled' : '',
        message ? 'has-error' : '',
        props.className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-field={props['data-field']}
      data-editable={kind}
      data-save-state={saveState}
      data-testid={props.testId}
      title={off && kind === 'chips' ? why : undefined}
    >
      {props.showLabel && (
        <span className="editable-label" id={labelId}>
          {label}
        </span>
      )}
      {body}
      {saveState === 'saved' && (
        <span className="editable-tick" aria-hidden="true">
          ✓
        </span>
      )}
      {/* One live region per field, present while it is open or saving and for the tick,
          so "Saved" is announced into a region that already exists; closed fields add none. */}
      {(open || addNew.step !== 'closed' || saveState === 'saving' || saveState === 'saved') && (
        <span className="sr-only" role="status" aria-live="polite">
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving' : ''}
        </span>
      )}
      {message && (
        <span id={errorId} className="ed-error editable-error" role="alert">
          Not saved: {message}
        </span>
      )}
      {(props.notes ?? []).map((n, i) => (
        <span key={i} className="ed-warning editable-note" role="note" data-code={n.code}>
          {n.message}
        </span>
      ))}
    </Root>
  );
}

/** The chip row: each chip with its remove button, then Add, which turns into a picker. */
function ChipRow(props: {
  label: string;
  value: readonly string[];
  options: readonly EditableOption[];
  placeholder?: string;
  addLabel?: string;
  pickerLabel?: string;
  canAddNew: boolean;
  off: boolean;
  busy: boolean;
  errorId?: string;
  addNew: ReturnType<typeof addNewReducer>;
  dispatch: (a: Parameters<typeof addNewReducer>[1]) => void;
  addButton: (el: HTMLButtonElement | null) => void;
  onRemove: (id: string) => void;
  onPick: (id: string) => void;
  onSubmitNew: () => void;
  onOpen: () => void;
  onCancel: () => void;
  onBlurOut: () => void;
}) {
  const { label, value, options, addNew, dispatch, addButton } = props;
  const { canAddNew } = props;
  const listId = useId();
  const optionId = useId();
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const opening = addNew.step === 'choosing';
  // The picker takes the focus when it opens, without scrolling the page (IP-1). Only
  // then: a later render must not pull the focus back from where the writer moved it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (opening && el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [opening]);
  const nameOf = (id: string) => options.find((o) => o.value === id)?.label ?? id;
  const addText = props.addLabel ?? `Add to ${label}`;
  const choosing = addNew.step === 'choosing' ? addNew : null;
  const naming = addNew.step === 'naming' || addNew.step === 'adding' || addNew.step === 'saving';
  const choices = choosing ? chipChoices(options, value, choosing.query) : [];
  const rows: { value: string; label: string }[] = [
    ...choices,
    ...(canAddNew ? [{ value: ADD_NEW, label: ADD_NEW_LABEL }] : []),
  ];
  const at = Math.min(active, Math.max(0, rows.length - 1));
  const pick = (v: string) => {
    if (v === ADD_NEW) {
      dispatch({ type: 'pickAddNew' });
      return;
    }
    props.onPick(v);
  };
  const text = choosing ? choosing.query : 'label' in addNew ? addNew.label : '';
  return (
    <span className="chips editable-chip-row">
      {value.length === 0 && !choosing && !naming && (
        <span className="editable-text is-placeholder editable-chips-empty">
          {props.placeholder ?? 'None yet'}
        </span>
      )}
      {value.map((id) => (
        <span key={id} className="chip">
          {nameOf(id)}
          {!props.off && (
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${nameOf(id)} from ${label}`}
              disabled={props.busy}
              onClick={() => props.onRemove(id)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {props.off ? null : choosing || naming ? (
        <span className="editable-combo">
          <span
            className="editable-sizer"
            data-value={text || (naming ? 'Name the new item' : 'Type to find')}
          >
            <input
              className="editable-input"
              role={choosing ? 'combobox' : undefined}
              aria-expanded={choosing ? true : undefined}
              aria-controls={choosing ? listId : undefined}
              aria-autocomplete={choosing ? 'list' : undefined}
              aria-activedescendant={choosing && rows.length ? `${optionId}-${at}` : undefined}
              aria-label={
                naming ? `Name of the new item for ${label}` : (props.pickerLabel ?? addText)
              }
              aria-describedby={props.errorId}
              placeholder={naming ? 'Name the new item' : 'Type to find'}
              ref={inputRef}
              autoComplete="off"
              size={1}
              value={text}
              readOnly={addNew.step === 'adding' || addNew.step === 'saving'}
              onChange={(e) => {
                setActive(0);
                if (choosing) dispatch({ type: 'query', query: e.target.value });
                else dispatch({ type: 'label', label: e.target.value });
              }}
              onBlur={props.onBlurOut}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onCancel();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (naming) props.onSubmitNew();
                  else if (rows[at]) pick(rows[at].value);
                } else if (choosing && e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive(Math.min(at + 1, rows.length - 1));
                } else if (choosing && e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(Math.max(at - 1, 0));
                }
              }}
            />
          </span>
          {choosing && (
            <span
              className="editable-listbox"
              role="listbox"
              id={listId}
              aria-label={`Choices for ${label}`}
            >
              {rows.length === 0 && <span className="editable-empty">Nothing matches.</span>}
              {rows.map((r, i) => (
                <span
                  key={r.value}
                  id={`${optionId}-${i}`}
                  role="option"
                  data-value={r.value === ADD_NEW ? undefined : r.value}
                  aria-selected={i === at}
                  className={`editable-option${i === at ? ' active' : ''}${r.value === ADD_NEW ? ' add-new' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (i !== at) setActive(i);
                  }}
                  onClick={() => pick(r.value)}
                >
                  {r.label}
                </span>
              ))}
            </span>
          )}
        </span>
      ) : (
        <button
          ref={addButton}
          type="button"
          className="btn small editable-add"
          disabled={props.busy}
          onClick={() => {
            setActive(0);
            props.onOpen();
          }}
        >
          {addText}
        </button>
      )}
    </span>
  );
}
