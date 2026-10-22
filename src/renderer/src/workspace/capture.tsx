import { useDefaultStatus } from './bibleSettings';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ClaudeStatusWire, RunError } from '../../../shared/claude';
import type { ProposalView } from '../../../shared/ipc';
import { collectionInfo, entryTitle, isEntryCollection } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { StoryTimeValue } from '../../../shared/storyTime';
import { captureQuestionData, fileCapture } from '../../../shared/domain/capture';
import type { CaptureProposal, FiledEntry } from '../../../shared/domain/capture';
import { localDateString } from '../../../shared/domain/sessionLog';
import { useWriteGuard } from '../connection';
import { call, plainError } from '../api';
import { ClaudeErrorNote, Disclosure, claudeNav, newRunId, useRunStream, watchRun } from './claude';
import type { LiveRun } from './claude';
import { useEntries } from './data';
import { useFocusTrap } from './focusTrap';
import { ProposalDiff } from './review';
import { formatMoment, useStoryTime } from './storyTime';
import { createCommand } from '../../../shared/domain/undoRunner';
import { useUndo } from './undo';
import { RichText } from './richText/RichText';
import type { RichTextHandle } from './richText/RichText';
import './capture.css';

/**
 * Capture (KB-6, KB-7, A34): Cmd+K, or Add in the status bar, opens a box on
 * every screen. Enter sends the sentence to Claude (feature `capture`), which
 * looks names up and proposes where each fact belongs. The proposals show here
 * as ED-7 diffs, ticked; File it approves the ticked ones as one undo step and
 * rejects the rest. Nothing is written before File it (AI-3). Without a key,
 * offline, or when the run fails, the text is saved as an open question.
 */

let boxOpen = false;
const openListeners = new Set<() => void>();
function setBoxOpen(open: boolean): void {
  if (boxOpen === open) return;
  boxOpen = open;
  for (const l of openListeners) l();
}

/** A35: who hears a prefill such as "Cultural context for Pacific States, 2055: ". */
const prefillListeners = new Set<(text: string) => void>();

export const captureNav = {
  open: (prefill?: string) => {
    if (prefill) for (const l of prefillListeners) l(prefill);
    setBoxOpen(true);
  },
  close: () => setBoxOpen(false),
};

function useBoxOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      openListeners.add(l);
      return () => {
        openListeners.delete(l);
      };
    },
    () => boxOpen,
  );
}

/** The status bar button beside Ask Claude (KB-6). */
export function CaptureButton() {
  const open = useBoxOpen();
  return (
    <button
      type="button"
      className="btn small"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => captureNav.open()}
      data-testid="capture-add"
    >
      Add <kbd>Cmd K</kbd>
    </button>
  );
}

type Phase = 'edit' | 'running' | 'review' | 'filed' | 'saved';

interface Card {
  view: ProposalView;
  ticked: boolean;
}

/** The story time in words, with the chapter and strand being written. */
function useStoryTimeWords(): { value: StoryTimeValue; words: string } {
  const story = useStoryTime();
  const chapters = useEntries('chapters');
  const value: StoryTimeValue = story.time ?? { year: story.year };
  const chapter = value.chapterId ? chapters.find((c) => c._id === value.chapterId) : undefined;
  const strands = Array.isArray(chapter?.strands)
    ? (chapter.strands as { id: string; label: string }[])
    : [];
  const strand = strands.find((s) => s.id === value.strandId);
  const where = chapter
    ? `, writing Chapter ${String(chapter.readingOrder ?? '')}: ${entryTitle(chapter)}${strand ? `, ${strand.label}` : ''}`
    : '';
  const set = story.time ? '' : ' (from the current position)';
  return { value, words: `Story time ${formatMoment(value)}${set}${where}` };
}

const toProposal = (v: ProposalView): CaptureProposal => ({
  id: v.proposal._id,
  op: v.proposal.op,
  collection: v.proposal.collection as EntryCollection,
  targetId: v.proposal.targetId,
});

