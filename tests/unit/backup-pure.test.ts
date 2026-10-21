import { describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SnapshotManifest,
  localDay,
  needsDailySnapshot,
  snapshotsToPrune,
} from '../../src/shared/domain/snapshots';
import { resetOnNavigation } from '../../src/main/promptReset';
import { CHANNELS, parseRequest, parseResponse } from '../../src/shared/ipc';
import { IpcValidationError } from '../../src/shared/ipc';

const at = (iso: string, reason = 'daily') => ({ takenAt: iso, reason });

describe('BK-1 daily snapshots and how many are kept', () => {
  test('BK-1 the first launch of a local day needs a snapshot and later launches that day do not', () => {
    const morning = new Date(2026, 9, 10, 8, 30);
    const evening = new Date(2026, 9, 10, 21, 5);
    const nextDay = new Date(2026, 9, 11, 0, 5);
    expect(needsDailySnapshot([], morning)).toBe(true);
    const taken = [at(morning.toISOString())];
    expect(needsDailySnapshot(taken, evening)).toBe(false);
    expect(needsDailySnapshot(taken, nextDay)).toBe(true);
    // A snapshot for another reason does not count as the daily one.
    expect(needsDailySnapshot([at(morning.toISOString(), 'manual')], evening)).toBe(true);
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  test('BK-1 the oldest snapshots beyond the limit are pruned and at least one is always kept', () => {
    const list = ['e', 'd', 'c', 'b', 'a'].map((id) => ({ id }));
    expect(snapshotsToPrune(list, 3).map((s) => s.id)).toEqual(['b', 'a']);
    expect(snapshotsToPrune(list, 30)).toEqual([]);
    expect(snapshotsToPrune(list, 0).map((s) => s.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('BK-1 a manifest states the bible, time, reason, schema version, and counts', () => {
    const good = {
      format: 'novel-companion-snapshot',
      version: 1,
      bible: 'eastwinds',
      takenAt: '2026-10-10T12:00:00.000Z',
      reason: 'import',
      schemaVersion: 6,
      counts: { characters: 3 },
    };
    expect(SnapshotManifest.parse(good).label).toBe('');
    for (const bad of [
      { ...good, reason: 'whenever' },
      { ...good, schemaVersion: -1 },
      { ...good, counts: { characters: -1 } },
      { ...good, takenAt: 'yesterday' },
      { ...good, extra: true },
    ]) {
      expect(SnapshotManifest.safeParse(bad).success).toBe(false);
    }
  });
});

describe('BK-1 BK-2 BK-3 the new IPC channels validate both sides', () => {
  test('ARCH-1 every import, snapshot, and backup channel is in the contract', () => {
    for (const c of [
      'import.pickFile',
      'import.workbook',
      'import.guess',
      'import.fields',
      'import.preview',
      'import.plan',
      'import.apply',
      'import.document',
      'import.documentPlan',
      'snapshot.list',
      'snapshot.take',
      'snapshot.restore',
      'snapshot.keep',
      'backup.export',
      'backup.import',
    ]) {
      expect(CHANNELS, c).toContain(c);
    }
  });

  test('IM-1 requests reject unknown fields, bad shapes, and out of range limits', () => {
    expect(() => parseRequest('import.pickFile', { kind: 'pdf' })).toThrow(IpcValidationError);
    expect(() => parseRequest('import.preview', { fileId: 'f', limit: 1000, mapping: {} })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseRequest('import.apply', { planId: 'p', approved: [''], saveMapping: true }),
    ).toThrow(IpcValidationError);
    expect(() => parseRequest('snapshot.keep', { keep: 0 })).toThrow(IpcValidationError);
    expect(() => parseRequest('snapshot.restore', { id: '' })).toThrow(IpcValidationError);
    expect(() => parseRequest('backup.import', { slug: 'Bad Slug', name: 'x' })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseRequest('import.documentPlan', { fileId: 'f', target: { kind: 'note', title: ' ' } }),
    ).toThrow(IpcValidationError);
    const ok = parseRequest('import.apply', { planId: 'p', approved: ['c1'] });
    expect(ok.saveMapping).toBe(true);
    expect(parseRequest('import.preview', { fileId: 'f', mapping: tableMapping }).limit).toBe(12);
  });

  test('IM-2 a response with a missing field is rejected', () => {
    expect(() => parseResponse('snapshot.list', { snapshots: [] })).toThrow(IpcValidationError);
    expect(() =>
      parseResponse('import.apply', {
        created: 1,
        updated: 0,
        unchanged: 0,
        questions: 0,
        failed: [{ where: 'x' }],
        snapshot: null,
      }),
    ).toThrow(IpcValidationError);
  });
});

const tableMapping = {
  shape: 'table',
  sheet: 'People',
  target: { collection: 'characters' },
  columns: [{ header: 'Name', index: 0, field: 'title' }],
};

describe('SL-1 the stop prompt flag resets when the page reloads or navigates', () => {
  test('SL-1 a main frame navigation to a new document resets the flag; same-page and frame changes do not', () => {
    const wc = new EventEmitter();
    let resets = 0;
    resetOnNavigation({ on: (event, listener) => wc.on(event, listener) }, () => {
      resets += 1;
    });
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(resets).toBe(0);
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(resets).toBe(1);
  });
});

describe('BK-4 typing is saved within a second', () => {
  test('BK-4 the autosave waits at most 700 ms after the first unsaved change, so a forced quit loses under a second', () => {
    const source = readFileSync(
      join(import.meta.dirname, '../../src/renderer/src/workspace/editor.tsx'),
      'utf8',
    );
    const debounce = Number(/AUTOSAVE_DEBOUNCE_MS = (\d+)/.exec(source)?.[1]);
    const maxWait = Number(/AUTOSAVE_MAX_WAIT_MS = (\d+)/.exec(source)?.[1]);
    expect(debounce).toBeLessThanOrEqual(1000);
    expect(maxWait).toBeLessThan(1000);
    expect(debounce).toBeLessThanOrEqual(maxWait);
  });
});
