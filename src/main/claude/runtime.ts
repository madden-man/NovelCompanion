import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { ERROR_MESSAGES, FEATURE_INFO, maskKey } from '../../shared/claude';
import type {
  ClaudeFeature,
  ClaudeRun,
  ClaudeStatusWire,
  ClaudeStreamEvent,
  ClaudeTurn,
  EntryRefWire,
  RunError,
} from '../../shared/claude';
import type { OpenBible } from '../db/session';
import { ClaudeFailure } from './client';
import type { ClaudeClient, ClaudeRequest, ClaudeTool } from './client';
import type { KeyStore } from './keys';
import { systemPrompt } from './prompts';
import { queueDraft } from './proposals';
import type { ProposalDraft } from './proposals';
import { modelsWithDefaults } from './settings';
import type { SettingsStore } from './settings';
import { RunStore } from './store';
import { PANEL_INSTRUCTIONS, PANEL_MAX_TURNS, panelPrompt } from './features/panel';
import { bibleTools } from './tools';

/**
 * A feature that runs Claude once over a deterministic input (AI-1):
 * alignment checks (CC-3), chapter summaries (MS-2), and capture (KB-6). Each lives in `features/` and is started with
 * `ClaudeRuntime.runFeature`. See docs/ARCHITECTURE.md, "Claude runtime".
 */
export interface FeatureDefinition<I, O> {
  feature: Exclude<ClaudeFeature, 'panel'>;
  /** The default system prompt text; the writer may replace it (IP-15). The runtime adds the fixed footer, the AI-4 prohibition among it. */
  instructions: string;
  /** The deterministic input, validated before anything is sent. */
  input: z.ZodType<I>;
  /** The structured output Claude must return; validated with zod before anything is saved. */
  output: z.ZodType<O>;
  /** History title, for example "Summary of Chapter 4". */
  title(input: I, session: OpenBible): string;
  /** The prompt and the entries it contains. Must be deterministic: same input and data, same prompt. */
  build(input: I, session: OpenBible): { prompt: string; given: EntryRefWire[] };
  /** Proposals the output carries, checked and queued for review (AI-3). A problem is reported, never dropped. */
  proposals?(output: O, input: I, session: OpenBible): DraftOrProblem[];
  /** Tool round trips allowed; features get their material in the prompt, so the default is small. */
  maxTurns?: number;
  /** The tools the run may call; none unless given. Capture (KB-6) gets the AI-2 tools and propose_change. */
  tools?(input: I, session: OpenBible, sink: Sink): ClaudeTool[];
}

/** A proposal draft, or why one the output carries could not become a draft. */
export type DraftOrProblem = ProposalDraft | { summary: string; problem: string };

/**
 * The system prompt a feature runs with (AI-4: the only way to build one).
 * IP-15: `custom` is the writer's text for the feature from Settings, which
 * replaces the default instructions; the fixed footer follows either way.
 */
export const featureSystemPrompt = (
  def: { feature?: string; instructions: string },
  custom?: string | null,
): string =>
  systemPrompt(
    custom ?? def.instructions,
    def.feature === 'capture' || def.feature === 'captureFast',
  );

export const panelSystemPrompt = (custom?: string | null): string =>
  systemPrompt(custom ?? PANEL_INSTRUCTIONS, true);

/** Turn a zod schema into the JSON Schema the SDK's structured output takes. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'output' }) as Record<
    string,
    unknown
  >;
  return rest;
}

export interface RuntimeDeps {
  client: ClaudeClient;
  keys: KeyStore;
  settings: SettingsStore;
  emit(event: ClaudeStreamEvent): void;
  now?: () => Date;
}

/** What starting a run returns at once; `done` settles when the run is saved for the last time. */
export interface RunStart {
  runId: string;
  conversationId: string;
  done: Promise<ClaudeRun>;
}

export const RUN_ID = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'A run ID is 8 to 64 letters, digits, dashes, or underscores.');

interface Launch {
  session: OpenBible;
  /** A new run to create with this turn, or the saved conversation the turn joins. */
  run: ClaudeRun | { existing: string };
  turn: ClaudeTurn;
  feature: ClaudeFeature;
  system: string;
  prompt: string;
  tools: (sink: Sink) => ClaudeTool[];
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  /** Turn the final result into the saved answer and output; throws a ClaudeFailure if it cannot. */
  finish(
    result: { text: string; structured: unknown },
    sink: Sink,
  ): Promise<{ answer: string; output?: unknown }>;
}

