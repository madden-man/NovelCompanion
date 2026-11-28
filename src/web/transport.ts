import { ELSEWHERE_MESSAGE } from '../shared/freshness';
import {
  events,
  isChannel,
  isEventName,
  parseCallContext,
  parseRequest,
  parseResponse,
} from '../shared/ipc';
import type {
  Api,
  CallContext,
  Channel,
  EventName,
  EventPayload,
  Request,
  Response,
} from '../shared/ipc';
import { APPEARANCES, isWriteChannel } from '../shared/ipcApp';
import type { Appearance, ConnectionStatus } from '../shared/ipcApp';
import { isBibleFree } from '../shared/ipcPhone';
import { ReadStore, answerKey } from './readStore';
import type { StoredAnswer } from './readStore';

/**
 * A58 P4: `window.api` on the phone. The same `Api` the preload exposes,
 * over `POST /rpc` to the hosted function: the request and the answer are
 * checked against the contract on both sides (ARCH-1 rule 3), the events a
 * request broadcast come back in the answer and go to the listeners here
 * (PH-12), and every answer is checked for the phone key (PH-17), the build
 * id (PH-21) and the bible's `rev` (PH-9).
 */

/** Where the phone keeps its key and the bible it was on, in the installed app's own storage. */
export const KEY_STORAGE = 'nc.phoneKey';
export const BIBLE_STORAGE = 'nc.phone.bible';
export const APPEARANCE_STORAGE = 'nc.phone.appearance';

/** The headers the function answers with (`src/server/rpc.ts`). */
export const BUILD_HEADER = 'X-NC-Build';
export const REV_HEADERS = {
  bible: 'X-NC-Rev-Bible',
  before: 'X-NC-Rev-Before',
  after: 'X-NC-Rev',
} as const;

/** PH-13: a keepalive request's body must stay under this, and so must all of them in flight. */
export const KEEPALIVE_BUDGET = 64 * 1024;
/** PH-13: how long after the app is hidden its writes still go out as keepalive requests. */
export const KEEPALIVE_WINDOW_MS = 5000;
/** PH-9: how often the phone checks `rev` while it is visible. */
export const PHONE_FRESHEN_MS = 20_000;
/** PH-9: entries stored this long before the last check are asked again, for clocks that differ. */
export const CLOCK_MARGIN_MS = 5 * 60_000;

/** PH-25: a read waits this long for the function before the phone serves what it read before. */
export const READ_TIMEOUT_MS = 15_000;
/** PH-25: while the connection is lost, a read tries the function this long first. */
export const OFFLINE_PROBE_MS = 4000;
/** PH-25: after the phone's own write, the views read again first; what they did not is asked after this. */
export const REREAD_DELAY_MS = 300;
/** PH-25: at most this many answers a write dropped are asked again; the rest read as not stored. */
export const REREAD_LIMIT = 60;

export const KEY_REFUSED = 'The phone key was not accepted.';
export const NO_CONNECTION = 'The phone has no connection to the bible.';
/** PH-25: the banner while the phone shows what it read before. */
export const OFFLINE_READ_ONLY =
  'The phone has no connection, so it shows what it read before and nothing can be changed.';
/** PH-25: a read with no connection and nothing stored for it. */
export const NOT_STORED =
  'This was not opened on the phone before, so it cannot be shown without a connection.';
/** PH-25: a write asked for while the phone is read-only. */
export const OFFLINE_WRITE = 'The phone has no connection, so this change was not saved.';
const NOT_UNDERSTOOD = 'The answer could not be read, so nothing is shown as saved. Try again.';
/** A write sent while the connection broke before its answer came back: it may have been stored. */
export const WRITE_LOST =
  'The connection broke before the answer came back, so this change may already be saved.';

/** Channels the phone answers itself: its connection state, its close flow, its appearance. */
export const LOCAL_CHANNELS = [
  'connection.status',
  'connection.retry',
  'app.flushed',
  'appearance.get',
  'appearance.set',
] as const satisfies readonly Channel[];
type LocalChannel = (typeof LOCAL_CHANNELS)[number];
const isLocal = (c: Channel): c is LocalChannel =>
  (LOCAL_CHANNELS as readonly string[]).includes(c);

