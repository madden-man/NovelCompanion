import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunError } from '../../../../shared/claude';
import type { Response } from '../../../../shared/ipc';
import type { FindingWire } from '../../../../shared/ipcContinuity';
import { isEntryCollection } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { resolutionCommand } from '../../../../shared/domain/continuity/findings';
import { call, plainError } from '../../api';
import { WriteFieldset, useWriteGuard } from '../../connection';
import type { EntryRefWire } from '../../../../shared/claude';
import {
  ClaudeErrorNote,
  Disclosure,
  EntriesRead,
  newRunId,
  useRunStream,
  watchRun,
} from '../claude';
import { useChapterNumbers, useEntries, useStore } from '../data';
import type { Entry } from '../data';
import { Editable, EntryEditable, saveEntryField } from '../editable';
import { useUndo } from '../undo';
import type { OpenEntry } from './common';
import './alignment.css';

/**
 * The alignment check (CC-1 to CC-5, A20). Check runs the structural checks
 * in code, then Claude on each chapter in scope that has text, one run at a
 * time, streaming, with Stop. Each finding quotes its lines, cites its
 * entries, and offers "Chapter is right" (the change set, shown as a diff,
 * applied in one step and undoable; the button counts the changes), "Bible is
 * right" (a rewrite task, never replacement text), or Dismiss (A57: each
 * button names its result, so no caveat sits beside it).
 *
 * IP-7 (a47-continuity): a card edits the finding in place. The text and
 * what must change are A44 boxes, each quoted line is a field that keeps the
 * quote styling, and the resolution note sits with the resolution. Every
 * save is one undo step through the entry write path; Open goes to the
 * finding's page. The change set stays a system field, shown as a diff
 * before Apply.
 */

type Check = Response<'continuity.check'>;
type Rejected = Response<'claude.alignment'>['rejected'];
type Scope = string | null;

const linesText = (f: Pick<FindingWire, 'lineStart' | 'lineEnd'>) =>
  f.lineStart === null
    ? ''
    : f.lineEnd !== null && f.lineEnd !== f.lineStart
      ? `lines ${f.lineStart} to ${f.lineEnd}`
      : `line ${f.lineStart}`;

const chapterText = (f: Pick<FindingWire, 'number' | 'chapter'>) =>
  f.chapter ? `Chapter ${f.number ?? '?'}: ${f.chapter}` : 'Whole bible';

