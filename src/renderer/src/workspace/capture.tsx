import { useBibleSettings } from './bibleSettings';
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
import {
  captureQuestionData,
  fileCapture,
  fileLocalDrafts,
  mergeFilings,
} from '../../../shared/domain/capture';
import type { CaptureProposal, FiledEntry, Filing } from '../../../shared/domain/capture';
import type { CaptureFact, CaptureHint } from '../../../shared/domain/captureRouter';
import { useWriteGuard } from '../connection';
import { call, plainError } from '../api';
import { ClaudeErrorNote, Disclosure, claudeNav, newRunId, useRunStream, watchRun } from './claude';
import type { LiveRun } from './claude';
import { useChapterNumbers, useEntries, useStore } from './data';
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
import { ClaudeKeyField, FactCard } from './captureChips';
import type { FactStand } from './captureChips';
import './capture.css';

/**
 * Capture (KB-6, KB-7, A34, A48): Cmd+K, or Add in the status bar, opens a box
 * on every screen. The capture router (CR-6) runs on a short pause in the
 * typing (A57), so each sentence shows as a fact with its section, chips and
 * drafts before anything is pressed. A fact the router can place (Route A)
 * files from the box without Claude: when every fact does, Enter is File it.
 * Otherwise Enter sends the rest to Claude with the writer's hints (CR-9),
 * their proposals stream in as ED-7 diffs, and File it (Cmd+Enter) writes the
 * ticked drafts and approves the ticked proposals as one undo step. Nothing is
 * written before File it (AI-3). Without a key, offline, or when every run
 * fails, the text is saved as an open question (KB-7). No line in the box
 * says how to use it: the buttons carry their keys.
 */
/** A57: how long the typing rests before the router places the sentences. */
const ROUTE_PAUSE_MS = 300;

let boxOpen = false;
const openListeners = new Set<() => void>();
function setBoxOpen(open: boolean): void {
  if (boxOpen === open) return;
  boxOpen = open;
  for (const l of openListeners) l();
}

/** A35: who hears a prefill such as "Cultural context for Pacific States, 2055: ". */
const prefillListeners = new Set<(text: string) => void>();

/**
 * A56 (FN-6): a sentence handed over from the From the notebook tray, with
 * its year and chips, to send on its route as if typed and entered here.
 */
export interface CaptureSendRequest {
  text: string;
  year: number;
  hint?: Omit<CaptureHint, 'fact'>;
  /** Ask Claude instead: Route C (CR-5). */
  all?: boolean;
  /**
   * A56 (FN-6): called when the sentence ends unfiled after all (the run
   * failed or was stopped, or the box closed without filing it), so the tray
   * offers it again. Never called once it is filed or kept for review.
   */
  onUnfiled?: () => void;
}
/** What came of a hand-over: sent to Claude, the box busy with another capture, or not sent. */
export type CaptureSendResult = 'sent' | 'busy' | 'not sent';
let sendHandler: ((r: CaptureSendRequest) => Promise<CaptureSendResult>) | null = null;

export const captureNav = {
  open: (prefill?: string) => {
    if (prefill) for (const l of prefillListeners) l(prefill);
    setBoxOpen(true);
  },
  close: () => setBoxOpen(false),
  /** A56 (FN-6): open the box on the sentence and send it; nothing is sent before this is called. */
  send: (r: CaptureSendRequest): Promise<CaptureSendResult> =>
    sendHandler ? sendHandler(r) : Promise.resolve('not sent'),
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
  /** The story time sent with it: the top bar's, or the year a tray sentence was written in (FN-6). */
  storyTime: StoryTimeValue;
  facts: CaptureFact[];
  choices: FactChoice[];
  ticks: boolean[];
  /** The run that handles each fact, once it is sent. */
  sentTo: (string | null)[];
  /** KB-7 with no key: the facts that needed Claude, saved as one open question. */
  asked: boolean[];
}

