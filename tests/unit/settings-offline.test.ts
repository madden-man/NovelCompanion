import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MongoClientClosedError,
  MongoExpiredSessionError,
  MongoNetworkTimeoutError,
  MongoOperationTimeoutError,
  MongoServerClosedError,
  MongoServerError,
} from 'mongodb';

// The pool errors are not exported from the package root; these are the driver's own classes.
type PoolError = new (pool: { address: string }) => Error;
const { PoolClearedError, PoolClearedOnNetworkError, PoolClosedError, WaitQueueTimeoutError } =
  createRequire(import.meta.url)('mongodb/lib/cmap/errors.js') as {
    PoolClosedError: PoolError;
    PoolClearedError: PoolError;
    PoolClearedOnNetworkError: PoolError;
    WaitQueueTimeoutError: new (message: string, address: string) => Error;
  };
import { cleanMongoUri, maskMongoUri } from '../../src/main/secrets';
import { guardHandler, isConnectionError } from '../../src/main/ipc/offline';
import { ReadOnlyError } from '../../src/main/db/readOnly';
import { connectionFailure } from '../../src/main/connection';
import { CHANNELS } from '../../src/shared/ipc';
import { CONNECTION_LOST_MESSAGE, READ_ONLY_REASON, WRITE_CHANNELS } from '../../src/shared/ipcApp';

const ROOT = join(import.meta.dirname, '../..');
const RENDERER = join(ROOT, 'src/renderer/src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('ST-1 the MongoDB connection string is shown masked', () => {
  const cases = [
    'mongodb+srv://tommy:s3cret-Pa55@cluster0.ab1cd.mongodb.net/?retryWrites=true&w=majority',
    'mongodb://admin:hunter2@127.0.0.1:27017/?replicaSet=testset',
    'mongodb://localhost:27017',
  ];

  test('ST-1 the masked form keeps the scheme and the end of the host, never the user, password, or options', () => {
    expect(maskMongoUri(cases[0]!)).toBe('mongodb+srv://…ongodb.net');
    expect(maskMongoUri(cases[1]!)).toBe('mongodb://….0.1:27017');
    for (const uri of cases) {
      const masked = maskMongoUri(uri);
      expect(masked).not.toMatch(/s3cret|hunter2|tommy|admin|retryWrites|replicaSet|@/);
      expect(masked).not.toBe(uri);
      expect(masked.length).toBeLessThan(uri.length);
    }
    expect(maskMongoUri('nonsense')).toBe('a connection string the app cannot read');
  });

  test('ST-1 a pasted string is checked for shape before anything connects', () => {
    expect(cleanMongoUri('  mongodb+srv://u:p@c.example.net/  ', { localOnly: false })).toEqual({
      ok: true,
      uri: 'mongodb+srv://u:p@c.example.net/',
    });
    expect(cleanMongoUri('', { localOnly: false }).ok).toBe(false);
    expect(cleanMongoUri('mongodb://a b', { localOnly: false })).toEqual({
      ok: false,
      message: 'A connection string has no spaces or line breaks.',
    });
    expect(cleanMongoUri('postgres://x', { localOnly: false })).toMatchObject({ ok: false });
    expect(cleanMongoUri('mongodb+srv://c.example.net', { localOnly: true })).toEqual({
      ok: false,
      message: 'The test database address must be a local MongoDB.',
    });
  });

  test('ST-1 NF-3 connection failures are explained in plain words without the string', () => {
    const cases: [Error, RegExp][] = [
      [
        Object.assign(new Error('Authentication failed.'), { name: 'MongoServerError' }),
        /user name or password/,
      ],
      [
        Object.assign(new Error('querySrv ENOTFOUND _mongodb._tcp.x'), { name: 'MongoAPIError' }),
        /not found/,
      ],
      [
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          name: 'MongoServerSelectionError',
        }),
        /Nothing answered/,
      ],
      [
        Object.assign(new Error('timed out'), { name: 'MongoServerSelectionError' }),
        /did not answer in time/,
      ],
      [Object.assign(new Error('Invalid scheme'), { name: 'MongoParseError' }), /not in a form/],
    ];
    for (const [e, want] of cases) {
      const text = connectionFailure(e);
      expect(text).toMatch(want);
      expect(text).not.toMatch(/ECONNREFUSED|ENOTFOUND|Mongo\w*Error|—/);
    }
  });
});

