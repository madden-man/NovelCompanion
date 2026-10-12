import type { TopologyDescriptionChangedEvent } from 'mongodb';
import { connect } from './db/connection';
import type { Store } from './db/connection';
import { latestSnapshot } from './db/readOnly';
import { cleanMongoUri, maskMongoUri } from './secrets';
import type { MongoUriStore } from './secrets';
import type { ConnectionStatus, MongoSettingsWire } from '../shared/ipcApp';
import type { SnapshotInfo } from '../shared/domain/snapshots';

/** NF-3, ARCH-6: what the window says when MongoDB cannot be reached. */
export const UNREACHABLE =
  'The app could not reach the MongoDB deployment. Check your network connection, then click Try again.';
const WITH_SNAPSHOT = ' Until then you can open the most recent local snapshot read-only.';
const NO_SNAPSHOT =
  ' There is no local snapshot on this Mac yet, so there is nothing to open read-only.';

/** Server types a write can go to. With none of these in the topology, writes cannot land. */
const WRITABLE = new Set(['RSPrimary', 'Standalone', 'Mongos', 'LoadBalancer']);

export interface ConnectionDeps {
  /** Where the connection string is kept: the keychain, or memory under test. */
  uris: MongoUriStore;
  /** Under test only a local MongoDB address is accepted. */
  localOnly: boolean;
  /** Said when no connection string is stored at all. */
  missingMessage: string;
  /** `<userData>/snapshots`, where BK-1 snapshots are kept. */
  snapshotRoot: string;
  connect?: (uri: string) => Promise<Store>;
  /** Under test, the spec file's own database in place of `novel_companion` (`testDatabaseName()`). */
  database?: string | null;
  /** Told whenever the state changes, so the window can follow it. */
  onStatus?: (status: ConnectionStatus) => void;
}

/**
 * The one MongoDB connection of the app (ARCH-2, ARCH-6), and the settings
 * that change it (ST-1). It knows whether MongoDB is reachable, whether a
 * snapshot is open read-only instead, and it switches to a new connection
 * string only after that string has connected.
 */
export class ConnectionManager {
  private store: Store | null = null;
  private state: ConnectionStatus['state'] = 'connected';
  private message: string | null = null;
  private readOnlySnapshot: SnapshotInfo | null = null;
  /** The bible that was open when the connection went, so its snapshot is offered first. */
  lastBible: string | null = null;
  private readonly connectTo: (uri: string) => Promise<Store>;

  constructor(private readonly deps: ConnectionDeps) {
    this.connectTo = deps.connect ?? ((uri) => connect(uri, {}, deps.database ?? null));
  }

  get current(): Store | null {
    return this.store;
  }

  get readOnly(): boolean {
    return this.state === 'readOnly';
  }

