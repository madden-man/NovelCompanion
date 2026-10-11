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

/** Arc (A6): a scope, an optional owner character, and a story year range. */
export const Arc = entry({
  name: z.string().min(1),
  scope: z.enum(['book', 'family', 'character', 'custom']),
  familyId: Id.nullable().default(null),
  ownerCharacterId: Id.nullable().default(null),
  startYear: Year.nullable().default(null),
  endYear: Year.nullable().default(null),
  summary: z.string().default(''),
});
export type Arc = z.infer<typeof Arc>;

export const arcFields: FieldSpec[] = [
  ...commonFields,
  f.text('name', 'Arc name', { required: true }),
  f.enum(
    'scope',
    'Scope',
    [
      { value: 'book', label: 'Whole book' },
      { value: 'family', label: 'A family' },
      { value: 'character', label: 'A character' },
      { value: 'custom', label: 'Custom' },
    ],
    { required: true },
  ),
  f.ref('familyId', 'Family', ['families'], { nullable: true }),
  f.ref('ownerCharacterId', 'Owner character', ['characters'], { nullable: true }),
  ...yearRange('startYear', 'endYear'),
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

/** KN-3: which characters act on which facts in a chapter. */
export const FactInPlay = z.strictObject({
  factId: Id,
  characterId: Id,
  note: z.string().default(''),
});

export const Chapter = entry({
  partId: Id,
  readingOrder: z.int().min(1),
  strands: z.array(Strand).min(1),
  arcIds: z.array(Id).default([]),
  factsInPlay: z.array(FactInPlay).default([]),
  written: z.boolean().default(false),
  /** Read-only import of the manuscript (MS-5). */
  manuscriptText: z.string().default(''),
  summary: z.string().default(''),
  sourceFile: z.string().nullable().default(null),
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
  f.refs('arcIds', 'Arcs', ['arcs']),
  // Derived: a theme's appearances are the one place the link is stored (TH-1).
  f.refs('themeIds', 'Themes', ['themes'], {
    derived: true,
    hint: 'Adding a theme here adds an appearance to that theme, with an empty note. Removing it removes the appearance.',
  }),
  f.objectList(
    'factsInPlay',
    'Facts in play',
    [
      f.ref('factId', 'Fact', ['facts'], { required: true }),
      f.ref('characterId', 'Acted on by', ['characters'], { required: true }),
      f.text('note', 'Note'),
    ],
    { itemLabel: 'note' },
  ),
  f.boolean('written', 'Written'),
  f.longText('manuscriptText', 'Manuscript text', {
    hint: 'Imported from the manuscript. The app never writes back to it.',
  }),
  f.longText('summary', 'Summary'),
  f.text('sourceFile', 'Source file', { nullable: true }),
];

/** The position of a beat within one arc (A7, PL-3). */
export const BeatArcOrder = z.strictObject({ arcId: Id, order: z.int() });

/** Plot beat (A7). */
export const PlotBeat = entry({
  arcIds: z.array(Id).default([]),
  chapterId: Id.nullable().default(null),
  year: Year.nullable().default(null),
  povCharacterId: Id.nullable().default(null),
  description: z.string().default(''),
  worldContext: z.string().default(''),
  experienceNote: z.string().default(''),
  /** PL-3: the position in each arc the beat belongs to. A beat in two arcs has two positions. */
  arcOrders: z.array(BeatArcOrder).default([]),
});
export type PlotBeat = z.infer<typeof PlotBeat>;

export const plotBeatFields: FieldSpec[] = [
  ...commonFields,
  f.refs('arcIds', 'Arcs', ['arcs']),
  f.ref('chapterId', 'Chapter', ['chapters'], { nullable: true }),
  f.year('year', 'Story year', { nullable: true }),
  f.ref('povCharacterId', 'Point of view', ['characters'], { nullable: true }),
  f.longText('description', 'Description'),
  f.longText('worldContext', 'World context'),
  f.longText('experienceNote', 'How the point of view character experiences it'),
  f.objectList(
    'arcOrders',
    'Order within each arc',
    [
      f.ref('arcId', 'Arc', ['arcs'], { required: true }),
      f.int('order', 'Order', { required: true }),
    ],
    { itemLabel: 'arcId' },
  ),
];

/** A fact is a secret or a piece of family history; its text is the shared body. */
export const Fact = entry({});
export type Fact = z.infer<typeof Fact>;

export const factFields: FieldSpec[] = [...commonFields];

export const KnowledgeRecord = entry({
  factId: Id,
  characterId: Id,
  yearLearned: Year.nullable(),
  chapterLearnedId: Id.nullable().default(null),
  how: z.string().default(''),
});
export type KnowledgeRecord = z.infer<typeof KnowledgeRecord>;

export const knowledgeRecordFields: FieldSpec[] = [
  ...commonFields,
  f.ref('factId', 'Fact', ['facts'], { required: true }),
  f.ref('characterId', 'Character', ['characters'], { required: true }),
  f.year('yearLearned', 'Year learned', {
    required: true,
    nullable: true,
    warnings: ['learned-before-birth', 'learned-after-death'],
  }),
  f.ref('chapterLearnedId', 'Chapter learned', ['chapters'], { nullable: true }),
  f.longText('how', 'How they learn it'),
];

/** Theme or motif (TH-1). */
export const Theme = entry({
  description: z.string().default(''),
  appearances: z.array(z.strictObject({ chapterId: Id, note: z.string().default('') })).default([]),
});
export type Theme = z.infer<typeof Theme>;

export const themeFields: FieldSpec[] = [
  ...commonFields,
  f.longText('description', 'Description'),
  f.objectList(
    'appearances',
    'Appearances',
    [f.ref('chapterId', 'Chapter', ['chapters'], { required: true }), f.text('note', 'Note')],
    { itemLabel: 'note' },
  ),
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
});
export type SessionLog = z.infer<typeof SessionLog>;

export const sessionLogFields: FieldSpec[] = [
  ...commonFields,
  f.calendarDate('date', 'Date', { required: true }),
  f.ref('chapterId', 'Chapter worked on', ['chapters'], { nullable: true }),
  f.longText('stoppedAt', 'Where I stopped'),
  f.longText('notes', 'Notes'),
];

/** A saved session brief (SB-8). Generated content is an ordinary editable field (ED-6). */
export const Brief = entry({
  chapterId: Id.nullable().default(null),
  storyYear: Year.nullable().default(null),
  povCharacterId: Id.nullable().default(null),
  entryIds: z.array(Id).default([]),
  content: z.string().default(''),
});
export type Brief = z.infer<typeof Brief>;

export const briefFields: FieldSpec[] = [
  ...commonFields,
  f.ref('chapterId', 'Chapter', ['chapters'], { nullable: true }),
  f.year('storyYear', 'Story year', { nullable: true }),
  f.ref('povCharacterId', 'Point of view', ['characters'], { nullable: true }),
  f.refs('entryIds', 'Selected entries', ANY),
  f.longText('content', 'Brief'),
];

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