const OP_TEXT = { create: 'New', update: 'Change to', delete: 'Move to trash:' } as const;

function cardTitle(v: ProposalView): string {
  const c = v.proposal.collection;
  const kind = isEntryCollection(c) ? collectionInfo[c].singular.toLowerCase() : c;
  const name = v.targetTitle ?? entryTitle(v.proposal.data);
  return `${OP_TEXT[v.proposal.op]} ${kind} ${name}`;
}

/**
 * Mounted once in the frame. The box's state lives here, so closing the box
 * mid-run does not lose the run: its proposals still land, and a failure is
 * still saved as an open question (KB-7).
 */
export function CaptureBox() {
  const statusOf = useDefaultStatus();
  const open = useBoxOpen();
  const undo = useUndo();
  const ro = useWriteGuard();
  const time = useStoryTimeWords();
  const [status, setStatus] = useState<ClaudeStatusWire | null>(null);
  const [phase, setPhase] = useState<Phase>('edit');
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [answer, setAnswer] = useState('');
  const [runError, setRunError] = useState<RunError | null>(null);
  const [filed, setFiled] = useState<FiledEntry[]>([]);
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetched = useRef(new Set<string>());
  /** Proposals whose diff could not be read; they wait in the review queue. */
  const [unread, setUnread] = useState<string[]>([]);
  /** What the last File it could not do (approvals that failed stay pending). */
  const [notFiled, setNotFiled] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // Another modal dialog (Story Time, the stop prompt) holds focus: two focus traps would fight.
        if (!boxOpen && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        captureNav.open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setBoxOpen(false);
    };
  }, []);

  // A35: a prefill from the opener lands in an empty box.
  useEffect(() => {
    const onPrefill = (t: string) => setText((cur) => cur || t);
    prefillListeners.add(onPrefill);
    return () => {
      prefillListeners.delete(onPrefill);
    };
  }, []);

  // The key and the AI-6 confirmation, read each time the box opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void call('claude.status', {}).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const reset = useCallback(() => {
    setPhase('edit');
    setRunId(null);
    setCards([]);
    setAnswer('');
    setRunError(null);
    setFiled([]);
    setSaved(null);
    setMessage(null);
    setSent('');
    setUnread([]);
    setNotFiled(0);
    fetched.current = new Set();
  }, []);

  /** KB-7: keep the text as an open question; the text stays in the box until this succeeds. */
  const saveAsQuestion = useCallback(
    async (body: string) => {
      setBusy(true);
      try {
        const data = captureQuestionData(
          body,
          time.words,
          localDateString(new Date()),
          statusOf('idea'),
        );
        const { entry } = await call('entry.create', { collection: 'openQuestions', data });
        undo.record(createCommand('openQuestions', entry._id, entryTitle(entry)));
        setSaved({ id: entry._id, title: entryTitle(entry) });
        setText('');
        setPhase('saved');
      } catch (e) {
        setText((t) => t || body);
        setPhase('edit');
        setMessage(`The text was not saved: ${plainError(e)} It is still in the box.`);
      } finally {
        setBusy(false);
      }
    },
    [time.words, undo, statusOf],
  );

  // Each proposal shows as it arrives, with its diff against the entry as it is now.
  const live = useRunStream(runId, (finished: LiveRun) => {
    setAnswer(finished.text);
    if (finished.status === 'failed' && finished.proposalIds.length === 0) {
      setRunError(finished.error);
      void saveAsQuestion(sent);
      return;
    }
    if (finished.status === 'failed') setRunError(finished.error);
    if (finished.status === 'stopped' && finished.proposalIds.length === 0) {
      setText((t) => t || sent);
      setPhase('edit');
      setMessage('Stopped. Nothing was proposed; your text is back in the box.');
      return;
    }
    setPhase('review');
  });
  const proposalIds = live?.proposalIds;
  useEffect(() => {
    for (const id of proposalIds ?? []) {
      if (fetched.current.has(id)) continue;
      fetched.current.add(id);
      call('proposal.diff', { id }).then(
        (view) =>
          setCards((cs) =>
            cs.some((c) => c.view.proposal._id === id) ? cs : [...cs, { view, ticked: true }],
          ),
        (e: unknown) => {
          setUnread((u) => [...u, id]);
          setMessage(
            `One proposed change could not be shown and waits in the review queue: ${plainError(e)}`,
          );
        },
      );
    }
  }, [proposalIds]);
  // Keep the cards in the order Claude made them.
  const ordered = useMemo(() => {
    const order = proposalIds ?? [];
    return [...cards].sort(
      (a, b) => order.indexOf(a.view.proposal._id) - order.indexOf(b.view.proposal._id),
    );
  }, [cards, proposalIds]);

  // KB-6: the review shows once every proposal's diff has arrived, so File it never files part of them.
  const loading = (proposalIds?.length ?? 0) > cards.length + unread.length;
  const shownPhase: Phase = phase === 'review' && loading ? 'running' : phase;

  const send = async () => {
    const body = text.trim();
    if (!body || phase !== 'edit' || busy || ro.off) return;
    setMessage(null);
    setRunError(null);
    const fresh = await call('claude.status', {}).catch(() => status);
    if (fresh) setStatus(fresh);
    // KB-7: with no key nothing can be sent, so the text is kept as an open question.
    if (!fresh?.key.set) {
      await saveAsQuestion(body);
      return;
    }
    if (!fresh.acknowledgedAt) return;
    const id = newRunId();
    watchRun(id);
    fetched.current = new Set();
    setCards([]);
    setUnread([]);
    setSent(body);
    setRunId(id);
    setPhase('running');
    setText('');
    try {
      await call('claude.capture', { runId: id, text: body, storyTime: time.value });
    } catch (e) {
      setRunId(null);
      setSent('');
      // The run never started (the bible could not save it, for example): keep it as a question.
      setRunError({ kind: 'other', message: plainError(e) });
      await saveAsQuestion(body);
    }
  };

  const stop = async () => {
    if (runId) await call('claude.stop', { runId });
  };

  const file = async () => {
    if (phase !== 'review' || loading || busy || ro.off) return;
    const ticked = ordered.filter((c) => c.ticked).map((c) => toProposal(c.view));
    const unticked = ordered.filter((c) => !c.ticked).map((c) => toProposal(c.view));
    if (ticked.length + unticked.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await undo.flush();
      const r = await fileCapture(call, ticked, unticked);
      if (r.command) undo.record(r.command);
      setFiled(r.filed);
      setNotFiled(r.failed.length);
      setPhase('filed');
      if (r.failed.length) {
        setMessage(
          `${r.failed.length === 1 ? 'One proposal was' : `${r.failed.length} proposals were`} not filed and still wait in the review queue: ${r.failed[0]?.message ?? ''}`,
        );
      }
    } catch (e) {
      setMessage(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setBoxOpen(false);
    // Proposals not filed stay pending in the review queue (they already are).
    if (phase === 'review' || phase === 'filed' || phase === 'saved') reset();
  };

  if (!open) return null;
  return (
    <CaptureDialog
      phase={shownPhase}
      running={live?.status === 'running'}
      notFiled={notFiled}
      text={text}
      setText={setText}
      sent={sent}
      timeWords={time.words}
      status={status}
      onAcknowledge={async () => setStatus(await call('claude.acknowledge', {}))}
      cards={ordered}
      setTicked={(id, ticked) =>
        setCards((cs) => cs.map((c) => (c.view.proposal._id === id ? { ...c, ticked } : c)))
      }
      streamed={phase === 'running' ? live?.text || 'Claude is looking up what you wrote.' : answer}
      runError={runError}
      filed={filed}
      saved={saved}
      message={message}
      busy={busy}
      readOnly={ro}
      onSend={() => void send()}
      onStop={() => void stop()}
      onFile={() => void file()}
      onClose={close}
      onAnother={() => {
        reset();
        setText('');
      }}
      onSaveQuestion={() => void saveAsQuestion(sent)}
    />
  );
}

function CaptureDialog(props: {
  phase: Phase;
  /** The run is still streaming (Stop applies). */
  running: boolean;
  /** Approvals the last File it could not make; they still wait in the review queue. */
  notFiled: number;
  text: string;
  setText(t: string): void;
  sent: string;
  timeWords: string;
  status: ClaudeStatusWire | null;
  onAcknowledge(): Promise<void>;
  cards: Card[];
  setTicked(id: string, ticked: boolean): void;
  streamed: string;
  runError: RunError | null;
  filed: FiledEntry[];
  saved: { id: string; title: string } | null;
  message: string | null;
  busy: boolean;
  readOnly: ReturnType<typeof useWriteGuard>;
  onSend(): void;
  onStop(): void;
  onFile(): void;
  onClose(): void;
  onAnother(): void;
  onSaveQuestion(): void;
}) {
  const { phase, status, cards, saved } = props;
  const ids = { title: useId(), input: useId(), hint: useId(), time: useId() };
  const dialogRef = useRef<HTMLDivElement>(null);
  const area = useRef<RichTextHandle>(null);
  const opener = useRef<Element | null>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) {
        opener.current.focus();
      }
    };
  }, []);

  // The field grows with the text (A44) and takes focus whenever the box is ready for typing.
  useEffect(() => {
    if (phase === 'edit') area.current?.focus();
    else if (phase !== 'running')
      dialogRef.current?.querySelector<HTMLElement>('[data-focus-first]')?.focus();
  }, [phase]);

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const ticked = cards.filter((c) => c.ticked).length;
  const fileLabel = ticked === cards.length ? 'File it' : `File ${ticked} of ${cards.length}`;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog stack capture-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.time}
        data-testid="capture-box"
        data-phase={phase}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && phase === 'review') {
            e.preventDefault();
            props.onFile();
          }
        }}
      >
        <header className="dialog-head">
          <div className="stack tight">
            <h2 id={ids.title}>Add to the bible</h2>
            <p className="capture-time" id={ids.time} data-testid="capture-time">
              {props.timeWords}
            </p>
          </div>
          <button type="button" className="btn" onClick={props.onClose}>
            Close
          </button>
        </header>

        {needsAck && phase === 'edit' && (
          <Disclosure onConfirm={() => void props.onAcknowledge()} onDecline={props.onClose} />
        )}

        {phase === 'edit' && (
          <div className="field">
            <label id={ids.input}>What do you want to add?</label>
            <RichText
              handle={area}
              mode="inline"
              size="quick"
              className="capture-input"
              labelledBy={ids.input}
              describedBy={ids.hint}
              value={props.text}
              onChange={props.setText}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  props.onSend();
                  return true;
                }
                return false;
              }}
              testId="capture-input"
            />
            <p className="capture-hint" id={ids.hint}>
              Enter sends it to Claude, Shift+Enter for a new line.
              {needsAck ? ' Confirm what Claude sends first.' : ''}
              {props.readOnly.off ? ` ${props.readOnly.tip.title ?? ''}` : ''}
            </p>
          </div>
        )}

        {phase !== 'edit' && props.sent && (
          <blockquote className="capture-sent" data-testid="capture-sent">
            {props.sent}
          </blockquote>
        )}

        {(phase === 'running' || phase === 'review') && (
          <div className="stack tight">
            <div className="capture-answer" aria-live="polite" data-testid="capture-answer">
              {props.streamed}
            </div>
            {phase === 'running' && !props.running && (
              <p data-testid="capture-loading">Loading the proposed changes.</p>
            )}
            {phase === 'running' && props.running && (
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={props.onStop}
                  data-testid="capture-stop"
                >
                  Stop
                </button>
              </div>
            )}
          </div>
        )}

        {props.runError && phase === 'review' && <ClaudeErrorNote error={props.runError} />}

        {(phase === 'running' || phase === 'review') && cards.length > 0 && (
          <ul className="capture-cards" aria-label="Proposed changes" data-testid="capture-cards">
            {cards.map((c, i) => (
              <li key={c.view.proposal._id}>
                <ProposalCheck
                  card={c}
                  first={i === 0}
                  onTick={(t) => props.setTicked(c.view.proposal._id, t)}
                />
              </li>
            ))}
          </ul>
        )}

        {phase === 'review' && cards.length === 0 && (
          <div className="stack tight">
            <p>Claude proposed nothing to file.</p>
            <div>
              <button
                type="button"
                className="btn"
                data-focus-first
                disabled={props.busy || props.readOnly.off}
                onClick={props.onSaveQuestion}
              >
                Save as an open question
              </button>
            </div>
          </div>
        )}

        {phase === 'review' && cards.length > 0 && (
          <div className="row capture-actions">
            <button
              type="button"
              className="btn primary"
              disabled={props.busy || props.readOnly.off}
              {...props.readOnly.tip}
              onClick={props.onFile}
              data-testid="capture-file"
            >
              {ticked === 0 ? 'Reject all' : fileLabel} <kbd>Cmd Enter</kbd>
            </button>
            <button
              type="button"
              className="btn"
              onClick={props.onClose}
              data-testid="capture-later"
            >
              Review later
            </button>
          </div>
        )}

        {phase === 'filed' && (
          <div className="stack tight" data-testid="capture-filed" role="status">
            <h3 tabIndex={-1} data-focus-first>
              Filed
            </h3>
            {props.filed.length === 0 ? (
              <p>
                {props.notFiled > 0
                  ? 'Nothing was filed. The proposals that could not be filed still wait in the review queue.'
                  : 'Nothing was filed; every proposal was rejected.'}
              </p>
            ) : (
              <ul className="capture-filed-list">
                {props.filed.map((f) => (
                  <li key={`${f.collection}:${f.id}`}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        props.onClose();
                        claudeNav.openEntry(f.collection, f.id);
                      }}
                    >
                      {f.title}
                    </button>{' '}
                    <span className="capture-kind">
                      ({collectionInfo[f.collection].singular.toLowerCase()})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              <button type="button" className="btn primary" onClick={props.onAnother}>
                Add another
              </button>
              <button type="button" className="btn" onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {phase === 'saved' && saved && (
          <div className="stack tight" data-testid="capture-saved" role="status">
            {props.runError && (
              <p>{props.runError.message.replace(/ Your question is kept\.$/, '')}</p>
            )}
            <p>
              <strong tabIndex={-1} data-focus-first>
                Saved as an open question
              </strong>
              :{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  props.onClose();
                  claudeNav.openEntry('openQuestions', saved.id);
                }}
              >
                {saved.title}
              </button>
            </p>
            <div className="row">
              <button type="button" className="btn primary" onClick={props.onAnother}>
                Add another
              </button>
              <button type="button" className="btn" onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {props.message && (
          <p className="callout crit" role="alert">
            {props.message}
          </p>
        )}
      </div>
    </div>
  );
}

function ProposalCheck(props: { card: Card; first: boolean; onTick(ticked: boolean): void }) {
  const { view, ticked } = props.card;
  const id = useId();
  return (
    <article
      className="capture-card"
      aria-labelledby={id}
      data-testid="capture-card"
      data-proposal={view.proposal._id}
    >
      <label className="capture-card-head">
        <input
          type="checkbox"
          checked={ticked}
          onChange={(e) => props.onTick(e.target.checked)}
          data-focus-first={props.first ? '' : undefined}
          data-testid="capture-tick"
        />
        <span id={id}>{cardTitle(view)}</span>
      </label>
      {view.proposal.reason && <p className="capture-reason">{view.proposal.reason}</p>}
      <ProposalDiff view={view} />
    </article>
  );
}
