import { parseArgs } from 'node:util';
import type * as ServerModule from '../src/server/index';
import { importSource } from './import-source.ts';

/**
 * A58 (PH-23): restore one of the function's daily phone snapshots into its
 * bible through the snapshot restore (BK-2). A snapshot of the bible as it is
 * now is kept first, beside the others in `phone_snapshots`.
 *
 *   NC_MONGODB_URI="$(security find-generic-password -s novel-companion-mongodb -a novel-companion -w)" \
 *     node scripts/restore-phone-snapshot.ts <bible>           lists the bible's phone snapshots
 *     node scripts/restore-phone-snapshot.ts <bible> <id>      restores one
 *
 * Quit the desktop app first, then open the bible again, so it loads what was restored.
 */
const { positionals } = parseArgs({ allowPositionals: true });
const [bible, id] = positionals;
const uri = process.env.NC_MONGODB_URI;
if (!bible || !uri) {
  console.error('Usage: NC_MONGODB_URI=... node scripts/restore-phone-snapshot.ts <bible> [id]');
  process.exit(2);
}

const server = await importSource<typeof ServerModule>('src/server/index.ts');
const store = await server.connect(uri);
try {
  const handle = await server.openBible(store, bible);
  if (!id) {
    const list = await server.listPhoneSnapshots(handle);
    if (!list.length) console.log(`${bible} has no phone snapshots.`);
    for (const s of list)
      console.log(`${s._id}  ${s.takenAt}  ${s.reason}  version ${s.schemaVersion}`);
  } else {
    const { restored, safety } = await server.restorePhoneSnapshot(handle, id);
    console.log(`Restored ${bible} to the phone snapshot from ${restored.takenAt}.`);
    console.log(`The bible as it was is kept as phone snapshot ${safety._id}.`);
  }
} finally {
  await store.close();
}
