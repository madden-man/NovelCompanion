import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  EMPTY_OUTLINE,
  continueBullet,
  indentLines,
  sceneCount,
} from '../../../../shared/domain/sceneOutline';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useStore } from '../data';
import { UndoPanel } from '../editor';
import { useOutlineWrites } from './actions';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;

/**
 * PL-5 (A36): the scene outline. One long bulleted text on the left, kept per
 * bible; the chapters in reading order on the right, each title editable in
 * place so chapters can be renamed to match the scenes.
 */
export function SceneOutline({ toggle }: { toggle: ReactNode }) {
  const { version } = useStore();
  const [outline, setOutline] = useState<Outline | null>(null);

  useEffect(() => {
    let live = true;
    void call('outline.get', { order: 'reading', cursorYear: null }).then((r) => {
      if (live) setOutline(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="ws-tree-area scenes" data-testid="outline-view">
      <section className="tree-main stack" aria-labelledby="outline-title">
        <div className="list-head">
          <h2 id="outline-title">Outline</h2>
          <span className="row tight">{toggle}</span>
        </div>
        <p className="example-note">
          One long list of scenes in page order, free of the chapter titles. Enter adds the next
          scene, Cmd+] indents, Cmd+[ outdents, and Enter on an empty bullet ends the list. A line
          without a bullet is a heading. Rename the chapters on the right to match the scenes.
        </p>
        <SceneOutlineEditor />
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="Chapter titles"
        data-testid="outline-inspector"
      >
        <span className="eyebrow">Chapters in reading order</span>
        {!outline ? (
          <p aria-live="polite">Loading the chapters.</p>
        ) : (
          <ChapterTitles rows={outline.rows} />
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}

/** Autosave timing for the scene outline, the same as an entry (ED-2). */
const SCENE_DEBOUNCE_MS = 500;
const SCENE_MAX_WAIT_MS = 700;

type SceneStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error';

/**
 * A textarea that behaves as a bulleted list and saves itself 500 ms after
 * the last keystroke, never more than 700 ms after the first unsaved one.
 */
function SceneOutlineEditor() {
  const ro = useWriteGuard();
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const current = useRef<string | null>(null);
  const saved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const [reloads, setReloads] = useState(0);
  const id = useId();

  useEffect(() => {
    let live = true;
    void call('sceneOutline.get', {})
      .then((r) => {
        if (!live) return;
        const value = r.text === '' ? EMPTY_OUTLINE : r.text;
        saved.current = r.text;
        current.current = value;
        setText(value);
        setStatus('saved');
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(plainError(e));
        setStatus('error');
      });
    const off = window.api.on('bible.reloaded', () => setReloads((n) => n + 1));
    return () => {
      live = false;
      off();
    };
  }, [reloads]);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    for (;;) {
      const target = current.current;
      if (target === null) return;
      // A fresh outline with nothing typed is stored as empty.
      const stored = target === EMPTY_OUTLINE ? '' : target;
      if (stored === saved.current) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
      setStatus('saving');
      const run = call('sceneOutline.set', { text: stored }).then(
        (r) => {
          saved.current = r.text;
          setError(null);
          return true;
        },
        (e: unknown) => {
          setError(plainError(e));
          setStatus('error');
          return false;
        },
      );
      inflight.current = run.then(() => undefined);
      const ok = await run;
      inflight.current = null;
      if (!ok) return;
      if (current.current === target) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
    }
  }, []);

  const schedule = useCallback(() => {
    setStatus('pending');
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    firstPending.current ??= now;
    const wait = Math.max(
      0,
      Math.min(SCENE_DEBOUNCE_MS, firstPending.current + SCENE_MAX_WAIT_MS - now),
    );
    timer.current = setTimeout(() => void save(), wait);
  }, [save]);

  // Leaving the view writes what is pending.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const target = current.current;
      const stored = target === EMPTY_OUTLINE ? '' : target;
      if (stored !== null && stored !== saved.current) {
        void call('sceneOutline.set', { text: stored });
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (caret.current && area.current) {
      area.current.setSelectionRange(caret.current.start, caret.current.end);
      caret.current = null;
    }
  }, [text]);

  const apply = (value: string, start: number, end: number) => {
    current.current = value;
    caret.current = { start, end };
    setText(value);
    schedule();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const edit = {
      text: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const next = continueBullet(edit);
      if (next) {
        e.preventDefault();
        apply(next.text, next.selectionStart, next.selectionEnd);
      }
    } else if ((e.key === ']' || e.key === '[') && (e.metaKey || e.ctrlKey) && !e.altKey) {
      // Cmd+] indents and Cmd+[ outdents; Tab stays the key that leaves the field (NF-2).
      e.preventDefault();
      const next = indentLines(edit, e.key === '[');
      apply(next.text, next.selectionStart, next.selectionEnd);
    }
  };

  const label = {
    loading: 'Loading',
    saved: 'Saved',
    pending: 'Unsaved changes',
    saving: 'Saving',
    error: 'Not saved',
  }[status];

  return (
    <div className="scene-outline stack tight" data-testid="scene-outline">
      <label htmlFor={`${id}-text`} className="sr-only">
        Scene outline
      </label>
      <textarea
        id={`${id}-text`}
        ref={area}
        value={text ?? ''}
        disabled={text === null || ro.off}
        {...ro.tip}
        spellCheck
        data-testid="scene-text"
        onChange={(e) => {
          current.current = e.target.value;
          setText(e.target.value);
          schedule();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
      />
      <div className="scene-foot">
        <span data-testid="scene-count">{text === null ? '' : `${sceneCount(text)} scenes`}</span>
        <span data-testid="scene-autosave" aria-live="polite" data-status={status}>
          {label}
        </span>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The chapters in reading order, grouped by book and part, each title editable in place. */
function ChapterTitles({ rows }: { rows: Outline['rows'] }) {
  const chapters = useEntries('chapters');
  const writes = useOutlineWrites();
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const byId = useMemo(() => new Map(chapters.map((c) => [c._id, c])), [chapters]);
  const chapterRows = rows.filter((r): r is ChapterRow => r.kind === 'chapter');
  const position = new Map(chapterRows.map((c, i) => [c.id, i]));

  const rename = async (row: ChapterRow, title: string): Promise<boolean> => {
    const next = title.trim();
    if (!next) return false;
    const ok = await writes.edit(
      'chapters',
      row.id,
      { title: next },
      `Renamed chapter ${row.readingOrder} to ${next}`,
    );
    return ok === true;
  };

  if (chapterRows.length === 0) {
    return <p className="example-note">No chapters yet. Add one in the year grid.</p>;
  }
  return (
    <div className="stack tight">
      {writes.error && (
        <p className="callout crit" role="alert">
          {writes.error}
        </p>
      )}
      <ul className="ch-titles" data-testid="chapter-titles">
        {rows.map((row) => {
          if (row.kind !== 'chapter') {
            return (
              <li key={`${row.kind}:${row.id}`} className={`group ${row.kind}`}>
                {row.kind === 'book' ? 'Book' : 'Part'}: {row.title}
              </li>
            );
          }
          const at = position.get(row.id) ?? 0;
          const stored = byId.get(row.id);
          return (
            <li key={row.id} className="ch" data-chapter={row.id}>
              <span className="num">{row.readingOrder}</span>
              <TitleInput
                ref={(el) => {
                  inputs.current[at] = el;
                }}
                row={row}
                title={stored ? entryTitle(stored) : row.title}
                disabled={writes.ro.off}
                tip={writes.ro.tip}
                onRename={(t) => rename(row, t)}
                onNext={() => inputs.current[at + 1]?.focus()}
              />
              <span className="year">{row.storyYear ?? ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TitleInputProps {
  row: ChapterRow;
  title: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onRename: (title: string) => Promise<boolean>;
  onNext: () => void;
  ref: (el: HTMLInputElement | null) => void;
}

/** One chapter title: edits are written on Enter or when the field loses focus. */
function TitleInput({ row, title, disabled, tip, onRename, onNext, ref }: TitleInputProps) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(title);
  // A rename from elsewhere (undo, the editor) replaces a draft nobody is typing in.
  if (seen !== title) {
    setSeen(title);
    if (!editing) setDraft(title);
  }

  const commit = async () => {
    setEditing(false);
    if (draft.trim() === title) return;
    const ok = await onRename(draft);
    if (!ok) setDraft(title);
  };

  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      disabled={disabled}
      {...tip}
      aria-label={`Title of chapter ${row.readingOrder}`}
      data-testid="chapter-title"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit().then(onNext);
        } else if (e.key === 'Escape') {
          setDraft(title);
          setEditing(false);
        }
      }}
    />
  );
}
