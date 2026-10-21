import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { ENTRY_COLLECTIONS, editableFields, manifests } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { t5Verify, t5Write } from '../helpers/t5';
import type { T5Plan } from '../helpers/t5';

let store: Store;
let slug: string;
let plan: T5Plan;

beforeAll(async () => {
  store = await localStore();
  slug = freshSlug('t5');
  await createBible(store, slug, 'T-5 coverage');
});
afterAll(async () => {
  await store.close();
});

describe('T-5 editing coverage through the IPC layer', () => {
  test('T-5 every field of every entity is set to a new value through the IPC handlers', async () => {
    const bible: OpenBible = await openBibleSession(store, slug);
    plan = await t5Write(ipcFor(() => bible));
    expect(plan.problems).toEqual([]);
    // Coverage by construction: the plan holds every collection and every editable field.
    expect(plan.items.map((i) => i.collection).sort()).toEqual([...ENTRY_COLLECTIONS].sort());
    const total = plan.items.reduce((n, i) => n + i.fields.length, 0);
    expect(total).toBeGreaterThan(200);
    for (const item of plan.items) {
      expect(item.fields).toEqual(editableFields(manifests[item.collection]).map((s) => s.name));
    }
  });

  test('T-5 SM-3 the walk reaches every manifest the cut model keeps: moments, questions, log, briefs, places, glossary, culture', () => {
    const m4 = [
      'moments',
      'openQuestions',
      'sessionLogs',
      'briefs',
      'places',
      'glossaryTerms',
      'culturalEntries',
    ] as const;
    for (const c of m4) {
      const item = plan.items.find((i) => i.collection === c);
      expect(item, `${c} is in the T-5 plan`).toBeDefined();
      expect(item!.fields.length).toBeGreaterThan(0);
      for (const name of item!.fields) expect(item!.expected).toHaveProperty(name);
    }
    // Nested fields are walked too: chapter strands and place descriptions.
    const expected = (c: string) => plan.items.find((i) => i.collection === c)!.expected;
    expect(expected('chapters').strands).toHaveLength(1);
    expect(expected('places').descriptions).toHaveLength(1);
    // SM-3: a moment is written with every field, its character and years included.
    expect(expected('moments')).toMatchObject({ year: 2061, endYear: 2071 });
  });

  test('T-5 every value persists when the bible is reopened on a fresh connection', async () => {
    // A new client, a new read model loaded from MongoDB, and a new search index.
    const fresh = await localStore();
    try {
      const reopened = await openBibleSession(fresh, slug);
      expect(
        await t5Verify(
          ipcFor(() => reopened),
          plan,
        ),
      ).toEqual([]);
      // The check has teeth: a value that did not persist is reported.
      const tampered: T5Plan = {
        ...plan,
        items: plan.items.map((i) =>
          i.collection === 'characters'
            ? { ...i, expected: { ...i.expected, backstory: 'Elsewhere' } }
            : i,
        ),
      };
      expect(
        await t5Verify(
          ipcFor(() => reopened),
          tampered,
        ),
      ).toEqual([expect.stringMatching(/^characters\.backstory: expected "Elsewhere"/)]);
    } finally {
      await fresh.close();
    }
  });
});
