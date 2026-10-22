import { EventEmitter } from 'node:events';
import { monotonicFactory } from 'ulid';
import type { ClientSession, Collection, Document } from 'mongodb';
import { z } from 'zod';
import {
  DERIVED_LIST_IDS,
  FIXED_ITEM_LISTS,
  LIST_IDS,
  ListDoc,
  Proposal,
  collectionInfo,
  entrySchemas,
  entryTitle,
  isEntryCollection,
  manifests,
} from '../../shared/schema';
import type {
  AnyListId,
  DerivedListId,
  EntryCollection,
  EntryInput,
  EntryOf,
  ListItem,
} from '../../shared/schema';
import { contentOf, diffEntries } from '../../shared/domain/diff';
import type { FieldChange } from '../../shared/domain/diff';
import { unknownPaths } from '../../shared/domain/schemaPaths';
import { StoryTimeValue } from '../../shared/storyTime';
import {
  countListUsage,
  derivedRename,
  newItemId,
  renameCascade,
  tagsUsed,
} from '../../shared/domain/lists';
import type { CollectionDocs } from '../../shared/domain/lists';
import { DEFAULT_SELECTION_SETTINGS } from '../../shared/domain/brief/selection';
import { eraRangeFromItem } from '../../shared/domain/timeline';
import { shiftStrand } from '../../shared/domain/strands';
import { computeWarnings } from '../../shared/domain/warnings';
import { ROMANIZATION_META_ID, settingsFromMeta } from '../../shared/domain/romanization';
import type { DriveKnown, DriveLink, DriveSeen } from '../../shared/domain/drive';
import type { RomanizationSettings } from '../../shared/domain/romanization';
import { ownAncestorMessage, wouldBeOwnAncestor } from '../../shared/domain/tree';
import type { FieldWarning } from '../../shared/domain/warnings';
import { conflictQuestion, questionCovers, questionWithConflict } from '../../shared/domain/import';
import type { ChangeItem, Conflict, ListAdd, SourceRecord } from '../../shared/domain/import';
import type { Backlink, ReadModel, StoredDoc } from '../readmodel';
import type { SearchIndex } from '../search';
import type { BibleHandle } from './bibles';
import {
  SCENE_OUTLINE_ID,
  SCENE_VERSIONS_COLLECTION,
  sameYears,
  sceneCount,
  sameBreaks,
  sceneBreaks,
  sceneOutlineText,
  sceneYears,
  startsNewVersion,
} from '../../shared/domain/sceneOutline';
import type { SceneBreaks, SceneYears } from '../../shared/domain/sceneOutline';
// a47-guard
import { CLAUDE_FEATURES } from '../../shared/claude';
import type { ClaudeFeature } from '../../shared/claude';
import { ListRef, MINTABLE_LISTS } from '../../shared/schema';
import type { ListAddProposal } from '../../shared/schema';

export type ChangeOp = 'create' | 'update' | 'softDelete' | 'restore';

export interface ChangeEvent {
  bible: string;
  collection: EntryCollection;
  id: string;
  op: ChangeOp | 'purge';
}

export interface Revision {
  _id: string;
  collection: EntryCollection;
  entryId: string;
  op: ChangeOp;
  at: string;
  /** The full document before this write, or null for a create. */
  prior: StoredDoc | null;
  /** Why the write happened when it was not a plain edit, in plain words. */
  note?: string;
  /** The approved proposal that made this write (ED-7). */
  proposalId?: string;
}

/** A revision as the history drawer lists it: the entry as it stood after that write. */
export interface RevisionView {
  _id: string;
  op: ChangeOp;
  at: string;
  note: string | null;
  proposalId: string | null;
  snapshot: StoredDoc;
}

export interface ListView {
  _id: AnyListId | string;
  label: string;
  /** Derived lists hold entries; their items are renamed through those entries. */
  derived: boolean;
  /** Items can be renamed but not added or removed. */
  fixedItems: boolean;
  items: ListViewItem[];
}

export type ListViewItem = ListItem & { usage: number; detail?: string };

/** Hooks for tests that need to fail a write part way. */
export interface RepositoryOptions {
  /** Called inside every transaction after its writes, before it commits. Throwing aborts it. */
  midTransaction?: (session: ClientSession) => Promise<void>;
}

export class RepositoryError extends Error {
  override name = 'RepositoryError';
}

export class ValidationError extends RepositoryError {
  override name = 'ValidationError';
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
    /** The section, so a plain message can name the field by its label (NF-3). */
    readonly collection?: string,
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

interface Change {
  collection: EntryCollection;
  op: ChangeOp;
  next: StoredDoc;
  prior: StoredDoc | null;
  note?: string;
  proposalId?: string;
}

const newId = monotonicFactory();

const isDerived = (id: string): id is DerivedListId =>
  (DERIVED_LIST_IDS as readonly string[]).includes(id);

/**
 * The one write path (ARCHITECTURE rule 2). Every mutation validates with zod,
 * writes the entries and their revisions in one transaction, updates the read
 * model, patches the search index, and emits a change event.
 */
export class Repository {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly bible: BibleHandle,
    private readonly model: ReadModel,
    private readonly index: SearchIndex,
    private readonly now: () => Date = () => new Date(),
    private readonly options: RepositoryOptions = {},
  ) {}

  /** Runs before a bulk change (a list rename, an approved proposal, an import) so it can take a snapshot first (BK-1). */
  beforeBulk: ((reason: string) => Promise<void>) | null = null;

  private async bulkGuard(reason: string): Promise<void> {
    await this.beforeBulk?.(reason);
  }

  get name(): string {
    return this.bible.id;
  }

  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  /** A proposal was made, edited, refreshed, approved, or rejected. */
  onProposalsChange(listener: () => void): () => void {
    this.emitter.on('proposals', listener);
    return () => this.emitter.off('proposals', listener);
  }

  /** Lists changed: a rename, an added item, or a tag first used. */
  onListsChange(listener: () => void): () => void {
    this.emitter.on('lists', listener);
    return () => this.emitter.off('lists', listener);
  }

  private collection(c: EntryCollection): Collection<StoredDoc> {
    return this.bible.collection<StoredDoc>(c);
  }

  private validate<C extends EntryCollection>(c: C, doc: unknown, shape = true): EntryOf<C> {
    const result = entrySchemas[c].safeParse(doc);
    if (!result.success) {
      throw new ValidationError(
        `This ${c} entry is not valid: ${z.prettifyError(result.error)}`,
        result.error.issues,
        c,
      );
    }
    const data = result.data as EntryOf<C>;
    if (shape) this.checkShape(c, data as unknown as StoredDoc);
    return data;
  }

  /** Shape rules that need other data: nobody may be their own ancestor (FT-6). */
  private checkShape(c: EntryCollection, doc: StoredDoc, ancestry = true): void {
    if (ancestry && c === 'parentLinks' && !doc.deletedAt) this.checkNotOwnAncestor(doc, []);
  }

