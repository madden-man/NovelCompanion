import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { SCENE_VERSIONS_COLLECTION } from '../../src/shared/domain/sceneOutline';
import {
  BridgeDoc,
  BriefSettingsDoc,
  ClaudeInstructionsDoc,
  CommunityNotesDoc,
  NotebookTrayDoc,
  RomanizationDoc,
  SceneOutlineDoc,
  SceneVersionDoc,
  SnapshotSettingsDoc,
  TreeLayoutDoc,
} from '../../src/shared/metaDocs';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

/**
 * A58 (PH-20): what each setter stores parses with the schema the
 * fingerprint test keeps, so the fingerprint follows the stored shape.
 */
let store: Store;
let s: OpenBible;

beforeAll(async () => {
  store = await localStore();
  s = await openBibleSession(store, (await loadFixture(store, freshSlug('meta-docs'))).id);
});
afterAll(async () => {
  await store.close();
});

const stored = (id: string) => s.handle.collection('meta').findOne({ _id: id as never });

function strictly(schema: z.ZodType, doc: unknown) {
  const r = schema.safeParse(doc);
  expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
}

describe('PH-20 the meta documents and scene versions are stored in the shape their schemas say', () => {
  test('PH-20 each setter stores a document its schema parses strictly', async () => {
    const r = s.repo.list('characters')[0]!;
    await s.repo.setTreePositions({
      [r._id]: { x: 10, y: 20 },
      other: { x: 1, y: 2, loose: true },
    });
    strictly(TreeLayoutDoc, await stored('treeLayout'));

    await s.repo.setSceneOutline('- One', { breaks: { CH1: 0 }, years: { '0': 2040 } });
    await s.repo.setSceneOutline('- One\n- Two', { newVersion: true });
    strictly(SceneOutlineDoc, await stored('sceneOutline'));
    const versions = await s.handle.collection(SCENE_VERSIONS_COLLECTION).find().toArray();
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) strictly(SceneVersionDoc, v);

    await s.repo.setBriefSettings({ budget: 20_000 });
    strictly(BriefSettingsDoc, await stored('briefSettings'));

    const community = s.repo.list('culturalEntries')[0]?.communityId as string | undefined;
    await s.repo.setCommunityNote(community ?? 'portland', 'A note.');
    strictly(CommunityNotesDoc, await stored('communityNotes'));

    await s.repo.setTrayMarks(['k1', 'k2'], 'dismissed');
    strictly(NotebookTrayDoc, await stored('notebookTray'));

    await s.repo.setSnapshotKeep(12);
    strictly(SnapshotSettingsDoc, await stored('snapshotSettings'));

    await s.repo.setClaudeInstructions('capture', 'Be brief.');
    strictly(ClaudeInstructionsDoc, await stored('claudeInstructions'));

    await s.repo.markBridgeSince(1_700_000_000_000);
    await s.repo.noteBridgeQuestions(['Q1']);
    strictly(BridgeDoc, await stored('bridge'));

    const lang = (s.model.get('lists', 'languages') as unknown as { items: { id: string }[] })
      .items[0]!.id;
    await s.repo.setRomanization(lang, null);
    strictly(RomanizationDoc, await stored('romanization'));
  });
});
