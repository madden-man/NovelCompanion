/**
 * Capture routing (A48, CR-5, CR-6): what a fact would write, per section,
 * in the shape of main's `ProposalDraft`; the required fields it could not
 * fill; the chips the box must ask for; and the judgment flags that keep it
 * off Route A. The source note is not set here: the box and main add it.
 */
import { LIVES_IN_PREFIX } from '../../schema/moment';
import { LEXICON } from './lexicon';
import type { Lexicon } from './lexicon';
import { DECADE_PART_SOURCE, YEAR_SOURCE } from './parse';
import type { ParsedSentence } from './parse';
import { WRITING_STRAND } from './resolve';
import type { CommunityChoice, Match, Resolved } from './resolve';
import { lexiconPattern } from './score';
import { foldAlias, hasHan } from './text';
import type { CaptureDraft, CaptureSection, RouterIndex } from './types';

/** Required fields per section, and which of them a chip can ask for. */
export const REQUIRED: Record<CaptureSection, readonly string[]> = {
  culturalEntries: ['communityId', 'startYear'],
  moments: ['characterId', 'year'],
  worldEvents: ['start', 'categoryId'],
  places: ['title'],
  glossaryTerms: ['characters'],
  openQuestions: [],
  characters: ['names.full'],
};
/** A missing field the writer can fill with a chip; anything else (a category) is a judgment. */
export const ASKABLE: ReadonlySet<string> = new Set([
  'communityId',
  'characterId',
  'title',
  'characters',
  'names.full',
]);

const Y = YEAR_SOURCE;
const YEAR_PHRASE = new RegExp(
  `\\s*,?\\s*(?<![\\p{L}\\p{N}])(?:(?:starting|beginning)\\s+)?(?:(?:around|from|by|in|after|since|until|through|before|during|up\\s+to)\\s+)?(?:the\\s+)?${DECADE_PART_SOURCE}${Y}s?(?:\\s*(?:to|-|–|until|through)\\s*${Y}s?)?(?!\\p{N}),?`,
  'giu',
);
const END_PUNCT = /[.!]+$/;
const SPACES = /\s+/g;

