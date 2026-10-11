/**
 * The seam between sessions (M7) and the Claude runtime (M6).
 *
 * M7 never talks to Claude itself. It asks for two small services:
 * - `BriefSynthesizer` writes a brief from a selection's material only (SB-4,
 *   DB-2): the three lead sections first, every line citing manifest IDs.
 * - `ChapterSummarizer` drafts a chapter summary for approval (MS-2).
 *
 * INTEGRATION POINT FOR M6: implement both over `src/main/claude/` and call
 * `registerSessionClaude({ briefs, summaries })` once at startup (after the
 * runtime is ready), and `registerSessionClaude({ briefs: null, summaries: null })`
 * if the key is removed. Until then both are null, and the app shows the
 * structured brief with no synthesis (SB-7) and asks for the summary by hand.
 * The model for briefs is resolved by `modelFor('briefs')`; M6 owns that
 * setting and its default `claude-opus-5-5` (DB-4). Every system prompt M6
 * uses for these must carry the AI-4 prose prohibition.
 */
import type { BriefMaterial } from '../../shared/domain/brief/render';
import type { Selection } from '../../shared/domain/brief/selection';

/** DB-4: the settings key for the brief model, and its default. M6 owns the setting. */
export const BRIEF_MODEL_SETTING = 'briefs';
export const DEFAULT_BRIEF_MODEL = 'claude-opus-5-5';
/** The settings key for chapter summaries (DB-4). */
export const SUMMARY_MODEL_SETTING = 'summaries';

export interface BriefSynthesisRequest {
  model: string;
  /** The deterministic selection (SB-2, SB-3). Claude is given nothing else. */
  selection: Selection;
  /** The selection's contents, one record per selected entry (SB-4). */
  material: BriefMaterial[];
  /** The structured brief (SB-7), as a shape to follow. */
  structured: string;
  /** Streamed text, for the output pane. */
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface BriefSynthesisResult {
  /**
   * Markdown. Must open with the three DB-2 sections (characters and ages,
   * world events ongoing, cultural expectations) and cite every line as
   * `[[ID]]`. Code checks the citations against the manifest afterwards.
   */
  content: string;
  model: string;
}

export interface BriefSynthesizer {
  synthesize(req: BriefSynthesisRequest): Promise<BriefSynthesisResult>;
}

export interface ChapterSummaryRequest {
  model: string;
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
  briefs: BriefSynthesizer | null;
  summaries: ChapterSummarizer | null;
  /** The configured model for a feature (DB-4). */
  modelFor?: (feature: string) => string | null;
}

let registered: SessionClaude = { briefs: null, summaries: null };

/** M6 calls this when the Claude runtime is ready (or gone). */
export function registerSessionClaude(claude: SessionClaude): void {
  registered = claude;
}

export function sessionClaude(): SessionClaude {
  return registered;
}

export function briefModel(claude: SessionClaude): string {
  return claude.modelFor?.(BRIEF_MODEL_SETTING) ?? DEFAULT_BRIEF_MODEL;
}

/**
 * A recorded-response stand-in for tests (T-3). The brief is built from the
 * material it is given, so every citation is in the manifest unless
 * `foreignCitation` asks for one that is not, to exercise SB-4.
 */
export function fakeSessionClaude(
  opts: { foreignCitation?: string; uncitedLine?: string; summary?: string; fail?: string } = {},
): SessionClaude {
  return {
    briefs: {
      async synthesize(req) {
        if (opts.fail) throw new Error(opts.fail);
        const by = (groups: string[]) => req.material.filter((m) => groups.includes(m.group));
        const cite = (m: BriefMaterial) => [m.id, ...m.refs].map((id) => `[[${id}]]`).join(' ');
        const lines = (ms: BriefMaterial[]) =>
          ms.length
            ? ms.map((m) => `- ${m.title}: ${m.note}. ${cite(m)}`)
            : ['- Nothing selected.'];
        const out = [
          `# Brief: ${req.selection.label}`,
          '',
          '## 1. Characters and their ages',
          ...lines(by(['characters'])),
          '',
          '## 2. World events ongoing',
          ...lines(by(['era', 'eventsWindow', 'eventsFormative', 'eventsPlaces'])),
          '',
          '## 3. Cultural expectations',
          ...lines(by(['culture'])),
          '',
          '## 4. Who knows what',
          ...lines(by(['knowledge', 'povUnknown'])),
          '',
          '## 5. Loose threads',
          ...lines(by(['beats', 'previousChapters'])),
        ];
        if (opts.uncitedLine) out.push(`- ${opts.uncitedLine}`);
        if (opts.foreignCitation)
          out.push(`- A line with a stray source. [[${opts.foreignCitation}]]`);
        const content = out.join('\n') + '\n';
        req.onText?.(content);
        return { content, model: req.model };
      },
    },
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
    modelFor: (feature) =>
      feature === BRIEF_MODEL_SETTING ? DEFAULT_BRIEF_MODEL : 'claude-sonnet-5-5',
  };
}