/** Where tools report what Claude read and proposed during a turn. */
export interface Sink {
  read(entries: EntryRefWire[]): void;
  proposed(proposalId: string): void;
  rejected(summary: string, reason: string): void;
  label: string;
  now(): Date;
}

/**
 * The Claude runtime (ARCH-4, AI-1 to AI-7). Every Claude call in the app
 * goes through here: it reads the key and the model setting, checks the
 * disclosure was confirmed, saves the input before anything is sent, streams,
 * stops, validates, queues proposals, and saves the outcome. A failure never
 * writes to the bible and never loses the input.
 */
export class ClaudeRuntime {
  /** Runs streaming now, by run (turn) ID: how to stop each, its conversation, and when it ends. */
  private readonly active = new Map<
    string,
    { controller: AbortController; conversationId: string; done: Promise<unknown> }
  >();
  /**
   * AI-1: run IDs the writer stopped before the run reached this process (the
   * renderer flushes edits first, so Stop can arrive ahead of the start). A run
   * that starts under one of these ends at once.
   */
  private readonly earlyStops = new Set<string>();
  private readonly newId = monotonicFactory();
  private readonly now: () => Date;

  constructor(private readonly deps: RuntimeDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Key status (masked), the disclosure for this bible, and the models (ARCH-4, AI-6, DB-4). */
  status(bibleId: string | null): ClaudeStatusWire {
    const key = this.deps.keys.get();
    const s = this.deps.settings.read();
    return {
      key: { set: key !== null, masked: key ? maskKey(key) : null },
      acknowledgedAt: bibleId ? (s.acknowledged[bibleId] ?? null) : null,
      models: modelsWithDefaults(s),
    };
  }

  /** AI-6: the person has read what is sent to Anthropic, on the first use in this bible. */
  acknowledge(bibleId: string): ClaudeStatusWire {
    const s = this.deps.settings.read();
    if (!s.acknowledged[bibleId]) {
      this.deps.settings.write({
        ...s,
        acknowledged: { ...s.acknowledged, [bibleId]: this.now().toISOString() },
      });
    }
    return this.status(bibleId);
  }

  setModel(feature: ClaudeFeature, model: string, bibleId: string | null): ClaudeStatusWire {
    const s = this.deps.settings.read();
    this.deps.settings.write({ ...s, models: { ...s.models, [feature]: model } });
    return this.status(bibleId);
  }

  modelFor(feature: ClaudeFeature): string {
    return modelsWithDefaults(this.deps.settings.read())[feature];
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Stop a streaming run. What streamed so far is kept, marked stopped. */
  stop(runId: string): boolean {
    const a = this.active.get(runId);
    if (!a) {
      this.earlyStops.add(runId);
      // Remember only the latest few; an ID that never starts is not kept forever.
      const oldest = this.earlyStops.size > 100 ? this.earlyStops.values().next().value : undefined;
      if (oldest !== undefined) this.earlyStops.delete(oldest);
      return false;
    }
    a.controller.abort();
    return true;
  }

  /**
   * Stop every streaming run and wait until each is saved as stopped. Called
   * when the open bible changes and before the app closes the store.
   */
  async stopAll(): Promise<void> {
    const pending = [...this.active.values()];
    for (const a of pending) a.controller.abort();
    await Promise.allSettled(pending.map((a) => a.done));
  }

  /** Runs streaming now in one conversation. */
  activeIn(conversationId: string): string[] {
    return [...this.active.entries()]
      .filter(([, a]) => a.conversationId === conversationId)
      .map(([id]) => id);
  }

  // ---------- the question panel (AI-1, AI-2) ----------

  async ask(
    session: OpenBible,
    req: { runId: string; conversationId: string | null; question: string },
  ): Promise<RunStart> {
    const at = this.now().toISOString();
    const model = this.modelFor('panel');
    const turn = newTurn(req.runId, req.question, model, at);
    let run: ClaudeRun | { existing: string };
    let earlier: ClaudeTurn[] = [];
    if (req.conversationId) {
      const found = new RunStore(session).get(req.conversationId);
      if (!found || found.feature !== 'panel') throw new Error('That conversation is not saved.');
      earlier = found.turns.filter((t) => t.status === 'done');
      run = { existing: found._id };
    } else {
      run = {
        _id: this.newId(),
        feature: 'panel',
        title: titleOf(req.question),
        createdAt: at,
        modifiedAt: at,
        turns: [turn],
      };
    }
    return this.launch({
      session,
      run,
      turn,
      feature: 'panel',
      system: panelSystemPrompt(session.repo.claudeInstructions().panel),
      prompt: panelPrompt(earlier, req.question),
      tools: (sink) => bibleTools(session, sink),
      maxTurns: PANEL_MAX_TURNS,
      finish: async (result) => ({ answer: result.text }),
    });
  }

  // ---------- the four features (AI-1) ----------

  async runFeature<I, O>(
    session: OpenBible,
    def: FeatureDefinition<I, O>,
    rawInput: unknown,
    runId: string,
  ): Promise<RunStart> {
    const input = def.input.parse(rawInput);
    const at = this.now().toISOString();
    const model = this.modelFor(def.feature);
    const { prompt, given } = def.build(input, session);
    const title = def.title(input, session);
    const turn: ClaudeTurn = { ...newTurn(runId, title, model, at), entries: given };
    const run: ClaudeRun = {
      _id: this.newId(),
      feature: def.feature,
      title,
      createdAt: at,
      modifiedAt: at,
      turns: [turn],
      input,
      output: null,
    };
    return this.launch({
      session,
      run,
      turn,
      feature: def.feature,
      system: featureSystemPrompt(def, session.repo.claudeInstructions()[def.feature]),
      prompt,
      tools: (sink) => def.tools?.(input, session, sink) ?? [],
      outputSchema: jsonSchemaFor(def.output),
      maxTurns: def.maxTurns ?? 3,
      finish: async (result, sink) => {
        const raw = result.structured ?? parseJson(result.text);
        const parsed = def.output.safeParse(raw);
        if (!parsed.success) throw new ClaudeFailure('invalidOutput');
        for (const draft of def.proposals?.(parsed.data, input, session) ?? []) {
          if ('problem' in draft) {
            sink.rejected(draft.summary, draft.problem);
            continue;
          }
          const queued = await queueDraft(session, draft, sink.label, sink.now());
          if (queued.ok) sink.proposed(queued.proposalId);
          else sink.rejected(queued.summary, queued.reason);
        }
        return { answer: result.text, output: parsed.data };
      },
    });
  }

  // ---------- shared ----------

  private async launch(l: Launch): Promise<RunStart> {
    const id = l.turn.id;
    const conversationId = 'existing' in l.run ? l.run.existing : l.run._id;
    // Claim the run ID and the conversation before any await, so two requests cannot both pass.
    if (this.active.has(id) || runExists(l.session, id)) {
      throw new Error('That run ID is already in use.');
    }
    if (this.activeIn(conversationId).length) {
      throw new Error(
        'Claude is still answering in this conversation. Wait for the answer or stop it, then ask again.',
      );
    }
    const controller = new AbortController();
    const slot = { controller, conversationId, done: Promise.resolve() as Promise<unknown> };
    this.active.set(id, slot);
    if (this.earlyStops.delete(id)) controller.abort();

    const store = new RunStore(l.session);
    const at = () => this.now().toISOString();
    const emit = (e: DistributiveOmit<ClaudeStreamEvent, 'runId' | 'conversationId'>) =>
      this.deps.emit({ ...e, runId: id, conversationId } as ClaudeStreamEvent);

    // AI-7: the input is saved before anything is sent. If it cannot be, nothing is sent
    // and the caller gets the reason; the renderer puts the question back.
    let run: ClaudeRun;
    try {
      run =
        'existing' in l.run
          ? await store.pushTurn(conversationId, l.turn, at())
          : await store.create(l.run);
    } catch {
      this.active.delete(id);
      throw new Error(ERROR_MESSAGES.saveFailed);
    }
    let turn = l.turn;
    // Each save writes this turn only (and the output), never the other turns.
    const update = async (patch: Partial<ClaudeTurn>, output?: unknown) => {
      turn = { ...turn, ...patch };
      try {
        run = await store.updateTurn(conversationId, turn, at(), output);
      } catch (e) {
        throw new SaveFailed(e);
      }
    };
    const fail = async (error: RunError) => {
      await update({ status: 'failed', error, finishedAt: at() });
      emit({ kind: 'finished', status: 'failed', error });
      return run;
    };

    const entries = new Map(turn.entries.map((e) => [`${e.collection}:${e.id}`, e]));
    const proposalIds: string[] = [];
    const rejected: { summary: string; reason: string }[] = [];
    const sink: Sink = {
      label: `${FEATURE_INFO[l.feature].label.toLowerCase()}, run ${id}`,
      now: this.now,
      read: (list) => {
        const fresh = list.filter((e) => !entries.has(`${e.collection}:${e.id}`));
        for (const e of fresh) entries.set(`${e.collection}:${e.id}`, e);
        if (fresh.length) emit({ kind: 'read', entries: fresh });
      },
      proposed: (pid) => {
        proposalIds.push(pid);
        emit({ kind: 'proposal', proposalId: pid });
      },
      rejected: (summary, reason) => rejected.push({ summary, reason }),
    };
    const collected = () => ({ entries: [...entries.values()], proposalIds, rejected });

    const body = async (): Promise<ClaudeRun> => {
      const key = this.deps.keys.get();
      if (!this.deps.settings.read().acknowledged[l.session.handle.id]) {
        return fail(errorOf('notAcknowledged'));
      }
      if (!key) return fail(errorOf('noKey'));
      if (turn.entries.length) emit({ kind: 'read', entries: turn.entries });
      const request: ClaudeRequest = {
        feature: l.feature,
        model: turn.model,
        apiKey: key,
        system: l.system,
        prompt: l.prompt,
        tools: l.tools(sink),
        outputSchema: l.outputSchema,
        maxTurns: l.maxTurns,
      };
      let streamed = '';
      let result: { text: string; structured: unknown } | null = null;
      try {
        for await (const ev of this.deps.client.run(request, controller.signal)) {
          if (ev.type === 'text') {
            streamed += ev.text;
            emit({ kind: 'text', text: ev.text });
          } else if (ev.type === 'result') {
            result = { text: ev.text, structured: ev.structured };
          }
        }
        if (controller.signal.aborted) {
          await update({ ...collected(), answer: streamed, status: 'stopped', finishedAt: at() });
          emit({ kind: 'finished', status: 'stopped', error: null });
          return run;
        }
        if (!result) throw new ClaudeFailure('other');
        const finished = await l.finish(
          { text: result.text || streamed, structured: result.structured },
          sink,
        );
        await update(
          { ...collected(), answer: finished.answer || streamed, status: 'done', finishedAt: at() },
          finished.output,
        );
        emit({ kind: 'finished', status: 'done', error: null });
        return run;
      } catch (e) {
        if (e instanceof SaveFailed) throw e;
        const error =
          e instanceof ClaudeFailure ? { kind: e.kind, message: e.message } : errorOf('other');
        // Keep what streamed: the input is in the turn already (AI-7).
        await update({ ...collected(), answer: streamed });
        return fail(error);
      }
    };

    // Whatever happens, the run ends with one `finished` event and `done` never rejects:
    // a save that fails part way is reported as saveFailed (AI-7).
    const done = body()
      .catch(() => {
        emit({ kind: 'finished', status: 'failed', error: errorOf('saveFailed') });
        return { ...run, turns: run.turns.map((t) => (t.id === id ? turn : t)) };
      })
      .finally(() => {
        this.active.delete(id);
      });
    slot.done = done;
    return { runId: id, conversationId, done };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A save to MongoDB failed during a run; reported as saveFailed, never as a Claude error. */
class SaveFailed extends Error {
  constructor(cause: unknown) {
    super('save failed', { cause });
  }
}

const errorOf = (kind: RunError['kind']): RunError => ({ kind, message: ERROR_MESSAGES[kind] });

function newTurn(id: string, question: string, model: string, at: string): ClaudeTurn {
  return {
    id,
    question,
    answer: '',
    model,
    status: 'running',
    error: null,
    entries: [],
    proposalIds: [],
    rejected: [],
    startedAt: at,
    finishedAt: null,
  };
}

function titleOf(question: string): string {
  const one = question.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

function parseJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as unknown;
  } catch {
    return null;
  }
}

function runExists(session: OpenBible, turnId: string): boolean {
  return new RunStore(session).list().some((r) => r.turns.some((t) => t.id === turnId));
}
