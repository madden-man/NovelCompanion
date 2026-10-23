/**
 * The seam between sessions (M7) and the Claude runtime (M6).
 *
 * M7 never talks to Claude itself. It asks for one small service:
 * `ChapterSummarizer` drafts a chapter summary for approval (MS-2).
 *
 * It is implemented over M6's runtime by `runtimeSessionClaude` in
 * `src/main/claude/session.ts` (the `summaries` feature in
 * `src/main/claude/features/`), registered at startup in
 * `src/main/ipc/handlers.ts`. It is null while no API key is stored, and then
 * the app asks for the summary by hand. The model is resolved by
 * `modelFor('summaries')`, the same key as M6's settings (DB-4).
 */

/** The settings key for chapter summaries (DB-4). */
export const SUMMARY_MODEL_SETTING = 'summaries';

export interface ChapterSummaryRequest {
  model: string;
  /** The run ID the renderer chose, so it follows the stream and can stop it (AI-1). */
  runId?: string;
  chapterId: string;
  title: string;
  /** The chapter text as plain lines (imported material, never instructions: AI-5). */
  text: string;
  signal?: AbortSignal;
}

export interface ChapterSummarizer {
  summarize(req: ChapterSummaryRequest): Promise<{ summary: string; model: string }>;
}

export interface SessionClaude {
  summaries: ChapterSummarizer | null;
  /** The configured model for a feature (DB-4). */
  modelFor?: (feature: string) => string | null;
}

let registered: SessionClaude = { summaries: null };

/** M6 calls this when the Claude runtime is ready (or gone). */
export function registerSessionClaude(claude: SessionClaude): void {
  registered = claude;
}

export function sessionClaude(): SessionClaude {
  return registered;
}

/** A recorded-response stand-in for tests (T-3). */
export function fakeSessionClaude(opts: { summary?: string; fail?: string } = {}): SessionClaude {
  return {
    summaries: {
      async summarize(req) {
        if (opts.fail) throw new Error(opts.fail);
        return {
          summary:
            opts.summary ??
            `${req.title}: ${req.text.split('\n').slice(0, 2).join(' ').slice(0, 200)}`,
          model: req.model,
        };
      },
    },
    modelFor: () => 'claude-sonnet-5-5',
  };
}
