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
  choiceListId,
  parseChoiceListId,
  entrySchemas,
  entryTitle,
  isEntryCollection,
  manifests,
} from '../../shared/schema';
import type {
  AnyListId,
  CustomSection,
  DerivedListId,
  EntryCollection,
  EntryInput,
  EntryOf,
  ListItem,
} from '../../shared/schema';
import { hasValue } from '../../shared/domain/customValues';
import { contentOf, diffEntries } from '../../shared/domain/diff';
import type { FieldChange } from '../../shared/domain/diff';
import { StoryTimeValue } from '../../shared/storyTime';
import {
  countListUsage,
  derivedRename,
  newItemId,
  renameCascade,
  tagsUsed,
} from '../../shared/domain/lists';
import type { CollectionDocs } from '../../shared/domain/lists';
import { computeWarnings } from '../../shared/domain/warnings';
import { ownAncestorMessage, wouldBeOwnAncestor } from '../../shared/domain/tree';
import type { FieldWarning } from '../../shared/domain/warnings';
import type { Backlink, ReadModel, StoredDoc } from '../readmodel';
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
  ) {}

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
      );
    }
    const data = result.data as EntryOf<C>;
    if (shape) this.checkShape(c, data as unknown as StoredDoc);
    return data;
  }

  /** Shape rules that need other data: custom values must fit their section (CS-1). */
  private checkShape(c: EntryCollection, doc: StoredDoc, ancestry = true): void {
    const fail = (message: string) => {
      throw new ValidationError(message, [
        { code: 'custom', message, path: [], input: doc } as z.core.$ZodIssue,
      ]);
    };
    if (c === 'customEntries') {
      const section = this.model.get('customSections', String(doc.sectionId));
      if (!section) return fail(`There is no custom section with the ID ${String(doc.sectionId)}.`);
      // Values that no longer fit the section are warnings (ED-10), not refusals.
    }
    if (c === 'customSections') {
      const ids = (doc.fields as { id: string }[]).map((f) => f.id);
      if (new Set(ids).size !== ids.length) fail('Two fields in this section share an ID.');
    }
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
      for (const label of tagsUsed(manifests[ch.collection], ch.next, this.customSpecs)) {
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
      for (const ch of changes) {
        if (ch.prior === null) {
          await this.collection(ch.collection).insertOne(ch.next, { session });
        } else {
          const res = await this.collection(ch.collection).replaceOne(
            { _id: ch.prior._id, modifiedAt: ch.prior.modifiedAt } as Document,
            ch.next,
            { session },
          );
          if (res.matchedCount !== 1) {
            throw new RepositoryError(
              'This entry changed somewhere else. Reload it and try again.',
            );
          }
        }
        const revision: Revision = {
          _id: newId(),
          collection: ch.collection,
          entryId: ch.next._id,
          op: ch.op,
          at: ch.next.modifiedAt as string,
          prior: ch.prior,
          ...(ch.note ? { note: ch.note } : {}),
          ...(ch.proposalId ? { proposalId: ch.proposalId } : {}),
        };
        await this.bible.collection<Revision>('revisions').insertOne(revision, { session });
      }
      for (const list of listUpdates) {
        await this.bible
          .collection<ListDoc>('lists')
          .replaceOne({ _id: list._id }, list, { session, upsert: true });
      }
      await extra?.(session);
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

  private buildCreate<C extends EntryCollection>(c: C, input: Record<string, unknown>): Change {
    return this.buildCreateWith(c, input, true);
  }

  /** A create whose shape checks run later, against the whole batch. */
  private buildCreateUnchecked(c: EntryCollection, input: Record<string, unknown>): Change {
    return this.buildCreateWith(c, input, false);
  }

  private buildCreateWith(
    c: EntryCollection,
    input: Record<string, unknown>,
    shape: boolean,
  ): Change {
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
  ): Change {
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

  async create<C extends EntryCollection>(c: C, input: CreateInput<C>): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const change = this.buildCreate(c, input as Record<string, unknown>);
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

  async update<C extends EntryCollection>(c: C, id: string, patch: Patch<C>): Promise<EntryOf<C>> {
    this.assertCollection(c);
    const prior = await this.current(c, id);
    const change = this.buildUpdate(c, prior, patch as Record<string, unknown>);
    if (c === 'customSections') this.guardSectionChange(prior, change.next);
    await this.commit([change]);
    return change.next as EntryOf<C>;
  }

  /** Custom entries of a section, trash included, so a restore never meets a lost value. */
  private sectionEntries(sectionId: string): StoredDoc[] {
    return this.model.all('customEntries').filter((e) => e.sectionId === sectionId);
  }

  /**
   * A section edit may not drop a field or a choice that entries still use
   * (ED-8): it says how many use it, as list items in use do. Rename a choice
   * on the Lists screen instead, which updates the entries too.
   */
  private guardSectionChange(prior: StoredDoc, next: StoredDoc): void {
    type F = { id: string; label: string; type: string; options: string[] };
    const before = prior.fields as F[];
    const after = next.fields as F[];
    const entries = this.sectionEntries(prior._id);
    const values = (e: StoredDoc) => (e.values ?? {}) as Record<string, unknown>;
    const count = (n: number) => (n === 1 ? '1 entry uses' : `${n} entries use`);
    for (const field of before) {
      const now = after.find((f) => f.id === field.id);
      if (!now) {
        const n = entries.filter((e) => hasValue(values(e)[field.id])).length;
        if (n > 0) {
          throw new RepositoryError(
            `${count(n)} the field ${field.label}. Clear it on those entries first, or keep the field.`,
          );
        }
        continue;
      }
      if (field.type !== 'singleChoice' || now.type !== 'singleChoice') continue;
      for (const option of field.options.filter((o) => !now.options.includes(o))) {
        const n = entries.filter((e) => values(e)[field.id] === option).length;
        if (n > 0) {
          throw new RepositoryError(
            `${count(n)} the choice ${option} in ${field.label}. Rename it on the Lists screen, or change those entries first.`,
          );
        }
      }
    }
  }

  /** A section's single-choice field, for the choice lists. */
  private choiceField(listId: string) {
    const parsed = parseChoiceListId(listId);
    if (!parsed) return null;
    const section = this.model.get('customSections', parsed.sectionId);
    const fields = (section?.fields ?? []) as {
      id: string;
      label: string;
      type: string;
      options: string[];
    }[];
    const field = fields.find((f) => f.id === parsed.fieldId && f.type === 'singleChoice');
    if (!section || !field) throw new RepositoryError('That choice field no longer exists.');
    return { section, field, fields };
  }

  private async writeChoices(
    section: StoredDoc,
    fieldId: string,
    options: string[],
    entryPatches: { id: string; values: Record<string, unknown> }[] = [],
    note?: string,
  ): Promise<number> {
    const prior = await this.current('customSections', section._id);
    const fields = (prior.fields as { id: string; options: string[] }[]).map((f) =>
      f.id === fieldId ? { ...f, options } : f,
    );
    const changes: Change[] = [
      { ...this.buildUpdate('customSections', prior, { fields }), ...(note ? { note } : {}) },
    ];
    for (const p of entryPatches) {
      const e = await this.current('customEntries', p.id);
      changes.push({
        ...this.buildUpdate('customEntries', e, { values: p.values }),
        ...(note ? { note } : {}),
      });
    }
    await this.commit(changes);
    this.emitter.emit('lists');
    return entryPatches.length;
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

  private readonly customSpecs = (sectionId: string) => this.model.customSpecs(sectionId);

  /** Field warnings for an entry (ED-10). They never block a write. */
  warnings(c: EntryCollection, doc: StoredDoc): FieldWarning[] {
    return computeWarnings(c, manifests[c], doc, {
      get: (col, id) => this.model.get(col, id),
      find: (id) => this.model.find(id),
      list: (id) => this.model.get('lists', id) as ListDoc | undefined,
      customSpecs: this.customSpecs,
      customSection: (id) => this.model.get('customSections', id) as CustomSection | undefined,
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
      ...contentOf(revision.snapshot),
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
    if (listId === 'sectionNames') {
      return live('customSections').map((d) => ({
        id: d._id,
        label: String(d.name),
        parentId: null,
        usage: live('customEntries').filter((e) => e.sectionId === d._id).length,
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
          usage: countListUsage(id, item, all, this.customSpecs),
        })),
      };
    });
    const labels: Record<DerivedListId, string> = {
      families: 'Families',
      sectionNames: 'Section names',
      eraRanges: 'Era names and ranges',
    };
    const derived: ListView[] = DERIVED_LIST_IDS.map((id) => ({
      _id: id,
      label: labels[id],
      derived: true,
      fixedItems: true,
      items: this.derivedItems(id),
    }));
    const choices: ListView[] = [];
    for (const section of this.model.all('customSections').filter((d) => !d.deletedAt)) {
      const entries = this.sectionEntries(section._id).filter((e) => !e.deletedAt);
      for (const f of section.fields as {
        id: string;
        label: string;
        type: string;
        options: string[];
      }[]) {
        if (f.type !== 'singleChoice') continue;
        choices.push({
          _id: choiceListId(section._id, f.id),
          label: `${String(section.name)}: ${f.label}`,
          derived: true,
          fixedItems: false,
          items: f.options.map((o) => ({
            id: o,
            label: o,
            parentId: null,
            usage: entries.filter((e) => (e.values as Record<string, unknown>)?.[f.id] === o)
              .length,
          })),
        });
      }
    }
    return [...stored, ...derived, ...choices];
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
    const choice = this.choiceField(listId);
    if (choice) {
      const { section, field } = choice;
      if (!field.options.includes(itemId)) {
        throw new RepositoryError(`${field.label} has no choice called ${itemId}.`);
      }
      if (itemId === to) return { updated: 0, from: itemId };
      if (field.options.includes(to)) {
        throw new RepositoryError(`${field.label} already has a choice called ${to}.`);
      }
      // Every entry holding the old choice gets the new one, in the same transaction.
      const patches = this.sectionEntries(section._id)
        .filter((e) => (e.values as Record<string, unknown>)?.[field.id] === itemId)
        .map((e) => ({ id: e._id, values: { ...(e.values as object), [field.id]: to } }));
      const updated = await this.writeChoices(
        section,
        field.id,
        field.options.map((o) => (o === itemId ? to : o)),
        patches,
        `Renamed ${itemId} to ${to} in ${field.label}`,
      );
      return { updated, from: itemId };
    }
    if (isDerived(listId)) {
      const collection =
        listId === 'families'
          ? 'families'
          : listId === 'sectionNames'
            ? 'customSections'
            : 'eraStates';
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
    const patches = renameCascade(listId, from, to, this.allDocs(), this.customSpecs);
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
  ): Promise<ListItem> {
    const choice = this.choiceField(listId);
    if (choice) {
      const name = label.trim();
      if (!name) throw new RepositoryError('A choice needs a name.');
      if (choice.field.options.includes(name)) {
        throw new RepositoryError(`${choice.field.label} already has a choice called ${name}.`);
      }
      await this.writeChoices(choice.section, choice.field.id, [...choice.field.options, name]);
      return { id: name, label: name, parentId: null };
    }
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
    const item: ListItem = { id: newItemId(list, name), label: name, parentId };
    await this.commit([], undefined, [{ ...list, items: [...list.items, item] }]);
    return item;
  }

  /** Remove an unused item. An item in use is kept, and the message says how many use it. */
  async removeListItem(listId: string, itemId: string): Promise<void> {
    const choice = this.choiceField(listId);
    if (choice) {
      const { section, field } = choice;
      const n = this.sectionEntries(section._id).filter(
        (e) => (e.values as Record<string, unknown>)?.[field.id] === itemId,
      ).length;
      if (n > 0) {
        throw new RepositoryError(
          `${n === 1 ? '1 entry uses' : `${n} entries use`} ${itemId}. Change them first, or rename the choice instead.`,
        );
      }
      await this.writeChoices(
        section,
        field.id,
        field.options.filter((o) => o !== itemId),
      );
      return;
    }
    if (isDerived(listId) || FIXED_ITEM_LISTS.includes(listId)) {
      throw new RepositoryError('Items in this list come from the entries themselves.');
    }
    const list = this.storedList(listId);
    const item = list.items.find((i) => i.id === itemId);
    if (!item) throw new RepositoryError(`The ${list.label} list has no item ${itemId}.`);
    const usage = countListUsage(listId, item, this.allDocs(), this.customSpecs);
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
  }): Promise<Proposal> {
    this.assertCollection(input.collection);
    const target = input.targetId ? this.model.get(input.collection, input.targetId) : undefined;
    if (input.op !== 'create' && !target) {
      throw new RepositoryError(`No ${input.collection} entry has the ID ${input.targetId}.`);
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
    const c = proposal.collection as EntryCollection;
    const current = proposal.targetId ? (this.model.get(c, proposal.targetId) ?? null) : null;
    const after =
      proposal.op === 'delete' ? null : { ...(current ?? {}), ...this.stripSystem(proposal.data) };
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
    const c = proposal.collection as EntryCollection;
    const clean = this.stripSystem(data);
    if (proposal.op === 'update') {
      this.buildUpdate(c, await this.current(c, String(proposal.targetId)), clean);
    } else {
      this.validate(c, {
        ...clean,
        _id: 'CHECK',
        createdAt: this.now().toISOString(),
        modifiedAt: this.now().toISOString(),
      });
    }
    return this.saveProposal({ ...proposal, data: clean, edited: true });
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
    const c = proposal.collection as EntryCollection;
    this.assertCollection(c);
    const data = proposal.data;
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
    await this.commit([change], async (session) => {
      const res = await this.proposals().replaceOne({ _id: id, state: 'pending' }, decided, {
        session,
      });
      if (res.matchedCount !== 1) throw new RepositoryError('This proposal was already decided.');
    });
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

  // ---------- story time (TM-3, stored in meta, never an entry) ----------

  /** The current story time, or null when none is set. */
  storyTime(): StoryTimeValue | null {
    const doc = this.model.get('meta', STORY_TIME_ID);
    if (!doc || typeof doc.year !== 'number') return null;
    return StoryTimeValue.parse({
      year: doc.year,
      ...(typeof doc.month === 'number' ? { month: doc.month } : {}),
      ...(typeof doc.day === 'number' ? { day: doc.day } : {}),
    });
  }

  /** Set or clear the story time. It writes only the meta document, never an entry (TM-5). */
  async setStoryTime(value: StoryTimeValue | null): Promise<StoryTimeValue | null> {
    const meta = this.bible.collection<StoredDoc>('meta');
    if (value === null) {
      await meta.deleteOne({ _id: STORY_TIME_ID });
      this.model.remove('meta', STORY_TIME_ID);
    } else {
      const doc: StoredDoc = { _id: STORY_TIME_ID, ...StoryTimeValue.parse(value) };
      await meta.replaceOne({ _id: STORY_TIME_ID }, doc, { upsert: true });
      this.model.put('meta', doc);
    }
    this.emitter.emit('storyTime');
    return this.storyTime();
  }

  /** Stored tree positions keyed by character ID (FT-10), or null when none are stored. */
  treePositions(): Record<string, { x: number; y: number; loose?: boolean }> | null {
    const doc = this.model.get('meta', TREE_LAYOUT_ID);
    const p = doc?.positions;
    return p && typeof p === 'object'
      ? (p as Record<string, { x: number; y: number; loose?: boolean }>)
      : null;
  }

  /** Save the tree positions. Layout is not an entry: no revision, no undo step. */
  async setTreePositions(
    positions: Record<string, { x: number; y: number; loose?: boolean }>,
  ): Promise<void> {
    const doc: StoredDoc = { _id: TREE_LAYOUT_ID, positions };
    await this.bible.collection<StoredDoc>('meta').replaceOne({ _id: TREE_LAYOUT_ID }, doc, {
      upsert: true,
    });
    this.model.put('meta', doc);
  }

  onStoryTimeChange(listener: () => void): () => void {
    this.emitter.on('storyTime', listener);
    return () => this.emitter.off('storyTime', listener);
  }
}

const STORY_TIME_ID = 'storyTime';
const TREE_LAYOUT_ID = 'treeLayout';
