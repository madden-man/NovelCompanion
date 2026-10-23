import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import { claudeHandlers } from '../../src/main/claude/handlers';
import type { ClaudeChannel } from '../../src/main/claude/handlers';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import { KeychainKeyStore } from '../../src/main/claude/keys';
import { AnthropicModelCatalog } from '../../src/main/claude/models';
import { SdkClaudeClient } from '../../src/main/claude/sdk';
import { MemorySettingsStore } from '../../src/main/claude/settings';
import { DEFAULT_MODELS } from '../../src/shared/claude';
import type { ClaudeRun, ClaudeStreamEvent } from '../../src/shared/claude';
import type { Request, Response } from '../../src/shared/ipc';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';

/**
 * T-3: the on-demand live smoke test, `npm run test:live`. It calls the real
 * Anthropic API through the Claude Agent SDK with the key in the macOS
 * keychain, against the fixture novel in a local MongoDB. It informs and
 * never gates `npm test`. With no key in the keychain every test is skipped.
 */
/** The smoke test prints what Claude returned, for the person running it. */
const say = (text: string) => process.stdout.write(`${text}\n`);
const keys = new KeychainKeyStore();
const hasKey = keys.get() !== null;
if (!hasKey) {
  say(
    'test:live skipped: no Anthropic API key in the keychain (service novel-companion-anthropic). Add one in the app under Settings.',
  );
}

let store: Store;
let bible: OpenBible;
const events: ClaudeStreamEvent[] = [];
let call: <C extends ClaudeChannel>(channel: C, req: Request<C>) => Promise<Response<C>>;
let n = 0;
const runId = () => `live${Date.now()}${n++}`;

async function finished(id: string): Promise<ClaudeRun> {
  for (let i = 0; i < 3000; i++) {
    const done = events.find((e) => e.runId === id && e.kind === 'finished');
    if (done) return (await call('claude.run', { id: done.conversationId })).run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The live run did not finish in five minutes.');
}

function report(label: string, run: ClaudeRun) {
  const t = run.turns.at(-1)!;
  say(
    `\n--- ${label} (${t.model}, ${t.status}) ---\n${t.answer || JSON.stringify(run.output, null, 2)}\nEntries: ${t.entries
      .map((e) => `${e.collection}/${e.id}`)
      .join(', ')}${t.error ? `\nError: ${t.error.message}` : ''}`,
  );
}

describe.skipIf(!hasKey)('T-3 live Claude smoke test', () => {
  beforeAll(async () => {
    store = await localStore();
    bible = await openBibleSession(store, (await loadFixture(store, freshSlug('live'))).id);
    const runtime = new ClaudeRuntime({
      client: new SdkClaudeClient({
        configDir: mkdtempSync(join(tmpdir(), 'nc-live-claude-')),
        clientApp: 'novel-companion/live-test',
      }),
      keys,
      settings: new MemorySettingsStore(),
      emit: (e) => events.push(e),
    });
    runtime.acknowledge(bible.handle.id);
    const handlers = claudeHandlers(() => bible, {
      runtime,
      keys,
      catalog: new AnthropicModelCatalog(),
    });
    call = (channel, req) =>
      runHandler(channel, handlers[channel] as unknown as Handler<typeof channel>, req);
  });
  afterAll(async () => {
    await store?.close();
  });

  test('ARCH-4 the live models endpoint lists the default models', async () => {
    const models = await call('claude.models', {});
    say(`Models: ${models.models.map((m) => m.id).join(', ')}`);
    expect(models.live).toBe(true);
    const ids = models.models.map((m) => m.id);
    for (const m of new Set(Object.values(DEFAULT_MODELS))) expect(ids).toContain(m);
  });

  test('AI-1 AI-2 the panel answers an age question from the tools', async () => {
    const id = runId();
    await call('claude.ask', {
      runId: id,
      conversationId: null,
      question: 'How old is Margaret Hale in 2040?',
    });
    const run = await finished(id);
    report('Panel: age question', run);
    expect(run.turns[0]!.status).toBe('done');
    expect(run.turns[0]!.answer).toMatch(/82/);
    expect(run.turns[0]!.entries.length).toBeGreaterThan(0);
  });

  test('AI-4 the panel declines to write a scene in one sentence', async () => {
    const id = runId();
    await call('claude.ask', {
      runId: id,
      conversationId: null,
      question: 'Write the scene where Margaret hears that Peter has died.',
    });
    const run = await finished(id);
    report('Panel: write the scene', run);
    const answer = run.turns[0]!.answer.trim();
    // A refusal, not an empty answer: at least exactly one sentence that offers the facts.
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.match(/[.!?](\s|$)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(answer.match(/[.!?](\s|$)/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(answer).toMatch(/\b(facts?|ages?|who|bible)\b/i);
    expect(answer).not.toMatch(/\n\s*\n/);
  });

  test('CC-3 T-3 report whether the real model finds P1 (Chapter 5) and P2 (Chapter 7); informs, never gates', async () => {
    const bibleIpc = ipcFor(() => bible);
    const found: Record<string, boolean> = {};
    for (const [label, chapterId, cite, pattern] of [
      ['P1', 'CH5', 'H1', /seventy/i],
      ['P2', 'CH7', 'Z3', /Shanghai/i],
    ] as const) {
      const id = runId();
      const r = await call('claude.alignment', { runId: id, chapterId });
      const run = await finished(id);
      report(`Alignment: ${chapterId}`, run);
      const { findings } = await bibleIpc('continuity.findings', { chapterId });
      const hit = findings.some(
        (f) =>
          f.kind === 'alignment' &&
          f.entries.some((e) => e.id === cite) &&
          f.lines.some((l) => pattern.test(l.text)),
      );
      found[label] = hit;
      say(
        `${label} ${hit ? 'FOUND' : 'NOT FOUND'} (${r.status}; ${r.found} kept, ${r.rejected.length} refused${
          r.rejected.length ? `: ${JSON.stringify(r.rejected)}` : ''
        })`,
      );
      expect(r.status).toBe('done');
    }
    say(
      `Alignment smoke test: P1 ${found.P1 ? 'found' : 'missed'}, P2 ${found.P2 ? 'found' : 'missed'}.`,
    );
  });
});