/** A title from a sentence: the year phrase removed, capitalised, cut at 90 characters. */
export function titleFrom(sentence: string): string {
  const plain = sentence.trim().replace(END_PUNCT, '');
  let t = plain
    .replace(YEAR_PHRASE, ' ')
    .replace(SPACES, ' ')
    .replace(/\s+([?,])/g, '$1')
    .trim();
  t = t.replace(/^,\s*/, '');
  if (t.length < 8) t = plain;
  if (t.length > 90) {
    const cut = t.slice(0, 89);
    const space = cut.lastIndexOf(' ');
    t = `${(space > 60 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const slug = (s: string) =>
  foldAlias(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'item';

/** Everything `draftsFor` needs about one fact once its section is known. */
export interface DraftContext {
  section: CaptureSection;
  sentence: string;
  parsed: ParsedSentence;
  resolved: Resolved;
  years: { start: number; end: number | null };
  communities: CommunityChoice[];
  /** The community the drafts use: the hint, else the first candidate that is not the writing strand. */
  communityId: string | null;
  demographic: string;
  /** A character the writer picked (a hint), replacing the resolved ones. */
  characterId: string | null;
  /** A category the writer picked (a hint). */
  categoryId: string | null;
  index: RouterIndex;
}

export interface DraftResult {
  drafts: CaptureDraft[];
  missing: string[];
  asks: string[];
  reasons: string[];
}

/** The first community candidate that is not only the writing strand's guess. */
export function firstCommunity(communities: CommunityChoice[]): string | null {
  return communities.find((c) => c.why !== WRITING_STRAND)?.id ?? null;
}

/**
 * The characters a moment is about: those named before the first life verb
 * ("Dawn and Mark argue about ... LiNa" is about Dawn and Mark); when none
 * come before it, every character named.
 */
export function momentSubjects(r: Resolved, lexicon: Lexicon = LEXICON): Match[] {
  const verb = lexiconPattern('life', lexicon).exec(r.text.lower)?.index;
  if (verb === undefined) return r.characters;
  const before = r.characters.filter((c) => c.start < verb);
  return before.length ? before : r.characters;
}

/**
 * The single category the cues point to: categories that are ancestors of
 * another matched one are dropped, and one must remain.
 */
export function singleCategory(r: Resolved, index: RouterIndex): string | null {
  const parent = new Map(index.categories.map((c) => [c.id, c.parentId]));
  const ids = r.categories.flatMap((c) => (c.id ? [c.id] : []));
  const isAncestor = (a: string, of: string) => {
    for (let p = parent.get(of); p; p = parent.get(p)) if (p === a) return true;
    return false;
  };
  const leaves = ids.filter((a) => !ids.some((b) => b !== a && isAncestor(a, b)));
  return leaves.length === 1 ? (leaves[0] ?? null) : null;
}

/**
 * World event regions (IP-8): the `regions` item named like the place or
 * its nearest larger place; a top-level place with no item gets a new one
 * (IP-17, a `listAdd` draft whose ref the event uses).
 */
function regionsFor(r: Resolved, index: RouterIndex): { values: string[]; adds: CaptureDraft[] } {
  const byLabel = new Map((index.regions ?? []).map((g) => [foldAlias(g.label), g.id]));
  const places = new Map(index.places.map((p) => [p.id, p]));
  const values: string[] = [];
  const adds: CaptureDraft[] = [];
  for (const m of r.places) {
    if (!m.id) continue;
    let place = places.get(m.id);
    let found: string | undefined;
    for (let hops = 0; place && hops < 10 && !found; hops++) {
      found = byLabel.get(foldAlias(place.name));
      if (!found) place = place.parentId ? places.get(place.parentId) : undefined;
    }
    const top = places.get(m.id);
    if (!found && top && !top.parentId) {
      const ref = `new:${slug(top.name)}`;
      if (!adds.some((a) => a.ref === ref)) {
        adds.push({ op: 'listAdd', listId: 'regions', label: top.name, parentId: null, ref });
      }
      found = ref;
    }
    if (found && !values.includes(found)) values.push(found);
  }
  return { values, adds };
}

const CLAUSE = /,\s*(?:and|but|while|so)\s+|;\s*/;
const AND = /\sand\s+/gu;
const LEADING_SPACE = /^\s+/;
const AND_NEXT = /^and\s+/;

/**
 * A second clause that names a person or place the first does not: after
 * ", and", "but", "while", "so" or ";", or after " and " when a life verb
 * comes before it and a known name right after it ("Mark moves to Seattle
 * and Dawn moves to Jinan", but not "Dawn and Mark argue").
 */
export function secondClause(r: Resolved, lexicon: Lexicon = LEXICON): string | null {
  const lower = r.text.lower;
  const named = [...r.characters, ...r.places, ...r.unknown];
  const verb = lexiconPattern('life', lexicon).exec(lower)?.index;
  const splits: number[] = [];
  const comma = CLAUSE.exec(lower)?.index;
  if (comma !== undefined) splits.push(comma);
  if (verb !== undefined) {
    for (const m of lower.matchAll(AND)) {
      const next = m.index + m[0].length;
      if (m.index > verb && [...r.characters, ...r.places].some((n) => n.start === next)) {
        splits.push(m.index);
      }
    }
  }
  for (const at of splits) {
    const before = new Set(named.filter((m) => m.start < at).map((m) => m.id ?? m.label));
    const after = named.find((m) => m.start > at && !before.has(m.id ?? m.label));
    if (after) return after.label;
  }
  return null;
}

/**
 * A capitalised first word the bible lacks, counted as an unknown name when a
 * life verb follows it or "and" plus a known name does ("Rosa meets Mark",
 * "Rosa and Mark argue"). "Teenagers in Jinan treat ..." is not one.
 */
export function leadingUnknown(r: Resolved, lexicon: Lexicon = LEXICON): Match | null {
  const lead = r.leading;
  const end = lead?.spans[0]?.[1];
  if (!lead || end === undefined) return null;
  const gap = LEADING_SPACE.exec(r.text.lower.slice(end))?.[0].length ?? 0;
  const at = end + gap;
  const rest = r.text.lower.slice(at);
  if (lexiconPattern('life', lexicon).exec(rest)?.index === 0) return lead;
  const and = AND_NEXT.exec(rest);
  if (and && [...r.characters, ...r.places].some((n) => n.start === at + and[0].length)) {
    return lead;
  }
  return null;
}

/** CR-5, CR-6: the drafts, missing fields, asks and judgment flags of one fact. */
export function draftsFor(ctx: DraftContext, lexicon: Lexicon = LEXICON): DraftResult {
  const { section, sentence, resolved: r, years, index } = ctx;
  const drafts: CaptureDraft[] = [];
  const missing: string[] = [];
  const asks: string[] = [];
  const reasons: string[] = [];
  const need = (field: string, ask?: string) => {
    missing.push(field);
    if (ask) asks.push(ask);
  };
  const text = sentence.trim();
  // A44, ED-2: long text is Markdown, so the body is the sentence as typed.
  const body = text;
  const title = titleFrom(text);
  const lower = r.text.lower;
  const unknown = r.unknown[0];

  switch (section) {
    case 'culturalEntries': {
      if (!ctx.communityId) need('communityId', 'Community');
      drafts.push({
        op: 'create',
        collection: 'culturalEntries',
        data: {
          title,
          ...(ctx.communityId ? { communityId: ctx.communityId } : {}),
          demographic: ctx.demographic,
          startYear: years.start,
          endYear: years.end ?? index.timelineEnd,
          body,
        },
      });
      break;
    }
    case 'moments': {
      const subjects = ctx.characterId
        ? [{ id: ctx.characterId }]
        : momentSubjects(r, lexicon).flatMap((c) => (c.id ? [{ id: c.id }] : []));
      if (!subjects.length) need('characterId', 'Character');
      // The place a move goes to follows the move verb; else the first place named.
      const move = lexiconPattern('move', lexicon).exec(lower);
      const place = move
        ? (r.places.find((p) => p.start >= move.index + move[0].length) ?? r.places[0])
        : undefined;
      const lives = !!place;
      const momentTitle = lives ? `${LIVES_IN_PREFIX}${place.label}` : title;
      // A51 (SM-3): a place lived is a move, when the bible's kinds still hold Moves.
      const kind = lives && index.momentKinds?.includes('move') ? 'move' : null;
      for (const c of subjects.length ? subjects : [null]) {
        drafts.push({
          op: 'create',
          collection: 'moments',
          data: {
            ...(c ? { characterId: c.id } : {}),
            year: years.start,
            endYear: years.end,
            title: momentTitle,
            body,
            ...(kind ? { kind } : {}),
          },
        });
      }
      if (subjects.length > 1) {
        reasons.push(`a moment for each of ${subjects.length} characters`);
      }
      // A second person the moment would leave out ("Dawn Li marries Mark Sullivan").
      if (!ctx.characterId) {
        for (const c of r.characters) {
          if (!subjects.some((s) => s.id === c.id)) reasons.push(`${c.label} is named too`);
        }
      }
      const lead = leadingUnknown(r, lexicon);
      if (lead) reasons.push(`unknown name "${lead.label}"`);
      const quoted = r.quoted[0];
      if (quoted && lexiconPattern('nickname', lexicon).test(lower)) {
        drafts.push({
          op: 'create',
          collection: 'glossaryTerms',
          data: {
            title: quoted,
            characters: quoted,
            language: 'english',
            usageNote: text,
          },
        });
        reasons.push(`"${quoted}" may also be a glossary term`);
      }
      if (!lives && lexiconPattern('role', lexicon).test(lower)) {
        reasons.push('might be a role on the character rather than a moment');
      }
      break;
    }
    case 'worldEvents': {
      const categoryId = ctx.categoryId ?? singleCategory(r, index);
      if (!categoryId) {
        need('categoryId');
        reasons.push(
          r.categories.length > 1
            ? `category to choose: ${r.categories.map((c) => c.label).join(' or ')}`
            : 'category to choose from the event categories',
        );
      }
      const regions = regionsFor(r, index);
      drafts.push(...regions.adds);
      drafts.push({
        op: 'create',
        collection: 'worldEvents',
        data: {
          title,
          start: { year: years.start },
          end: years.end === null ? null : { year: years.end },
          ...(categoryId ? { categoryId } : {}),
          regions: regions.values,
          body,
        },
      });
      break;
    }
    case 'places': {
      const fresh = r.unknown.find((u) => u.placeTail) ?? unknown;
      const name = fresh?.label ?? r.places[0]?.label ?? null;
      if (!name) need('title', 'Place name');
      const parent = r.places.find((p) => p.label !== name);
      drafts.push({
        op: 'create',
        collection: 'places',
        data: {
          title: name ?? '',
          parentId: parent?.id ?? null,
          communityId: parent?.communityId ?? ctx.communityId ?? null,
          body,
        },
      });
      break;
    }
    case 'glossaryTerms': {
      const term = r.cjk[0] ?? r.quoted[0] ?? null;
      if (!term) need('characters', 'Term');
      drafts.push({
        op: 'create',
        collection: 'glossaryTerms',
        data: {
          title: term ?? '',
          characters: term ?? '',
          language: term && hasHan(term) ? 'mandarin' : 'english',
          usageNote: text,
        },
      });
      break;
    }
    case 'openQuestions': {
      drafts.push({
        op: 'create',
        collection: 'openQuestions',
        data: { title, question: text, body: '' },
      });
      break;
    }
    case 'characters': {
      const name = unknown?.label ?? null;
      if (!name) need('names.full', 'Name');
      drafts.push({
        op: 'create',
        collection: 'characters',
        data: {
          title: name ?? '',
          names: { full: name ?? '' },
          birth: { unknown: true },
          body,
        },
      });
      break;
    }
  }

  for (const u of r.unknown) {
    reasons.push(
      section === 'places' || section === 'characters'
        ? `"${u.label}" is not in the bible, probably new`
        : `unknown name "${u.label}"`,
    );
  }
  const clause = secondClause(r, lexicon);
  if (clause) reasons.push(`a second clause names ${clause}, probably another fact`);
  return { drafts, missing, asks, reasons };
}
