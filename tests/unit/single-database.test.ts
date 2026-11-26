import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Db } from 'mongodb';
import {
  BRIDGE_DATABASE_NAME,
  BRIDGE_REACH,
  DATABASE_NAME,
  bridgeDatabaseFor,
  bridgeHandle,
} from '../../src/main/db/connection';

const ROOT = join(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

const DB_DIR = join(ROOT, 'src/main/db');
const MAIN_DIR = join(ROOT, 'src/main');

describe('ARCH-8 the app uses only novel_companion, and flowstate_bridge through the bridge handle', () => {
  test('ARCH-8 the database name is novel_companion', () => {
    expect(DATABASE_NAME).toBe('novel_companion');
  });

  test('ARCH-8 src/main/db never calls listDatabases, admin(), or db() with any other name', () => {
    const files = sourceFiles(DB_DIR);
    expect(files.length).toBeGreaterThan(5);
    const problems: string[] = [];
    let calls = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = relative(ROOT, f);
      if (/listDatabases/.test(text)) problems.push(`${rel}: listDatabases`);
      if (/\.admin\s*\(/.test(text)) problems.push(`${rel}: admin()`);
      for (const m of text.matchAll(/\.db\s*\(([^)]*)\)/g)) {
        calls += 1;
        const arg = (m[1] ?? '').trim();
        // `database` is the end-to-end test seam's name (testDatabaseName in secrets.ts), null otherwise.
        // A56: the bridge handle's database, flowstate_bridge (or the test seam's name with _bridge).
        const allowed = [
          "'novel_companion'",
          'DATABASE_NAME',
          'database ?? DATABASE_NAME',
          'bridgeDatabaseFor(database', // the pattern stops at the first closing bracket
        ];
        if (!allowed.includes(arg)) {
          problems.push(`${rel}: .db(${arg})`);
        }
      }
    }
    expect(problems).toEqual([]);
    // One place selects the databases: connect() in connection.ts, the app's own and the bridge's.
    expect(calls).toBe(2);
  });

  test('ARCH-8 the rest of the main process has no other database access', () => {
    const outside = sourceFiles(MAIN_DIR).filter((f) => !f.startsWith(DB_DIR));
    const hits = outside
      .filter((f) =>
        /listDatabases|\.admin\s*\(|\.db\s*\(|new MongoClient/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  test('ARCH-8 the check catches a forbidden call', () => {
    const pattern = /\.db\s*\(([^)]*)\)/g;
    const args = [
      ...'client.db(name); client.db("other"); client.db(DATABASE_NAME)'.matchAll(pattern),
    ].map((m) => m[1]);
    expect(args).toEqual(['name', '"other"', 'DATABASE_NAME']);
  });
});

describe('ARCH-8 A56 the bridge handle reaches flowstate_bridge and its three collections, nothing else', () => {
  test('ARCH-8 the bridge database is flowstate_bridge, or the test seam name with _bridge', () => {
    expect(BRIDGE_DATABASE_NAME).toBe('flowstate_bridge');
    expect(bridgeDatabaseFor(null)).toBe('flowstate_bridge');
    expect(bridgeDatabaseFor('e2e-notebook')).toBe('e2e-notebook_bridge');
    expect(BRIDGE_REACH).toEqual(['bridge_worlds', 'bridge_down', 'bridge_up']);
  });

  test('ARCH-8 the handle opens only the three bridge collections and exposes no database, client or admin', () => {
    const opened: string[] = [];
    const fake = {
      databaseName: 'flowstate_bridge',
      collection: (n: string) => {
        opened.push(n);
        return { name: n };
      },
    } as unknown as Db;
    const h = bridgeHandle(fake);
    expect(Object.keys(h).sort()).toEqual(['collection', 'databaseName']);
    for (const n of BRIDGE_REACH) h.collection(n);
    for (const bad of ['bridge_clips', 'bibles', 'eastwinds.characters', 'system.users']) {
      expect(() => h.collection(bad as never)).toThrow(/reaches only/);
    }
    expect(opened).toEqual([...BRIDGE_REACH]);
  });

  test('ARCH-8 the bridge code takes the handle, never a Db, a client or a database name', () => {
    const files = [
      join(ROOT, 'src/main/db/bridge.ts'),
      ...sourceFiles(join(ROOT, 'src/main/bridge')),
    ];
    const hits = files
      .filter((f) =>
        /\.db\s*\(|\bclient\b|\bDb\b|listDatabases|\.admin\s*\(|bridge_clips|BRIDGE_CLIPS/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
