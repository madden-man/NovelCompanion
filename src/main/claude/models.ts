import { ClaudeFailure } from './client';
import type { ModelCatalog } from './client';

/** ARCH-5: the key goes to this host and no other, whatever ANTHROPIC_BASE_URL says. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * ARCH-4: the settings model lists come from the live models endpoint,
 * `GET /v1/models`, read through the official SDK with the stored key. The
 * same call checks a newly pasted key.
 */
export class AnthropicModelCatalog implements ModelCatalog {
  async list(apiKey: string): Promise<{ id: string; displayName: string }[]> {
    // Loaded on first use, so launch never waits for it (NF-1).
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey,
      baseURL: ANTHROPIC_API_URL,
      maxRetries: 0,
      timeout: 15_000,
    });
    try {
      const out: { id: string; displayName: string }[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        out.push({ id: m.id, displayName: m.display_name });
      }
      return out.filter((m) => m.id.startsWith('claude-'));
    } catch (e) {
      if (
        e instanceof Anthropic.AuthenticationError ||
        e instanceof Anthropic.PermissionDeniedError
      ) {
        throw new ClaudeFailure('badKey');
      }
      if (e instanceof Anthropic.RateLimitError) throw new ClaudeFailure('rateLimit');
      if (e instanceof Anthropic.APIConnectionError) throw new ClaudeFailure('network');
      throw new ClaudeFailure(
        'other',
        'The list of models could not be read. Open Settings again later.',
      );
    }
  }
}
