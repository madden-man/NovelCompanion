import { useBibleSettings, useDefaultStatus } from './bibleSettings';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ClaudeStatusWire, RunError } from '../../../shared/claude';
import type { ProposalView } from '../../../shared/ipc';
import { collectionInfo, entryTitle, isEntryCollection } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { StoryTimeValue } from '../../../shared/storyTime';
import {
  captureQuestionData,
  fileCapture,
  fileLocalDrafts,
  mergeFilings,
} from '../../../shared/domain/capture';
import type { CaptureProposal, FiledEntry, Filing } from '../../../shared/domain/capture';
import type { CaptureFact, CaptureHint } from '../../../shared/domain/captureRouter';
import { localDateString } from '../../../shared/domain/sessionLog';
import { useWriteGuard } from '../connection';
import { call, plainError } from '../api';
import { ClaudeErrorNote, Disclosure, claudeNav, newRunId, useRunStream, watchRun } from './claude';
import type { LiveRun } from './claude';
import { useEntries, useStore } from './data';
import { useFocusTrap } from './focusTrap';
import { ProposalDiff } from './review';
import { formatMoment, useStoryTime } from './storyTime';
import { createCommand } from '../../../shared/domain/undoRunner';
import { useUndo } from './undo';
import { RichText } from './richText/RichText';
import type { RichTextHandle } from './richText/RichText';
import {
  CAPTURE_MAX_FACTS,
  CAPTURE_TOO_MANY_FACTS,
  NO_CHOICE,
  draftsWith,
  loadCaptureBible,
  openAsks,
  routeWith,
  sendHints,
} from './captureLocal';
import type { CaptureBible, FactChoice } from './captureLocal';
import { FactCard } from './captureChips';
import type { FactStand } from './captureChips';
import './capture.css';

/**
 * Capture (KB-6, KB-7, A34, A48): Cmd+K, or Add in the status bar, opens a box
 * on every screen. Enter runs the capture router (CR-6) before anything is
 * sent: each sentence becomes a fact with its section, chips and drafts. A
 * fact the router can place (Route A) files from the box without Claude; the
 * rest go to Claude at once with the writer's hints (CR-9), and their
 * proposals stream in as ED-7 diffs. File it writes the ticked drafts and
 * approves the ticked proposals as one undo step. Nothing is written before
 * File it (AI-3). Without a key, offline, or when every run fails, the text
 * is saved as an open question (KB-7).
 */
/** What the field's hint says Enter does (CR-6), Alt+Enter (CR-5) and Shift+Enter. */
const CAPTURE_HINT =
  'Enter shows where each sentence goes; nothing is filed before File it. Alt+Enter sends it all to Claude. Shift+Enter for a new line.';

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

/**
 * The box's phases. `routed` follows Enter: the facts as cards, Route A ones
 * waiting for File it, the others streaming from Claude. `data-phase` reads
 * `running` while a run streams or its diffs load.
 */
type Phase = 'edit' | 'routed' | 'filed' | 'saved';
type ShownPhase = Phase | 'running';

interface Card {
  view: ProposalView;
  ticked: boolean;
}

/** One Claude run started from the box: the facts it files and what it proposed. */
interface RunState {
  /** The ID `claude.capture` was called with; `claude.stop` takes it. */
  requestId: string;
  runId: string;
  route: 'fast' | 'full';
  conversationId: string;
  facts: number[];
  live: LiveRun | null;
  cards: Card[];
  /** Proposals whose diff could not be read; they wait in the review queue. */
  unread: string[];
  /** CR-7: the facts the fast file could not place, with why. */
  cannotPlace: { fact: number; reason: string }[];
  finished: boolean;
}

