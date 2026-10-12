import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DROP_ORDER,
  allGroups,
  itemSize,
  selectForSession,
} from '../../src/shared/domain/brief/selection';
import type { BriefInput, GroupKind, Selection } from '../../src/shared/domain/brief/selection';
import {
  citationProblems,
  citedIds,
  markdownToHtml,
  missingLeadSections,
  structuredBrief,
  uncitedLines,
} from '../../src/shared/domain/brief/render';
import { fromCollections } from '../../src/shared/domain/timeline';
import { briefCollections, briefData } from '../helpers/briefFixture';
import { SelectionWire } from '../../src/shared/ipcSession';

interface StrandCase {
  strandId: string | null;
  primary: boolean;
  year: number;
  characters: { id: string; note: string }[];
  groups: Partial<Record<GroupKind, string[]>>;
  notes?: Partial<Record<GroupKind, Record<string, string>>>;
  refs?: Partial<Record<GroupKind, Record<string, string[]>>>;
}

interface Case {
  name: string;
  supplement: boolean;
  input: BriefInput;
  label: string;
  year: number;
  strands: StrandCase[];
  shared: Partial<Record<GroupKind, string[]>>;
  sharedNotes?: Partial<Record<GroupKind, Record<string, string>>>;
  ids: string[];
}

const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/expected/sb2-selection.json'), 'utf8'),
) as {
  cases: Case[];
  budgetZero: { omitted: [GroupKind, string][]; ids: string[] };
  partTwo: { beats: string[]; plannedAhead: string[] };
};

const STRAND_KINDS: GroupKind[] = [
  'era',
  'eventsWindow',
  'eventsFormative',
  'eventsPlaces',
  'culture',
  'places',
  'knowledge',
  'povUnknown',
  'plannedAhead',
];
const SHARED_KINDS: GroupKind[] = [
  'previousChapters',
  'beats',
  'glossary',
  'themes',
  'openQuestions',
  'custom',
  'sessionNote',
  'decidedQuestions',
  'plannedAhead',
  'added',
];

const group = (groups: Selection['shared'], kind: GroupKind) =>
  groups.find((g) => g.kind === kind)!.items;

