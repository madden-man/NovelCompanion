/**
 * Open-questions audit of a bible (East Winds by default). Run with
 * `node scripts/audit-eastwinds.ts <mode> ...`:
 *
 * - `report <out.json>`: read-only. Opens the bible without migrating it and
 *   writes every entry plus the computed checks (FT-6 tree warnings, the M8
 *   structural continuity findings, every field warning, era coverage) to a
 *   JSON file for review. Nothing is written to the database.
 * - `rehearse <plan.json>`: copies the bible from the cluster (read-only) into
 *   a throwaway local one-node replica set and applies the plan there.
 * - `apply <plan.json>`: takes a manual snapshot through the app's backup code,
 *   then applies the plan to the real bible through `Repository.writeBatch`.
 *
 * A plan only creates or updates open questions; anything else is refused.
 * Plan shape: `{ "creates": [{ title, question, tags, links }], "updates":
 * [{ id, patch }] }`.
 *
 * The file bundles itself with esbuild (as import-eastwinds.ts does) because
 * the app code uses extensionless TypeScript imports Node cannot load. The
 * connection string comes from the macOS keychain and is never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from '../src/main/db/connection';
import type { OpenBible } from '../src/main/db/session';

const SNAPSHOT_LABEL = 'Before the open-questions audit 2026-10-11';

interface Plan {
  creates: {
    title: string;
    question: string;
    tags: string[];
    links: { targetId: string; kind: string }[];
  }[];
  updates: { id: string; patch: Record<string, unknown> }[];
}

const ALLOWED_PATCH = new Set(['question', 'tags', 'links', 'state', 'decision', 'title']);

function readPlan(path: string): Plan {
  const plan = JSON.parse(readFileSync(resolve(path), 'utf8')) as Plan;
  for (const u of plan.updates) {
    for (const k of Object.keys(u.patch)) {
      if (!ALLOWED_PATCH.has(k))
        throw new Error(`The plan patches ${k} on ${u.id}; only open question fields may change.`);
    }
  }
  return plan;
}

async function applyPlan(
  open: OpenBible,
  plan: Plan,
): Promise<{ created: number; updated: number; decided: number }> {
  const { repo, model } = open;
  for (const u of plan.updates) {
    if (!model.get('openQuestions', u.id)) throw new Error(`No open question ${u.id}.`);
  }
  const ops = [
    ...plan.creates.map((c) => ({
      op: 'create' as const,
      collection: 'openQuestions' as const,
      data: {
        title: c.title,
        question: c.question,
        tags: c.tags,
        links: c.links,
        status: 'planned',
        state: 'open',
      },
    })),
    ...plan.updates.map((u) => ({
      op: 'update' as const,
      collection: 'openQuestions' as const,
      id: u.id,
      patch: u.patch,
    })),
  ];
  for (const o of ops) {
    const links =
      (o.op === 'create' ? o.data.links : (o.patch.links as { targetId: string }[] | undefined)) ??
      [];
    for (const l of links) {
      if (!model.find(l.targetId))
        throw new Error(`A link targets ${l.targetId}, which is not in the bible.`);
    }
  }
  await repo.writeBatch(ops, { note: 'Open-questions audit 2026-10-11 PM' });
  return {
    created: plan.creates.length,
    updated: plan.updates.length,
    decided: plan.updates.filter((u) => u.patch.state === 'decided').length,
  };
}

/**
 * Open a bible as openBibleSession does but without migrating it, so the
 * audit never changes the recorded schema version under an older installed
 * app. The schema change the audit could meet (8: a findings index) does not
 * touch open questions.
 */
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