/** PH-25: reads whose answers are never kept: `bible.changes` asks about a moment, not a screen. */
const NEVER_STORED: ReadonlySet<string> = new Set<Channel>(['bible.changes']);

/** PH-25: a read channel whose last answer the phone keeps for reading without a connection. */
export const isStoredRead = (c: Channel): boolean =>
  !isWriteChannel(c) && !isLocal(c) && !NEVER_STORED.has(c);

/** PH-25: the bible a stored answer belongs to; '' for reads that read no bible. */
const storeBible = (channel: Channel, bible: string | null): string =>
  isBibleFree(channel) && channel !== 'bible.current' ? '' : (bible ?? '');

/** A request the function refused, with its code (`key`, `desk`, `older`, `refused`, ...). */
export class RpcCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface TransportDeps {
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The id this web build was made with (PH-21). */
  buildId: string;
  /** Where `/rpc` lives; the page's own origin by default. */
  endpoint?: string;
  now?: () => number;
  /** PH-25: where the answers of reads are kept; none keeps nothing, as before L1. */
  reads?: ReadStore;
}

type Listener = (payload: unknown) => void;

export class WebTransport implements Api {
  private readonly listeners = new Map<EventName, Set<Listener>>();
  private readonly signedOut = new Set<() => void>();
  private readonly buildChanged = new Set<(id: string) => void>();
  private status: ConnectionStatus = { state: 'connected', message: null, snapshot: null };
  /** The bible the phone is on, sent with every request so a fresh instance opens it (PH-7). */
  private bible: string | null;
  /** PH-9: the `rev` the phone's views show, and when that was last true. */
  private rev: { bible: string; known: number; at: number } | null = null;
  private syncing: Promise<void> | null = null;
  /** PH-13: keepalive requests go out until this time. */
  private keepaliveUntil = 0;
  private keepaliveBytes = 0;
  private readonly now: () => number;
  private readonly reads: ReadStore;
  /** PH-25: reads in flight whose answers the store keeps. */
  private readonly reading = new Set<Promise<unknown>>();
  /** PH-25: answers the phone's own writes dropped, to ask again, by answer key. */
  private readonly again = new Map<string, { bible: string; channel: string; request: unknown }>();
  private rereading: Promise<void> | null = null;

  constructor(private readonly deps: TransportDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.reads = deps.reads ?? new ReadStore(null);
    this.bible = this.read(BIBLE_STORAGE);
  }

  // ---------- the phone key (PH-16, PH-17) ----------

  hasKey(): boolean {
    return this.read(KEY_STORAGE) !== null;
  }

  /**
   * PH-16: try a pasted key with one read. A key the function accepts is kept;
   * one it refuses is not, and the promise rejects with `KEY_REFUSED`.
   */
  async signIn(raw: string): Promise<void> {
    const key = raw.trim();
    if (!key || /\s/.test(key)) throw new RpcCallError(KEY_REFUSED, 'key', 401);
    await this.send('bible.list', {}, undefined, key, false);
    // PH-25: what was read under another key is not kept under this one.
    if (this.read(KEY_STORAGE) !== key) await this.reads.clear();
    this.write(KEY_STORAGE, key);
  }

  /** PH-17: the key was refused, so it is forgotten with the bible the phone was on. */
  signOut(): void {
    this.remove(KEY_STORAGE);
    this.remove(BIBLE_STORAGE);
    this.bible = null;
    this.rev = null;
    // PH-25: the bible's content leaves the phone with the key.
    void this.reads.clear();
    for (const fn of [...this.signedOut]) fn();
  }

  onSignedOut(fn: () => void): () => void {
    this.signedOut.add(fn);
    return () => this.signedOut.delete(fn);
  }

  /** PH-21: an answer carried another build id than this web build's. */
  onBuildChanged(fn: (id: string) => void): () => void {
    this.buildChanged.add(fn);
    return () => this.buildChanged.delete(fn);
  }

  // ---------- Api ----------