  /**
   * FT-6: nobody may be their own ancestor. Every parent link in force counts,
   * whoever it names, plus the links written in the same transaction.
   */
  private checkNotOwnAncestor(doc: StoredDoc, batch: StoredDoc[]): void {
    const links = [...this.model.all('parentLinks'), ...batch]
      .filter((l) => !l.deletedAt && l._id !== doc._id)
      .map((l) => ({ parentId: String(l.parentId), childId: String(l.childId) }));
    const parentId = String(doc.parentId);
    const childId = String(doc.childId);
    if (!wouldBeOwnAncestor(links, parentId, childId)) return;
    const name = (id: string) => entryTitle(this.model.get('characters', id) ?? { title: id });
    const message = ownAncestorMessage(name(parentId), name(childId));
    throw new ValidationError(message, [
      { code: 'custom', message, path: ['childId'], input: doc } as z.core.$ZodIssue,
    ]);
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
      // A transaction aborted from inside (a killed write) ends without an error; it saved nothing.
      const state = (session.transaction as unknown as { state: string }).state;
      if (state === 'TRANSACTION_ABORTED' || state === 'NO_TRANSACTION') {
        throw new RepositoryError(
          'The write was cancelled before it finished, so nothing was saved.',
        );
      }
      return out as T;
    } finally {
      await session.endSession();
    }
  }

  /** Tag labels the changes use that the tags list does not have yet. */
  private newTags(changes: Change[]): ListItem[] {
    const tags = this.model.get('lists', 'tags') as ListDoc | undefined;
    const known = new Set((tags?.items ?? []).map((i) => i.label));
    const draft: ListDoc = { _id: 'tags', label: 'Tags', items: [...(tags?.items ?? [])] };
    const out: ListItem[] = [];
    for (const ch of changes) {
      for (const label of tagsUsed(manifests[ch.collection], ch.next)) {
        if (known.has(label)) continue;
        known.add(label);
        const item = { id: newItemId(draft, label), label, parentId: null };
        draft.items.push(item);
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Write every change and its revision in one transaction, then update the
   * read model and search index and announce each change. `extra` runs inside
   * the same transaction for list and proposal updates.
   */
  private async commit(
    changes: Change[],
    extra?: (session: ClientSession) => Promise<void>,
    listsAfter: ListDoc[] = [],
  ): Promise<void> {
    const addTags = this.newTags(changes);
    const listUpdates = [...listsAfter];
    if (addTags.length) {
      const base =
        listUpdates.find((l) => l._id === 'tags') ??
        (this.model.get('lists', 'tags') as ListDoc | undefined) ??
        ({ _id: 'tags', label: 'Tags', items: [] } as ListDoc);
      const merged = { ...base, items: [...base.items, ...addTags] };
      const i = listUpdates.findIndex((l) => l._id === 'tags');
      if (i >= 0) listUpdates[i] = merged;
      else listUpdates.push(merged);
    }
    await this.transact(async (session) => {
      await this.writeChanges(changes, session);
      for (const list of listUpdates) {
        await this.bible
          .collection<ListDoc>('lists')
          .replaceOne({ _id: list._id }, list, { session, upsert: true });
      }
      await extra?.(session);
      await this.options.midTransaction?.(session);
    });
    for (const list of listUpdates) this.model.put('lists', list as unknown as StoredDoc);
    for (const ch of changes) {
      this.model.put(ch.collection, ch.next);
      this.index.upsert(ch.collection, ch.next);
    }
    for (const ch of changes) {
      this.emitter.emit('change', {
        bible: this.bible.id,
        collection: ch.collection,
        id: ch.next._id,
        op: ch.op,
      });
    }
    if (listUpdates.length) this.emitter.emit('lists');
  }

  /**
   * Insert the new entries together, replace the changed ones (each only if it
   * has not changed since it was read), and append the revisions together, so a
   * large import is a handful of round trips rather than one per entry.
   */
  private async writeChanges(changes: Change[], session: ClientSession): Promise<void> {
    const byCollection = new Map<EntryCollection, Change[]>();
    for (const ch of changes) {
      const list = byCollection.get(ch.collection) ?? [];
      list.push(ch);
      byCollection.set(ch.collection, list);
    }
    for (const [collection, list] of byCollection) {
      const creates = list.filter((ch) => ch.prior === null);
      const updates = list.flatMap((ch) => (ch.prior ? [{ prior: ch.prior, next: ch.next }] : []));
      const target = this.collection(collection);
      if (creates.length) {
        await target.insertMany(
          creates.map((ch) => ch.next),
          { session, ordered: true },
        );
      }
      for (const u of updates) {
        const res = await target.replaceOne(
          { _id: u.prior._id, modifiedAt: u.prior.modifiedAt } as Document,
          u.next,
          { session },
        );
        if (res.matchedCount !== 1) {
          throw new RepositoryError('This entry changed somewhere else. Reload it and try again.');
        }
      }
    }
    if (changes.length) {
      const revisions: Revision[] = changes.map((ch) => ({
        _id: newId(),
        collection: ch.collection,
        entryId: ch.next._id,
        op: ch.op,
        at: ch.next.modifiedAt as string,
        prior: ch.prior,
        ...(ch.note ? { note: ch.note } : {}),
        ...(ch.proposalId ? { proposalId: ch.proposalId } : {}),
      }));
      await this.bible
        .collection<Revision>('revisions')
        .insertMany(revisions, { session, ordered: true });
    }
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

  private stripSystem(patch: Record<string, unknown>): Record<string, unknown> {
    // Identity, creation time, and trash state change only through their own paths.
    const {
      _id: _ignoredId,
      createdAt: _ignoredCreated,
      modifiedAt: _ignoredModified,
      deletedAt: _ignoredDeleted,
      ...rest
    } = patch;
    return rest;
  }

  private buildCreate<C extends EntryCollection>(
    c: C,
    input: Record<string, unknown>,
    opts: WriteOptions = {},
  ): Change {
    return this.buildCreateWith(c, input, true, opts);
  }

  /** A create whose shape checks run later, against the whole batch. */
  private buildCreateUnchecked(c: EntryCollection, input: Record<string, unknown>): Change {
    return this.buildCreateWith(c, input, false);
  }

  private buildCreateWith(
    c: EntryCollection,
    input: Record<string, unknown>,
    shape: boolean,
    opts: WriteOptions = {},
  ): Change {
    if (!opts.importer) this.refuseLocked(c, {}, input);
    const at = this.now().toISOString();
    const rest = this.stripSystem(input);
    const id = typeof input._id === 'string' && input._id ? input._id : newId();
    const doc = this.validate(c, { ...rest, _id: id, createdAt: at, modifiedAt: at }, shape);
    if (this.model.get(c, id)) throw new RepositoryError(`An entry with the ID ${id} exists.`);
    return { collection: c, op: 'create', next: doc as StoredDoc, prior: null };
  }

  private buildUpdate(
    c: EntryCollection,
    prior: StoredDoc,
    patch: Record<string, unknown>,
    opts: WriteOptions = {},
  ): Change {
    if (!opts.importer) this.refuseLocked(c, prior, patch);
    const doc = this.validate(c, {
      ...prior,
      ...this.stripSystem(patch),
      modifiedAt: this.stamp(prior),
    });
    return { collection: c, op: 'update', next: doc as StoredDoc, prior };
  }

  private buildSoftDelete(c: EntryCollection, prior: StoredDoc): Change {
    if (prior.deletedAt) throw new RepositoryError('This entry is already in the trash.');
    const at = this.stamp(prior);
    const doc = this.validate(c, { ...prior, deletedAt: at, modifiedAt: at });
    return { collection: c, op: 'softDelete', next: doc as StoredDoc, prior };
  }

  async create<C extends EntryCollection>(
    c: C,
    input: CreateInput<C>,
    opts: WriteOptions = {},
  ): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const change = this.buildCreate(c, input as Record<string, unknown>, opts);
    await this.commit([change]);
    return change.next as EntryOf<C>;
  }

  /**
   * Create several entries in one transaction, for in-tree actions that make a
   * person and the link to them together (FT-2), and for loading many at once.
   * Either every entry is written or none is.
   */
  async createMany(
    items: { collection: EntryCollection; data: Record<string, unknown> }[],
  ): Promise<StoredDoc[]> {
    const changes: Change[] = [];
    const ids = new Set<string>();
    for (const item of items) {
      this.assertCollection(item.collection);
      const change = this.buildCreateUnchecked(item.collection, item.data);
      if (ids.has(change.next._id)) {
        throw new RepositoryError(`Two new entries share the ID ${change.next._id}.`);
      }
      ids.add(change.next._id);
      changes.push(change);
    }
    const links = changes.filter((ch) => ch.collection === 'parentLinks').map((ch) => ch.next);
    for (const ch of changes) {
      this.checkShape(ch.collection, ch.next, false);
      if (ch.collection === 'parentLinks') this.checkNotOwnAncestor(ch.next, links);
    }
    await this.commit(changes);
    return changes.map((ch) => ch.next);
  }

  async update<C extends EntryCollection>(
    c: C,
    id: string,
    patch: Patch<C>,
    opts: WriteOptions = {},
  ): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    const change = this.buildUpdate(c, prior, patch as Record<string, unknown>, opts);
    await this.commit([change]);
    return change.next as EntryOf<C>;
  }

  /**
   * Several creates, updates, and moves to the trash in one transaction, each
   * with a revision (M8: an alignment run's findings, and Manuscript wins
   * applying a change set together with the finding's new state, CC-4). With
   * `bulk`, a snapshot is taken first (BK-1). Either everything is written or nothing is.
   */
  async writeBatch(
    ops: (
      | { op: 'create'; collection: EntryCollection; data: Record<string, unknown> }
      | { op: 'update'; collection: EntryCollection; id: string; patch: Record<string, unknown> }
      | { op: 'softDelete'; collection: EntryCollection; id: string }
    )[],
    opts: { note?: string; bulk?: string } = {},
  ): Promise<StoredDoc[]> {
    if (!ops.length) return [];
    if (opts.bulk) await this.bulkGuard(opts.bulk);
    const changes: Change[] = [];
    const seen = new Set<string>();
    for (const o of ops) {
      this.assertCollection(o.collection);
      let change: Change;
      if (o.op === 'create') change = this.buildCreate(o.collection, o.data);
      else {
        if (seen.has(`${o.collection}:${o.id}`)) {
          throw new RepositoryError(`One batch changes ${o.id} twice.`);
        }
        const prior = await this.current(o.collection, o.id);
        change =
          o.op === 'update'
            ? this.buildUpdate(o.collection, prior, o.patch)
            : this.buildSoftDelete(o.collection, prior);
      }
      seen.add(`${o.collection}:${change.next._id}`);
      if (opts.note) change.note = opts.note;
      changes.push(change);
    }
    await this.commit(changes);
    return changes.map((c) => c.next);
  }

  /** Move to the trash (ED-5). Links are kept so a restore brings them back. */
  async softDelete<C extends EntryCollection>(c: C, id: string): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const change = this.buildSoftDelete(c, await this.current(c, id));
    await this.commit([change]);
    return change.next as EntryOf<C>;
  }

  async restore<C extends EntryCollection>(c: C, id: string): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    if (!prior.deletedAt) throw new RepositoryError('This entry is not in the trash.');
    const { deletedAt: _cleared, ...rest } = prior;
    const doc = this.validate(c, { ...rest, modifiedAt: this.stamp(prior) });
    await this.commit([{ collection: c, op: 'restore', next: doc as StoredDoc, prior }]);
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
    return doc as EntryOf<C>;
  }

  list<C extends EntryCollection>(
    c: C,
    opts: { includeDeleted?: boolean; onlyDeleted?: boolean } = {},
  ): EntryOf<C>[] {
    this.assertCollection(c);
    return this.model
      .all(c)
      .filter((d) =>
        opts.onlyDeleted ? Boolean(d.deletedAt) : opts.includeDeleted || !d.deletedAt,
      ) as EntryOf<C>[];
  }

  /** Every entry in the trash, newest first (ED-5). */
  trash(): { collection: EntryCollection; entry: StoredDoc }[] {
    const out: { collection: EntryCollection; entry: StoredDoc }[] = [];
    for (const c of Object.keys(entrySchemas) as EntryCollection[]) {
      for (const d of this.model.all(c)) if (d.deletedAt) out.push({ collection: c, entry: d });
    }
    return out.sort((a, b) => String(b.entry.deletedAt).localeCompare(String(a.entry.deletedAt)));
  }

  /** Field warnings for an entry (ED-10). They never block a write. */
  warnings(c: EntryCollection, doc: StoredDoc): FieldWarning[] {
    return computeWarnings(c, manifests[c], doc, {
      get: (col, id) => this.model.get(col, id),
      find: (id) => this.model.find(id),
      list: (id) => this.model.get('lists', id) as ListDoc | undefined,
      all: (col) => this.model.all(col),
    });
  }

  /** Entries that refer to this one, through links or reference fields (ED-9). */
  backlinks(id: string, opts: { includeDeleted?: boolean } = {}): Backlink[] {
    return this.model.backlinks(id, opts);
  }

  /** What deleting an entry would leave pointing at the trash (ED-5). */
  linkedFrom(id: string): { count: number; entries: (Backlink & { title: string })[] } {
    const entries = this.model.backlinks(id).map((b) => ({
      ...b,
      title: entryTitle(this.model.get(b.collection, b.id)),
    }));
    return { count: new Set(entries.map((e) => `${e.collection}:${e.id}`)).size, entries };
  }

  async revisions(c: EntryCollection, id: string): Promise<Revision[]> {
    return this.bible
      .collection<Revision>('revisions')
      .find({ collection: c, entryId: id })
      .sort({ _id: 1 })
      .toArray();
  }

  /**
   * The history of one entry, newest first, each with the entry as it stood
   * after that write (ED-4). A revision holds the document before its write,
   * so the state after write N is the prior of write N+1, or the current one.
   */
  async history(c: EntryCollection, id: string): Promise<RevisionView[]> {
    this.assertCollection(c);
    const current = await this.current(c, id);
    const revs = await this.revisions(c, id);
    return revs
      .map((r, i) => ({
        _id: r._id,
        op: r.op,
        at: r.at,
        note: r.note ?? null,
        proposalId: r.proposalId ?? null,
        snapshot: revs[i + 1]?.prior ?? current,
      }))
      .reverse();
  }

  private async revision(c: EntryCollection, id: string, revisionId: string) {
    const view = (await this.history(c, id)).find((r) => r._id === revisionId);
    if (!view) throw new RepositoryError('That revision does not belong to this entry.');
    return view;
  }

  /** A side-by-side comparison of one revision with the current entry (ED-4). */
  async revisionDiff(
    c: EntryCollection,
    id: string,
    revisionId: string,
  ): Promise<{ revision: RevisionView; current: StoredDoc; changes: FieldChange[] }> {
    const revision = await this.revision(c, id, revisionId);
    const current = await this.current(c, id);
    return { revision, current, changes: diffEntries(revision.snapshot, current) };
  }

  /** Bring back the content of an earlier revision as a new write (ED-4). Trash state is kept. */
  async restoreRevision<C extends EntryCollection>(
    c: C,
    id: string,
    revisionId: string,
  ): Promise<EntryOf<C>> {
    const revision = await this.revision(c, id, revisionId);
    const prior = await this.current(c, id);
    const doc = this.validate(c, {
      ...withoutLocked(c, contentOf(revision.snapshot)),
      ...this.lockedValues(c, prior),
      _id: prior._id,
      createdAt: prior.createdAt,
      modifiedAt: this.stamp(prior),
      ...(prior.deletedAt ? { deletedAt: prior.deletedAt } : {}),
    });
    await this.commit([
      {
        collection: c,
        op: 'update',
        next: doc as StoredDoc,
        prior,
        note: `Restored the version from ${revision.at}`,
      },
    ]);
    return doc;
  }

  // ---------- lists (ED-8) ----------

  private allDocs(): CollectionDocs[] {
    return (Object.keys(entrySchemas) as EntryCollection[]).map((c) => ({
      collection: c,
      manifest: manifests[c],
      docs: this.model.all(c),
    }));
  }

  private storedList(listId: string): ListDoc {
    const doc = this.model.get('lists', listId);
    if (!doc) throw new RepositoryError(`There is no list called ${listId}.`);
    return ListDoc.parse(doc);
  }

  private derivedItems(listId: DerivedListId): ListViewItem[] {
    const live = (c: EntryCollection) => this.model.all(c).filter((d) => !d.deletedAt);
    if (listId === 'families') {
      return live('families').map((d) => ({
        id: d._id,
        label: String(d.name),
        parentId: null,
        usage: this.model.backlinks(d._id).length,
      }));
    }
    return live('eraStates')
      .sort((a, b) => Number(a.startYear) - Number(b.startYear))
      .map((d) => ({
        id: d._id,
        label: String(d.name),
        parentId: null,
        usage: this.model.backlinks(d._id).length,
        detail: `${String(d.startYear)} to ${String(d.endYear)}`,
      }));
  }

  /** Every editable list with how many entries use each item. */
  lists(): ListView[] {
    const all = this.allDocs();
    const stored: ListView[] = LIST_IDS.filter((id) => this.model.get('lists', id)).map((id) => {
      const list = this.storedList(id);
      return {
        _id: id,
        label: list.label,
        derived: false,
        fixedItems: FIXED_ITEM_LISTS.includes(id),
        items: list.items.map((item) => ({
          ...item,
          usage: countListUsage(id, item, all),
        })),
      };
    });
    const labels: Record<DerivedListId, string> = {
      families: 'Families',
      eraRanges: 'Era names and ranges',
    };
    const derived: ListView[] = DERIVED_LIST_IDS.map((id) => ({
      _id: id,
      label: labels[id],
      derived: true,
      fixedItems: true,
      items: this.derivedItems(id),
    }));
    return [...stored, ...derived];
  }

  /**
   * Rename a list item and update every entry that uses it, in one
   * transaction with a revision for each entry (ED-8).
   */
  async renameListItem(
    listId: string,
    itemId: string,
    label: string,
  ): Promise<{ updated: number; from: string }> {
    const to = label.trim();
    if (!to) throw new RepositoryError('A list item needs a name.');
    await this.bulkGuard('list rename');
    if (isDerived(listId)) {
      const collection = listId === 'families' ? 'families' : 'eraStates';
      const prior = await this.current(collection, itemId);
      const from = String(prior.name);
      const { patch } = derivedRename(listId, prior, to);
      await this.commit([
        { ...this.buildUpdate(collection, prior, patch), note: `Renamed ${from} to ${to}` },
      ]);
      return { updated: 1, from };
    }
    const list = this.storedList(listId);
    const item = list.items.find((i) => i.id === itemId);
    if (!item) throw new RepositoryError(`The ${list.label} list has no item ${itemId}.`);
    const from = item.label;
    if (from === to) return { updated: 0, from };
    const clash = list.items.find((i) => i.id !== itemId && i.label === to);
    if (clash && listId !== 'tags') {
      throw new RepositoryError(`The ${list.label} list already has an item called ${to}.`);
    }
    // Renaming a tag onto an existing tag merges the two.
    const items = clash
      ? list.items.filter((i) => i.id !== itemId)
      : list.items.map((i) => (i.id === itemId ? { ...i, label: to } : i));
    const patches = renameCascade(listId, from, to, this.allDocs());
    const changes: Change[] = [];
    for (const p of patches) {
      const collection = p.collection as EntryCollection;
      const prior = await this.current(collection, p.id);
      changes.push({
        ...this.buildUpdate(collection, prior, p.patch),
        note: `Renamed ${from} to ${to} in ${list.label}`,
      });
    }
    await this.commit(changes, undefined, [{ ...list, items }]);
    return { updated: changes.length, from };
  }

  async addListItem(
    listId: string,
    label: string,
    parentId: string | null = null,
    /** The ID to use when it is free (an undo putting an item back); otherwise one is made from the label. */
    wantedId?: string,
  ): Promise<ListItem> {
    if (isDerived(listId) || FIXED_ITEM_LISTS.includes(listId)) {
      throw new RepositoryError('Items in this list come from the entries themselves.');
    }
    const name = label.trim();
    if (!name) throw new RepositoryError('A list item needs a name.');
    const list = this.storedList(listId);
    if (list.items.some((i) => i.label === name)) {
      throw new RepositoryError(`The ${list.label} list already has an item called ${name}.`);
    }
    if (parentId && !list.items.some((i) => i.id === parentId)) {
      throw new RepositoryError('The parent item is not in this list.');
    }
    const id =
      wantedId && !list.items.some((i) => i.id === wantedId) ? wantedId : newItemId(list, name);
    const item: ListItem = { id, label: name, parentId };
    await this.commit([], undefined, [{ ...list, items: [...list.items, item] }]);
    return item;
  }

  /** Remove an unused item. An item in use is kept, and the message says how many use it. */
  async removeListItem(listId: string, itemId: string): Promise<void> {
    if (isDerived(listId) || FIXED_ITEM_LISTS.includes(listId)) {
      throw new RepositoryError('Items in this list come from the entries themselves.');
    }
    const list = this.storedList(listId);
    const item = list.items.find((i) => i.id === itemId);
    if (!item) throw new RepositoryError(`The ${list.label} list has no item ${itemId}.`);
    const usage = countListUsage(listId, item, this.allDocs());
    if (usage > 0) {
      throw new RepositoryError(
        `${usage} ${usage === 1 ? 'entry uses' : 'entries use'} ${item.label}. Change them first, or rename the item instead.`,
      );
    }
    if (list.items.some((i) => i.parentId === itemId)) {
      throw new RepositoryError(`${item.label} has items under it. Move or remove them first.`);
    }
    await this.commit([], undefined, [
      { ...list, items: list.items.filter((i) => i.id !== itemId) },
    ]);
  }

  // ---------- proposals (ED-7) ----------

  private proposals() {
    return this.bible.collection<Proposal>('proposals');
  }

  /** Record a change for approval. Nothing in the bible changes. */
  async propose(input: {
    source: Proposal['source'];
    op: Proposal['op'];
    collection: string;
    targetId?: string | null;
    data?: Record<string, unknown>;
    reason?: string;
    listAdd?: ListAddInput;
  }): Promise<Proposal> {
    if (input.op === 'listAdd') return this.proposeListAdd(input);
    this.assertCollection(input.collection);
    const target = input.targetId ? this.model.get(input.collection, input.targetId) : undefined;
    if (input.op !== 'create' && !target) {
      throw new RepositoryError(`No ${input.collection} entry has the ID ${input.targetId}.`);
    }
    // ED-7: a proposal is checked against its kind's schema when it is made, as a deep partial:
    // a field the kind does not have (SM-1, SM-4), top level or nested, is refused now, and so is
    // a value of the wrong shape, not when the proposal is approved.
    if (input.op !== 'delete' && input.data) {
      const schema = entrySchemas[input.collection];
      const data = this.stripSystem(input.data);
      const plural = collectionInfo[input.collection].plural;
      const unknown = unknownPaths(schema, data);
      if (unknown.length) {
        throw new RepositoryError(
          `${plural} have no ${unknown.length === 1 ? 'field' : 'fields'} named ${unknown.join(', ')}, so this change cannot be proposed.`,
        );
      }
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      for (const [k, v] of Object.entries(data)) {
        const r = shape[k]?.safeParse(v);
        const issue = r && !r.success ? r.error.issues[0] : undefined;
        if (issue) {
          const at = [k, ...issue.path.map(String)].join('.');
          throw new RepositoryError(
            `The proposed ${at} is not valid: ${issue.message}. This change cannot be proposed.`,
          );
        }
      }
    }
    const proposal = Proposal.parse({
      _id: newId(),
      source: input.source,
      op: input.op,
      collection: input.collection,
      targetId: input.targetId ?? null,
      data: input.data ?? {},
      baseModifiedAt: target ? target.modifiedAt : null,
      reason: input.reason ?? '',
      createdAt: this.now().toISOString(),
      ...this.proposalGuard(input, target),
    });
    await this.proposals().insertOne(proposal);
    this.model.put('proposals', proposal as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return proposal;
  }

  listProposals(state?: Proposal['state']): Proposal[] {
    return (this.model.all('proposals') as unknown as Proposal[])
      .filter((p) => !state || p.state === state)
      .sort((a, b) => a._id.localeCompare(b._id));
  }

  /** What a proposal would change, against the entry as it is now. */
  proposalDiff(id: string): { proposal: Proposal; changes: FieldChange[]; conflict: boolean } {
    const proposal = this.proposal(id);
    if (proposal.op === 'listAdd') return this.listAddDiff(proposal);
    const c = proposal.collection as EntryCollection;
    const current = proposal.targetId ? (this.model.get(c, proposal.targetId) ?? null) : null;
    const after =
      proposal.op === 'delete'
        ? null
        : { ...(current ?? {}), ...this.shownRefs(proposal, this.stripSystem(proposal.data)) };
    const conflict =
      proposal.baseModifiedAt !== null && current?.modifiedAt !== proposal.baseModifiedAt;
    return { proposal, changes: diffEntries(current, after), conflict };
  }

  private proposal(id: string): Proposal {
    const p = this.model.get('proposals', id);
    if (!p) throw new RepositoryError(`There is no proposal with the ID ${id}.`);
    return Proposal.parse(p);
  }

  private pending(id: string): Proposal {
    const proposal = this.proposal(id);
    if (proposal.state !== 'pending') {
      throw new RepositoryError(`This proposal is already ${proposal.state}.`);
    }
    return proposal;
  }

  private async saveProposal(p: Proposal): Promise<Proposal> {
    const res = await this.proposals().replaceOne({ _id: p._id, state: 'pending' }, p);
    if (res.matchedCount !== 1) throw new RepositoryError('This proposal was already decided.');
    this.model.put('proposals', p as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return p;
  }

  /**
   * Change what a proposal would write before approving it (ED-7). The new
   * values are checked against the schema now, so approval cannot fail on them.
   */
  async editProposal(id: string, data: Record<string, unknown>): Promise<Proposal> {
    const proposal = this.pending(id);
    if (proposal.op === 'delete') throw new RepositoryError('A deletion has no values to edit.');
    if (proposal.op === 'listAdd') throw new RepositoryError(LIST_ADD_NO_EDIT);
    const c = proposal.collection as EntryCollection;
    const clean = this.stripSystem(data);
    if (proposal.op === 'update') {
      this.buildUpdate(c, await this.current(c, String(proposal.targetId)), clean);
    } else {
      this.refuseLocked(c, {}, clean);
      this.validate(c, {
        ...clean,
        _id: 'CHECK',
        createdAt: this.now().toISOString(),
        modifiedAt: this.now().toISOString(),
      });
    }
    return this.saveProposal({
      ...proposal,
      data: clean,
      edited: true,
      uses: this.usesIn(clean, proposal.uses),
    });
  }

  /** Compare again: take the entry as it is now as the proposal's base, so it can be approved. */
  async refreshProposal(id: string): Promise<Proposal> {
    const proposal = this.pending(id);
    if (!proposal.targetId) return proposal;
    const current = await this.current(proposal.collection as EntryCollection, proposal.targetId);
    return this.saveProposal({ ...proposal, baseModifiedAt: String(current.modifiedAt) });
  }

  /**
   * Apply an approved proposal through the write path and record the approval
   * on the proposal and on the entry's revision, in one transaction (ED-7).
   * A proposal whose entry changed after it was made is refused: the person
   * has not seen the change against the entry as it is now.
   */
  async applyProposal(id: string): Promise<Proposal> {
    const proposal = this.pending(id);
    if (proposal.op === 'listAdd') return this.applyListAdd(proposal);
    await this.bulkGuard('approved proposal');
    const c = proposal.collection as EntryCollection;
    this.assertCollection(c);
    const minted = this.mintFor(proposal);
    const data = minted.data;
    let change: Change;
    if (proposal.op === 'create') {
      change = this.buildCreate(c, { ...data, _id: proposal.targetId ?? data._id });
    } else {
      const prior = await this.current(c, String(proposal.targetId));
      if (proposal.baseModifiedAt !== null && prior.modifiedAt !== proposal.baseModifiedAt) {
        throw new RepositoryError(
          'This entry changed after the proposal was made, so it was not approved. Compare again to see the proposal against the entry as it is now.',
        );
      }
      change =
        proposal.op === 'update'
          ? this.buildUpdate(c, prior, data)
          : this.buildSoftDelete(c, prior);
    }
    change.note = `Approved a proposal from ${proposal.source}`;
    change.proposalId = proposal._id;
    const decided: Proposal = {
      ...proposal,
      state: 'approved',
      decidedAt: this.now().toISOString(),
      appliedEntryId: change.next._id,
      data,
    };
    await this.commit(
      [change],
      async (session) => {
        const res = await this.proposals().replaceOne({ _id: id, state: 'pending' }, decided, {
          session,
        });
        if (res.matchedCount !== 1) throw new RepositoryError('This proposal was already decided.');
        await this.saveDecided(minted.decided, session);
      },
      minted.lists,
    );
    for (const p of minted.decided) this.model.put('proposals', p as unknown as StoredDoc);
    this.model.put('proposals', decided as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return decided;
  }

  async rejectProposal(id: string): Promise<Proposal> {
    const proposal = this.proposal(id);
    if (proposal.state !== 'pending') {
      throw new RepositoryError(`This proposal is already ${proposal.state}.`);
    }
    const decided: Proposal = {
      ...proposal,
      state: 'rejected',
      decidedAt: this.now().toISOString(),
    };
    const res = await this.proposals().replaceOne({ _id: id, state: 'pending' }, decided);
    if (res.matchedCount !== 1) throw new RepositoryError('This proposal was already decided.');
    this.model.put('proposals', decided as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return decided;
  }

  // ---------- import (IM-3, IM-7) ----------

  /** What earlier imports recorded about where each field's value came from. */
  sourceRecords(entryId: string): SourceRecord[] {
    const doc = this.model.get('importSources', entryId);
    return Array.isArray(doc?.fields) ? (doc.fields as SourceRecord[]) : [];
  }

  /**
   * Write the approved changes of an import in one transaction (ED-7, IM-3):
   * new entries, changes to entries already imported, the list choices they
   * need, the record of where each field came from, and an open question for
   * every field where two sources disagreed (IM-7). Either all of it is
   * written or none. Entries changed since the plan was made are refused.
   */
  async applyImport(input: {
    file: { fileName: string; modifiedAt: string };
    items: ChangeItem[];
    listAdds: ListAdd[];
  }): Promise<{ created: number; updated: number; questions: number }> {
    await this.bulkGuard('import');
    const note = `Imported from ${input.file.fileName}`;
    const changes: Change[] = [];
    let created = 0;
    let updated = 0;
    let questions = 0;
    const touched = new Map<string, { collection: EntryCollection; records: SourceRecord[] }>();
    for (const item of input.items) {
      this.assertCollection(item.collection);
      if (item.kind === 'new') {
        const data: Record<string, unknown> = {
          ...(item.data as Record<string, unknown>),
          _id: item.entryId,
        };
        const change = this.buildCreate(item.collection, data, { importer: true });
        changes.push({ ...change, note });
        created += 1;
      } else {
        const prior = await this.current(item.collection, item.entryId);
        if (item.baseModifiedAt !== undefined && prior.modifiedAt !== item.baseModifiedAt) {
          throw new RepositoryError(
            `${entryTitle(prior)} changed after the import was compared, so nothing was written. Compare again.`,
          );
        }
        if (item.patch && Object.keys(item.patch).length > 0) {
          changes.push({
            ...this.buildUpdate(item.collection, prior, item.patch, { importer: true }),
            note,
          });
          updated += 1;
        }
      }
      if (item.records.length) {
        touched.set(item.entryId, { collection: item.collection, records: item.records });
      }
      // An open question about this entry that already lists a field is brought up to date, not asked again.
      const askedAbout = this.model
        .all('openQuestions')
        .filter(
          (q) =>
            !q.deletedAt &&
            q.state === 'open' &&
            Array.isArray(q.links) &&
            (q.links as { targetId?: unknown; kind?: unknown }[]).some(
              (l) => l.targetId === item.entryId && l.kind === 'conflict',
            ),
        );
      const fresh: Conflict[] = [];
      const reworded = new Map<string, string>();
      for (const c of item.deltas.flatMap((d) => (d.conflict ? [d.conflict] : []))) {
        let handled = false;
        for (const q of askedAbout) {
          const text = reworded.get(String(q._id)) ?? String(q.question ?? '');
          if (questionCovers(text, c)) {
            handled = true;
            break;
          }
          if (text.split('\n').some((l, i) => i > 0 && l.startsWith(`${c.label}: `))) {
            const next = questionWithConflict(text, c);
            if (next !== null) reworded.set(String(q._id), next);
            handled = true;
            break;
          }
        }
        if (!handled) fresh.push(c);
      }
      for (const [id, text] of reworded) {
        const prior = askedAbout.find((q) => String(q._id) === id);
        if (!prior) continue;
        changes.push({ ...this.buildUpdate('openQuestions', prior, { question: text }), note });
      }
      const conflicts = fresh;
      if (conflicts.length) {
        const q = conflictQuestion(item.title, conflicts);
        changes.push({
          ...this.buildCreate('openQuestions', {
            title: q.title,
            question: q.question,
            state: 'open',
            status: 'planned',
            sourceRef: item.ref,
            links: [{ targetId: item.entryId, kind: 'conflict' }],
          }),
          note,
        });
        questions += 1;
      }
    }
    const lists = this.listsWithAdds(input.listAdds);
    const sourceDocs = [...touched].map(([entryId, t]) => {
      const prior = this.sourceRecords(entryId);
      const fields = [
        ...prior.filter((r) => !t.records.some((n) => n.path === r.path)),
        ...t.records,
      ];
      return { _id: entryId, collection: t.collection, fields };
    });
    await this.commit(
      changes,
      async (session) => {
        for (const doc of sourceDocs) {
          await this.bible
            .collection<StoredDoc>('importSources')
            .replaceOne({ _id: doc._id }, doc, { session, upsert: true });
        }
      },
      lists,
    );
    for (const doc of sourceDocs) this.model.put('importSources', doc as unknown as StoredDoc);
    return { created, updated, questions };
  }

  /** The lists with the import's new choices added, ready to write. */
  private listsWithAdds(adds: ListAdd[]): ListDoc[] {
    const out = new Map<string, ListDoc>();
    for (const add of adds) {
      const base =
        out.get(add.listId) ??
        (this.model.get('lists', add.listId) as ListDoc | undefined) ??
        ({ _id: add.listId, label: add.listId, items: [] } as ListDoc);
      if (base.items.some((i) => i.id === add.id)) continue;
      out.set(add.listId, {
        ...base,
        items: [...base.items, { id: add.id, label: add.label, parentId: add.parentId }],
      });
    }
    return [...out.values()];
  }

  // ---------- backup settings (BK-1) ----------

  /** How many snapshots to keep; 30 unless the person changed it. */
  snapshotKeep(): number {
    const doc = this.model.get('meta', SNAPSHOT_SETTINGS_ID);
    return typeof doc?.keep === 'number' && doc.keep >= 1 ? Math.floor(doc.keep) : 30;
  }

  async setSnapshotKeep(keep: number): Promise<number> {
    if (!Number.isInteger(keep) || keep < 1 || keep > 1000) {
      throw new RepositoryError('Keep between 1 and 1000 snapshots.');
    }
    await this.writeMeta({ _id: SNAPSHOT_SETTINGS_ID, keep });
    return keep;
  }

  /** Saved column mappings, keyed by file name and sheet (IM-1). Stored in `meta`. */
  savedMappings(): Record<string, unknown> {
    const doc = this.model.get('meta', IMPORT_MAPPINGS_ID);
    const list = (Array.isArray(doc?.mappings) ? doc.mappings : []) as {
      key: string;
      mapping: unknown;
    }[];
    return Object.fromEntries(list.map((m) => [m.key, m.mapping]));
  }

  async saveMapping(key: string, mapping: unknown): Promise<void> {
    // A list, not an object, because file names and sheet names contain dots.
    const kept = Object.entries(this.savedMappings())
      .filter(([k]) => k !== key)
      .map(([k, m]) => ({ key: k, mapping: m }));
    await this.writeMeta({
      _id: IMPORT_MAPPINGS_ID,
      mappings: [...kept, { key, mapping }],
    });
  }

  // ---------- Google Drive links (GD-2, GD-3; stored in meta, never a token) ----------

  /** The Drive files and folders linked to this bible, and the version of each file last brought in. */
  driveState(): { links: DriveLink[]; seen: DriveSeen[]; known: DriveKnown[] } {
    const doc = this.model.get('meta', DRIVE_ID);
    // Read through shape checks: a hand-edited or older meta document cannot reach the screens as a cast.
    const rows = <T>(value: unknown, ok: (r: Record<string, unknown>) => boolean): T[] =>
      (Array.isArray(value) ? value : []).filter(
        (r): r is T => !!r && typeof r === 'object' && ok(r as Record<string, unknown>),
      );
    const text = (v: unknown) => typeof v === 'string' && v.length > 0;
    return {
      links: rows<DriveLink>(
        doc?.links,
        (r) =>
          text(r.id) &&
          text(r.name) &&
          text(r.mimeType) &&
          (r.kind === 'folder' || r.kind === 'workbook' || r.kind === 'document'),
      ),
      seen: rows<DriveSeen>(doc?.seen, (r) => text(r.fileId) && text(r.modifiedTime)),
      known: rows<DriveKnown>(
        doc?.known,
        (r) =>
          text(r.fileId) &&
          text(r.linkId) &&
          text(r.name) &&
          text(r.mimeType) &&
          (r.kind === 'workbook' || r.kind === 'document'),
      ),
    };
  }

  async setDriveState(state: {
    links: DriveLink[];
    seen: DriveSeen[];
    known?: DriveKnown[];
  }): Promise<void> {
    await this.writeMeta({
      _id: DRIVE_ID,
      links: state.links,
      seen: state.seen,
      known: state.known ?? this.driveState().known,
    });
  }

  /** Tell views that the whole bible was replaced, after a restore or a file import. */
  announceReload(message: string): void {
    this.emitter.emit('reload', message);
  }

  onReload(listener: (message: string) => void): () => void {
    this.emitter.on('reload', listener);
    return () => this.emitter.off('reload', listener);
  }

  // ---------- story time (TM-3, stored in meta, never an entry) ----------

  /** The current story time, or null when none is set. */
  storyTime(): StoryTimeValue | null {
    const doc = this.model.get('meta', STORY_TIME_ID);
    if (!doc || typeof doc.year !== 'number') return null;
    const r = StoryTimeValue.safeParse({
      year: doc.year,
      ...(typeof doc.month === 'number' ? { month: doc.month } : {}),
      ...(typeof doc.month === 'number' && typeof doc.day === 'number' ? { day: doc.day } : {}),
      ...(typeof doc.chapterId === 'string' ? { chapterId: doc.chapterId } : {}),
      ...(typeof doc.chapterId === 'string' && typeof doc.strandId === 'string'
        ? { strandId: doc.strandId }
        : {}),
    });
    return r.success ? r.data : { year: doc.year };
  }

  /** Set or clear the story time. It writes only the meta document, never an entry (TM-5). */
  async setStoryTime(value: StoryTimeValue | null): Promise<StoryTimeValue | null> {
    if (value === null) await this.writeMeta(null, STORY_TIME_ID);
    else await this.writeMeta({ _id: STORY_TIME_ID, ...StoryTimeValue.parse(value) });
    this.emitter.emit('storyTime');
    return this.storyTime();
  }

  /**
   * TM-5: promote a year into one chapter strand, an explicit action the
   * person confirms after seeing the change (ED-7). It goes through the one
   * write path with a revision note. Refused when the chapter changed after
   * the person saw the change.
   */
  async setStrandYear(
    chapterId: string,
    strandId: string,
    year: number,
    baseModifiedAt: string,
  ): Promise<StoredDoc> {
    const prior = await this.current('chapters', chapterId);
    if (prior.modifiedAt !== baseModifiedAt) {
      throw new RepositoryError(
        'This chapter changed after you saw the change, so nothing was written. Look at the change again.',
      );
    }
    const strands = (Array.isArray(prior.strands) ? prior.strands : []) as object[];
    const shifted = shiftStrand(strands, strandId, year);
    if (!shifted) throw new RepositoryError('That strand is no longer in this chapter.');
    const { strand, next } = shifted;
    const change = this.buildUpdate('chapters', prior, { strands: next });
    change.note = `Set the ${strand.label} strand year to ${year} from the story time`;
    await this.commit([change]);
    return change.next;
  }

  /**
   * WE-2: give a new bible its default eras, copied from the `eraDefaults`
   * list into era state entries through the write path. Does nothing when
   * the bible already has eras, in the trash or not.
   */
  async seedDefaultEras(): Promise<number> {
    if (this.model.all('eraStates').length > 0) return 0;
    const list = this.model.get('lists', 'eraDefaults') as ListDoc | undefined;
    const ranges = (list?.items ?? [])
      .map(eraRangeFromItem)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (!ranges.length) return 0;
    const changes = ranges.map((r) => ({
      ...this.buildCreate('eraStates', {
        title: r.name,
        name: r.name,
        status: 'planned',
        provenance: 'invented',
        startYear: r.startYear,
        endYear: r.endYear,
      }),
      note: 'Default era for a new bible',
    }));
    await this.commit(changes);
    return changes.length;
  }

  // Plot reorder (PL-3) and romanization settings (GL-1).

  /**
   * Change the order fields of several chapters in one transaction (PL-3).
   * Each patch carries only a chapter's reading order and part; story years
   * are never touched. Each entry gets a revision, so each step can be undone.
   */
  async reorder(
    collection: 'chapters',
    patches: { id: string; patch: Record<string, unknown> }[],
  ): Promise<StoredDoc[]> {
    const allowed = ['readingOrder', 'partId'];
    const changes: Change[] = [];
    for (const m of patches) {
      const stray = Object.keys(m.patch).filter((k) => !allowed.includes(k));
      if (stray.length) {
        throw new RepositoryError(`A reorder may only change ${allowed.join(' and ')}.`);
      }
      const prior = await this.current(collection, m.id);
      changes.push({ ...this.buildUpdate(collection, prior, m.patch), note: 'Reordered chapters' });
    }
    if (changes.length) await this.commit(changes);
    return changes.map((c) => c.next);
  }

  /**
   * One romanization system per language (GL-1). This is a settings write, in
   * the same class as the story time and the tree layout: it is stored in the
   * `meta` collection, is not an entry, and so has no entry revision and no
   * undo step. Changing it is one visible action on the Romanization screen
   * that can be changed back there. Every settings write goes through
   * `writeMeta`, the one place that touches `meta`.
   */
  romanizationSettings(): RomanizationSettings {
    return settingsFromMeta(this.model.get('meta', ROMANIZATION_META_ID));
  }

  async setRomanization(
    languageId: string,
    systemId: string | null,
  ): Promise<RomanizationSettings> {
    const languages = this.model.get('lists', 'languages') as ListDoc | undefined;
    const systems = this.model.get('lists', 'romanizationSystems') as ListDoc | undefined;
    if (!languages?.items.some((i) => i.id === languageId)) {
      throw new RepositoryError('That language is not in the Languages list.');
    }
    if (systemId !== null && !systems?.items.some((i) => i.id === systemId)) {
      throw new RepositoryError('That romanization system is not in the list.');
    }
    // An empty string records "no system" so the default does not apply.
    const next = { ...this.romanizationSettings(), [languageId]: systemId ?? '' };
    await this.writeMeta({ _id: ROMANIZATION_META_ID, systems: next });
    // Glossary warnings depend on this, so views reload.
    this.emitter.emit('lists');
    return next;
  }

  /** Stored tree positions keyed by character ID (FT-10), or null when none are stored. */
  treePositions(): Record<string, { x: number; y: number; loose?: boolean }> | null {
    const doc = this.model.get('meta', TREE_LAYOUT_ID);
    const p = doc?.positions;
    return p && typeof p === 'object'
      ? (p as Record<string, { x: number; y: number; loose?: boolean }>)
      : null;
  }

  /**
   * Save the tree positions. Layout is not an entry: no revision. Undo of a
   * move is a renderer command that writes back through here (ED-3), and the
   * tree reloads on the change event either way.
   */
  async setTreePositions(
    positions: Record<string, { x: number; y: number; loose?: boolean }>,
  ): Promise<void> {
    await this.writeMeta({ _id: TREE_LAYOUT_ID, positions });
    this.emitter.emit('tree');
  }

  /** The tree's stored positions changed (FT-11). */
  onTreeChange(listener: () => void): () => void {
    this.emitter.on('tree', listener);
    return () => this.emitter.off('tree', listener);
  }

  // ---------- scene outline (PL-5, A36: meta for the current state, its own collection for versions) ----------

  /** The scene outline: one bulleted text per bible, the chapters' breaks, the scenes' years, and when it was last saved. */
  sceneOutline(): SceneOutlineDoc {
    const doc = this.model.get('meta', SCENE_OUTLINE_ID);
    return {
      text: sceneOutlineText(doc),
      breaks: sceneBreaks(doc),
      years: sceneYears(doc),
      modifiedAt: doc && typeof doc.modifiedAt === 'string' ? doc.modifiedAt : null,
    };
  }

  private sceneVersions() {
    return this.bible.collection<SceneVersionDoc>(SCENE_VERSIONS_COLLECTION);
  }

  /**
   * Replace the scene outline. The current state is the meta document; every
   * change also lands in a version: the latest one when it was touched in the
   * last ten minutes, else a new one (`newVersion` forces a new one). An
   * outline written before versioning gets its old state as the first version
   * the first time it changes, so nothing is lost. Never an entry: no revision,
   * no undo step.
   */
  async setSceneOutline(
    text: string,
    opts: { newVersion?: boolean; breaks?: SceneBreaks; years?: SceneYears } = {},
  ): Promise<SceneOutlineDoc> {
    const prev = this.sceneOutline();
    const clean = sceneYears({ years: opts.years ?? {} });
    const cleanBreaks = sceneBreaks({ breaks: opts.breaks ?? {} });
    const changed =
      prev.text !== text || !sameYears(prev.years, clean) || !sameBreaks(prev.breaks, cleanBreaks);
    const now = this.now();
    const iso = now.toISOString();
    if (changed) {
      const versions = this.sceneVersions();
      let last = await versions.find().sort({ at: -1 }).limit(1).next();
      if (
        !last &&
        prev.modifiedAt !== null &&
        (prev.text !== '' || Object.keys(prev.breaks).length)
      ) {
        last = {
          _id: newId(),
          at: prev.modifiedAt,
          until: prev.modifiedAt,
          text: prev.text,
          breaks: prev.breaks,
          years: prev.years,
        };
        await versions.insertOne(last);
      }
      if (last && !startsNewVersion(last.until, now, opts.newVersion)) {
        await versions.updateOne(
          { _id: last._id },
          { $set: { text, breaks: cleanBreaks, years: clean, until: iso } },
        );
      } else {
        await versions.insertOne({
          _id: newId(),
          at: iso,
          until: iso,
          text,
          breaks: cleanBreaks,
          years: clean,
        });
      }
    }
    await this.writeMeta({
      _id: SCENE_OUTLINE_ID,
      text,
      breaks: cleanBreaks,
      years: clean,
      modifiedAt: iso,
    });
    return this.sceneOutline();
  }

  /** The versions, newest first, without their text. */
  async sceneOutlineVersions(): Promise<
    { id: string; at: string; until: string; scenes: number; chars: number }[]
  > {
    const docs = await this.sceneVersions().find().sort({ at: -1 }).toArray();
    return docs.map((d) => ({
      id: d._id,
      at: d.at,
      until: d.until,
      scenes: sceneCount(sceneOutlineText(d)),
      chars: sceneOutlineText(d).length,
    }));
  }

  async sceneOutlineVersion(id: string): Promise<{
    id: string;
    at: string;
    until: string;
    scenes: number;
    chars: number;
    text: string;
    breaks: SceneBreaks;
    years: SceneYears;
  }> {
    const d = await this.sceneVersions().findOne({ _id: id });
    if (!d) throw new Error('That version of the scene outline is gone.');
    const text = sceneOutlineText(d);
    return {
      id: d._id,
      at: d.at,
      until: d.until,
      scenes: sceneCount(text),
      chars: text.length,
      text,
      breaks: sceneBreaks(d),
      years: sceneYears(d),
    };
  }

  /** Make a version current again, as a new version, so the step back is itself restorable. */
  async restoreSceneOutline(id: string) {
    const v = await this.sceneOutlineVersion(id);
    return this.setSceneOutline(v.text, { newVersion: true, breaks: v.breaks, years: v.years });
  }

  /**
   * Settings writes (story time, tree layout, romanization choices): a single
   * `meta` document, replaced or removed, with the read model kept in step.
   * They are not entries, so they carry no entry revision (ARCHITECTURE rule 5
   * covers entries).
   */
  private async writeMeta(doc: StoredDoc | null, removeId?: string): Promise<void> {
    const meta = this.bible.collection<StoredDoc>('meta');
    if (doc === null) {
      const id = removeId as string;
      await meta.deleteOne({ _id: id });
      this.model.remove('meta', id);
      return;
    }
    await meta.replaceOne({ _id: doc._id }, doc, { upsert: true });
    this.model.put('meta', doc);
  }

  // ---------- brief settings (SB-2 window, SB-6 budget), stored in meta ----------

  /** The brief window in years before the story year and the size budget in characters, or their defaults (3, 40,000; A33). */
  briefSettings(): { window: number; budget: number } {
    const doc = this.model.get('meta', BRIEF_SETTINGS_ID);
    const int = (v: unknown, min: number, max: number, d: number) =>
      typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d;
    return {
      window: int(doc?.window, 0, 200, DEFAULT_SELECTION_SETTINGS.window),
      budget: int(doc?.budget, 0, 10_000_000, 40_000),
    };
  }

  /** Brief settings writes run one after another, so each merges onto the one before it. */
  private briefQueue: Promise<unknown> = Promise.resolve();

  /** A settings write, like the story time: the meta document only, no entry revision. */
  setBriefSettings(next: {
    window?: number;
    budget?: number;
  }): Promise<{ window: number; budget: number }> {
    // Two quick changes (the window, then the budget) must not each merge onto the old value.
    const run = this.briefQueue.then(() => this.writeBriefSettings(next));
    this.briefQueue = run.catch(() => undefined);
    return run;
  }

  private async writeBriefSettings(next: {
    window?: number;
    budget?: number;
  }): Promise<{ window: number; budget: number }> {
    const merged = { ...this.briefSettings(), ...next };
    if (!Number.isInteger(merged.window) || merged.window < 0 || merged.window > 200) {
      throw new RepositoryError('The brief window is a whole number of years from 0 to 200.');
    }
    if (!Number.isInteger(merged.budget) || merged.budget < 0 || merged.budget > 10_000_000) {
      throw new RepositoryError(
        'The size budget is a whole number of characters from 0 to 10,000,000.',
      );
    }
    await this.writeMeta({ _id: BRIEF_SETTINGS_ID, ...merged });
    return this.briefSettings();
  }

  onStoryTimeChange(listener: () => void): () => void {
    this.emitter.on('storyTime', listener);
    return () => this.emitter.off('storyTime', listener);
  }

  // ---------- community descriptions (A41: meta, keyed by the community list item) ----------

  /** What each community is like overall, by community ID; a community with no description is absent. */
  communityNotes(): Record<string, string> {
    const doc = this.model.get('meta', COMMUNITY_NOTES_ID);
    const notes = doc?.notes;
    const out: Record<string, string> = {};
    if (notes && typeof notes === 'object') {
      for (const [id, text] of Object.entries(notes as Record<string, unknown>)) {
        if (typeof text === 'string' && text !== '') out[id] = text;
      }
    }
    return out;
  }

  /** Set or clear a community's description. The lists event reloads the screens that show it. */
  async setCommunityNote(communityId: string, text: string): Promise<Record<string, string>> {
    const list = this.model.get('lists', 'communities') as ListDoc | undefined;
    if (!list?.items.some((i) => i.id === communityId)) {
      throw new RepositoryError('That community is not in the Communities list.');
    }
    const clean = text.trim();
    const notes = Object.fromEntries(
      Object.entries(this.communityNotes()).filter(([id]) => id !== communityId),
    );
    if (clean) notes[communityId] = clean;
    await this.writeMeta({ _id: COMMUNITY_NOTES_ID, notes });
    this.emitter.emit('lists');
    return this.communityNotes();
  }

  // ---------- a47-guard: Claude's instructions (IP-15), housekeeping (IP-16), list items in proposals (IP-17), the manuscript lock (IP-18) ----------

  /** IP-15: the writer's instructions per Claude feature, from `meta`; a feature left out uses its default. */
  claudeInstructions(): Partial<Record<ClaudeFeature, string>> {
    const texts = this.model.get('meta', CLAUDE_INSTRUCTIONS_ID)?.texts;
    const out: Partial<Record<ClaudeFeature, string>> = {};
    if (!texts || typeof texts !== 'object') return out;
    for (const f of CLAUDE_FEATURES) {
      const t = (texts as Record<string, unknown>)[f];
      if (typeof t === 'string' && t.trim()) out[f] = t;
    }
    return out;
  }

  /**
   * IP-15: set one feature's instructions, or reset it to the default with
   * null or blank text. A settings write like the brief settings: the meta
   * document only, no entry revision; undo is a renderer command.
   */
  async setClaudeInstructions(
    feature: ClaudeFeature,
    text: string | null,
  ): Promise<Partial<Record<ClaudeFeature, string>>> {
    if (!CLAUDE_FEATURES.includes(feature)) {
      throw new RepositoryError(`There is no Claude feature called ${String(feature)}.`);
    }
    const clean = (text ?? '').trim();
    if (clean.length > CLAUDE_INSTRUCTIONS_MAX) {
      throw new RepositoryError(
        `Instructions are at most ${CLAUDE_INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`,
      );
    }
    const texts: Partial<Record<ClaudeFeature, string>> = Object.fromEntries(
      Object.entries(this.claudeInstructions()).filter(([f]) => f !== feature),
    );
    if (clean) texts[feature] = clean;
    await this.writeMeta({ _id: CLAUDE_INSTRUCTIONS_ID, texts });
    return this.claudeInstructions();
  }

  /**
   * IP-16: delete one entry in the trash forever, with its revisions and its
   * import record, in one transaction. Not an undo step (the A40 rule): a
   * snapshot is taken first instead (BK-1). Links to it from other entries are
   * left as they are, and the warnings report them as missing.
   */
  async purge(c: EntryCollection, id: string): Promise<PurgeCounts> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    if (!prior.deletedAt) throw new RepositoryError(PURGE_NOT_IN_TRASH);
    await this.bulkGuard('delete forever');
    return this.purgeAll([{ collection: c, id }]);
  }

  /** IP-16: delete every entry in the trash forever, in one transaction. */
  async emptyTrash(): Promise<PurgeCounts> {
    const items = this.trash().map((t) => ({ collection: t.collection, id: t.entry._id }));
    if (!items.length) return { entries: 0, revisions: 0 };
    await this.bulkGuard('empty trash');
    return this.purgeAll(items);
  }

  private async purgeAll(
    items: { collection: EntryCollection; id: string }[],
  ): Promise<PurgeCounts> {
    const counts: PurgeCounts = { entries: 0, revisions: 0 };
    await this.transact(async (session) => {
      // A retried transaction counts again from nothing.
      counts.entries = 0;
      counts.revisions = 0;
      const byCollection = new Map<EntryCollection, string[]>();
      for (const it of items) {
        byCollection.set(it.collection, [...(byCollection.get(it.collection) ?? []), it.id]);
      }
      for (const [collection, ids] of byCollection) {
        const gone = await this.collection(collection).deleteMany(
          { _id: { $in: ids }, deletedAt: { $type: 'string' } } as Document,
          { session },
        );
        if (gone.deletedCount !== ids.length) {
          throw new RepositoryError(
            'An entry left the trash while it was being deleted, so nothing was deleted. Look at the trash again.',
          );
        }
        counts.entries += gone.deletedCount;
        const revs = await this.bible
          .collection<Revision>('revisions')
          .deleteMany({ collection, entryId: { $in: ids } }, { session });
        counts.revisions += revs.deletedCount;
      }
      await this.bible
        .collection<StoredDoc>('importSources')
        .deleteMany({ _id: { $in: items.map((i) => i.id) } }, { session });
      await this.options.midTransaction?.(session);
    });
    for (const it of items) {
      this.model.remove(it.collection, it.id);
      this.model.remove('importSources', it.id);
      this.index.remove(it.collection, it.id);
    }
    for (const it of items) {
      this.emitter.emit('change', {
        bible: this.bible.id,
        collection: it.collection,
        id: it.id,
        op: 'purge',
      } satisfies ChangeEvent);
    }
    return counts;
  }

  /**
   * IP-16: remove revisions written before a date, for one entry or the whole
   * bible. `dryRun` only counts them, for the count shown before confirming.
   * Not an undo step; a snapshot is taken first (BK-1).
   */
  async pruneRevisions(opts: {
    collection?: EntryCollection;
    id?: string;
    before: string;
    dryRun?: boolean;
  }): Promise<{ count: number }> {
    const before = new Date(opts.before);
    if (Number.isNaN(before.getTime())) {
      throw new RepositoryError('Give the date as a day, for example 2026-01-31.');
    }
    if (opts.id && !opts.collection) {
      throw new RepositoryError('Say which section the entry is in.');
    }
    const filter: Document = { at: { $lt: before.toISOString() } };
    if (opts.collection) {
      this.assertCollection(opts.collection);
      filter.collection = opts.collection;
      if (opts.id) {
        if (!this.model.get(opts.collection, opts.id)) {
          throw new RepositoryError(`No ${opts.collection} entry has the ID ${opts.id}.`);
        }
        filter.entryId = opts.id;
      }
    }
    const revisions = this.bible.collection<Revision>('revisions');
    if (opts.dryRun) return { count: await revisions.countDocuments(filter) };
    if (!(await revisions.countDocuments(filter))) return { count: 0 };
    await this.bulkGuard('remove old revisions');
    const res = await revisions.deleteMany(filter);
    return { count: res.deletedCount };
  }

  /**
   * IP-18: a patch that changes the manuscript fields of a chapter is refused
   * unless the importer writes it. A patch that repeats their stored values
   * (a whole entry saved back) is not a change and passes.
   */
  private refuseLocked(
    c: EntryCollection,
    prior: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): void {
    if (lockedTouched(c, prior, patch).length) throw new RepositoryError(MANUSCRIPT_LOCKED);
  }

  /** IP-18: the stored manuscript fields of an entry, kept when an older revision is restored. */
  private lockedValues(c: EntryCollection, prior: StoredDoc): Record<string, unknown> {
    const fields = LOCKED_FIELDS[c] ?? [];
    return Object.fromEntries(fields.filter((k) => k in prior).map((k) => [k, prior[k]]));
  }

  /**
   * What a proposal records beyond its kind when it is made: the new list
   * items its values use (IP-17), and, when it touches the manuscript fields,
   * its rejection with the reason (IP-18).
   */
  private proposalGuard(
    input: { op: Proposal['op']; collection: string; data?: Record<string, unknown> },
    target: StoredDoc | undefined,
  ): Partial<Proposal> {
    const data = input.data ?? {};
    const uses = input.op === 'delete' ? [] : this.usesIn(data);
    const touched =
      input.op === 'update' && target
        ? lockedTouched(input.collection as EntryCollection, target, data)
        : input.op === 'create'
          ? (LOCKED_FIELDS[input.collection as EntryCollection] ?? []).filter((k) =>
              Boolean(data[k]),
            )
          : [];
    if (!touched.length) return { uses };
    return {
      uses,
      state: 'rejected',
      decidedAt: this.now().toISOString(),
      refusal: MANUSCRIPT_LOCKED,
    };
  }

  /**
   * IP-17: every new-item ref in a proposal's values, each tied to the proposal
   * that adds it: the newest one still waiting with that ref, which is the one
   * made in the same run, since a run proposes the item before its entries.
   */
  private usesIn(data: unknown, known: Proposal['uses'] = []): Proposal['uses'] {
    const refs = new Set<string>();
    collectRefs(data, refs);
    return [...refs].map((ref) => {
      const kept = known.find((u) => u.ref === ref);
      if (kept) return kept;
      const adds = this.listProposals()
        .filter((p) => p.op === 'listAdd' && p.listAdd?.ref === ref && p.state !== 'rejected')
        .sort((a, b) => b._id.localeCompare(a._id));
      const add = adds.find((p) => p.state === 'pending') ?? adds[0];
      if (!add) {
        throw new RepositoryError(
          `No proposal adds the list item ${ref}. Propose the new item first, then the entries that use it.`,
        );
      }
      return { ref, proposalId: add._id };
    });
  }

  /** IP-17: a proposal to add one item to a list. Nothing in the bible changes. */
  private async proposeListAdd(input: {
    source: Proposal['source'];
    listAdd?: ListAddInput;
    reason?: string;
  }): Promise<Proposal> {
    if (!input.listAdd) throw new RepositoryError('A list item proposal needs the item.');
    const add = { ...input.listAdd, label: input.listAdd.label.trim() };
    if (!(MINTABLE_LISTS as readonly string[]).includes(add.listId)) {
      throw new RepositoryError(
        `New items can be proposed only for communities, event categories, regions, languages and tags, not ${add.listId}.`,
      );
    }
    const list = this.storedList(add.listId);
    if (!add.label) throw new RepositoryError('A list item needs a name.');
    const same = list.items.find((i) => i.label.toLowerCase() === add.label.toLowerCase());
    if (same) {
      throw new RepositoryError(
        `The ${list.label} list already has ${same.label} (ID ${same.id}). Use it instead of adding it again.`,
      );
    }
    if (add.parentId && !list.items.some((i) => i.id === add.parentId)) {
      throw new RepositoryError('The parent item is not in this list.');
    }
    if (!ListRef.safeParse(add.ref).success) {
      throw new RepositoryError('A new list item ref looks like new:jinan.');
    }
    const proposal = Proposal.parse({
      _id: newId(),
      source: input.source,
      op: 'listAdd',
      collection: 'lists',
      targetId: null,
      data: {},
      reason: input.reason ?? '',
      createdAt: this.now().toISOString(),
      listAdd: {
        listId: add.listId,
        label: add.label,
        parentId: add.parentId ?? null,
        ref: add.ref,
      },
    });
    await this.proposals().insertOne(proposal);
    this.model.put('proposals', proposal as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return proposal;
  }

  /** IP-17: a list item proposal as a field in the diff, for example "Community: + Jinan". */
  private listAddDiff(proposal: Proposal): {
    proposal: Proposal;
    changes: FieldChange[];
    conflict: boolean;
  } {
    const add = proposal.listAdd as ListAddProposal;
    return {
      proposal,
      changes: [{ path: listItemLabel(add.listId), before: null, after: `+ ${add.label}` }],
      conflict: false,
    };
  }

  /** IP-17: a proposal's values as the diff shows them, each new-item ref as "+ Label". */
  private shownRefs(proposal: Proposal, data: Record<string, unknown>): Record<string, unknown> {
    if (!proposal.uses.length) return data;
    const shown = new Map<string, string>();
    for (const u of proposal.uses) {
      const add = this.model.get('proposals', u.proposalId) as unknown as Proposal | undefined;
      if (add?.listAdd) shown.set(u.ref, `+ ${add.listAdd.label}`);
    }
    return replaceRefs(data, shown) as Record<string, unknown>;
  }

  /**
   * IP-17: the new list items an entry proposal needs, made now when their
   * own proposals are still pending (approving the entry approves the item
   * first, in the same transaction), and its values with each ref replaced.
   */
  private mintFor(proposal: Proposal): {
    data: Record<string, unknown>;
    lists: ListDoc[];
    decided: Proposal[];
  } {
    if (!proposal.uses.length) return { data: proposal.data, lists: [], decided: [] };
    const values = new Map<string, string>();
    const lists = new Map<string, ListDoc>();
    const decided: Proposal[] = [];
    for (const u of proposal.uses) {
      const add = this.proposal(u.proposalId);
      const item = add.listAdd as ListAddProposal;
      const list = lists.get(item.listId) ?? this.storedList(item.listId);
      if (add.state === 'rejected') {
        throw new RepositoryError(
          `This proposal uses ${item.label}, a new item for ${list.label} that was rejected. Reject this proposal too, or edit it to use an item the list has.`,
        );
      }
      if (add.state === 'approved') {
        const made = list.items.find((i) => i.id === add.appliedItemId);
        if (!made) {
          throw new RepositoryError(
            `${item.label} is no longer in ${list.label}. Edit this proposal to use an item the list has.`,
          );
        }
        values.set(u.ref, item.listId === 'tags' ? made.label : made.id);
        continue;
      }
      const { made, next, existed } = this.mintItem(list, item);
      if (!existed) lists.set(item.listId, next);
      values.set(u.ref, item.listId === 'tags' ? made.label : made.id);
      decided.push({
        ...add,
        state: 'approved',
        decidedAt: this.now().toISOString(),
        appliedItemId: made.id,
        appliedItemExisted: existed,
      });
    }
    return {
      data: replaceRefs(proposal.data, values) as Record<string, unknown>,
      lists: [...lists.values()],
      decided,
    };
  }

  /** The item a list item proposal makes, or the item of that name the list already has. */
  private mintItem(
    list: ListDoc,
    add: ListAddProposal,
  ): { made: ListItem; next: ListDoc; existed: boolean } {
    // The same rule as when the item was proposed: a label matches whatever its case.
    const existing = list.items.find((i) => i.label.toLowerCase() === add.label.toLowerCase());
    if (existing) return { made: existing, next: list, existed: true };
    if (add.parentId && !list.items.some((i) => i.id === add.parentId)) {
      throw new RepositoryError(
        `The item ${add.label} was to go under is no longer in ${list.label}. Reject this proposal and add the item in Lists.`,
      );
    }
    const made: ListItem = {
      id: newItemId(list, add.label),
      label: add.label,
      parentId: add.parentId,
    };
    return { made, next: { ...list, items: [...list.items, made] }, existed: false };
  }

  /** IP-17: approve a list item proposal: the item is added and the approval recorded together. */
  private async applyListAdd(proposal: Proposal): Promise<Proposal> {
    await this.bulkGuard('approved proposal');
    const add = proposal.listAdd as ListAddProposal;
    const { made, next, existed } = this.mintItem(this.storedList(add.listId), add);
    const decided: Proposal = {
      ...proposal,
      state: 'approved',
      decidedAt: this.now().toISOString(),
      appliedItemId: made.id,
      appliedItemExisted: existed,
    };
    await this.commit([], (session) => this.saveDecided([decided], session), existed ? [] : [next]);
    this.model.put('proposals', decided as unknown as StoredDoc);
    this.emitter.emit('proposals');
    return decided;
  }

  /** Record approvals made inside a transaction; each must still be pending. */
  private async saveDecided(decided: Proposal[], session: ClientSession): Promise<void> {
    for (const p of decided) {
      const res = await this.proposals().replaceOne({ _id: p._id, state: 'pending' }, p, {
        session,
      });
      if (res.matchedCount !== 1) throw new RepositoryError('This proposal was already decided.');
    }
  }
}

const STORY_TIME_ID = 'storyTime';

/** One saved version of the scene outline (PL-5); `breaks` since A37, `years` since A39 (an older `ranges` is ignored). */
interface SceneVersionDoc {
  _id: string;
  at: string;
  until: string;
  text: string;
  breaks?: SceneBreaks;
  years?: SceneYears;
}

/** The scene outline as the repository returns it. */
interface SceneOutlineDoc {
  text: string;
  breaks: SceneBreaks;
  years: SceneYears;
  modifiedAt: string | null;
}
const BRIEF_SETTINGS_ID = 'briefSettings';
const COMMUNITY_NOTES_ID = 'communityNotes';
const SNAPSHOT_SETTINGS_ID = 'snapshotSettings';
const IMPORT_MAPPINGS_ID = 'importMappings';
const TREE_LAYOUT_ID = 'treeLayout';
const DRIVE_ID = 'drive';

// ---------- a47-guard ----------

/** Options for a write; `importer` is set only by the manuscript importer, never from IPC (IP-18). */
export interface WriteOptions {
  importer?: boolean;
}

/** What `propose` takes for a `listAdd` proposal (IP-17). */
export interface ListAddInput {
  listId: string;
  label: string;
  parentId?: string | null;
  ref: string;
}

/** What a purge removed (IP-16). */
export interface PurgeCounts {
  entries: number;
  revisions: number;
}

const CLAUDE_INSTRUCTIONS_ID = 'claudeInstructions';
const CLAUDE_INSTRUCTIONS_MAX = 20_000;

/** IP-18: the plain error for a write to the manuscript fields from anything but the importer. */
export const MANUSCRIPT_LOCKED = 'The manuscript text is imported, not edited here. Use Re-import.';

/** IP-16: Delete forever is only for an entry already in the trash. */
export const PURGE_NOT_IN_TRASH =
  'Only an entry in the trash can be deleted forever. Move it to the trash first.';

/** IP-17: a list item proposal is approved or rejected as it stands. */
export const LIST_ADD_NO_EDIT =
  'A new list item cannot be edited here. Reject it, or approve it and rename the item in Lists.';

/** IP-18: fields only the manuscript importer writes. */
export const LOCKED_FIELDS: Partial<Record<EntryCollection, readonly string[]>> = {
  chapters: ['manuscriptText', 'manuscriptSource', 'sourceFile'],
};

/** A document without its locked fields, so an older revision cannot bring them back (IP-18). */
function withoutLocked(c: EntryCollection, doc: Record<string, unknown>): Record<string, unknown> {
  const fields = LOCKED_FIELDS[c] ?? [];
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !fields.includes(k)));
}

/** The locked fields a patch would change. Absent and empty count as the same. */
export function lockedTouched(
  c: EntryCollection,
  prior: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  const blank = (v: unknown) => (v === undefined || v === null || v === '' ? null : v);
  return (LOCKED_FIELDS[c] ?? []).filter((k) => k in patch && blank(patch[k]) !== blank(prior[k]));
}

const LIST_ITEM_LABELS: Record<string, string> = {
  communities: 'Community',
  eventCategories: 'Event category',
  regions: 'Region',
  languages: 'Language',
  tags: 'Tag',
};

/** A list's item in the singular, as the diff names it. */
export const listItemLabel = (listId: string): string => LIST_ITEM_LABELS[listId] ?? listId;

function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (ListRef.safeParse(value).success) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

function replaceRefs(value: unknown, values: Map<string, string>): unknown {
  if (typeof value === 'string') return values.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceRefs(v, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceRefs(v, values)]));
  }
  return value;
}
