import { describe, expect, test } from 'vitest';
import {
  ENTRIES_COLLECTIONS,
  entryKinds,
  filterEntries,
  firstLine,
  isEntriesTab,
  kindKeyOf,
  orderWorldRows,
  textMatches,
} from '../../src/shared/domain/entries';
import type { EntriesCollection, EntriesRow } from '../../src/shared/domain/entries';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();

/** The fixture's entries of every listed kind, with modifiedAt spread so the order is known. */
function rows(): EntriesRow[] {
  let n = 0;
  const out: EntriesRow[] = [];
  for (const c of ENTRIES_COLLECTIONS) {
    for (const e of fx[c] ?? []) {
      n += 1;
      const at = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
      out.push({ collection: c as EntriesCollection, entry: { ...e, modifiedAt: at } });
    }
  }
  return out;
}

const sections = fx.customSections ?? [];
const kinds = entryKinds(sections);
const all = new Set(kinds.map((k) => k.key));

describe('KB-5 the Entries list', () => {
  test('KB-5 the kinds are the six built-in sections and one per custom section', () => {
    expect(kinds.slice(0, 6).map((k) => k.plural)).toEqual([
      'Facts',
      'Cultural entries',
      'Places',
      'Glossary',
      'Themes and motifs',
      'Open questions',
    ]);
    expect(kinds.slice(6).map((k) => k.label)).toEqual(
      sections.map((s) => String(s.name)).sort((a, b) => a.localeCompare(b)),
    );
    const deleted = entryKinds([{ _id: 'S9', name: 'Gone', deletedAt: '2026-01-01T00:00:00Z' }]);
    expect(deleted.map((k) => k.label)).not.toContain('Gone');
  });

  test('KB-5 every kind is listed, newest change first', () => {
    const shown = filterEntries(rows(), { kinds: all, status: null, query: '' });
    expect(shown).toHaveLength(rows().length);
    const stamps = shown.map((r) => String(r.entry.modifiedAt));
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(new Set(shown.map((r) => r.collection))).toEqual(
      new Set(['facts', 'culturalEntries', 'places', 'glossaryTerms', 'customEntries']),
    );
  });

  test('KB-5 a kind left out of the chips is hidden; a custom section is its own kind', () => {
    const noFacts = new Set([...all].filter((k) => k !== 'facts'));
    const shown = filterEntries(rows(), { kinds: noFacts, status: null, query: '' });
    expect(shown.some((r) => r.collection === 'facts')).toBe(false);
    const recipes = kinds.find((k) => k.sectionId)!;
    const only = filterEntries(rows(), { kinds: new Set([recipes.key]), status: null, query: '' });
    expect(only.length).toBe(
      (fx.customEntries ?? []).filter((e) => e.sectionId === recipes.sectionId).length,
    );
    expect(only.every((r) => kindKeyOf(r.collection, r.entry) === recipes.key)).toBe(true);
  });

  test('KB-5 the status filter and the search narrow the list', () => {
    const planned = filterEntries(rows(), { kinds: all, status: 'planned', query: '' });
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((r) => r.entry.status === 'planned')).toBe(true);
    const letter = filterEntries(rows(), { kinds: all, status: null, query: 'letter' });
    expect(letter.map((r) => r.entry.title)).toContain("Peter's letter");
    expect(letter.every((r) => textMatches(r.entry, 'letter'))).toBe(true);
    // A search hit counts even when the words are not in the text (GL-2 romanization).
    const term = (fx.glossaryTerms ?? []).find((t) => t.title === '团圆')!;
    const viaHits = filterEntries(rows(), {
      kinds: all,
      status: null,
      query: 'tuanyuan',
      hits: new Set([String(term._id)]),
    });
    expect(viaHits.map((r) => r.entry.title)).toEqual(['团圆']);
  });

  test('KB-5 the first line is plain text from the body, or another text field', () => {
    expect(firstLine({ body: '<p>One <em>two</em></p><p>Three</p>' })).toBe('One two');
    expect(firstLine({ body: '', meaning: 'family reunion' })).toBe('family reunion');
    expect(firstLine({ descriptions: [{ startYear: 2030, endYear: null, text: 'Wet.' }] })).toBe(
      'Wet.',
    );
    expect(firstLine({ body: 'x'.repeat(200) }, 20)).toHaveLength(20);
    expect(firstLine({})).toBe('');
  });

  test('KB-5 only the five tabs are tabs', () => {
    expect(['entries', 'culture', 'places', 'romanization', 'glossary'].every(isEntriesTab)).toBe(
      true,
    );
    expect(isEntriesTab('year')).toBe(false);
    expect(isEntriesTab(null)).toBe(false);
  });
});

describe('KB-4 the world list under the chart', () => {
  const list = [
    { id: 'a', startYear: 2040, endYear: 2040, modifiedAt: '2026-01-01T00:00:00Z', title: 'A' },
    { id: 'b', startYear: 2030, endYear: 2035, modifiedAt: '2026-03-01T00:00:00Z', title: 'B' },
    { id: 'c', startYear: 2050, endYear: 2050, modifiedAt: '2026-02-01T00:00:00Z', title: 'C' },
  ];
  test('KB-4 rows sort by year or by newest change', () => {
    expect(orderWorldRows(list, 'year').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(orderWorldRows(list, 'newest').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});
