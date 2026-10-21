import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, listBibles } from '../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../src/main/db/session';
import { isLocalMongoUri, mongoUri } from '../src/main/secrets';
import { importEastWinds } from '../src/main/import/eastwinds';
import type { StepChanges } from '../src/main/import/eastwinds';
import { collectionInfo } from '../src/shared/schema';
import type { EntryCollection } from '../src/shared/schema';

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
  yes: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    dir: resolve('source-material'),
    bible: 'eastwinds',
    snapshots: DEFAULT_SNAPSHOT_ROOT,
    dryRun: true,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--dir') args.dir = resolve(argv[++i] ?? '');
    else if (a === '--bible') args.bible = argv[++i] ?? args.bible;
    else if (a === '--snapshots') args.snapshots = resolve(argv[++i] ?? '');
    else
      throw new Error(
        `Unknown option ${String(a)}. Use --yes, --dry-run, --dir, --bible, or --snapshots.`,
      );
  }
  // A dry run unless told to apply (A39): --yes writes, after a snapshot.
  args.dryRun = !args.yes;
  return args;
}

function printChanges(changes: StepChanges | undefined): void {
  if (!changes) return;
  if (changes.created.count) {
    const shown = changes.created.titles.join('; ');
    const more = changes.created.count - changes.created.titles.length;
    console.log(
      `  new (${changes.created.count}): ${shown}${more > 0 ? `; and ${more} more` : ''}`,
    );
  }
  for (const c of changes.changed) {
    console.log(`  changed: ${c.title} (${c.ref})`);
    for (const f of c.fields) {
      console.log(
        `    ${f.label}: ${f.before} -> ${f.after}${f.kept ? ' (not applied, the current value is newer)' : ''}`,
      );
    }
  }
}

/** The sections the report always totals, in this order, then any other the run touched. */
const REPORTED: EntryCollection[] = ['chapters', 'worldEvents', 'moments', 'characters'];

/**
 * `npm run import:eastwinds`: compare the East Winds workbook and Word
 * documents with the bible and print what would change, the counts per
 * section, and every failed row. Nothing is written without `--yes`, which
 * takes a snapshot first. It never prints the connection string.
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
    // A dry run never migrates the cluster: it stops with a plain message when migrations are pending.
    const open = await openBibleSession(store, args.bible, {
      snapshotRoot: args.snapshots,
      readOnly: args.dryRun,
    });
    console.log(
      `${args.dryRun ? 'Dry run (nothing is written)' : 'Importing'} into the bible "${args.bible}" from ${args.dir}`,
    );
    const report = await importEastWinds(open, args.dir, {
      dryRun: args.dryRun,
      yes: args.yes,
      log: (line) => console.log(line),
    });
    let failed = 0;
    for (const step of report.steps) {
      console.log(
        `\n${step.step}\n  created ${step.created}, updated ${step.updated}, unchanged ${step.unchanged}, open questions ${step.questions}, failed ${step.failed.length}`,
      );
      for (const note of step.notes) console.log(`  note: ${note}`);
      printChanges(step.changes);
      for (const f of step.failed) console.log(`  failed: ${f.where}: ${f.reason}`);
      failed += step.failed.length;
    }
    const total = (key: 'created' | 'updated' | 'unchanged' | 'questions') =>
      report.steps.reduce((n, s) => n + s[key], 0);
    console.log(
      `\nTotal: created ${total('created')}, updated ${total('updated')}, unchanged ${total('unchanged')}, open questions ${total('questions')}, failed rows ${failed}.`,
    );
    const bySection = new Map<EntryCollection, { created: number; updated: number }>();
    for (const step of report.steps) {
      for (const [c, t] of Object.entries(step.touched) as [
        EntryCollection,
        { created: number; updated: number },
      ][]) {
        const sum = bySection.get(c) ?? { created: 0, updated: 0 };
        bySection.set(c, { created: sum.created + t.created, updated: sum.updated + t.updated });
      }
    }
    const sections = [...REPORTED, ...[...bySection.keys()].filter((c) => !REPORTED.includes(c))];
    const verb = report.dryRun || report.held ? 'would be' : 'were';
    console.log(`Entries that ${verb} made or changed, by section:`);
    for (const c of sections) {
      const t = bySection.get(c) ?? { created: 0, updated: 0 };
      console.log(`  ${collectionInfo[c].plural}: ${t.created} new, ${t.updated} changed`);
    }
    if (report.dryRun) {
      console.log('\nThis was a dry run: nothing was written. Run again with --yes to apply it.');
    }
    if (report.held) {
      console.log(
        `\nThe bible "${args.bible}" already holds imported entries, so nothing was written. Review the changes above, then run again with --yes to apply them.`,
      );
    }
    if (report.snapshot)
      console.log(
        `Snapshot before the import: ${join(args.snapshots, args.bible, report.snapshot)}`,
      );
  } finally {
    await store.close();
  }
}
