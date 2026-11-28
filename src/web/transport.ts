import { PLAIN } from '../shared/errors';
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
import { NO_BIBLE_MESSAGE, isBibleFree } from '../shared/ipcPhone';
import { ReadStore, answerKey } from './readStore';
import type { StoredAnswer, StoredRead } from './readStore';
import { writtenReads } from './writeAnswers';

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
/**
 * PH-25: answers read before a change are read again in the background once
 * the phone's writes have been quiet this long; each write starts it again.
 */
export const REFRESH_QUIET_MS = 2000;
/**
 * PH-25: a pass over every flagged answer starts at most this often, and runs
 * to its end before the next one starts. Between passes only the screen
 * showing and the entries a change names are read again.
 */
export const REFRESH_PASS_GAP_MS = 5 * 60_000;
/** PH-9: answers that cross a write of the phone's own wait for it at most this long. */
export const WRITE_HOLD_MS = 30_000;
/** PH-25: how many reads the transport remembers the place of, for the screen showing. */
const SCREEN_READS = 2000;

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

/**
 * PH-25: a refusal in the function's own plain words about what was asked (a
 * purged entry: "No characters entry has the ID H1."), not a failure of the
 * database or of the request itself. The kept answer of that read goes.
 */
const GENERIC_REFUSALS: ReadonlySet<string> = new Set([...Object.values(PLAIN), NO_BIBLE_MESSAGE]);
const isGone = (status: number, code: string, message: string): boolean =>
  status === 422 && code === 'refused' && !GENERIC_REFUSALS.has(message);

