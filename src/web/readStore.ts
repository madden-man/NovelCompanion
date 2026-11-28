/**
 * A58 L1 (PH-25): the phone's store of what it read. The transport keeps the
 * last answer of every read channel here, keyed by bible, channel and the
 * request, with the bible's `rev` it was read at, and serves those answers
 * read-only when the phone has no connection. Writes are never kept.
 *
 * Layout (IndexedDB `nc-phone-reads`, version 1):
 * - `meta`: `{ key, bible, channel, rev, at, size }` per answer, small, read
 *   whole when the store opens, so sizes, eviction and drops never read a value;
 * - `values`: `{ key, value }`, the answer as JSON text;
 * - `bibles`: `{ bible, rev, floor }`, the newest `rev` seen for a bible and the
 *   `rev` below which its answers were dropped as stale.
 *
 * Nothing here ever throws to the caller: a store that cannot open (private
 * browsing, blocked IndexedDB) is simply not usable, and the phone works as it
 * did before L1, with no offline reading.
 */

export interface AnswerMeta {
  key: string;
  /** The bible the answer belongs to; '' for answers that read no bible. */
  bible: string;
  channel: string;
  /** The bible's `rev` the answer was read at, or null when the function sent none. */
  rev: number | null;
  /** When it was stored (ms). The oldest go first when the store is full. */
  at: number;
  /** The length of the stored JSON text. */
  size: number;
}

export interface BibleMark {
  bible: string;
  /** The newest `rev` the phone has seen for this bible. */
  rev: number;
  /** Answers read below this `rev` are stale and never stored again. */
  floor: number;
}

/** Where the store keeps its records. IndexedDB on the phone, a map in tests. */
export interface ReadBackend {
  load(): Promise<{ metas: AnswerMeta[]; bibles: BibleMark[] }>;
  value(key: string): Promise<string | undefined>;
  put(meta: AnswerMeta, value: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
  mark(mark: BibleMark): Promise<void>;
  clear(): Promise<void>;
}

/** One answer over this is never kept (the East Winds bible is under 1 MB in all). */
export const MAX_ANSWER_CHARS = 4 * 1024 * 1024;
/** The whole store stays under this; the oldest answers go first. */
export const MAX_STORE_CHARS = 50 * 1024 * 1024;

export interface StoredAnswer {
  value: unknown;
  rev: number | null;
  at: number;
}

/** JSON with object keys sorted, so the same request is always the same key. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  });
}

export function answerKey(bible: string, channel: string, request: unknown): string {
  return `${bible}\u0000${channel}\u0000${stableJson(request ?? {})}`;
}

/** The channel and request an answer key was made from, or null when it cannot be read back. */
function readOf(key: string): { channel: string; request: unknown } | null {
  const a = key.indexOf('\u0000');
  const b = a < 0 ? -1 : key.indexOf('\u0000', a + 1);
  if (b < 0) return null;
  try {
    return { channel: key.slice(a + 1, b), request: JSON.parse(key.slice(b + 1)) as unknown };
  } catch {
    return null;
  }
}

export class ReadStore {
  private readonly index = new Map<string, AnswerMeta>();
  private readonly marks = new Map<string, BibleMark>();
  private total = 0;
  private ok: boolean;
  private queue: Promise<unknown>;
  private readonly opened: Promise<boolean>;

  constructor(
    private readonly backend: ReadBackend | null,
    private readonly limits = { answer: MAX_ANSWER_CHARS, store: MAX_STORE_CHARS },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.ok = backend !== null;
    this.opened = backend
      ? backend.load().then(
          ({ metas, bibles }) => {
            for (const m of metas) {
              this.index.set(m.key, m);
              this.total += m.size;
            }
            for (const b of bibles) this.marks.set(b.bible, b);
            return true;
          },
          () => (this.ok = false),
        )
      : Promise.resolve(false);
    this.queue = this.opened;
  }

  /** True once the store opened, and false for good when it could not. */
  async ready(): Promise<boolean> {
    await this.opened;
    return this.ok;
  }

  /** Resolves once every operation asked for so far has finished. */
  async settled(): Promise<void> {
    await this.queue;
  }

  /** How much is kept, for tests and limits. */
  get size(): { answers: number; chars: number } {
    return { answers: this.index.size, chars: this.total };
  }

