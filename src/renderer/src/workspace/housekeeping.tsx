/**
 * IP-16: the confirmations housekeeping asks for, drawn in the page where the
 * action sits (never a dialog, so nothing the writer reads is covered).
 * `TypedConfirm` asks for a word typed first (an entry's title, or "empty");
 * `ConfirmLine` is one line with the action and a way back.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { plainError } from '../api';
import './housekeeping.css';

/** True when what was typed is the word, ignoring case and the spaces around it. */
export function typedMatches(typed: string, word: string): boolean {
  return typed.trim().toLowerCase() === word.trim().toLowerCase() && word.trim() !== '';
}

/**
 * Type the word, then the action runs. Escape or Keep closes it; an error
 * stays here in plain words and the box stays open.
 */
export function TypedConfirm(props: {
  /** What must be typed. */
  word: string;
  /** What will happen, in a sentence or two. */
  children: ReactNode;
  /** The action button, for example "Delete Ada Sullivan forever". */
  action: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testId?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typedMatches(typed, props.word);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm();
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  };
  return (
    <form
      className="hk-confirm stack tight"
      role="group"
      aria-label={props.action}
      data-testid={props.testId}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <div className="hk-confirm-text">{props.children}</div>
      <label htmlFor={id}>
        Type <strong className="hk-word">{props.word}</strong> to confirm
      </label>
      <div className="row tight hk-confirm-row">
        <input
          ref={input}
          id={id}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button type="submit" className="btn small danger" disabled={!ok || busy}>
          {props.action}
        </button>
        <button type="button" className="btn small" onClick={props.onCancel}>
          Keep it
        </button>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** One line: what will happen, the action, and Keep. Escape keeps. The Keep button takes the focus. */
export function ConfirmLine(props: {
  children: ReactNode;
  action: string;
  keep?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testId?: string;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    keep.current?.focus({ preventScroll: true });
  }, []);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm();
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="hk-confirm hk-line"
      role="group"
      aria-label={props.action}
      data-testid={props.testId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <span className="hk-confirm-text">{props.children}</span>
      <span className="row tight">
        <button
          type="button"
          className="btn small danger"
          disabled={busy}
          onClick={() => void go()}
        >
          {props.action}
        </button>
        <button ref={keep} type="button" className="btn small" onClick={props.onCancel}>
          {props.keep ?? 'Keep it'}
        </button>
      </span>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
