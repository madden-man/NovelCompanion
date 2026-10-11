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
 * A feature that runs Claude once over a deterministic input (AI-1): session
 * briefs (SB-4, DB-2), alignment checks (CC-3), chapter summaries (MS-2), and
 * import proposals (IM-5). Each lives in `features/` and is started with
 * `ClaudeRuntime.runFeature`. See docs/ARCHITECTURE.md, "Claude runtime".
 */
export interface FeatureDefinition<I, O> {
  feature: Exclude<ClaudeFeature, 'panel'>;
  /** Feature-specific system prompt text; the runtime prepends the shared rules, the AI-4 prohibition among them. */
  instructions: string;
  /** The deterministic input, validated before anything is sent. */
  input: z.ZodType<I>;
  /** The structured output Claude must return; validated with zod before anything is saved. */
  output: z.ZodType<O>;
  /** History title, for example "Brief for Chapter 4". */
  title(input: I, session: OpenBible): string;
  /** The prompt and the entries it contains. Must be deterministic: same input and data, same prompt. */
  build(input: I, session: OpenBible): { prompt: string; given: EntryRefWire[] };
  /** Proposals the output carries, checked and queued for review (AI-3). A problem is reported, never dropped. */
  proposals?(output: O, input: I, session: OpenBible): DraftOrProblem[];
  /** Tool round trips allowed; features get their material in the prompt, so the default is small. */
  maxTurns?: number;
}

/** A proposal draft, or why one the output carries could not become a draft. */
export type DraftOrProblem = ProposalDraft | { summary: string; problem: string };

/** The system prompt a feature runs with (AI-4: the only way to build one). */
export const featureSystemPrompt = (def: { instructions: string }): string =>
  systemPrompt(def.instructions);

export const panelSystemPrompt = (): string => systemPrompt(PANEL_INSTRUCTIONS);

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
  run: ClaudeRun;
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
  private readonly active = new Map<string, AbortController>();
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
    const c = this.active.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Stop everything, for example when the bible closes. */
  stopAll(): void {
    for (const c of this.active.values()) c.abort();
  }

  // ---------- the question panel (AI-1, AI-2) ----------

  async ask(
    session: OpenBible,
    req: { runId: string; conversationId: string | null; question: string },
  ): Promise<RunStart> {
    const store = new RunStore(session);
    const at = this.now().toISOString();
    const model = this.modelFor('panel');
    let run: ClaudeRun;
    if (req.conversationId) {
      const found = store.get(req.conversationId);
      if (!found || found.feature !== 'panel') throw new Error('That conversation is not saved.');
      run = found;
    } else {
      run = {
        _id: this.newId(),
        feature: 'panel',
        title: titleOf(req.question),
        createdAt: at,
        modifiedAt: at,
        turns: [],
      };
    }
    const earlier = run.turns.filter((t) => t.status === 'done');
    const turn = newTurn(req.runId, req.question, model, at);
    return this.launch({
      session,
      run: { ...run, turns: [...run.turns, turn], modifiedAt: at },
      turn,
      feature: 'panel',
      system: panelSystemPrompt(),
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
      system: featureSystemPrompt(def),
      prompt,
      tools: () => [],
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
    if (this.active.has(l.turn.id) || runExists(l.session, l.turn.id)) {
      throw new Error('That run ID is already in use.');
    }
    const store = new RunStore(l.session);
    const conversationId = l.run._id;
    const emit = (e: DistributiveOmit<ClaudeStreamEvent, 'runId' | 'conversationId'>) =>
      this.deps.emit({ ...e, runId: l.turn.id, conversationId } as ClaudeStreamEvent);
    // AI-7: the input is saved before anything is sent.
    let run = await store.save(l.run);
    let turn = l.turn;
    const update = async (patch: Partial<ClaudeTurn>, runPatch: Partial<ClaudeRun> = {}) => {
      turn = { ...turn, ...patch };
      run = {
        ...run,
        ...runPatch,
        modifiedAt: this.now().toISOString(),
        turns: run.turns.map((t) => (t.id === turn.id ? turn : t)),
      };
      run = await store.save(run);
    };
    const fail = async (error: RunError) => {
      await update({ status: 'failed', error, finishedAt: this.now().toISOString() });
      emit({ kind: 'finished', status: 'failed', error });
      return run;
    };

    const key = this.deps.keys.get();
    const settings = this.deps.settings.read();
    if (!settings.acknowledged[l.session.handle.id]) {
      const done = fail(errorOf('notAcknowledged'));
      return { runId: turn.id, conversationId, done };
    }
    if (!key) {
      const done = fail(errorOf('noKey'));
      return { runId: turn.id, conversationId, done };
    }

    const controller = new AbortController();
    this.active.set(turn.id, controller);
    const entries = new Map(turn.entries.map((e) => [`${e.collection}:${e.id}`, e]));
    const proposalIds: string[] = [];
    const rejected: { summary: string; reason: string }[] = [];
    const sink: Sink = {
      label: `${FEATURE_INFO[l.feature].label.toLowerCase()}, run ${turn.id}`,
      now: this.now,
      read: (list) => {
        const fresh = list.filter((e) => !entries.has(`${e.collection}:${e.id}`));
        for (const e of fresh) entries.set(`${e.collection}:${e.id}`, e);
        if (fresh.length) emit({ kind: 'read', entries: fresh });
      },
      proposed: (id) => {
        proposalIds.push(id);
        emit({ kind: 'proposal', proposalId: id });
      },
      rejected: (summary, reason) => rejected.push({ summary, reason }),
    };
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

    const done = (async (): Promise<ClaudeRun> => {
      let streamed = '';
      let result: { text: string; structured: unknown } | null = null;
      const collected = () => ({ entries: [...entries.values()], proposalIds, rejected });
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
          await update({
            ...collected(),
            answer: streamed,
            status: 'stopped',
            finishedAt: this.now().toISOString(),
          });
          emit({ kind: 'finished', status: 'stopped', error: null });
          return run;
        }
        if (!result) throw new ClaudeFailure('other');
        const finished = await l.finish(
          { text: result.text || streamed, structured: result.structured },
          sink,
        );
        await update(
          {
            ...collected(),
            answer: finished.answer || streamed,
            status: 'done',
            finishedAt: this.now().toISOString(),
          },
          finished.output !== undefined ? { output: finished.output } : {},
        );
        emit({ kind: 'finished', status: 'done', error: null });
        return run;
      } catch (e) {
        const error =
          e instanceof ClaudeFailure ? { kind: e.kind, message: e.message } : errorOf('other');
        // Keep what streamed: the input is in the turn already (AI-7).
        await update({ ...collected(), answer: streamed });
        return fail(error);
      } finally {
        this.active.delete(turn.id);
      }
    })();
    return { runId: turn.id, conversationId, done };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
