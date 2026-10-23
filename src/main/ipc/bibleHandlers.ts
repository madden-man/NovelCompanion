import { entryTitle, isEntryCollection } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { Channel, WireEntry } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { Handler } from './validate';
import { backupHandlers } from './backupHandlers';
import type { BackupChannel, BackupDeps } from './backupHandlers';
import { sessionHandlers } from './sessionHandlers';
import type { SessionChannel, SessionDeps } from './sessionHandlers';
import { continuityHandlers } from './continuityHandlers';
import type { ContinuityChannel } from './continuityHandlers';
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
import {
  chapterPage,
  moveChapter,
  moveNumbered,
  newChapterPlace,
  outlineGrid,
} from '../../shared/domain/outline';
import { newNestedId } from '../../shared/domain/blank';
import { descriptionFor, entriesFor, placePath } from '../../shared/domain/culture';
import { NO_CHECKER_NOTE, systemFor, termProblem } from '../../shared/domain/romanization';
import { compileFilters } from '../../shared/domain/searchFilters';
import { entrySnippet } from '../search';
import type { ListDoc } from '../../shared/schema';
// a47-guard
import { guardHandlers } from './guardHandlers';
import type { GuardChannel } from './guardHandlers';

/** Channels that act on the open bible. */
export type BibleChannel =
  | 'entry.list'
  | 'entry.get'
  | 'entry.create'
  | 'entry.createMany'
  | 'entry.update'
  | 'entry.delete'
  | 'entry.restore'
  | 'entry.lookup'
  | 'trash.list'
  | 'lists.get'
  | 'lists.rename'
  | 'lists.addItem'
  | 'lists.removeItem'
  | 'search.query'
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
  | 'sceneOutline.get'
  | 'sceneOutline.set'
  | 'sceneOutline.versions'
  | 'sceneOutline.version'
  | 'sceneOutline.restore'
  | 'chapter.page'
  | 'plot.reorder'
  | 'outline.newChapter'
  | 'culture.entriesFor'
  | 'place.describe'
  | 'romanization.get'
  | 'romanization.set'
  | 'romanization.check'
  | 'community.notes.get'
  | 'community.notes.set'
  | BackupChannel
  | SessionChannel
  | ContinuityChannel
  // a47-guard
  | GuardChannel
  // a47-model
  | 'lists.move'
  | 'lists.setParent'
  | 'lists.setItem'
  | 'settings.get'
  | 'settings.set'
  | 'eraDefaults.get'
  | 'eraDefaults.set';

