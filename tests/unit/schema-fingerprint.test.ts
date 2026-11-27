import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations';
import {
  BibleSettings,
  NOTEBOOK_COLLECTION,
  NotebookPage,
  configSchemas,
  entrySchemas,
} from '../../src/shared/schema';
import { ClaudeRun } from '../../src/shared/claude';
import { RevDoc } from '../../src/shared/freshness';
import { PhoneWaitsDoc } from '../../src/shared/phoneWaits';
import { StoryTimeValue } from '../../src/shared/storyTime';

/**
 * A58 (PH-20): every stored document shape, by where it is stored. A change
 * to any of them comes with a new schema version (a migration, empty if need
 * be), so a side that lags sees a version mismatch instead of a strict zod
 * failure ("Unrecognized keys", 2026-10-11). A new stored shape joins this list.
 */
const STORED: Record<string, z.ZodType> = {
  ...Object.fromEntries(Object.entries(entrySchemas)),
  ...Object.fromEntries(Object.entries(configSchemas)),
  [NOTEBOOK_COLLECTION]: NotebookPage,
  conversations: ClaudeRun,
  'meta.bibleSettings': BibleSettings,
  'meta.storyTime': StoryTimeValue,
  'meta.rev': RevDoc,
  'meta.phoneWaits': PhoneWaitsDoc,
};

/**
 * The fingerprint of every stored shape at each schema version, from 16 on
 * (the first one kept). When a shape changes: add a migration, then add the
 * new version here with the fingerprints the failure prints. Never edit a
 * version already here.
 */
const FINGERPRINTS: Record<number, Record<string, string>> = {
  16: {
    chapters: '86afcca688359b72',
    characters: 'bd99affa55e39f7a',
    conversations: '16d974f55e90985c',
    culturalEntries: 'c974120697f028c7',
    eraStates: 'a186008ee4897f03',
    families: '839cea5615d63149',
    findings: 'e86495d5de806c25',
    glossaryTerms: '03e45c6b3316c691',
    lists: '437468a4ea75172f',
    'meta.bibleSettings': 'd638ed4b72dcdf85',
    'meta.rev': '9038fea824b8de8a',
    'meta.storyTime': 'a34d0baa30af658b',
    moments: 'c4f7a13f9501d1c8',
    notebookPages: '00fd55d9ba0f9466',
    openQuestions: '72c01837d43fe3d7',
    parentLinks: 'af73207a6209e6ae',
    parts: 'f187fc3e1fbb864a',
    places: '8e51e25630fccc59',
    proposals: '68fa78d42a525b46',
    unions: '3547bef526b1aade',
    worldEvents: 'a70a2ea87ac6e11c',
  },

  // A58 U5: the sentences that wait for the desk (`meta.phoneWaits`).
  17: {
    chapters: '86afcca688359b72',
    characters: 'bd99affa55e39f7a',
    conversations: '16d974f55e90985c',
    culturalEntries: 'c974120697f028c7',
    eraStates: 'a186008ee4897f03',
    families: '839cea5615d63149',
    findings: 'e86495d5de806c25',
    glossaryTerms: '03e45c6b3316c691',
    lists: '437468a4ea75172f',
    'meta.bibleSettings': 'd638ed4b72dcdf85',
    'meta.phoneWaits': 'f346454595119202',
    'meta.rev': '9038fea824b8de8a',
    'meta.storyTime': 'a34d0baa30af658b',
    moments: 'c4f7a13f9501d1c8',
    notebookPages: '00fd55d9ba0f9466',
    openQuestions: '72c01837d43fe3d7',
    parentLinks: 'af73207a6209e6ae',
    parts: 'f187fc3e1fbb864a',
    places: '8e51e25630fccc59',
    proposals: '68fa78d42a525b46',
    unions: '3547bef526b1aade',
    worldEvents: 'a70a2ea87ac6e11c',
  },
};

function fingerprint(schema: z.ZodType): string {
  const json = JSON.stringify(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

const now = (): Record<string, string> =>
  Object.fromEntries(
    Object.keys(STORED)
      .sort()
      .map((name) => [name, fingerprint(STORED[name] as z.ZodType)]),
  );

describe('PH-20 a stored shape change raises the schema version', () => {
  test('PH-20 every schema version from 16 on keeps its fingerprints', () => {
    for (let v = 16; v <= LATEST_SCHEMA_VERSION; v++) {
      expect(FINGERPRINTS[v], `fingerprints for schema version ${v}`).toBeDefined();
    }
    expect(Math.max(...Object.keys(FINGERPRINTS).map(Number))).toBe(LATEST_SCHEMA_VERSION);
  });

  test('PH-20 the stored shapes are the ones recorded for the current schema version', () => {
    const recorded = FINGERPRINTS[LATEST_SCHEMA_VERSION] ?? {};
    const current = now();
    const changed = Object.keys({ ...recorded, ...current })
      .filter((name) => recorded[name] !== current[name])
      .sort();
    // On a failure: a stored shape changed without a new schema version. Add a migration
    // (empty if need be) and record `current` under the new version.
    expect(changed, JSON.stringify(current, null, 2)).toEqual([]);
  });

  test('PH-20 the fingerprint moves when a shape gains a field', () => {
    const base = z.strictObject({ _id: z.string(), name: z.string() });
    expect(fingerprint(base)).not.toBe(fingerprint(base.extend({ rev: z.int() })));
    expect(fingerprint(base)).toBe(
      fingerprint(z.strictObject({ _id: z.string(), name: z.string() })),
    );
  });
});