  invoke = async <C extends Channel>(
    channel: C,
    request: Request<C>,
    context?: CallContext,
  ): Promise<Response<C>> => {
    if (!isChannel(channel)) throw new Error(`Unknown channel: ${String(channel)}`);
    const parsed = parseRequest(channel, request);
    const ctx = context === undefined ? undefined : parseCallContext(context);
    if (isLocal(channel)) return parseResponse(channel, await this.local(channel, parsed));
    const key = this.read(KEY_STORAGE);
    if (key === null) {
      this.signOut();
      throw new RpcCallError(KEY_REFUSED, 'key', 401);
    }
    // PH-25: nothing is written while the phone shows what it read before.
    if (this.status.state === 'readOnly' && isWriteChannel(channel)) {
      throw new RpcCallError(OFFLINE_WRITE, 'unreachable', 0);
    }
    try {
      return await this.track(channel, this.send(channel, parsed, ctx, key));
    } catch (e) {
      // The bible used last is gone: the phone starts on the chooser instead.
      if (channel === 'bible.current' && e instanceof RpcCallError && e.code === 'refused') {
        if (this.bible !== null) {
          this.bible = null;
          this.remove(BIBLE_STORAGE);
          return await this.send(channel, parsed, ctx, key);
        }
      }
      // PH-19: a bible older or newer than the function is not opened again at the next launch.
      if (
        channel === 'bible.current' &&
        e instanceof RpcCallError &&
        /^(older|newer)$/.test(e.code)
      ) {
        this.remove(BIBLE_STORAGE);
      }
      throw e;
    }
  };

