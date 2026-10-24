/**
 * Structural numbers in titles (PL-3). A chapter's shown number comes from its
 * reading order, and a part's from its number field, so a title
 * such as "Ch. 3: Mark Gets Drunk" or "Part One: Sins of the Father" repeats a
 * number that goes stale as soon as the entries are reordered. These helpers
 * find such a leading number, give the bare name, and build the shown label
 * from the number field instead of the title.
 */

export type NumberedKind = 'chapter' | 'part';

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

function romanValue(text: string): number | null {
  const s = text.toLowerCase();
  if (!/^[ivxlc]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i] as string] ?? 0;
    const next = ROMAN[s[i + 1] as string] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : null;
}

const KEYWORDS: Record<NumberedKind, string> = {
  chapter: '(?:chapter|chap\\.?|ch\\.?)',
  part: '(?:part|pt\\.?)',
};

/** A separator after the number: punctuation, or spaces before the name. */
const PUNCT = '[:.)\\u2013\\u2014,-]';

function numberOf(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const w = WORDS.indexOf(token.toLowerCase());
  if (w > 0) return w;
  return romanValue(token);
}

/**
 * The structural number at the start of a title and the name after it:
 * "Ch. 1: Mark Feels Free" is chapter 1 named "Mark Feels Free", "Part One:
 * Sins of the Father" is part 1, "Part One" is part 1 with no name. A chapter
 * title may also start with a bare number followed by punctuation ("3: The
 * Storm", "3. The Storm"); a bare number followed only by a space ("1984 Was
 * Hot", "12 Angry Men") is part of the name. Returns null when the title
 * carries no such number.
 */
export function splitNumberedTitle(
  kind: NumberedKind,
  title: string,
): { number: number; name: string } | null {
  const text = title.trim();
  const keyword = new RegExp(
    `^${KEYWORDS[kind]}\\s*(\\d+|[a-z]+)(?:\\s*${PUNCT}+\\s*|\\s+|$)(.*)$`,
    'i',
  ).exec(text);
  if (keyword) {
    const token = keyword[1] ?? '';
    const rest = (keyword[2] ?? '').trim();
    // A word or numeral must end where the separator starts ("Ch. I Am" is not chapter 1 unless punctuated).
    const isDigits = /^\d+$/.test(token);
    const n = numberOf(token);
    if (n !== null) {
      const punctuated = new RegExp(`^${KEYWORDS[kind]}\\s*${token}\\s*${PUNCT}`, 'i').test(text);
      if (isDigits || punctuated || rest === '' || WORDS.includes(token.toLowerCase()))
        return { number: n, name: rest };
    }
  }
  if (kind === 'chapter') {
    const bare = new RegExp(`^(\\d+)\\s*${PUNCT}+\\s*(.+)$`).exec(text);
    if (bare) return { number: Number(bare[1]), name: (bare[2] ?? '').trim() };
  }
  return null;
}

/** The title without a leading structural number; the whole title when that would leave nothing. */
export function bareTitle(kind: NumberedKind, title: string): string {
  const split = splitNumberedTitle(kind, title);
  return split && split.name !== '' ? split.name : title.trim();
}

/** Which structural kind a collection's titles may start with, if any. */
export function numberedKindOf(collection: string): NumberedKind | null {
  if (collection === 'chapters') return 'chapter';
  if (collection === 'parts') return 'part';
  return null;
}

/**
 * The label a part is shown by: the number from its number field and
 * the name from its title, "Part 2: Lost Spirits". A title that repeats the
 * same number ("Part Two: Lost Spirits") is shown without the repeat, and one
 * that is only the number ("Part One") is shown as "Part 1". A title whose
 * number disagrees with the number field is shown whole after the field's
 * number, so the disagreement stays visible.
 */
export function groupLabel(kind: 'part', number: unknown, title: string): string {
  const word = 'Part';
  const t = title.trim();
  if (typeof number !== 'number' || !Number.isFinite(number)) return t ? `${word}: ${t}` : word;
  const split = splitNumberedTitle(kind, t);
  const name = split && split.number === number ? split.name : t;
  return name ? `${word} ${number}: ${name}` : `${word} ${number}`;
}

/** Chapters before the numbered ones that a plan does not count ("Introduction"). */
const UNNUMBERED = /^(introduction|prologue|preface|foreword|epilogue|interlude)$/i;

