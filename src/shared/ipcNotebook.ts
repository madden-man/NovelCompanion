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
  year: Year.nullable(),
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
  year: Year.nullable(),
  inTrash: z.boolean(),
  lines: z.array(
    z.strictObject({
      id: z.string(),
      /** The character who spoke it, or null for plain ink, his own words. */
      speakerId: z.string().nullable(),
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
} as const;
