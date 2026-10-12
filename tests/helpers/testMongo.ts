import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Set to 0 to keep the test server's data on the ordinary disk. */
export const RAM_DISK_ENV = 'NC_TEST_RAM_DISK';
const PREFIX = 'nc-test-mongo-';

/**
 * A RAM disk for the test server's data, on macOS only. Every collection and
 * index MongoDB creates is fsynced, and on this Mac's disk that costs about
 * 35 ms per collection; a test bible has dozens. On a RAM disk it is about
 * 5 ms, which is most of the suites' run time. Nothing here is meant to
 * survive the run. Returns null (use the ordinary disk) when it cannot be made.
 */
function ramDisk(megabytes: number): { path: string; remove(): void } | null {
  if (process.platform !== 'darwin' || process.env[RAM_DISK_ENV] === '0') return null;
  removeOrphans();
  const name = `${PREFIX}${process.pid}-${Date.now()}`;
  let device = '';
  try {
    device = execFileSync('hdiutil', ['attach', '-nomount', `ram://${megabytes * 2048}`], {
      encoding: 'utf8',
    }).trim();
    execFileSync('diskutil', ['erasevolume', 'HFS+', name, device], { stdio: 'ignore' });
  } catch {
    if (device) detach(device);
    return null;
  }
  const path = `/Volumes/${name}`;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    detach(device);
  };
  process.once('exit', remove);
  return { path, remove };
}

function detach(device: string): void {
  try {
    execFileSync('hdiutil', ['detach', device, '-force'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** RAM disks left by a run that was killed: their process is gone, so nothing else uses them. */
function removeOrphans(): void {
  if (!existsSync('/Volumes')) return;
  for (const v of readdirSync('/Volumes')) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(v)?.[1]);
    if (!pid || alive(pid)) continue;
    detach(`/Volumes/${v}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The local MongoDB the integration and end-to-end suites share: one node of
 * a replica set (the repository writes in transactions) with wiredTiger, its
 * data on a RAM disk where the Mac allows one. Tests never touch Atlas.
 *
 * Every test bible is its own set of collections and indexes, and WiredTiger
 * keeps a file handle open for each one it has touched. A full run makes
 * thousands, which exhausts this Mac's file table (ENFILE) and kills the
 * server part way through, so idle handles are closed quickly.
 */
export async function startTestMongo(): Promise<{ uri: string; stop(): Promise<void> }> {
  const disk = ramDisk(2048);
  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [
      {
        ...(disk ? { dbPath: mkdtempSync(`${disk.path}/db-`) } : {}),
        args: [
          '--wiredTigerEngineConfigString',
          'file_manager=(close_idle_time=2,close_scan_interval=1,close_handle_minimum=100)',
        ],
      },
    ],
  });
  return {
    uri: server.getUri(),
    async stop() {
      await server.stop();
      disk?.remove();
    },
  };
}
