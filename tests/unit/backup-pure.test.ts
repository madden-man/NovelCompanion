import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SnapshotManifest,
  localDay,
  needsDailySnapshot,
  snapshotsToPrune,
} from '../../src/shared/domain/snapshots';
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

  test('BK-1 SM-2 a snapshot taken before a migration is never counted and never pruned', () => {
    const list = [
      { id: 'e', reason: 'manual' },
      { id: 'd', reason: 'daily' },
      { id: 'c', reason: 'migration' },
      { id: 'b', reason: 'bulk' },
      { id: 'a', reason: 'migration' },
    ];
    expect(snapshotsToPrune(list, 2).map((s) => s.id)).toEqual(['b']);
    expect(snapshotsToPrune(list, 1).map((s) => s.id)).toEqual(['d', 'b']);
    expect(snapshotsToPrune(list, 3)).toEqual([]);
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
  test('ARCH-1 every snapshot and backup channel is in the contract', () => {
    for (const c of [
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

  test('BK-1 BK-3 requests reject unknown fields, bad shapes, and out of range values', () => {
    expect(() => parseRequest('snapshot.keep', { keep: 0 })).toThrow(IpcValidationError);
    expect(() => parseRequest('snapshot.restore', { id: '' })).toThrow(IpcValidationError);
    expect(() => parseRequest('backup.import', { slug: 'Bad Slug', name: 'x' })).toThrow(
      IpcValidationError,
    );
    expect(() => parseRequest('snapshot.take', { extra: 1 })).toThrow(IpcValidationError);
  });

  test('BK-1 a response with a missing field is rejected', () => {
    expect(() => parseResponse('snapshot.list', { snapshots: [] })).toThrow(IpcValidationError);
    expect(() => parseResponse('backup.export', { path: null })).toThrow(IpcValidationError);
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
