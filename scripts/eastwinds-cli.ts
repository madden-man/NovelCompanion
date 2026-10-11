import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, listBibles } from '../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../src/main/db/session';
import { isLocalMongoUri, mongoUri } from '../src/main/secrets';
import { importEastWinds } from '../src/main/import/eastwinds';

/** Where the app keeps snapshots: the same folder the desktop app uses. */
export const DEFAULT_SNAPSHOT_ROOT = join(
  homedir(),
  'Library',
  'Application Support',
  'Novel Companion',
  'snapshots',
);

interface Args {
  dir: string;
  bible: string;
  snapshots: string;
  dryRun: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    dir: resolve('source-material'),
    bible: 'eastwinds',
    snapshots: DEFAULT_SNAPSHOT_ROOT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--dir') args.dir = resolve(argv[++i] ?? '');
    else if (a === '--bible') args.bible = argv[++i] ?? args.bible;
    else if (a === '--snapshots') args.snapshots = resolve(argv[++i] ?? '');
    else
      throw new Error(
        `Unknown option ${String(a)}. Use --dry-run, --dir, --bible, or --snapshots.`,
      );
  }
  return args;
}

/**
 * `npm run import:eastwinds`: import the East Winds workbook and Word
 * documents into the bible, with a snapshot first, and print the counts and
 * every failed row. It never prints the connection string.
 */
export async function main(argv: string[]): Promise<void> {
  const args = parse(argv);
  const lookup = mongoUri(process.env, { isPackaged: false });
  if (!lookup.ok) throw new Error(lookup.message);
  const store = await connect(lookup.uri);
  try {
    const known = (await listBibles(store)).some((b) => b._id === args.bible);
    if (!known) {
      // Only a local test database may get a bible made for it; the real cluster must already have one.
      if (!isLocalMongoUri(lookup.uri)) {
        throw new Error(
          `The cluster has no bible called "${args.bible}". Make it in the app first.`,
        );
      }
      await createBibleWithDefaults(store, args.bible, 'East Winds');
    }
    const open = await openBibleSession(store, args.bible, { snapshotRoot: args.snapshots });
    console.log(
      `${args.dryRun ? 'Dry run (nothing is written)' : 'Importing'} into the bible "${args.bible}" from ${args.dir}`,
    );
    const report = await importEastWinds(open, args.dir, {
      dryRun: args.dryRun,
      log: (line) => console.log(line),
    });
    let failed = 0;
    for (const step of report.steps) {
      console.log(
        `\n${step.step}\n  created ${step.created}, updated ${step.updated}, unchanged ${step.unchanged}, open questions ${step.questions}, failed ${step.failed.length}`,
      );
      for (const note of step.notes) console.log(`  note: ${note}`);
      for (const f of step.failed) console.log(`  failed: ${f.where}: ${f.reason}`);
      failed += step.failed.length;
    }
    const total = (key: 'created' | 'updated' | 'unchanged' | 'questions') =>
      report.steps.reduce((n, s) => n + s[key], 0);
    console.log(
      `\nTotal: created ${total('created')}, updated ${total('updated')}, unchanged ${total('unchanged')}, open questions ${total('questions')}, failed rows ${failed}.`,
    );
    if (report.snapshot)
      console.log(
        `Snapshot before the import: ${join(args.snapshots, args.bible, report.snapshot)}`,
      );
  } finally {
    await store.close();
  }
}
