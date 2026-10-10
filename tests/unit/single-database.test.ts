import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DATABASE_NAME } from '../../src/main/db/connection';

const ROOT = join(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

const DB_DIR = join(ROOT, 'src/main/db');
const MAIN_DIR = join(ROOT, 'src/main');

describe('ARCH-8 the app uses only the novel_companion database', () => {
  test('ARCH-8 the database name is novel_companion', () => {
    expect(DATABASE_NAME).toBe('novel_companion');
  });

  test('ARCH-8 src/main/db never calls listDatabases, admin(), or db() with any other name', () => {
    const files = sourceFiles(DB_DIR);
    expect(files.length).toBeGreaterThan(5);
    const problems: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = relative(ROOT, f);
      if (/listDatabases/.test(text)) problems.push(`${rel}: listDatabases`);
      if (/\.admin\s*\(/.test(text)) problems.push(`${rel}: admin()`);
      for (const m of text.matchAll(/\.db\s*\(([^)]*)\)/g)) {
        const arg = (m[1] ?? '').trim();
        if (arg !== "'novel_companion'" && arg !== 'DATABASE_NAME') {
          problems.push(`${rel}: .db(${arg})`);
        }
      }
    }
    expect(problems).toEqual([]);
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
