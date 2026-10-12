import { useState } from 'react';
import type { ReactNode } from 'react';
import { call } from '../../api';
import { Disclosure, newRunId, useRunStream, watchRun } from '../claude';

/**
 * A brief or a chapter summary written by Claude (AI-1, AI-6): the first use
 * in a bible shows what is sent to Anthropic before anything is, the run ID
 * is chosen here so the page follows the stream from the first event, and a
 * Stop button ends the run (what streamed is kept in the saved run, and the
 * app falls back to the structured brief or a hand-written summary).
 */
export function useClaudeRun(what: string): {
  /** Start `go`, with a run ID when Claude is available, after the disclosure if it is due. */
  begin(available: boolean, go: (runId: string | undefined) => Promise<void>): void;
  disclosure: ReactNode;
  progress: ReactNode;
  running: boolean;
} {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const live = useRunStream(runId);

  const begin = (available: boolean, go: (runId: string | undefined) => Promise<void>) => {
    if (!available) {
      void go(undefined);
      return;
    }
    const launch = () => {
      const id = newRunId();
      watchRun(id);
      setRunId(id);
      void go(id).finally(() => setRunId(null));
    };
    // Asked fresh, so a view that starts a run as it opens still sees the disclosure state.
    call('claude.status', {}).then(
      (status) => (status.acknowledgedAt ? launch() : setPending(() => launch)),
      () => launch(),
    );
  };

  const disclosure = pending ? (
    <Disclosure
      onConfirm={() =>
        void call('claude.acknowledge', {}).then(() => {
          const go = pending;
          setPending(null);
          go();
        })
      }
      onDecline={() => setPending(null)}
    />
  ) : null;

  const progress = runId ? (
    <span className="row tight" role="status" data-testid="claude-progress">
      <span aria-live="polite">
        Claude is writing {what} ({live?.text.length ?? 0} characters so far).
      </span>
      <button
        type="button"
        className="btn small"
        onClick={() => void call('claude.stop', { runId })}
        data-testid="claude-run-stop"
      >
        Stop
      </button>
    </span>
  ) : null;

  return { begin, disclosure, progress, running: runId !== null };
}
