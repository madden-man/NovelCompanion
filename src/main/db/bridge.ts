import type { Collection, Db } from 'mongodb';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS } from '../../shared/bridge';
import type { DownRow, NovelPocket, UpRow, WorldRow } from '../../shared/bridge';

/**
 * A55 (NB-1 to NB-3): the phone bridge's three collections, the only place
 * the app touches them. They sit in `novel_companion` beside the `bibles`
 * registry, outside every bible's prefix (ARCH-8: still the one database).
 * This app writes `bridge_worlds` and `bridge_down` and only reads
 * `bridge_up`, which FlowState's function writes. Like `bibles.ts`, this is
 * structural, not an entry write: entries from the phone are written by the
 * repository (`Repository.applyNotebook`).
 */
export class BridgeStore {
  constructor(private readonly db: Db) {}

  private worlds(): Collection<WorldRow> {
    return this.db.collection<WorldRow>(BRIDGE_WORLDS);
  }

  private down(): Collection<DownRow> {
    return this.db.collection<DownRow>(BRIDGE_DOWN);
  }

  private up(): Collection<UpRow> {
    return this.db.collection<UpRow>(BRIDGE_UP);
  }

  /** The registry row `{ _id, name, kind: 'novel' }`, written when it is missing or differs. */
  async writeWorld(world: string, name: string): Promise<boolean> {
    const have = await this.worlds().findOne({ _id: world });
    if (have && have.name === name && have.kind === 'novel') return false;
    await this.worlds().replaceOne({ _id: world }, { name, kind: 'novel' }, { upsert: true });
    return true;
  }

  async readWorld(world: string): Promise<WorldRow | null> {
    return this.worlds().findOne({ _id: world });
  }

  /** The pocket's stamp as stored, or null when there is no pocket yet. */
  async stamp(world: string): Promise<string | null> {
    const row = await this.down().findOne({ _id: world }, { projection: { stamp: 1 } });
    return typeof row?.stamp === 'string' ? row.stamp : null;
  }

  async readDown(world: string): Promise<DownRow | null> {
    return this.down().findOne({ _id: world });
  }

  /** The pocket row `{ _id, stamp, pocket }`. */
  async writeDown(world: string, stamp: string, pocket: NovelPocket): Promise<void> {
    await this.down().replaceOne({ _id: world }, { stamp, pocket }, { upsert: true });
  }

  /** Every row the phone sent for one world, newest revision of each as the function keeps it. */
  async readUp(world: string): Promise<UpRow[]> {
    return this.up().find({ world }).toArray();
  }
}
