/**
 * Characters-present audit of a bible (East Winds by default). Run with
 * `node scripts/audit-characters-present-eastwinds.ts <mode> <file>`:
 *
 * - `report <out.json>`: read-only. Opens the bible without migrating it and
 *   writes the chapters (strands, summaries, manuscript text), parts, arcs,
 *   beats and characters to a JSON file for review.
 * - `apply <plan.json>`: takes a manual snapshot through the app's backup
 *   code, then applies the plan to the real bible through
 *   `Repository.writeBatch`, so every change carries a revision.
 *
 * A plan only replaces chapters' `strands` arrays and creates open questions;
 * anything else is refused. Plan shape:
 * `{ "chapters": [{ id, strands }], "questions": [{ title, question, tags, links }] }`.
 *
 * Bundled with esbuild like audit-eastwinds.ts. The connection string comes
 * from the macOS keychain and is never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from '../src/main/db/connection';
import type { OpenBible } from '../src/main/db/session';

const SNAPSHOT_LABEL = 'Before the characters present audit 2026-10-12';
const NOTE = 'Characters present audit 2026-10-12';

interface Plan {
  chapters: { id: string; strands: Record<string, unknown>[] }[];
  questions: {
    title: string;
    question: string;
    tags: string[];
    links: { targetId: string; kind: string }[];
  }[];
}

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
  if (!mode || !['report', 'apply'].includes(mode) || !file) {
    throw new Error('Use: report <out.json> | apply <plan.json>');
  }
  const bibleId = 'eastwinds';
  const { connect } = await import('../src/main/db/connection');
  const { mongoUri } = await import('../src/main/secrets');
  const lookup = mongoUri(process.env, { isPackaged: false });
  if (!lookup.ok) throw new Error(lookup.message);
  const store = await connect(lookup.uri);
  try {
    if (mode === 'report') {
      const open = await openAsIs(store, bibleId);
      const m = open.model;
      const live = (c: string) => m.all(c).filter((d) => !d.deletedAt);
      const out = {
        parts: live('parts'),
        chapters: live('chapters'),
        arcs: live('arcs'),
        beats: live('plotBeats'),
        characters: live('characters').map((c) => ({
          _id: c._id,
          names: c.names,
          title: c.title,
          birth: c.birth,
          death: c.death,
          familyIds: c.familyIds,
          status: c.status,
          summary: c.summary,
          role: c.role,
        })),
        questions: live('openQuestions').map((q) => ({
          _id: q._id,
          title: q.title,
          tags: q.tags,
          links: q.links,
          state: q.state,
        })),
      };
      writeFileSync(resolve(file), JSON.stringify(out, null, 1));
      console.log(
        `Report written: parts ${out.parts.length}, chapters ${out.chapters.length}, arcs ${out.arcs.length}, beats ${out.beats.length}, characters ${out.characters.length}, questions ${out.questions.length}.`,
      );
      return;
    }
    const plan = JSON.parse(readFileSync(resolve(file), 'utf8')) as Plan;
    const open = await openAsIs(
      store,
      bibleId,
      join(homedir(), 'Library', 'Application Support', 'Novel Companion', 'snapshots'),
    );
    const { model, repo } = open;
    for (const c of plan.chapters) {
      if (!model.get('chapters', c.id)) throw new Error(`No chapter ${c.id}.`);
      for (const s of c.strands) {
        for (const id of [s.povCharacterId, ...((s.characterIds as string[]) ?? [])]) {
          if (id && !model.get('characters', String(id)))
            throw new Error(
              `Strand ${String(s.id)} of ${c.id} names ${String(id)}, not a character.`,
            );
        }
      }
    }
    for (const q of plan.questions) {
      for (const l of q.links) {
        if (!model.find(l.targetId))
          throw new Error(`A link targets ${l.targetId}, which is not in the bible.`);
      }
    }
    if (!open.snapshots) throw new Error('No snapshot folder.');
    const snap = await open.snapshots.take('manual', SNAPSHOT_LABEL);
    console.log(`Snapshot "${SNAPSHOT_LABEL}" taken: ${snap.id}`);
    const ops = [
      ...plan.chapters.map((c) => ({
        op: 'update' as const,
        collection: 'chapters' as const,
        id: c.id,
        patch: { strands: c.strands },
      })),
      ...plan.questions.map((q) => ({
        op: 'create' as const,
        collection: 'openQuestions' as const,
        data: {
          title: q.title,
          question: q.question,
          tags: q.tags,
          links: q.links,
          status: 'planned',
          state: 'open',
        },
      })),
    ];
    await repo.writeBatch(ops, { note: NOTE });
    console.log(
      `Applied: ${plan.chapters.length} chapters updated, ${plan.questions.length} questions created.`,
    );
  } finally {
    await store.close();
  }
}

if (!import.meta.url.endsWith('.mjs')) {
  const { build } = await import('esbuild');
  const root = join(import.meta.dirname, '..');
  const outDir = join(root, 'node_modules/.cache/audit-characters-present');
  const outfile = join(outDir, 'run.mjs');
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts/audit-characters-present-eastwinds.ts')],
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
