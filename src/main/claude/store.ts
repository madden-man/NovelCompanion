import { ClaudeRun, ClaudeTurn } from '../../shared/claude';
import type { ClaudeFeature, ClaudeRunSummary } from '../../shared/claude';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';

const COLLECTION = 'conversations';

/**
 * Saved Claude runs (AI-1) in the bible's `conversations` collection, created
 * by schema version 7 with a `{ modifiedAt: -1 }` index. Panel conversations
 * and feature runs share it, told apart by `feature`. A run is not an entry:
 * it has no revisions and no undo, like proposals and settings, and this is
 * the one place that writes it. The read model is kept in step.
 *
 * Writes touch one turn at a time (`$push` a new turn, `$set` the matching
 * turn), never the whole document, so two writers on one conversation cannot
 * overwrite each other's turns.
 */
export class RunStore {
  constructor(private readonly session: OpenBible) {}

  private collection() {
    return this.session.handle.collection<ClaudeRun>(COLLECTION);
  }

  private remember(doc: ClaudeRun | null): ClaudeRun {
    if (!doc) throw new Error('That conversation is not saved.');
    const parsed = ClaudeRun.parse(doc);
    this.session.model.put(COLLECTION, parsed as unknown as StoredDoc);
    return parsed;
  }

  /** A new run with its first turn. */
  async create(run: ClaudeRun): Promise<ClaudeRun> {
    const doc = ClaudeRun.parse(run);
    await this.collection().insertOne(doc);
    this.session.model.put(COLLECTION, doc as unknown as StoredDoc);
    return doc;
  }

  /** Add a turn to a saved conversation, leaving its other turns alone. */
  async pushTurn(runId: string, turn: ClaudeTurn, at: string): Promise<ClaudeRun> {
    const doc = await this.collection().findOneAndUpdate(
      { _id: runId },
      { $push: { turns: ClaudeTurn.parse(turn) }, $set: { modifiedAt: at } },
      { returnDocument: 'after' },
    );
    return this.remember(doc);
  }

  /** Replace one turn (by its ID) and optionally the run's output; nothing else changes. */
  async updateTurn(
    runId: string,
    turn: ClaudeTurn,
    at: string,
    output?: unknown,
  ): Promise<ClaudeRun> {
    const set: Record<string, unknown> = { 'turns.$': ClaudeTurn.parse(turn), modifiedAt: at };
    if (output !== undefined) set.output = output;
    const doc = await this.collection().findOneAndUpdate(
      { _id: runId, 'turns.id': turn.id },
      { $set: set },
      { returnDocument: 'after' },
    );
    return this.remember(doc);
  }

  get(id: string): ClaudeRun | null {
    const doc = this.session.model.get(COLLECTION, id);
    if (!doc) return null;
    const parsed = ClaudeRun.safeParse(doc);
    return parsed.success ? parsed.data : null;
  }

  /** Newest first, matching the collection's index. */
  list(feature?: ClaudeFeature): ClaudeRun[] {
    return this.session.model
      .all(COLLECTION)
      .map((d) => ClaudeRun.safeParse(d))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((r) => !feature || r.feature === feature)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b._id.localeCompare(a._id));
  }
}

/** A run as the history list shows it. A turn left running by a closed app reads as stopped. */
export function summarize(run: ClaudeRun, active: (turnId: string) => boolean): ClaudeRunSummary {
  const last = run.turns.at(-1);
  const status = !last
    ? 'done'
    : last.status === 'running' && !active(last.id)
      ? 'stopped'
      : last.status;
  return {
    id: run._id,
    feature: run.feature,
    title: run.title,
    modifiedAt: run.modifiedAt,
    turns: run.turns.length,
    status,
  };
}
