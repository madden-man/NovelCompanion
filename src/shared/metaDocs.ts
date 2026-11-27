import { z } from 'zod';
import { BRIDGE_META_ID } from './bridge';
import { SCENE_OUTLINE_ID } from './domain/sceneOutline';
import { ROMANIZATION_META_ID } from './domain/romanization';

/**
 * A58 (PH-20): the stored shape of each `meta` document the repository writes
 * without a zod schema of its own, and of a saved scene outline version.
 * These describe what is stored and change nothing about it: the repository
 * still writes the same documents, `tests/integration/meta-docs.test.ts`
 * checks that what each setter stores parses here, and
 * `tests/unit/schema-fingerprint.test.ts` fingerprints them, so a change to
 * any of them comes with a new schema version.
 */

/** SM-5: a chapter's first line in the outline, by chapter ID. */
const SceneBreaks = z.record(z.string(), z.int().min(0));
/** SM-5: a scene's story year, by the 0-based line of its bullet. */
const SceneYears = z.record(z.string(), z.int());

/** FT-10: the family tree's stored positions (`treeLayout`). */
export const TreeLayoutDoc = z.strictObject({
  _id: z.literal('treeLayout'),
  positions: z.record(
    z.string(),
    z.strictObject({ x: z.number(), y: z.number(), loose: z.boolean().optional() }),
  ),
});

/** PL-5, SM-5: the scene outline (`sceneOutline`). */
export const SceneOutlineDoc = z.strictObject({
  _id: z.literal(SCENE_OUTLINE_ID),
  text: z.string(),
  breaks: SceneBreaks,
  years: SceneYears,
  modifiedAt: z.string(),
});

/** PL-5: one saved version of the scene outline, in `sceneOutlineVersions`; `breaks` since A37, `years` since A39. */
export const SceneVersionDoc = z.strictObject({
  _id: z.string(),
  at: z.string(),
  until: z.string(),
  text: z.string(),
  breaks: SceneBreaks.optional(),
  years: SceneYears.optional(),
});

/** SB-6: the brief's size budget (`briefSettings`); the window is the bible's settings since A47. */
export const BriefSettingsDoc = z.strictObject({
  _id: z.literal('briefSettings'),
  budget: z.int().min(0),
});

/** Notes on each community, by community ID (`communityNotes`). */
export const CommunityNotesDoc = z.strictObject({
  _id: z.literal('communityNotes'),
  notes: z.record(z.string(), z.string()),
});

/** A56 (FN-3, FN-4): the From the notebook tray's marks (`notebookTray`). */
export const NotebookTrayDoc = z.strictObject({
  _id: z.literal('notebookTray'),
  dismissed: z.array(z.string()),
  filed: z.array(z.string()),
  sent: z.array(z.string()),
});

/** BK-1: how many snapshots to keep (`snapshotSettings`). */
export const SnapshotSettingsDoc = z.strictObject({
  _id: z.literal('snapshotSettings'),
  keep: z.int().min(1).max(1000),
});

/** IP-15: each Claude feature's own instructions, by feature (`claudeInstructions`). */
export const ClaudeInstructionsDoc = z.strictObject({
  _id: z.literal('claudeInstructions'),
  texts: z.record(z.string(), z.string()),
});

/** A55, A56 (NB-2, FN-7): the phone bridge's first publish and the question IDs held (`bridge`). */
export const BridgeDoc = z.strictObject({
  _id: z.literal(BRIDGE_META_ID),
  since: z.number().optional(),
  questionIds: z.array(z.string()).optional(),
});

/** The romanization system chosen for each language (`romanization`). */
export const RomanizationDoc = z.strictObject({
  _id: z.literal(ROMANIZATION_META_ID),
  systems: z.record(z.string(), z.string()),
});
