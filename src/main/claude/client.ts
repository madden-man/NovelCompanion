import type { z } from 'zod';
import { ERROR_MESSAGES } from '../../shared/claude';
import type { ClaudeErrorKind, ClaudeFeature } from '../../shared/claude';

/**
 * The seam between the app and Claude. `sdk.ts` implements it with the Claude
 * Agent SDK; `fake.ts` with recorded responses for the test suite (T-3). The
 * runtime (`runtime.ts`) is the only caller.
 */

/** What a tool hands back to Claude. */
export interface ToolOutput {
  text: string;
  isError?: boolean;
}

/**
 * An in-process tool (AI-2, AI-3). Tools are the app's own: read-only bible
 * queries and `propose_change`. Claude gets no built-in tool (no shell, no
 * files, no web).
 */
export interface ClaudeTool {
  name: string;
  description: string;
  /** zod raw shape of the input; the SDK validates against it before the handler runs. */
  shape: z.ZodRawShape;
  readOnly: boolean;
  handler(args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface ClaudeRequest {
  feature: ClaudeFeature;
  model: string;
  apiKey: string;
  /** Always built by `systemPrompt()`, so it holds the AI-4 prohibition. */
  system: string;
  prompt: string;
  tools: ClaudeTool[];
  /** JSON Schema for structured output (features); absent for the panel's plain answer. */
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
}

export type ClaudeEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; input: unknown }
  | { type: 'result'; text: string; structured: unknown };

export interface ClaudeClient {
  /**
   * Stream one run. Ends with exactly one `result` event, or throws a
   * `ClaudeFailure`. Aborting `signal` stops the run; the iterator then ends
   * without a result.
   */
  run(request: ClaudeRequest, signal: AbortSignal): AsyncIterable<ClaudeEvent>;
}

/** A failure with a kind the interface can explain (AI-7). */
export class ClaudeFailure extends Error {
  override name = 'ClaudeFailure';
  constructor(
    readonly kind: ClaudeErrorKind,
    message: string = ERROR_MESSAGES[kind],
  ) {
    super(message);
  }
}

/** Lists the models the key may use (ARCH-4: the settings list is live). */
export interface ModelCatalog {
  list(apiKey: string): Promise<{ id: string; displayName: string }[]>;
}

/**
 * Turn what the SDK or the API reported into a failure kind. Pure, so the
 * mapping is unit-tested without a network.
 */
export function classifyFailure(input: {
  assistantError?: string | null;
  apiStatus?: number | null;
  message?: string | null;
}): ClaudeErrorKind {
  switch (input.assistantError) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
    case 'account_on_hold':
      return 'badKey';
    case 'rate_limit':
      return 'rateLimit';
    case 'overloaded':
      return 'overloaded';
    case 'model_not_found':
      return 'modelUnavailable';
    default:
      break;
  }
  const status = input.apiStatus ?? null;
  if (status === 401 || status === 403) return 'badKey';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'modelUnavailable';
  if (status === 529 || status === 503) return 'overloaded';
  const m = input.message ?? '';
  if (/invalid x-api-key|invalid api key|authentication|401/i.test(m)) return 'badKey';
  if (/rate.?limit|429/i.test(m)) return 'rateLimit';
  if (/overloaded|529/i.test(m)) return 'overloaded';
  if (/model.{0,40}(not found|not available|does not exist)|not_found_error/i.test(m)) {
    return 'modelUnavailable';
  }
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket hang up|unable to connect/i.test(
      m,
    )
  ) {
    return 'network';
  }
  return 'other';
}
