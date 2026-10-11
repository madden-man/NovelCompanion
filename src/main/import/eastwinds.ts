import { join } from 'node:path';
import {
  blocksToBody,
  cellText,
  erasFromBlocks,
  isBlank,
  parseYear,
  planEraDocument,
  spanOf,
} from '../../shared/domain/import';
import type {
  ChangeSet,
  DocBlock,
  DocumentTarget,
  GridMapping,
  Mapping,
  ParsedSheet,
  ParsedWorkbook,
  SourceFile,
  TableMapping,
} from '../../shared/domain/import';
import { entryTitle } from '../../shared/schema';
import type { OpenBible } from '../db/session';
import { parseDocxFile } from './docx';
import type { ParsedDocument } from './docx';
import { applyPlan, contextFor, notesSection, planDocumentImport, planSheet } from './run';
import type { DocumentPlan } from './run';
import { parseWorkbookFile } from './xlsx';

/** Where the East Winds material lives, relative to the folder given to the importer. */
export const EAST_WINDS_FILES = {
  workbook: 'East_Winds_World.xlsx',
  lives: [
    ['Dawns_Life.docx', 'Dawn'],
    ['Franks_Life.docx', 'Frank'],
    ['Marks_Life.docx', 'Mark'],
  ] as const,
  manuscript: 'East_Winds.docx',
  worldDevelopment: 'East_Winds_World_Development.docx',
};

export interface StepReport {
  step: string;
  created: number;
  updated: number;
  unchanged: number;
  questions: number;
  failed: { where: string; reason: string }[];
  notes: string[];
}

export interface EastWindsReport {
  steps: StepReport[];
  snapshot: string | null;
  dryRun: boolean;
}

const header = (sheet: ParsedSheet, row = 0) => (sheet.cells[row] ?? []).map((c) => cellText(c));

/**
 * The default mapping for a sheet of the East Winds workbook. Columns are
 * found by their header text, so a moved column still lands in the right field.
 */
export function defaultMappings(wb: ParsedWorkbook): Mapping[] {
  const out: Mapping[] = [];
  const high = wb.sheets.find((s) => s.name === 'High Level');
  if (high) {
    // Year columns headed 9 to 100 stand for 2009 to 2100.
    const years = (high.cells[0] ?? [])
      .map((c) => parseYear(c))
      .filter((y): y is number => y !== null);
    const short = years.length > 3 && years.every((y) => y > 0 && y < 200);
    out.push({
      shape: 'grid',
      sheet: 'High Level',
      target: { collection: 'worldEvents' },
      headerRow: null,
      labelColumn: 0,
      yearOffset: short ? 2000 : 0,
      categoryRoot: null,
      categoryList: 'eventCategories',
      fixed: { status: 'planned', provenance: 'invented', reality: 'invented' },
      addMissingListItems: true,
      createMissing: false,
      matchIn: 'sheet',
    } satisfies GridMapping);
  }
  const beatSheet = (name: string, tag: string): TableMapping | null => {
    const sheet = wb.sheets.find((s) => s.name === name);
    if (!sheet) return null;
    return {
      shape: 'table',
      sheet: name,
      target: { collection: 'plotBeats' },
      headerRow: 1,
      columns: columnsFor(header(sheet), {
        title: /^chronological/i,
        povCharacterId: /^pov$/i,
        year: /^year$/i,
        worldContext: /^relevant world/i,
        experienceNote: /^how the pov/i,
      }),
      identity: ['title', 'year'],
      fixed: { status: 'planned', provenance: 'invented', tags: [tag] },
      addMissingListItems: false,
      createMissing: true,
      matchIn: 'sheet',
      headings: [],
    };
  };
  for (const m of [beatSheet('Sullivan', 'Sullivan'), beatSheet('李', '李')]) if (m) out.push(m);
  const plot = wb.sheets.find((s) => s.name === 'Plot v1');
  if (plot) {
    out.push({
      shape: 'table',
      sheet: 'Plot v1',
      target: { collection: 'chapters' },
      headerRow: 1,
      columns: columnsFor(header(plot), {
        title: /^plot/i,
        'strand.povCharacterId': /^pov$/i,
        'strand.startYear': /^year$/i,
        body: /^relevant world/i,
        summary: /^how the pov/i,
      }),
      identity: ['title'],
      fixed: { status: 'planned', provenance: 'invented' },
      addMissingListItems: false,
      createMissing: true,
      matchIn: 'sheet',
      headings: [
        {
          collection: 'books',
          match: 'single',
          linkField: 'bookId',
          numberField: 'number',
          fixed: { status: 'planned', provenance: 'invented' },
        },
        {
          collection: 'parts',
          match: 'banner',
          linkField: 'partId',
          parentLinkField: 'bookId',
          textField: 'summary',
          numberField: 'number',
          implicitTitle: 'Chapters with no part named',
          fixed: { status: 'planned', provenance: 'invented' },
        },
      ],
    } satisfies TableMapping);
  }
  return out;
}