describe('SB-2 the selection matches the hand-written known answers (fixtures/expected/sb2-selection.json)', () => {
  for (const c of expected.cases) {
    test(`SB-1 SB-2 ${c.name}`, () => {
      const sel = selectForSession(briefData(c.supplement), c.input);
      expect(sel.label).toBe(c.label);
      expect(sel.year).toBe(c.year);
      // A5: one section per strand, the primary first.
      expect(sel.strands.map((s) => [s.strandId, s.primary, s.year])).toEqual(
        c.strands.map((s) => [s.strandId, s.primary, s.year]),
      );
      c.strands.forEach((want, i) => {
        const got = sel.strands[i]!;
        // Step 1: characters present with ages (TL-2 states).
        expect(group(got.groups, 'characters').map((it) => ({ id: it.id, note: it.note }))).toEqual(
          want.characters,
        );
        for (const kind of STRAND_KINDS) {
          expect(
            group(got.groups, kind).map((it) => it.id),
            `${want.strandId} ${kind}`,
          ).toEqual(want.groups[kind] ?? []);
          for (const [id, note] of Object.entries(want.notes?.[kind] ?? {})) {
            expect(group(got.groups, kind).find((it) => it.id === id)?.note, `${kind} ${id}`).toBe(
              note,
            );
          }
          for (const [id, refs] of Object.entries(want.refs?.[kind] ?? {})) {
            expect(group(got.groups, kind).find((it) => it.id === id)?.refs).toEqual(refs);
          }
        }
      });
      for (const kind of SHARED_KINDS) {
        expect(
          group(sel.shared, kind).map((it) => it.id),
          kind,
        ).toEqual(c.shared[kind] ?? []);
        for (const [id, note] of Object.entries(c.sharedNotes?.[kind] ?? {})) {
          expect(group(sel.shared, kind).find((it) => it.id === id)?.note, `${kind} ${id}`).toBe(
            note,
          );
        }
      }
      // SB-3: the manifest is every selected ID, sorted.
      expect(sel.ids).toEqual(c.ids);
      expect(sel.omitted).toEqual([]);
    });
  }

  test('SB-2 a strand input selects only that strand', () => {
    const sel = selectForSession(briefData(false), {
      kind: 'strand',
      chapterId: 'CH2',
      strandId: 'CH2-backstory',
    });
    expect(sel.strands.map((s) => s.strandId)).toEqual(['CH2-backstory']);
    expect(sel.year).toBe(2032);
    expect(sel.label).toBe('Chapter 2: Two Kitchens, backstory, 2032');
  });

  test('SB-2 a part input covers its chapters in reading order, each strand primary first', () => {
    const sel = selectForSession(briefData(false), { kind: 'part', partId: 'PT1' });
    expect(sel.chapterIds).toEqual(['CH1', 'CH2', 'CH3', 'CH4']);
    expect(sel.strands.map((s) => s.strandId)).toEqual([
      'CH1-present',
      'CH2-present',
      'CH2-backstory',
      'CH3-present',
      'CH4-present',
    ]);
    expect(sel.year).toBe(2075);
  });

  test('SB-1 a year and point of view with a place and other characters uses them', () => {
    const sel = selectForSession(briefData(true), {
      kind: 'pov',
      year: 2045,
      povCharacterId: 'H5',
      placeIds: ['PLC2'],
      characterIds: ['H3'],
    });
    const s = sel.strands[0]!;
    // The point of view is always present, first, even when other characters are given.
    expect(group(s.groups, 'characters').map((it) => it.id)).toEqual(['H5', 'H3']);
    expect(group(s.groups, 'culture').map((it) => it.id)).toEqual(['CU4']);
    expect(group(s.groups, 'places').map((it) => it.id)).toEqual(['PLC2']);
    expect(group(sel.shared, 'beats')).toEqual([]);
  });

  test('SB-2 step 1 the point of view is listed first even when it is already in the strand cast', () => {
    const sel = selectForSession(briefData(true), {
      kind: 'pov',
      year: 2045,
      povCharacterId: 'H5',
      characterIds: ['H3', 'H5'],
    });
    expect(group(sel.strands[0]!.groups, 'characters').map((it) => it.id)).toEqual(['H5', 'H3']);
  });

  test('SB-2 a strand with no start year is skipped with a note, not selected as year 0', () => {
    const cols = briefCollections(true);
    cols.chapters = cols.chapters!.map((c) =>
      c._id === 'CH2'
        ? {
            ...c,
            strands: (c.strands as Record<string, unknown>[]).map((s, i) =>
              i === 0 ? { ...s, startYear: undefined } : s,
            ),
          }
        : c,
    );
    const sel = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH2' });
    expect(sel.strands.every((s) => s.year !== 0)).toBe(true);
    expect(sel.skippedStrands).toHaveLength(1);
    expect(structuredBrief(sel)).toContain('strand has no start year');
  });

  test('SB-2 a trashed character, event, or beat is never selected', () => {
    const cols = briefCollections(true);
    cols.worldEvents = cols.worldEvents!.map((e) =>
      e._id === 'E4' ? { ...e, deletedAt: '2026-02-01T00:00:00.000Z' } : e,
    );
    cols.characters = cols.characters!.map((e) =>
      e._id === 'H3' ? { ...e, deletedAt: '2026-02-01T00:00:00.000Z' } : e,
    );
    const sel = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH6' });
    expect(sel.ids).not.toContain('E4');
    expect(sel.ids).not.toContain('H3');
    expect(sel.ids).not.toContain('B8');
  });

  test('SB-2 the window is a setting: a 3 year window keeps only events still running since 2042', () => {
    const sel = selectForSession(
      briefData(false),
      { kind: 'chapter', chapterId: 'CH2' },
      { window: 3, budget: 40_000 },
    );
    expect(group(sel.strands[0]!.groups, 'eventsWindow').map((it) => it.id)).toEqual(['E5']);
    expect(sel.window).toBe(3);
  });
});

