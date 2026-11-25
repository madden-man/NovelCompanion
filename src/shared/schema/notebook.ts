import { z } from 'zod';
import { Timestamp, Year } from './common';

/**
 * A55 (NB-4): the notebook pages that arrive from the phone. Not an entry
 * collection: every field follows the phone, nothing here is edited on the
 * desktop, so it stays out of `entrySchemas` (whose fields ED-1 and T-5 make
 * editable, and which IPC entry writes and Claude proposals may reach). The
 * repository writes it (the one write path), the read model holds it, search
 * indexes it.
 */
export const NOTEBOOK_COLLECTION = 'notebookPages';

/** The phone's row IDs (FlowState `ROW_ID`): wider than an entry ID, so colons and dots pass. */
export const NotebookId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,120}$/, 'A notebook page ID is the phone row ID');

/** kept: one kept journal line; council and thread: a page whole; research: a question researched. */
export const NOTEBOOK_KINDS = ['kept', 'council', 'thread', 'research'] as const;
export type NotebookKind = (typeof NOTEBOOK_KINDS)[number];

/** One line as written on the phone. `speakerId` is a character ID, or null for plain ink (his own). */
export const NotebookLine = z.strictObject({
  id: NotebookId,
  speakerId: z.string().min(1).max(120).nullable(),
  text: z.string().max(65536),
  wise: z.boolean(),
  kept: z.boolean(),
  at: Timestamp.nullable(),
});
export type NotebookLine = z.infer<typeof NotebookLine>;

/** A paper a question was researched with: its public record and the side it was picked for. */
export const NotebookPaper = z.strictObject({
  id: z.string().max(200),
  title: z.string().max(2000),
  journal: z.string().max(500).nullable(),
  year: z.int().nullable(),
  doi: z.string().max(500).nullable(),
  side: z.string().max(40).nullable(),
});
export type NotebookPaper = z.infer<typeof NotebookPaper>;

const Ids = z.array(z.string().min(1).max(120));

export const NotebookPage = z.strictObject({
  /** The phone page's ID; a kept line's own ID. */
  _id: NotebookId,
  /** The world it came from (A55: the bible's world ID). */
  world: z.string().min(1).max(40),
  kind: z.enum(NOTEBOOK_KINDS),
  /** A council's reading: in the story or about it. Null for every other kind. */
  reading: z.enum(['in', 'about']).nullable(),
  title: z.string().max(2000),
  /** The page's date on the phone (a kept line: its page's date). */
  date: Timestamp,
  /** The story year it was written in; null for the whole book. */
  year: Year.nullable(),
  lines: z.array(NotebookLine),
  /** The chips the phone sent: characters and places. */
  chips: z.strictObject({ characterIds: Ids, placeIds: Ids }),
  /** A research page: the question and the papers picked. */
  research: z
    .strictObject({ question: z.string().max(4000), papers: z.array(NotebookPaper) })
    .nullable(),
  /** The bible's open question a thread or research page belongs to, when there is one. */
  questionId: z.string().max(120).nullable(),
  /** Read from the chips, the seats, the speakers and the text (NB-5). */
  characterIds: Ids,
  placeIds: Ids,
  chapterIds: Ids,
  years: z.array(Year),
  /** The phone rows and revisions it was built from; a pull that brings the same ones changes nothing. */
  sig: z.string().max(20000),
  createdAt: Timestamp,
  modifiedAt: Timestamp,
  deletedAt: Timestamp.optional(),
});
export type NotebookPage = z.infer<typeof NotebookPage>;