/** Channels that exist only outside a packaged app. */
export type TestChannel = 'test.propose' | 'test.seed';

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
export function bibleHandlers(
  current: () => OpenBible | null,
  deps: BackupDeps & SessionDeps = {},
): BibleHandlers {
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
        return {
          id: l.id,
          label: l.label,
          systemId: sys?.id ?? null,
          kind: sys?.kind ?? null,
          note: sys && !sys.kind ? NO_CHECKER_NOTE : null,
        };
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
    ...backupHandlers(current, deps),
    ...sessionHandlers(current, deps),
    ...continuityHandlers(current),
    // a47-guard
    ...guardHandlers(current, deps),
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
      return withWarnings(collection, entry);
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
    'sceneOutline.get': () => session().repo.sceneOutline(),
    'sceneOutline.set': ({ text, breaks, years }) =>
      session().repo.setSceneOutline(text, { breaks, years }),
    'sceneOutline.versions': async () => ({
      versions: await session().repo.sceneOutlineVersions(),
    }),
    'sceneOutline.version': ({ id }) => session().repo.sceneOutlineVersion(id),
    'sceneOutline.restore': ({ id }) => session().repo.restoreSceneOutline(id),
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
      const { numbers: n } = session().repo.bibleSettings(); // a47-model: IP-11
      return { ...chart, coverage: eraCoverage(eraSpans(model), n.timelineStart, n.timelineEnd) };
    },
    'timeline.eraCoverage': () => {
      const { numbers: n } = session().repo.bibleSettings(); // a47-model: IP-11
      const coverage = eraCoverage(eraSpans(session().model), n.timelineStart, n.timelineEnd);
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
      if (req.kind === 'chapters') {
        const moved = model.get('chapters', req.movedId);
        if (!moved || moved.deletedAt) throw new Error('That chapter does not exist.');
        const part = model.get('parts', req.groupId);
        if (!part || part.deletedAt) throw new Error('That part does not exist.');
        const patches = moveChapter(
          model.all('chapters'),
          model.all('parts'),
          req.movedId,
          req.groupId,
          req.toIndex,
        );
        const before = new Map(model.all('chapters').map((c) => [c._id, c]));
        await repo.reorder(
          'chapters',
          patches.map((p) => ({
            id: p.id,
            patch: { readingOrder: p.readingOrder, partId: p.partId },
          })),
        );
        return {
          collection: 'chapters' as const,
          changes: patches.map((p) => {
            const c = before.get(p.id);
            return {
              id: p.id,
              before: {
                readingOrder: Number(c?.readingOrder ?? 0),
                partId: String(c?.partId ?? ''),
              },
              after: { readingOrder: p.readingOrder, partId: p.partId },
            };
          }),
        };
      }
      if (req.kind === 'parts') {
        const collection = 'parts' as const;
        const moved = model.get(collection, req.movedId);
        if (!moved || moved.deletedAt) throw new Error('That part does not exist.');
        const siblings = model.all('parts');
        const patches = moveNumbered(siblings, req.movedId, req.toIndex);
        const before = new Map(siblings.map((d) => [d._id, d]));
        await repo.writeBatch(
          patches.map((p) => ({
            op: 'update' as const,
            collection,
            id: p.id,
            patch: { number: p.number },
          })),
        );
        return {
          collection,
          changes: patches.map((p) => ({
            id: p.id,
            before: { number: Number(before.get(p.id)?.number ?? 0) },
            after: { number: p.number },
          })),
        };
      }
      throw new Error('That cannot be reordered.');
    },
    'outline.newChapter': async ({ partId, title, year, afterId }) => {
      const { model, repo } = session();
      const part = model.get('parts', partId);
      if (!part || part.deletedAt) throw new Error('That part does not exist.');
      const place = newChapterPlace(model.all('chapters'), model.all('parts'), partId, afterId);
      const before = new Map(model.all('chapters').map((c) => [c._id, c]));
      const written = await repo.writeBatch([
        {
          op: 'create',
          collection: 'chapters',
          data: {
            title: title.trim(),
            partId,
            readingOrder: place.readingOrder,
            strands: [
              {
                id: newNestedId(),
                label: repo.bibleSettings().templates.strandPresent,
                startYear: year,
                endYear: null,
                primary: true,
                povCharacterId: null,
                characterIds: [],
                placeIds: [],
              },
            ],
          },
        },
        ...place.shifts.map((p) => ({
          op: 'update' as const,
          collection: 'chapters' as const,
          id: p.id,
          patch: { readingOrder: p.readingOrder },
        })),
      ]);
      return {
        entry: wire(written[0] as StoredDoc),
        changes: place.shifts.map((p) => ({
          id: p.id,
          before: { readingOrder: Number(before.get(p.id)?.readingOrder ?? 0) },
          after: { readingOrder: p.readingOrder },
        })),
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
    'community.notes.get': () => ({ notes: session().repo.communityNotes() }),
    'community.notes.set': async ({ communityId, text }) => ({
      notes: await session().repo.setCommunityNote(communityId, text),
    }),
    'romanization.get': () => romanization(),
    'romanization.set': async ({ languageId, systemId }) => {
      await session().repo.setRomanization(languageId, systemId);
      return romanization();
    },
    'romanization.check': ({ languageId, text }) => {
      const { model, repo } = session();
      const systems = model.get('lists', 'romanizationSystems') as ListDoc | undefined;
      const system = systemFor(languageId, repo.romanizationSettings(), systems);
      // A system with no checker never reports "follows the system": it says it cannot check.
      if (system && !system.kind) return { ok: true, message: NO_CHECKER_NOTE };
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
    'lists.get': () => ({ lists: session().repo.lists() }),
    'lists.rename': ({ listId, itemId, label }) =>
      session().repo.renameListItem(listId, itemId, label),
    'lists.addItem': async ({ listId, label, parentId, id, color, extra }) => ({
      item: await session().repo.addListItem(listId, label, parentId, id, { color, extra }),
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
          snippet: entrySnippet(doc),
        };
      });
      return { hits, total: matched.length };
    },
    // a47-model
    'lists.move': ({ listId, itemId, index }) => session().repo.moveListItem(listId, itemId, index),
    'lists.setParent': ({ listId, itemId, parentId }) =>
      session().repo.setListItemParent(listId, itemId, parentId),
    'lists.setItem': async ({ listId, itemId, color, extra }) => ({
      item: await session().repo.setListItemLook(listId, itemId, { color, extra }),
    }),
    'settings.get': () => session().repo.bibleSettings(),
    'settings.set': (patch) => session().repo.setBibleSettings(patch),
    'eraDefaults.get': () => ({ rows: session().repo.eraDefaults() }),
    'eraDefaults.set': async ({ rows }) => ({ rows: await session().repo.setEraDefaults(rows) }),
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
    'test.seed': async ({ items }) => {
      const s = current();
      if (!s) throw new Error(NO_BIBLE);
      const created = await s.repo.createMany(items, { importer: true });
      return {
        entries: created.map((entry, i) => ({
          entry: entry as unknown as WireEntry,
          warnings: s.repo.warnings(
            (items[i] as { collection: EntryCollection }).collection,
            entry,
          ),
        })),
      };
    },
  };
}

export const BIBLE_CHANNELS = Object.keys(bibleHandlers(() => null)) as (BibleChannel & Channel)[];
