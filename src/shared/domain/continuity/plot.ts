/**
 * What the alignment check gives Claude for one chapter (CC-3, A20), built
 * deterministically from the read model: the chapter's numbered lines, the
 * entries the M7 selection picks for the chapter (SB-2), and the plot as
 * stored: the chapter's strands and years, and the chapter order. The
 * characters' moments up to the story year come with the selected entries
 * (SM-3); beats, arcs, and facts in play went with A39.
 */
import { lifeState } from '../ages';
import { selectForSession } from '../brief/selection';
import type { SelectionSettings } from '../brief/selection';
import { briefMaterial } from '../brief/render';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { chapterYear } from '../position';
import { characterName } from '../timeline';
import type { TimelineData } from '../timeline';
import type { StoryDate } from '../../schema/common';
import { entryTitle } from '../../schema';
import { chaptersInOrder } from './structural';
import { numberedLines } from './lines';
import type { NumberedLine } from './lines';

export interface AlignmentMaterial {
  chapterId: string;
  heading: string;
  storyYear: number | null;
  lines: NumberedLine[];
  /** The stored plot, one fact per line, every entry with its ID in square brackets. */
  plot: string;
  /** The selected entries, one per line. */
  entries: string;
  /** Every entry given, for the run record (AI-2). */
  given: { collection: string; id: string; title: string }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc | undefined): d is Doc => !!d && !d.deletedAt;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
const one = (s: string) => s.replace(/\s+/g, ' ').trim();

function byId(data: TimelineData, c: string): Map<string, Doc> {
  return new Map(
    data
      .all(c)
      .filter(live)
      .map((d) => [str(d._id), d]),
  );
}

function person(chars: Map<string, Doc>, id: string, year: number | null): string {
  const c = chars.get(id);
  const name = characterName(c, id);
  if (!c || year === null) return `${name} [${id}]`;
  const s = lifeState(
    {
      birth: isPlainObject(c.birth) ? (c.birth as StoryDate) : null,
      death: isPlainObject(c.death) ? (c.death as StoryDate) : null,
    },
    year,
  );
  const state =
    s.state === 'alive'
      ? `age ${s.age}${s.dyingThisYear ? ', dies this year' : ''}`
      : s.state === 'dead'
        ? `dead since ${s.deathYear}`
        : s.state === 'unborn'
          ? `not born until ${s.birthYear}`
          : 'age unknown';
  return `${name} [${id}] (${state})`;
}

/** CC-3: the material for one chapter. Throws a plain error when the chapter is missing. */
export function alignmentMaterial(
  data: TimelineData,
  chapterId: string,
  settings?: SelectionSettings,
): AlignmentMaterial {
  const chapter = byId(data, 'chapters').get(chapterId);
  if (!chapter) throw new Error('That chapter is not in the bible.');
  const chars = byId(data, 'characters');
  const places = byId(data, 'places');
  const year = chapterYear(chapter);
  const title = entryTitle(chapter);
  const order = num(chapter.readingOrder);
  const heading = `Chapter ${order ?? '?'}: ${title} [${chapterId}]`;
  const given = new Map<string, { collection: string; id: string; title: string }>();
  const give = (collection: string, d: Doc) =>
    given.set(`${collection}:${str(d._id)}`, { collection, id: str(d._id), title: entryTitle(d) });
  give('chapters', chapter);

  const plot: string[] = [];
  plot.push(`${heading}. Story year ${year ?? 'not set'}.`);
  const strands = (Array.isArray(chapter.strands) ? chapter.strands : []).filter(isPlainObject);
  for (const s of strands) {
    const y = num(s.startYear);
    const end = num(s.endYear);
    const pov = str(s.povCharacterId);
    plot.push(
      `Strand [${str(s.id)}] "${str(s.label)}"${s.primary === true ? ' (primary)' : ''}: story year ${y ?? '?'}${end !== null && end !== y ? ` to ${end}` : ''}; point of view ${pov ? person(chars, pov, y) : 'none'}; characters present: ${
        ids(s.characterIds)
          .map((id) => person(chars, id, y))
          .join(', ') || 'none'
      }; places: ${
        ids(s.placeIds)
          .map((id) => `${entryTitle(places.get(id))} [${id}]`)
          .join(', ') || 'none'
      }.`,
    );
  }

  plot.push('Chapter order (reading order, story year):');
  for (const c of chaptersInOrder(data)) {
    plot.push(
      `${num(c.readingOrder) ?? '?'}. ${entryTitle(c)} [${str(c._id)}], ${chapterYear(c) ?? 'no year'}${str(c._id) === chapterId ? ' (this chapter)' : ''}`,
    );
  }

  const sel = selectForSession(data, { kind: 'chapter', chapterId }, settings);
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const m of briefMaterial(sel)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    given.set(`${m.collection}:${m.id}`, { collection: m.collection, id: m.id, title: m.title });
    const parts = [m.note, m.detail].map(one).filter(Boolean);
    entries.push(`[${m.id}] ${m.title} (${m.collection}): ${parts.join('. ')}`);
  }

  return {
    chapterId,
    heading,
    storyYear: year,
    lines: numberedLines(chapter.manuscriptText),
    plot: plot.join('\n'),
    entries: entries.join('\n'),
    given: [...given.values()],
  };
}