function columnsFor(headers: string[], rules: Record<string, RegExp>): TableMapping['columns'] {
  const columns: TableMapping['columns'] = [];
  for (const [field, re] of Object.entries(rules)) {
    const index = headers.findIndex((h) => re.test(h));
    const header = headers[index];
    if (header !== undefined) columns.push({ header, index, field });
  }
  return columns;
}

/** The first name in a character's title or full name, lower case, for matching "Dawn" to "Dawn Sullivan". */
const firstName = (title: string) => title.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

/**
 * Split the East Winds manuscript: the introduction (everything before the
 * first chapter), chapter 1, and the rest as a general note.
 */
export function splitManuscript(blocks: DocBlock[]): {
  introduction: DocBlock[];
  chapterOne: DocBlock[];
  rest: DocBlock[];
  chapterTitle: string;
} | null {
  const headings = blocks.filter((b) => b.kind === 'heading' && b.text);
  const intro = headings.find((h) => /^introduction\b/i.test(h.text));
  const chapter = headings.find(
    (h) =>
      (!intro || h.index > intro.index) && /^(chapter\s+)?(1|one|i)\b\s*[:.\-)]?/i.test(h.text),
  );
  if (!chapter) return null;
  const after = headings.find((h) => h.index > chapter.index && h.level <= chapter.level);
  const before = (stop: number) => blocks.filter((b) => b.index < stop);
  return {
    introduction: before(chapter.index),
    chapterOne: blocks.filter((b) => b.index >= chapter.index && (!after || b.index < after.index)),
    rest: after ? blocks.filter((b) => b.index >= after.index) : [],
    chapterTitle: chapter.text,
  };
}

interface Log {
  (line: string): void;
}

/**
 * Import the East Winds material into an open bible (IM-1 to IM-7). With
 * `dryRun` it compares and reports and writes nothing. Otherwise it takes one
 * snapshot first, then applies each step through the write path.
 */
export async function importEastWinds(
  open: OpenBible,
  dir: string,
  opts: { dryRun?: boolean; log?: Log } = {},
): Promise<EastWindsReport> {
  const log = opts.log ?? (() => undefined);
  const dryRun = opts.dryRun === true;
  const report: EastWindsReport = { steps: [], snapshot: null, dryRun };
  if (!dryRun && open.snapshots) {
    const snap = await open.snapshots.take('import', 'East Winds import');
    report.snapshot = snap.id;
    log(`Snapshot taken: ${snap.id}`);
    // One snapshot covers the whole run; the steps below do not each take another.
    open.repo.beforeBulk = null;
  }

  const record = async (
    step: string,
    set: ChangeSet,
    file: SourceFile,
    createSection: DocumentPlan['createSection'] = null,
    notes: string[] = [],
  ) => {
    const base = {
      step,
      unchanged: set.unchanged,
      failed: set.failed.map((f) => ({ where: f.where, reason: f.reason })),
      notes: [...notes, ...set.notes],
    };
    if (dryRun) {
      const r = {
        ...base,
        created: set.items.filter((i) => i.kind === 'new').length,
        updated: set.items.filter((i) => i.kind === 'changed').length,
        questions: set.items.filter((i) => i.deltas.some((d) => d.conflict)).length,
      };
      report.steps.push(r);
      return r;
    }
    const done = await applyPlan(open, set, file, 'all', createSection);
    const r = { ...base, created: done.created, updated: done.updated, questions: done.questions };
    report.steps.push(r);
    return r;
  };

  // The workbook: grid, beats, and chapters.
  const wb = await parseWorkbookFile(join(dir, EAST_WINDS_FILES.workbook));
  for (const mapping of defaultMappings(wb)) {
    const sheet = wb.sheets.find((s) => s.name === mapping.sheet);
    if (!sheet) continue;
    const { set } = planSheet(open, sheet, wb, mapping);
    await record(`${wb.fileName}, sheet ${mapping.sheet}`, set, wb);
  }

  // The lives: one backstory each.
  for (const [file, name] of EAST_WINDS_FILES.lives) {
    const doc = await parseDocxFile(join(dir, file));
    const found = findCharacter(open, name);
    let id = found?._id;
    if (!id && !dryRun) {
      const made = await open.repo.create('characters', {
        title: name,
        names: { full: name },
        birth: { unknown: true },
        status: 'planned',
        provenance: 'invented',
        sourceRef: `${file}#p1`,
      } as never);
      id = made._id;
    }
    if (!id) {
      report.steps.push({
        step: file,
        created: 1,
        updated: 0,
        unchanged: 0,
        questions: 0,
        failed: [],
        notes: [`Would make a character called ${name} and set the backstory.`],
      });
      continue;
    }
    const plan = planDocumentImport(open, doc, { kind: 'backstory', characterId: id });
    await record(
      `${file}, backstory of ${entryTitle(open.model.get('characters', id) ?? { title: name })}`,
      plan.set,
      plan.file,
      null,
      found ? [] : [`Made a character called ${name}; it had no entry.`],
    );
  }

  // The manuscript.
  const manuscript = await parseDocxFile(join(dir, EAST_WINDS_FILES.manuscript));
  const split = splitManuscript(manuscript.blocks);
  if (!split) {
    report.steps.push({
      step: manuscript.fileName,
      created: 0,
      updated: 0,
      unchanged: 0,
      questions: 0,
      failed: [
        {
          where: manuscript.fileName,
          reason: 'No heading for chapter 1 was found, so the manuscript was not split.',
        },
      ],
      notes: [],
    });
  } else {
    const part = await partForManuscript(open, dryRun);
    const year = firstChapterYear(open) ?? 2000;
    const targets: { title: string; blocks: DocBlock[] }[] = [
      { title: 'Introduction', blocks: split.introduction },
      { title: split.chapterTitle, blocks: split.chapterOne },
    ];
    for (const t of targets) {
      if (!part) {
        report.steps.push({
          step: `${manuscript.fileName}, ${t.title}`,
          created: 1,
          updated: 0,
          unchanged: 0,
          questions: 0,
          failed: [],
          notes: ['Would make a book and a part to hold the manuscript chapters.'],
        });
        continue;
      }
      const existing = open.repo
        .list('chapters')
        .find((c) => c.title === t.title && c.sourceFile === manuscript.fileName);
      const target: DocumentTarget = existing
        ? { kind: 'chapter', chapterId: existing._id }
        : { kind: 'chapter', chapterId: null, title: t.title, partId: part, year };
      const plan = planDocumentImport(open, manuscript, target, t.blocks);
      await record(
        `${manuscript.fileName}, ${t.title}`,
        plan.set,
        plan.file,
        null,
        existing
          ? []
          : [
              `New chapter placed in the first part with story year ${year}. Edit the year and the part in the app.`,
            ],
      );
    }
    if (split.rest.length) {
      const section = notesSection(open);
      const plan = planDocumentImport(
        open,
        manuscript,
        { kind: 'note', sectionId: '', title: 'East Winds: the rest of the manuscript document' },
        split.rest,
        section,
      );
      await record(
        `${manuscript.fileName}, general note for the rest`,
        plan.set,
        plan.file,
        plan.createSection,
      );
    }
  }

  // The world development document: era states by headings.
  const world = await parseDocxFile(join(dir, EAST_WINDS_FILES.worldDevelopment));
  await importEras(open, world, record);
  return report;
}

