import { z } from 'zod';

/**
 * Claude in the app (ARCH-4, AI-1 to AI-7, DB-4): the five features, their
 * default models, the failure kinds, and the shape of a saved run. Shared by
 * main (the runtime) and the renderer (the panel, settings, and feature panes).
 */

/** Every Claude feature. The question panel is one; the other four are started by named controls. */
export const CLAUDE_FEATURES = [
  'briefs',
  'alignment',
  'summaries',
  'importProposals',
  'panel',
] as const;
export const ClaudeFeature = z.enum(CLAUDE_FEATURES);
export type ClaudeFeature = z.infer<typeof ClaudeFeature>;

/**
 * Model IDs from Anthropic's current models page (checked 2026-10-11) and the
 * live `GET /v1/models` list. Briefs and alignment checks default to Opus
 * (DB-4, CC-3). Chapter summaries, import proposals, and the question panel
 * default to Sonnet 5.5: they read and condense rather than reason across the
 * whole bible, and Sonnet is the faster and cheaper current model for that.
 * Every one is a setting.
 */
export const DEFAULT_MODELS: Record<ClaudeFeature, string> = {
  briefs: 'claude-opus-5-5',
  alignment: 'claude-opus-5-5',
  summaries: 'claude-sonnet-5-5',
  importProposals: 'claude-sonnet-5-5',
  panel: 'claude-sonnet-5-5',
};

/** Shown in settings when the live list cannot be reached. */
export const KNOWN_MODELS = [
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
] as const;

/** AI-6: what each feature sends to Anthropic, in plain words. */
export const FEATURE_INFO: Record<ClaudeFeature, { label: string; sends: string }> = {
  panel: {
    label: 'Question panel',
    sends:
      'your question, earlier questions in the same conversation, and the entries Claude looks up to answer',
  },
  briefs: {
    label: 'Session briefs',
    sends: 'the entries selected for the brief',
  },
  alignment: {
    label: 'Alignment checks',
    sends: 'the chapter text, the entries selected for it, and the stored plot',
  },
  summaries: {
    label: 'Chapter summaries',
    sends: 'the chapter text',
  },
  importProposals: {
    label: 'Import proposals',
    sends: 'the text of the imported document and the titles of matching entries',
  },
};

/** AI-7: why a run did not finish, so the message can say what to do next. */
export const ClaudeErrorKind = z.enum([
  'noKey',
  'badKey',
  'rateLimit',
  'network',
  'overloaded',
  'modelUnavailable',
  'invalidOutput',
  'notAcknowledged',
  'saveFailed',
  'noBible',
  'other',
]);
export type ClaudeErrorKind = z.infer<typeof ClaudeErrorKind>;

/** NF-3: plain language with what to do next. Kinds that need the key link to settings. */
export const ERROR_MESSAGES: Record<ClaudeErrorKind, string> = {
  noKey:
    'Claude needs an Anthropic API key, and none is stored. Add one in Settings, then ask again. Your question is kept.',
  badKey:
    'Anthropic rejected the stored API key. Replace it in Settings, then ask again. Your question is kept.',
  rateLimit:
    'Anthropic is limiting how fast this key can send requests. Wait a minute, then try again. Your question is kept.',
  network:
    'The app could not reach Anthropic. Check your network connection, then try again. Your question is kept.',
  overloaded: 'Anthropic is busy right now. Try again in a few minutes. Your question is kept.',
  modelUnavailable:
    'The model chosen for this feature is not available to this key. Pick another in Settings, then try again. Your question is kept.',
  invalidOutput:
    'Claude answered in a shape the app could not read, so nothing was saved from it. Try again.',
  notAcknowledged: 'Read how Claude uses your content and confirm it before the first run.',
  saveFailed:
    'The app could not save this run to MongoDB, so it stopped. Check your connection, then ask again. Your question is kept.',
  noBible: 'Open a bible first.',
  other: 'Claude could not finish. Try again. Your question is kept.',
};

