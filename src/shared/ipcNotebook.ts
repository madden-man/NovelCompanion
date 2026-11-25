import { z } from 'zod';
import { NOTEBOOK_KINDS } from './schema/notebook';

/**
 * A55 (NB-7, NB-8): the notebook channels. Both read; nothing in the
 * renderer writes a notebook page, which follows the phone (NB-4).
 */

const Reading = z.enum(['in', 'about']).nullable();
const Year = z.int().min(-10000).max(10000);
const Kind = z.enum(NOTEBOOK_KINDS);

/** One row of a Notebook list: the date and first line, captioned by kind and story year. */
export const NotebookRowWire = z.strictObject({
  id: z.string(),
  kind: Kind,
  reading: Reading,
  date: z.string(),
  /** Null is the whole book; absent is no year known. */
  year: Year.nullable().optional(),
  firstLine: z.string(),
  caption: z.string(),
  /** False for a kept line: the row is all there is to read. */
  opens: z.boolean(),
});

const LinkWire = z.strictObject({
  collection: z.enum(['characters', 'places', 'chapters', 'openQuestions']),
  id: z.string(),
  title: z.string(),
});

/** One page as the screen shows it, names read from the bible. */
export const NotebookPageWire = z.strictObject({
  id: z.string(),
  kind: Kind,
  reading: Reading,
  title: z.string(),
  firstLine: z.string(),
  caption: z.string(),
  date: z.string(),
  year: Year.nullable().optional(),
  inTrash: z.boolean(),
  lines: z.array(
    z.strictObject({
      id: z.string(),
      /** ink: his own words; character: `speakerId` spoke it; other: another voice, a paper among them. */
      voice: z.enum(['ink', 'character', 'other']),
      speakerId: z.string().nullable(),
      paper: z.strictObject({ side: z.string().nullable() }).nullable(),
      speaker: z.string().nullable(),
      text: z.string(),
      wise: z.boolean(),
      kept: z.boolean(),
    }),
  ),
  research: z
    .strictObject({
      question: z.string(),
      papers: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          journal: z.string().nullable(),
          year: z.int().nullable(),
          doi: z.string().nullable(),
          side: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  /** What the page names: characters, places and chapters, and the question it belongs to. */
  links: z.array(LinkWire),
  years: z.array(Year),
});

const TrayKeys = z.array(z.string());
const TrayMarksWire = z.strictObject({ dismissed: TrayKeys, filed: TrayKeys, sent: TrayKeys });

export const notebookContract = {
  /** NB-7: the Notebook list of one character, place or chapter. */
  'notebook.list': {
    request: z.strictObject({
      collection: z.enum(['characters', 'places', 'chapters']),
      id: z.string().min(1).max(64),
    }),
    response: z.strictObject({ rows: z.array(NotebookRowWire) }),
  },
  /** NB-8: one page, to read across the screen. */
  'notebook.get': {
    request: z.strictObject({ id: z.string().min(1).max(120) }),
    response: z.strictObject({ page: NotebookPageWire }),
  },
  /** A56 (FN-8): a character's Voice, their lines in councils in the story. */
  'notebook.voice': {
    request: z.strictObject({ id: z.string().min(1).max(64) }),
    response: z.strictObject({
      rows: z.array(
        z.strictObject({
          pageId: z.string(),
          lineId: z.string(),
          date: z.string(),
          year: Year.nullable().optional(),
          text: z.string(),
        }),
      ),
    }),
  },
  /** A56 (FN-9): the pages that touch the scene being written, for Relevant to Session. */
  'notebook.relevant': {
    request: z.strictObject({
      characterIds: z.array(z.string().min(1).max(64)).max(500),
      placeIds: z.array(z.string().min(1).max(64)).max(500),
      year: Year.nullable(),
    }),
    response: z.strictObject({ rows: z.array(NotebookRowWire) }),
  },
  /** A56 (FN-1): the kept lines and councils about the story the tray offers, as they are now. */
  'notebook.offered': {
    request: z.strictObject({}),
    response: z.strictObject({
      pages: z.array(
        z.strictObject({
          id: z.string(),
          kind: z.enum(['kept', 'council']),
          title: z.string(),
          date: z.string(),
          year: Year.nullable().optional(),
          lines: z.array(
            z.strictObject({ id: z.string(), text: z.string(), speakerId: z.string().nullable() }),
          ),
        }),
      ),
    }),
  },
  /** A56 (FN-3, FN-4): the facts dismissed, filed and sent, by key. */
  'tray.state': {
    request: z.strictObject({}),
    response: TrayMarksWire,
  },
  /** A56 (FN-3, FN-4, FN-6): mark facts dismissed, filed or sent; null clears (undo). */
  'tray.mark': {
    request: z.strictObject({
      keys: z.array(z.string().min(1).max(300)).min(1).max(1000),
      mark: z.enum(['dismissed', 'filed', 'sent']).nullable(),
    }),
    response: TrayMarksWire,
  },
} as const;
