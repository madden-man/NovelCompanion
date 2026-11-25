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

/**
 * Who a line is by: `ink` is his own (no voice), `character` a council voice
 * `c:<characterId>` (then `speakerId` names the character), `other` any other
 * voice, a research paper brought to a council among them (then `paper` says
 * which side it was picked for). Only `ink` is his.
 */
export const LINE_VOICES = ['ink', 'character', 'other'] as const;
export type LineVoice = (typeof LINE_VOICES)[number];

/** Caps a line, a title and a question are cut to on arrival, so one long value never stops a page landing. */
export const NOTEBOOK_TEXT_MAX = 65536;
export const NOTEBOOK_TITLE_MAX = 2000;
export const NOTEBOOK_QUESTION_MAX = 4000;

/** One line as written on the phone. */
export const NotebookLine = z.strictObject({
  id: NotebookId,
  voice: z.enum(LINE_VOICES),
  /** The character who spoke it, when `voice` is `character`; otherwise null. */
  speakerId: z.string().min(1).max(120).nullable(),
  /** A paper's line (`voice` is `other`): the side it was picked for. */
  paper: z.strictObject({ side: z.string().max(40).nullable() }).nullable(),
  text: z.string().max(NOTEBOOK_TEXT_MAX),
  wise: z.boolean(),
  kept: z.boolean(),
  at: Timestamp.nullable(),
});
export type NotebookLine = z.infer<typeof NotebookLine>;

/** A paper a question was researched with: its public record and the side it was picked for. */
export const NotebookPaper = z.strictObject({
  id: z.string().max(200),
  title: z.string().max(NOTEBOOK_TITLE_MAX),
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
  title: z.string().max(NOTEBOOK_TITLE_MAX),
  /** The page's date on the phone (a kept line: its page's date). */
  date: Timestamp,
  /**
   * The story year it was written in; null for the whole book; absent when no
   * year is known (a page written before the phone had a pocket).
   */
  year: Year.nullable().optional(),
  lines: z.array(NotebookLine),
  /** The chips the phone sent: characters and places. */
  chips: z.strictObject({ characterIds: Ids, placeIds: Ids }),
  /** A research page: the question and the papers picked. */
  research: z
    .strictObject({
      question: z.string().max(NOTEBOOK_QUESTION_MAX),
      papers: z.array(NotebookPaper),
    })
    .nullable(),
  /** The bible's open question a thread or research page belongs to, when there is one. */
  questionId: z.string().max(120).nullable(),
  /** Read from the chips, the seats, the speakers and the text (NB-5). */
  characterIds: Ids,
  placeIds: Ids,
  chapterIds: Ids,
  years: z.array(Year),
  /**
   * A hash of the phone rows and revisions it was built from (or of the delete
   * that trashed it); a pull that brings the same ones changes nothing.
   */
  sig: z.string().max(200),
  createdAt: Timestamp,
  modifiedAt: Timestamp,
  deletedAt: Timestamp.optional(),
});
export type NotebookPage = z.infer<typeof NotebookPage>;
