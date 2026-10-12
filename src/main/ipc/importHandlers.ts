import { writeFile, readFile } from 'node:fs/promises';
import { monotonicFactory } from 'ulid';
import {
  guessHeaderRow,
  guessMapping,
  guessShape,
  importableFields,
  mappingKey,
  shownValue,
} from '../../shared/domain/import';
import type {
  ChangeSet,
  DocumentTarget,
  Mapping,
  ParsedWorkbook,
  SourceFile,
} from '../../shared/domain/import';
import { blocksToBody } from '../../shared/domain/import';
import { createBible, dropBible } from '../db/bibles';
import type { OpenBible } from '../db/session';
import { exportBibleJson, importBibleJson, readBibleFile } from '../backup/json';
import { restoreSnapshot } from '../backup/restore';
import { parseDocxFile } from '../import/docx';
import type { ParsedDocument } from '../import/docx';
import { parseWorkbookFile } from '../import/xlsx';
import { rememberDocument } from '../import/pickedDocuments';
import { applyPlan, planDocumentImport, planSheet, planView } from '../import/run';
import type { DocumentPlan } from '../import/run';
import type { Channel } from '../../shared/ipc';
import { entryTitle } from '../../shared/schema';
import type { CustomSection } from '../../shared/schema';
import type { Handler } from './validate';

/** What the import and backup channels need from the host, so tests can supply their own. */
export interface ImportDeps {
  /** Ask the person for a file. Null when cancelled. */
  pickFile?: (kind: 'workbook' | 'document') => Promise<string | null>;
  /** Ask where to write the export. Null when cancelled. */
  pickSavePath?: (defaultName: string) => Promise<string | null>;
  /** Ask for an exported bible file to read. Null when cancelled. */
  pickBibleFile?: () => Promise<string | null>;
  /**
   * GD-2: receives the bridge through which another source (Google Drive)
   * hands an already-read file to this same pipeline: mapping, preview,
   * compare, and apply, exactly as for a picked file.
   */
  bridge?: (bridge: ImportBridge) => void;
  /** GD-3: told after the person applied (or declined) a comparison of a file that has an origin. */
  onApplied?: (origin: string) => Promise<void> | void;
}

/** A parsed file from elsewhere, registered as if it had been picked. */
export interface ImportBridge {
  adopt(
    source:
      | { kind: 'workbook'; workbook: ParsedWorkbook }
      | { kind: 'document'; document: ParsedDocument },
    origin: string,
  ): { id: string; name: string; kind: 'workbook' | 'document'; modifiedAt: string };
}

export type ImportChannel =
  | 'import.pickFile'
  | 'import.workbook'
  | 'import.guess'
  | 'import.fields'
  | 'import.preview'
  | 'import.plan'
  | 'import.apply'
  | 'import.document'
  | 'import.documentPlan'
  | 'snapshot.list'
  | 'snapshot.take'
  | 'snapshot.restore'
  | 'snapshot.keep'
  | 'backup.export'
  | 'backup.import';

export type ImportHandlers = { [C in ImportChannel]: Handler<C & Channel> };

const NO_BIBLE = 'Open a bible first.';
const newId = monotonicFactory();

type Picked = (
  | { id: string; path: string; kind: 'workbook'; workbook: ParsedWorkbook }
  | { id: string; path: string; kind: 'document'; document: ParsedDocument }
) & { origin?: string };

type StoredPlan = {
  id: string;
  set: ChangeSet;
  file: SourceFile;
  mapping: Mapping | null;
  createSection: DocumentPlan['createSection'];
  /** Where the file came from, when not a local pick (GD-3). */
  origin?: string;
};

function wireFile(p: Picked) {
  const source = p.kind === 'workbook' ? p.workbook : p.document;
  return { id: p.id, name: source.fileName, kind: p.kind, modifiedAt: source.modifiedAt };
}

