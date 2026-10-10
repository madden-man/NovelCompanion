import { entryTitle, isEntryCollection } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { Channel, WireEntry } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { Handler } from './validate';
import { ancestorsOf, buildGraph, descendantsOf, treeWarnings } from '../../shared/domain/tree';
import { characterPage } from '../../shared/domain/character';
import { positionYear } from '../../shared/domain/position';
import { shiftStrand } from '../../shared/domain/strands';
import { itemPath } from '../../shared/domain/lists';
import {
  characterName,
  compare,
  coverageMessages,
  eraCoverage,
  eraFor,
  eraSpans,
  erasFor,
  eventsIn,
  everyoneIn,
  filterChart,
  livedThrough,
  strandsIn,
  timelineChart,
  yearForAge,
} from '../../shared/domain/timeline';
import { chapterPage, outlineGrid, reorder } from '../../shared/domain/outline';
import { descriptionFor, entriesFor, placePath } from '../../shared/domain/culture';
import { systemFor, termProblem } from '../../shared/domain/romanization';
import { factPage, knownBy, whoKnows } from '../../shared/domain/knowledge';
import { latestLog } from '../../shared/domain/sessionLog';
import { compileFilters } from '../../shared/domain/searchFilters';
import { entrySnippet } from '../search';
import type { ListDoc } from '../../shared/schema';

/** Channels that act on the open bible. */
export type BibleChannel =
  | 'entry.list'
  | 'entry.get'
  | 'entry.create'
  | 'entry.createMany'
  | 'entry.update'
  | 'entry.delete'
  | 'entry.restore'
  | 'entry.linkedFrom'
  | 'entry.backlinks'
  | 'entry.lookup'
  | 'trash.list'
  | 'revisions.list'
  | 'revisions.diff'
  | 'revisions.restore'
  | 'lists.get'
  | 'lists.rename'
  | 'lists.addItem'
  | 'lists.removeItem'
  | 'search.query'
  | 'fact.page'
  | 'knowledge.whoKnows'
  | 'knowledge.knownBy'
  | 'sessionLog.latest'
  | 'proposal.list'
  | 'proposal.diff'
  | 'proposal.approve'
  | 'proposal.edit'
  | 'proposal.reject'
  | 'proposal.refresh'
  | 'tree.get'
  | 'tree.lineage'
  | 'tree.savePositions'
  | 'character.page'
  | 'storyTime.get'
  | 'storyTime.set'
  | 'storyTime.anchorAge'
  | 'storyTime.promotePreview'
  | 'storyTime.promote'
  | 'timeline.year'
  | 'timeline.livedThrough'
  | 'timeline.compare'
  | 'timeline.chart'
  | 'timeline.eraCoverage'
  | 'outline.get'
  | 'chapter.page'
  | 'plot.reorder'
  | 'culture.entriesFor'
  | 'place.describe'
  | 'romanization.get'
  | 'romanization.set'
  | 'romanization.check';

/** Channels that exist only outside a packaged app. */
export type TestChannel = 'test.propose';

export type BibleHandlers = { [C in BibleChannel]: Handler<C> };

export const NO_BIBLE = 'Open a bible first.';

const isFullMoment = (m: {
  month?: number;
  day?: number;
}): m is {
  year: number;
  month: number;
  day: number;
} => m.month !== undefined && m.day !== undefined;

/**
 * Handlers for every bible channel, independent of Electron so the
 * integration suite can drive the same IPC layer (zod on both sides through
 * `runHandler`) that the renderer uses.
 */