/** Findings for a scope, reloaded whenever the bible changes. */
export function useFindings(chapterId: Scope, states?: FindingWire['state'][]) {
  const { version } = useStore();
  const [data, setData] = useState<Response<'continuity.findings'> | null>(null);
  const key = JSON.stringify(states ?? null);
  useEffect(() => {
    let live = true;
    void call('continuity.findings', {
      chapterId,
      ...(states ? { states } : {}),
    }).then(
      (r) => live && setData(r),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, key, version]);
  return data;
}

/**
 * IP-7: the stored findings, from the renderer's cache, which reloads only
 * when a finding changes. A card takes its finding from here, so its fields
 * never wait on a read or flash their placeholders; one the cache has not
 * caught up with yet is drawn from what the findings channel said.
 */
function useFindingDocs(): { loaded: boolean; docOf: (f: FindingWire) => Entry } {
  const store = useStore();
  const all = useEntries('findings');
  const loaded = store.entries('findings') !== undefined;
  const byId = new Map(all.map((e) => [e._id, e]));
  return {
    loaded,
    docOf: (f) =>
      byId.get(f.id) ??
      ({
        _id: f.id,
        modifiedAt: f.createdAt,
        text: f.text,
        quote: f.lines.map((l) => l.text).join('\n'),
        mustChange: f.mustChange,
        resolutionNote: '',
      } as Entry),
  };
}

/** One alignment check run over a scope: structural checks, then Claude chapter by chapter. */
function useAlignmentRun(scope: Scope) {
  const [busy, setBusy] = useState(false);
  const [structural, setStructural] = useState<Check | null>(null);
  const [current, setCurrent] = useState<{
    runId: string;
    title: string;
    i: number;
    n: number;
  } | null>(null);
  const [done, setDone] = useState<{ chapters: number; found: number; stopped: boolean } | null>(
    null,
  );
  const [rejected, setRejected] = useState<Rejected>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [given, setGiven] = useState<EntryRefWire[]>([]);
  const [error, setError] = useState<RunError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<((ok: boolean) => void) | null>(null);
  const stopped = useRef(false);
  // A57: the scope select sits inside the runner's row, so a new scope clears the last
  // run's results here instead of remounting the row (which would take the select's focus).
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setDone(null);
    setStructural(null);
    setRejected([]);
    setSkipped([]);
    setGiven([]);
    setError(null);
    setFailure(null);
  }
  // AI-2: every entry Claude was given, across the chapters of this run.
  const live = useRunStream(current?.runId ?? null, (finished) => {
    setGiven((prior) => {
      const have = new Set(prior.map((e) => `${e.collection}:${e.id}`));
      const more = finished.entries.filter((e) => !have.has(`${e.collection}:${e.id}`));
      return more.length ? [...prior, ...more] : prior;
    });
  });

  const confirmed = async (): Promise<boolean> => {
    const status = await call('claude.status', {});
    if (status.acknowledgedAt) return true;
    return new Promise<boolean>((resolve) => setAsking(() => resolve));
  };

  const run = async (scope: Scope) => {
    stopped.current = false;
    setBusy(true);
    setDone(null);
    setRejected([]);
    setSkipped([]);
    setGiven([]);
    setError(null);
    setFailure(null);
    let found = 0;
    let read = 0;
    try {
      const s = await call('continuity.check', { chapterId: scope });
      setStructural(s);
      const targets = s.chapters.filter((c) => c.lines > 0);
      if (targets.length && (await confirmed())) {
        for (const [i, c] of targets.entries()) {
          if (stopped.current) break;
          const runId = newRunId();
          watchRun(runId);
          setCurrent({
            runId,
            title: `Chapter ${c.number ?? '?'}: ${c.title}`,
            i: i + 1,
            n: targets.length,
          });
          const r = await call('claude.alignment', { runId, chapterId: c.id });
          setRejected((prior) => [...prior, ...r.rejected]);
          if (r.skipped) setSkipped((prior) => [...prior, r.skipped as string]);
          found += r.found;
          if (r.status === 'done') read++;
          if (r.status === 'stopped') stopped.current = true;
          if (r.status === 'failed') {
            setError(r.error);
            break;
          }
        }
      }
      setDone({ chapters: read, found, stopped: stopped.current });
    } catch (e) {
      setFailure(plainError(e));
    } finally {
      setCurrent(null);
      setBusy(false);
    }
  };

  const stop = () => {
    stopped.current = true;
    if (current) void call('claude.stop', { runId: current.runId });
  };

  const disclosure = asking ? (
    <Disclosure
      onConfirm={() =>
        void call('claude.acknowledge', {}).then(() => {
          asking(true);
          setAsking(null);
        })
      }
      onDecline={() => {
        asking(false);
        setAsking(null);
      }}
    />
  ) : null;

  return {
    run,
    stop,
    busy,
    structural,
    current,
    live,
    done,
    rejected,
    skipped,
    given,
    error,
    failure,
    disclosure,
  };
}

/**
 * CC-1: Check one chapter or the whole manuscript, with the model, progress,
 * and Stop. A57: the scope reads as part of the action, "Check all 8
 * chapters against the bible", so `scope` is the select (or the words) that
 * sits between the button and "against the bible".
 */
