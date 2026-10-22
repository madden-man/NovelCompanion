import { useWriteGuard } from '../connection';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { CLAUDE_FEATURES, FEATURE_INFO, needsSettings } from '../../../shared/claude';
import type {
  ClaudeRun,
  ClaudeRunSummary,
  ClaudeStatusWire,
  ClaudeTurn,
  EntryRefWire,
  RunError,
  RunStatus,
} from '../../../shared/claude';
import { collectionInfo, isEntryCollection } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { formatTime } from './format';
import { RichText } from './richText/RichText';
import type { RichTextHandle } from './richText/RichText';
import { Editable, useEditableSave, valueCommand } from './editable';
import { ConfirmLine } from './housekeeping';
import './claude.css';

/**
 * Claude in the workspace (AI-1, AI-2, AI-6, AI-7): the question panel, the
 * first-use disclosure, the streaming state of a run, and failures that say
 * what to do next. The panel opens from every screen through the status bar
 * button or Cmd+J.
 */

/**
 * Navigation the Claude views ask for (settings, the review queue, an entry)
 * and the panel's open state. Both are small module stores, so the frame
 * needs one hook and no wrapper around every screen.
 */
type NavRequest =
  { to: 'settings' } | { to: 'review' } | { to: 'entry'; collection: EntryCollection; id: string };

const navListeners = new Set<(r: NavRequest) => void>();
let panelOpen = false;
const panelListeners = new Set<() => void>();

function setPanelOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const l of panelListeners) l();
}

function navigate(r: NavRequest): void {
  if (r.to !== 'entry') setPanelOpen(false);
  for (const l of navListeners) l(r);
}

export const claudeNav = {
  openPanel: () => setPanelOpen(true),
  closePanel: () => setPanelOpen(false),
  togglePanel: () => setPanelOpen(!panelOpen),
  openSettings: () => navigate({ to: 'settings' }),
  openReview: () => navigate({ to: 'review' }),
  openEntry: (collection: EntryCollection, id: string) => navigate({ to: 'entry', collection, id }),
};

/** The frame answers navigation requests from the Claude views. */
export function useClaudeNavigation(handlers: {
  settings(): void;
  review(): void;
  entry(collection: EntryCollection, id: string): void;
}): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const listener = (r: NavRequest) => {
      if (r.to === 'entry') ref.current.entry(r.collection, r.id);
      else ref.current[r.to]();
    };
    navListeners.add(listener);
    return () => {
      navListeners.delete(listener);
    };
  }, []);
}

function usePanelOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      panelListeners.add(l);
      return () => {
        panelListeners.delete(l);
      };
    },
    () => panelOpen,
  );
}

/** The key, disclosure, and model settings, reloaded when asked. */
export function useClaudeStatus(): [ClaudeStatusWire | null, (s: ClaudeStatusWire) => void] {
  const [status, setStatus] = useState<ClaudeStatusWire | null>(null);
  useEffect(() => {
    let live = true;
    void call('claude.status', {}).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return [status, setStatus];
}

/** A run ID chosen here, so the page listens before the run starts and misses no event. */
export function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export interface LiveRun {
  runId: string;
  conversationId: string | null;
  text: string;
  entries: EntryRefWire[];
  proposalIds: string[];
  status: RunStatus;
  error: RunError | null;
}

/**
 * Every stream event since the page loaded, by run ID. One listener for the
 * whole page, so no event is missed between starting a run and a view
 * subscribing to it.
 */
const runs = new Map<string, LiveRun>();
const runListeners = new Set<() => void>();
let streaming = false;

function listenToStreams(): void {
  if (streaming) return;
  streaming = true;
  window.api.on('claude.stream', (e) => {
    const prior: LiveRun = runs.get(e.runId) ?? {
      runId: e.runId,
      conversationId: e.conversationId,
      text: '',
      entries: [],
      proposalIds: [],
      status: 'running',
      error: null,
    };
    const next: LiveRun = { ...prior, conversationId: e.conversationId };
    if (e.kind === 'text') next.text = prior.text + e.text;
    else if (e.kind === 'read') next.entries = [...prior.entries, ...e.entries];
    else if (e.kind === 'proposal') next.proposalIds = [...prior.proposalIds, e.proposalId];
    else {
      next.status = e.status;
      next.error = e.error;
    }
    runs.set(e.runId, next);
    for (const l of runListeners) l();
  });
}

/** Call before starting a run so its first event is caught. */
export function watchRun(runId: string): void {
  listenToStreams();
  runs.delete(runId);
}

/** Follow one streaming run by its ID (AI-1); `onFinished` runs once when it ends. */
export function useRunStream(
  runId: string | null,
  onFinished?: (run: LiveRun) => void,
): LiveRun | null {
  listenToStreams();
  const live = useSyncExternalStore(
    (l) => {
      runListeners.add(l);
      return () => {
        runListeners.delete(l);
      };
    },
    () => (runId ? (runs.get(runId) ?? null) : null),
  );
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (live && live.status !== 'running' && reported.current !== live.runId) {
      reported.current = live.runId;
      finished.current?.(live);
    }
  }, [live]);
  return live;
}

