/**
 * Title cleanup of a bible (East Winds), PL-3. Run with
 * `node scripts/clean-titles-eastwinds.ts <mode>`:
 *
 * - `report`: read-only. Lists the book, part, and chapter titles that repeat
 *   a structural number ("Ch. 3: ...", "Part One: ..."), which would be
 *   renamed, which disagree with the entry's place, and which are only a number.
 * - `rehearse`: copies the bible from the cluster (read-only) into a throwaway
 *   local one-node replica set, applies the cleanup there, and checks the result.
 * - `apply`: takes a manual snapshot through the app's backup code, then
 *   applies the cleanup to the real bible through `Repository.writeBatch`, and
 *   checks the result.
 *
 * The check compares a dump from before with one from after: only titles of
 * books, parts, and chapters may change, open questions may be added, and the
 * revisions collection grows by one per write. Anything else fails loudly.
 *
 * Like audit-eastwinds.ts it bundles itself with esbuild, reads the connection
 * string from the macOS keychain, and never prints it.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Document } from 'mongodb';
import type { Store } from '../src/main/db/connection';
import type { OpenBible } from '../src/main/db/session';
import type { CollectionDocs } from '../src/main/backup/dump';

const SNAPSHOT_LABEL = 'Before the title cleanup 2026-10-11';
const NOTE =
  'Title cleanup 2026-10-11: the number is kept in the number field or reading order (PL-3)';
const QUESTION_TAGS = ['Audit 2026-10-11 PM', 'chapters'];

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

/**
 * What changed between two dumps of a bible, by collection: changed fields per
 * entry, entries added, entries gone. `modifiedAt` is ignored (every write sets it).
 */
function diffDumps(
  before: CollectionDocs,
  after: CollectionDocs,
): { problems: string[]; summary: Record<string, string> } {
  const problems: string[] = [];
  const summary: Record<string, string> = {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    const a = new Map((before[name] ?? []).map((d: Document) => [String(d._id), d]));
    const b = new Map((after[name] ?? []).map((d: Document) => [String(d._id), d]));
    const added = [...b.keys()].filter((k) => !a.has(k));
    const gone = [...a.keys()].filter((k) => !b.has(k));
    const fields = new Map<string, number>();
    for (const [id, d] of a) {
      const n = b.get(id);
      if (!n) continue;
      for (const k of new Set([...Object.keys(d), ...Object.keys(n)])) {
        if (k === 'modifiedAt') continue;
        if (JSON.stringify(d[k]) === JSON.stringify(n[k])) continue;
        // The write path fills a field an older entry lacks with its schema default (false, null, empty).
        const filled =
          d[k] === undefined &&
          [false, null, '', '[]'].includes(Array.isArray(n[k]) ? JSON.stringify(n[k]) : n[k]);
        const key = filled ? `${k} (default filled in)` : k;
        fields.set(key, (fields.get(key) ?? 0) + 1);
      }
    }
    if (!added.length && !gone.length && !fields.size) continue;
    summary[name] =
      `added ${added.length}, removed ${gone.length}, changed fields ${JSON.stringify(Object.fromEntries(fields))}`;
    if (gone.length) problems.push(`${name}: ${gone.length} documents removed`);
    const titled = ['books', 'parts', 'chapters'].includes(name);
    if (titled && added.length) problems.push(`${name}: ${added.length} documents added`);
    if (
      titled &&
      [...fields.keys()].some((k) => k !== 'title' && !k.endsWith('(default filled in)'))
    )
      problems.push(`${name}: fields other than title changed`);
    if (!titled && fields.size && name !== 'meta')
      problems.push(`${name}: existing documents changed (${[...fields.keys()].join(', ')})`);
    if (!titled && added.length && !['openQuestions', 'revisions'].includes(name))
      problems.push(`${name}: ${added.length} documents added`);
  }
  return { problems, summary };
}