  /** The stored answer for this read, or null. */
  get(bible: string, channel: string, request: unknown): Promise<StoredAnswer | null> {
    return this.run(null, async (b) => {
      const meta = this.index.get(answerKey(bible, channel, request));
      if (!meta) return null;
      const text = await b.value(meta.key);
      if (text === undefined) {
        this.forget([meta.key]);
        return null;
      }
      return { value: JSON.parse(text) as unknown, rev: meta.rev, at: meta.at };
    });
  }

  /** Keep the live answer of a read, replacing the one before it. */
  put(bible: string, channel: string, request: unknown, value: unknown, rev: number | null) {
    return this.run(undefined, async (b) => {
      const key = answerKey(bible, channel, request);
      const mark = this.marks.get(bible);
      // Read before a change made elsewhere that is already known: stale on arrival.
      if (bible && mark && (rev === null || rev < mark.floor)) return;
      const text = JSON.stringify(value);
      if (text === undefined || text.length > this.limits.answer) {
        if (this.index.has(key)) {
          await b.remove([key]);
          this.forget([key]);
        }
        return;
      }
      const meta: AnswerMeta = { key, bible, channel, rev, at: this.now(), size: text.length };
      await b.put(meta, text);
      this.forget([key]);
      this.index.set(key, meta);
      this.total += meta.size;
      await this.evict(b);
    });
  }

  /**
   * PH-25: an answer came back for `bible` with these `rev` headers. When the
   * bible moved somewhere else (its `rev` before this request is not the
   * newest the phone saw), every answer read before that is dropped, so a
   * stale answer never outlives the reload. The phone's own writes move
   * `rev` from the number it saw, which drops nothing.
   */
  observe(bible: string, before: number, after: number) {
    return this.run(undefined, async (b) => {
      const mark = this.marks.get(bible);
      if (mark && before < mark.floor) return;
      let floor = mark?.floor ?? 0;
      if (!mark || before !== mark.rev) {
        const stale = [...this.index.values()]
          .filter((m) => m.bible === bible && (m.rev === null || m.rev < before))
          .map((m) => m.key);
        if (stale.length) await b.remove(stale);
        this.forget(stale);
        floor = Math.max(floor, before);
      }
      const next = { bible, rev: Math.max(mark?.rev ?? 0, after), floor };
      await b.mark(next);
      this.marks.set(bible, next);
    });
  }

  /** True when an answer for this read is kept now, after every operation asked for so far. */
  has(bible: string, channel: string, request: unknown): Promise<boolean> {
    return this.run(false, async () => this.index.has(answerKey(bible, channel, request)));
  }

  /**
   * PH-25: the phone's own write to `bible` was stored at `after`. Every
   * answer read before it may now be out of date, and the views do not all
   * read again (an entry page shows the write's own answer, a page left is
   * gone), so those answers are dropped and answers read before `after` are
   * never kept again. The reads dropped come back, newest first, for the
   * transport to ask again.
   */
  wrote(bible: string, after: number): Promise<{ channel: string; request: unknown }[]> {
    return this.run([], async (b) => {
      const mark = this.marks.get(bible);
      const stale = [...this.index.values()]
        .filter((m) => m.bible === bible && (m.rev === null || m.rev < after))
        .sort((x, y) => y.at - x.at);
      const keys = stale.map((m) => m.key);
      if (keys.length) await b.remove(keys);
      this.forget(keys);
      const next = {
        bible,
        rev: Math.max(mark?.rev ?? 0, after),
        floor: Math.max(mark?.floor ?? 0, after),
      };
      await b.mark(next);
      this.marks.set(bible, next);
      return stale.flatMap((m) => {
        const read = readOf(m.key);
        return read ? [read] : [];
      });
    });
  }

  /** PH-17: a refused key, another key or sign-out: nothing read is kept on the phone. */
  clear() {
    return this.run(undefined, async (b) => {
      this.index.clear();
      this.marks.clear();
      this.total = 0;
      try {
        await b.clear();
      } catch {
        // What could not be cleared is never served again in this session.
        this.ok = false;
      }
    });
  }

  private async evict(b: ReadBackend): Promise<void> {
    if (this.total <= this.limits.store) return;
    const oldest = [...this.index.values()].sort((x, y) => x.at - y.at);
    const out: string[] = [];
    let total = this.total;
    for (const m of oldest) {
      if (total <= this.limits.store) break;
      out.push(m.key);
      total -= m.size;
    }
    await b.remove(out);
    this.forget(out);
  }

  private forget(keys: string[]): void {
    for (const k of keys) {
      const m = this.index.get(k);
      if (!m) continue;
      this.total -= m.size;
      this.index.delete(k);
    }
  }

