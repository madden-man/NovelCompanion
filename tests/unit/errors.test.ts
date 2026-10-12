import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { MongoClient, MongoNetworkError, MongoServerError } from 'mongodb';
import { z } from 'zod';
import {
  PLAIN,
  looksRaw,
  notSavedText,
  plainCallError as plainError,
} from '../../src/shared/errors';
import { ValidationError, RepositoryError } from '../../src/main/db/repository';
import { DriveApi, DriveError } from '../../src/main/drive/api';
import { endpointsAt } from '../../src/main/drive/oauth';
import { userStrings } from '../helpers/userStrings';

type Registered = (event: unknown, payload: unknown) => Promise<unknown>;
const registered = new Map<string, Registered>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Registered) => {
      registered.set(channel, fn);
    },
  },
}));

const { handle } = await import('../../src/main/ipc/handle');

const ROOT = new URL('../..', import.meta.url).pathname;
const NEXT_STEP =
  /\b(Check|Try|Reload|Fix|Free|Connect|Restart|Open|Wait|Set|Choose|Pick|Write|Update|Download|Add|Move|Remove|Take|Save|Ask|Use|Run)\b/;

/** What any message a person sees must satisfy (NF-3). */
function expectPlain(message: string) {
  expect(looksRaw(message), message).toBe(false);
  expect(message, message).not.toMatch(/—/);
  expect(message, message).toMatch(/[.!?]$/);
  expect(message, message).toMatch(NEXT_STEP);
}

/** Run one IPC handler that throws, through the real `handle`, and return what the renderer gets. */
async function thrownThroughHandle(error: unknown, payload: unknown = {}): Promise<string> {
  registered.clear();
  handle('bible.list', () => {
    throw error;
  });
  const fn = registered.get('nc:bible.list')!;
  try {
    await fn({}, payload);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the handler did not throw');
}

async function serverSelectionError(): Promise<unknown> {
  // A closed port: the driver's own MongoServerSelectionError, not a stand-in.
  const client = new MongoClient('mongodb://127.0.0.1:1/?directConnection=true', {
    serverSelectionTimeoutMS: 150,
  });
  try {
    await client.connect();
  } catch (e) {
    return e;
  } finally {
    await client.close();
  }
  throw new Error('connected to a closed port');
}

function zodError(): unknown {
  try {
    z.strictObject({ names: z.strictObject({ full: z.string().min(1) }) }).parse({
      names: { full: 3 },
    });
  } catch (e) {
    return e;
  }
}

describe('NF-3 handle.ts maps the known error classes', () => {
  test('NF-3 a MongoDB server selection timeout says the deployment is unreachable and to check the network', async () => {
    const e = await serverSelectionError();
    expect((e as Error).name).toBe('MongoServerSelectionError');
    const shown = await thrownThroughHandle(e);
    expect(shown).toBe(PLAIN.unreachable);
    expectPlain(shown);
  });

  test('NF-3 a MongoDB network error and a refused connection say the same, with no ECONNREFUSED', async () => {
    const shown = await thrownThroughHandle(
      new MongoNetworkError('connect ECONNREFUSED 127.0.0.1:27017'),
    );
    expect(shown).toBe(PLAIN.unreachable);
    const sys = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(await thrownThroughHandle(sys)).toBe(PLAIN.network);
    expect(await thrownThroughHandle(new Error('fetch failed'))).toBe(PLAIN.network);
  });

  test('NF-3 a duplicate key (E11000) becomes a plain sentence', async () => {
    const e = new MongoServerError({
      message: 'E11000 duplicate key error collection: novel_companion.x index: _id_ dup key',
      errmsg: 'E11000 duplicate key error',
      code: 11000,
    });
    const shown = await thrownThroughHandle(e);
    expect(shown).toBe(PLAIN.duplicate);
    expectPlain(shown);
  });

  test('NF-3 a request that fails validation never names the channel or a zod path', async () => {
    registered.clear();
    handle('bible.open', () => ({ bible: { id: 'x', name: 'x' } }));
    const fn = registered.get('nc:bible.open')!;
    const shown = await fn({}, { slug: 42 }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(shown).toBe(PLAIN.invalidRequest);
    expect(shown).not.toMatch(/bible\.open|slug|✖/);
    expectPlain(shown);
  });

  test('NF-3 a response that fails validation says nothing is shown and to reload', async () => {
    registered.clear();
    handle('bible.current', () => ({ bible: 'tide' }) as never);
    const shown = await registered.get('nc:bible.current')!({}, {}).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(shown).toBe(PLAIN.invalidResponse);
    expectPlain(shown);
  });

  test('NF-3 an entry that fails the schema names the field by its label, not its path', async () => {
    const issues = (zodError() as z.ZodError).issues;
    const e = new ValidationError(
      'This characters entry is not valid: ✖ Invalid input: expected string\n  → at names.full',
      issues as never,
      'characters',
    );
    const shown = await thrownThroughHandle(e);
    expect(shown).toBe(
      'The character was not saved. Names, Full name: This value has the wrong form. Fix that field and try again.',
    );
    expectPlain(shown);
    expect(await thrownThroughHandle(zodError())).toBe(PLAIN.invalidEntry);
  });

  test('NF-3 file system codes become plain words with a next step', async () => {
    const sys = (code: string) => Object.assign(new Error(`${code}: open '/x'`), { code });
    expect(await thrownThroughHandle(sys('ENOENT'))).toBe(PLAIN.missingFile);
    expect(await thrownThroughHandle(sys('EACCES'))).toBe(PLAIN.permission);
    expect(await thrownThroughHandle(sys('ENOSPC'))).toBe(PLAIN.diskFull);
    expect(await thrownThroughHandle(sys('EISDIR'))).toBe(PLAIN.file);
    for (const m of Object.values(PLAIN)) expectPlain(m);
  });

  test('NF-3 a bug in the app (TypeError, a stack trace) shows the general message, never the trace', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'year')");
    expect(await thrownThroughHandle(bug)).toBe(PLAIN.unknown);
    const traced = new Error('boom\n    at Object.<anonymous> (/app/out/main/index.js:12:5)');
    expect(await thrownThroughHandle(traced)).toBe(PLAIN.unknown);
    expect(await thrownThroughHandle('a string')).toBe('a string');
    expect(await thrownThroughHandle(undefined)).toBe(PLAIN.unknown);
  });

  test("NF-3 the app's own plain messages pass through unchanged", async () => {
    for (const m of [
      'This entry changed somewhere else. Reload it and try again.',
      'Open a bible first.',
      'Google Drive could not find that file. It may be deleted or no longer shared with you.',
    ]) {
      const e = m.startsWith('Google') ? new DriveError(m, 404) : new RepositoryError(m);
      expect(await thrownThroughHandle(e)).toBe(m);
    }
  });
});

