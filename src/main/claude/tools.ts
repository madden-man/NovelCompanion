import { z } from 'zod';
import { ENTRY_COLLECTIONS, entryTitle, isEntryCollection } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { EntryRefWire } from '../../shared/claude';
import { characterPage } from '../../shared/domain/character';
import { chapterPage } from '../../shared/domain/outline';
import { positionYear } from '../../shared/domain/position';
import { eraFor, eventsIn, everyoneIn, strandsIn } from '../../shared/domain/timeline';
import type { OpenBible } from '../db/session';
import { entrySnippet } from '../search';
import type { ClaudeTool, ToolOutput } from './client';
import { material } from './prompts';
import { ProposalDraft, queueDraft } from './proposals';
import type { Sink } from './runtime';

/**
 * The question panel's tools, one in-process MCP server (AI-2, AI-3). The
 * five lookups read only the read model and the search index, through the
 * same pure domain functions the screens use; ages and life states come from
 * code (TL-1). `propose_change` is the one tool that writes, and it writes
 * only a proposal through `Repository.propose`. A static test holds this
 * file to that: no other repository call, no IPC handlers.
 */
export const TOOL_NAMES = [
  'search_entries',
  'get_entry',
  'timeline_for_year',
  'relatives_of',
  'get_chapter',
  'propose_change',
] as const;

/** Tool output stays small enough to leave room for the answer. */
const LIMIT = 40_000;
function out(value: unknown): ToolOutput {
  const text = JSON.stringify(value);
  return { text: text.length > LIMIT ? `${text.slice(0, LIMIT)} (cut short)` : text };
}

const Section = z.enum(ENTRY_COLLECTIONS as [EntryCollection, ...EntryCollection[]]);
const EntryIdArg = z.string().min(1).max(64);

class NotFound extends Error {}