export const needsSettings = (kind: ClaudeErrorKind): boolean =>
  kind === 'noKey' || kind === 'badKey' || kind === 'modelUnavailable';

export const RunError = z.strictObject({ kind: ClaudeErrorKind, message: z.string() });
export type RunError = z.infer<typeof RunError>;

/** An entry Claude read (panel) or was given (feature run), AI-2. */
export const EntryRefWire = z.strictObject({
  collection: z.string().min(1),
  id: z.string().min(1),
  title: z.string(),
});
export type EntryRefWire = z.infer<typeof EntryRefWire>;

export const RunStatus = z.enum(['running', 'done', 'stopped', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;

/** One question and answer in the panel, or the single exchange of a feature run. */
export const ClaudeTurn = z.strictObject({
  id: z.string().min(1),
  /** The question as typed (panel) or a one-line description of the input (feature). Kept on failure (AI-7). */
  question: z.string(),
  answer: z.string().default(''),
  model: z.string(),
  status: RunStatus,
  error: RunError.nullable().default(null),
  /** Panel: entries the tools returned. Feature: entries in the deterministic input. */
  entries: z.array(EntryRefWire).default([]),
  /** Proposals this turn put in the review queue (AI-3). */
  proposalIds: z.array(z.string()).default([]),
  /** Proposals Claude made that failed validation and were not queued, with the reason. */
  rejected: z.array(z.strictObject({ summary: z.string(), reason: z.string() })).default([]),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
});
export type ClaudeTurn = z.infer<typeof ClaudeTurn>;

/**
 * A saved run, stored in the bible's `conversations` collection (schema
 * version 7). A panel conversation holds many turns; a feature run holds one,
 * with its deterministic input and its validated output (AI-1).
 */
export const ClaudeRun = z.strictObject({
  _id: z.string().min(1),
  feature: ClaudeFeature,
  title: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  turns: z.array(ClaudeTurn),
  /** Feature runs: the input as given, so the run can be repeated. */
  input: z.unknown().optional(),
  /** Feature runs: the zod-validated structured output, or null when the run failed. */
  output: z.unknown().optional(),
});
export type ClaudeRun = z.infer<typeof ClaudeRun>;

export const ClaudeRunSummary = z.strictObject({
  id: z.string(),
  feature: ClaudeFeature,
  title: z.string(),
  modifiedAt: z.string(),
  turns: z.int().min(0),
  status: RunStatus,
});
export type ClaudeRunSummary = z.infer<typeof ClaudeRunSummary>;

/** Pushed to the renderer while a run streams. */
export const ClaudeStreamEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    runId: z.string(),
    conversationId: z.string(),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal('read'),
    runId: z.string(),
    conversationId: z.string(),
    entries: z.array(EntryRefWire),
  }),
  z.strictObject({
    kind: z.literal('proposal'),
    runId: z.string(),
    conversationId: z.string(),
    proposalId: z.string(),
  }),
  z.strictObject({
    kind: z.literal('finished'),
    runId: z.string(),
    conversationId: z.string(),
    status: RunStatus,
    error: RunError.nullable(),
  }),
]);
export type ClaudeStreamEvent = z.infer<typeof ClaudeStreamEvent>;

/** Settings and sign-in status as the settings screen shows them. The key is never sent in full. */
export const ClaudeStatusWire = z.strictObject({
  key: z.strictObject({ set: z.boolean(), masked: z.string().nullable() }),
  acknowledgedAt: z.string().nullable(),
  models: z.record(ClaudeFeature, z.string()),
});
export type ClaudeStatusWire = z.infer<typeof ClaudeStatusWire>;

/** Show only enough of the key to recognise it: never the whole key (ARCH-4). */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 12) return '••••';
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}

const RunIdWire = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'A run ID is 8 to 64 letters, digits, dashes, or underscores.');

