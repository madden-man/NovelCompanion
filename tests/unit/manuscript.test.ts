import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lineDiff, manuscriptChange, manuscriptLines } from '../../src/shared/domain/manuscript';
import { parseLocator } from '../../src/main/session/sources';

const ROOT = join(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('MS-1 MS-4 manuscript text and the re-import diff', () => {
  test('MS-1 the stored text keeps scene breaks and paragraphs as lines', () => {
    expect(manuscriptLines('<h1>The Letter</h1><p>One <em>two</em>.</p><hr><p>Three.</p>')).toEqual(
      ['The Letter', 'One two.', '* * *', 'Three.'],
    );
  });

  test('MS-4 the line diff marks removed and added lines with their line numbers', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
      { kind: 'same', text: 'a', line: 1 },
      { kind: 'removed', text: 'b', line: 2 },
      { kind: 'added', text: 'x', line: 2 },
      { kind: 'same', text: 'c', line: 3 },
      { kind: 'added', text: 'd', line: 4 },
    ]);
    expect(lineDiff([], [])).toEqual([]);
  });

  test('MS-4 a changed text with a summary marks the summary as possibly out of date; no summary or no change does not', () => {
    const ch = { manuscriptText: '<p>One.</p>', summary: 'A summary.' };
    expect(manuscriptChange(ch, '<p>One.</p>')).toMatchObject({
      changed: false,
      summaryOutOfDate: false,
    });
    expect(manuscriptChange(ch, '<p>Two.</p>')).toMatchObject({
      changed: true,
      added: 1,
      removed: 1,
      summaryOutOfDate: true,
    });
    expect(manuscriptChange({ ...ch, summary: '' }, '<p>Two.</p>').summaryOutOfDate).toBe(false);
    expect(manuscriptChange({ summary: 'S' }, '<p>First import.</p>').summaryOutOfDate).toBe(false);
    // Once marked, it stays marked until a new summary is approved.
    expect(
      manuscriptChange({ ...ch, summaryOutOfDate: true }, '<p>One.</p>').summaryOutOfDate,
    ).toBe(true);
  });

  test('MS-1 a stored source names where the chapter is read from', () => {
    expect(parseLocator('word:/Users/t/Chapter 3.docx')).toEqual({
      sourceId: 'word',
      locator: '/Users/t/Chapter 3.docx',
    });
    expect(parseLocator('')).toBeNull();
  });
});

describe('MS-5 the app never writes to a manuscript', () => {
  test('MS-5 a manuscript source can only pick and read', () => {
    const src = readFileSync(join(ROOT, 'src/main/session/sources.ts'), 'utf8');
    const iface = /export interface ManuscriptSource \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const members = [...iface.matchAll(/^\s{2}(\w+)[(:?]/gm)].map((m) => m[1]);
    expect(members).toEqual(['id', 'label', 'pick', 'read']);
  });

  test("MS-5 every file write in the main process is a backup, an export, or the app's own settings files", () => {
    const writers = sourceFiles(join(ROOT, 'src'))
      .filter((f) =>
        /\b(writeFile|writeFileSync|createWriteStream|appendFile|copyFile)\b/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative(ROOT, f))
      .sort();
    expect(writers).toEqual([
      // ST-1: the appearance setting, in app-settings.json in the app's data folder.
      'src/main/appSettings.ts',
      'src/main/backup/snapshots.ts',
      // The Claude settings file in the app's data folder (models, AI-6 confirmations).
      'src/main/claude/settings.ts',
      'src/main/ipc/backupHandlers.ts',
      'src/main/ipc/exportTree.ts',
    ]);
    // The backup handlers write only to the path the export dialog returned.
    const backup = readFileSync(join(ROOT, 'src/main/ipc/backupHandlers.ts'), 'utf8');
    const targets = [...backup.matchAll(/writeFile\((\w+)/g)].map((m) => m[1]);
    expect(new Set(targets)).toEqual(new Set(['path']));
    expect(backup).toMatch(/const path = await deps\.pickSavePath\?\./);
    // The Claude settings store (M6) writes only its own JSON file, through a temporary beside it.
    const settings = readFileSync(join(ROOT, 'src/main/claude/settings.ts'), 'utf8');
    expect([...settings.matchAll(/writeFileSync\((\w+)/g)].map((m) => m[1])).toEqual(['tmp']);
    expect(settings).toMatch(/const tmp = `\$\{this\.path\}\.tmp`;/);
  });

  test('MS-5 nothing calls a Google Docs or Drive write method', () => {
    const offenders = sourceFiles(join(ROOT, 'src')).filter((f) =>
      /documents\.(batchUpdate|create)|files\.(update|delete)\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