describe('ARCH-6 offline behaviour in the IPC layer', () => {
  test('ARCH-6 driver errors that mean MongoDB is out of reach are told apart from refused writes', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    for (const n of [
      'MongoNetworkError',
      'MongoServerSelectionError',
      'MongoTopologyClosedError',
      'MongoNotConnectedError',
    ]) {
      expect(isConnectionError(named(n))).toBe(true);
      expect(isConnectionError(new Error('wrapped', { cause: named(n) }))).toBe(true);
    }
    expect(isConnectionError(named('MongoServerError'))).toBe(false);
    expect(isConnectionError(new Error('This entry is not valid'))).toBe(false);
    expect(isConnectionError('text')).toBe(false);
  });

  test('ARCH-6 the driver pool, close, and timeout errors count as a lost connection', () => {
    const pool = { address: '127.0.0.1:27017' };
    const real: Error[] = [
      new PoolClosedError(pool),
      new PoolClearedError(pool),
      new PoolClearedOnNetworkError(pool),
      new WaitQueueTimeoutError('Timed out while checking out a connection', pool.address),
      new MongoServerClosedError(),
      new MongoClientClosedError(),
      new MongoOperationTimeoutError('Timed out'),
      new MongoNetworkTimeoutError('socket timed out'),
      new MongoExpiredSessionError(),
    ];
    expect(real.map((e) => e.name)).toEqual([
      'MongoPoolClosedError',
      'MongoPoolClearedError',
      'PoolClearedOnNetworkError',
      'MongoWaitQueueTimeoutError',
      'MongoServerClosedError',
      'MongoClientClosedError',
      'MongoOperationTimeoutError',
      'MongoNetworkTimeoutError',
      'MongoExpiredSessionError',
    ]);
    for (const e of real) {
      expect(isConnectionError(e), e.name).toBe(true);
      expect(isConnectionError(new Error('wrapped', { cause: e })), e.name).toBe(true);
    }
    // A refused write from the server is not a lost connection.
    expect(isConnectionError(new MongoServerError({ message: 'not authorized', code: 13 }))).toBe(
      false,
    );
  });

  test('ARCH-6 a write that fails because the connection went is reported as not saved and marks the connection lost', async () => {
    let lost = 0;
    const failing = guardHandler(
      'entry.update',
      (() => {
        throw Object.assign(new Error('Client must be connected'), {
          name: 'MongoNotConnectedError',
        });
      }) as never,
      { readOnly: () => false, lost: () => void lost++ },
    );
    await expect(Promise.resolve().then(() => failing({} as never))).rejects.toThrow(
      CONNECTION_LOST_MESSAGE,
    );
    expect(lost).toBe(1);
    // Any other failure passes through unchanged, and does not mark the connection.
    const invalid = guardHandler(
      'entry.update',
      (() => {
        throw new Error('The title is empty.');
      }) as never,
      { readOnly: () => false, lost: () => void lost++ },
    );
    await expect(Promise.resolve().then(() => invalid({} as never))).rejects.toThrow(
      'The title is empty.',
    );
    expect(lost).toBe(1);
    // A refusal from the read-only write path carries the reason.
    const ro = guardHandler(
      'search.query',
      (() => {
        throw new ReadOnlyError();
      }) as never,
      { readOnly: () => true, lost: () => undefined },
    );
    await expect(Promise.resolve().then(() => ro({} as never))).rejects.toThrow(READ_ONLY_REASON);
  });

  test('ARCH-6 every write channel names a real channel', () => {
    for (const c of WRITE_CHANNELS) expect(CHANNELS).toContain(c);
    for (const read of ['entry.get', 'entry.list', 'search.query', 'timeline.year', 'tree.get']) {
      expect(WRITE_CHANNELS as readonly string[]).not.toContain(read);
    }
  });

  test('ARCH-6 every renderer file that sends a write disables its controls while read-only', () => {
    // App.tsx creates bibles only from the form shown while MongoDB is connected.
    // sessions/common.tsx holds updateWithUndo, a helper whose callers (the manuscript
    // screen) disable the controls that reach it.
    const exempt = new Set(['App.tsx', 'common.tsx']);
    const writes = new RegExp(
      `['"](${WRITE_CHANNELS.map((c) => c.replace('.', '\\.')).join('|')})['"]`,
    );
    const missing: string[] = [];
    for (const file of files(RENDERER)) {
      const name = file.slice(RENDERER.length + 1);
      if (exempt.has(name.split('/').pop()!)) continue;
      const text = readFileSync(file, 'utf8');
      if (!/\b(call|invoke)\(/.test(text) || !writes.test(text)) continue;
      if (!/useWriteGuard|WriteFieldset|useReadOnly/.test(text)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test('ARCH-6 ST-1 the new messages and screens use no em dash', () => {
    for (const f of [
      'src/shared/ipcApp.ts',
      'src/main/connection.ts',
      'src/main/db/readOnly.ts',
      'src/main/ipc/offline.ts',
      'src/renderer/src/connection.tsx',
      'src/renderer/src/workspace/settings.tsx',
    ]) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toContain('—');
    }
  });
});
