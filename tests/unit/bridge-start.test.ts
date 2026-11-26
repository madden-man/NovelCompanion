import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { handlerWrites } from '../helpers/writeReach';

const MAIN = join(import.meta.dirname, '../../src/main');

describe('NB-1 NB-3 the bridge runs only for a bible opened from MongoDB', () => {
  const reach = handlerWrites(MAIN);

  test('NB-1 NB-3 opening a snapshot read-only never starts the bridge: nothing it reaches writes', () => {
    // BridgeService.start publishes (driver writes, markBridgeSince) and pulls (applyNotebook),
    // all of which this walk counts as writes; an earlier build that started the bridge in
    // adopt() made this channel reach them.
    expect(reach.get('connection.openSnapshot')).toBeNull();
    expect(reach.get('connection.openSnapshot')).not.toBeUndefined();
  });
});
