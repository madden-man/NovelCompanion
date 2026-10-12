import { ERROR_MESSAGES, KNOWN_MODELS, claudeContract } from '../../shared/claude';
import type { ClaudeErrorKind } from '../../shared/claude';
import type { OpenBible } from '../db/session';
import type { Handler } from '../ipc/validate';
import { ClaudeFailure } from './client';
import type { ModelCatalog } from './client';
import { cleanKey } from './keys';
import type { KeyStore } from './keys';
import type { ClaudeRuntime } from './runtime';
import { RunStore, summarize } from './store';
import { FEATURES } from './features';
import { recordAlignment } from '../continuity';
import { textHash } from '../../shared/domain/continuity/lines';
import { localDateString } from '../../shared/domain/sessionLog';

export type ClaudeChannel = keyof typeof claudeContract;
export const CLAUDE_CHANNELS = Object.keys(claudeContract) as ClaudeChannel[];

/** Settings only: what to do when the list of models could not be read (not "ask again"). */
const LIST_MESSAGES: Partial<Record<ClaudeErrorKind, string>> = {
  badKey:
    'Anthropic rejected the stored API key, so the list of models could not be read. Replace the key below.',
  rateLimit:
    'Anthropic is limiting requests right now, so the list of models could not be read. Wait a minute, then open Settings again.',
  network:
    'The app could not reach Anthropic to read the list of models. Check your network connection, then open Settings again.',
};
const LIST_FALLBACK = 'The list of models could not be read. Open Settings again later.';
/** The list read from Anthropic is reused for this long before the endpoint is called again. */
const LIST_TTL_MS = 10 * 60_000;

export interface ClaudeDeps {
  runtime: ClaudeRuntime;
  keys: KeyStore;
  catalog: ModelCatalog;
}

/**
 * Handlers for the Claude channels, free of Electron so the integration
 * suite drives the same zod contract the renderer uses. Streaming goes out
 * through the runtime's `emit`.
 */
export function claudeHandlers(
  current: () => OpenBible | null,
  deps: ClaudeDeps,
): { [C in ClaudeChannel]: Handler<C> } {
  const { runtime, keys, catalog } = deps;
  let cached: { id: string; displayName: string }[] | null = null;
  let cachedFor: { key: string; at: number } | null = null;
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(ERROR_MESSAGES.noBible);
    return s;
  };
  const bibleId = () => current()?.handle.id ?? null;

  return {
    'claude.status': () => runtime.status(bibleId()),
    'claude.setKey': async ({ key }) => {
      const cleaned = cleanKey(key);
      if (!cleaned.ok)
        return { ok: false, message: cleaned.message, status: runtime.status(bibleId()) };
      try {
        cached = await catalog.list(cleaned.key);
        cachedFor = { key: cleaned.key, at: Date.now() };
        keys.set(cleaned.key);
        return {
          ok: true,
          message: 'Saved in the keychain. Anthropic accepted the key.',
          status: runtime.status(bibleId()),
        };
      } catch (e) {
        const kind = e instanceof ClaudeFailure ? e.kind : 'other';
        if (kind === 'badKey') {
          return {
            ok: false,
            message:
              'Anthropic rejected this key, so it was not saved. Check it in the Anthropic Console and paste it again.',
            status: runtime.status(bibleId()),
          };
        }
        // Offline or busy: keep the key; the first run will say if it is wrong.
        cached = null;
        cachedFor = null;
        keys.set(cleaned.key);
        return {
          ok: true,
          message:
            'Saved in the keychain. The app could not reach Anthropic to check it, so the first run will.',
          status: runtime.status(bibleId()),
        };
      }
    },
    'claude.clearKey': () => {
      keys.clear();
      cached = null;
      cachedFor = null;
      return runtime.status(bibleId());
    },
    'claude.models': async () => {
      const key = keys.get();
      if (!key) {
        return {
          models: KNOWN_MODELS.map((m) => ({ ...m })),
          live: false,
          message: 'Add an API key to see the models it can use.',
        };
      }
      if (cached && cachedFor && cachedFor.key === key && Date.now() - cachedFor.at < LIST_TTL_MS) {
        return { models: cached, live: true, message: null };
      }
      try {
        cached = await catalog.list(key);
        cachedFor = { key, at: Date.now() };
        return { models: cached, live: true, message: null };
      } catch (e) {
        const message = (e instanceof ClaudeFailure && LIST_MESSAGES[e.kind]) || LIST_FALLBACK;
        return {
          models: cached ?? KNOWN_MODELS.map((m) => ({ ...m })),
          live: false,
          message: cached ? `Showing the list read earlier. ${message}` : message,
        };
      }
    },
    'claude.setModel': ({ feature, model }) => runtime.setModel(feature, model, bibleId()),
    'claude.acknowledge': () => runtime.acknowledge(session().handle.id),
    'claude.ask': async (req) => {
      const start = await runtime.ask(session(), req);
      return { runId: start.runId, conversationId: start.conversationId };
    },
    'claude.stop': ({ runId }) => ({ stopped: runtime.stop(runId) }),
    'claude.runs': ({ feature }) => ({
      runs: new RunStore(session())
        .list(feature)
        .map((r) => summarize(r, (id) => runtime.isActive(id))),
    }),
    'claude.run': ({ id }) => {
      const run = new RunStore(session()).get(id);
      if (!run) throw new Error('That conversation is not saved.');
      return { run, active: run.turns.filter((t) => runtime.isActive(t.id)).map((t) => t.id) };
    },
    'claude.importProposals': async ({ runId, fileId }) => {
      const start = await runtime.runFeature(
        session(),
        FEATURES.importProposals,
        { fileId },
        runId,
      );
      return { runId: start.runId, conversationId: start.conversationId };
    },
    'claude.capture': async ({ runId, text, storyTime }) => {
      const start = await runtime.runFeature(
        session(),
        FEATURES.capture,
        { text, storyTime, capturedOn: localDateString(new Date()) },
        runId,
      );
      return { runId: start.runId, conversationId: start.conversationId };
    },
    'claude.alignment': async ({ runId, chapterId }) => {
      const s = session();
      const text = s.model.get('chapters', chapterId)?.manuscriptText;
      const start = await runtime.runFeature(
        s,
        FEATURES.alignment,
        { chapterId, textHash: textHash(typeof text === 'string' ? text : '') },
        runId,
      );
      const run = await start.done;
      const turn = run.turns.find((t) => t.id === runId) ?? run.turns[0];
      // CC-3: the checked findings are stored before the call returns.
      const recorded = await recordAlignment(s, chapterId, run, runId);
      return {
        runId: start.runId,
        conversationId: start.conversationId,
        status: turn?.status ?? 'failed',
        error: turn?.error ?? null,
        ...recorded,
      };
    },
  };
}