/** The routed capture: the text sent, the bible it was routed against, and each fact's state. */
interface Routed {
  text: string;
  bible: CaptureBible;
  storyYear: number;
  facts: CaptureFact[];
  choices: FactChoice[];
  ticks: boolean[];
  /** The run that handles each fact, once it is sent. */
  sentTo: (string | null)[];
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

const OP_TEXT = {
  create: 'New',
  update: 'Change to',
  delete: 'Move to trash:',
  listAdd: 'New list item:',
} as const;

function cardTitle(v: ProposalView): string {
  if (v.proposal.listAdd) return `${OP_TEXT.listAdd} ${v.proposal.listAdd.label}`;
  const c = v.proposal.collection;
  const kind = isEntryCollection(c) ? collectionInfo[c].singular.toLowerCase() : c;
  const name = v.targetTitle ?? entryTitle(v.proposal.data);
  return `${OP_TEXT[v.proposal.op]} ${kind} ${name}`;
}

const NO_FILING: Filing = { filed: [], minted: [], rejected: [], failed: [], command: null };

/** The cards of a run in the order Claude made them. */
function orderedCards(r: RunState): Card[] {
  const order = r.live?.proposalIds ?? [];
  return [...r.cards].sort(
    (a, b) => order.indexOf(a.view.proposal._id) - order.indexOf(b.view.proposal._id),
  );
}

/** A run is still busy while it streams or while the diffs of its proposals load. */
const runBusy = (r: RunState) =>
  !r.finished || (r.live?.proposalIds.length ?? 0) > r.cards.length + r.unread.length;

/** Follows one run's stream for the box, even while the box is closed. */
function RunWatch({ runId, onLive }: { runId: string; onLive(live: LiveRun): void }) {
  const live = useRunStream(runId);
  useEffect(() => {
    if (live) onLive(live);
  }, [live, onLive]);
  return null;
}

/** Where a fact stands: filed by the box, re-routed and not sent, or sent. */
function standOf(routed: Routed, i: number): FactStand {
  if (routed.sentTo[i]) return 'sent';
  return routed.facts[i]?.route === 'local' ? 'local' : 'unsent';
}

/**
 * Mounted once in the frame. The box's state lives here, so closing the box
 * mid-run does not lose the run: its proposals still land, and a failure is
 * still saved as an open question (KB-7).
 */
export function CaptureBox() {
  const statusOf = useDefaultStatus();
  const settings = useBibleSettings();
  const { lists } = useStore();
  const open = useBoxOpen();
  const undo = useUndo();
  const ro = useWriteGuard();
  const time = useStoryTimeWords();
  const [status, setStatus] = useState<ClaudeStatusWire | null>(null);
  const [phase, setPhase] = useState<Phase>('edit');
  const [text, setText] = useState('');
  const [routed, setRouted] = useState<Routed | null>(null);
  const [runs, setRuns] = useState<RunState[]>([]);
  /** Sends whose `claude.capture` call has not answered yet. */
  const [sending, setSending] = useState(0);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [filed, setFiled] = useState<FiledEntry[]>([]);
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Routed with no key: only Route A facts, filed without Claude (KB-7, CR-6). */
  const [noKey, setNoKey] = useState(false);
  const fetched = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  /** The routed capture already ended in KB-7 (saved, or the text put back). */
  const settled = useRef(false);
  /** What the last File it could not do (approvals that failed stay pending). */
  const [notFiled, setNotFiled] = useState(0);
  const capturedOn = localDateString(new Date());

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
    setRouted(null);
    setRuns([]);
    setRunError(null);
    setFiled([]);
    setSaved(null);
    setMessage(null);
    setNoKey(false);
    setNotFiled(0);
    fetched.current = new Set();
    handled.current = new Set();
    settled.current = false;
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

  const onLive = useCallback((live: LiveRun) => {
    setRuns((rs) => rs.map((r) => (r.runId === live.runId ? { ...r, live } : r)));
  }, []);

  // Each proposal shows as it arrives, with its diff against the entry as it is now.
  useEffect(() => {
    for (const r of runs) {
      for (const id of r.live?.proposalIds ?? []) {
        if (fetched.current.has(id)) continue;
        fetched.current.add(id);
        const into = (change: (run: RunState) => RunState) =>
          setRuns((rs) => rs.map((x) => (x.runId === r.runId ? change(x) : x)));
        call('proposal.diff', { id }).then(
          (view) =>
            into((x) =>
              x.cards.some((c) => c.view.proposal._id === id)
                ? x
                : { ...x, cards: [...x.cards, { view, ticked: true }] },
            ),
          (e: unknown) => {
            into((x) => ({ ...x, unread: [...x.unread, id] }));
            setMessage(
              `One proposed change could not be shown and waits in the review queue: ${plainError(e)}`,
            );
          },
        );
      }
    }
  }, [runs]);

  // A run that ends: the fast file's facts it could not place come back with their reasons (CR-7).
  useEffect(() => {
    for (const r of runs) {
      if (!r.live || r.live.status === 'running' || handled.current.has(r.runId)) continue;
      handled.current.add(r.runId);
      const finish = (cannotPlace: RunState['cannotPlace']) =>
        setRuns((rs) =>
          rs.map((x) => (x.runId === r.runId ? { ...x, finished: true, cannotPlace } : x)),
        );
      if (r.route === 'fast' && r.live.status === 'done') {
        void call('claude.run', { id: r.conversationId }).then(
          ({ run }) => {
            const out = run.output as { cannotPlace?: RunState['cannotPlace'] } | null | undefined;
            finish(Array.isArray(out?.cannotPlace) ? out.cannotPlace : []);
          },
          () => finish([]),
        );
      } else finish([]);
    }
  }, [runs]);

  // KB-7: when every fact went to Claude and nothing came back, the text is not lost.
  useEffect(() => {
    if (!routed || settled.current || sending > 0 || !runs.length) return;
    if (runs.some((r) => !r.finished)) return;
    if (routed.sentTo.some((s) => s === null)) return;
    if (runs.some((r) => (r.live?.proposalIds.length ?? 0) > 0)) return;
    const failed = runs.find((r) => r.live?.status === 'failed');
    const stopped = runs.every((r) => r.live?.status === 'stopped');
    if (!failed && !stopped) return;
    settled.current = true;
    // The outcome is a write (KB-7) or the text put back; neither belongs in the render pass.
    queueMicrotask(() => {
      if (failed) {
        setRunError(failed.live?.error ?? null);
        void saveAsQuestion(routed.text);
        return;
      }
      setText((t) => t || routed.text);
      setRouted(null);
      setRuns([]);
      setPhase('edit');
      setMessage('Stopped. Nothing was proposed; your text is back in the box.');
    });
  }, [routed, runs, sending, saveAsQuestion]);

  const running = sending > 0 || runs.some(runBusy);
  const shownPhase: ShownPhase = phase === 'routed' && running ? 'running' : phase;

  /**
   * IP-17: after a proposed value or a new item's name is edited, every card
   * reads its diff again, since a line shows the name of the item it uses.
   */
  const refreshCards = useCallback(async () => {
    const ids = runs.flatMap((r) => r.cards.map((c) => c.view.proposal._id));
    const views = await Promise.all(ids.map((id) => call('proposal.diff', { id })));
    setRuns((rs) =>
      rs.map((r) => ({
        ...r,
        cards: r.cards.map((c) => ({
          ...c,
          view: views.find((v) => v.proposal._id === c.view.proposal._id) ?? c.view,
        })),
      })),
    );
  }, [runs]);

  /**
   * CR-9: send the facts in `which` to Claude with the text and the hints;
   * every other fact carries `route: 'local'`, so main skips it. `force`
   * sends them on Route C (Ask Claude instead).
   */
  const startRuns = async (
    r: Routed,
    which: ReadonlySet<number>,
    force?: 'full',
  ): Promise<boolean> => {
    const requestId = newRunId();
    watchRun(requestId);
    const hints: CaptureHint[] = sendHints(r.facts, r.choices, which, force);
    setSending((n) => n + 1);
    try {
      const res = await call('claude.capture', {
        runId: requestId,
        text: r.text,
        storyTime: time.value,
        hints,
      });
      if (!res.started) return false;
      setRuns((rs) => [
        ...rs,
        ...res.runs.map((x) => ({
          requestId,
          runId: x.runId,
          route: x.route,
          conversationId: x.conversationId,
          facts: x.facts,
          live: null,
          cards: [],
          unread: [],
          cannotPlace: [],
          finished: false,
        })),
      ]);
      setRouted((cur) =>
        cur
          ? {
              ...cur,
              sentTo: cur.sentTo.map(
                (v, i) => res.runs.find((x) => x.facts.includes(i))?.runId ?? v,
              ),
            }
          : cur,
      );
      return true;
    } catch (e) {
      setMessage(`Claude was not asked: ${plainError(e)}`);
      setRunError({ kind: 'other', message: plainError(e) });
      return false;
    } finally {
      setSending((n) => n - 1);
    }
  };

  /** Enter (CR-6): route first. Alt+Enter: send every fact to Claude on Route C (CR-5). */
  const send = async (all = false) => {
    const body = text.trim();
    if (!body || phase !== 'edit' || busy || ro.off) return;
    setMessage(null);
    setRunError(null);
    setBusy(true);
    let bible: CaptureBible;
    try {
      bible = await loadCaptureBible(call, settings.numbers.timelineEnd, time.value);
    } catch (e) {
      setBusy(false);
      setMessage(`The bible could not be read to place the text: ${plainError(e)}`);
      return;
    }
    const facts = routeWith(body, bible, time.value.year, []);
    if (facts.length > CAPTURE_MAX_FACTS) {
      setBusy(false);
      setMessage(CAPTURE_TOO_MANY_FACTS);
      return;
    }
    if (!facts.length) {
      setBusy(false);
      return;
    }
    const fresh = await call('claude.status', {}).catch(() => status);
    if (fresh) setStatus(fresh);
    setBusy(false);
    const toClaude = new Set(facts.filter((f) => all || f.route !== 'local').map((f) => f.index));
    // KB-7: with no key nothing can be sent, so a capture that needs Claude is kept as an open question.
    if (toClaude.size && !fresh?.key.set) {
      await saveAsQuestion(body);
      return;
    }
    if (toClaude.size && !fresh?.acknowledgedAt) return;
    const r: Routed = {
      text: body,
      bible,
      storyYear: time.value.year,
      facts,
      choices: facts.map(() => NO_CHOICE),
      ticks: facts.map(() => true),
      sentTo: facts.map(() => null),
    };
    fetched.current = new Set();
    handled.current = new Set();
    settled.current = false;
    setRuns([]);
    setRouted(r);
    setNoKey(!fresh?.key.set);
    setText('');
    setPhase('routed');
    if (!toClaude.size) return;
    const ok = await startRuns(r, toClaude, all ? 'full' : undefined);
    // The run never started (the bible could not save it, for example): keep it as a question.
    if (!ok && toClaude.size === facts.length) {
      settled.current = true;
      await saveAsQuestion(body);
    }
  };

  /** A chip changed (CR-6): route the text again with the writer's choices; sent facts stay as sent. */
  const choose = (
    i: number,
    patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> },
  ) => {
    setRouted((cur) => {
      if (!cur) return cur;
      const choices = cur.choices.map((c, j) =>
        j === i ? { hint: { ...c.hint, ...patch.hint }, typed: { ...c.typed, ...patch.typed } } : c,
      );
      const facts = routeWith(cur.text, cur.bible, cur.storyYear, choices).map((f, j) =>
        cur.sentTo[j] ? (cur.facts[j] ?? f) : f,
      );
      return { ...cur, choices, facts };
    });
  };