type Entry = Record<string, unknown> & { _id: string };

export interface TitleCleanupPlan {
  /** Titles to rewrite to the bare name: the number agrees with the number field or the reading order. */
  renames: {
    collection: 'parts' | 'chapters';
    id: string;
    from: string;
    to: string;
    number: number;
  }[];
  /** Titles left alone because their number disagrees with where the entry is. */
  disagreements: {
    collection: 'parts' | 'chapters';
    id: string;
    title: string;
    /** The number in the title. */
    says: number;
    /** What the entry's own fields make it, in words: "reading order 4, chapter 3 of its part". */
    is: string;
  }[];
  /** Titles that are only a number ("Part One"): no name would be left, so they stay. */
  numberOnly: { collection: 'parts' | 'chapters'; id: string; title: string }[];
}

/**
 * Which part and chapter titles repeat a structural number (PL-3). A
 * chapter's number agrees when it is the chapter's place in its part (not
 * counting an introduction or prologue), its shown number or its reading order; a part's when
 * it equals the number field. Nothing is guessed: a
 * disagreeing title is listed, not renamed.
 */
export function planTitleCleanup(data: {
  all: (c: string) => Record<string, unknown>[];
}): TitleCleanupPlan {
  const live = (c: string) =>
    data.all(c).filter((d) => !d.deletedAt && typeof d._id === 'string') as Entry[];
  const plan: TitleCleanupPlan = { renames: [], disagreements: [], numberOnly: [] };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const [collection, kind] of [['parts', 'part']] as const) {
    for (const d of live(collection)) {
      const title = String(d.title ?? '');
      const split = splitNumberedTitle(kind, title);
      if (!split) continue;
      if (!split.name) plan.numberOnly.push({ collection, id: d._id, title });
      else if (split.number === n(d.number))
        plan.renames.push({
          collection,
          id: d._id,
          from: title,
          to: split.name,
          number: split.number,
        });
      else
        plan.disagreements.push({
          collection,
          id: d._id,
          title,
          says: split.number,
          is: `${kind} number ${n(d.number) ?? 'not set'}`,
        });
    }
  }
  const chapters = live('chapters').sort(
    (a, b) => (n(a.readingOrder) ?? 0) - (n(b.readingOrder) ?? 0) || a._id.localeCompare(b._id),
  );
  const shown = chapterNumbers(chapters);
  const counted = (c: Entry) => !UNNUMBERED.test(String(c.title ?? '').trim());
  const inPart = new Map<string, number>();
  for (const c of chapters) {
    if (!counted(c)) continue;
    const partId = String(c.partId ?? '');
    inPart.set(
      c._id,
      chapters.filter((x) => counted(x) && String(x.partId ?? '') === partId).indexOf(c) + 1,
    );
  }
  for (const c of chapters) {
    const title = String(c.title ?? '');
    const split = splitNumberedTitle('chapter', title);
    if (!split) continue;
    if (!split.name) {
      plan.numberOnly.push({ collection: 'chapters', id: c._id, title });
      continue;
    }
    const order = n(c.readingOrder);
    const part = inPart.get(c._id);
    if (split.number === part || split.number === order || split.number === shown.get(c._id))
      plan.renames.push({
        collection: 'chapters',
        id: c._id,
        from: title,
        to: split.name,
        number: split.number,
      });
    else
      plan.disagreements.push({
        collection: 'chapters',
        id: c._id,
        title,
        says: split.number,
        is: `reading order ${order ?? 'not set'}, chapter ${part ?? '?'} of its part`,
      });
  }
  return plan;
}

/**
 * PL-3, KB-3 (A54): the number each chapter is shown by, its 1-based place
 * among the live chapters sorted by reading order, then title, then id.
 * Reading order stays the stored sort key; trashed chapters get no number and
 * leave no gap, and a move, trash, restore or new chapter renumbers the rest.
 */
export function chapterNumbers(chapters: readonly Record<string, unknown>[]): Map<string, number> {
  const order = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const live = chapters
    .filter((c) => !c.deletedAt && typeof c._id === 'string')
    .map((c) => ({
      id: c._id as string,
      order: order(c.readingOrder),
      title: text(c.title).trim() || text(c.name).trim(),
    }))
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.title.localeCompare(b.title) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return new Map(live.map((c, i) => [c.id, i + 1]));
}
