import { monotonicFactory } from 'ulid';
import { ClaudeFeature } from '../../shared/claude';
import type { ClaudeRun } from '../../shared/claude';
import type { OpenBible } from '../db/session';
import type { SessionClaude } from '../session/claude';
import { briefs, briefsInput, renderBrief } from './features/briefs';
import type { BriefsInput, BriefsOutput } from './features/briefs';
import { summaries } from './features/summaries';
import type { SummariesOutput } from './features/summaries';
import type { KeyStore } from './keys';
import type { ClaudeRuntime, RunStart } from './runtime';

/**
 * M7's Claude seam (`src/main/session/claude.ts`) over M6's runtime. Briefs
 * and summaries run as ordinary feature runs: they stream to the renderer
 * under the run ID it chose, stop with `claude.stop`, and are saved in
 * `conversations` with the feature that produced them (AI-1). Both are
 * available only while a key is stored; without one the session handlers
 * fall back to the structured brief (SB-7) and a hand-written summary.
 */

const newId = monotonicFactory();

/** A run that did not finish, said in a few words for M7's fallback note. */
class RunEnded extends Error {}

function outcome(run: ClaudeRun, runId: string) {
  const turn = run.turns.find((t) => t.id === runId) ?? run.turns[0];
  if (!turn || turn.status === 'stopped') throw new RunEnded('you stopped it');
  if (turn.status !== 'done') {
    const why = (turn.error?.message ?? 'it failed').replace(/\s*Your question is kept\.$/, '');
    throw new RunEnded(why.replace(/\.$/, ''));
  }
  return { turn, output: run.output };
}

/** Run a feature and wait until it is saved; `signal` stops it like the Stop button. */
async function runToEnd(
  start: () => Promise<RunStart>,
  runtime: ClaudeRuntime,
  runId: string,
  signal?: AbortSignal,
): Promise<ClaudeRun> {
  const started = await start();
  const onAbort = () => runtime.stop(runId);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await started.done;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function runtimeSessionClaude(
  runtime: ClaudeRuntime,
  current: () => OpenBible | null,
  keys: KeyStore,
): SessionClaude {
  const session = () => {
    const s = current();
    if (!s) throw new Error('Open a bible first.');
    return s;
  };
  const briefWriter: NonNullable<SessionClaude['briefs']> = {
    async synthesize(req) {
      const runId = req.runId ?? newId();
      const input: BriefsInput = briefsInput(req.selection, req.material);
      const run = await runToEnd(
        () => runtime.runFeature(session(), briefs, input, runId),
        runtime,
        runId,
        req.signal,
      );
      const { turn, output } = outcome(run, runId);
      const content = renderBrief(output as BriefsOutput, input, req.selection);
      req.onText?.(content);
      return { content, model: turn.model };
    },
  };
  const summaryWriter: NonNullable<SessionClaude['summaries']> = {
    async summarize(req) {
      const runId = req.runId ?? newId();
      const run = await runToEnd(
        () => runtime.runFeature(session(), summaries, { chapterId: req.chapterId }, runId),
        runtime,
        runId,
        req.signal,
      );
      const { turn, output } = outcome(run, runId);
      return { summary: (output as SummariesOutput).summary.trim(), model: turn.model };
    },
  };
  return {
    // Claude is available while a key is stored (ARCH-4); otherwise SB-7.
    get briefs() {
      return keys.get() ? briefWriter : null;
    },
    get summaries() {
      return keys.get() ? summaryWriter : null;
    },
    modelFor: (feature) => {
      const f = ClaudeFeature.safeParse(feature);
      return f.success ? runtime.modelFor(f.data) : null;
    },
  };
}