describe('SB-3 the manifest is identical for the same inputs and data', () => {
  test('SB-3 two runs, and a run over the collections in reverse order, give identical selections', () => {
    const input: BriefInput = { kind: 'chapter', chapterId: 'CH6' };
    const a = selectForSession(briefData(true), input);
    const b = selectForSession(briefData(true), input);
    expect(b).toEqual(a);
    const reversed = Object.fromEntries(
      Object.entries(briefCollections(true)).map(([k, v]) => [k, [...v].reverse()]),
    );
    const c = selectForSession(fromCollections(reversed), input);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});

describe('SB-6 the size budget drops items in the fixed priority order', () => {
  test('SB-6 A25 a budget of 0 drops everything but the lead sections, lowest priority first, and says the brief is over budget', () => {
    const sel = selectForSession(
      briefData(true),
      { kind: 'chapter', chapterId: 'CH6' },
      { window: 10, budget: 0 },
    );
    expect(sel.omitted.map((o) => [o.kind, o.id])).toEqual(expected.budgetZero.omitted);
    expect(sel.omitted.every((o) => o.reason === 'budget')).toBe(true);
    expect(sel.ids).toEqual(expected.budgetZero.ids);
    expect(sel.size).toBeGreaterThan(0);
    expect(sel.overBudget).toBe(true);
    const brief = structuredBrief(sel);
    expect(brief).toContain('## Left out');
    expect(brief).toContain('## Over budget');
    // An entry reported as left out is never still in the manifest.
    expect(sel.omitted.filter((o) => sel.ids.includes(o.id))).toEqual([]);
  });

  test('SB-6 an event in two strands is left out only when it leaves both', () => {
    // The fixture is read once: selection is pure, and re-reading it per budget made this slow.
    const data = briefData(false);
    const full = selectForSession(data, { kind: 'chapter', chapterId: 'CH2' });
    for (let b = full.size - 1; b >= 0; b -= 1) {
      const s = selectForSession(
        data,
        { kind: 'chapter', chapterId: 'CH2' },
        { window: 10, budget: b },
      );
      expect(
        s.omitted.filter((o) => s.ids.includes(o.id)),
        `budget ${b}`,
      ).toEqual([]);
    }
  });

  test('SB-6 a budget one character short drops only the lowest priority item', () => {
    const full = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    const sel = selectForSession(
      briefData(true),
      { kind: 'chapter', chapterId: 'CH6' },
      { window: 10, budget: full.size - 1 },
    );
    expect(sel.omitted.map((o) => [o.kind, o.id, o.reason])).toEqual([
      ['plannedAhead', 'E9', 'budget'],
    ]);
    expect(sel.size).toBeLessThanOrEqual(full.size - 1);
    const brief = structuredBrief(sel);
    expect(brief).toMatch(
      /Household robots outnumber cars in Portland \(planned ahead\): over the size budget/,
    );
  });

  test('SB-6 the budget counts the characters of the selected text, each entry once', () => {
    const sel = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    const seen = new Set<string>();
    let n = 0;
    for (const g of allGroups(sel)) {
      for (const it of g.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        n += itemSize(it);
      }
    }
    expect(sel.size).toBe(n);
    expect(DROP_ORDER).toEqual([
      'plannedAhead',
      'custom',
      'decidedQuestions',
      'openQuestions',
      'themes',
      'glossary',
      'places',
      'eventsPlaces',
      'previousChapters',
      'beats',
      'povUnknown',
      'knowledge',
      'era',
      'sessionNote',
    ]);
    // A25: the DB-2 lead sections are never dropped.
    for (const k of ['characters', 'eventsWindow', 'eventsFormative', 'culture'] as GroupKind[]) {
      expect(DROP_ORDER).not.toContain(k);
    }
  });
});

describe('SB-3 SB-5 A24 more known answers', () => {
  test('SB-3 a duplicate knowledge record gives the same manifest in either stored order', () => {
    const cols = briefCollections(true);
    const k4 = cols.knowledgeRecords!.find((k) => k._id === 'K4')!;
    cols.knowledgeRecords = [...cols.knowledgeRecords!, { ...k4, _id: 'K5' }];
    const input: BriefInput = { kind: 'chapter', chapterId: 'CH6' };
    const a = selectForSession(fromCollections(cols), input);
    const reversed = Object.fromEntries(
      Object.entries(cols).map(([k, v]) => [k, [...v].reverse()]),
    );
    const b = selectForSession(fromCollections(reversed), input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // The lower ID counts when two records share a year.
    expect(a.ids).toContain('K4');
    expect(a.ids).not.toContain('K5');
  });

  test('SB-5 a whole-part session puts beats dated after the story year under Planned ahead', () => {
    const sel = selectForSession(briefData(true), { kind: 'part', partId: 'PT2' });
    expect(sel.year).toBe(2040);
    expect(group(sel.shared, 'beats').map((it) => it.id)).toEqual(expected.partTwo.beats);
    expect(group(sel.shared, 'plannedAhead').map((it) => it.id)).toEqual(
      expected.partTwo.plannedAhead,
    );
    const md = structuredBrief(sel);
    const ahead = md.indexOf('## Planned ahead (after 2040)');
    expect(ahead).toBeGreaterThan(0);
    expect(md.indexOf('[[B6]]')).toBeGreaterThan(ahead);
  });

  test('A24 decided questions are selected by the same link rule and shown under Decided with their decision', () => {
    const sel = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    expect(group(sel.shared, 'decidedQuestions').map((it) => [it.id, it.detail])).toEqual([
      ['Q2', 'Settled: she is. Decision: Left-handed.'],
    ]);
    expect(group(sel.shared, 'openQuestions').map((it) => it.id)).toEqual(['Q1', 'Q4']);
    const md = structuredBrief(sel);
    const decided = md.indexOf('### Decided');
    expect(decided).toBeGreaterThan(md.indexOf('## 8. Glossary, themes, and open questions'));
    expect(md.indexOf('[[Q2]]')).toBeGreaterThan(decided);
    expect(md.indexOf('[[Q1]]')).toBeLessThan(decided);
  });
});

describe('SB-9 add and remove entries, then select again', () => {
  test('SB-9 a removed entry leaves every group and the manifest; an added entry joins both', () => {
    const sel = selectForSession(
      briefData(true),
      { kind: 'chapter', chapterId: 'CH6' },
      undefined,
      { add: ['Z4', 'GL1'], remove: ['E4', 'GL1'] },
    );
    expect(sel.ids).not.toContain('E4');
    expect(sel.ids).not.toContain('GL1');
    expect(sel.ids).toContain('Z4');
    expect(group(sel.shared, 'added').map((it) => [it.id, it.title])).toEqual([['Z4', 'Zhou Jun']]);
    expect(sel.removed).toEqual(['E4', 'GL1']);
    expect(sel.omitted.map((o) => [o.id, o.reason])).toEqual([
      ['E4', 'removed'],
      ['GL1', 'removed'],
    ]);
    expect(structuredBrief(sel)).toContain('## 11. Added by you');
  });
});

describe('SB-5 SB-7 the structured brief', () => {
  const sel = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
  const md = structuredBrief(sel);

  test('DB-2 SB-7 the brief opens with characters and ages, world events, and cultural expectations', () => {
    expect(missingLeadSections(md)).toEqual([]);
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings.slice(0, 3)).toEqual([
      '## 1. Characters and their ages',
      '## 2. World events ongoing',
      '## 3. Cultural expectations',
    ]);
    expect(md).toContain('Iris Hale-Zhou: alive, age 14.');
  });

  test('SB-5 canon and planned material are apart, and events after the year only appear under Planned ahead', () => {
    const lines = md.split('\n');
    const ahead = lines.findIndex((l) => l.startsWith('## Planned ahead (after 2045)'));
    expect(ahead).toBeGreaterThan(0);
    const e9 = lines.findIndex((l) => l.includes('[[E9]]'));
    expect(e9).toBeGreaterThan(ahead);
    // In the world events section, canon lines come before the "Planned or idea" label.
    const events = lines.slice(
      lines.indexOf('## 2. World events ongoing'),
      lines.indexOf('## 3. Cultural expectations'),
    );
    const canon = events.indexOf('Canon:');
    const planned = events.indexOf('Planned or idea:');
    expect(canon).toBeGreaterThan(0);
    expect(planned).toBeGreaterThan(canon);
    expect(events.slice(canon + 1, planned).every((l) => !l.includes('[[E5]]'))).toBe(true);
    expect(events.slice(planned).some((l) => l.includes('[[E5]]'))).toBe(true);
  });

  test('SB-4 every line cites manifest entries only; a foreign citation is caught and marked', () => {
    expect(citationProblems(md, sel.ids)).toEqual([]);
    expect(citedIds(md)).toEqual(expect.arrayContaining(sel.ids.filter((id) => id !== 'CH6')));
    const edited = `${md}\n- Something else. [[Z2]]`;
    expect(citationProblems(edited, sel.ids)).toEqual(['Z2']);
    expect(markdownToHtml(edited, sel.ids)).toContain(
      '<span class="cite bad" data-cite="Z2" title="Not in the selection">Z2 not in the selection</span>',
    );
  });

  test('SB-4 lines of a Claude-written brief that cite nothing are found and marked', () => {
    const text =
      '# Brief\n\n## 1. Characters\n- Iris is fourteen. [[H5]]\n- Daniel is tired.\nA loose sentence.\n- Nothing selected.\n';
    expect(uncitedLines(text)).toEqual(['Daniel is tired.', 'A loose sentence.']);
    const html = markdownToHtml(text, sel.ids, { flagUncited: true });
    expect(html).toContain(
      '<li><span class="uncited" title="This line cites no entry">Daniel is tired. <strong class="uncited-flag">cites nothing</strong></span></li>',
    );
    expect(markdownToHtml(text, sel.ids)).not.toContain('uncited');
  });

  test('SB-8 Markdown to HTML escapes brief text', () => {
    expect(markdownToHtml('- <script>x</script> **bold**')).toBe(
      '<ul>\n<li>&lt;script&gt;x&lt;/script&gt; <strong>bold</strong></li>\n</ul>',
    );
  });
});

describe('SB-1 SB-6 A25 M7 review fixes', () => {
  test('SB-1 a parent link counts from its start year: H6 in 2013 has no adoptive parent H4 yet', () => {
    const at = (year: number) =>
      group(
        selectForSession(briefData(false), { kind: 'pov', year, povCharacterId: 'H6' }).strands[0]!
          .groups,
        'characters',
      ).map((it) => it.id);
    expect(at(2013)).not.toContain('H4');
    expect(at(2016)).toContain('H4');
  });

  test('A25 SB-6 the lead size leaves out entries you added, so a budget the lead fits is not over budget', () => {
    const input: BriefInput = { kind: 'chapter', chapterId: 'CH6' };
    const probe = selectForSession(briefData(true), input, { window: 10, budget: 0 });
    const budget = probe.leadSize + 5;
    const sel = selectForSession(briefData(true), input, { window: 10, budget }, { add: ['Z4'] });
    expect(sel.leadSize).toBe(probe.leadSize);
    expect(sel.size).toBeGreaterThan(budget);
    expect(sel.overBudget).toBe(false);
    expect(structuredBrief(sel)).not.toContain('## Over budget');
    const tight = selectForSession(briefData(true), input, { window: 10, budget: 0 });
    expect(structuredBrief(tight)).toContain(
      `The lead sections alone are ${tight.leadSize} characters`,
    );
  });
  test('SB-2 the wire schema accepts every field a real selection carries, including an undated strand', () => {
    const whole = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    expect(SelectionWire.parse(whole)).toEqual(whole);
    const cols = briefCollections(false);
    cols.chapters = cols.chapters!.map((c) =>
      c._id === 'CH2'
        ? {
            ...c,
            strands: (c.strands as Record<string, unknown>[]).map((s, i) =>
              i === 0 ? { ...s, startYear: undefined } : s,
            ),
          }
        : c,
    );
    const skipped = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH2' });
    expect(skipped.skippedStrands).toHaveLength(1);
    expect(SelectionWire.parse(skipped)).toEqual(skipped);
  });
});