  /** The open store, connecting first when there is none. */
  getStore(): Promise<{ ok: true; store: Store } | { ok: false; message: string }> {
    if (this.store) return Promise.resolve({ ok: true, store: this.store });
    // One attempt at a time: callers that arrive while it runs share its outcome.
    this.pending ??= this.connectOnce().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** True once a connection has been tried (or made), so the state is known. */
  get tried(): boolean {
    return this.attempted;
  }

  private pending: Promise<{ ok: true; store: Store } | { ok: false; message: string }> | null =
    null;
  private attempted = false;

  private async connectOnce(): Promise<
    { ok: true; store: Store } | { ok: false; message: string }
  > {
    this.attempted = true;
    const uri = this.deps.uris.get();
    if (!uri) {
      this.setState('unavailable', this.deps.missingMessage);
      return { ok: false, message: this.deps.missingMessage };
    }
    try {
      this.adopt(await this.connectTo(uri));
      return { ok: true, store: this.store as unknown as Store };
    } catch {
      this.setState('unavailable', UNREACHABLE);
      return { ok: false, message: UNREACHABLE };
    }
  }

  /** ARCH-6: the state as the window shows it, with the snapshot it may open. */
  async status(): Promise<ConnectionStatus> {
    if (this.state === 'readOnly' && this.readOnlySnapshot) {
      return {
        state: 'readOnly',
        message: this.message,
        snapshot: {
          bible: this.readOnlySnapshot.bible,
          name: this.readOnlySnapshot.name ?? this.readOnlySnapshot.bible,
          takenAt: this.readOnlySnapshot.takenAt,
        },
      };
    }
    if (this.state === 'connected') return { state: 'connected', message: null, snapshot: null };
    const latest = await this.latest();
    return {
      state: 'unavailable',
      message: `${this.message ?? UNREACHABLE}${latest ? WITH_SNAPSHOT : NO_SNAPSHOT}`,
      snapshot: latest
        ? { bible: latest.bible, name: latest.name ?? latest.bible, takenAt: latest.takenAt }
        : null,
    };
  }

  /** The most recent local snapshot, of the bible last open when it has one. */
  latest(): Promise<SnapshotInfo | null> {
    return latestSnapshot(this.deps.snapshotRoot, this.lastBible);
  }

  /** ARCH-6: a request failed because MongoDB went away. */
  lost(): void {
    if (this.state === 'readOnly') return;
    this.setState('unavailable', 'The app lost its connection to MongoDB.');
  }

  /** ARCH-6: a snapshot is now open read-only. */
  enterReadOnly(snapshot: SnapshotInfo): void {
    this.readOnlySnapshot = snapshot;
    this.setState(
      'readOnly',
      `MongoDB cannot be reached, so this is the snapshot of ${snapshot.name ?? snapshot.bible} taken ${snapshot.takenAt}, open read-only. Nothing can be changed. Click Try again when your network is back.`,
    );
  }

  /**
   * ARCH-6: connect again from nothing. The old client is closed only after
   * a new one has connected, so a failed retry changes nothing.
   */
  async retry(): Promise<{ ok: true; store: Store } | { ok: false; message: string }> {
    const uri = this.deps.uris.get();
    if (!uri) {
      if (!this.readOnly) this.setState('unavailable', this.deps.missingMessage);
      return { ok: false, message: this.deps.missingMessage };
    }
    let next: Store;
    try {
      next = await this.connectTo(uri);
    } catch {
      if (!this.readOnly) this.setState('unavailable', UNREACHABLE);
      return { ok: false, message: UNREACHABLE };
    }
    const old = this.store;
    this.store = null;
    this.readOnlySnapshot = null;
    this.adopt(next);
    await old?.close().catch(() => undefined);
    return { ok: true, store: next };
  }

  /** ST-1: the stored connection string, masked. */
  mongoSettings(): MongoSettingsWire {
    const uri = this.deps.uris.get();
    return {
      set: uri !== null,
      masked: uri ? maskMongoUri(uri) : null,
      where: this.deps.uris.where,
    };
  }

  /**
   * ST-1: try a connection string (or the stored one) and say plainly what
   * happened. Nothing is stored and the app's connection is not touched.
   */
  async test(raw?: string): Promise<{ ok: boolean; message: string }> {
    let uri: string;
    if (raw === undefined) {
      const stored = this.deps.uris.get();
      if (!stored) return { ok: false, message: this.deps.missingMessage };
      uri = stored;
    } else {
      const clean = cleanMongoUri(raw, { localOnly: this.deps.localOnly });
      if (!clean.ok) return clean;
      uri = clean.uri;
    }
    try {
      const probe = await this.connectTo(uri);
      try {
        await probe.db.command({ ping: 1 });
      } finally {
        await probe.close().catch(() => undefined);
      }
      return {
        ok: true,
        message: 'Connected. MongoDB answered, and the app can use the novel_companion database.',
      };
    } catch (e) {
      return { ok: false, message: connectionFailure(e) };
    }
  }

  /**
   * ST-1: replace the stored connection string. The new string is tested
   * first; only when it connects is it stored and the app switched over to it.
   * A failed test changes nothing: the old string and connection stay.
   */
  async replace(raw: string): Promise<{ ok: boolean; message: string; switched: Store | null }> {
    const clean = cleanMongoUri(raw, { localOnly: this.deps.localOnly });
    if (!clean.ok) return { ...clean, switched: null };
    let next: Store;
    try {
      next = await this.connectTo(clean.uri);
      await next.db.command({ ping: 1 });
    } catch (e) {
      return {
        ok: false,
        message: `${connectionFailure(e)} The connection string was not changed.`,
        switched: null,
      };
    }
    try {
      this.deps.uris.set(clean.uri);
    } catch {
      await next.close().catch(() => undefined);
      return {
        ok: false,
        message:
          'The new connection string works, but the keychain did not accept it, so nothing changed. Allow Novel Companion to use the keychain, then try again.',
        switched: null,
      };
    }
    const old = this.store;
    this.store = null;
    this.readOnlySnapshot = null;
    this.adopt(next);
    await old?.close().catch(() => undefined);
    return {
      ok: true,
      message: 'Connected with the new connection string. It is stored, and the app now uses it.',
      switched: next,
    };
  }

  async close(): Promise<void> {
    const s = this.store;
    this.store = null;
    await s?.close();
  }

  private adopt(store: Store): void {
    this.store = store;
    this.watch(store);
    this.setState('connected', null);
  }

  /**
   * Follow the driver's view of the deployment, so a connection lost while
   * nothing is being written still shows, and one that comes back clears.
   */
  private watch(store: Store): void {
    let writable = true;
    store.client.on('topologyDescriptionChanged', (e: TopologyDescriptionChangedEvent) => {
      if (this.store !== store) return;
      const now = [...e.newDescription.servers.values()].some((s) => WRITABLE.has(s.type));
      if (now === writable) return;
      writable = now;
      if (this.state === 'readOnly') return;
      if (now) this.setState('connected', null);
      else this.lost();
    });
  }

  private setState(state: ConnectionStatus['state'], message: string | null): void {
    const changed = state !== this.state || message !== this.message;
    this.state = state;
    this.message = message;
    if (changed && this.deps.onStatus) {
      void this.status().then((s) => this.deps.onStatus?.(s));
    }
  }
}

/** NF-3: why a connection attempt failed, in plain words, without the string itself. */
export function connectionFailure(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const text = e instanceof Error ? e.message : '';
  if (/auth/i.test(name) || /auth|credential|password/i.test(text)) {
    return 'MongoDB refused the user name or password. Copy the connection string again from Atlas, with the database user password filled in.';
  }
  if (/ENOTFOUND|querySrv|ENODATA|EAI_AGAIN/i.test(text)) {
    return 'The cluster address in the connection string was not found. Check the address, and check your network connection.';
  }
  if (/ECONNREFUSED/i.test(text)) {
    return 'Nothing answered at that address. Check that MongoDB is running there, and check the port.';
  }
  if (name === 'MongoParseError' || name === 'MongoAPIError') {
    return 'The connection string is not in a form MongoDB accepts. Copy it again from Atlas under Connect, then Drivers.';
  }
  if (name === 'MongoServerSelectionError') {
    return 'MongoDB did not answer in time. Check your network connection, and check that this Mac is allowed in the Atlas network access list.';
  }
  return 'The app could not connect with that connection string. Check it, and check your network connection.';
}
