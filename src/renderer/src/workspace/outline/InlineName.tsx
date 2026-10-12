import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/**
 * KB-3: a heading that renames in place. Click it or press Enter on it to
 * edit; Enter or leaving the field saves, Escape cancels. Alt+Up and Alt+Down
 * on the heading go to `onMove`, for keyboard reordering (PL-3).
 */
export function InlineName(props: {
  value: string;
  /** What the heading shows when not editing, such as "Part 2: The Letter". */
  children: ReactNode;
  /** The field's label, such as "Part title". */
  label: string;
  onSave: (next: string) => unknown;
  onMove?: (by: -1 | 1) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.value);
  const button = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  const refocus = useRef(false);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  const start = () => {
    if (props.disabled) return;
    done.current = false;
    setText(props.value);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = text.trim();
    setEditing(false);
    if (save && next && next !== props.value) void props.onSave(next);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (!props.onMove || !e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      props.onMove(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="ol-rename"
        aria-label={props.label}
        value={text}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            refocus.current = true;
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            refocus.current = true;
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <button
      ref={button}
      type="button"
      className={`ol-name${props.className ? ` ${props.className}` : ''}`}
      title={
        props.onMove
          ? 'Click or press Enter to rename. Alt+Up and Alt+Down move it.'
          : 'Click or press Enter to rename.'
      }
      aria-keyshortcuts={props.onMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      disabled={props.disabled}
      data-testid={props.testId}
      onClick={start}
      onKeyDown={onButtonKey}
    >
      {props.children}
    </button>
  );
}

/**
 * KB-3: a one-field form that names a new entry where it will live. Enter or
 * the Create button makes it; Escape or Cancel closes the form.
 */
export function NameForm(props: {
  label: string;
  submit: string;
  onSubmit: (name: string) => unknown;
  onCancel: () => void;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      className="ol-name-form row tight"
      data-testid={props.testId}
      onSubmit={(e) => {
        e.preventDefault();
        const name = text.trim();
        if (!name || busy) return;
        setBusy(true);
        void Promise.resolve(props.onSubmit(name)).finally(() => setBusy(false));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        ref={input}
        value={text}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn small primary" disabled={busy || !text.trim()}>
        {props.submit}
      </button>
      <button type="button" className="btn small" onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}