function AlignmentRunner(props: { scope: Scope; scopeControl: ReactNode }) {
  const r = useAlignmentRun(props.scope);
  const guard = useWriteGuard();
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    void call('claude.status', {}).then(
      (s) => setModel(s.models.alignment),
      () => undefined,
    );
  }, []);
  return (
    <div className="stack tight" data-testid="alignment-runner">
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={r.busy || guard.off}
          {...guard.tip}
          onClick={() => void r.run(props.scope)}
          data-testid="alignment-run"
        >
          Check
        </button>
        <span className="al-scope" data-testid="alignment-scope-words">
          {props.scopeControl}
        </span>
        <span>against the bible</span>
        <button
          type="button"
          className="btn"
          disabled={!r.busy || guard.off}
          {...guard.tip}
          onClick={r.stop}
          data-testid="alignment-stop"
        >
          Stop
        </button>
        {model && <span className="chip">Model: {model}</span>}
      </div>
      {r.disclosure}
      <p role="status" aria-live="polite" data-testid="alignment-status">
        {r.current
          ? `Claude is reading ${r.current.title} (${r.current.i} of ${r.current.n}), ${r.live?.text.length ?? 0} characters so far.`
          : r.busy
            ? 'Running the structural checks.'
            : r.done
              ? `${r.done.stopped ? 'Stopped' : 'Done'}. Structural checks: ${r.structural?.found ?? 0} found${
                  r.structural?.hidden ? `, ${r.structural.hidden} dismissed and unchanged` : ''
                }. Claude read ${r.done.chapters} ${r.done.chapters === 1 ? 'chapter' : 'chapters'} and found ${r.done.found}.`
              : ''}
      </p>
      {r.error && <ClaudeErrorNote error={r.error} />}
      {r.skipped.map((x, i) => (
        <p key={i} className="callout warn" role="alert" data-testid="alignment-skipped">
          {x}
        </p>
      ))}
      <EntriesRead entries={r.given} label="Entries given to Claude" />
      {r.failure && (
        <p className="callout crit" role="alert">
          {r.failure}
        </p>
      )}
      {r.rejected.length > 0 && (
        <div className="callout warn stack tight" data-testid="alignment-rejected">
          <span>
            Claude returned{' '}
            {r.rejected.length === 1 ? 'a finding' : `${r.rejected.length} findings`} that failed
            the checks, so {r.rejected.length === 1 ? 'it was' : 'they were'} not kept:
          </span>
          <ul className="plain-list">
            {r.rejected.map((x, i) => (
              <li key={i}>
                {x.summary} {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A57: the "Chapter is right" button counts the bible changes it makes. */
const chapterIsRight = (n: number) =>
  n === 0
    ? 'Chapter is right: no bible change prepared'
    : `Chapter is right: ${n} bible ${n === 1 ? 'change' : 'changes'}`;

/**
 * IP-7: the quoted lines, each a field in the quote's own styling. A line
 * saves the whole quote with that line changed, as one undo step.
 */
function QuoteLines(props: { f: FindingWire; editable: boolean; testId?: string }) {
  const { f } = props;
  const undo = useUndo();
  const saveLine = async (index: number, next: string) => {
    const quote = f.lines.map((l, i) => (i === index ? next : l.text)).join('\n');
    await saveEntryField(undo, {
      collection: 'findings',
      id: f.id,
      path: 'quote',
      value: quote,
      label: 'Quoted passage',
    });
  };
  return (
    <blockquote className="al-quote" data-testid={props.testId}>
      {f.lines.map((l, i) => (
        <p key={l.n}>
          <span className="al-ln">Line {l.n}:</span>
          {props.editable ? (
            <Editable
              kind="text"
              label={`Quoted line ${l.n}`}
              value={l.text}
              allowEmpty={false}
              data-field="quote"
              testId={`quote-line-${l.n}`}
              onSave={(next) => saveLine(i, next)}
            />
          ) : (
            l.text
          )}
        </p>
      ))}
    </blockquote>
  );
}

const WORDING_LABELS = {
  text: 'Finding',
  quote: 'Quoted passage',
  mustChange: 'What must change',
} as const;

/**
 * IP-7, ED-7: a re-run found new words for a field the writer edited. The
 * edit stays; the card shows what the check says now, and Take the new text
 * replaces the edit as one undo step.
 */
function ProposedWording(props: {
  findingId: string;
  doc: Record<string, unknown> | null;
  field: keyof typeof WORDING_LABELS;
}) {
  const undo = useUndo();
  const [error, setError] = useState<string | null>(null);
  const proposed = props.doc?.proposed as Record<string, unknown> | null | undefined;
  const now = proposed?.[props.field];
  if (typeof now !== 'string' || now === props.doc?.[props.field]) return null;
  const label = WORDING_LABELS[props.field];
  const take = async () => {
    setError(null);
    try {
      await saveEntryField(undo, {
        collection: 'findings',
        id: props.findingId,
        path: props.field,
        value: now,
        label,
      });
    } catch (e) {
      setError(plainError(e));
    }
  };
  return (
    <div
      className="callout al-proposed stack tight"
      data-testid="finding-proposed"
      data-wording={props.field}
    >
      <span>
        <strong>The check now says{props.field === 'text' ? '' : ` (${label})`}:</strong>{' '}
        <span className="al-proposed-text">{now}</span>
      </span>
      <WriteFieldset className="row tight">
        <button
          type="button"
          className="btn small"
          aria-label={`Take the new text for ${label}`}
          onClick={() => void take()}
        >
          Take the new text
        </button>
      </WriteFieldset>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** CC-4, IP-7: one finding with its quoted lines, citations, the three resolutions, and its fields. */
function FindingCard(props: { f: FindingWire; doc: Entry; onOpen: OpenEntry }) {
  const { f, doc, onOpen } = props;
  const undo = useUndo();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const diffCaptionId = useId();

  const resolve = async (
    action: 'manuscriptWins' | 'rewrite' | 'dismiss' | 'done',
    label: string,
  ) => {
    setError(null);
    setWarnings([]);
    try {
      const r = await call('continuity.resolve', {
        id: f.id,
        action,
        ...(action === 'manuscriptWins' ? { shown: f.shown } : {}),
      });
      setWarnings(r.warnings.map((w) => `${w.entry}: ${w.message}`));
      undo.record(
        resolutionCommand(
          `${label}: ${f.title}`,
          r.changes
            .filter((c) => isEntryCollection(c.collection))
            .map((c) => ({ ...c, collection: c.collection as EntryCollection })),
        ),
      );
      setNote(
        action === 'manuscriptWins'
          ? 'Bible updated.'
          : action === 'rewrite'
            ? 'Added to the rewrite tasks.'
            : null,
      );
    } catch (e) {
      setError(plainError(e));
    }
  };

  const openEntry = (collection: string, id: string) => {
    if (isEntryCollection(collection)) onOpen(collection, id);
  };

  const hasDiff = f.state === 'open' && f.kind === 'alignment' && f.changes.length > 0;

  return (
    <li
      className="al-finding stack tight"
      data-testid="finding"
      data-key={f.key}
      data-check={f.check}
      data-state={f.state}
      aria-label={`${f.label}, ${chapterText(f)}`}
    >
      <div className="row tight">
        <span className="chip time">{f.label}</span>
        <span className="chip">{chapterText(f)}</span>
        {f.lineStart !== null && <span>{linesText(f)}</span>}
        {f.storyYear !== null && <span>story year {f.storyYear}</span>}
        <button
          type="button"
          className="link-btn al-open"
          aria-label="Open the finding page"
          data-testid="finding-open"
          onClick={() => onOpen('findings', f.id)}
        >
          Open
        </button>
      </div>
      {f.lines.length > 0 && <QuoteLines f={f} editable testId="finding-quote" />}
      <ProposedWording findingId={f.id} doc={doc} field="quote" />
      {f.textChanged && (
        <p className="callout warn">The chapter text changed since this check. Check it again.</p>
      )}
      <EntryEditable
        collection="findings"
        id={f.id}
        entry={doc}
        path="text"
        kind="rich"
        label="Finding"
        placeholder="Say what the check found"
        testId="finding-text"
        className="al-field"
      />
      <ProposedWording findingId={f.id} doc={doc} field="text" />
      {f.entries.length > 0 && (
        <div className="row tight" aria-label="Cited entries">
          <span>Cites:</span>
          {f.entries.map((e) =>
            e.found ? (
              <button
                key={e.id}
                type="button"
                className="link-btn"
                onClick={() => openEntry(e.collection, e.id)}
              >
                {e.title} <span className="al-cite">({e.id})</span>
              </button>
            ) : (
              <span key={e.id} className="al-cite">
                {e.id} (no longer in the bible)
              </span>
            ),
          )}
        </div>
      )}
      {f.kind === 'alignment' && (
        <EntryEditable
          collection="findings"
          id={f.id}
          entry={doc}
          path="mustChange"
          kind="rich"
          label="What must change"
          showLabel
          placeholder="Say what must change in the text"
          testId="finding-must-change"
          className="al-field"
        />
      )}
      {f.kind === 'alignment' && <ProposedWording findingId={f.id} doc={doc} field="mustChange" />}
      {f.state === 'open' && (
        <WriteFieldset className="row tight">
          <div className="row tight" data-testid="finding-actions">
            {f.kind === 'alignment' && (
              <>
                <button
                  type="button"
                  className="btn small"
                  disabled={f.changes.length === 0}
                  onClick={() => void resolve('manuscriptWins', 'Chapter is right')}
                  data-testid="finding-apply"
                >
                  {chapterIsRight(f.changes.length)}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void resolve('rewrite', 'Bible is right')}
                >
                  Bible is right: add a rewrite task
                </button>
              </>
            )}
            <button
              type="button"
              className="btn small"
              onClick={() => void resolve('dismiss', 'Dismissed')}
            >
              Dismiss
            </button>
          </div>
        </WriteFieldset>
      )}
      {hasDiff && (
        <div className="sunken stack tight al-diff" data-testid="finding-diff">
          <span className="eyebrow" id={diffCaptionId}>
            If the chapter is right, the bible changes like this
          </span>
          {/* Bounded, so a long change set does not push the next findings down the screen. */}
          <div className="al-diff-body" tabIndex={0} role="region" aria-labelledby={diffCaptionId}>
            <table className="diff-table" aria-labelledby={diffCaptionId}>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">Field</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {f.changes.map((c, i) => (
                  <tr key={i}>
                    <th scope="row">{c.entry}</th>
                    <td>{c.label}</td>
                    <td>
                      <del>{c.before}</del>
                    </td>
                    <td>
                      <ins>{c.after}</ins>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {f.rejectedChanges.length > 0 && (
        <div className="stack tight" data-testid="finding-rejected">
          <span>Changes Claude prepared that failed the checks, never applied:</span>
          <ul className="plain-list">
            {f.rejectedChanges.map((x, i) => (
              <li key={i}>
                {x.summary}: {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="al-resolution" data-testid="finding-resolution">
        <div className="row tight" aria-label="Resolution">
          <span>Resolution:</span>
          {f.state === 'manuscriptWins' ? (
            <span className="chip now">bible updated</span>
          ) : f.state === 'rewrite' ? (
            <span className="chip todo">rewrite task</span>
          ) : (
            <span className="chip">not resolved yet</span>
          )}
        </div>
        <EntryEditable
          collection="findings"
          id={f.id}
          entry={doc}
          path="resolutionNote"
          kind="rich"
          label="Resolution note"
          placeholder="Why you chose this"
          testId="finding-note"
          className="al-field"
        />
      </div>
      {note && (
        <p role="status" className="row tight">
          {note}
          {f.state === 'manuscriptWins' && (
            <button type="button" className="btn small" onClick={() => void undo.undo()}>
              Undo
            </button>
          )}
        </p>
      )}
      {warnings.length > 0 && (
        <div className="callout warn stack tight" data-testid="finding-warnings">
          <span>The bible was updated, and these fields now carry a warning:</span>
          <ul className="plain-list">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** CC-3, CC-4: the findings for a scope, structural first, then Claude's. */
function FindingList(props: { scope: Scope; onOpen: OpenEntry }) {
  const data = useFindings(props.scope, ['open', 'manuscriptWins']);
  const docs = useFindingDocs();
  if (!data || !docs.loaded) return <p aria-live="polite">Loading findings.</p>;
  const structural = data.findings.filter((f) => f.kind === 'structural');
  const alignment = data.findings.filter((f) => f.kind === 'alignment');
  return (
    <div className="stack">
      <section
        className="al-section"
        aria-label="Structural findings"
        data-testid="structural-findings"
      >
        <h3>Structural checks</h3>
        {structural.length ? (
          <ul className="al-list">
            {structural.map((f) => (
              <FindingCard key={f.id} f={f} doc={docs.docOf(f)} onOpen={props.onOpen} />
            ))}
          </ul>
        ) : (
          <p>No structural findings.</p>
        )}
      </section>
      <section
        className="al-section"
        aria-label="Alignment with the text"
        data-testid="alignment-findings"
      >
        <h3>Alignment with the text (Claude)</h3>
        {alignment.length ? (
          <ul className="al-list">
            {alignment.map((f) => (
              <FindingCard key={f.id} f={f} doc={docs.docOf(f)} onOpen={props.onOpen} />
            ))}
          </ul>
        ) : (
          <p>No alignment findings.</p>
        )}
      </section>
      {data.dismissed > 0 && (
        <p data-testid="findings-dismissed">
          {data.dismissed === 1
            ? '1 dismissed finding is hidden.'
            : `${data.dismissed} dismissed findings are hidden.`}
        </p>
      )}
    </div>
  );
}

/**
 * CC-4, DB-1: open rewrite tasks: chapter, line numbers, the quoted lines,
 * and what must change. No replacement text is ever suggested (AI-4).
 */
export function RewriteTasks(props: { chapterId: Scope; onOpenChapter?: (id: string) => void }) {
  const data = useFindings(props.chapterId, ['rewrite']);
  const docs = useFindingDocs();
  const undo = useUndo();
  const guard = useWriteGuard();
  const [error, setError] = useState<string | null>(null);
  const tasks = data?.findings ?? [];
  const markDone = async (f: FindingWire) => {
    setError(null);
    try {
      const r = await call('continuity.resolve', { id: f.id, action: 'done' });
      undo.record(
        resolutionCommand(
          `Rewrite task done: ${f.title}`,
          r.changes.map((c) => ({ ...c, collection: c.collection as EntryCollection })),
        ),
      );
    } catch (e) {
      setError(plainError(e));
    }
  };
  return (
    <div className="stack tight" data-testid="rewrite-tasks">
      {tasks.length ? (
        <ul className="al-list">
          {tasks.map((t) => (
            <li key={t.id} className="al-finding stack tight" data-testid="rewrite-task">
              <div className="row tight">
                <strong>{chapterText(t)}</strong>
                {t.lineStart !== null && <span>{linesText(t)}</span>}
                <span className="chip todo">{t.label}</span>
              </div>
              {t.lines.length > 0 && <QuoteLines f={t} editable={false} />}
              <div className="al-task-text">
                <strong>{t.mustChange ? 'What must change' : 'Finding'}:</strong>{' '}
                {/* IP-7: the task's text edits in place, in the same box as the card; a task with
                    no "what must change" edits its finding text, under that field's label. */}
                <EntryEditable
                  collection="findings"
                  id={t.id}
                  entry={docs.docOf(t)}
                  path={t.mustChange ? 'mustChange' : 'text'}
                  kind="rich"
                  size="quick"
                  allowEmpty={false}
                  testId="rewrite-task-text"
                />
              </div>
              <div className="row tight">
                {props.onOpenChapter && t.chapterId && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => t.chapterId && props.onOpenChapter?.(t.chapterId)}
                  >
                    Open chapter
                  </button>
                )}
                <button
                  type="button"
                  className="btn small"
                  disabled={guard.off}
                  {...guard.tip}
                  onClick={() => void markDone(t)}
                >
                  Done
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="example-note">No open rewrite tasks.</p>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** CC-1: the alignment check screen, the Continuity checker's first tab. */
export function AlignmentView(props: { onOpen: OpenEntry; chapterId?: string | null }) {
  const chapters = useEntries('chapters');
  const numbers = useChapterNumbers();
  const [scope, setScope] = useState<Scope>(props.chapterId ?? null);
  const scopeId = useId();
  const sorted = [...chapters].sort(
    (a, b) => Number(a.readingOrder ?? 0) - Number(b.readingOrder ?? 0),
  );
  const select = (
    <select
      id={scopeId}
      aria-label="Chapters to check"
      value={scope ?? ''}
      onChange={(e) => setScope(e.target.value || null)}
      data-testid="alignment-scope"
    >
      <option value="">
        all {sorted.length} {sorted.length === 1 ? 'chapter' : 'chapters'}
      </option>
      {sorted.map((c) => (
        <option key={c._id} value={c._id}>
          Chapter {numbers.get(c._id) ?? '?'}: {String(c.title)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="ws-wide stack" data-testid="alignment-view">
      <h2>Alignment check</h2>
      <AlignmentRunner scope={scope} scopeControl={select} />
      <section className="panel stack tight" aria-label="Rewrite tasks">
        <h3>Rewrite tasks</h3>
        <RewriteTasks chapterId={scope} onOpenChapter={(id) => props.onOpen('chapters', id)} />
      </section>
      <FindingList scope={scope} onOpen={props.onOpen} />
    </div>
  );
}

/** CC-1, CC-4: on a chapter's page, check this chapter and see its open rewrite tasks and findings. */
export function ChapterAlignment(props: { chapterId: string; onOpen: OpenEntry }) {
  return (
    <section
      className="panel stack tight"
      aria-label="Alignment check"
      data-testid="chapter-alignment"
    >
      <h3>Alignment check</h3>
      <AlignmentRunner scope={props.chapterId} scopeControl="this chapter" />
      <span className="eyebrow">Rewrite tasks</span>
      <RewriteTasks chapterId={props.chapterId} />
      <FindingList scope={props.chapterId} onOpen={props.onOpen} />
    </section>
  );
}
