import { useId, useState } from 'react';
import { FEATURE_INFO } from '../../../shared/claude';
import type { ClaudeRun, ClaudeStatusWire } from '../../../shared/claude';
import { call, plainError } from '../api';
import {
  ClaudeErrorNote,
  Disclosure,
  EntriesRead,
  ProposalsNote,
  newRunId,
  useClaudeStatus,
  useRunStream,
  watchRun,
} from './claude';

/**
 * IM-5: optionally, Claude reads the Word document picked in Import and
 * proposes structured entries. They go to the review queue (AI-3); nothing
 * is saved until each one is approved there.
 */
export function ImportProposals(props: { fileId: string; fileName: string }) {
  const [status, setStatus] = useClaudeStatus();
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ClaudeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const headingId = useId();

  const live = useRunStream(runId, (done) => {
    if (done.conversationId) {
      void call('claude.run', { id: done.conversationId }).then((r) => setRun(r.run));
    }
    setRunId(null);
  });

  const start = async () => {
    setError(null);
    setRun(null);
    const id = newRunId();
    watchRun(id);
    setRunId(id);
    try {
      await call('claude.importProposals', { runId: id, fileId: props.fileId });
    } catch (e) {
      setRunId(null);
      setError(plainError(e));
    }
  };

  const turn = run?.turns[0];
  const output = run?.output as { summary?: string } | null | undefined;
  return (
    <div className="panel stack tight" aria-labelledby={headingId} data-testid="import-claude">
      <h3 id={headingId}>Ask Claude to propose entries</h3>
      <p>
        Optional. Claude reads {props.fileName} and suggests characters, dates, relationships, and
        events it states. Each suggestion goes to the review queue, where you see the exact change
        and approve, edit, or reject it.
      </p>
      {asking && (
        <Disclosure
          onConfirm={() =>
            void call('claude.acknowledge', {}).then((s: ClaudeStatusWire) => {
              setStatus(s);
              setAsking(false);
              void start();
            })
          }
          onDecline={() => setAsking(false)}
        />
      )}
      <div className="row tight">
        <button
          type="button"
          className="btn"
          disabled={runId !== null || asking}
          onClick={() => {
            // AI-6: the first use in this bible says what is sent before anything is.
            if (status && !status.acknowledgedAt) setAsking(true);
            else void start();
          }}
          data-testid="import-claude-start"
        >
          Propose entries with Claude
        </button>
        {runId && (
          <button
            type="button"
            className="btn"
            onClick={() => void call('claude.stop', { runId })}
            data-testid="import-claude-stop"
          >
            Stop
          </button>
        )}
        <span className="example-note">Model: {status?.models.importProposals ?? ''}</span>
      </div>
      {runId && (
        <p aria-live="polite" aria-busy="true">
          Claude is reading the document ({live?.text.length ?? 0} characters so far).
        </p>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {turn && (
        <div className="stack tight" data-testid="import-claude-result" data-status={turn.status}>
          {turn.status === 'done' && output?.summary && <p>{output.summary}</p>}
          {turn.status === 'stopped' && (
            <p className="example-note">Stopped. Nothing was queued.</p>
          )}
          {turn.error && <ClaudeErrorNote error={turn.error} />}
          <ProposalsNote ids={turn.proposalIds} rejected={turn.rejected} />
          {turn.status === 'done' &&
            turn.proposalIds.length === 0 &&
            turn.rejected.length === 0 && <p>Claude found nothing to propose.</p>}
          <EntriesRead
            entries={turn.entries}
            label={`Entries given to Claude for matching (${FEATURE_INFO.importProposals.label})`}
          />
        </div>
      )}
    </div>
  );
}
