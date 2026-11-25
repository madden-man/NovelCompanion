import { createHash } from 'node:crypto';
import type { NovelPocket } from '../../shared/bridge';
import { buildIndex } from '../../shared/domain/captureRouter';
import { assembleNotebook, linkNotebook, planNotebook } from '../../shared/domain/notebook';
import type { LinkContext } from '../../shared/domain/notebook';
import { chapterNumbers } from '../../shared/domain/numbering';
import { buildPocket, pocketText } from '../../shared/domain/pocket';
import { phoneQuestions, planQuestions } from '../../shared/domain/phoneQuestions';
import type { BibleQuestion, QuestionStep } from '../../shared/domain/phoneQuestions';
import { positionYear } from '../../shared/domain/position';
import { plainText } from '../../shared/domain/markdown';
import type { StoredDoc } from '../readmodel';
import type { BridgeStore } from '../db/bridge';
import type { OpenBible } from '../db/session';
import { indexFromSession } from '../claude/features/captureIndex';

/** The pull that runs while a bible is open, every ten minutes (NB-3). */
export const PULL_EVERY_MS = 10 * 60 * 1000;
/** A change to what the pocket holds is published once the writes settle (NB-2). */
export const PUBLISH_AFTER_MS = 1500;

/** The collections whose changes can move the pocket. */
const POCKET_COLLECTIONS = new Set([
  'characters',
  'families',
  'places',
  'chapters',
  'worldEvents',
  'openQuestions',
]);

/** The stamp of a pocket: a hash of its text, so it moves only when the content does (NB-2). */
export function stampOf(pocket: NovelPocket): string {
  return createHash('sha256').update(pocketText(pocket), 'utf8').digest('hex').slice(0, 32);
}

const live = (docs: StoredDoc[]) => docs.filter((d) => !d.deletedAt);

/** The year the app shows ages at: the story time, else the last chapter written, else the timeline's start. */
function storyYearOf(session: OpenBible): number | null {
  return positionYear(session.repo.storyTime(), session.model.all('chapters')).year;
}

/** NB-2: the pocket of the open bible. */
export function pocketOf(session: OpenBible, decidedSince: number): NovelPocket {
  const { model, repo } = session;
  const all = (c: string) => model.all(c);
  const communities = model.get('lists', 'communities');
  const numbers = repo.bibleSettings().numbers;
  return buildPocket({
    characters: all('characters'),
    families: all('families'),
    places: all('places'),
    chapters: all('chapters'),
    worldEvents: all('worldEvents'),
    openQuestions: all('openQuestions'),
    communities: Array.isArray(communities?.items)
      ? (communities.items as { id: string; label: string }[])
      : [],
    storyYear: storyYearOf(session),
    span: { from: numbers.timelineStart, to: numbers.timelineEnd },
    decidedSince,
  });
}

/** NB-5: what the links of a page are read against: the bible as it is now. */
export function linkContextOf(session: OpenBible): LinkContext {
  const { model, repo } = session;
  const chapters = model.all('chapters');
  const numbers = chapterNumbers(chapters);
  const known = new Set<string>();
  // Only live entries: a chip naming one in the trash is dropped like an unknown one.
  for (const c of ['characters', 'places', 'chapters']) {
    for (const d of live(model.all(c))) known.add(d._id);
  }
  return {
    index: buildIndex(indexFromSession(session)),
    chapters: live(chapters).map((c) => ({
      id: c._id,
      title: typeof c.title === 'string' ? c.title : '',
      number: numbers.get(c._id) ?? null,
    })),
    known,
    storyYear: storyYearOf(session) ?? repo.bibleSettings().numbers.timelineStart,
  };
}

export interface BridgeServiceOptions {
  store: BridgeStore;
  session: OpenBible;
  /** The world ID (`worldForBible`); null leaves the bible off the bridge. */
  world: string | null;
  /** The bible's name, for the registry row. */
  name: string;
  now?: () => number;
  pullEveryMs?: number;
  publishAfterMs?: number;
  /** A failed publish or pull: offline, or Atlas refused. The next one tries again. */
  onError?: (e: unknown) => void;
  /** A56 (FN-7): the questions a pull changed from the phone, for the undo history. */
  onQuestions?: (steps: QuestionStep[]) => void;
}

/**
 * A55 (NB-1 to NB-6): the bridge while one bible is open. It publishes the
 * registry row and the pocket when the bible opens and again when what the
 * pocket holds changes, and pulls what the phone sent when the bible opens,
 * when the window comes to the front, and every ten minutes. Publishes run
 * one at a time, and so do pulls. Every failure is quiet: the bible works
 * the same without the bridge, and the next run tries again.
 */
export class BridgeService {
  readonly world: string | null;
  private readonly store: BridgeStore;
  private readonly session: OpenBible;
  private readonly name: string;
  private readonly now: () => number;
  private readonly pullEveryMs: number;
  private readonly publishAfterMs: number;
  private readonly onError: (e: unknown) => void;
  private readonly onQuestions: (steps: QuestionStep[]) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private offs: (() => void)[] = [];
  private pulling: Promise<number> = Promise.resolve(0);
  private publishing: Promise<boolean> = Promise.resolve(false);
  private lastStamp: string | null | undefined = undefined;
  private stopped = false;

  constructor(opts: BridgeServiceOptions) {
    this.store = opts.store;
    this.session = opts.session;
    this.world = opts.world;
    this.name = opts.name;
    this.now = opts.now ?? Date.now;
    this.pullEveryMs = opts.pullEveryMs ?? PULL_EVERY_MS;
    this.publishAfterMs = opts.publishAfterMs ?? PUBLISH_AFTER_MS;
    this.onError = opts.onError ?? (() => undefined);
    this.onQuestions = opts.onQuestions ?? (() => undefined);
  }