function findCharacter(open: OpenBible, name: string) {
  const want = name.toLowerCase();
  const people = open.repo.list('characters');
  return (
    people.find((c) => entryTitle(c).toLowerCase() === want) ??
    people.find((c) => firstName(entryTitle(c)) === want) ??
    people.find((c) => firstName(c.names.full) === want)
  );
}

function firstChapterYear(open: OpenBible): number | null {
  const chapters = open.repo.list('chapters').sort((a, b) => a.readingOrder - b.readingOrder);
  return (
    chapters[0]?.strands.find((s) => s.primary)?.startYear ??
    chapters[0]?.strands[0]?.startYear ??
    null
  );
}

/** The part new manuscript chapters go into: the lowest numbered part, made if the bible has none. */
async function partForManuscript(open: OpenBible, dryRun: boolean): Promise<string | null> {
  const parts = open.repo.list('parts').sort((a, b) => a.number - b.number);
  if (parts[0]) return parts[0]._id;
  if (dryRun) return null;
  const book =
    open.repo.list('books')[0] ??
    (await open.repo.create('books', {
      title: 'East Winds',
      number: 1,
      status: 'planned',
    } as never));
  const part = await open.repo.create('parts', {
    title: 'Manuscript',
    bookId: book._id,
    number: 1,
    status: 'planned',
  } as never);
  return part._id;
}

async function importEras(
  open: OpenBible,
  doc: ParsedDocument,
  record: (
    step: string,
    set: ChangeSet,
    file: SourceFile,
    createSection?: DocumentPlan['createSection'],
    notes?: string[],
  ) => Promise<unknown>,
): Promise<void> {
  const file = { fileName: doc.fileName, modifiedAt: doc.modifiedAt };
  const { eras, skipped } = erasFromBlocks(doc.blocks);
  const ctx = contextFor(open, file);
  const set = planEraDocument({
    file,
    eras,
    entries: ctx.entries,
    sources: (id) => open.repo.sourceRecords(id),
    newId: ctx.newId,
  });
  await record(`${doc.fileName}, era states by heading`, set, file, null, [
    `${eras.length} eras found by their headings.`,
  ]);
  const rest = skipped.flatMap((s) => (s.heading ? [s.heading, ...s.blocks] : s.blocks));
  if (rest.length) {
    const section = notesSection(open);
    const plan = planDocumentImport(
      open,
      doc,
      { kind: 'note', sectionId: '', title: 'East Winds: world development, other sections' },
      rest,
      section,
    );
    await record(
      `${doc.fileName}, general note for text outside the eras`,
      plan.set,
      plan.file,
      plan.createSection,
    );
  }
}

void blocksToBody;
void isBlank;
void spanOf;