/** AI-7, NF-3: what went wrong and what to do; a key problem links to settings. */
/** ARCH-4: the way from a key problem to the place that fixes it. */
export function OpenSettingsButton() {
  return (
    <button
      type="button"
      className="btn small"
      onClick={claudeNav.openSettings}
      data-testid="open-claude-settings"
    >
      Open settings
    </button>
  );
}

export function ClaudeErrorNote({ error }: { error: RunError }) {
  return (
    <div className="callout crit stack tight" role="alert" data-testid="claude-error">
      <span>{error.message}</span>
      {needsSettings(error.kind) && (
        <div>
          <OpenSettingsButton />
        </div>
      )}
    </div>
  );
}

/** AI-6: stated plainly before the first run, and kept in settings afterwards. */
export function Disclosure(props: {
  onConfirm?: () => void;
  onDecline?: () => void;
  confirmedAt?: string | null;
}) {
  const headingId = useId();
  return (
    <div
      className="panel stack tight"
      role="group"
      aria-labelledby={headingId}
      data-testid="claude-disclosure"
    >
      <h3 id={headingId}>What Claude sends to Anthropic</h3>
      <p>
        When you use a Claude feature, the app sends the content listed below to Anthropic, the
        company that runs Claude, over the internet. Nothing is sent until you start a Claude
        feature. Your bible itself is stored in the MongoDB deployment you set up for this app, and
        the app sends it to Google only when you start an export to Google Drive.
      </p>
      <ul>
        {CLAUDE_FEATURES.map((f) => (
          <li key={f}>
            <strong>{FEATURE_INFO[f].label}</strong>: {FEATURE_INFO[f].sends}.
          </li>
        ))}
      </ul>
      {props.onConfirm ? (
        <div className="row">
          <button
            type="button"
            className="btn primary"
            onClick={props.onConfirm}
            data-testid="claude-acknowledge"
          >
            Continue
          </button>
          {props.onDecline && (
            <button type="button" className="btn" onClick={props.onDecline}>
              Not now
            </button>
          )}
        </div>
      ) : (
        props.confirmedAt && (
          <p className="example-note">You confirmed this on {formatTime(props.confirmedAt)}.</p>
        )
      )}
    </div>
  );
}