async function runCleanup(open: OpenBible): Promise<void> {
  const { dumpBible } = await import('../src/main/backup/dump');
  const { applyTitleCleanup } = await import('../src/main/import/titleCleanup');
  const before = (await dumpBible(open.handle)).collections;
  const result = await applyTitleCleanup(open, { note: NOTE, questionTags: QUESTION_TAGS });
  console.log(
    `Renamed: books ${result.renamed.books}, parts ${result.renamed.parts}, chapters ${result.renamed.chapters}; open questions written ${result.questions}; left as only a number ${result.plan.numberOnly.length}.`,
  );
  // Re-read from the database, not the in-memory model.
  const after = (await dumpBible(open.handle)).collections;
  const { problems, summary } = diffDumps(before, after);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  const titles = new Map(
    ['books', 'parts', 'chapters'].flatMap((c) =>
      (after[c] ?? []).map((d: Document) => [String(d._id), String(d.title)] as const),
    ),
  );
  for (const r of result.plan.renames) {
    if (titles.get(r.id) !== r.to)
      problems.push(`${r.id} reads "${titles.get(r.id)}", not "${r.to}"`);
  }
  const revs = (after.revisions ?? []).length - (before.revisions ?? []).length;
  const expected = result.plan.renames.length + result.questions;
  if (revs !== expected) problems.push(`revisions grew by ${revs}, expected ${expected}`);
  if (problems.length) throw new Error(`The check failed:\n  ${problems.join('\n  ')}`);
  console.log(
    `Check passed: only titles changed, ${result.questions} questions added, ${revs} revisions written.`,
  );
}

export async function main(argv: string[]): Promise<void> {
  const [mode] = argv;
  if (!mode || !['report', 'rehearse', 'apply'].includes(mode)) {
    throw new Error('Use: report | rehearse | apply');
  }
  const bibleId = 'eastwinds';
  const { connect } = await import('../src/main/db/connection');
  const { openBible } = await import('../src/main/db/bibles');
  const { mongoUri } = await import('../src/main/secrets');
  const { planTitleCleanup } = await import('../src/shared/domain/numbering');
  const lookup = mongoUri(process.env, { isPackaged: false });
  if (!lookup.ok) throw new Error(lookup.message);
  const store = await connect(lookup.uri);
  try {
    if (mode === 'report') {
      const open = await openAsIs(store, bibleId);
      const plan = planTitleCleanup(open.model);
      for (const r of plan.renames)
        console.log(`rename ${r.collection} ${r.id}: "${r.from}" -> "${r.to}"`);
      for (const d of plan.disagreements)
        console.log(
          `disagrees ${d.collection} ${d.id}: "${d.title}" says ${d.says}, is at ${d.is}`,
        );
      for (const d of plan.numberOnly)
        console.log(`only a number ${d.collection} ${d.id}: "${d.title}"`);
      console.log(
        `Renames ${plan.renames.length}, disagreements ${plan.disagreements.length}, only a number ${plan.numberOnly.length}.`,
      );
      return;
    }
    if (mode === 'rehearse') {
      const { MongoMemoryReplSet } = await import('mongodb-memory-server');
      const { dumpBible, replaceBible } = await import('../src/main/backup/dump');
      const { createBible } = await import('../src/main/db/bibles');
      const dump = await dumpBible(await openBible(store, bibleId));
      const server = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
      });
      const local = await connect(server.getUri());
      try {
        const handle = await createBible(local, bibleId, dump.bible.name);
        await replaceBible(handle, dump.collections, dump.bible.schemaVersion);
        console.log('Rehearsal on a local copy:');
        await runCleanup(await openAsIs(local, bibleId));
        // Running it a second time finds nothing left to do.
        const second = planTitleCleanup((await openAsIs(local, bibleId)).model);
        console.log(
          `Second plan on the copy: renames ${second.renames.length}, disagreements ${second.disagreements.length}.`,
        );
      } finally {
        await local.close();
        await server.stop();
      }
      return;
    }
    const open = await openAsIs(
      store,
      bibleId,
      join(homedir(), 'Library', 'Application Support', 'Novel Companion', 'snapshots'),
    );
    if (!open.snapshots) throw new Error('No snapshot folder.');
    const snap = await open.snapshots.take('manual', SNAPSHOT_LABEL);
    console.log(`Snapshot "${SNAPSHOT_LABEL}" taken: ${snap.id}`);
    await runCleanup(open);
  } finally {
    await store.close();
  }
}

if (!import.meta.url.endsWith('.mjs')) {
  const { build } = await import('esbuild');
  const root = join(import.meta.dirname, '..');
  const outDir = join(root, 'node_modules/.cache/clean-titles-eastwinds');
  const outfile = join(outDir, 'run.mjs');
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts/clean-titles-eastwinds.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'error',
  });
  const mod = (await import(pathToFileURL(outfile).href)) as {
    main: (a: string[]) => Promise<void>;
  };
  await mod.main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