  /** One operation at a time, in the order asked; a failure is the fallback, never a throw. */
  private run<T>(fallback: T, op: (b: ReadBackend) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (!this.ok || !this.backend) return fallback;
      try {
        return await op(this.backend);
      } catch {
        return fallback;
      }
    });
    this.queue = next;
    return next;
  }
}

/*
 * The few IndexedDB shapes used here, written out so this file also compiles
 * for the unit tests in Node, which has no DOM types. The browser's
 * `IDBFactory` fits `IdbFactory`.
 */
type Handler = ((this: never, ev: never) => unknown) | null;
interface IdbRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: Handler;
  onerror: Handler;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: Handler;
  onblocked: Handler;
}
interface IdbObjectStore {
  put(value: unknown): unknown;
  delete(key: string): unknown;
  clear(): unknown;
  get(key: string): IdbRequest<unknown>;
  getAll(): IdbRequest<unknown[]>;
}
interface IdbTransaction {
  readonly error: unknown;
  objectStore(name: string): IdbObjectStore;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
}
interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): unknown;
  transaction(stores: string | string[], mode: 'readonly' | 'readwrite'): IdbTransaction;
  close(): void;
  onversionchange: Handler;
}
export interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest;
  deleteDatabase(name: string): IdbRequest<unknown>;
}

const DB_NAME = 'nc-phone-reads';
const STORES = ['meta', 'values', 'bibles'] as const;

/** The browser's IndexedDB, or null where it is missing or refused. Never throws. */
export function browserIndexedDb(): IdbFactory | null {
  try {
    return (globalThis as { indexedDB?: IdbFactory }).indexedDB ?? null;
  } catch {
    return null;
  }
}

/** The store's records in IndexedDB, or null when there is none. */
export function indexedDbBackend(
  factory: IdbFactory | null,
  name: string = DB_NAME,
): ReadBackend | null {
  if (!factory) return null;
  let db: Promise<IdbDatabase> | null = null;
  const open = (): Promise<IdbDatabase> =>
    (db ??= new Promise<IdbDatabase>((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('values'))
          d.createObjectStore('values', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('bibles'))
          d.createObjectStore('bibles', { keyPath: 'bible' });
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => d.close();
        resolve(d);
      };
      req.onerror = () => reject(failure(req.error, 'IndexedDB did not open.'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked.'));
    }));
  const request = <T>(r: IdbRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(failure(r.error, 'IndexedDB request failed.'));
    });
  const write = async (
    stores: readonly (typeof STORES)[number][],
    fn: (t: IdbTransaction) => void,
  ): Promise<void> => {
    const t = (await open()).transaction([...stores], 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(failure(t.error, 'IndexedDB write failed.'));
      t.onabort = () => reject(failure(t.error, 'IndexedDB write was aborted.'));
    });
    fn(t);
    await done;
  };
  return {
    async load() {
      const t = (await open()).transaction(['meta', 'bibles'], 'readonly');
      const [metas, bibles] = await Promise.all([
        request(t.objectStore('meta').getAll()),
        request(t.objectStore('bibles').getAll()),
      ]);
      return { metas: metas as AnswerMeta[], bibles: bibles as BibleMark[] };
    },
    async value(key) {
      const t = (await open()).transaction('values', 'readonly');
      const rec = (await request(t.objectStore('values').get(key))) as
        { value?: unknown } | undefined;
      return typeof rec?.value === 'string' ? rec.value : undefined;
    },
    put: (meta, value) =>
      write(['meta', 'values'], (t) => {
        t.objectStore('meta').put(meta);
        t.objectStore('values').put({ key: meta.key, value });
      }),
    remove: (keys) =>
      keys.length === 0
        ? Promise.resolve()
        : write(['meta', 'values'], (t) => {
            for (const k of keys) {
              t.objectStore('meta').delete(k);
              t.objectStore('values').delete(k);
            }
          }),
    mark: (mark) => write(['bibles'], (t) => void t.objectStore('bibles').put(mark)),
    async clear() {
      try {
        await write(STORES, (t) => {
          for (const s of STORES) t.objectStore(s).clear();
        });
      } catch (e) {
        // The last resort: the whole database goes.
        try {
          (await open()).close();
          db = null;
          await request(factory.deleteDatabase(name));
        } catch {
          // Nothing more can be done; the store stops serving (ReadStore.clear).
        }
        throw e;
      }
    },
  };
}

function failure(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