export async function main(argv: string[]): Promise<void> {
  const [mode, file] = argv;
  if (!mode || !['report', 'rehearse', 'apply'].includes(mode) || !file) {
    throw new Error('Use: report <out.json> | rehearse <plan.json> | apply <plan.json>');
  }
  const bibleId = 'eastwinds';
  const { connect } = await import('../src/main/db/connection');
  const { openBible } = await import('../src/main/db/bibles');
  const { mongoUri } = await import('../src/main/secrets');
  const lookup = mongoUri(process.env, { isPackaged: false });
  if (!lookup.ok) throw new Error(lookup.message);
  const store = await connect(lookup.uri);
  try {
    if (mode === 'report') {
      const open = await openAsIs(store, bibleId);
      const { ENTRY_COLLECTIONS } = await import('../src/shared/schema');
      const { buildGraph, treeWarnings } = await import('../src/shared/domain/tree');
      const { structuralFindings } = await import('../src/shared/domain/continuity/structural');
      const { eraSpans, eraCoverage, coverageMessages } =
        await import('../src/shared/domain/timeline');
      const m = open.model;
      const entries: Record<string, unknown[]> = {};
      const warnings: {
        collection: string;
        id: string;
        title: string;
        path: string;
        code: string;
        message: string;
      }[] = [];
      for (const c of ENTRY_COLLECTIONS) {
        entries[c] = m.all(c);
        for (const d of m.all(c)) {
          if (d.deletedAt) continue;
          for (const w of open.repo.warnings(c, d)) {
            warnings.push({ collection: c, id: d._id, title: String(d.title ?? ''), ...w });
          }
        }
      }
      const graph = buildGraph(m.all('characters'), m.all('unions'), m.all('parentLinks'));
      const out = {
        entries,
        lists: m.all('lists'),
        treeWarnings: treeWarnings(graph),
        structural: structuralFindings(m),
        eraCoverage: coverageMessages(eraCoverage(eraSpans(m))),
        warnings,
      };
      writeFileSync(resolve(file), JSON.stringify(out, null, 1));
      console.log(
        `Report written. ${Object.entries(entries)
          .map(([k, v]) => `${k} ${v.length}`)
          .join(
            ', ',
          )}; tree warnings ${out.treeWarnings.length}; structural ${out.structural.length}; field warnings ${warnings.length}.`,
      );
      return;
    }
    const plan = readPlan(file);
    console.log(`Plan: ${plan.creates.length} new questions, ${plan.updates.length} updates.`);
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
        const open = await openAsIs(local, bibleId);
        const before = open.model.all('openQuestions').length;
        const r = await applyPlan(open, plan);
        const after = open.model.all('openQuestions');
        const tagged = after.filter((q) =>
          (q.tags as string[]).includes('Audit 2026-10-11 PM'),
        ).length;
        const decided = after.filter((q) => q.state === 'decided').length;
        console.log(
          `Rehearsal: open questions ${before} -> ${after.length}; created ${r.created}, updated ${r.updated} (${r.decided} marked decided); tagged PM ${tagged}; decided in all ${decided}.`,
        );
      } finally {
        await local.close();
        await server.stop();
      }
      return;
    }
    // apply
    const open = await openAsIs(
      store,
      bibleId,
      join(homedir(), 'Library', 'Application Support', 'Novel Companion', 'snapshots'),
    );
    if (!open.snapshots) throw new Error('No snapshot folder.');
    const snap = await open.snapshots.take('manual', SNAPSHOT_LABEL);
    console.log(`Snapshot "${SNAPSHOT_LABEL}" taken: ${snap.id}`);
    const before = open.model.all('openQuestions').length;
    const r = await applyPlan(open, plan);
    console.log(
      `Applied: open questions ${before} -> ${open.model.all('openQuestions').length}; created ${r.created}, updated ${r.updated} (${r.decided} marked decided).`,
    );
  } finally {
    await store.close();
  }
}

if (!import.meta.url.endsWith('.mjs')) {
  const { build } = await import('esbuild');
  const root = join(import.meta.dirname, '..');
  const outDir = join(root, 'node_modules/.cache/audit-eastwinds');
  const outfile = join(outDir, 'run.mjs');
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts/audit-eastwinds.ts')],
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
