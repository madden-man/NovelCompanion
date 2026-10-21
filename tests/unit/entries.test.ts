import { describe, expect, test } from 'vitest';
import {
  ENTRIES_COLLECTIONS,
  entryKinds,
  ENTRIES_PAGE,
  filterEntries,
  filterIndexed,
  firstLine,
  indexEntries,
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

const kinds = entryKinds();
const all = new Set(kinds.map((k) => k.key));

describe('KB-5 the Entries list', () => {
  test('KB-5 SM-2 the kinds are the four sections left after A39: no facts, themes, or custom sections', () => {
    expect(kinds.map((k) => k.plural)).toEqual([
      'Cultural entries',
      'Places',
      'Glossary',
      'Open questions',
    ]);
  });

  test('KB-5 every kind is listed, newest change first', () => {
    const shown = filterEntries(rows(), { kinds: all, status: null, query: '' });
    expect(shown).toHaveLength(rows().length);
    const stamps = shown.map((r) => String(r.entry.modifiedAt));
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(new Set(shown.map((r) => r.collection))).toEqual(
      new Set(['culturalEntries', 'places', 'glossaryTerms']),
    );
  });

  test('KB-5 a kind left out of the chips is hidden; one kind alone shows only its own', () => {
    const noPlaces = new Set([...all].filter((k) => k !== 'places'));
    const shown = filterEntries(rows(), { kinds: noPlaces, status: null, query: '' });
    expect(shown.some((r) => r.collection === 'places')).toBe(false);
    const only = filterEntries(rows(), { kinds: new Set(['places']), status: null, query: '' });
    expect(only.length).toBe((fx.places ?? []).length);
    expect(only.every((r) => kindKeyOf(r.collection, r.entry) === 'places')).toBe(true);
  });

  test('KB-5 the status filter and the search narrow the list', () => {
    const planned = filterEntries(rows(), { kinds: all, status: 'planned', query: '' });
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((r) => r.entry.status === 'planned')).toBe(true);
    const cakes = filterEntries(rows(), { kinds: all, status: null, query: 'mooncakes' });
    expect(cakes.map((r) => r.entry.title)).toContain('Mid-Autumn mooncakes');
    expect(cakes.every((r) => textMatches(r.entry, 'mooncakes'))).toBe(true);
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

  test('KB-5 NF-1 the indexed list matches the plain filter and filters 5,000 rows within the search budget', () => {
    const plainRows = rows();
    const indexed = ENTRIES_COLLECTIONS.flatMap((c) =>
      indexEntries(
        c,
        plainRows.filter((r) => r.collection === c).map((r) => r.entry),
      ),
    );
    for (const query of ['', 'letter', 'mooncakes', 'family reunion', 'zzz']) {
      const f = { kinds: all, status: null, query };
      expect(filterIndexed(indexed, f).map((r) => r.id)).toEqual(
        filterEntries(plainRows, f).map((r) => String(r.entry._id)),
      );
    }
    const many = Array.from({ length: 5000 }, (_, i) => ({
      _id: `X${i}`,
      title: `Fact ${i} harbor`,
      status: 'canon',
      body: `<p>The ferry ${i} crosses at dawn.</p><p>Second line.</p>`,
      modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    const big = indexEntries('culturalEntries', many);
    expect(big[0]!.firstLine).toBe('The ferry 0 crosses at dawn.');
    const start = performance.now();
    for (const q of ['h', 'ha', 'har', 'harb', 'harbor', 'harbor ferry']) {
      filterIndexed(big, { kinds: all, status: null, query: q });
    }
    expect((performance.now() - start) / 6).toBeLessThan(200);
    expect(ENTRIES_PAGE).toBe(200);
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
