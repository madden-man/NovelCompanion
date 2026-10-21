import { parseWords, wordUrl } from '../../shared/domain/words';
import type { WordKind, WordResult } from '../../shared/domain/words';

/**
 * WT-1: one lookup on Datamuse from the main process. Every failure becomes a
 * plain sentence with what to do next (NF-3); no status code, driver message,
 * or stack reaches the renderer.
 */

export const DATAMUSE_UNREACHABLE =
  'The app could not reach Datamuse. Check your internet connection and try again.';
export const DATAMUSE_SLOW = 'Datamuse took too long to answer. Try again in a moment.';
export const DATAMUSE_BUSY =
  'Datamuse is limiting requests right now. Wait a minute and try again.';
export const DATAMUSE_DOWN = 'Datamuse is having trouble right now. Try again in a few minutes.';
export const DATAMUSE_REFUSED =
  'Datamuse could not use that request. Change the word and try again.';
export const DATAMUSE_UNREADABLE =
  'The app could not read what Datamuse sent back. Try again in a moment.';

/** How long a lookup waits before it gives up. */
export const DATAMUSE_TIMEOUT_MS = 8000;

export interface WordsRequest {
  kind: WordKind;
  word: string;
}

export interface WordsResponse {
  kind: WordKind;
  word: string;
  results: WordResult[];
}

const isTimeout = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

function statusText(status: number): string {
  if (status === 429) return DATAMUSE_BUSY;
  if (status >= 500) return DATAMUSE_DOWN;
  return DATAMUSE_REFUSED;
}

export async function lookupWords(
  req: WordsRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DATAMUSE_TIMEOUT_MS,
): Promise<WordsResponse> {
  const word = req.word.trim();
  const url = wordUrl(req.kind, word);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(isTimeout(e) ? DATAMUSE_SLOW : DATAMUSE_UNREACHABLE, { cause: e });
  }
  if (!res.ok) throw new Error(statusText(res.status));
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(DATAMUSE_UNREADABLE, { cause: e });
  }
  if (!Array.isArray(body)) throw new Error(DATAMUSE_UNREADABLE);
  return { kind: req.kind, word, results: parseWords(body) };
}