const ModelList = z.array(z.strictObject({ id: z.string(), displayName: z.string() }));

/** A run has started; its stream events carry `runId`. The renderer picks `runId` so it can listen first. */
const Started = z.strictObject({ runId: z.string(), conversationId: z.string() });

/**
 * The Claude channels of the IPC contract (`src/shared/ipc.ts` spreads them
 * in). AI-4: only `claude.ask` carries free text, the question typed into the
 * panel; every feature channel takes IDs of the material it works on.
 */
export const claudeContract = {
  /** ARCH-4, AI-6, DB-4: key status (masked), disclosure, and the model per feature. */
  'claude.status': {
    request: z.strictObject({}),
    response: ClaudeStatusWire,
  },
  /** ARCH-4: store or replace the key in the keychain after checking it with Anthropic. */
  'claude.setKey': {
    request: z.strictObject({ key: z.string().max(500) }),
    response: z.strictObject({
      ok: z.boolean(),
      message: z.string(),
      status: ClaudeStatusWire,
    }),
  },
  'claude.clearKey': {
    request: z.strictObject({}),
    response: ClaudeStatusWire,
  },
  /** ARCH-4: the models the key may use, from the live models endpoint. */
  'claude.models': {
    request: z.strictObject({}),
    response: z.strictObject({
      models: ModelList,
      live: z.boolean(),
      message: z.string().nullable(),
    }),
  },
  'claude.setModel': {
    request: z.strictObject({ feature: ClaudeFeature, model: z.string().min(1).max(100) }),
    response: ClaudeStatusWire,
  },
  /** AI-6: the person read what is sent to Anthropic. */
  'claude.acknowledge': {
    request: z.strictObject({}),
    response: ClaudeStatusWire,
  },
  /** AI-1: ask the question panel; the answer streams as `claude.stream` events. */
  'claude.ask': {
    request: z.strictObject({
      runId: RunIdWire,
      conversationId: z.string().min(1).max(64).nullable(),
      question: z.string().trim().min(1).max(8000),
    }),
    response: Started,
  },
  /** AI-1: stop a streaming run. */
  'claude.stop': {
    request: z.strictObject({ runId: z.string().min(1).max(64) }),
    response: z.strictObject({ stopped: z.boolean() }),
  },
  /** AI-1: saved runs, newest first; one feature or all. */
  'claude.runs': {
    request: z.strictObject({ feature: ClaudeFeature.optional() }),
    response: z.strictObject({ runs: z.array(ClaudeRunSummary) }),
  },
  'claude.run': {
    request: z.strictObject({ id: z.string().min(1).max(64) }),
    response: z.strictObject({ run: ClaudeRun, active: z.array(z.string()) }),
  },
  /** IM-5: Claude reads a Word document picked in Import and proposes entries for review. */
  'claude.importProposals': {
    request: z.strictObject({ runId: RunIdWire, fileId: z.string().min(1).max(64) }),
    response: Started,
  },
  /**
   * CC-3: Claude reads one chapter against its selected entries and the stored
   * plot. Resolves when the run ends (it streams meanwhile); the checked
   * findings are stored, and the ones Claude made that failed the checks are
   * returned with the reason.
   */
  'claude.alignment': {
    request: z.strictObject({ runId: RunIdWire, chapterId: z.string().min(1).max(64) }),
    response: z.strictObject({
      runId: z.string(),
      conversationId: z.string(),
      status: RunStatus,
      error: RunError.nullable(),
      found: z.int().min(0),
      hidden: z.int().min(0),
      rejected: z.array(z.strictObject({ summary: z.string(), reason: z.string() })),
      /** Why a finished run recorded nothing (the chapter text changed while Claude read it), or null. */
      skipped: z.string().nullable(),
    }),
  },
} as const;

export const claudeEvents = {
  /** AI-1: a streaming run's text, the entries it read, its proposals, and how it finished. */
  'claude.stream': ClaudeStreamEvent,
} as const;