/** The story time in words, with the chapter and strand being written. */
function useStoryTimeWords(): { value: StoryTimeValue; words: string } {
  const story = useStoryTime();
  const chapters = useEntries('chapters');
  const numbers = useChapterNumbers();
  const value: StoryTimeValue = story.time ?? { year: story.year };
  const chapter = value.chapterId ? chapters.find((c) => c._id === value.chapterId) : undefined;
  const strands = Array.isArray(chapter?.strands)
    ? (chapter.strands as { id: string; label: string }[])
    : [];
  const strand = strands.find((s) => s.id === value.strandId);
  const where = chapter
    ? `, writing Chapter ${numbers.get(chapter._id) ?? ''}: ${entryTitle(chapter)}${strand ? `, ${strand.label}` : ''}`
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

/**
 * KB-7, AI-7: a run that failed or was stopped before it proposed anything
 * hands its facts back to the box, so their sentences are never lost.
 */
const dropped = (r: RunState | undefined): boolean =>
  !!r &&
  r.finished &&
  (r.live?.status === 'failed' || r.live?.status === 'stopped') &&
  (r.live?.proposalIds.length ?? 0) === 0;

/** Where a fact stands: filed by the box, re-routed or handed back and not sent, or sent. */
function standOf(routed: Routed, runs: readonly RunState[], i: number): FactStand {
  if (routed.asked[i]) return 'question';
  const sent = routed.sentTo[i];
  const run = sent ? runs.find((r) => r.runId === sent) : undefined;
  // A fact the fast file could not place comes back too (CR-7), with Ask Claude instead.
  if (sent && !dropped(run) && !run?.cannotPlace.some((c) => c.fact === i)) return 'sent';
  return routed.facts[i]?.route === 'local' ? 'local' : 'unsent';
}

/** A57: what the writer set on a sentence while typing, kept by the sentence's text. */
interface EditMark {
  choice?: FactChoice;
  ticked?: boolean;
}
type EditMarks = Record<string, EditMark>;

interface TypedRouting {
  facts: CaptureFact[];
  choices: FactChoice[];
  ticks: boolean[];
}
const NO_PREVIEW: TypedRouting = { facts: [], choices: [], ticks: [] };

/**
 * A57: route the text as typed with the chips and ticks set on its sentences.
 * The plain routing names the sentences; a sentence that has a mark is routed
 * again with its chips, so a chip stays with its sentence when another changes.
 */
function routeTyped(
  body: string,
  bible: CaptureBible,
  storyYear: number,
  marks: EditMarks,
): TypedRouting {
  const plain = routeWith(body, bible, storyYear, []);
  const choices = plain.map((f) => marks[f.text]?.choice ?? NO_CHOICE);
  const facts = choices.some((c) => c !== NO_CHOICE)
    ? routeWith(body, bible, storyYear, choices)
    : plain;
  return { facts, choices, ticks: plain.map((f) => marks[f.text]?.ticked ?? true) };
}

/**
 * Mounted once in the frame. The box's state lives here, so closing the box
 * mid-run does not lose the run: its proposals still land, and a failure is
 * still saved as an open question (KB-7).
 */
export function CaptureBox() {
  const settings = useBibleSettings();
  const { lists, version } = useStore();
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
  /** A57: the key field in place, opened by Add a Claude key. */
  const [keyOpen, setKeyOpen] = useState(false);
  /** A57: the text the router last placed while typing, and the writer's chips and ticks on it. */
  const [quietText, setQuietText] = useState('');
  const [editMarks, setEditMarks] = useState<EditMarks>({});
  const [previewBible, setPreviewBible] = useState<CaptureBible | null>(null);
  /** One send at a time: Enter in the field and on the dialog must not both route. */
  const sendingNow = useRef(false);
  const fetched = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  /** Request IDs whose `claude.capture` call has not answered yet; Stop stops them too. */
  const pending = useRef(new Set<string>());
  /** The writer asked for Claude on a fact the box files: show the AI-6 confirmation. */
  const [askAck, setAskAck] = useState(false);
  /** The routed capture already ended in KB-7 (saved, or the text put back). */
  const settled = useRef(false);
  /** A56 (FN-6): the tray's hand-over still waiting to be filed; called back if it is not. */
  const handOver = useRef<(() => void) | null>(null);
  const releaseHandOver = useCallback(() => {
    const back = handOver.current;
    handOver.current = null;
    back?.();
  }, []);
  /** What the last File it could not do (approvals that failed stay pending). */
  const [notFiled, setNotFiled] = useState(0);
  /** Sentences the last File it put back in the box (unsent, or a draft that failed). */
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // Another modal dialog (Story Time) holds focus: two focus traps would fight.
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

  // A57: the router runs on a pause in the typing; an emptied box forgets its chips.
  useEffect(() => {
    const empty = !text.trim();
    const t = setTimeout(
      () => {
        setQuietText(empty ? '' : text);
        if (empty) {
          setEditMarks({});
        }
      },
      empty ? 0 : ROUTE_PAUSE_MS,
    );
    return () => clearTimeout(t);
  }, [text]);

  // A57: the bible the typing is placed against, read when the box opens and after each write.
  const timeKey = JSON.stringify(time.value);
  useEffect(() => {
    if (!open) return;
    let live = true;
    loadCaptureBible(
      call,
      settings.numbers.timelineEnd,
      JSON.parse(timeKey) as StoryTimeValue,
    ).then(
      (b) => {
        if (live) setPreviewBible(b);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, version, timeKey, settings.numbers.timelineEnd]);

  const reset = useCallback(() => {
    setPhase('edit');
    setRouted(null);
    setRuns([]);
    setRunError(null);
    setFiled([]);
    setSaved(null);
    setMessage(null);
    setKeyOpen(false);
    setEditMarks({});
    setAskAck(false);
    setNotFiled(0);
    setLeft(0);
    fetched.current = new Set();
    handled.current = new Set();
    settled.current = false;
  }, []);

  /** KB-7: write the open question; null (with the reason shown) when it could not be saved. */
  const writeQuestion = useCallback(
    async (body: string): Promise<{ id: string; title: string } | null> => {
      try {
        const data = captureQuestionData(body, time.words);
        const { entry } = await call('entry.create', { collection: 'openQuestions', data });
        undo.record(createCommand('openQuestions', entry._id, entryTitle(entry)));
        return { id: entry._id, title: entryTitle(entry) };
      } catch (e) {
        setText((t) => t || body);
        setMessage(`The text was not saved: ${plainError(e)} It is still in the box.`);
        return null;
      }
    },
    [time.words, undo],
  );

  /** KB-7: keep the text as an open question; the text stays in the box until this succeeds. */
  const saveAsQuestion = useCallback(
    async (body: string) => {
      setBusy(true);
      const q = await writeQuestion(body);
      if (q) {
        setSaved(q);
        setText('');
        setPhase('saved');
      } else setPhase('edit');
      setBusy(false);
    },
    [writeQuestion],
  );

  /** KB-7 inside a routed capture: save the sentences that need Claude, and stay. */
  const keepAsQuestion = async (body: string) => {
    setBusy(true);
    const q = await writeQuestion(body);
    setBusy(false);
    return q;
  };

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
    // A capture with a fact the box files keeps its handed-back facts as cards instead.
    if (routed.sentTo.some((s) => s === null)) return;
    if (!runs.every(dropped)) return;
    const failed = runs.find((r) => r.live?.status === 'failed');
    const stopped = runs.every((r) => r.live?.status === 'stopped');
    if (!failed && !stopped) return;
    settled.current = true;
    // The outcome is a write (KB-7) or the text put back; neither belongs in the render pass.
    queueMicrotask(() => {
      // A56 (FN-6): a sentence from the tray that came to nothing goes back to the tray.
      releaseHandOver();
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
  }, [routed, runs, sending, saveAsQuestion, releaseHandOver]);

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
    pending.current.add(requestId);
    setSending((n) => n + 1);
    try {
      const res = await call('claude.capture', {
        runId: requestId,
        text: r.text,
        storyTime: r.storyTime,
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
      pending.current.delete(requestId);
      setSending((n) => n - 1);
    }
  };

  /**
   * Enter (CR-6). When every fact files here (Route A), Enter is File it: the
   * drafts the box showed while typing are written at once (A57). Otherwise
   * the facts that need Claude are sent, and the box shows them with the rest
   * for one File it. Alt+Enter (`all`) sends every fact on Route C (CR-5).
   * `one` sends a single fact from the typing view (its Send to Claude, or Ask
   * Claude instead with `force`). `from` is a sentence handed over by the tray
   * (FN-6), sent in its own year with its chips. True when a run to Claude
   * started.
   */
  const send = async (
    all = false,
    from?: CaptureSendRequest,
    one?: { fact: number; force?: 'full' },
  ): Promise<boolean> => {
    if (sendingNow.current) return false;
    sendingNow.current = true;
    try {
      return await sendNow(all, from, one);
    } finally {
      sendingNow.current = false;
    }
  };

  const sendNow = async (
    all: boolean,
    from: CaptureSendRequest | undefined,
    one: { fact: number; force?: 'full' } | undefined,
  ): Promise<boolean> => {
    const body = from ? from.text.trim() : text.trim();
    if (!body || phase !== 'edit' || busy || ro.off) return false;
    const storyTime: StoryTimeValue = from ? { year: from.year } : time.value;
    const firstChoices: FactChoice[] = from?.hint ? [{ hint: from.hint, typed: {} }] : [];
    setMessage(null);
    setRunError(null);
    setBusy(true);
    let bible: CaptureBible;
    try {
      bible = await loadCaptureBible(call, settings.numbers.timelineEnd, time.value);
    } catch (e) {
      setBusy(false);
      setMessage(`The bible could not be read to place the text: ${plainError(e)}`);
      return false;
    }
    // The chips and ticks set while typing go with their sentences (A57).
    const typed = from ? null : routeTyped(body, bible, storyTime.year, editMarks);
    const facts = typed ? typed.facts : routeWith(body, bible, storyTime.year, firstChoices);
    if (facts.length > CAPTURE_MAX_FACTS) {
      setBusy(false);
      setMessage(CAPTURE_TOO_MANY_FACTS);
      return false;
    }
    if (!facts.length || (one && !facts[one.fact])) {
      setBusy(false);
      return false;
    }
    const fresh = await call('claude.status', {}).catch(() => status);
    if (fresh) setStatus(fresh);
    setBusy(false);
    const keySet = !!fresh?.key.set;
    // A57: a Claude button pressed with no key opens the key field instead.
    if ((all || one) && !keySet) {
      setKeyOpen(true);
      return false;
    }
    const choices = typed ? typed.choices : facts.map((_, i) => firstChoices[i] ?? NO_CHOICE);
    const ticks = typed ? typed.ticks : facts.map(() => true);
    const toClaude = one
      ? new Set([one.fact])
      : new Set(facts.filter((f) => all || f.route !== 'local').map((f) => f.index));
    // A57: every fact files here, so Enter is File it for the drafts shown while typing.
    if (!toClaude.size && !from) {
      const waits = facts.some((f, i) => openAsks(f, choices[i] ?? NO_CHOICE).length);
      const ready = facts.some((f, i) => ticks[i] && !openAsks(f, choices[i] ?? NO_CHOICE).length);
      if (waits || !ready) {
        // The needed chips show under the field; nothing is filed.
        setQuietText(body);
        return false;
      }
      const r: Routed = {
        text: body,
        bible,
        storyYear: storyTime.year,
        storyTime,
        facts,
        choices,
        ticks,
        sentTo: facts.map(() => null),
        asked: facts.map(() => false),
      };
      fetched.current = new Set();
      handled.current = new Set();
      settled.current = false;
      setRuns([]);
      setRouted(r);
      setSaved(null);
      setText('');
      setPhase('routed');
      await fileWith(r, []);
      return false;
    }
    // KB-7: with no key nothing can be sent, so a capture that needs Claude is kept as an open question.
    if (toClaude.size === facts.length && !keySet) {
      await saveAsQuestion(body);
      return false;
    }
    if (toClaude.size && keySet && !fresh?.acknowledgedAt) return false;
    // No key and a mixed capture: the box files its own facts and keeps the rest as the question.
    let asked: { id: string; title: string } | null = null;
    if (toClaude.size && !keySet) {
      asked = await keepAsQuestion(
        facts
          .filter((f) => toClaude.has(f.index))
          .map((f) => f.text)
          .join(' '),
      );
      if (!asked) return false;
    }
    const r: Routed = {
      text: body,
      bible,
      storyYear: storyTime.year,
      storyTime,
      facts,
      choices,
      ticks,
      sentTo: facts.map(() => null),
      asked: facts.map((f) => asked !== null && toClaude.has(f.index)),
    };
    fetched.current = new Set();
    handled.current = new Set();
    settled.current = false;
    setRuns([]);
    setRouted(r);
    setSaved(asked);
    if (!from) setText('');
    setPhase('routed');
    if (!toClaude.size || !keySet) return false;
    const ok = await startRuns(r, toClaude, all ? 'full' : one?.force);
    // The run never started (the bible could not save it, for example): keep it as a question.
    if (!ok && toClaude.size === facts.length) {
      settled.current = true;
      await saveAsQuestion(body);
    }
    if (ok && from?.onUnfiled) handOver.current = from.onUnfiled;
    return ok;
  };

  // A56 (FN-6): the tray hands a sentence over; the box opens on it and sends it.
  const sendRef = useRef(send);
  const stateRef = useRef({ phase, busy });
  useEffect(() => {
    sendRef.current = send;
    stateRef.current = { phase, busy };
  });
  useEffect(() => {
    sendHandler = async (r) => {
      if (stateRef.current.phase !== 'edit' || stateRef.current.busy) {
        setBoxOpen(true);
        return 'busy';
      }
      setBoxOpen(true);
      return (await sendRef.current(r.all ?? false, r)) ? 'sent' : 'not sent';
    };
    return () => {
      sendHandler = null;
    };
  }, []);

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
        standOf(cur, runs, j) === 'sent' || cur.asked[j] ? (cur.facts[j] ?? f) : f,
      );
      return { ...cur, choices, facts };
    });
  };

  const sendFact = async (i: number, force?: 'full') => {
    if (!routed || busy) return;
    const fresh = await call('claude.status', {}).catch(() => status);
    if (fresh) setStatus(fresh);
    if (!fresh?.key.set) return;
    // AI-6: confirm what Claude sends first; the box shows the confirmation.
    if (!fresh.acknowledgedAt) {
      setAskAck(true);
      return;
    }
    setMessage(null);
    await startRuns(routed, new Set([i]), force);
  };

  const stop = async () => {
    // A request still being answered is stopped by its ID too; main stops what it starts.
    const ids = new Set([
      ...pending.current,
      ...runs.filter((r) => !r.finished).map((r) => r.requestId),
    ]);
    for (const runId of ids) await call('claude.stop', { runId });
  };

  /** Route A facts waiting for a chip; File it waits for them (CR-6). */
  const waiting = routed
    ? routed.facts.filter(
        (f) =>
          standOf(routed, runs, f.index) === 'local' &&
          openAsks(f, routed.choices[f.index] ?? NO_CHOICE).length,
      )
    : [];
  /** The text of facts the box still holds unfiled, to put back in the box. */
  const textOf = (fs: readonly CaptureFact[]) => fs.map((f) => f.text).join(' ');

  /**
   * File it for a routed capture and its runs: the ticked drafts, then the
   * proposals, as one undo step (CR-9). Enter calls it straight after routing
   * when every fact files here (A57).
   */
  const fileWith = async (r: Routed, rs: readonly RunState[]) => {
    const stand = (i: number) => standOf(r, rs, i);
    const localFacts = r.facts.filter((f) => stand(f.index) === 'local');
    if (localFacts.some((f) => openAsks(f, r.choices[f.index] ?? NO_CHOICE).length)) return;
    /** Facts that need Claude and were not sent (or were handed back); File it leaves them. */
    const unsentFacts = r.facts.filter((f) => stand(f.index) === 'unsent');
    const allCards = rs.flatMap(orderedCards);
    const ticked = localFacts.filter((f) => r.ticks[f.index]);
    const draftFacts: number[] = [];
    const drafts = ticked.flatMap((f) => {
      const ds = draftsWith(f, r.choices[f.index] ?? NO_CHOICE);
      for (const _ of ds) draftFacts.push(f.index);
      return ds;
    });
    const tickedCards = allCards.filter((c) => c.ticked).map((c) => toProposal(c.view));
    const untickedCards = allCards.filter((c) => !c.ticked).map((c) => toProposal(c.view));
    if (!drafts.length && !allCards.length) return;
    setBusy(true);
    setMessage(null);
    try {
      await undo.flush();
      // CR-9: the box's own drafts, then the proposals, as one undo step.
      const local = drafts.length ? await fileLocalDrafts(call, drafts) : NO_FILING;
      const approved = allCards.length
        ? await fileCapture(call, tickedCards, untickedCards)
        : NO_FILING;
      const merged = mergeFilings(local, approved);
      if (merged.command) undo.record(merged.command);
      // A draft that could not be written keeps its sentence: it goes back in the box with the unsent facts.
      const failedFacts = new Set(
        local.failed.map((f) => draftFacts[Number(f.id.replace('draft ', ''))] ?? -1),
      );
      const back = r.facts.filter(
        (f) => failedFacts.has(f.index) || unsentFacts.some((u) => u.index === f.index),
      );
      if (back.length) setText((t) => [t.trim(), textOf(back)].filter(Boolean).join(' '));
      setLeft(back.length);
      setFiled(merged.filed);
      setNotFiled(approved.failed.length);
      setPhase('filed');
      // A56 (FN-6): filed, the tray's sentence stays gone; nothing filed, it goes back.
      if (merged.filed.length) handOver.current = null;
      else releaseHandOver();
      const notes: string[] = [];
      if (local.failed.length) {
        notes.push(
          `${failedFacts.size === 1 ? 'One sentence was' : `${failedFacts.size} sentences were`} not filed: ${local.failed[0]?.message ?? ''} The text is back in the box.`,
        );
      }
      if (approved.failed.length) {
        notes.push(
          `${approved.failed.length === 1 ? 'One proposal was' : `${approved.failed.length} proposals were`} not filed and still wait in the review queue: ${approved.failed[0]?.message ?? ''}`,
        );
      }
      if (notes.length) setMessage(notes.join(' '));
    } catch (e) {
      setMessage(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const file = async () => {
    if (!routed || phase !== 'routed' || running || busy || ro.off || waiting.length) return;
    await fileWith(routed, runs);
  };

  /**
   * Escape, Close and Decline. Proposals not filed stay pending in the review
   * queue (they already are). Facts the box still holds unfiled go back into
   * the text field, so closing never loses a sentence; nothing is written.
   */
  const close = () => {
    setBoxOpen(false);
    // A56 (FN-6): closed before the tray's sentence was filed: the tray offers it again.
    if (phase !== 'filed') releaseHandOver();
    if (phase === 'routed' && !running && routed) {
      const back = routed.facts.filter((f) => {
        const st = standOf(routed, runs, f.index);
        return st === 'local' || st === 'unsent';
      });
      if (back.length) setText((t) => t || textOf(back));
      reset();
    } else if (phase === 'filed' || phase === 'saved') reset();
  };

  /** Hide the box and keep the routed capture as it is (Decline in the routed view). */
  const hide = () => setBoxOpen(false);

  /**
   * Review later: the proposals wait in the review queue, and the facts the
   * box still holds (its own, and those Claude did not take) are kept as the
   * KB-7 open question (CR-6).
   */
  const later = async () => {
    // A57: Review later while typing keeps the text as it stands.
    if (!routed) return text.trim() ? saveAsQuestion(text.trim()) : close();
    const kept = routed.facts.filter((f) => {
      const st = standOf(routed, runs, f.index);
      return st === 'local' || st === 'unsent';
    });
    // Review later keeps the tray's sentence (its proposals wait in the review queue).
    handOver.current = null;
    if (!kept.length) return close();
    const body = kept.length === routed.facts.length ? routed.text : textOf(kept);
    settled.current = true;
    await saveAsQuestion(body);
  };

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const keyMissing = status !== null && !status.key.set;
  const unsentCount = routed
    ? routed.facts.filter((f) => standOf(routed, runs, f.index) === 'unsent').length
    : 0;
  // AI-6 in the routed view: only when a card needs Claude, or the writer asked for it.
  const showAck = needsAck && (askAck || unsentCount > 0);

  // A57: the facts of the text as typed, placed on a pause, with the writer's chips and ticks.
  const preview = useMemo(() => {
    const body = quietText.trim();
    if (phase !== 'edit' || !body || !previewBible) return NO_PREVIEW;
    const p = routeTyped(body, previewBible, time.value.year, editMarks);
    return p.facts.length > CAPTURE_MAX_FACTS ? NO_PREVIEW : p;
  }, [phase, quietText, previewBible, time.value.year, editMarks]);
  /** A chip or tick changed while typing: kept by the sentence's text, so editing elsewhere keeps it. */
  const markEdit = (i: number, change: (m: EditMark) => EditMark) => {
    const key = preview.facts[i]?.text;
    if (key === undefined) return;
    setEditMarks((cur) => ({ ...cur, [key]: change(cur[key] ?? {}) }));
  };
  const chooseEdit = (
    i: number,
    patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> },
  ) =>
    markEdit(i, (m) => {
      const c = m.choice ?? NO_CHOICE;
      return {
        ...m,
        choice: { hint: { ...c.hint, ...patch.hint }, typed: { ...c.typed, ...patch.typed } },
      };
    });

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
          keyMissing={keyMissing}
          keyOpen={keyOpen}
          onAddKey={() => setKeyOpen(true)}
          onKeyClosed={() => setKeyOpen(false)}
          onKeySaved={(s) => {
            setStatus(s);
            setKeyOpen(false);
          }}
          preview={{
            ...preview,
            bible: previewBible,
            current: quietText.trim() === text.trim(),
          }}
          onChooseEdit={chooseEdit}
          onTickEdit={(i, t) => markEdit(i, (m) => ({ ...m, ticked: t }))}
          onSendOne={(i, force) => void send(false, undefined, { fact: i, force })}
          waiting={waiting.length}
          showAck={showAck}
          left={left}
          onHide={hide}
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
            // After File it the box holds the sentences that were not filed; keep them.
            if (phase !== 'filed') setText('');
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
  /** No Anthropic key is set: the Claude buttons become Add a Claude key (A57). */
  keyMissing: boolean;
  /** The key field shows in place. */
  keyOpen: boolean;
  onAddKey(): void;
  onKeyClosed(): void;
  onKeySaved(status: ClaudeStatusWire): void;
  /** A57: the facts of the text as typed, before Enter. `current` is false while the typing has not paused. */
  preview: {
    facts: CaptureFact[];
    choices: FactChoice[];
    ticks: boolean[];
    bible: CaptureBible | null;
    current: boolean;
  };
  onChooseEdit(
    fact: number,
    patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> },
  ): void;
  onTickEdit(fact: number, ticked: boolean): void;
  onSendOne(fact: number, force?: 'full'): void;
  /** Route A facts waiting for a chip. */
  waiting: number;
  /** AI-6 in the routed view: a card needs Claude and the writer has not confirmed. */
  showAck: boolean;
  /** Sentences the last File it put back in the box. */
  left: number;
  onHide(): void;
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
  const ids = { title: useId(), time: useId() };
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
        box?.querySelector<HTMLElement>('[data-focus-first]:not(:disabled)') ??
        box?.querySelector<HTMLElement>(
          '[data-testid="capture-fact-tick"]:not(:disabled), [data-testid="capture-tick"], [data-testid="capture-file"]:not(:disabled), [data-testid="capture-later"]',
        )
      )?.focus();
    }
    // Focus moves when the phase settles, not on every chip change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPhase, phase === 'running']);

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const inBox = phase === 'routed' || phase === 'running';
  const cards = runs.flatMap(orderedCards);
  const localFacts = routed
    ? routed.facts.filter((f) => standOf(routed, runs, f.index) === 'local')
    : [];
  const localTicked = routed
    ? localFacts.filter(
        (f) => routed.ticks[f.index] && !openAsks(f, routed.choices[f.index] ?? NO_CHOICE).length,
      ).length
    : 0;
  const unsent = routed
    ? routed.facts.filter((f) => standOf(routed, runs, f.index) === 'unsent').length
    : 0;
  // CR-9: facts that need Claude and were not sent count too, so the button says what stays behind.
  const total = localFacts.length + cards.length + unsent;
  const ticked = localTicked + cards.filter((c) => c.ticked).length;
  // A57: the button says how many it files; "of" counts what stays behind.
  const fileLabel = ticked === total ? `File ${ticked}` : `File ${ticked} of ${total}`;
  const onlyClaude = routed !== null && localFacts.length === 0 && unsent === 0;
  const { keyMissing, preview } = props;
  const previewIndex = preview.bible?.index ?? null;

  // A57: what Enter does with the text as typed, said by the button it presses.
  const askOf = (f: CaptureFact) => openAsks(f, preview.choices[f.index] ?? NO_CHOICE);
  const pLocal = preview.facts.filter((f) => f.route === 'local');
  const pClaude = preview.facts.length - pLocal.length;
  const pReady = pLocal.filter((f) => (preview.ticks[f.index] ?? true) && !askOf(f).length).length;
  const pWaits = pLocal.some((f) => askOf(f).length > 0);
  const enterLabel = !preview.facts.length
    ? 'File'
    : pClaude === 0
      ? `File ${pReady}`
      : keyMissing
        ? `Save ${pClaude} as a question`
        : `Send ${pClaude} to Claude`;
  const enterOff =
    props.busy ||
    props.readOnly.off ||
    !props.text.trim() ||
    (preview.current && preview.facts.length > 0 && pClaude === 0 && (pWaits || pReady === 0));
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
          } else if (
            e.key === 'Enter' &&
            (e.metaKey || e.ctrlKey) &&
            phase === 'edit' &&
            !e.defaultPrevented
          ) {
            // Cmd+Enter from a chip or a button while typing: the same as Enter in the field.
            e.preventDefault();
            props.onSend(false);
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
        {props.showAck && inBox && (
          // Decline here hides the box and keeps the routed capture for later.
          <Disclosure onConfirm={() => void props.onAcknowledge()} onDecline={props.onHide} />
        )}

        {props.keyOpen && (
          <ClaudeKeyField onSaved={props.onKeySaved} onCancel={props.onKeyClosed} />
        )}

        {phase === 'edit' && (
          <div className="capture-edit">
            <RichText
              handle={area}
              mode="inline"
              size="quick"
              className="capture-input"
              labelledBy={ids.title}
              value={props.text}
              onChange={props.setText}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return false;
                // Alt+Enter: Ask Claude instead (CR-5), or the key field when there is no key.
                if (e.altKey && !e.metaKey && !e.ctrlKey) {
                  if (keyMissing) props.onAddKey();
                  else props.onSend(true);
                } else props.onSend(false);
                return true;
              }}
              testId="capture-input"
            />
            {preview.facts.length > 0 && previewIndex && (
              <ol className="capture-facts" aria-label="Where it goes" data-testid="capture-facts">
                {preview.facts.map((f, i) => (
                  <li key={i}>
                    <FactCard
                      fact={f}
                      choice={preview.choices[i] ?? NO_CHOICE}
                      stand={f.route === 'local' ? 'local' : 'unsent'}
                      ticked={preview.ticks[i] ?? true}
                      first={false}
                      lists={props.lists}
                      index={previewIndex}
                      busy={props.busy}
                      claudeOff={props.readOnly.off}
                      keyMissing={keyMissing}
                      onAddKey={props.onAddKey}
                      onTick={(t) => props.onTickEdit(i, t)}
                      onChoose={(patch) => props.onChooseEdit(i, patch)}
                      onAskClaude={() => props.onSendOne(i, 'full')}
                      onSend={() => props.onSendOne(i)}
                    />
                  </li>
                ))}
              </ol>
            )}
            {props.readOnly.off && props.readOnly.tip.title && (
              <p className="capture-note">{props.readOnly.tip.title}</p>
            )}
            <div className="row capture-actions">
              <button
                type="button"
                className="btn primary"
                disabled={enterOff}
                onClick={() => props.onSend(false)}
                data-testid="capture-file"
              >
                {enterLabel} <kbd>Enter</kbd>
              </button>
              {keyMissing ? (
                <button
                  type="button"
                  className="btn"
                  disabled={props.readOnly.off}
                  onClick={props.onAddKey}
                  data-testid="capture-add-key"
                >
                  Add a Claude key
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={props.busy || props.readOnly.off || !props.text.trim()}
                  onClick={() => props.onSend(true)}
                  data-testid="capture-send-all"
                >
                  Ask Claude instead <kbd>Alt Enter</kbd>
                </button>
              )}
              {preview.facts.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={props.busy || props.readOnly.off}
                  onClick={props.onLater}
                  data-testid="capture-later"
                >
                  Review later
                </button>
              )}
            </div>
          </div>
        )}

        {phase !== 'edit' && routed && (
          <blockquote className="capture-sent" data-testid="capture-sent">
            {routed.text}
          </blockquote>
        )}

        {inBox && props.saved && (
          <p className="capture-note" data-testid="capture-asked">
            The sentences that need Claude were saved as an open question:{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const q = props.saved;
                props.onClose();
                if (q) claudeNav.openEntry('openQuestions', q.id);
              }}
            >
              {props.saved.title}
            </button>
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
                    stand={standOf(routed, runs, i)}
                    sentRoute={sentRun?.route}
                    ticked={routed.ticks[i] ?? true}
                    first={i === 0}
                    lists={props.lists}
                    index={routed.bible.index}
                    busy={props.busy || phase === 'running'}
                    claudeOff={props.readOnly.off}
                    keyMissing={keyMissing}
                    onAddKey={props.onAddKey}
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

        {phase === 'routed' &&
          onlyClaude &&
          runs.length > 0 &&
          cards.length === 0 &&
          !anyUnread && (
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
                disabled={
                  props.busy ||
                  props.readOnly.off ||
                  props.waiting > 0 ||
                  (ticked === 0 && cards.length === 0)
                }
                {...props.readOnly.tip}
                onClick={props.onFile}
                data-testid="capture-file"
              >
                {ticked === 0 && cards.length ? 'Reject all' : fileLabel} <kbd>Cmd Enter</kbd>
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
          </div>
        )}

        {phase === 'filed' && (
          <div className="stack tight" data-testid="capture-filed" role="status">
            <h3 tabIndex={-1} data-focus-first>
              Filed
            </h3>
            {props.left > 0 && (
              <p data-testid="capture-left">
                {props.left === 1
                  ? 'One sentence was not filed and is back in the box.'
                  : `${props.left} sentences were not filed and are back in the box.`}
              </p>
            )}
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
