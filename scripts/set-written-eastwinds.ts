/**
 * Sets which East Winds chapters are written (2026-10-11), and moves the
 * chapter-1 manuscript text to "Mark Meets Dawn" if another chapter holds it.
 * Run with `node scripts/set-written-eastwinds.ts <mode>`:
 *
 * - `report`: read-only. Prints the written chapters, the chapters that hold
 *   manuscript text, the three named chapters, and the chapter-1 open question.
 * - `apply`: takes a manual snapshot, then writes through
 *   `Repository.writeBatch` with a revision note, and checks the result.
 *
 * Bundles itself with esbuild like audit-eastwinds.ts; the connection string
 * comes from the keychain and is never printed.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from '../src/main/db/connection';
import type { OpenBible } from '../src/main/db/session';

const SNAPSHOT_LABEL = 'Before setting the written chapters 2026-10-11';
const NOTE =
  'Tommy, 2026-10-11: written so far are the Introduction and Mark Meets Dawn (unfinished)';
const QUESTION_ID = '01M4PED5CJH3794RKY8VCZ0TS5';
const DECISION =
  'Mark Meets Dawn. Tommy, 2026-10-11: the chapters written so far are the Introduction and Mark Meets Dawn, and Mark Meets Dawn is not finished.';

type Doc = Record<string, unknown> & { _id: string };

async function openAsIs(store: Store, id: string, snapshotRoot?: string): Promise<OpenBible> {
  const { openBible } = await import('../src/main/db/bibles');
  const { ReadModel } = await import('../src/main/readmodel');
  const { SearchIndex } = await import('../src/main/search');
  const { Repository } = await import('../src/main/db/repository');
  const { SnapshotService } = await import('../src/main/backup/snapshots');
  const handle = await openBible(store, id);
  const model = new ReadModel();
  await model.load(handle);
  const search = new SearchIndex();
  search.rebuild(model);
  const repo = new Repository(handle, model, search);
  const open: OpenBible = { handle, model, search, repo };
  if (snapshotRoot)
    open.snapshots = new SnapshotService(handle, snapshotRoot, () => repo.snapshotKeep());
  return open;
}

const live = (open: OpenBible, c: 'chapters' | 'parts' | 'openQuestions'): Doc[] =>
  (open.model.all(c) as Doc[]).filter((d) => !d.deletedAt);
const hasText = (c: Doc): boolean => String(c.manuscriptText ?? '').trim() !== '';
const line = (c: Doc, parts: Map<string, string>): string => {
  const strands = (c.strands as { label: string; primary: boolean }[])
    .map((s) => `${s.label}${s.primary ? '*' : ''}`)
    .join(', ');
  return `${c._id} order ${c.readingOrder} "${c.title}" part "${parts.get(String(c.partId))}" written ${c.written} status ${c.status} textLen ${String(c.manuscriptText ?? '').length} source ${c.manuscriptSource} file ${c.sourceFile} sourceRef "${c.sourceRef}" summaryLen ${String(c.summary ?? '').length} outOfDate ${c.summaryOutOfDate} strands [${strands}]`;
};

function report(open: OpenBible): void {
  const parts = new Map(live(open, 'parts').map((p) => [p._id, String(p.title)]));
  const chapters = live(open, 'chapters').sort(
    (a, b) => Number(a.readingOrder) - Number(b.readingOrder),
  );
  console.log(`Chapters (live): ${chapters.length}`);
  console.log('Written = true:');
  for (const c of chapters.filter((c) => c.written)) console.log('  ' + line(c, parts));
  console.log('Hold manuscript text:');
  for (const c of chapters.filter(hasText)) console.log('  ' + line(c, parts));
  for (const t of ['Introduction', 'Mark Meets Dawn', 'Mark Feels Free']) {
    const m = chapters.filter((c) => c.title === t);
    console.log(`Titled "${t}": ${m.length}`);
    for (const c of m) console.log('  ' + line(c, parts));
  }
  const q = open.model.get('openQuestions', QUESTION_ID) as Doc | undefined;
  console.log(q ? `Question ${q._id}: state ${q.state}\n  ${q.title}\n  ${q.question}\n  decision: "${q.decision}"` : `Question ${QUESTION_ID} NOT FOUND`);
}

async function counts(open: OpenBible): Promise<Record<string, string>> {
  const { dumpBible } = await import('../src/main/backup/dump');
  const dump = (await dumpBible(open.handle)).collections;
  const out: Record<string, string> = {};
  for (const [name, docs] of Object.entries(dump)) {
    const max = docs.reduce((m: string, d: Record<string, unknown>) => {
      const v = d.modifiedAt ? String(d.modifiedAt instanceof Date ? d.modifiedAt.toISOString() : d.modifiedAt) : '';
      return v > m ? v : m;
    }, '');
    out[name] = `${docs.length} docs, latest modifiedAt ${max}`;
  }
  return out;
}

async function apply(open: OpenBible): Promise<void> {
  const chapters = live(open, 'chapters');
  const intro = chapters.filter((c) => c.title === 'Introduction');
  const dawn = chapters.filter((c) => c.title === 'Mark Meets Dawn');
  if (intro.length !== 1) throw new Error(`Expected one Introduction, found ${intro.length}.`);
  if (dawn.length !== 1) throw new Error(`Expected one Mark Meets Dawn, found ${dawn.length}.`);
  const q = open.model.get('openQuestions', QUESTION_ID) as Doc | undefined;
  if (!q) throw new Error(`No open question ${QUESTION_ID}.`);
  const holders = chapters.filter((c) => hasText(c) && c._id !== intro[0]._id);
  if (holders.length > 1) throw new Error(`${holders.length} non-Introduction chapters hold text.`);
  const ops: { op: 'update'; collection: 'chapters' | 'openQuestions'; id: string; patch: Record<string, unknown> }[] = [];
  // sourceRef on these chapters is the plan sheet's row reference, not the manuscript's, so it stays.
  const wrong = holders.find((h) => h._id !== dawn[0]._id);
  if (wrong) {
    if (hasText(dawn[0])) throw new Error('Mark Meets Dawn already holds text and so does another chapter.');
    ops.push({
      op: 'update', collection: 'chapters', id: dawn[0]._id,
      patch: {
        manuscriptText: wrong.manuscriptText,
        manuscriptSource: wrong.manuscriptSource,
        sourceFile: wrong.sourceFile,
        ...(String(wrong.summary ?? '').trim()
          ? { summary: wrong.summary, summaryOutOfDate: false }
          : {}),
      },
    });
    ops.push({
      op: 'update', collection: 'chapters', id: wrong._id,
      patch: {
        manuscriptText: '', manuscriptSource: null, sourceFile: null,
        ...(String(wrong.summary ?? '').trim() ? { summary: '', summaryOutOfDate: false } : {}),
      },
    });
  }
  for (const c of chapters) {
    const want = c._id === intro[0]._id;
    if (Boolean(c.written) !== want) {
      const prior = ops.find((o) => o.id === c._id);
      if (prior) prior.patch.written = want;
      else ops.push({ op: 'update', collection: 'chapters', id: c._id, patch: { written: want } });
    }
  }
  ops.push({
    op: 'update', collection: 'openQuestions', id: QUESTION_ID,
    patch: { state: 'decided', decision: DECISION },
  });
  console.log(`Writing ${ops.length} updates.`);
  await open.repo.writeBatch(ops, { note: NOTE });
}

export async function main(argv: string[]): Promise<void> {
  const [mode] = argv;
  if (!mode || !['report', 'apply'].includes(mode)) throw new Error('Use: report | apply');
  const { connect } = await import('../src/main/db/connection');
  const { mongoUri } = await import('../src/main/secrets');
  const lookup = mongoUri(process.env, { isPackaged: false });
  if (!lookup.ok) throw new Error(lookup.message);
  const store = await connect(lookup.uri);
  try {
    if (mode === 'report') {
      report(await openAsIs(store, 'eastwinds'));
      return;
    }
    const open = await openAsIs(
      store,
      'eastwinds',
      join(homedir(), 'Library', 'Application Support', 'Novel Companion', 'snapshots'),
    );
    if (!open.snapshots) throw new Error('No snapshot folder.');
    report(open);
    const before = await counts(open);
    const snap = await open.snapshots.take('manual', SNAPSHOT_LABEL);
    console.log(`Snapshot "${SNAPSHOT_LABEL}" taken: ${snap.id}`);
    await apply(open);
    const fresh = await openAsIs(store, 'eastwinds');
    console.log('--- After ---');
    report(fresh);
    const after = await counts(fresh);
    for (const k of Object.keys({ ...before, ...after }))
      console.log(`${before[k] === after[k] ? 'same   ' : 'CHANGED'} ${k}: ${before[k]} -> ${after[k]}`);
  } finally {
    await store.close();
  }
}

if (!import.meta.url.endsWith('.mjs')) {
  const { build } = await import('esbuild');
  const root = join(import.meta.dirname, '..');
  const outDir = join(root, 'node_modules/.cache/set-written-eastwinds');
  const outfile = join(outDir, 'run.mjs');
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts/set-written-eastwinds.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'error',
  });
  const mod = (await import(pathToFileURL(outfile).href)) as { main: (a: string[]) => Promise<void> };
  await mod.main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