export function importHandlers(current: () => OpenBible | null, deps: ImportDeps): ImportHandlers {
  const files = new Map<string, Picked>();
  const plans = new Map<string, StoredPlan>();
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };
  const picked = (id: string): Picked => {
    const p = files.get(id);
    if (!p) throw new Error('That file is no longer open. Choose it again.');
    return p;
  };
  const workbook = (id: string): ParsedWorkbook => {
    const p = picked(id);
    if (p.kind !== 'workbook') throw new Error('That file is not a workbook.');
    return p.workbook;
  };
  const document = (id: string): ParsedDocument => {
    const p = picked(id);
    if (p.kind !== 'document') throw new Error('That file is not a Word document.');
    return p.document;
  };
  const remember = (plan: Omit<StoredPlan, 'id'>): string => {
    const id = newId();
    plans.set(id, { ...plan, id });
    for (const old of [...plans.keys()].slice(0, Math.max(0, plans.size - 8))) plans.delete(old);
    return id;
  };
  const originOf = (fileId: string) => {
    const o = files.get(fileId)?.origin;
    return o ? { origin: o } : {};
  };
  deps.bridge?.({
    adopt(source, origin) {
      const p: Picked =
        source.kind === 'workbook'
          ? { id: newId(), path: '', kind: 'workbook', workbook: source.workbook, origin }
          : { id: newId(), path: '', kind: 'document', document: source.document, origin };
      files.set(p.id, p);
      // IM-5: Claude reads a Drive-opened document by the same ID as a picked one.
      if (p.kind === 'document') rememberDocument(p.id, p.document);
      return wireFile(p);
    },
  });
  const sectionOf = (collection: string, sectionId?: string) =>
    collection === 'customEntries' && sectionId
      ? (session().model.get('customSections', sectionId) as unknown as
          Pick<CustomSection, 'fields'> | undefined)
      : undefined;

  return {
    'import.pickFile': async ({ kind }) => {
      session();
      const path = await deps.pickFile?.(kind);
      if (!path) return { file: null };
      const p: Picked =
        kind === 'workbook'
          ? { id: newId(), path, kind, workbook: await parseWorkbookFile(path) }
          : { id: newId(), path, kind, document: await parseDocxFile(path) };
      files.set(p.id, p);
      if (p.kind === 'document') rememberDocument(p.id, p.document);
      return { file: wireFile(p) };
    },

    'import.workbook': ({ fileId }) => {
      const s = session();
      const wb = workbook(fileId);
      const saved = s.repo.savedMappings();
      return {
        file: wireFile(picked(fileId)),
        sheets: wb.sheets.map((sheet) => ({
          name: sheet.name,
          rows: sheet.cells.length,
          columns: sheet.cells[0]?.length ?? 0,
          shape: guessShape(sheet),
          headerRow: guessHeaderRow(sheet),
          preview: sheet.cells.slice(0, 12).map((r) => r.slice(0, 12)),
        })),
        saved: wb.sheets.flatMap((sheet) => {
          const m = saved[mappingKey(wb.fileName, sheet.name)];
          return m ? [{ sheet: sheet.name, mapping: m as Mapping }] : [];
        }),
      };
    },

    'import.guess': ({ fileId, sheet, shape, collection, sectionId }) => {
      const wb = workbook(fileId);
      const found = wb.sheets.find((x) => x.name === sheet);
      if (!found) throw new Error(`The workbook has no sheet called ${sheet}.`);
      return {
        mapping: guessMapping(
          found,
          shape,
          { collection, ...(sectionId ? { sectionId } : {}) },
          sectionOf(collection, sectionId),
        ),
      };
    },

    'import.fields': ({ collection, sectionId }) => ({
      fields: importableFields(
        { collection, ...(sectionId ? { sectionId } : {}) },
        sectionOf(collection, sectionId),
      ).map((f) => ({ path: f.path, label: f.label })),
    }),

    'import.preview': ({ fileId, mapping, limit }) => {
      const s = session();
      const wb = workbook(fileId);
      const sheet = wb.sheets.find((x) => x.name === mapping.sheet);
      if (!sheet) throw new Error(`The workbook has no sheet called ${mapping.sheet}.`);
      const { output } = planSheet(s, sheet, wb, mapping);
      const catalog = importableFields(
        mapping.target,
        sectionOf(mapping.target.collection, mapping.target.sectionId),
      );
      const labels = new Map(catalog.map((f) => [f.path, f.label]));
      const rows = output.rows.filter((r) => r.kind === 'entry');
      return {
        rows: rows.slice(0, limit).map((r) => ({
          where: r.where,
          ok: r.ok,
          ...(r.ok ? {} : { reason: r.reason ?? 'The row could not be read' }),
          title: r.ok ? entryTitle(r.data) : '',
          values: Object.entries(r.fields).map(([path, value]) => ({
            label: labels.get(path) ?? path,
            text: shownValue(value),
          })),
        })),
        total: rows.length,
        ok: rows.filter((r) => r.ok).length,
        failed: rows.filter((r) => !r.ok).length,
        notes: output.notes,
      };
    },

    'import.plan': ({ fileId, mapping }) => {
      const s = session();
      const wb = workbook(fileId);
      const sheet = wb.sheets.find((x) => x.name === mapping.sheet);
      if (!sheet) throw new Error(`The workbook has no sheet called ${mapping.sheet}.`);
      const { set, file } = planSheet(s, sheet, wb, mapping);
      const id = remember({ set, file, mapping, createSection: null, ...originOf(fileId) });
      return planView(s, id, wb.fileName, set);
    },

    'import.apply': async ({ planId, approved, saveMapping }) => {
      const s = session();
      const plan = plans.get(planId);
      if (!plan) throw new Error('That comparison is out of date. Compare again.');
      const result = await applyPlan(s, plan.set, plan.file, new Set(approved), plan.createSection);
      if (saveMapping && plan.mapping) {
        await s.repo.saveMapping(mappingKey(plan.file.fileName, plan.mapping.sheet), plan.mapping);
      }
      plans.delete(planId);
      if (plan.origin) await deps.onApplied?.(plan.origin);
      const latest = s.snapshots ? (await s.snapshots.list())[0] : undefined;
      return { ...result, snapshot: latest?.id ?? null };
    },

    'import.document': ({ fileId }) => {
      const doc = document(fileId);
      return {
        file: wireFile(picked(fileId)),
        title:
          doc.blocks.find((b) => b.kind === 'heading')?.text ||
          doc.fileName.replace(/\.[^.]+$/, ''),
        headings: doc.blocks
          .filter((b) => b.kind === 'heading')
          .map((b) => ({ level: b.level, text: b.text, index: b.index })),
        paragraphs: doc.blocks.length,
        sceneBreaks: doc.blocks.filter((b) => b.kind === 'scene').length,
        body: blocksToBody(doc.blocks),
      };
    },

    'import.documentPlan': ({ fileId, target }) => {
      const s = session();
      const doc = document(fileId);
      let t: DocumentTarget;
      if (target.kind === 'backstory') t = target;
      else if (target.kind === 'note') t = { kind: 'note', sectionId: '', title: target.title };
      else if (target.chapterId) t = { kind: 'chapter', chapterId: target.chapterId };
      else if (target.title && target.partId && target.year !== undefined) {
        t = {
          kind: 'chapter',
          chapterId: null,
          title: target.title,
          partId: target.partId,
          year: target.year,
        };
      } else {
        throw new Error('A new chapter needs a title, a part, and a story year.');
      }
      const plan = planDocumentImport(s, doc, t);
      const id = remember({
        set: plan.set,
        file: plan.file,
        mapping: null,
        createSection: plan.createSection,
        ...originOf(fileId),
      });
      return planView(s, id, doc.fileName, plan.set);
    },

    'snapshot.list': async () => {
      const s = session();
      return { snapshots: (await s.snapshots?.list()) ?? [], keep: s.repo.snapshotKeep() };
    },

    'snapshot.take': async () => {
      const s = session();
      if (!s.snapshots) throw new Error('Snapshots are not set up for this bible.');
      return { snapshot: await s.snapshots.take('manual') };
    },

    'snapshot.restore': async ({ id }) => {
      return restoreSnapshot(session(), id);
    },

    'snapshot.keep': async ({ keep }) => {
      const s = session();
      const saved = await s.repo.setSnapshotKeep(keep);
      await s.snapshots?.prune();
      return { keep: saved };
    },

    'backup.export': async () => {
      const s = session();
      const { text, counts } = await exportBibleJson(s.handle);
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await deps.pickSavePath?.(`${s.handle.id}-${stamp}.json`);
      if (!path) return { path: null, counts: {} };
      await writeFile(path, text);
      return { path, counts };
    },

    'backup.import': async ({ slug, name }) => {
      const s = session();
      const path = await deps.pickBibleFile?.();
      if (!path) return { bible: null, counts: {} };
      const text = await readFile(path, 'utf8');
      const store = { client: s.handle.client, db: s.handle.db, close: async () => undefined };
      // Check the file completely before making the bible, so a bad file leaves nothing behind.
      readBibleFile(text);
      const handle = await createBible(store, slug, name);
      try {
        const docs = await importBibleJson(handle, text);
        return {
          bible: { id: slug, name },
          counts: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.length])),
        };
      } catch (e) {
        await dropBible(store, slug).catch(() => undefined);
        throw e;
      }
    },
  } as ImportHandlers;
}