  const sendFact = async (i: number, force?: 'full') => {
    if (!routed || busy) return;
    const fresh = await call('claude.status', {}).catch(() => status);
    if (fresh) setStatus(fresh);
    if (!fresh?.key.set || !fresh.acknowledgedAt) return;
    setMessage(null);
    await startRuns(routed, new Set([i]), force);
  };

  const stop = async () => {
    const ids = new Set(runs.filter((r) => !r.finished).map((r) => r.requestId));
    for (const runId of ids) await call('claude.stop', { runId });
  };

  /** Route A facts waiting for a chip; File it waits for them (CR-6). */
  const waiting = routed
    ? routed.facts.filter(
        (f) =>
          standOf(routed, f.index) === 'local' &&
          openAsks(f, routed.choices[f.index] ?? NO_CHOICE).length,
      )
    : [];
  const localFacts = routed ? routed.facts.filter((f) => standOf(routed, f.index) === 'local') : [];
  const allCards = runs.flatMap(orderedCards);

  const file = async () => {
    if (!routed || phase !== 'routed' || running || busy || ro.off || waiting.length) return;
    const ticked = localFacts.filter((f) => routed.ticks[f.index]);
    const drafts = ticked.flatMap((f) => draftsWith(f, routed.choices[f.index] ?? NO_CHOICE));
    const tickedCards = allCards.filter((c) => c.ticked).map((c) => toProposal(c.view));
    const untickedCards = allCards.filter((c) => !c.ticked).map((c) => toProposal(c.view));
    if (!drafts.length && !allCards.length) return;
    setBusy(true);
    setMessage(null);
    try {
      await undo.flush();
      // CR-9: the box's own drafts, then the proposals, as one undo step.
      const local = drafts.length
        ? await fileLocalDrafts(call, drafts, capturedOn, statusOf('idea'))
        : NO_FILING;
      const approved = allCards.length
        ? await fileCapture(call, tickedCards, untickedCards)
        : NO_FILING;
      const r = mergeFilings(local, approved);
      if (r.command) undo.record(r.command);
      setFiled(r.filed);
      setNotFiled(r.failed.length);
      setPhase('filed');
      if (r.failed.length) {
        setMessage(
          `${r.failed.length === 1 ? 'One change was' : `${r.failed.length} changes were`} not filed: ${r.failed[0]?.message ?? ''} Proposals that were not filed still wait in the review queue.`,
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
    // Proposals not filed stay pending in the review queue (they already are); drafts are dropped.
    if (phase === 'filed' || phase === 'saved' || (phase === 'routed' && !running)) reset();
  };

  /**
   * Review later: the proposals wait in the review queue, and the facts the
   * box would file are kept as the KB-7 open question (CR-6).
   */
  const later = async () => {
    if (!routed) return close();
    const kept = routed.facts.filter((f) => !routed.sentTo[f.index]);
    if (!kept.length) return close();
    const body =
      kept.length === routed.facts.length ? routed.text : kept.map((f) => f.text).join(' ');
    settled.current = true;
    await saveAsQuestion(body);
  };

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const claudeOff = noKey
    ? 'No Anthropic key is set. Add one in Settings to ask Claude.'
    : needsAck
      ? 'Confirm what Claude sends first.'
      : ro.off
        ? (ro.tip.title ?? 'The bible is read-only.')
        : null;

  return (
    <>
      {runs.map((r) => (
        <RunWatch key={r.runId} runId={r.runId} onLive={onLive} />
      ))}
      {open && (
        <CaptureDialog
          phase={shownPhase}
          running={runs.some((r) => !r.finished) || sending > 0}
          notFiled={notFiled}
          text={text}
          setText={setText}
          routed={routed}
          runs={runs}
          lists={lists}
          ideaStatus={statusOf('idea')}
          capturedOn={capturedOn}
          noKey={noKey}
          claudeOff={claudeOff}
          waiting={waiting.length}
          timeWords={time.words}
          status={status}
          onAcknowledge={async () => setStatus(await call('claude.acknowledge', {}))}
          setTicked={(id, ticked) =>
            setRuns((rs) =>
              rs.map((r) => ({
                ...r,
                cards: r.cards.map((c) => (c.view.proposal._id === id ? { ...c, ticked } : c)),
              })),
            )
          }
          setFactTicked={(i, ticked) =>
            setRouted((cur) =>
              cur ? { ...cur, ticks: cur.ticks.map((t, j) => (j === i ? ticked : t)) } : cur,
            )
          }
          onChoose={choose}
          onAskClaude={(i) => void sendFact(i, 'full')}
          onSendFact={(i) => void sendFact(i)}
          onEdited={refreshCards}
          runError={runError}
          filed={filed}
          saved={saved}
          message={message}
          busy={busy}
          readOnly={ro}
          onSend={(all) => void send(all)}
          onStop={() => void stop()}
          onFile={() => void file()}
          onClose={close}
          onLater={() => void later()}
          onAnother={() => {
            reset();
            setText('');
          }}
          onSaveQuestion={() => routed && void saveAsQuestion(routed.text)}
        />
      )}
    </>
  );
}

function CaptureDialog(props: {
  phase: ShownPhase;
  /** A run is still streaming (Stop applies). */
  running: boolean;
  /** Changes the last File it could not make. */
  notFiled: number;
  text: string;
  setText(t: string): void;
  routed: Routed | null;
  runs: RunState[];
  lists: ReturnType<typeof useStore>['lists'];
  ideaStatus: string;
  capturedOn: string;
  noKey: boolean;
  claudeOff: string | null;
  /** Route A facts waiting for a chip. */
  waiting: number;
  timeWords: string;
  status: ClaudeStatusWire | null;
  onAcknowledge(): Promise<void>;
  setTicked(id: string, ticked: boolean): void;
  setFactTicked(fact: number, ticked: boolean): void;
  onChoose(
    fact: number,
    patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> },
  ): void;
  onAskClaude(fact: number): void;
  onSendFact(fact: number): void;
  /** A proposed value was edited: read every card's diff again. */
  onEdited(): Promise<void>;
  runError: RunError | null;
  filed: FiledEntry[];
  saved: { id: string; title: string } | null;
  message: string | null;
  busy: boolean;
  readOnly: ReturnType<typeof useWriteGuard>;
  onSend(all: boolean): void;
  onStop(): void;
  onFile(): void;
  onClose(): void;
  onLater(): void;
  onAnother(): void;
  onSaveQuestion(): void;
}) {
  const { phase, status, routed, runs, saved } = props;
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
  const settledPhase = phase === 'running' ? 'routed' : phase;
  useEffect(() => {
    if (settledPhase === 'edit') area.current?.focus();
    else if (phase !== 'running') {
      const box = dialogRef.current;
      (
        box?.querySelector<HTMLElement>('[data-focus-first]') ??
        box?.querySelector<HTMLElement>('[data-testid="capture-tick"]')
      )?.focus();
    }
    // Focus moves when the phase settles, not on every chip change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPhase, phase === 'running']);

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const inBox = phase === 'routed' || phase === 'running';
  const cards = runs.flatMap(orderedCards);
  const localFacts = routed ? routed.facts.filter((f) => standOf(routed, f.index) === 'local') : [];
  const localTicked = routed
    ? localFacts.filter(
        (f) => routed.ticks[f.index] && !openAsks(f, routed.choices[f.index] ?? NO_CHOICE).length,
      ).length
    : 0;
  const total = localFacts.length + cards.length;
  const ticked = localTicked + cards.filter((c) => c.ticked).length;
  const fileLabel = ticked === total ? 'File it' : `File ${ticked} of ${total}`;
  const onlyClaude = routed !== null && localFacts.length === 0;
  const anyUnread = runs.some((r) => r.unread.length > 0);

  /** The runs drawn under a fact: those whose first fact it is. */
  const runsUnder = (i: number) => runs.filter((r) => Math.min(...r.facts) === i);

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
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && phase === 'routed') {
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

        {needsAck && (phase === 'edit' || inBox) && (
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
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  props.onSend(e.altKey);
                  return true;
                }
                return false;
              }}
              testId="capture-input"
            />
            <p className="capture-hint" id={ids.hint}>
              {CAPTURE_HINT}
              {needsAck ? ' Confirm what Claude sends first.' : ''}
              {props.readOnly.off ? ` ${props.readOnly.tip.title ?? ''}` : ''}
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={props.busy || props.readOnly.off || !props.text.trim()}
                onClick={() => props.onSend(true)}
                data-testid="capture-send-all"
              >
                Send it all to Claude <kbd>Alt Enter</kbd>
              </button>
            </div>
          </div>
        )}

        {phase !== 'edit' && routed && (
          <blockquote className="capture-sent" data-testid="capture-sent">
            {routed.text}
          </blockquote>
        )}

        {inBox && props.noKey && (
          <p className="capture-note" data-testid="capture-no-key">
            No Anthropic key is set, so these file here without Claude.
          </p>
        )}

        {inBox && routed && (
          <ol className="capture-facts" aria-label="What you added" data-testid="capture-facts">
            {routed.facts.map((f, i) => {
              const sent = routed.sentTo[i];
              const sentRun = sent ? runs.find((r) => r.runId === sent) : undefined;
              return (
                <li key={i}>
                  <FactCard
                    fact={f}
                    choice={routed.choices[i] ?? NO_CHOICE}
                    stand={standOf(routed, i)}
                    sentRoute={sentRun?.route}
                    ticked={routed.ticks[i] ?? true}
                    first={i === 0}
                    lists={props.lists}
                    index={routed.bible.index}
                    status={props.ideaStatus}
                    capturedOn={props.capturedOn}
                    busy={props.busy || phase === 'running'}
                    claudeOff={props.claudeOff}
                    onTick={(t) => props.setFactTicked(i, t)}
                    onChoose={(patch) => props.onChoose(i, patch)}
                    onAskClaude={() => props.onAskClaude(i)}
                    onSend={() => props.onSendFact(i)}
                  >
                    {runs
                      .flatMap((r) =>
                        r.cannotPlace.filter((c) => c.fact === i).map((c) => ({ r, c })),
                      )
                      .filter(({ r }) => r.runId === sent)
                      .map(({ c }) => (
                        <div
                          key={`cannot-${c.fact}`}
                          className="callout stack tight"
                          data-testid="capture-cannot-place"
                        >
                          <span>Claude could not place this. {c.reason}</span>
                          <div>
                            <button
                              type="button"
                              className="btn small"
                              disabled={props.busy || props.claudeOff !== null}
                              title={props.claudeOff ?? undefined}
                              onClick={() => props.onAskClaude(i)}
                              data-testid="capture-ask-claude"
                            >
                              Ask Claude instead
                            </button>
                          </div>
                        </div>
                      ))}
                    {runsUnder(i).map((r) => (
                      <RunBlock
                        key={r.runId}
                        run={r}
                        several={r.facts.length > 1}
                        busy={props.busy}
                        editable={phase === 'routed' && !props.busy}
                        onStop={props.onStop}
                        setTicked={props.setTicked}
                        onEdited={props.onEdited}
                      />
                    ))}
                  </FactCard>
                </li>
              );
            })}
          </ol>
        )}

        {phase === 'running' && props.running && (
          <div>
            <button type="button" className="btn" onClick={props.onStop} data-testid="capture-stop">
              Stop
            </button>
          </div>
        )}
        {phase === 'running' && !props.running && (
          <p data-testid="capture-loading">Loading the proposed changes.</p>
        )}

        {phase === 'routed' && onlyClaude && cards.length === 0 && !anyUnread && (
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

        {phase === 'routed' && total > 0 && (
          <div className="stack tight">
            <div className="row capture-actions">
              <button
                type="button"
                className="btn primary"
                disabled={props.busy || props.readOnly.off || props.waiting > 0}
                {...props.readOnly.tip}
                onClick={props.onFile}
                data-testid="capture-file"
              >
                {ticked === 0 ? (cards.length ? 'Reject all' : 'File nothing') : fileLabel}{' '}
                <kbd>Cmd Enter</kbd>
              </button>
              <button
                type="button"
                className="btn"
                disabled={props.busy}
                onClick={props.onLater}
                data-testid="capture-later"
              >
                Review later
              </button>
            </div>
            {props.waiting > 0 && (
              <p className="capture-needed" data-testid="capture-file-waits">
                File it waits for the highlighted chips.
              </p>
            )}
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

/** One Claude run under its fact: the streamed answer, the error, and each proposal as a card. */
function RunBlock(props: {
  run: RunState;
  several: boolean;
  busy: boolean;
  editable: boolean;
  onStop(): void;
  setTicked(id: string, ticked: boolean): void;
  onEdited(): Promise<void>;
}) {
  const { run } = props;
  const live = run.live;
  const cards = orderedCards(run);
  const streaming = !run.finished;
  return (
    <div className="stack tight capture-run" data-testid="capture-run" data-route={run.route}>
      {props.several && (
        <p className="capture-cues">
          Claude files sentences {run.facts.map((f) => f + 1).join(', ')} together.
        </p>
      )}
      <div className="capture-answer" aria-live="polite" data-testid="capture-answer">
        {streaming ? live?.text || 'Claude is looking up what you wrote.' : (live?.text ?? '')}
      </div>
      {live?.error && run.finished && <ClaudeErrorNote error={live.error} />}
      {cards.length > 0 && (
        <ul className="capture-cards" aria-label="Proposed changes" data-testid="capture-cards">
          {cards.map((c) => (
            <li key={c.view.proposal._id}>
              <ProposalCheck
                card={c}
                first={false}
                editable={props.editable}
                onTick={(t) => props.setTicked(c.view.proposal._id, t)}
                onEdited={props.onEdited}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One proposal in the capture box: its tick, its reason, and its diff. While
 * the box is in review, each proposed value is a field (IP-17): the edit goes
 * into the proposal, and File it writes it.
 */
function ProposalCheck(props: {
  card: Card;
  first: boolean;
  editable: boolean;
  onTick(ticked: boolean): void;
  onEdited(): Promise<void>;
}) {
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
      <ProposalDiff
        view={view}
        edit={props.editable ? 'values' : undefined}
        onEdited={props.onEdited}
      />
    </article>
  );
}
