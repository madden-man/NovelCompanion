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
import { APPEARANCES } from '../shared/ipcApp';
import type { Appearance, ConnectionStatus } from '../shared/ipcApp';

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

export const KEY_REFUSED = 'The phone key was not accepted.';
export const NO_CONNECTION = 'The phone has no connection to the bible.';
const NOT_UNDERSTOOD = 'The answer could not be read, so nothing is shown as saved. Try again.';

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

  constructor(private readonly deps: TransportDeps) {
    this.now = deps.now ?? (() => Date.now());
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
    await this.send('bible.list', {}, undefined, key);
    this.write(KEY_STORAGE, key);
  }

  /** PH-17: the key was refused, so it is forgotten with the bible the phone was on. */
  signOut(): void {
    this.remove(KEY_STORAGE);
    this.remove(BIBLE_STORAGE);
    this.bible = null;
    this.rev = null;
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
    try {
      return await this.send(channel, parsed, ctx, key);
    } catch (e) {
      // The bible used last is gone: the phone starts on the chooser instead.
      if (channel === 'bible.current' && e instanceof RpcCallError && e.code === 'refused') {
        if (this.bible !== null) {
          this.bible = null;
          this.remove(BIBLE_STORAGE);
          return await this.send(channel, parsed, ctx, key);
        }
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

  // ---------- inside ----------

  private async local(channel: LocalChannel, request: unknown): Promise<unknown> {
    switch (channel) {
      case 'connection.status':
        return this.status;
      case 'connection.retry': {
        const key = this.read(KEY_STORAGE);
        if (key !== null) await this.send('bible.list', {}, undefined, key).catch(() => undefined);
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
  ): Promise<Response<C>> {
    const bible = context?.bible ?? this.bible;
    const body = JSON.stringify({
      channel,
      request,
      ...(context && Object.keys(context).length ? { context } : {}),
      bible,
    });
    const size = new TextEncoder().encode(body).length;
    const keepalive =
      this.now() < this.keepaliveUntil &&
      size < KEEPALIVE_BUDGET &&
      this.keepaliveBytes + size < KEEPALIVE_BUDGET;
    const sentAt = this.now();
    let res: globalThis.Response;
    if (keepalive) this.keepaliveBytes += size;
    try {
      res = await this.deps.fetch(this.deps.endpoint ?? '/rpc', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        cache: 'no-store',
        credentials: 'omit',
        ...(keepalive ? { keepalive: true } : {}),
      });
    } catch {
      this.lost(NO_CONNECTION);
      throw new RpcCallError(NO_CONNECTION, 'unreachable', 0);
    } finally {
      if (keepalive) this.keepaliveBytes -= size;
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
      throw new RpcCallError(NOT_UNDERSTOOD, 'invalid', res.status);
    }
    if (!res.ok) {
      const { error, code } = (payload ?? {}) as { error?: unknown; code?: unknown };
      const message = typeof error === 'string' ? error : NOT_UNDERSTOOD;
      const why = typeof code === 'string' ? code : 'refused';
      if (why === 'unreachable') this.lost(message);
      else this.reached();
      throw new RpcCallError(message, why, res.status);
    }
    this.reached();
    const envelope = (payload ?? {}) as { result?: unknown; events?: unknown };
    this.followRev(res.headers, sentAt);
    // The request ran: its events reach the views even if its answer cannot be read.
    if (Array.isArray(envelope.events)) {
      for (const e of envelope.events as { event?: unknown; payload?: unknown }[]) {
        if (isEventName(e?.event)) this.emit(e.event, e.payload);
      }
    }
    const result = parseResponse(channel, envelope.result);
    if (channel === 'bible.open' || channel === 'bible.current') {
      const open = (result as { bible: { id: string } | null }).bible;
      this.bible = open?.id ?? null;
      if (open) this.write(BIBLE_STORAGE, open.id);
      else this.remove(BIBLE_STORAGE);
    }
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
    const was = this.rev;
    if (!was || was.bible !== bible || before === was.known) {
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

  private lost(message: string): void {
    if (this.status.state === 'unavailable' && this.status.message === message) return;
    this.status = { state: 'unavailable', message, snapshot: null };
    this.emit('connection.changed', this.status);
  }

  private reached(): void {
    if (this.status.state === 'connected') return;
    this.status = { state: 'connected', message: null, snapshot: null };
    this.emit('connection.changed', this.status);
  }

  /** ARCH-6 on the phone: the browser says it went offline or came back. */
  offline(): void {
    this.lost(NO_CONNECTION);
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
