import { entryTitle } from '../../schema';
import type { EntryCollection, FieldSpec } from '../../schema';
import { isPlainObject } from '../paths';
import type { Doc } from '../paths';
import type { MapContext, MappedRow } from './types';

const STUBBABLE: Partial<Record<EntryCollection, (name: string) => Doc>> = {
  characters: (name) => ({ title: name, names: { full: name }, birth: { unknown: true } }),
  families: (name) => ({ title: name, name }),
  places: (name) => ({ title: name }),
};

const ALL_COLLECTIONS: EntryCollection[] = [
  'characters',
  'families',
  'places',
  'chapters',
  'parts',
  'books',
  'worldEvents',
  'eraStates',
  'culturalEntries',
  'glossaryTerms',
];

/** The names an entry answers to: its title, and for people their full and Chinese names. */
function namesOf(doc: Doc): string[] {
  const out = [entryTitle(doc)];
  const names = doc.names;
  if (isPlainObject(names)) {
    for (const key of ['full', 'chinese']) {
      if (typeof names[key] === 'string') out.push(names[key]);
    }
  }
  return out.map((n) => n.trim().toLowerCase()).filter(Boolean);
}

/** The words of a person's title and full name, lower case: "Frank Sullivan" answers to "frank" and "sullivan". */
function wordsOf(doc: Doc): string[] {
  const out = entryTitle(doc).split(/\s+/);
  const names = doc.names;
  if (isPlainObject(names) && typeof names.full === 'string') out.push(...names.full.split(/\s+/));
  return out.map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/** Chinese surnames of two characters; any other surname is taken to be one character. */
export const TWO_CHARACTER_SURNAMES = [
  '欧阳',
  '司马',
  '上官',
  '诸葛',
  '东方',
  '皇甫',
  '尉迟',
  '公孙',
  '慕容',
  '令狐',
  '长孙',
  '宇文',
  '司徒',
  '夏侯',
  '轩辕',
  '端木',
  '独孤',
  '南宫',
  '西门',
  '百里',
];

/** The Chinese name without its surname: 李勤 answers to 勤, 欧阳明 to 明. */
export function chineseGivenName(chinese: string): string {
  const chars = [...chinese.trim()];
  const surname = TWO_CHARACTER_SURNAMES.includes(chars.slice(0, 2).join('')) ? 2 : 1;
  return chars.length > surname ? chars.slice(surname).join('') : '';
}

function chineseOf(doc: Doc): string {
  const names = doc.names;
  return isPlainObject(names) && typeof names.chinese === 'string' ? names.chinese.trim() : '';
}

/**
 * True when a hint names this person's family: one word of their names, Chinese
 * characters within their Chinese name, or the name of a family they belong to.
 */
function hinted(doc: Doc, hint: string, familyNames: (doc: Doc) => string[]): boolean {
  const h = hint.trim().toLowerCase();
  if (!h) return false;
  if (wordsOf(doc).includes(h)) return true;
  if (/\p{Script=Han}/u.test(h) && chineseOf(doc).includes(h)) return true;
  return familyNames(doc).some((f) => f === h || f.split(/\s+/).includes(h));
}

/**
 * A person a short name means when no entry carries it whole: one word of the
 * title or full name ("Qin" for Li Qin), or the Chinese name without its
 * surname (勤 for 李勤). Only a mapping with hints (the sheet's family) may
 * match this way, and only when exactly one such person is in the family;
 * more than one is ambiguous, none falls back to the mapping's stub rule.
 */
function personByPart(
  people: Doc[],
  want: string,
  hints: string[],
  familyNames: (doc: Doc) => string[],
): Doc | null | 'ambiguous' {
  if (hints.length === 0) return null;
  const hits = people.filter(
    (d) => wordsOf(d).includes(want) || (chineseOf(d) && chineseGivenName(chineseOf(d)) === want),
  );
  const narrowed = hits.filter((d) => hints.some((h) => hinted(d, h, familyNames)));
  if (narrowed.length > 1) return 'ambiguous';
  return narrowed[0] ?? null;
}

/** Common surnames in pinyin and characters, so "Li Family" also hints 李. */
const SURNAME_CHARACTERS: Record<string, string> = {
  li: '李',
  wang: '王',
  zhang: '张',
  liu: '刘',
  chen: '陈',
  zhou: '周',
  huang: '黄',
  wu: '吴',
};

/** The family words a heading row gives: "Li Family" hints Li and 李, "Sullivan Family" Sullivan. */
export function familyHints(heading: string): string[] {
  const words = heading
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter((w) => w && !/^(family|families|the|and|&)$/i.test(w));
  return words.flatMap((w) => {
    const han = SURNAME_CHARACTERS[w.toLowerCase()];
    return han ? [w, han] : [w];
  });
}

/** The report line for names matched by part of a person's name. */
export function partialNote(sheet: string, partials: string[]): string | null {
  return partials.length
    ? `${sheet}: names matched by part of a name, check them: ${partials.join('; ')}.`
    : null;
}

export interface NameResolver {
  resolve(spec: FieldSpec, name: string): string | null | 'ambiguous';
  /** Stub entries made so far for names that matched nothing. */
  stubs: MappedRow[];
  /** Names matched by part of a person's name, for the report: `"Qin" matched Li Qin`. */
  partials: string[];
  /** A point to return to when the row that made new stubs fails. */
  mark(): number;
  rollback(mark: number): void;
}

/**
 * Resolve a name in a cell to the ID of an existing entry (by title or by a
 * person's names). With `createMissing`, a name that matches nothing becomes a
 * stub entry that the import creates first, once per name.
 */
export function nameResolver(
  ctx: MapContext,
  opts: {
    createMissing: boolean;
    ref: () => string;
    where: () => string;
    /** The family words that allow a short name to match (the sheet's family, or the heading above the row). */
    hints?: string[] | (() => string[]);
  },
): NameResolver {
  const stubs: MappedRow[] = [];
  const partials: string[] = [];
  const made = new Map<string, string>();
  let families: Map<string, string> | null = null;
  const familyNames = (doc: Doc): string[] => {
    families ??= new Map(
      ctx.entries('families').map((f) => [String(f._id), entryTitle(f).toLowerCase()]),
    );
    const ids = Array.isArray(doc.familyIds) ? doc.familyIds : [];
    return ids.flatMap((id) => families?.get(String(id)) ?? []);
  };
  return {
    stubs,
    partials,
    mark: () => stubs.length,
    rollback(mark) {
      for (const dropped of stubs.splice(mark)) {
        for (const [key, id] of made) if (id === dropped.newId) made.delete(key);
      }
    },
    resolve(spec, name) {
      const want = name.trim().toLowerCase();
      const collections = (spec.target ?? []).includes('*')
        ? ALL_COLLECTIONS
        : ((spec.target ?? []) as EntryCollection[]);
      const hits = new Set<string>();
      for (const c of collections) {
        for (const doc of ctx.entries(c)) {
          if (doc._id === name || namesOf(doc).includes(want)) hits.add(String(doc._id));
        }
      }
      if (hits.size > 1) return 'ambiguous';
      const [only] = [...hits];
      if (hits.size === 1 && only !== undefined) return only;
      if (collections.includes('characters') && want) {
        const hints = typeof opts.hints === 'function' ? opts.hints() : (opts.hints ?? []);
        const part = personByPart(ctx.entries('characters'), want, hints, familyNames);
        if (part === 'ambiguous') return part;
        if (part) {
          const line = `"${name.trim()}" matched ${entryTitle(part)}`;
          if (!partials.includes(line)) partials.push(line);
          return String(part._id);
        }
      }
      const key = `${collections.join(',')}:${want}`;
      const prior = made.get(key);
      if (prior) return prior;
      if (!opts.createMissing) return null;
      const target = collections.find((c) => STUBBABLE[c]);
      const stub = target ? STUBBABLE[target] : undefined;
      if (!target || !stub) return null;
      const id = ctx.newId();
      made.set(key, id);
      stubs.push({
        ref: opts.ref(),
        where: opts.where(),
        ok: true,
        collection: target,
        newId: id,
        fields: {},
        data: {
          ...stub(name.trim()),
          status: 'planned',
          sourceRef: opts.ref(),
          _id: id,
        },
        identity: want,
        kind: 'entry',
      });
      return id;
    },
  };
}
