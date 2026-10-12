import { manifests, isEntryCollection, collectionInfo } from './schema';
import { labelPath, plainIssue } from './domain/issues';
import type { IssueLike } from './domain/issues';

/**
 * NF-3: errors in plain language with what to do next. Main maps every error
 * before it crosses IPC (`src/main/ipc/handle.ts`), and the renderer maps
 * again whatever reaches it (`plainError` in `src/renderer/src/api.ts`), so a
 * driver message, a zod path, a status code, or a stack trace never shows.
 */
export const PLAIN = {
  unreachable:
    'The app could not reach the MongoDB deployment. Check your network connection and try again.',
  slow: 'The database took too long to answer. Check your network connection and try again.',
  duplicate:
    'Something with the same ID is already saved, so nothing changed. Reload the screen with Cmd+R and try again.',
  database:
    'The database refused the change, so nothing was saved. Try again, and restart the app if it keeps happening.',
  invalidRequest:
    'The app could not use what this screen sent, so nothing changed. Reload the screen with Cmd+R and try again.',
  invalidResponse:
    'The app could not read what it got back, so nothing is shown. Reload the screen with Cmd+R and try again.',
  invalidEntry:
    'This was not saved because a field has a value the app cannot store. Fix the marked field and try again.',
  network: 'The app could not reach the network. Check your connection and try again.',
  missingFile:
    'The app could not find a file or folder it needed. Check that it still exists, then try again.',
  permission:
    'The app is not allowed to use that file or folder. Check its permissions in Finder, then try again.',
  diskFull: 'The disk is full. Free some space, then try again.',
  file: 'The app could not read or write a file it needed. Check the disk and the folder, then try again.',
  unknown:
    'Something went wrong in the app, so nothing changed. Try again, and restart the app if it keeps happening.',
} as const;

/** Mongo driver error class names that mean the deployment could not be reached. */
const UNREACHABLE = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoPoolClosedError',
  'MongoServerClosedError',
  'MongoClientClosedError',
]);
const SLOW = new Set(['MongoNetworkTimeoutError', 'MongoOperationTimeoutError']);
/** Mistakes in the app's own code: never shown as they are. */
const BUGS = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError']);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * True when a message carries something raw: an exception name with a colon,
 * a system error code, a Mongo duplicate key, a status code with no sentence
 * around it, a stack frame, or a zod report.
 */
export function looksRaw(text: string): boolean {
  return RAW_PATTERNS.some((p) => p.test(text));
}

export const RAW_PATTERNS: readonly RegExp[] = [
  /\b[A-Z]?[a-zA-Z]*(Error|Exception):/, // "Error:", "TypeError:", "MongoServerError:"
  /\bE(CONN[A-Z]+|NOTFOUND|TIMEDOUT|ACCES|PERM|NOENT|NOSPC|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /\bE11000\b/,
  /\bUND_ERR_[A-Z_]+\b/,
  /^\s*at .+\(.+:\d+:\d+\)/m, // a stack frame
  /\n\s+at /,
  /\(\s*[1-5]\d\d\s*(:|\))/, // "(400: ...)" or "(503)"
  /\b(status|HTTP|code)\s*[1-5]\d\d\b/i,
  /^\s*[1-5]\d\d\b/, // a message that starts with a status code
  /✖/, // zod's prettified report
  /→ at /,
  /\bis not valid: /,
  /\bserver selection\b/i,
  /\bundefined\b|\bnull\b|\[object Object\]/,
];

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  issues?: unknown;
  collection?: unknown;
  cause?: unknown;
}

function asObject(e: unknown): ErrorLike | null {
  return typeof e === 'object' && e !== null ? (e as ErrorLike) : null;
}

/** A repository validation failure as one sentence naming the field. */
function entryIssue(e: ErrorLike): string {
  const issues = Array.isArray(e.issues) ? (e.issues as IssueLike[]) : [];
  const first = issues[0];
  if (!first) return PLAIN.invalidEntry;
  const c = typeof e.collection === 'string' ? e.collection : '';
  const path = first.path.map(String).join('.');
  const label = path && isEntryCollection(c) ? labelPath(manifests[c], path) : '';
  const what = isEntryCollection(c) ? collectionInfo[c].singular.toLowerCase() : 'entry';
  // Zod leaves the input out of its issues unless asked; its message still says what it got.
  const withInput =
    first.code === 'invalid_type' && !('input' in first)
      ? { ...first, input: /received (undefined|null)\b/.test(first.message) ? undefined : '' }
      : first;
  const problem = plainIssue(withInput);
  if (looksRaw(problem)) return PLAIN.invalidEntry;
  return label
    ? `The ${what} was not saved. ${label}: ${problem} Fix that field and try again.`
    : `The ${what} was not saved. ${problem} Fix it and try again.`;
}

/**
 * Plain words for any error, with what to do next. A message the app wrote
 * itself passes through; anything raw is replaced.
 */
export function plainErrorMessage(e: unknown): string {
  const err = asObject(e);
  const name = typeof err?.name === 'string' ? err.name : '';
  const code = err?.code;
  const message = typeof err?.message === 'string' ? err.message : typeof e === 'string' ? e : '';
  if (UNREACHABLE.has(name)) return PLAIN.unreachable;
  if (SLOW.has(name)) return PLAIN.slow;
  if (code === 11000 || code === 11001 || /\bE11000\b/.test(message)) return PLAIN.duplicate;
  if (name.startsWith('Mongo')) {
    return /timed out|timeout/i.test(message) ? PLAIN.slow : PLAIN.database;
  }
  if (
    name === 'IpcValidationError' ||
    /^The (request|response) for \S+ is not valid/.test(message)
  ) {
    return /^The response/.test(message) ? PLAIN.invalidResponse : PLAIN.invalidRequest;
  }
  if (name === 'ValidationError' && /\bis not valid: /.test(message)) return entryIssue(err ?? {});
  if (name === 'ZodError' || name === '$ZodError') return PLAIN.invalidEntry;
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code)) return PLAIN.network;
    if (code === 'ENOENT') return PLAIN.missingFile;
    if (code === 'EACCES' || code === 'EPERM') return PLAIN.permission;
    if (code === 'ENOSPC') return PLAIN.diskFull;
    if (/^E[A-Z]+$/.test(code)) return PLAIN.file;
  }
  if (name === 'AbortError') return 'Stopped before it finished. Try again when you are ready.';
  if (BUGS.has(name)) return PLAIN.unknown;
  // `fetch failed` and similar wrap the real cause.
  if (message === 'fetch failed' || /^(connect|getaddrinfo|read|write) E[A-Z]+/.test(message)) {
    return PLAIN.network;
  }
  if (!message.trim()) return PLAIN.unknown;
  if (looksRaw(message)) {
    if (/server selection|mongo/i.test(message)) return PLAIN.unreachable;
    if (/\bE(CONN[A-Z]+|NOTFOUND|TIMEDOUT|AI_AGAIN)\b/.test(message)) return PLAIN.network;
    return PLAIN.unknown;
  }
  return message;
}

/**
 * What the renderer shows for a failed call: Electron wraps main's message
 * ("Error invoking remote method 'nc:x': Error: ..."); keep the message and
 * map it again, which also covers what the preload throws itself.
 */
export function plainCallError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';
  const stripped = text.replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');
  return plainErrorMessage(name && name !== 'Error' ? { name, message: stripped } : stripped);
}

/** The editor's line when a save failed (ED-2, NF-3); `error` is already plain. */
export function notSavedText(error: string | null): string {
  return `Not saved${error ? `: ${error}` : '. Fix the marked fields.'}`;
}
