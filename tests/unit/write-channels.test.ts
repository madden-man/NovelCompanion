import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { WRITE_CHANNELS } from '../../src/shared/ipcApp';
import { handlerWrites } from '../helpers/writeReach';

const MAIN = join(import.meta.dirname, '../../src/main');

/**
 * Write channels the static walk cannot see writing the bible, each with why
 * it is still refused on a read-only snapshot.
 */
const WRITES_OUTSIDE_THE_WALK: Record<string, string> = {
  'snapshot.take':
    'Writes a new snapshot folder on this Mac and prunes old ones; a read-only snapshot has nothing new to keep.',
  'chapter.summarize':
    'Runs Claude through the session Claude seam (an interface), which saves the run in the bible.',
};

/**
 * Handlers that reach a write but are not write channels, each with why.
 * The app channels open the bible from MongoDB, which is what ends read-only
 * mode, so they never write to a snapshot.
 */
const READS_THAT_WRITE: Record<string, string> = {
  'bible.open': 'Opens a bible from MongoDB (migrations run there), never a snapshot.',
  'connection.retry': 'Reopens the bible from MongoDB once it answers, which ends read-only mode.',
  'mongo.replace': 'Reopens the bible on the new connection, never a snapshot.',
};

describe('ARCH-6 the write channel list matches the handlers that write', () => {
  const reach = handlerWrites(MAIN);
  const listed = new Set<string>(WRITE_CHANNELS);

  test('ARCH-6 the static walk finds the handlers', () => {
    expect(reach.size).toBeGreaterThan(100);
    expect(reach.get('entry.update')).toBe('Repository.update');
    expect(reach.get('claude.alignment')).toBe('ClaudeRuntime.runFeature');
    expect(reach.get('entry.get')).toBeNull();
  });

  test('ARCH-6 every handler that reaches a repository write or a Claude run is a write channel', () => {
    const missing = [...reach]
      .filter(([ch, why]) => why && !listed.has(ch) && !(ch in READS_THAT_WRITE))
      .map(([ch, why]) => `${ch}: ${why}`);
    expect(missing).toEqual([]);
  });

  test('ARCH-6 every write channel reaches a write', () => {
    const idle = WRITE_CHANNELS.filter((ch) => !reach.get(ch) && !(ch in WRITES_OUTSIDE_THE_WALK));
    expect(idle).toEqual([]);
    // The exceptions stay true: each is listed, and the walk still cannot see it.
    for (const ch of Object.keys(WRITES_OUTSIDE_THE_WALK)) {
      expect(listed.has(ch), ch).toBe(true);
      expect(reach.get(ch), ch).toBeNull();
    }
    for (const ch of Object.keys(READS_THAT_WRITE)) {
      expect(listed.has(ch), ch).toBe(false);
      expect(reach.get(ch), ch).toBeTruthy();
    }
  });

  test('ARCH-6 the alignment check channels are write channels', () => {
    for (const ch of ['continuity.check', 'continuity.resolve', 'claude.alignment']) {
      expect(listed.has(ch), ch).toBe(true);
    }
    expect(listed.has('backup.export')).toBe(false);
  });
});
