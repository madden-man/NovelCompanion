import { entryTitle } from '../../shared/schema';
import type { NotebookPage } from '../../shared/schema';
import type { Response } from '../../shared/ipc';
import { firstLine, notebookCaption } from '../../shared/domain/notebook';
import type { SearchFilters } from '../../shared/domain/searchFilters';
import { placeAndDescendants } from '../../shared/domain/searchFilters';
import { plainText } from '../../shared/domain/markdown';
import type { ReadModel } from '../readmodel';

type PageWire = Response<'notebook.get'>['page'];
type Link = PageWire['links'][number];

/** NB-8: a page as the screen shows it, every name read from the bible as it is now. */
export function notebookPageView(page: NotebookPage, model: ReadModel): PageWire {
  const name = (collection: string, id: string): string | null => {
    const doc = model.get(collection, id);
    return doc ? entryTitle(doc) : null;
  };
  const links: Link[] = [];
  const add = (collection: Link['collection'], ids: readonly string[]) => {
    for (const id of ids) {
      const title = name(collection, id);
      if (title !== null && !model.get(collection, id)?.deletedAt) {
        links.push({ collection, id, title });
      }
    }
  };
  add('characters', page.characterIds);
  add('places', page.placeIds);
  add('chapters', page.chapterIds);
  if (page.questionId) {
    const q = model.get('openQuestions', page.questionId);
    if (q && !q.deletedAt) {
      links.push({
        collection: 'openQuestions',
        id: page.questionId,
        title: plainText(q.question).trim() || entryTitle(q),
      });
    }
  }
  return {
    id: page._id,
    kind: page.kind,
    reading: page.reading,
    title: page.title,
    firstLine: firstLine(page),
    caption: notebookCaption(page),
    date: page.date,
    ...(page.year !== undefined ? { year: page.year } : {}),
    inTrash: Boolean(page.deletedAt),
    lines: page.lines.map((l) => ({
      id: l.id,
      voice: l.voice,
      speakerId: l.speakerId,
      paper: l.paper,
      speaker: l.speakerId ? (name('characters', l.speakerId) ?? null) : null,
      text: l.text,
      wise: l.wise,
      kept: l.kept,
    })),
    research: page.research,
    links,
    years: page.years,
  };
}

/**
 * SR-2 on a notebook page: a section filter that names entry sections leaves
 * it out; a family filter keeps it when it names a character of the family; a
 * place filter when it names the place or a place inside it; a year range
 * when one of its years falls in the range.
 */
export function notebookAccepts(
  filters: SearchFilters,
  model: ReadModel,
): (page: NotebookPage) => boolean {
  const sections = filters.sections?.length ? filters.sections : null;
  const places = filters.placeId
    ? placeAndDescendants(
        model.all('places').filter((p) => !p.deletedAt),
        filters.placeId,
      )
    : null;
  const familyId = filters.familyId || null;
  const from = filters.yearFrom ?? null;
  const to = filters.yearTo ?? null;
  return (page) => {
    if (sections) return false;
    if (places && !page.placeIds.some((id) => places.has(id))) return false;
    if (familyId) {
      const inFamily = page.characterIds.some((id) => {
        const c = model.get('characters', id);
        return Array.isArray(c?.familyIds) && (c.familyIds as unknown[]).includes(familyId);
      });
      if (!inFamily) return false;
    }
    if (from !== null || to !== null) {
      const lo = from ?? -Infinity;
      const hi = to ?? Infinity;
      if (!page.years.some((y) => y >= lo && y <= hi)) return false;
    }
    return true;
  };
}
