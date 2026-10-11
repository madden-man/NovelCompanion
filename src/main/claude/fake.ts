import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ClaudeErrorKind, ClaudeFeature, KNOWN_MODELS } from '../../shared/claude';
import { ClaudeFailure } from './client';
import type { ClaudeClient, ClaudeEvent, ClaudeRequest, ModelCatalog, ToolOutput } from './client';

/**
 * Recorded responses for the test suite (T-3): no test calls the real API.
 * A recording is the sequence a real run produces: streamed text, tool calls
 * (which the fake really runs against the app's tools, so the tools are
 * tested), and a final result or a failure.
 */
const Step = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ tool: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    result: z.strictObject({ text: z.string().default(''), structured: z.unknown().optional() }),
  }),
  z.strictObject({ fail: ClaudeErrorKind }),
  /** Stream nothing more until the run is stopped (for testing Stop). */
  z.strictObject({ waitForAbort: z.literal(true) }),
]);

export const Recording = z.strictObject({
  name: z.string(),
  feature: ClaudeFeature,
  /** The recording answers a prompt that contains this text; absent matches any prompt. */
  match: z.string().optional(),
  steps: z.array(Step),
});
export type Recording = z.infer<typeof Recording>;

export const Recordings = z.array(Recording);

export function loadRecordings(path: string): Recording[] {
  return Recordings.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export class FakeClaudeClient implements ClaudeClient {
  /** Every request the app made, for assertions on prompts, models, and tools. */
  readonly requests: ClaudeRequest[] = [];
  /** What each tool returned to Claude, in order. */
  readonly toolResults: { name: string; output: ToolOutput }[] = [];

  constructor(
    private readonly recordings: Recording[],
    private readonly stepDelayMs = 0,
  ) {}

  private pick(req: ClaudeRequest): Recording {
    // The newest question is the end of the prompt, so the match found latest wins.
    let best: { r: Recording; at: number } | null = null;
    for (const r of this.recordings) {
      if (r.feature !== req.feature || r.match === undefined) continue;
      const at = req.prompt.lastIndexOf(r.match);
      if (at >= 0 && (!best || at > best.at)) best = { r, at };
    }
    const found =
      best?.r ?? this.recordings.find((r) => r.feature === req.feature && r.match === undefined);
    if (!found) {
      throw new ClaudeFailure('other', `No recorded response for this ${req.feature} request.`);
    }
    return found;
  }

  async *run(req: ClaudeRequest, signal: AbortSignal): AsyncIterable<ClaudeEvent> {
    this.requests.push(req);
    const recording = this.pick(req);
    for (const step of recording.steps) {
      if (signal.aborted) return;
      if (this.stepDelayMs) await sleep(this.stepDelayMs, signal);
      if (signal.aborted) return;
      if ('text' in step) {
        yield { type: 'text', text: step.text };
      } else if ('tool' in step) {
        const t = req.tools.find((x) => x.name === step.tool);
        if (!t)
          throw new ClaudeFailure(
            'other',
            `The recording calls a tool this run does not have: ${step.tool}.`,
          );
        // As the SDK does: the input must match the tool's schema before the handler runs.
        const args = z.object(t.shape).safeParse(step.input);
        if (!args.success) {
          throw new ClaudeFailure('other', `The recording gives ${step.tool} an input it refuses.`);
        }
        yield { type: 'toolCall', name: step.tool, input: step.input };
        this.toolResults.push({ name: step.tool, output: await t.handler(args.data) });
      } else if ('result' in step) {
        yield {
          type: 'result',
          text: step.result.text,
          structured: step.result.structured ?? null,
        };
        return;
      } else if ('fail' in step) {
        throw new ClaudeFailure(step.fail);
      } else {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Keys that start with this are refused by the fake catalog, to test a rejected key. */
export const FAKE_REJECTED_PREFIX = 'sk-ant-rejected';
/** Keys that start with this cannot be checked, as if offline. */
export const FAKE_OFFLINE_PREFIX = 'sk-ant-offline';

export class FakeModelCatalog implements ModelCatalog {
  async list(apiKey: string) {
    if (apiKey.startsWith(FAKE_REJECTED_PREFIX)) throw new ClaudeFailure('badKey');
    if (apiKey.startsWith(FAKE_OFFLINE_PREFIX)) throw new ClaudeFailure('network');
    return KNOWN_MODELS.map((m) => ({ ...m }));
  }
}
