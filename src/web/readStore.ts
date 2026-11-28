/**
 * A58 L1 (PH-25): the phone's store of what it read. The transport keeps the
 * last answer of every read channel here, keyed by bible, channel and the
 * request, with the bible's `rev` it was read at, and serves those answers
 * read-only when the phone has no connection. A write's answer is kept only
 * as the answer of the read it repeats (`writtenReads` in `writeAnswers.ts`).
 *
 * Layout (IndexedDB `nc-phone-reads`, version 1):
 * - `meta`: `{ key, bible, channel, rev, at, size }` per answer, small, read
 *   whole when the store opens, so sizes, eviction and drops never read a value;
 * - `values`: `{ key, value }`, the answer as JSON text;
 * - `bibles`: `{ bible, rev, floor, stale }`, the newest `rev` seen for a bible,
 *   the `rev` of the last change made elsewhere that the phone saw, and the `rev`
 *   below which its answers predate a change, the phone's own or another's.
 *   Those answers are flagged, never dropped: they are still served with no
 *   connection, and the transport reads them again in the background. A row
 *   from before `stale` existed reads it as `floor`.
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
  /** Answers read below this `rev` predate a change made elsewhere. */
  floor: number;
  /** Answers read below this `rev` predate a change: kept, flagged, and read again when there is time. */
  stale: number;
}

/** A stored read, as the transport asks it again. */
export interface StoredRead {
  key: string;
  channel: string;
  request: unknown;
}

/** A read whose answer a write's own answer already holds (`entry.update` returns the entry). */
export interface WrittenRead {
  channel: string;
  request: unknown;
  value: unknown;
}

/** Where the store keeps its records. IndexedDB on the phone, a map in tests. */
export interface ReadBackend {
  load(): Promise<{
    metas: AnswerMeta[];
    bibles: (Omit<BibleMark, 'stale'> & { stale?: number })[];
  }>;
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
  /** Read before a change the phone knows of; served with no connection all the same. */
  stale: boolean;
  /**
   * The bible's `rev` a view showing this answer is as good as drawn at: the
   * newest seen when only the phone's own writes came after it, else `rev`.
   */
  current: number | null;
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
            for (const b of bibles) this.marks.set(b.bible, { ...b, stale: b.stale ?? b.floor });
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
      const mark = this.marks.get(bible);
      const stale = this.isStale(meta);
      const elsewhere = meta.rev === null || (mark !== undefined && meta.rev < mark.floor);
      return {
        value: JSON.parse(text) as unknown,
        rev: meta.rev,
        at: meta.at,
        stale,
        current: elsewhere || !mark ? meta.rev : Math.max(meta.rev ?? 0, mark.rev),
      };
    });
  }

  /**
   * Keep the live answer of a read, replacing the one before it, unless the
   * one kept was read at a newer `rev` (a read answered late, after a write
   * whose own answer already holds the newer text). An answer read before a
   * change the phone knows of is still kept when nothing newer is: flagged,
   * it reads offline as the screen read online.
   */
  put(bible: string, channel: string, request: unknown, value: unknown, rev: number | null) {
    return this.run(undefined, (b) => this.keep(b, bible, channel, request, value, rev));
  }

  /**
   * PH-25: an answer came back for `bible` with these `rev` headers. When the
   * bible moved somewhere else (its `rev` before this request is newer than
   * the newest the phone saw), every answer read before that is flagged, kept
   * for reading with no connection and read again in the background. The
   * transport holds back the headers of answers that cross the phone's own
   * writes and hands them over in `rev` order once those writes have
   * answered, so the phone's own writes, which move `rev` from the number it
   * saw, flag nothing here. True when this flagged an answer kept.
   */
  observe(bible: string, before: number, after: number): Promise<boolean> {
    return this.run(false, async (b) => {
      const mark = this.marks.get(bible);
      let floor = mark?.floor ?? 0;
      let stale = mark?.stale ?? 0;
      const elsewhere = !mark || before > mark.rev;
      if (elsewhere) {
        floor = Math.max(floor, before);
        stale = Math.max(stale, before);
      }
      await this.setMark(b, { bible, rev: Math.max(mark?.rev ?? 0, after), floor, stale });
      if (!elsewhere) return false;
      for (const m of this.index.values()) if (m.bible === bible && this.isStale(m)) return true;
      return false;
    });
  }

  /** True when an answer for this read is kept now, after every operation asked for so far. */
  has(bible: string, channel: string, request: unknown): Promise<boolean> {
    return this.run(false, async () => this.index.has(answerKey(bible, channel, request)));
  }

  /**
   * PH-25: the phone's own write to `bible` was stored at `after`. Nothing is
   * dropped: every answer read before it is flagged, and the reads the
   * write's own answer holds (`written`) are kept at `after` in the same
   * step, so the page just edited reads offline as it did online at once.
   */
  wrote(bible: string, after: number, written: readonly WrittenRead[] = []): Promise<void> {
    return this.run(undefined, async (b) => {
      const mark = this.marks.get(bible);
      await this.setMark(b, {
        bible,
        // `rev` itself moves when the transport hands over the write's headers (`observe`).
        rev: mark?.rev ?? after,
        floor: mark?.floor ?? 0,
        stale: Math.max(mark?.stale ?? 0, after),
      });
      for (const w of written) await this.keep(b, bible, w.channel, w.request, w.value, after);
    });
  }

  /**
   * PH-25: the flagged reads of `bible`, the most recently stored first, less
   * those in `skip`. The transport reads them again one at a time.
   */
  flagged(bible: string, skip: ReadonlySet<string> = new Set()): Promise<StoredRead[]> {
    return this.run([], async () =>
      // Newest first; stored in the same millisecond, the later one first.
      [...this.index.values()]
        .reverse()
        .filter((m) => m.bible === bible && !skip.has(m.key) && this.isStale(m))
        .sort((x, y) => y.at - x.at)
        .flatMap((m) => {
          const read = readOf(m.key);
          return read ? [{ key: m.key, ...read }] : [];
        }),
    );
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

  private isStale(m: AnswerMeta): boolean {
    if (!m.bible) return false;
    const mark = this.marks.get(m.bible);
    return m.rev === null || (mark !== undefined && m.rev < mark.stale);
  }

  private async setMark(b: ReadBackend, next: BibleMark): Promise<void> {
    const was = this.marks.get(next.bible);
    if (was && was.rev === next.rev && was.floor === next.floor && was.stale === next.stale) return;
    await b.mark(next);
    this.marks.set(next.bible, next);
  }

  private async keep(
    b: ReadBackend,
    bible: string,
    channel: string,
    request: unknown,
    value: unknown,
    rev: number | null,
  ): Promise<void> {
    const key = answerKey(bible, channel, request);
    const kept = this.index.get(key);
    // Never an older answer over a newer one; with no `rev` to compare, the kept one stays.
    if (bible && kept && (rev === null || (kept.rev !== null && rev < kept.rev))) return;
    const text = JSON.stringify(value);
    if (text === undefined || text.length > this.limits.answer) {
      if (kept) {
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