export function bibleHandlers(current: () => OpenBible | null): BibleHandlers {
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };
  // Stored entries carry modifiedAt; the response schema checks it on the way out.
  const wire = (d: StoredDoc) => d as unknown as WireEntry;
  const withWarnings = (c: EntryCollection, entry: StoredDoc) => ({
    entry: wire(entry),
    warnings: session().repo.warnings(c, entry),
  });
  const titled = (links: { collection: string; id: string; kind: string }[]) =>
    links
      .filter((b): b is typeof b & { collection: EntryCollection } =>
        isEntryCollection(b.collection),
      )
      .map((b) => ({
        ...b,
        title: entryTitle(session().model.get(b.collection, b.id)),
      }));

  const graph = () => {
    const { model } = session();
    return buildGraph(model.all('characters'), model.all('unions'), model.all('parentLinks'));
  };
  const position = () => {
    const { model, repo } = session();
    return positionYear(repo.storyTime(), model.all('chapters'));
  };

  const romanization = () => {
    const { model, repo } = session();
    const settings = repo.romanizationSettings();
    const systems = model.get('lists', 'romanizationSystems') as ListDoc | undefined;
    const languages = model.get('lists', 'languages') as ListDoc | undefined;
    return {
      languages: (languages?.items ?? []).map((l) => {
        const sys = systemFor(l.id, settings, systems);
        return { id: l.id, label: l.label, systemId: sys?.id ?? null, kind: sys?.kind ?? null };
      }),
      systems: (systems?.items ?? []).map((i) => ({ id: i.id, label: i.label })),
    };
  };

  const proposalView = (id: string) => {
    const { repo, model } = session();
    const d = repo.proposalDiff(id);
    const target = d.proposal.targetId
      ? model.get(d.proposal.collection, d.proposal.targetId)
      : undefined;
    return { ...d, targetTitle: target ? entryTitle(target) : null };
  };

  return {
    'proposal.list': ({ state }) => ({
      proposals: session()
        .repo.listProposals(state)
        .map((p) => proposalView(p._id)),
    }),
    'proposal.diff': ({ id }) => proposalView(id),
    'proposal.approve': async ({ id }) => ({ proposal: await session().repo.applyProposal(id) }),
    'proposal.edit': async ({ id, data }) => ({
      proposal: await session().repo.editProposal(id, data),
    }),
    'proposal.reject': async ({ id }) => ({ proposal: await session().repo.rejectProposal(id) }),
    'proposal.refresh': async ({ id }) => {
      await session().repo.refreshProposal(id);
      return proposalView(id);
    },
    'entry.list': ({ collection, trash }) => {
      const { repo } = session();
      const entries = repo.list(collection, {
        includeDeleted: trash === 'include',
        onlyDeleted: trash === 'only',
      }) as StoredDoc[];
      return { entries: entries.map((e) => withWarnings(collection, e)) };
    },
    'entry.get': ({ collection, id }) => {
      const { repo } = session();
      const entry = repo.get(collection, id, { includeDeleted: true }) as StoredDoc | undefined;
      if (!entry) throw new Error(`No ${collection} entry has the ID ${id}.`);
      return { ...withWarnings(collection, entry), backlinks: titled(repo.backlinks(id)) };
    },
    'entry.create': async ({ collection, data }) => {
      const entry = (await session().repo.create(collection, data as never)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.createMany': async ({ items }) => {
      const created = await session().repo.createMany(items);
      return {
        entries: created.map((entry, i) =>
          withWarnings((items[i] as { collection: EntryCollection }).collection, entry),
        ),
      };
    },
    'tree.get': () => {
      const g = graph();
      return {
        people: g.people,
        unions: g.unions,
        links: g.links,
        warnings: treeWarnings(g),
        positions: session().repo.treePositions(),
      };
    },
    'tree.savePositions': async ({ positions }) => {
      await session().repo.setTreePositions(positions);
      return { ok: true as const };
    },
    'tree.lineage': ({ id }) => {
      const g = graph();
      if (!g.byId.has(id)) throw new Error(`No character has the ID ${id}.`);
      const order = (ids: Set<string>) =>
        [...ids].sort((a, b) => (g.rank.get(a) ?? 0) - (g.rank.get(b) ?? 0));
      return { ancestors: order(ancestorsOf(g, id)), descendants: order(descendantsOf(g, id)) };
    },
    'character.page': ({ id }) => {
      const { model, repo } = session();
      // The current position is the last written chapter, whatever the story time (CH-3).
      const current = positionYear(null, model.all('chapters'));
      const page = characterPage(model, id, current, repo.storyTime());
      if (!page) throw new Error(`No character has the ID ${id}.`);
      return { page };
    },
    'storyTime.get': () => ({ time: session().repo.storyTime(), position: position() }),
    'storyTime.set': async ({ time }) => {
      const saved = await session().repo.setStoryTime(time);
      return { time: saved, position: position() };
    },
    'storyTime.anchorAge': ({ characterId, age }) => {
      const c = session().model.get('characters', characterId);
      if (!c || c.deletedAt) throw new Error(`No character has the ID ${characterId}.`);
      const year = yearForAge(c, age);
      const name = characterName(c, characterId);
      return year === null
        ? { year, message: `${name} has no known birth year, so no year can be computed.` }
        : { year, message: `${name} is ${age} in ${year}.` };
    },
    'storyTime.promotePreview': ({ chapterId, strandId }) => {
      const { model, repo } = session();
      const time = repo.storyTime();
      if (!time) throw new Error('Set a story time first.');
      const ch = model.get('chapters', chapterId);
      if (!ch || ch.deletedAt) throw new Error(`No chapter has the ID ${chapterId}.`);
      const shifted = shiftStrand(ch.strands as object[], strandId, time.year);
      if (!shifted) throw new Error('That strand is not in this chapter.');
      return {
        chapterId,
        chapterTitle: entryTitle(ch),
        strandId,
        strandLabel: shifted.strand.label,
        year: time.year,
        from: shifted.from,
        to: shifted.to,
        baseModifiedAt: String(ch.modifiedAt),
        unchanged: shifted.unchanged,
      };
    },
    'storyTime.promote': async ({ chapterId, strandId, baseModifiedAt }) => {
      const { repo } = session();
      const time = repo.storyTime();
      if (!time) throw new Error('Set a story time first.');
      const entry = await repo.setStrandYear(chapterId, strandId, time.year, baseModifiedAt);
      return withWarnings('chapters', entry);
    },
    'timeline.year': ({ at }) => {
      const { model, repo } = session();
      const moment = at ?? storyMoment();
      const year = moment.year;
      const groups = everyoneIn(model, isFullMoment(moment) ? moment : year);
      return {
        ...groups,
        at: moment,
        era: eraFor(model, year),
        eras: erasFor(model, year),
        events: eventsIn(model, year),
        strands: strandsIn(model, year),
      };
      function storyMoment() {
        const t = repo.storyTime();
        if (t) {
          return {
            year: t.year,
            ...(t.month !== undefined ? { month: t.month } : {}),
            ...(t.month !== undefined && t.day !== undefined ? { day: t.day } : {}),
          };
        }
        return { year: position().year ?? new Date().getFullYear() };
      }
    },
    'timeline.livedThrough': ({ characterId, year }) => {
      const { model } = session();
      const lived = livedThrough(model, characterId, year);
      if (!lived) throw new Error(`No character has the ID ${characterId}.`);
      const cats = model.get('lists', 'eventCategories') as ListDoc | undefined;
      return {
        ...lived,
        events: lived.events.map((e) => ({
          ...e,
          categoryPath: cats ? itemPath(cats, e.categoryId) || e.categoryId : e.categoryId,
        })),
      };
    },
    'timeline.compare': ({ a, b, from, to, step }) => {
      const { model } = session();
      for (const id of [a, b]) {
        if (!model.get('characters', id)) throw new Error(`No character has the ID ${id}.`);
      }
      return { rows: compare(model, a, b, from, to, step) };
    },
    'timeline.chart': ({ filters }) => {
      const { model } = session();
      const chart = filterChart(timelineChart(model), filters, {
        places: model.all('places'),
        categories: model.get('lists', 'eventCategories') as ListDoc | undefined,
      });
      return { ...chart, coverage: eraCoverage(eraSpans(model)) };
    },
    'timeline.eraCoverage': () => {
      const coverage = eraCoverage(eraSpans(session().model));
      return { coverage, messages: coverageMessages(coverage) };
    },
    'outline.get': ({ order, cursorYear }) => {
      const { model, repo } = session();
      // The cursor follows the story time; the caller may pass another year.
      const cursor = cursorYear ?? repo.storyTime()?.year ?? null;
      return outlineGrid(model, { order, cursorYear: cursor });
    },
    'chapter.page': ({ id }) => {
      const page = chapterPage(session().model, id);
      if (!page) throw new Error(`No chapter has the ID ${id}.`);
      return { page };
    },
    'plot.reorder': async (req) => {
      const { model, repo } = session();
      const field = req.kind === 'chapters' ? ('readingOrder' as const) : ('order' as const);
      const group = (
        req.kind === 'chapters'
          ? model.all('chapters').filter((c) => c.partId === req.groupId)
          : model
              .all('plotBeats')
              .filter((b) => Array.isArray(b.arcIds) && b.arcIds.includes(req.groupId))
      )
        .filter((d) => !d.deletedAt)
        .sort(
          (a, b) =>
            Number(a[field] ?? 0) - Number(b[field] ?? 0) ||
            String(a.title).localeCompare(String(b.title)),
        );
      if (!group.some((d) => d._id === req.movedId)) {
        throw new Error('That item is not in this group.');
      }
      const moves = reorder(
        group.map((d) => ({ id: d._id, value: Number(d[field] ?? 0) })),
        req.movedId,
        req.toIndex,
        req.kind === 'chapters' ? 'reuse' : 'sequence',
      );
      const before = new Map(group.map((d) => [d._id, Number(d[field] ?? 0)]));
      await repo.reorder(req.kind === 'chapters' ? 'chapters' : 'plotBeats', moves);
      return {
        field,
        changes: moves.map((m) => ({ id: m.id, before: before.get(m.id) ?? 0, after: m.value })),
      };
    },
    'culture.entriesFor': ({ communityId, year }) => ({
      entries: entriesFor(session().model.all('culturalEntries'), communityId, year).map(wire),
    }),
    'place.describe': ({ id, year }) => {
      const { model } = session();
      const place = model.get('places', id);
      if (!place || place.deletedAt) throw new Error(`No place has the ID ${id}.`);
      const places = model.all('places');
      return {
        id,
        path: placePath(places, id),
        description: descriptionFor(place as { descriptions?: never }, year),
        children: places
          .filter((p) => !p.deletedAt && p.parentId === id)
          .map((p) => ({ id: p._id, title: entryTitle(p) }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    },
    'romanization.get': () => romanization(),
    'romanization.set': async ({ languageId, systemId }) => {
      await session().repo.setRomanization(languageId, systemId);
      return romanization();
    },
    'romanization.check': ({ languageId, text }) => {
      const { model, repo } = session();
      const systems = model.get('lists', 'romanizationSystems') as ListDoc | undefined;
      const problem = termProblem(
        { language: languageId, romanization: text },
        repo.romanizationSettings(),
        systems,
      );
      return problem
        ? { ok: false, message: problem }
        : { ok: true, message: 'Follows the system.' };
    },
    'entry.update': async ({ collection, id, patch }) => {
      const entry = (await session().repo.update(collection, id, patch as never)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.delete': async ({ collection, id }) => {
      const entry = (await session().repo.softDelete(collection, id)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.restore': async ({ collection, id }) => {
      const entry = (await session().repo.restore(collection, id)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'entry.linkedFrom': ({ id }) => {
      const { count, entries } = session().repo.linkedFrom(id);
      return { count, entries: titled(entries) };
    },
    'entry.backlinks': ({ id }) => ({ backlinks: titled(session().repo.backlinks(id)) }),
    'entry.lookup': ({ ids }) => {
      const { model } = session();
      const entries = [];
      for (const id of new Set(ids)) {
        const found = model.find(id);
        if (found && isEntryCollection(found.collection)) {
          entries.push({
            id,
            collection: found.collection,
            title: entryTitle(found.doc),
            inTrash: Boolean(found.doc.deletedAt),
          });
        }
      }
      return { entries };
    },
    'trash.list': () => ({
      entries: session()
        .repo.trash()
        .map((t) => ({ collection: t.collection, entry: wire(t.entry) })),
    }),
    'revisions.list': async ({ collection, id }) => {
      const history = await session().repo.history(collection, id);
      return { revisions: history.map(({ snapshot: _s, ...r }) => r) };
    },
    'revisions.diff': async ({ collection, id, revisionId }) => {
      const d = await session().repo.revisionDiff(collection, id, revisionId);
      return {
        revision: { ...d.revision, snapshot: wire(d.revision.snapshot) },
        current: wire(d.current),
        changes: d.changes,
      };
    },
    'revisions.restore': async ({ collection, id, revisionId }) => {
      const entry = (await session().repo.restoreRevision(collection, id, revisionId)) as StoredDoc;
      return withWarnings(collection, entry);
    },
    'lists.get': () => ({ lists: session().repo.lists() }),
    'lists.rename': ({ listId, itemId, label }) =>
      session().repo.renameListItem(listId, itemId, label),
    'lists.addItem': async ({ listId, label, parentId }) => ({
      item: await session().repo.addListItem(listId, label, parentId),
    }),
    'lists.removeItem': async ({ listId, itemId }) => {
      await session().repo.removeListItem(listId, itemId);
      return { ok: true as const };
    },
    'search.query': ({ query, collections, filters, limit }) => {
      const { search, model } = session();
      // `collections` (the link picker) and `filters.sections` both narrow the sections.
      const asked = [collections, filters?.sections].filter(
        (l): l is EntryCollection[] => !!l?.length,
      );
      const sections = asked.length
        ? (asked[0] as EntryCollection[]).filter((c) => asked.every((l) => l.includes(c)))
        : undefined;
      if (sections && sections.length === 0) return { hits: [], total: 0 };
      const accepts = compileFilters(
        { ...filters, sections: sections ?? [] },
        {
          get: (c, id) => model.get(c, id),
          places: model.all('places').filter((p) => !p.deletedAt),
          customSpecs: (id) => model.customSpecs(id),
        },
      );
      const matched = search
        .search(query, ({ collection, id }) => {
          if (!isEntryCollection(collection)) return false;
          const doc = model.get(collection, id);
          return doc !== undefined && !doc.deletedAt && accepts(collection, doc);
        })
        .filter((h): h is typeof h & { collection: EntryCollection } =>
          isEntryCollection(h.collection),
        );
      const hits = matched.slice(0, limit).map((h) => {
        const doc = model.get(h.collection, h.id) as StoredDoc;
        return {
          ...h,
          title: entryTitle(doc),
          status: typeof doc.status === 'string' ? doc.status : null,
          provenance: typeof doc.provenance === 'string' ? doc.provenance : null,
          snippet: entrySnippet(doc),
        };
      });
      return { hits, total: matched.length };
    },
    'fact.page': ({ id }) => {
      const page = factPage(session().model, id);
      if (!page) throw new Error(`No fact has the ID ${id}.`);
      return { page };
    },
    'knowledge.whoKnows': ({ factId, year }) => ({
      knowers: whoKnows(session().model, factId, year),
    }),
    'knowledge.knownBy': ({ characterId, year }) => ({
      facts: knownBy(session().model, characterId, year),
    }),
    'sessionLog.latest': () => {
      const { model } = session();
      const log = latestLog(model.all('sessionLogs'));
      if (!log) return { log: null };
      const chapterId = typeof log.chapterId === 'string' && log.chapterId ? log.chapterId : null;
      const chapter = chapterId ? model.get('chapters', chapterId) : undefined;
      return {
        log: {
          id: String(log._id),
          date: String(log.date ?? ''),
          chapterId,
          chapter: chapter && !chapter.deletedAt ? entryTitle(chapter) : null,
          stoppedAt: String(log.stoppedAt ?? ''),
          notes: String(log.notes ?? ''),
        },
      };
    },
  };
}

/** Test-only handlers: never registered in a packaged app. */
export function testHandlers(current: () => OpenBible | null): { [C in TestChannel]: Handler<C> } {
  return {
    'test.propose': async (req) => {
      const s = current();
      if (!s) throw new Error(NO_BIBLE);
      return { proposal: await s.repo.propose(req) };
    },
  };
}

export const BIBLE_CHANNELS = Object.keys(bibleHandlers(() => null)) as (BibleChannel & Channel)[];