  on = <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
    if (!isEventName(event)) throw new Error(`Unknown event: ${String(event)}`);
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set);
    const wrapped: Listener = (payload) => listener(payload as EventPayload<E>);
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  };

  /** Hand an event to its listeners, checked against the contract as the preload does. */
  emit<E extends EventName>(event: E, payload: EventPayload<E> | unknown): void {
    const result = events[event].safeParse(payload);
    if (!result.success) return;
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        fn(result.data);
      } catch (e) {
        console.error('Novel Companion listener:', e);
      }
    }
  }

  // ---------- freshness (PH-9) and the flush on hide (PH-13) ----------

  /** PH-9: one small read; its `rev` headers fire `bible.reloaded` when the bible moved elsewhere. */
  async checkFreshness(): Promise<void> {
    if (this.bible === null || !this.hasKey()) return;
    try {
      await this.invoke('bible.current', {});
      await this.syncing;
    } catch {
      // The next check tries again; a lost connection already shows the banner.
    }
  }

  /**
   * PH-13: the app was hidden. Writes from now go out as keepalive requests,
   * and the page is asked to flush what it holds, as on the desk's close.
   */
  hidden(): void {
    this.keepalive();
    if (this.bible !== null) this.emit('app.closeRequested', { hasBible: true, quitting: false });
  }

  /** PH-13: from now, for a few seconds, writes go out as keepalive requests. */
  keepalive(): void {
    this.keepaliveUntil = this.now() + KEEPALIVE_WINDOW_MS;
  }

  /** The app is visible again: writes go out as normal requests. */
  shown(): void {
    this.keepaliveUntil = 0;
  }

  /**
   * PH-25: resolves once every read in flight has landed in the store and the
   * answers the phone's own writes dropped were asked again, so what the phone
   * shows offline is what it showed a moment before.
   */
  async readsSettled(): Promise<void> {
    for (;;) {
      if (this.reading.size) await Promise.all(this.reading);
      else if (this.rereading) await this.rereading;
      else {
        await this.reads.settled();
        if (!this.reading.size && !this.rereading) return;
      }
    }
  }

  // ---------- inside ----------

  private track<T>(channel: Channel, sent: Promise<T>): Promise<T> {
    if (!isStoredRead(channel)) return sent;
    const done = sent.then(
      () => undefined,
      () => undefined,
    );
    this.reading.add(done);
    void done.then(() => this.reading.delete(done));
    return sent;
  }

  /**
   * PH-25: the phone's own write was stored. The answers read before it are
   * dropped (an entry page redraws from the write's own answer and a page
   * left never reads again), and asked again once the views had their turn,
   * so the store holds what the phone shows. One that cannot be asked again
   * reads as not stored, never as it was before the write.
   */
  private wrote(headers: Headers, bible: string | null): void {
    const after = Number(headers.get(REV_HEADERS.after));
    if (bible === null || headers.get(REV_HEADERS.bible) !== bible || !Number.isInteger(after))
      return;
    void this.reads.wrote(bible, after).then((dropped) => {
      for (const read of dropped.slice(0, REREAD_LIMIT)) {
        this.again.set(answerKey(bible, read.channel, read.request), { bible, ...read });
      }
      this.reread();
    });
  }

  private reread(): void {
    if (this.rereading || this.again.size === 0) return;
    const run = (async () => {
      await new Promise((resolve) => setTimeout(resolve, REREAD_DELAY_MS));
      for (const [k, read] of this.again) {
        this.again.delete(k);
        // With no connection, what was dropped stays dropped and reads as not stored.
        if (this.status.state !== 'connected') {
          this.again.clear();
          break;
        }
        if (read.bible !== this.bible || !this.hasKey()) continue;
        if (await this.reads.has(read.bible, read.channel, read.request)) continue;
        if (!isChannel(read.channel)) continue;
        await this.invoke(read.channel, read.request as never, { bible: read.bible }).catch(
          () => undefined,
        );
      }
    })();
    this.rereading = run.finally(() => {
      this.rereading = null;
      this.reread();
    });
  }

  private async local(channel: LocalChannel, request: unknown): Promise<unknown> {
    switch (channel) {
      case 'connection.status':
        return this.status;
      case 'connection.retry': {
        const key = this.read(KEY_STORAGE);
        if (key !== null) {
          await this.send('bible.list', {}, undefined, key, false).catch(() => undefined);
        }
        return this.status;
      }
      case 'app.flushed':
        return { ok: true };
      case 'appearance.get': {
        const stored = this.read(APPEARANCE_STORAGE);
        const appearance = (APPEARANCES as readonly string[]).includes(stored ?? '')
          ? (stored as Appearance)
          : 'system';
        return { appearance };
      }
      case 'appearance.set': {
        const { appearance } = request as { appearance: Appearance };
        this.write(APPEARANCE_STORAGE, appearance);
        return { appearance };
      }
    }
  }

  private async send<C extends Channel>(
    channel: C,
    request: unknown,
    context: CallContext | undefined,
    key: string,
    /** PH-25: false when a stored answer must not stand in (a key being tried, Try again). */
    fromStore = true,
  ): Promise<Response<C>> {
    // PH-19: the chooser's channels name no bible, so one bible the function refuses blocks only itself.
    const chooser = isBibleFree(channel) && channel !== 'bible.current';
    const bible = chooser ? null : (context?.bible ?? this.bible);
    const stored = isStoredRead(channel);
    const body = JSON.stringify({
      channel,
      request,
      ...(context && Object.keys(context).length ? { context } : {}),
      bible,
    });
    const size = new TextEncoder().encode(body).length;
    let keepalive =
      this.now() < this.keepaliveUntil &&
      size < KEEPALIVE_BUDGET &&
      this.keepaliveBytes + size < KEEPALIVE_BUDGET;
    const sentAt = this.now();
    let res: globalThis.Response;
    if (keepalive) this.keepaliveBytes += size;
    // PH-25: a read that hangs counts as no connection; a write is never cut off.
    const abort = stored && !keepalive && typeof AbortController !== 'undefined';
    const ctrl = abort ? new AbortController() : null;
    const timer = ctrl
      ? setTimeout(
          () => ctrl.abort(),
          this.status.state === 'connected' ? READ_TIMEOUT_MS : OFFLINE_PROBE_MS,
        )
      : null;
    try {
      res = await this.deps.fetch(this.deps.endpoint ?? '/rpc', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        cache: 'no-store',
        credentials: 'omit',
        ...(keepalive ? { keepalive: true } : {}),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch {
      if (keepalive) this.keepaliveBytes -= size;
      keepalive = false;
      return await this.unreachable(channel, request, bible, stored && fromStore);
    } finally {
      if (keepalive) this.keepaliveBytes -= size;
      if (timer !== null) clearTimeout(timer);
    }
    const build = res.headers.get(BUILD_HEADER);
    if (build && build !== this.deps.buildId) {
      for (const fn of [...this.buildChanged]) fn(build);
    }
    if (res.status === 401) {
      // PH-17: a refused key is forgotten; a key being tried was never kept.
      if (this.read(KEY_STORAGE) === key) this.signOut();
      throw new RpcCallError(KEY_REFUSED, 'key', 401);
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    const { error, code } = (payload ?? {}) as { error?: unknown; code?: unknown };
    // ARCH-6: an answer that is not the function's (a gateway's 502 or 504, a page) is a lost connection.
    if (payload === undefined || (res.status >= 500 && typeof code !== 'string')) {
      // PH-25: a read falls back on what the phone read before, as with no network at all.
      if (!isWriteChannel(channel)) {
        return await this.unreachable(channel, request, bible, stored && fromStore);
      }
      const usable = await this.reads.ready();
      this.lost(usable ? OFFLINE_READ_ONLY : NO_CONNECTION, usable);
      throw new RpcCallError(WRITE_LOST, 'unreachable', res.status);
    }
    if (!res.ok) {
      const message = typeof error === 'string' ? error : NOT_UNDERSTOOD;
      const why = typeof code === 'string' ? code : 'refused';
      // The function answered but cannot reach MongoDB: the banner, as on the desk.
      if (why === 'unreachable') this.lost(message, false);
      else this.reached();
      throw new RpcCallError(message, why, res.status);
    }
    this.reached();
    const envelope = (payload ?? {}) as { result?: unknown; events?: unknown };
    this.followRev(res.headers, sentAt);
    // Before the write's events reach the views, so their reads after it are kept.
    if (isWriteChannel(channel)) this.wrote(res.headers, bible);
    // The bible opened is the one later requests name, before its events reach the views:
    // a view that reloads on `bibles.changed` must ask about the new bible (A58 U1).
    let result: Response<C> | undefined;
    let invalid: unknown = null;
    try {
      result = parseResponse(channel, envelope.result);
    } catch (e) {
      invalid = e;
    }
    if (result !== undefined) this.opened(channel, result);
    // PH-25: a bible opened by a request that named none is the one a launch with no
    // connection reopens, so it is read once under its own name.
    const opening = channel === 'bible.open' || (channel === 'bible.current' && bible === null);
    if (result !== undefined && opening && this.bible !== null) {
      const read = this.reads
        .ready()
        .then((usable) =>
          usable ? this.invoke('bible.current', {}).then(() => undefined) : undefined,
        );
      void this.track('bible.current', read).catch(() => undefined);
    }
    // PH-25: the live answer replaces the stored one, with the `rev` it was read at.
    if (result !== undefined && stored && this.read(KEY_STORAGE) === key) {
      const revBible = res.headers.get(REV_HEADERS.bible);
      const rev = Number(res.headers.get(REV_HEADERS.after));
      const at = revBible !== null && revBible === bible && Number.isInteger(rev) ? rev : null;
      void this.reads.put(storeBible(channel, bible), channel, request, result, at);
    }
    // The request ran: its events reach the views even if its answer cannot be read.
    if (Array.isArray(envelope.events)) {
      for (const e of envelope.events as { event?: unknown; payload?: unknown }[]) {
        if (isEventName(e?.event)) this.emit(e.event, e.payload);
      }
    }
    if (result === undefined) throw invalid;
    return result;
  }

  /**
   * PH-9: `X-NC-Rev-Before` is the bible's `rev` once the function made it
   * fresh. When that is not the number the phone's views were drawn at, the
   * bible changed somewhere else: what changed is asked for and every view
   * redraws in place, typing kept (PH-10). `X-NC-Rev` counts the phone's own
   * write, so its own writes never cause a reload.
   */
  private followRev(headers: Headers, sentAt: number): void {
    const bible = headers.get(REV_HEADERS.bible);
    const before = Number(headers.get(REV_HEADERS.before));
    const after = Number(headers.get(REV_HEADERS.after));
    if (!bible || !Number.isInteger(before) || !Number.isInteger(after)) return;
    // PH-25: stored answers read before a change made elsewhere are dropped.
    void this.reads.observe(bible, before, after);
    const was = this.rev;
    // An answer older than one already seen (requests run in parallel) changes nothing.
    if (was?.bible === bible && after < was.known) return;
    if (!was || was.bible !== bible || before <= was.known) {
      this.rev = { bible, known: after, at: sentAt };
      return;
    }
    this.rev = { bible, known: after, at: sentAt };
    const since = new Date(was.at - CLOCK_MARGIN_MS).toISOString();
    const run = (this.syncing ?? Promise.resolve()).then(() => this.redraw(bible, since));
    this.syncing = run.finally(() => {
      if (this.syncing === run) this.syncing = null;
    });
  }

  private async redraw(bible: string, since: string): Promise<void> {
    let changes: Response<'bible.changes'>['changes'] = [];
    try {
      changes = (await this.invoke('bible.changes', { since })).changes;
    } catch {
      // Each view still hears the reload below and asks again what it shows.
    }
    for (const c of changes) this.emit('bible.changed', { bible, ...c });
    for (const e of [
      'lists.changed',
      'tree.changed',
      'storyTime.changed',
      'settings.changed',
    ] as const) {
      this.emit(e, { bible });
    }
    this.emit('bible.reloaded', { bible, message: ELSEWHERE_MESSAGE, elsewhere: true });
  }

  /** A bible opened (or the one used last): later requests name it. */
  private opened(channel: Channel, result: unknown): void {
    if (channel !== 'bible.open' && channel !== 'bible.current') return;
    const open = (result as { bible: { id: string } | null }).bible;
    this.bible = open?.id ?? null;
    if (open) this.write(BIBLE_STORAGE, open.id);
    else this.remove(BIBLE_STORAGE);
  }

  /**
   * PH-25: the function could not be reached at all (no network, or a read
   * that hung). With a store, the phone turns read-only and a read is served
   * from what it read before; with none, it is ARCH-6's banner as before.
   */
  private async unreachable<C extends Channel>(
    channel: C,
    request: unknown,
    bible: string | null,
    serve: boolean,
  ): Promise<Response<C>> {
    const usable = await this.reads.ready();
    this.lost(usable ? OFFLINE_READ_ONLY : NO_CONNECTION, usable);
    if (!serve || !usable) throw new RpcCallError(NO_CONNECTION, 'unreachable', 0);
    const where = storeBible(channel, bible);
    const hit = await this.reads.get(where, channel, request);
    let result: Response<C> | undefined;
    try {
      if (hit) result = parseResponse(channel, hit.value);
    } catch {
      // Stored by another build in another shape: as good as nothing stored.
    }
    if (!hit || result === undefined) throw new RpcCallError(NOT_STORED, 'unreachable', 0);
    this.opened(channel, result);
    if (where) this.shownFrom(where, hit);
    return result;
  }

  /**
   * PH-25: a view now shows an answer read at `hit.rev`, so the phone's known
   * `rev` is no newer than that: back online, a change made meanwhile is told
   * apart and every view asks again (PH-9).
   */
  private shownFrom(bible: string, hit: StoredAnswer): void {
    if (hit.rev === null) return;
    const was = this.rev;
    if (!was || was.bible !== bible) this.rev = { bible, known: hit.rev, at: hit.at };
    else if (hit.rev < was.known)
      this.rev = { bible, known: hit.rev, at: Math.min(was.at, hit.at) };
  }

  private lost(message: string, readOnly: boolean): void {
    const state = readOnly ? 'readOnly' : 'unavailable';
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message, snapshot: null };
    this.emit('connection.changed', this.status);
  }

  private reached(): void {
    if (this.status.state === 'connected') return;
    const wasReadOnly = this.status.state === 'readOnly';
    this.status = { state: 'connected', message: null, snapshot: null };
    this.emit('connection.changed', this.status);
    // PH-25: back from reading what was stored, the bible is checked for changes made meanwhile.
    if (wasReadOnly) void this.checkFreshness();
  }

  /** ARCH-6 on the phone: the browser says it went offline. */
  offline(): void {
    void this.reads
      .ready()
      .then((usable) => this.lost(usable ? OFFLINE_READ_ONLY : NO_CONNECTION, usable));
  }

  private read(name: string): string | null {
    try {
      return this.deps.storage.getItem(name);
    } catch {
      return null;
    }
  }

  private write(name: string, value: string): void {
    try {
      this.deps.storage.setItem(name, value);
    } catch {
      // Private browsing may refuse storage; the app still works until it closes.
    }
  }

  private remove(name: string): void {
    try {
      this.deps.storage.removeItem(name);
    } catch {
      // As above.
    }
  }
}