  /** The bible opened: publish, pull, then follow its changes and the clock. */
  async start(): Promise<void> {
    if (!this.world || this.stopped) return;
    const repo = this.session.repo;
    const soon = () => this.schedulePublish();
    this.offs.push(
      repo.onChange((e) => {
        if (POCKET_COLLECTIONS.has(e.collection)) soon();
      }),
      repo.onListsChange(soon),
      repo.onSettingsChange(soon),
      repo.onStoryTimeChange(soon),
      // A restore or a file import replaced the bible: everything is read again.
      repo.onReload(() => {
        this.lastStamp = undefined;
        soon();
        void this.pull();
      }),
    );
    this.timer = setInterval(() => void this.pull(), this.pullEveryMs);
    this.timer.unref?.();
    await Promise.all([this.publish(), this.pull()]);
  }

  /** The bible closed or another one opened. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.timer = null;
    this.publishTimer = null;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** The window came to the front (NB-3). */
  focus(): Promise<number> {
    return this.pull();
  }

  private schedulePublish(): void {
    if (this.stopped) return;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publish();
    }, this.publishAfterMs);
    this.publishTimer.unref?.();
  }

  /** NB-1, NB-2: the registry row, and the pocket when its stamp moved. True when the pocket was written. */
  publish(): Promise<boolean> {
    const run = this.publishing.then(() => this.publishOnce());
    this.publishing = run.catch(() => false);
    return this.publishing;
  }

  private async publishOnce(): Promise<boolean> {
    const world = this.world;
    if (!world || this.stopped) return false;
    try {
      await this.store.writeWorld(world, this.name);
      const since = await this.session.repo.markBridgeSince(this.now());
      const pocket = pocketOf(this.session, since);
      const stamp = stampOf(pocket);
      if (this.lastStamp === undefined) this.lastStamp = await this.store.stamp(world);
      if (stamp === this.lastStamp) return false;
      await this.store.writeDown(world, stamp, pocket);
      this.lastStamp = stamp;
      return true;
    } catch (e) {
      this.lastStamp = undefined;
      this.onError(e);
      return false;
    }
  }

  /** NB-3 to NB-6: read what the phone sent and land it. Returns how many pages changed. */
  pull(): Promise<number> {
    const run = this.pulling.then(() => this.pullOnce());
    this.pulling = run.catch(() => 0);
    return this.pulling;
  }

  private async pullOnce(): Promise<number> {
    const world = this.world;
    if (!world || this.stopped) return 0;
    try {
      const rows = await this.store.readUp(world);
      const { model, repo } = this.session;
      if (this.stopped) return 0;
      // A56 (FN-7): questions answered, resolved, taken back or asked on the phone come first,
      // so a thread on a question asked there is linked to it in the same pull.
      const changed = await this.applyQuestions(rows, world);
      const questions = new Map<string, string>();
      for (const q of live(model.all('openQuestions'))) {
        questions.set(q._id, plainText(q.question).trim() || String(q.title ?? ''));
      }
      const stored = repo.notebookPages({ includeDeleted: true }).filter((p) => p.world === world);
      const threads = new Map(
        stored.filter((p) => p.kind === 'thread').map((p) => [p._id, p.title]),
      );
      const assembled = assembleNotebook(rows, world, { questions, threads });
      const ctx = linkContextOf(this.session);
      const ops = planNotebook(assembled, stored, (p) => linkNotebook(p, ctx));
      if (this.stopped) return 0;
      // NB-4: a page that fails the schema is skipped and reported; the rest land.
      const pages = await repo.applyNotebook(ops, (id, reason) =>
        this.onError(new Error(`The notebook page ${id} from the phone was skipped: ${reason}`)),
      );
      return pages + changed;
    } catch (e) {
      this.onError(e);
      return 0;
    }
  }

  /**
   * A56 (FN-7): write the phone's question pages into the open questions,
   * through the one write path, the newer change winning. Each question is
   * its own write; one that fails is reported and the rest still land.
   * Returns how many questions changed.
   */
  private async applyQuestions(rows: Parameters<typeof phoneQuestions>[0], world: string) {
    const { model, repo } = this.session;
    const bible = new Map<string, BibleQuestion>();
    for (const q of model.all('openQuestions')) {
      bible.set(q._id, {
        id: q._id,
        state: q.state === 'decided' ? 'decided' : 'open',
        decision: typeof q.decision === 'string' ? q.decision : '',
        modifiedAt: String(q.modifiedAt),
        ...(q.deletedAt ? { deletedAt: String(q.deletedAt) } : {}),
      });
    }
    const steps: QuestionStep[] = [];
    for (const op of planQuestions(phoneQuestions(rows, world), bible)) {
      if (this.stopped) break;
      try {
        if (op.op === 'ask') {
          const made = await repo.create('openQuestions', { _id: op.id, ...op.data });
          steps.push({
            id: op.id,
            title: String(made.title ?? op.data.title),
            before: null,
            after: { state: op.data.state, decision: op.data.decision },
          });
        } else {
          const next = await repo.update('openQuestions', op.id, op.after);
          steps.push({
            id: op.id,
            title: String(next.title ?? ''),
            before: op.before,
            after: op.after,
          });
        }
      } catch (e) {
        this.onError(e);
      }
    }
    if (steps.length) this.onQuestions(steps);
    return steps.length;
  }
}
