import type { Collection } from 'mongodb';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS, NOVEL_READS } from '../../shared/bridge';
import type { DownRow, NovelPocket, UpRow, WorldRow } from '../../shared/bridge';
import type { BridgeDb } from './connection';

/**
 * A55 (NB-1 to NB-3), A56 (ARCH-8): the phone bridge's collections, the only
 * place the app touches them. They live in the shared database
 * `flowstate_bridge`, reached through a `BridgeDb` handle that can open
 * nothing but `bridge_worlds`, `bridge_down` and `bridge_up`. This app
 * writes the `novel` rows of `bridge_worlds` and their pockets in
 * `bridge_down`, never a row of another kind (Music Companion's Songbook),
 * and only reads its own world's `pages`, `messages`, `inquiries` and `songs`
 * from `bridge_up`, which FlowState's function writes. Like `bibles.ts`, this is
 * structural, not an entry write: entries from the phone are written by the
 * repository (`Repository.applyNotebook`).
 */
export class BridgeStore {
  constructor(private readonly db: BridgeDb) {}

  private worlds(): Collection<WorldRow> {
    return this.db.collection<WorldRow>(BRIDGE_WORLDS);
  }

  private down(): Collection<DownRow> {
    return this.db.collection<DownRow>(BRIDGE_DOWN);
  }

  private up(): Collection<UpRow> {
    return this.db.collection<UpRow>(BRIDGE_UP);
  }

  /**
   * The registry row `{ _id, name, kind: 'novel' }`, written when it is
   * missing or differs. A row of another kind (Songbook, written by Music
   * Companion) is never overwritten: the world is taken, and this throws.
   */
  async writeWorld(world: string, name: string): Promise<boolean> {
    const have = await this.worlds().findOne({ _id: world });
    if (have && have.kind !== 'novel') throw new WorldTaken(world);
    if (have && have.name === name) return false;
    // Guarded by kind too, so a row another app writes in between is never replaced.
    await this.worlds().replaceOne(
      { _id: world, kind: 'novel' },
      { name, kind: 'novel' },
      {
        upsert: true,
      },
    );
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

  /** The pocket row `{ _id, stamp, pocket }`, only for a world registered as a novel. */
  async writeDown(world: string, stamp: string, pocket: NovelPocket): Promise<void> {
    const have = await this.worlds().findOne({ _id: world });
    if (!have || have.kind !== 'novel') throw new WorldTaken(world);
    await this.down().replaceOne({ _id: world }, { stamp, pocket }, { upsert: true });
  }

  /**
   * The rows the phone sent for one world that this app reads (pages,
   * messages, inquiries and songs; never takes), newest revision of each as
   * the function keeps it.
   */
  async readUp(world: string): Promise<UpRow[]> {
    return this.up()
      .find({ world, table: { $in: [...NOVEL_READS] } })
      .toArray();
  }
}

/** A world ID already registered by another app: Novel Companion leaves it alone. */
export class WorldTaken extends Error {
  constructor(world: string) {
    super(`The world ID ${world} belongs to another app, so this bible is not published to it.`);
    this.name = 'WorldTaken';
  }
}
