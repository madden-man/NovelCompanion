import { EventEmitter } from 'node:events';
import { monotonicFactory } from 'ulid';
import type { ClientSession, Collection, Document } from 'mongodb';
import { z } from 'zod';
import { entrySchemas, isEntryCollection } from '../../shared/schema';
import type { EntryCollection, EntryInput, EntryOf } from '../../shared/schema';
import type { ReadModel, StoredDoc } from '../readmodel';
import type { SearchIndex } from '../search';
import type { BibleHandle } from './bibles';

export type ChangeOp = 'create' | 'update' | 'softDelete' | 'restore';

export interface ChangeEvent {
  bible: string;
  collection: EntryCollection;
  id: string;
  op: ChangeOp;
}

export interface Revision {
  _id: string;
  collection: EntryCollection;
  entryId: string;
  op: ChangeOp;
  at: string;
  /** The full document before this write, or null for a create. */
  prior: StoredDoc | null;
}

export class RepositoryError extends Error {
  override name = 'RepositoryError';
}

export class ValidationError extends RepositoryError {
  override name = 'ValidationError';
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message);
  }
}

type CreateInput<C extends EntryCollection> = Omit<
  EntryInput<C>,
  '_id' | 'createdAt' | 'modifiedAt' | 'deletedAt'
> & { _id?: string };

type Patch<C extends EntryCollection> = Partial<
  Omit<EntryInput<C>, '_id' | 'createdAt' | 'modifiedAt' | 'deletedAt'>
>;

const newId = monotonicFactory();

/**
 * The one write path (ARCHITECTURE rule 2). Every mutation validates with zod,
 * writes the entry and its revision in one transaction, updates the read
 * model, patches the search index, and emits a change event.
 */
export class Repository {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly bible: BibleHandle,
    private readonly model: ReadModel,
    private readonly index: SearchIndex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get name(): string {
    return this.bible.id;
  }

  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private collection(c: EntryCollection): Collection<StoredDoc> {
    return this.bible.collection<StoredDoc>(c);
  }

  private validate<C extends EntryCollection>(c: C, doc: unknown): EntryOf<C> {
    const result = entrySchemas[c].safeParse(doc);
    if (!result.success) {
      throw new ValidationError(
        `This ${c} entry is not valid: ${z.prettifyError(result.error)}`,
        result.error.issues,
      );
    }
    return result.data as EntryOf<C>;
  }

  private assertCollection(c: string): asserts c is EntryCollection {
    if (!isEntryCollection(c)) throw new RepositoryError(`Unknown section: ${c}`);
  }

  private async transact<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.bible.client.startSession();
    try {
      let out: T | undefined;
      await session.withTransaction(async () => {
        out = await fn(session);
      });
      return out as T;
    } finally {
      await session.endSession();
    }
  }

  private async writeWithRevision(
    c: EntryCollection,
    op: ChangeOp,
    next: StoredDoc,
    prior: StoredDoc | null,
  ): Promise<void> {
    const revision: Revision = {
      _id: newId(),
      collection: c,
      entryId: next._id,
      op,
      at: next.modifiedAt as string,
      prior,
    };
    await this.transact(async (session) => {
      if (prior === null) {
        await this.collection(c).insertOne(next, { session });
      } else {
        const res = await this.collection(c).replaceOne(
          { _id: prior._id, modifiedAt: prior.modifiedAt } as Document,
          next,
          { session },
        );
        if (res.matchedCount !== 1) {
          throw new RepositoryError('This entry changed somewhere else. Reload it and try again.');
        }
      }
      await this.bible.collection<Revision>('revisions').insertOne(revision, { session });
    });
    this.model.put(c, next);
    this.index.upsert(c, next);
    this.emitter.emit('change', { bible: this.bible.id, collection: c, id: next._id, op });
  }

  private async current(c: EntryCollection, id: string): Promise<StoredDoc> {
    const doc = await this.collection(c).findOne({ _id: id });
    if (!doc) throw new RepositoryError(`No ${c} entry has the ID ${id}.`);
    return doc;
  }

  private stamp(prior: StoredDoc): string {
    // modifiedAt is the optimistic concurrency token, so it must change.
    let at = this.now().toISOString();
    if (at <= String(prior.modifiedAt)) {
      at = new Date(Date.parse(String(prior.modifiedAt)) + 1).toISOString();
    }
    return at;
  }

  async create<C extends EntryCollection>(c: C, input: CreateInput<C>): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const at = this.now().toISOString();
    const doc = this.validate(c, {
      ...input,
      _id: input._id ?? newId(),
      createdAt: at,
      modifiedAt: at,
    });
    await this.writeWithRevision(c, 'create', doc as StoredDoc, null);
    return doc;
  }

  async update<C extends EntryCollection>(c: C, id: string, patch: Patch<C>): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    // Identity, creation time, and trash state change only through their own paths.
    const {
      _id: _ignoredId,
      createdAt: _ignoredCreated,
      modifiedAt: _ignoredModified,
      deletedAt: _ignoredDeleted,
      ...rest
    } = patch as Record<string, unknown>;
    const doc = this.validate(c, { ...prior, ...rest, modifiedAt: this.stamp(prior) });
    await this.writeWithRevision(c, 'update', doc as StoredDoc, prior);
    return doc;
  }

  /** Move to the trash (ED-5). Links are kept so a restore brings them back. */
  async softDelete<C extends EntryCollection>(c: C, id: string): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    if (prior.deletedAt) throw new RepositoryError('This entry is already in the trash.');
    const at = this.stamp(prior);
    const doc = this.validate(c, { ...prior, deletedAt: at, modifiedAt: at });
    await this.writeWithRevision(c, 'softDelete', doc as StoredDoc, prior);
    return doc;
  }

  async restore<C extends EntryCollection>(c: C, id: string): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    if (!prior.deletedAt) throw new RepositoryError('This entry is not in the trash.');
    const { deletedAt: _cleared, ...rest } = prior;
    const doc = this.validate(c, { ...rest, modifiedAt: this.stamp(prior) });
    await this.writeWithRevision(c, 'restore', doc as StoredDoc, prior);
    return doc;
  }

  /** Read from the read model. Entries in the trash are hidden unless asked for. */
  get<C extends EntryCollection>(
    c: C,
    id: string,
    opts: { includeDeleted?: boolean } = {},
  ): EntryOf<C> | undefined {
    this.assertCollection(c);
    const doc = this.model.get(c, id);
    if (!doc || (doc.deletedAt && !opts.includeDeleted)) return undefined;
    return this.validate(c, doc);
  }

  list<C extends EntryCollection>(c: C, opts: { includeDeleted?: boolean } = {}): EntryOf<C>[] {
    this.assertCollection(c);
    return this.model
      .all(c)
      .filter((d) => opts.includeDeleted || !d.deletedAt)
      .map((d) => this.validate(c, d));
  }

  async revisions(c: EntryCollection, id: string): Promise<Revision[]> {
    return this.bible
      .collection<Revision>('revisions')
      .find({ collection: c, entryId: id })
      .sort({ _id: 1 })
      .toArray();
  }
}