/** PH-25: true when a read's request names one of the changed entries (`id` to its collections). */
function namesChange(request: unknown, changed: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (typeof request === 'string') return changed.has(request);
  if (Array.isArray(request)) return request.some((v) => namesChange(v, changed));
  if (request === null || typeof request !== 'object') return false;
  const o = request as Record<string, unknown>;
  const collection = typeof o.collection === 'string' ? o.collection : null;
  return Object.entries(o).some(([k, v]) => {
    if (k === 'collection') return false;
    if (typeof v === 'string' && collection !== null) {
      return changed.get(v)?.has(collection) ?? false;
    }
    return namesChange(v, changed);
  });
}

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
  /** PH-25: the place showing (the page's hash), so the reads of the screen showing are known. */
  place?: () => string;
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
  /** PH-9: the phone's own writes in flight for less than `WRITE_HOLD_MS`. */
  private holding = 0;
  /** PH-9: `rev` headers that came back while a write of the phone's own was in flight. */
  private held: { bible: string; before: number; after: number; sentAt: number }[] = [];
  /** PH-25: the background refresh of flagged answers: its quiet timer, its run, and its turn. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshTurn = 0;
  /** PH-25: flagged reads to read again at the next quiet moment: the screen showing, the entries a change named. */
  private readonly urgent = new Set<string>();
  /** PH-25: the pass over every flagged answer under way, with the keys it has still to read, newest first. */
  private pass: { bible: string; keys: string[] } | null = null;
  /** PH-25: when the last pass started, and the timer for the next. */
  private passAt: number;
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  /** PH-25: the place each read was last asked from by a view, by answer key. */
  private readonly screen = new Map<string, string>();
  private readonly place: () => string;
  /** A refresh came due while a write was out: it runs once the writes answered. */
  private refreshAfterWrites = false;
  private visible = true;

  constructor(private readonly deps: TransportDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.reads = deps.reads ?? new ReadStore(null);
    this.place =
      deps.place ?? (() => (globalThis as { location?: { hash: string } }).location?.hash ?? '');
    this.bible = this.read(BIBLE_STORAGE);
    // PH-25: a change seen from now on waits its turn for the pass; answers flagged in an
    // earlier launch are read again in this one at the first quiet moment.
    this.passAt = this.now();
    void this.reads.ready().then(async (usable) => {
      if (!usable) return;
      const bible = this.bible;
      if (bible !== null && (await this.reads.flagged(bible)).length) this.passAt = -Infinity;
      this.refreshLater();
    });
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
    this.stopRefresh();
    this.urgent.clear();
    this.pass = null;
    this.screen.clear();
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
    if (isStoredRead(channel)) this.seen(channel, parsed, ctx);
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
    this.visible = false;
    this.stopRefresh();
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
    this.visible = true;
    this.refreshLater();
  }

  /**
   * PH-25: resolves once every read in flight, and a background refresh
   * already running, has landed in the store, so what the phone shows offline
   * is what it showed a moment before. A refresh still waiting for the
   * phone's writes to go quiet is not waited for.
   */
  async readsSettled(): Promise<void> {
    for (;;) {
      if (this.reading.size) await Promise.all(this.reading);
      else if (this.refreshing) await this.refreshing;
      else {
        await this.reads.settled();
        if (!this.reading.size && !this.refreshing) return;
      }
    }
  }

  /** PH-25: true while a background refresh waits for quiet or runs. For tests. */
  get refreshPending(): boolean {
    return this.refreshTimer !== null || this.refreshing !== null;
  }

  /** PH-25: true while the next pass over every flagged answer waits its turn. For tests. */
  get passWaiting(): boolean {
    return this.passTimer !== null;
  }

  // ---------- inside ----------

  /** PH-25: a view asked this read from the place showing now. */
  private seen(channel: Channel, request: unknown, context: CallContext | undefined): void {
    const chooser = isBibleFree(channel) && channel !== 'bible.current';
    const bible = chooser ? null : (context?.bible ?? this.bible);
    const key = answerKey(storeBible(channel, bible), channel, request);
    this.screen.delete(key);
    this.screen.set(key, this.place());
    if (this.screen.size > SCREEN_READS) {
      const [oldest] = this.screen.keys();
      if (oldest !== undefined) this.screen.delete(oldest);
    }
  }

  /** PH-25: the reads the screen showing asked, read again at the next quiet moment if flagged. */
  private screenFirst(): void {
    const here = this.place();
    for (const [key, place] of this.screen) if (place === here) this.urgent.add(key);
  }

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
   * PH-25: the phone's own write was stored at `after`. Nothing kept is
   * dropped: what the write's own answer holds is kept as its read's answer in
   * this same step, everything else of the bible read before it is flagged,
   * the screen showing is read again once the writes go quiet, and the rest
   * waits for the next pass.
   */
  private wrote(
    headers: Headers,
    bible: string | null,
    channel: Channel,
    request: unknown,
    result: unknown,
  ): void {
    const after = Number(headers.get(REV_HEADERS.after));
    if (bible === null || headers.get(REV_HEADERS.bible) !== bible || !Number.isInteger(after))
      return;
    let written: ReturnType<typeof writtenReads> = [];
    try {
      if (result !== undefined) written = writtenReads(channel, request, result);
    } catch {
      // An answer of another shape holds no read; the refresh reads the page again.
    }
    void this.reads.wrote(bible, after, written);
    this.screenFirst();
    this.refreshLater();
  }

  /** PH-25: the background refresh runs once the phone's writes have been quiet a while. */
  private refreshLater(): void {
    this.refreshTurn++;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_QUIET_MS);
  }

  /** PH-25: hidden, offline or signed out: no refresh request goes out from now on. */
  private stopRefresh(): void {
    this.refreshTurn++;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.passTimer !== null) clearTimeout(this.passTimer);
    this.passTimer = null;
  }

  /** PH-25: the next pass, when its turn comes, if anything is still flagged. */
  private async passLater(bible: string): Promise<void> {
    if (this.passTimer !== null || !this.visible || this.status.state !== 'connected') return;
    if (!(await this.reads.flagged(bible)).length) return;
    if (this.passTimer !== null || !this.visible || this.status.state !== 'connected') return;
    const wait = Math.max(0, this.passAt + REFRESH_PASS_GAP_MS - this.now());
    this.passTimer = setTimeout(() => {
      this.passTimer = null;
      this.refreshLater();
    }, wait);
  }

  /**
   * PH-25: read flagged answers of the bible again, one request at a time,
   * the most recently stored first. First what is urgent (the screen showing,
   * the entries a change named); then the pass over every flagged answer:
   * one starts at most every `REFRESH_PASS_GAP_MS`, and the one started is
   * carried on to its end before another starts, so the oldest answers get
   * their turn. A write, hiding the app or losing the connection stops the
   * run at once; the flags and the pass's keys stay, so the next quiet
   * moment, reconnect or launch carries on.
   */
  private refresh(): void {
    if (this.refreshing) {
      // One run at a time; the one running ends at this turn, and a new one follows it.
      void this.refreshing.then(() => this.refreshLater());
      return;
    }
    const turn = this.refreshTurn;
    const live = (bible: string) =>
      turn === this.refreshTurn &&
      this.visible &&
      this.holding === 0 &&
      this.status.state === 'connected' &&
      this.bible === bible;
    const run = (async () => {
      const bible = this.bible;
      const key = this.read(KEY_STORAGE);
      if (this.holding > 0) this.refreshAfterWrites = true;
      if (bible === null || key === null || !live(bible)) return;
      const again = (next: StoredRead) =>
        isChannel(next.channel)
          ? this.track(next.channel, this.send(next.channel, next.request, { bible }, key, false))
              .then(() => true)
              // Only a lost connection leaves it to read again; an answer that could not be read does not.
              .catch((e: unknown) => !(e instanceof RpcCallError && e.code === 'unreachable'))
          : Promise.resolve(true);
      // Urgent first, each once.
      for (;;) {
        const [next] = await this.reads.flaggedAmong(bible, this.urgent);
        if (!next) break;
        if (!live(bible) || this.read(KEY_STORAGE) !== key) return;
        if (await again(next)) this.urgent.delete(next.key);
        else return;
      }
      this.urgent.clear();
      if (this.pass?.bible !== bible) {
        this.pass = null;
        if (this.now() < this.passAt + REFRESH_PASS_GAP_MS) return void this.passLater(bible);
        const keys = (await this.reads.flagged(bible)).map((r) => r.key);
        if (!keys.length || !live(bible)) return;
        this.pass = { bible, keys };
        this.passAt = this.now();
      }
      const pass = this.pass;
      for (;;) {
        const [next] = await this.reads.flaggedAmong(bible, new Set(pass.keys));
        if (!next) break;
        if (!live(bible) || this.read(KEY_STORAGE) !== key || this.pass !== pass) return;
        // A read the connection lost stays first; one answered or refused leaves the pass.
        if (!(await again(next))) return;
        pass.keys = pass.keys.filter((k) => k !== next.key);
      }
      if (this.pass === pass) this.pass = null;
      void this.passLater(bible);
    })();
    this.refreshing = run.finally(() => {
      this.refreshing = null;
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
    if (!isWriteChannel(channel)) return this.request(channel, request, context, key, fromStore);
    // PH-9: answers that come back while the phone's own write is out wait for it (`followRev`),
    // at most `WRITE_HOLD_MS`: a write that hangs is not cut off or sent again, but waits no more.
    let holds = true;
    this.holding++;
    const done = () => {
      if (!holds) return;
      holds = false;
      if (--this.holding === 0) this.release();
    };
    const timer = setTimeout(done, WRITE_HOLD_MS);
    try {
      return await this.request(channel, request, context, key, fromStore);
    } finally {
      clearTimeout(timer);
      done();
    }
  }

  private async request<C extends Channel>(
    channel: C,
    request: unknown,
    context: CallContext | undefined,
    key: string,
    fromStore: boolean,
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
    const keyKept = this.read(KEY_STORAGE) === key;
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
      // PH-25: what the read reads is gone (a purged entry): it is not served offline or asked again.
      if (stored && isGone(res.status, why, message) && this.read(KEY_STORAGE) === key) {
        void this.reads.drop(storeBible(channel, bible), channel, request);
      }
      // The function answered but cannot reach MongoDB: the banner, as on the desk.
      if (why === 'unreachable') this.lost(message, false);
      else this.reached();
      throw new RpcCallError(message, why, res.status);
    }
    this.reached();
    const envelope = (payload ?? {}) as { result?: unknown; events?: unknown };
    // PH-17: an answer landing after sign-out changes nothing the phone knows.
    if (!keyKept || this.read(KEY_STORAGE) === key) this.followRev(res.headers, sentAt);
    let result: Response<C> | undefined;
    let invalid: unknown = null;
    try {
      result = parseResponse(channel, envelope.result);
    } catch (e) {
      invalid = e;
    }
    // Before the write's events reach the views, so the page just edited is kept at once.
    if (isWriteChannel(channel) && this.read(KEY_STORAGE) === key) {
      this.wrote(res.headers, bible, channel, request, result);
    }
    // The bible opened is the one later requests name, before its events reach the views:
    // a view that reloads on `bibles.changed` must ask about the new bible (A58 U1).
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
    // While the phone's own write is out, an answer may count it before the write's
    // own answer does: it waits, and is weighed in `rev` order once the writes answered.
    if (this.holding > 0) {
      this.held.push({ bible, before, after, sentAt });
      return;
    }
    this.followRevNow(bible, before, after, sentAt);
  }

  /** PH-9: the phone's writes have all answered: the answers held meanwhile, in `rev` order. */
  private release(): void {
    const held = this.held.sort((x, y) => x.before - y.before || x.after - y.after);
    this.held = [];
    for (const h of held) this.followRevNow(h.bible, h.before, h.after, h.sentAt);
    if (this.refreshAfterWrites) {
      this.refreshAfterWrites = false;
      this.refreshLater();
    }
  }

  private followRevNow(bible: string, before: number, after: number, sentAt: number): void {
    // PH-25: stored answers read before a change made elsewhere are flagged, and read again.
    void this.reads.observe(bible, before, after).then((flagged) => {
      if (flagged) this.refreshLater();
    });
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
    // PH-25: what the change names and the screen showing are read again at once; the rest waits its pass.
    this.screenFirst();
    if (changes.length) {
      const changed = new Map<string, Set<string>>();
      for (const c of changes)
        changed.set(c.id, (changed.get(c.id) ?? new Set()).add(c.collection));
      for (const r of await this.reads.flagged(bible)) {
        if (namesChange(r.request, changed)) this.urgent.add(r.key);
      }
    }
    this.refreshLater();
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
    // An answer older only than the phone's own writes shows nothing changed elsewhere.
    const rev = hit.current;
    if (rev === null) return;
    const was = this.rev;
    if (!was || was.bible !== bible) this.rev = { bible, known: rev, at: hit.at };
    else if (rev < was.known) this.rev = { bible, known: rev, at: Math.min(was.at, hit.at) };
  }

  private lost(message: string, readOnly: boolean): void {
    this.stopRefresh();
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
    // PH-25: what is flagged is read again, carrying on where a pass stopped.
    this.refreshLater();
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
