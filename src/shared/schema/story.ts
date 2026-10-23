import { z } from 'zod';
import { Id, Year, entry } from './common';
import { ANY, commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/** A5, A53: parts contain chapters; parts are the outline's dividers. */
export const Part = entry({
  number: z.int().min(1),
  summary: z.string().default(''),
});
export type Part = z.infer<typeof Part>;

export const partFields: FieldSpec[] = [
  ...commonFields,
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
  // a47-guard, IP-18: only the importer writes the manuscript fields; editors show them read-only.
  {
    ...f.system('manuscriptText', 'Manuscript text'),
    hint: 'Imported from the manuscript. Use Re-import to change it.',
  },
  f.longText('summary', 'Summary'),
  f.boolean('summaryOutOfDate', 'Summary may be out of date', {
    hint: 'Set when a re-import changed the text after the summary was written.',
  }),
  f.system('sourceFile', 'Source file'),
  f.longText('sceneNote', 'What happens in this scene'),
  {
    ...f.system('manuscriptSource', 'Manuscript source'),
    hint: 'Where the manuscript is read from. The app only reads it, never writes to it.',
  },
];

/** Open question (OQ-1): what it asks, what it is about, and the decision. */
export const OpenQuestion = entry({
  question: z.string().default(''),
  /** A52, A53 (OQ-1): the entries this question is about. */
  aboutIds: z.array(Id).default([]),
  state: z.enum(['open', 'decided']).default('open'),
  decision: z.string().default(''),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const openQuestionFields: FieldSpec[] = [
  ...commonFields,
  f.longText('question', 'Question'),
  f.refs('aboutIds', 'About', ANY),
  f.enum('state', 'State', [
    { value: 'open', label: 'Open' },
    { value: 'decided', label: 'Decided' },
  ]),
  f.longText('decision', 'Decision', { warnings: ['decided-without-decision'] }),
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

/** IP-7, ED-7: the wording a run wrote for the fields a writer may edit on the card. */
export const FindingWording = z.strictObject({
  text: z.string(),
  quote: z.string(),
  mustChange: z.string(),
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
  /** IP-7, ED-7: what the last run wrote, so a re-run can tell a hand edit from its own words. */
  generated: FindingWording.nullable().default(null),
  /** IP-7, ED-7: what a re-run says now for a field the writer edited; shown on the card, never written over the edit. */
  proposed: FindingWording.partial().nullable().default(null),
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
  f.system('generated', 'Wording of the last run'),
  f.system('proposed', 'What the check now says'),
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