describe('NF-3 Drive and the editor show mapped text', () => {
  test('NF-3 a Drive 400 or other refusal has no status code and says what to do next', async () => {
    for (const status of [400, 409, 418]) {
      const api = new DriveApi({
        endpoints: endpointsAt('http://127.0.0.1:9'),
        token: () => Promise.resolve('t'),
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: { message: 'Invalid Value', errors: [{ reason: 'invalid' }] },
              }),
              {
                status,
              },
            ),
          ),
      });
      const shown = await api.about().then(
        () => '',
        (e: Error) => e.message,
      );
      expect(shown).not.toMatch(new RegExp(String(status)));
      expect(shown).not.toMatch(/Invalid Value|invalid/);
      expectPlain(shown);
    }
  });

  test('NF-3 the editor\'s "Not saved:" line shows the mapped text from main, and maps anything raw', () => {
    const fromMain = `Error invoking remote method 'nc:entry.update': Error: ${PLAIN.unreachable}`;
    // editor.tsx SaveState renders notSavedText(plainError(e)).
    expect(notSavedText(plainError(new Error(fromMain)))).toBe(`Not saved: ${PLAIN.unreachable}`);
    const raw = `Error invoking remote method 'nc:entry.update': MongoServerSelectionError: Server selection timed out after 30000 ms`;
    expect(plainError(new Error(raw))).toBe(PLAIN.unreachable);
    const preload = Object.assign(new Error('The request for entry.update is not valid: ✖ x'), {
      name: 'IpcValidationError',
    });
    expect(plainError(preload)).toBe(PLAIN.invalidRequest);
  });
});

describe('NF-3 no raw codes in user-facing strings', () => {
  const strings = userStrings(ROOT, ['src/main', 'src/renderer/src', 'src/shared']).filter(
    // The mapper's own tables name the codes it replaces.
    (s) => s.file !== 'src/shared/errors.ts',
  );

  test('NF-3 the sweep reads the source (thousands of strings in main, renderer, and shared)', () => {
    expect(strings.length).toBeGreaterThan(3000);
    expect(strings.some((s) => s.file.startsWith('src/renderer'))).toBe(true);
    expect(strings.some((s) => s.file.startsWith('src/main'))).toBe(true);
  });

  test('NF-3 no string carries "Error:", ECONN codes, E11000, a stack frame, or a bare status code', () => {
    const RAW: [string, RegExp][] = [
      ['an exception name with a colon', /\b[A-Za-z]*(Error|Exception):/],
      [
        'a system error code',
        /\bE(CONN[A-Z]+|NOTFOUND|TIMEDOUT|ACCES|PERM|NOENT|NOSPC|AI_AGAIN)\b/,
      ],
      ['a duplicate key code', /\bE11000\b/],
      ['a stack frame', /\n\s+at |^\s*at \S+ \(/m],
      [
        'a status code in brackets',
        /\(\s*(\$\{[^}]*\b(status|statusCode|code)\b[^}]*\}|[1-5]\d\d)\s*(:|\))/,
      ],
      ['a status code with no sentence', /\b(status|HTTP)\s*[1-5]\d\d\b/i],
    ];
    const hits = strings.flatMap((s) =>
      RAW.filter(([, r]) => r.test(s.text)).map(([why]) => `${s.file}:${s.line} ${why}: ${s.text}`),
    );
    expect(hits).toEqual([]);
  });

  test('NF-3 no caught error message is put in front of a person without the mapper', () => {
    // `${e.message}` in a template, or a caught error's message set as state, would show it raw.
    const forwards = strings.filter((s) => /\$\{/.test(s.text));
    expect(forwards.length).toBeGreaterThan(0);
    const files = new Set(strings.map((s) => s.file));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readSource(file);
      for (const m of text.matchAll(
        /\$\{\s*(e|err|error)\s+instanceof\s+Error\s*\?\s*\1\.message|\$\{\s*(e|err|error)\.message|set\w*Error\(\s*(e|err)\.message\)/g,
      )) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function readSource(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
}