/** AI-2: the entries Claude read for an answer, each one click from its page. */
export function EntriesRead(props: { entries: EntryRefWire[]; label: string }) {
  if (props.entries.length === 0) return null;
  return (
    <div className="stack tight" data-testid="claude-entries">
      <span className="eyebrow">{props.label}</span>
      <ul className="chips" aria-label={props.label}>
        {props.entries.map((e) => (
          <li key={`${e.collection}:${e.id}`}>
            <button
              type="button"
              className="chip"
              onClick={() =>
                isEntryCollection(e.collection) && claudeNav.openEntry(e.collection, e.id)
              }
            >
              {e.title}
              <span className="sr-only">
                {' '}
                (
                {isEntryCollection(e.collection)
                  ? collectionInfo[e.collection].singular
                  : e.collection}
                )
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProposalsNote({
  ids,
  rejected,
}: {
  ids: string[];
  rejected?: ClaudeTurn['rejected'];
}) {
  if (ids.length === 0 && !rejected?.length) return null;
  return (
    <div className="stack tight" data-testid="claude-proposals">
      {ids.length > 0 && (
        <p>
          {ids.length === 1 ? '1 proposal is' : `${ids.length} proposals are`} waiting in the review
          queue. Nothing changes until you approve.{' '}
          <button type="button" className="btn small" onClick={claudeNav.openReview}>
            Open the review queue
          </button>
        </p>
      )}
      {rejected && rejected.length > 0 && (
        <>
          <p className="callout warn">
            {rejected.length === 1 ? '1 suggestion was' : `${rejected.length} suggestions were`} not
            queued because they did not fit the bible:
          </p>
          <ul data-testid="claude-rejected">
            {rejected.map((r, i) => (
              <li key={i}>
                <strong>{r.summary}</strong>: {r.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The button at the right of the status bar, on every screen. */
export function AskClaudeButton() {
  const open = usePanelOpen();
  return (
    <button
      type="button"
      className="btn small status-end"
      aria-expanded={open}
      aria-controls="claude-panel"
      onClick={claudeNav.togglePanel}
      data-testid="ask-claude"
    >
      Ask Claude <kbd>Cmd J</kbd>
    </button>
  );
}

/** The panel when open; Cmd+J opens and closes it from every screen (NF-2). */
export function ClaudePanelGate() {
  const open = usePanelOpen();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        claudeNav.togglePanel();
      }
      // Escape closes the panel when focus is in it or nowhere in particular (a disabled
      // button that had focus leaves it on the page body), never from another dialog.
      if (e.key === 'Escape' && panelOpen && !e.defaultPrevented) {
        const at = document.activeElement;
        const inPanel = at?.closest('#claude-panel');
        if (inPanel || !at || at === document.body) {
          e.preventDefault();
          claudeNav.closePanel();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setPanelOpen(false);
    };
  }, []);
  return open ? <ClaudePanel /> : null;
}

let keptDraft = '';
let keptConversation: string | null = null;

/** IP-16: who hears that a conversation was renamed (by the field, or by undo and redo). */
const conversationListeners = new Set<() => void>();
async function renameConversation(id: string, title: string): Promise<void> {
  await call('claude.conversation.rename', { id, title });
  for (const l of conversationListeners) l();
}

/** AI-1: questions about the bible and the manuscript, streamed, stoppable, and saved. */
function ClaudePanel() {
  const nav = claudeNav;
  const [status, setStatus] = useClaudeStatus();
  const [history, setHistory] = useState<ClaudeRunSummary[]>([]);
  const [conversation, setConversationState] = useState<ClaudeRun | null>(null);
  const setConversation = (run: ClaudeRun | null) => {
    keptConversation = run?._id ?? null;
    setConversationState(run);
  };
  // AI-7: the typed question outlives the panel, so closing it (or opening settings) keeps it.
  const [draft, setDraftState] = useState(keptDraft);
  const setDraft = (next: string | ((d: string) => string)) =>
    setDraftState((d) => (keptDraft = typeof next === 'function' ? next(d) : next));
  const [runId, setRunId] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<RichTextHandle>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const ids = { title: useId(), input: useId(), history: useId() };

  const loadHistory = useCallback(() => {
    call('claude.runs', { feature: 'panel' }).then(
      (r) => setHistory(r.runs),
      (e: unknown) => setError(plainError(e)),
    );
  }, []);

  /**
   * Show a saved conversation. A turn still streaming in main (the panel was
   * closed mid-answer, or another conversation is picked) is followed again,
   * so its text keeps arriving and Stop works.
   */
  const adopt = useCallback(({ run, active }: Response<'claude.run'>, attach: boolean) => {
    keptConversation = run._id;
    setConversationState(run);
    const running = active[0];
    if (attach && running) {
      setRunId(running);
      setAsked(run.turns.find((t) => t.id === running)?.question ?? '');
    }
    return run;
  }, []);

  const loadConversation = useCallback(
    async (id: string, attach = false) => adopt(await call('claude.run', { id }), attach),
    [adopt],
  );

  useEffect(() => {
    // A rename (or its undo) shows in the picker and the title field at once.
    const reload = () => {
      loadHistory();
      if (keptConversation) void loadConversation(keptConversation);
    };
    conversationListeners.add(reload);
    return () => {
      conversationListeners.delete(reload);
    };
  }, [loadHistory, loadConversation]);

  useEffect(() => {
    loadHistory();
    // Reopening the panel shows the conversation it was showing, and follows a running answer.
    if (keptConversation) {
      call('claude.run', { id: keptConversation }).then(
        (r) => adopt(r, true),
        () => {
          keptConversation = null;
        },
      );
    }
    inputRef.current?.focus();
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, [loadHistory, adopt]);

  const live = useRunStream(runId, (finished) => {
    const settle = () => {
      setRunId(null);
      setAsked(null);
      loadHistory();
    };
    const question = asked ?? '';
    if (finished.status === 'failed') {
      // AI-7: a failed question goes back in the box, so nothing typed is lost.
      setDraft((d) => d || question);
      // A run that could not be saved has no saved error to show, so say it here.
      if (finished.error?.kind === 'saveFailed') setError(finished.error.message);
    }
    if (!finished.conversationId) return settle();
    loadConversation(finished.conversationId).then(
      () => settle(),
      (e: unknown) => {
        settle();
        setError(plainError(e));
      },
    );
  });

  const ro = useWriteGuard();
  const ask = async () => {
    const question = draft.trim();
    if (!question || runId || !status?.acknowledgedAt || ro.off) return;
    setError(null);
    const id = newRunId();
    watchRun(id);
    setRunId(id);
    setAsked(question);
    setDraft('');
    try {
      const started = await call('claude.ask', {
        runId: id,
        conversationId: conversation?._id ?? null,
        question,
      });
      // Remember the conversation now, so closing the panel mid-answer and reopening it follows the run.
      keptConversation = started.conversationId;
    } catch (e) {
      setRunId(null);
      setAsked(null);
      setDraft(question);
      setError(plainError(e));
    }
  };

  const stop = async () => {
    if (runId) await call('claude.stop', { runId });
  };

  const acknowledge = async () => {
    setStatus(await call('claude.acknowledge', {}));
    inputRef.current?.focus();
  };

  // The running turn shows from the stream below, not from its saved copy.
  const turns = (conversation?.turns ?? []).filter((t) => t.id !== runId);
  const running = runId !== null;

  return (
    <aside
      id="claude-panel"
      className="claude-panel"
      aria-labelledby={ids.title}
      data-testid="claude-panel"
    >
      <header className="drawer-head">
        <div>
          <span className="eyebrow">Question panel</span>
          <h2 id={ids.title}>Ask Claude</h2>
        </div>
        <div className="row tight">
          <button
            type="button"
            className="btn small"
            disabled={running}
            onClick={() => {
              setConversation(null);
              setError(null);
              inputRef.current?.focus();
            }}
          >
            New conversation
          </button>
          <button type="button" className="btn small" onClick={nav.closePanel}>
            Close
          </button>
        </div>
      </header>
      <p className="example-note">
        Claude reads the bible to answer and can suggest changes for the review queue. It never
        writes prose for the novel.
      </p>
      {history.length > 0 && (
        <div className="field">
          <label htmlFor={ids.history}>Saved conversations</label>
          <select
            id={ids.history}
            value={conversation?._id ?? ''}
            disabled={running}
            onChange={(e) => {
              if (e.target.value) void loadConversation(e.target.value, true);
              else setConversation(null);
            }}
            data-testid="claude-history"
          >
            <option value="">New conversation</option>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title} ({formatTime(h.modifiedAt)})
              </option>
            ))}
          </select>
        </div>
      )}
      {conversation && (
        <ConversationTools
          key={conversation._id}
          run={conversation}
          running={running}
          onCleared={async () => {
            await loadConversation(conversation._id);
            loadHistory();
          }}
          onDeleted={() => {
            setConversation(null);
            loadHistory();
            inputRef.current?.focus();
          }}
        />
      )}
      {status && !status.acknowledgedAt && (
        <Disclosure onConfirm={() => void acknowledge()} onDecline={nav.closePanel} />
      )}
      <ol className="claude-thread" aria-label="Conversation" data-testid="claude-thread">
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} />
        ))}
        {running && (
          <li
            className="claude-turn"
            aria-busy="true"
            data-testid="claude-turn"
            data-status="running"
          >
            <p className="claude-question">{asked}</p>
            <div className="claude-answer" aria-live="polite" data-testid="claude-answer">
              {live?.text || 'Claude is reading the bible.'}
            </div>
            <EntriesRead entries={live?.entries ?? []} label="Entries read so far" />
          </li>
        )}
      </ol>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <form
        className="stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label id={ids.input}>Your question about the bible or the manuscript</label>
        <RichText
          handle={inputRef}
          mode="inline"
          size="notes"
          labelledBy={ids.input}
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              void ask();
              return true;
            }
            return false;
          }}
          testId="claude-input"
        />
        <div className="row tight">
          <button
            type="submit"
            className="btn primary"
            disabled={running || !draft.trim() || !status?.acknowledgedAt || ro.off}
            {...ro.tip}
            data-testid="claude-send"
          >
            Ask
          </button>
          {running && (
            <button
              type="button"
              className="btn"
              onClick={() => void stop()}
              data-testid="claude-stop"
            >
              Stop
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

/**
 * IP-16: the open conversation's title renames in place (one undo step);
 * Clear takes its messages out and Delete removes it, each after a one-line
 * confirmation and neither an undo step.
 */
function ConversationTools(props: {
  run: ClaudeRun;
  running: boolean;
  onCleared: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { run } = props;
  const ro = useWriteGuard();
  const [asking, setAsking] = useState<'clear' | 'delete' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A deleted conversation reads as no title, so an undo step over it is skipped
  // with a plain notice instead of throwing (a throw would stop every later undo).
  const read = useCallback(async () => {
    try {
      return (await call('claude.run', { id: run._id })).run.title;
    } catch {
      return '';
    }
  }, [run._id]);
  const write = useCallback((title: string) => renameConversation(run._id, title), [run._id]);
  const command = useCallback(
    (before: string, after: string) =>
      before.trim() === after.trim()
        ? null
        : valueCommand({
            label: `Renamed the conversation ${before}`,
            read,
            write,
            before,
            after,
            changed: 'the conversation was renamed or deleted since',
          }),
    [read, write],
  );
  const save = useEditableSave({ value: run.title, write, command });
  const off = ro.off || props.running;
  const why = props.running
    ? 'Claude is still answering in this conversation. Stop it first.'
    : ro.tip.title;
  return (
    <div className="stack tight claude-conversation" data-testid="claude-conversation">
      <div className="row tight claude-conversation-head">
        <Editable
          kind="text"
          label="Conversation title"
          showLabel
          allowEmpty={false}
          value={run.title}
          disabled={off}
          reason={why}
          testId="claude-title"
          onSave={save}
        />
        <span className="row tight">
          <button
            type="button"
            className="btn small"
            disabled={off || asking === 'clear'}
            title={why}
            aria-label={`Clear the messages of ${run.title}`}
            data-testid="claude-clear"
            onClick={() => {
              setNotice(null);
              setAsking('clear');
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn small danger"
            disabled={off || asking === 'delete'}
            title={why}
            aria-label={`Delete ${run.title}`}
            data-testid="claude-delete"
            onClick={() => {
              setNotice(null);
              setAsking('delete');
            }}
          >
            Delete
          </button>
        </span>
      </div>
      {asking === 'clear' && (
        <ConfirmLine
          action="Clear messages"
          keep="Keep them"
          testId="claude-clear-confirm"
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            await call('claude.conversation.clear', { id: run._id });
            setAsking(null);
            setNotice(`Cleared ${run.title}. This is not an undo step.`);
            await props.onCleared();
          }}
        >
          Take every message out of {run.title}? The title stays. This is not an undo step.
        </ConfirmLine>
      )}
      {asking === 'delete' && (
        <ConfirmLine
          action="Delete conversation"
          testId="claude-delete-confirm"
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            await call('claude.conversation.delete', { id: run._id });
            setAsking(null);
            props.onDeleted();
          }}
        >
          Delete {run.title} and its messages? This is not an undo step.
        </ConfirmLine>
      )}
      {notice && (
        <p className="example-note" role="status" data-testid="claude-conversation-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<RunStatus, string> = {
  running: 'Answering',
  done: '',
  stopped: 'Stopped before the end.',
  failed: '',
};

function TurnView({ turn }: { turn: ClaudeTurn }) {
  return (
    <li className="claude-turn" data-testid="claude-turn" data-status={turn.status}>
      <p className="claude-question">{turn.question}</p>
      {turn.answer && (
        <div className="claude-answer" data-testid="claude-answer">
          {turn.answer}
        </div>
      )}
      {STATUS_TEXT[turn.status] && <p className="example-note">{STATUS_TEXT[turn.status]}</p>}
      {turn.error && <ClaudeErrorNote error={turn.error} />}
      <EntriesRead entries={turn.entries} label="Entries read" />
      <ProposalsNote ids={turn.proposalIds} rejected={turn.rejected} />
    </li>
  );
}
