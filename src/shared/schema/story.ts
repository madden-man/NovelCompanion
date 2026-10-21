import { z } from 'zod';
import { CalendarDate, Id, Year, entry } from './common';
import { ANY, commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/** A5: books contain parts, parts contain chapters. */
export const Book = entry({
  number: z.int().min(1),
  summary: z.string().default(''),
});
export type Book = z.infer<typeof Book>;

export const bookFields: FieldSpec[] = [
  ...commonFields,
  f.int('number', 'Book number', { required: true }),
  f.longText('summary', 'Summary'),
];

export const Part = entry({
  bookId: Id,
  number: z.int().min(1),
  summary: z.string().default(''),
});
export type Part = z.infer<typeof Part>;

export const partFields: FieldSpec[] = [
  ...commonFields,
  f.ref('bookId', 'Book', ['books'], { required: true }),
  f.int('number', 'Part number', { required: true }),
  f.longText('summary', 'Summary'),
];

/**
 * A chapter strand (A5). One strand per chapter is primary and supplies the
 * chapter's story year; more or fewer than one is a warning (ED-10).
 */
export const Strand = z.strictObject({
  id: Id,
  label: z.string().min(1),
  startYear: Year,
  endYear: Year.nullable().default(null),
  primary: z.boolean(),
  povCharacterId: Id.nullable().default(null),
  characterIds: z.array(Id).default([]),
  placeIds: z.array(Id).default([]),
});
export type Strand = z.infer<typeof Strand>;

export const Chapter = entry({
  partId: Id,
  readingOrder: z.int().min(1),
  strands: z.array(Strand).min(1),
  written: z.boolean().default(false),
  /** Read-only import of the manuscript (MS-5). */
  manuscriptText: z.string().default(''),
  summary: z.string().default(''),
  /** MS-4: set when a re-import changed the text after the summary was written. */
  summaryOutOfDate: z.boolean().default(false),
  sourceFile: z.string().nullable().default(null),
  /** SM-10: what happens in the scene being written, kept on the chapter. */
  sceneNote: z.string().default(''),
  /** MS-1: where the manuscript text is read from, for example `word:/path/Chapter 3.docx`. */
  manuscriptSource: z.string().max(2000).nullable().default(null),
});
export type Chapter = z.infer<typeof Chapter>;

export const chapterFields: FieldSpec[] = [
  ...commonFields,
  f.ref('partId', 'Part', ['parts'], { required: true }),
  f.int('readingOrder', 'Reading order', { required: true }),
  f.objectList(
    'strands',
    'Strands',
    [
      f.system('id', 'Strand ID'),
      f.text('label', 'Label', { required: true, hint: 'For example present or backstory.' }),
      ...yearRange('startYear', 'endYear', ['Story year', 'Ends in year'], {
        startRequired: true,
      }),
      f.boolean('primary', 'Primary strand', {
        required: true,
        warnings: ['primary-strand-count'],
      }),
      f.ref('povCharacterId', 'Point of view', ['characters'], { nullable: true }),
      f.refs('characterIds', 'Characters present', ['characters']),
      f.refs('placeIds', 'Places', ['places']),
    ],
    { required: true, minItems: 1, itemLabel: 'label', warnings: ['primary-strand-count'] },
  ),
  f.boolean('written', 'Written'),
  f.longText('manuscriptText', 'Manuscript text', {
    hint: 'Imported from the manuscript. The app never writes back to it.',
  }),
  f.longText('summary', 'Summary'),
  f.boolean('summaryOutOfDate', 'Summary may be out of date', {
    hint: 'Set when a re-import changed the text after the summary was written.',
  }),
  f.text('sourceFile', 'Source file', { nullable: true }),
  f.longText('sceneNote', 'What happens in this scene'),
  f.text('manuscriptSource', 'Manuscript source', {
    nullable: true,
    hint: 'Where the manuscript is read from. The app only reads it, never writes to it.',
  }),
];

/** Open question (OQ-1). Linked entries are the shared links. */
export const OpenQuestion = entry({
  question: z.string().default(''),
  state: z.enum(['open', 'decided']).default('open'),
  decision: z.string().default(''),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const openQuestionFields: FieldSpec[] = [
  ...commonFields,
  f.longText('question', 'Question'),
  f.enum('state', 'State', [
    { value: 'open', label: 'Open' },
    { value: 'decided', label: 'Decided' },
  ]),
  f.longText('decision', 'Decision', { warnings: ['decided-without-decision'] }),
];

/** Session log (SL-1). The date is a real calendar date. */
export const SessionLog = entry({
  date: CalendarDate,
  chapterId: Id.nullable().default(null),
  stoppedAt: z.string().default(''),
  notes: z.string().default(''),
  /** DB-3: the section the session was started for, and its brief. */
  partId: Id.nullable().default(null),
  strandId: z.string().max(64).nullable().default(null),
  storyYear: Year.nullable().default(null),
  povCharacterId: Id.nullable().default(null),
  briefId: Id.nullable().default(null),
});
export type SessionLog = z.infer<typeof SessionLog>;

export const sessionLogFields: FieldSpec[] = [
  ...commonFields,
  f.calendarDate('date', 'Date', { required: true }),
  f.ref('chapterId', 'Chapter worked on', ['chapters'], { nullable: true }),
  f.longText('stoppedAt', 'Where I stopped'),
  f.longText('notes', 'Notes'),
  f.ref('partId', 'Part worked on', ['parts'], { nullable: true }),
  f.text('strandId', 'Strand worked on', { nullable: true }),
  f.year('storyYear', 'Story year', { nullable: true }),
  f.ref('povCharacterId', 'Point of view', ['characters'], { nullable: true }),
  f.ref('briefId', 'Brief', ['briefs'], { nullable: true }),
];

/** A saved session brief (SB-8). Generated content is an ordinary editable field (ED-6). */
export const Brief = entry({
  chapterId: Id.nullable().default(null),
  storyYear: Year.nullable().default(null),
  povCharacterId: Id.nullable().default(null),
  entryIds: z.array(Id).default([]),
  content: z.string().default(''),
  /** SB-1, DB-2: the kind of section the brief is for, and its other inputs. */
  sectionKind: z.enum(['chapter', 'strand', 'part', 'pov']).nullable().default(null),
  strandId: z.string().max(64).nullable().default(null),
  partId: Id.nullable().default(null),
  placeIds: z.array(Id).default([]),
  characterIds: z.array(Id).default([]),
  /** SB-9: entries the person added to or removed from the selection. */
  added: z.array(Id).default([]),
  removed: z.array(Id).default([]),
  /** DB-4: the model that wrote it; empty for a structured brief (SB-7). */
  model: z.string().max(200).default(''),
  synthesized: z.boolean().default(false),
  /** SB-3: the saved selection the brief was written from. Set by the app. */
  selection: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type Brief = z.infer<typeof Brief>;

export const briefFields: FieldSpec[] = [
  ...commonFields,
  f.ref('chapterId', 'Chapter', ['chapters'], { nullable: true }),
  f.year('storyYear', 'Story year', { nullable: true }),
  f.ref('povCharacterId', 'Point of view', ['characters'], { nullable: true }),
  f.refs('entryIds', 'Selected entries', ANY),
  f.longText('content', 'Brief'),
  f.enum(
    'sectionKind',
    'Section',
    [
      { value: 'chapter', label: 'A chapter' },
      { value: 'strand', label: 'A chapter strand' },
      { value: 'part', label: 'A part' },
      { value: 'pov', label: 'A story year and point of view' },
    ],
    { nullable: true },
  ),
  f.text('strandId', 'Strand', { nullable: true }),
  f.ref('partId', 'Part', ['parts'], { nullable: true }),
  f.refs('placeIds', 'Places', ['places']),
  f.refs('characterIds', 'Other characters present', ['characters']),
  f.refs('added', 'Entries you added', ANY),
  f.refs('removed', 'Entries you removed', ANY),
  f.text('model', 'Model', { hint: 'Empty when the brief was not written by Claude.' }),
  f.boolean('synthesized', 'Written by Claude'),
  f.system('selection', 'Selection'),
];

/**
 * One field change in a finding's prepared change set (CC-4, Manuscript wins):
 * the entry, the field (a top-level field, or `strands.<strand ID>.<field>` on
 * a chapter), and the value that makes the bible match the chapter. Checked
 * against the schema and the read model before it is stored or applied.
 */
export const ChangeSetItem = z.strictObject({
  collection: z.string().min(1).max(64),
  id: Id,
  field: z.string().min(1).max(200),
  value: z.unknown(),
});
export type ChangeSetItem = z.infer<typeof ChangeSetItem>;

/** CC-4, Dismiss: what the finding was dismissed against, so a change brings it back. */
export const Dismissal = z.strictObject({
  textHash: z.string().max(64),
  entryHash: z.string().max(64),
});

/** A continuity finding (CC-2, CC-3). Editable like anything else (ED-6). */
export const Finding = entry({
  chapterId: Id.nullable().default(null),
  kind: z.enum(['structural', 'alignment']),
  text: z.string().default(''),
  quote: z.string().default(''),
  lineStart: z.int().min(1).nullable().default(null),
  lineEnd: z.int().min(1).nullable().default(null),
  entryIds: z.array(Id).default([]),
  state: z.enum(['open', 'manuscriptWins', 'rewrite', 'dismissed']).default('open'),
  resolutionNote: z.string().default(''),
  /** M8: the stable identity of the finding across runs (check, chapter, strand, entries). */
  key: z.string().max(500).default(''),
  /** The structural check, or the alignment kind (age, date, place, ...). */
  check: z.string().max(100).default(''),
  strandId: z.string().max(64).nullable().default(null),
  storyYear: Year.nullable().default(null),
  /** CC-4 Rewrite recommended: a plain description of what must change. Never replacement prose (AI-4). */
  mustChange: z.string().default(''),
  /** CC-4 Manuscript wins: the checked change set that makes the bible match the chapter. */
  changeSet: z.array(ChangeSetItem).default([]),
  /** Changes Claude prepared that failed the checks, with the reason, so they are shown and never applied. */
  rejectedChanges: z.array(z.strictObject({ summary: z.string(), reason: z.string() })).default([]),
  dismissal: Dismissal.nullable().default(null),
  /** The alignment run that produced it (AI-1). */
  runId: z.string().max(64).nullable().default(null),
});
export type Finding = z.infer<typeof Finding>;

export const findingFields: FieldSpec[] = [
  ...commonFields,
  f.ref('chapterId', 'Chapter', ['chapters'], { nullable: true }),
  f.enum(
    'kind',
    'Kind',
    [
      { value: 'structural', label: 'Structural' },
      { value: 'alignment', label: 'Alignment' },
    ],
    { required: true },
  ),
  f.longText('text', 'Finding'),
  f.longText('quote', 'Quoted passage'),
  ...yearRangeLines(),
  f.refs('entryIds', 'Cited entries', ANY),
  f.enum('state', 'Resolution', [
    { value: 'open', label: 'Open' },
    { value: 'manuscriptWins', label: 'Manuscript wins' },
    { value: 'rewrite', label: 'Rewrite recommended' },
    { value: 'dismissed', label: 'Dismissed' },
  ]),
  f.longText('resolutionNote', 'Resolution note'),
  f.system('key', 'Finding key'),
  f.system('check', 'Check'),
  f.system('strandId', 'Strand'),
  f.system('storyYear', 'Story year'),
  f.longText('mustChange', 'What must change', {
    hint: 'For a rewrite task: what must change in the text to match the bible. Never replacement text.',
  }),
  f.system('changeSet', 'Prepared change set'),
  f.system('rejectedChanges', 'Changes that failed the checks'),
  f.system('dismissal', 'Dismissed against'),
  f.system('runId', 'Alignment run'),
];

function yearRangeLines(): FieldSpec[] {
  return [
    f.int('lineStart', 'First line', {
      nullable: true,
      rangeEnd: 'lineEnd',
      warnings: ['range-end-before-start'],
    }),
    f.int('lineEnd', 'Last line', { nullable: true, warnings: ['range-end-before-start'] }),
  ];
}