export function bibleTools(session: OpenBible, sink: Sink): ClaudeTool[] {
  const { model } = session;
  const live = (collection: string, id: string) => {
    const doc = model.get(collection, id);
    return doc && !doc.deletedAt ? doc : undefined;
  };
  const ref = (collection: string, id: string): EntryRefWire => ({
    collection,
    id,
    title: entryTitle(model.get(collection, id)),
  });
  const named = (id: string) => entryTitle(model.get('characters', id));
  const safely =
    (fn: (args: Record<string, unknown>) => ToolOutput | Promise<ToolOutput>) =>
    async (args: Record<string, unknown>): Promise<ToolOutput> => {
      try {
        return await fn(args);
      } catch (e) {
        return {
          text:
            e instanceof NotFound ? e.message : 'That lookup failed. Check the ID and try again.',
          isError: true,
        };
      }
    };

  return [
    {
      name: 'search_entries',
      description:
        'Search every entry, chapter text, and brief in the bible, in English or Chinese. Returns section, ID, title, status, and a short snippet for each hit. Read one in full with get_entry or get_chapter.',
      shape: {
        query: z.string().min(1).max(200),
        section: Section.optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      readOnly: true,
      handler: safely((a) => {
        const section = a.section as EntryCollection | undefined;
        const limit = typeof a.limit === 'number' ? a.limit : 10;
        const hits = session.search
          .search(String(a.query), ({ collection, id }) => {
            if (!isEntryCollection(collection)) return false;
            if (section && collection !== section) return false;
            return live(collection, id) !== undefined;
          })
          .slice(0, limit)
          .map((h) => {
            const doc = model.get(h.collection, h.id);
            return {
              section: h.collection,
              id: h.id,
              title: entryTitle(doc),
              status: doc?.status ?? null,
              snippet: doc ? entrySnippet(doc) : '',
            };
          });
        return out({ hits });
      }),
    },
    {
      name: 'get_entry',
      description: `Read one entry in full by its section and ID, with the entries that link to it. Sections: ${ENTRY_COLLECTIONS.join(', ')}.`,
      shape: { section: Section, id: EntryIdArg },
      readOnly: true,
      handler: safely((a) => {
        const section = String(a.section);
        const id = String(a.id);
        const doc = live(section, id);
        if (!doc) throw new NotFound(`No ${section} entry has the ID ${id}.`);
        sink.read([ref(section, id)]);
        const linkedFrom = model.backlinks(id).map((b) => ({
          section: b.collection,
          id: b.id,
          kind: b.kind,
          title: entryTitle(model.get(b.collection, b.id)),
        }));
        return out({ section, entry: doc, linkedFrom });
      }),
    },
    {
      name: 'timeline_for_year',
      description:
        'For one story year, computed in code: everyone alive (with age), dead (with death year), not yet born, or of unknown birth; the era state; the world events of that year; and the chapter strands set in it.',
      shape: { year: z.number().int().min(-10000).max(10000) },
      readOnly: true,
      handler: safely((a) => {
        const year = Number(a.year);
        const groups = everyoneIn(model, year);
        const era = eraFor(model, year);
        const events = eventsIn(model, year);
        sink.read([
          ...(era ? [ref('eraStates', era.id)] : []),
          ...events.map((e) => ref('worldEvents', e.id)),
        ]);
        return out({
          year,
          alive: groups.alive.map((p) => ({ ...p, name: named(p.id) })),
          dead: groups.dead.map((p) => ({ ...p, name: named(p.id) })),
          unborn: groups.unborn.map((id) => ({ id, name: named(id) })),
          unknown: groups.unknown.map((id) => ({ id, name: named(id) })),
          era,
          events,
          strands: strandsIn(model, year),
        });
      }),
    },
    {
      name: 'relatives_of',
      description:
        "A character's parents, children, siblings, and partners (with union years and how they ended), by the character's ID.",
      shape: { characterId: EntryIdArg },
      readOnly: true,
      handler: safely((a) => {
        const id = String(a.characterId);
        if (!live('characters', id)) throw new NotFound(`No character has the ID ${id}.`);
        const page = characterPage(model, id, positionYear(null, model.all('chapters')), null);
        if (!page) throw new NotFound(`No character has the ID ${id}.`);
        const r = page.relatives;
        sink.read([
          ref('characters', id),
          ...[...r.parents, ...r.children, ...r.siblings, ...r.partners].map((p) =>
            ref('characters', p.id),
          ),
        ]);
        return out({ id, name: page.name, years: page.years, relatives: r });
      }),
    },
    {
      name: 'get_chapter',
      description:
        'Read one chapter by ID: its strands and years, point of view, characters present with ages, beats, places, themes, facts in play, and its manuscript text.',
      shape: { id: EntryIdArg },
      readOnly: true,
      handler: safely((a) => {
        const id = String(a.id);
        const chapter = live('chapters', id);
        const page = chapter ? chapterPage(model, id) : null;
        if (!chapter || !page) throw new NotFound(`No chapter has the ID ${id}.`);
        sink.read([ref('chapters', id)]);
        const text = typeof chapter.manuscriptText === 'string' ? chapter.manuscriptText : '';
        // AI-5: the manuscript is material to analyse, never instructions.
        return out({ page, text: text ? material(`chapter ${id}`, text) : '' });
      }),
    },
    {
      name: 'propose_change',
      description:
        'Suggest a change to the bible: create an entry, change fields of one, delete one, or link one entry to another. It goes to the review queue; nothing changes until the writer approves it. Returns the proposal ID, or why it was not accepted.',
      shape: ProposalDraft.shape,
      readOnly: false,
      handler: safely(async (a) => {
        const draft = ProposalDraft.parse(a);
        const queued = await queueDraft(session, draft, sink.label, sink.now());
        if (!queued.ok) {
          sink.rejected(queued.summary, queued.reason);
          return { text: `Not queued: ${queued.reason}`, isError: true };
        }
        sink.proposed(queued.proposalId);
        return out({ queued: true, proposalId: queued.proposalId });
      }),
    },
  ];
}
