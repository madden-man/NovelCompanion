import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ConnectionManager } from '../../src/main/connection';
import { MemoryMongoUriStore } from '../../src/main/secrets';
import { uniqueSlug } from '../../src/renderer/src/bibleSlug';

const manager = (file: string) =>
  new ConnectionManager({
    uris: new MemoryMongoUriStore(null),
    localOnly: true,
    missingMessage: 'none',
    snapshotRoot: join(tmpdir(), 'nc-unit-none'),
    lastBibleFile: file,
    connect: () => Promise.reject(new Error('not under test')),
  });

describe('A57 opening the app', () => {
  test('A57 a new bible gets its ID from its name, never one already taken', () => {
    expect(uniqueSlug('East Winds', [])).toBe('east-winds');
    expect(uniqueSlug('East Winds', ['east-winds'])).toBe('east-winds-2');
    expect(uniqueSlug('East Winds', ['east-winds', 'east-winds-2'])).toBe('east-winds-3');
    expect(uniqueSlug('晓曦', [])).toBe('bible');
    expect(uniqueSlug('晓曦', ['bible'])).toBe('bible-2');
    expect(uniqueSlug('Bibles', [])).toBe('bibles-2');
    const long = 'x'.repeat(60);
    expect(uniqueSlug(long, ['x'.repeat(40)])).toBe(`${'x'.repeat(38)}-2`);
  });

  test('A57 the bible opened last is kept in the data folder for the next launch', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nc-unit-last-')), 'last-bible.json');
    expect(manager(file).lastBible).toBeNull();
    manager(file).remember('tide-lines');
    expect(manager(file).lastBible).toBe('tide-lines');
    manager(file).remember(null);
    expect(manager(file).lastBible).toBeNull();
    writeFileSync(file, 'not json');
    expect(manager(file).lastBible).toBeNull();
    writeFileSync(file, JSON.stringify({ bible: 'Bad.ID' }));
    expect(manager(file).lastBible).toBeNull();
  });
});
