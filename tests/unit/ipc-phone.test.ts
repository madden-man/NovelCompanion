import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc';
import { claudeContract } from '../../src/shared/claude';
import {
  CHANNEL_REACH,
  DESK_CHANNELS,
  PHONE_CHANNELS,
  isPhoneChannel,
} from '../../src/shared/ipcPhone';
import { bearerKey, keyMatches } from '../../src/server/rpc';

const ROOT = join(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.m?tsx?$/.test(name) ? [p] : [];
  });
}

describe('PH-3 every channel of the contract is marked phone or desk', () => {
  test('PH-3 the walk finds a mark for every channel, and no mark for a channel that is not in the contract', () => {
    const unmarked = CHANNELS.filter((c) => !Object.hasOwn(CHANNEL_REACH, c));
    expect(unmarked).toEqual([]);
    const unknown = Object.keys(CHANNEL_REACH).filter((c) => !(CHANNELS as string[]).includes(c));
    expect(unknown).toEqual([]);
    for (const c of CHANNELS) expect(['phone', 'desk'], c).toContain(CHANNEL_REACH[c]);
    expect([...PHONE_CHANNELS, ...DESK_CHANNELS].sort()).toEqual([...CHANNELS].sort());
  });

  test('PH-3 the walk fails on a channel with no mark', () => {
    const contract = [...CHANNELS, 'new.channel'];
    expect(contract.filter((c) => !Object.hasOwn(CHANNEL_REACH, c))).toEqual(['new.channel']);
    expect(isPhoneChannel('new.channel')).toBe(false);
  });

  test('PH-3 the desk-only channels the spec names are desk', () => {
    const named = CHANNELS.filter(
      (c) =>
        c.startsWith('connection.') ||
        c.startsWith('mongo.') ||
        c.startsWith('backup.') ||
        c.startsWith('test.') ||
        c.startsWith('manuscript.') ||
        c in claudeContract,
    );
    expect(named.length).toBeGreaterThan(25);
    for (const c of [
      ...named,
      'bible.create',
      'snapshot.take',
      'snapshot.restore',
      'tree.export',
      'chapter.summarize',
    ] as const) {
      expect(CHANNEL_REACH[c], c).toBe('desk');
    }
  });

  test('PH-3 reading and editing the bible are phone channels', () => {
    for (const c of [
      'bible.list',
      'bible.open',
      'bible.current',
      'entry.list',
      'entry.get',
      'entry.update',
      'entry.create',
      'search.query',
      'tree.get',
      'outline.get',
      'storyTime.set',
    ] as const) {
      expect(isPhoneChannel(c), c).toBe(true);
    }
  });
});

describe('PH-14 the phone key', () => {
  test('PH-14 the right key matches, a wrong key, a shorter key or none does not', () => {
    expect(keyMatches('k3y-abc', 'k3y-abc')).toBe(true);
    expect(keyMatches('k3y-abc', ' k3y-abc\n')).toBe(true);
    expect(keyMatches('k3y-abd', 'k3y-abc')).toBe(false);
    expect(keyMatches('k3y', 'k3y-abc')).toBe(false);
    expect(keyMatches(null, 'k3y-abc')).toBe(false);
    expect(keyMatches('', 'k3y-abc')).toBe(false);
  });

  test('PH-14 with no key set, no key matches, not even an empty one', () => {
    expect(keyMatches('anything', undefined)).toBe(false);
    expect(keyMatches('', undefined)).toBe(false);
    expect(keyMatches(null, undefined)).toBe(false);
    expect(keyMatches('', '   ')).toBe(false);
  });

  test('PH-14 the keys are compared in constant time over their digests', () => {
    const text = readFileSync(join(ROOT, 'src/server/rpc.ts'), 'utf8');
    const body = text.slice(text.indexOf('export function keyMatches'));
    expect(body).toMatch(/timingSafeEqual\(digest\(/);
    expect(body).toMatch(/createHash\('sha256'\)/);
  });

  test('PH-14 the key is read from Authorization: Bearer', () => {
    const req = (v?: string) =>
      new Request('http://x/rpc', v ? { headers: { Authorization: v } } : {});
    expect(bearerKey(req('Bearer abc123'))).toBe('abc123');
    expect(bearerKey(req('Basic abc123'))).toBeNull();
    expect(bearerKey(req('Bearer'))).toBeNull();
    expect(bearerKey(req())).toBeNull();
  });
});

describe('PH-2 what the function bundle holds', () => {
  test('PH-2 the bundle of netlify/functions/rpc.mts holds no Electron, keyring or Agent SDK', async () => {
    const result = await build({
      entryPoints: [join(ROOT, 'netlify/functions/rpc.mts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const files = Object.keys(result.metafile.inputs);
    expect(files.some((f) => f.endsWith('src/server/rpc.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('src/main/ipc/handlers.ts'))).toBe(true);
    const imported = Object.values(result.metafile.inputs).flatMap((i) =>
      i.imports.map((m) => m.path),
    );
    expect(imported).toContain('mongodb');
    const banned = imported.filter((p) =>
      ['electron', '@napi-rs/keyring', '@anthropic-ai/claude-agent-sdk'].some(
        (b) => p === b || p.startsWith(`${b}/`),
      ),
    );
    expect(banned).toEqual([]);
    for (const host of ['src/main/host/electron.ts', 'src/main/secrets.ts']) {
      expect(files.some((f) => f.endsWith(host)), host).toBe(false);
    }
  });
});

describe('ARCH-8 the function uses only novel_companion', () => {
  test('ARCH-8 src/server and netlify select no database and make no client of their own', () => {
    const files = [...sourceFiles(join(ROOT, 'src/server')), ...sourceFiles(join(ROOT, 'netlify'))];
    expect(files.length).toBeGreaterThan(3);
    const hits = files
      .filter((f) =>
        /listDatabases|\.admin\s*\(|\.db\s*\(|new MongoClient/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
