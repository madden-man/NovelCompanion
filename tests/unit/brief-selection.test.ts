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
  partTwo: { moments: string[] };
};

const STRAND_KINDS: GroupKind[] = [
  'moments',
  'era',
  'eventsWindow',
  'eventsFormative',
  'culture',
  'places',
  'plannedAhead',
];
const SHARED_KINDS: GroupKind[] = [
  'previousChapters',
  'glossary',
  'openQuestions',
  'sessionNote',
  'decidedQuestions',
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

  test('SB-2 SM-3 a trashed character, event, or moment is never selected', () => {
    const cols = briefCollections(true);
    cols.moments = cols.moments!.map((m) =>
      m._id === 'B4' ? { ...m, deletedAt: '2026-02-01T00:00:00.000Z' } : m,
    );
    cols.worldEvents = cols.worldEvents!.map((e) =>
      e._id === 'E4' ? { ...e, deletedAt: '2026-02-01T00:00:00.000Z' } : e,
    );
    cols.characters = cols.characters!.map((e) =>
      e._id === 'H3' ? { ...e, deletedAt: '2026-02-01T00:00:00.000Z' } : e,
    );
    const sel = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH6' });
    expect(sel.ids).not.toContain('E4');
    expect(sel.ids).not.toContain('H3');
    expect(sel.ids).not.toContain('B4');
  });

  test('SB-2 A33 the window is a setting: a 10 year window keeps events still running since 2035, the default 3 keeps those since 2042', () => {
    const wide = selectForSession(
      briefData(false),
      { kind: 'chapter', chapterId: 'CH2' },
      { window: 10, budget: 40_000 },
    );
    expect(group(wide.strands[0]!.groups, 'eventsWindow').map((it) => it.id)).toEqual(['E4', 'E5']);
    expect(wide.window).toBe(10);
    const sel = selectForSession(briefData(false), { kind: 'chapter', chapterId: 'CH2' });
    expect(group(sel.strands[0]!.groups, 'eventsWindow').map((it) => it.id)).toEqual(['E5']);
    expect(sel.window).toBe(3);
  });

  test('SB-2 A33 SB-5 the window looks one year ahead: the event of the year after sits under Planned ahead, never in the window', () => {
    const sel = selectForSession(briefData(false), {
      kind: 'pov',
      year: 2047,
      povCharacterId: 'H5',
    });
    const s = sel.strands[0]!;
    expect(group(s.groups, 'eventsWindow').map((it) => it.id)).toEqual([]);
    expect(
      group(s.groups, 'plannedAhead').map((it) => [it.id, it.note, it.year, it.endYear]),
    ).toEqual([['E6', '2048 to 2051, next year', 2048, 2051]]);
    expect(sel.ids).toContain('E6');
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
    // No event is planned ahead of CH6 since world events lost their places (A39); the decided question goes first.
    expect(sel.omitted.map((o) => [o.kind, o.id, o.reason])).toEqual([
      ['decidedQuestions', 'Q2', 'budget'],
    ]);
    expect(sel.size).toBeLessThanOrEqual(full.size - 1);
    const brief = structuredBrief(sel);
    expect(brief).toMatch(/Is Iris left-handed\? \(decided\): over the size budget/);
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
    // SM-3: moments drop where beats did; knowledge, themes and custom entries went with A39.
    expect(DROP_ORDER).toEqual([
      'plannedAhead',
      'decidedQuestions',
      'openQuestions',
      'glossary',
      'places',
      'previousChapters',
      'moments',
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
  test('SB-3 SM-3 two moments of one year give the same manifest in either stored order', () => {
    const cols = briefCollections(true);
    const b4 = cols.moments!.find((m) => m._id === 'B4')!;
    cols.moments = [...cols.moments!, { ...b4, _id: 'B4A', title: 'Iris finds the letter' }];
    const input: BriefInput = { kind: 'chapter', chapterId: 'CH6' };
    const a = selectForSession(fromCollections(cols), input);
    const reversed = Object.fromEntries(
      Object.entries(cols).map(([k, v]) => [k, [...v].reverse()]),
    );
    const b = selectForSession(fromCollections(reversed), input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // Same year and title: the lower ID comes first.
    const ids = group(a.strands[0]!.groups, 'moments').map((it) => it.id);
    expect(ids.indexOf('B4')).toBeLessThan(ids.indexOf('B4A'));
  });

  test('SM-3 A5 a whole-part session reads each strand up to its own year, so a moment after the first chapter year comes in through a later strand', () => {
    const sel = selectForSession(briefData(true), { kind: 'part', partId: 'PT2' });
    expect(sel.year).toBe(2040);
    const moments = sel.strands.flatMap((s) => group(s.groups, 'moments').map((it) => it.id));
    expect([...new Set(moments)].sort()).toEqual(expected.partTwo.moments);
    // Each strand reads up to its own year: B6 (Lan, 2060) through CH7, never through CH5 (2040).
    const ch5 = sel.strands.find((st) => st.chapterId === 'CH5')!;
    expect(group(ch5.groups, 'moments').map((it) => it.id)).not.toContain('B6');
    expect(sel.ids).not.toContain('B1');
    const md = structuredBrief(sel);
    expect(md).toContain('## 5. Backstory');
  });

  test('SM-3 SB-5 in a one-chapter session a moment after the chapter year is not backstory; the next year sits under Planned ahead', () => {
    const cols = briefCollections(true);
    const b4 = cols.moments!.find((m) => m._id === 'B4')!;
    cols.moments = [
      ...cols.moments!,
      { ...b4, _id: 'M-NEXT', title: 'Iris answers the letter', year: 2046 },
      { ...b4, _id: 'M-LATER', title: 'Iris moves to Seattle', year: 2050 },
    ];
    const sel = selectForSession(fromCollections(cols), { kind: 'chapter', chapterId: 'CH6' });
    expect(sel.year).toBe(2045);
    const strand = sel.strands[0]!;
    const backstory = group(strand.groups, 'moments').map((it) => it.id);
    expect(backstory).toContain('B4');
    expect(backstory).not.toContain('M-NEXT');
    expect(backstory).not.toContain('M-LATER');
    const ahead = [...strand.groups, ...sel.shared]
      .filter((g) => g.kind === 'plannedAhead')
      .flatMap((g) => g.items.map((it) => it.id));
    expect(ahead).toContain('M-NEXT');
    expect(sel.ids).not.toContain('M-LATER');
    const md = structuredBrief(sel);
    const heading = md.indexOf('## Planned ahead (after 2045)');
    expect(heading).toBeGreaterThan(0);
    expect(md.indexOf('[[M-NEXT]]')).toBeGreaterThan(heading);
    expect(md.indexOf('[[M-NEXT]]')).toBeGreaterThan(md.lastIndexOf('[[B4]]'));
  });

  test('A24 decided questions are selected by the same link rule and shown under Decided with their decision', () => {
    const sel = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    expect(group(sel.shared, 'decidedQuestions').map((it) => [it.id, it.detail])).toEqual([
      ['Q2', 'Settled: she is. Decision: Left-handed.'],
    ]);
    expect(group(sel.shared, 'openQuestions').map((it) => it.id)).toEqual(['Q1', 'Q4']);
    const md = structuredBrief(sel);
    const decided = md.indexOf('### Decided');
    expect(decided).toBeGreaterThan(md.indexOf('## 7. Glossary and open questions'));
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
      { add: ['Z4', 'GL1'], remove: ['E5', 'GL1'] },
    );
    expect(sel.ids).not.toContain('E5');
    expect(sel.ids).not.toContain('GL1');
    expect(sel.ids).toContain('Z4');
    expect(group(sel.shared, 'added').map((it) => [it.id, it.title])).toEqual([['Z4', 'Zhou Jun']]);
    expect(sel.removed).toEqual(['E5', 'GL1']);
    expect(sel.omitted.map((o) => [o.id, o.reason])).toEqual([
      ['E5', 'removed'],
      ['GL1', 'removed'],
    ]);
    expect(structuredBrief(sel)).toContain('## 9. Added by you');
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
    // A year with an event the year after: it sits under Planned ahead only.
    const later = structuredBrief(
      selectForSession(briefData(false), { kind: 'pov', year: 2047, povCharacterId: 'H5' }),
    ).split('\n');
    const ahead = later.findIndex((l) => l.startsWith('## Planned ahead (after 2047)'));
    expect(ahead).toBeGreaterThan(0);
    const e6 = later.findIndex((l) => l.includes('[[E6]]'));
    expect(e6).toBeGreaterThan(ahead);
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

describe('SM-3 the brief reads moments: the voice at that age, and the backstory up to the story year', () => {
  test('SM-3 SB-2 a character carries the latest Voice moment at or before the year, and cites it', () => {
    // Chapter 5 is 2040: Margaret's voice moment is from 2028 (age 70).
    const ch5 = selectForSession(briefData(false), { kind: 'chapter', chapterId: 'CH5' });
    const margaret = group(ch5.strands[0]!.groups, 'characters').find((it) => it.id === 'H1')!;
    expect(margaret.refs).toEqual(['H1-voice-0']);
    expect(margaret.detail).toContain(
      'Voice from 2028: Speaks in short, dry sentences and never raises her voice.',
    );
    expect(ch5.ids).toContain('H1-voice-0');
    // The voice is on the character, not listed again as a moment.
    expect(group(ch5.strands[0]!.groups, 'moments').map((it) => it.id)).not.toContain('H1-voice-0');
  });

  test('SM-3 SB-2 a Voice moment after the year is not how they speak yet', () => {
    // Chapter 6 is 2045; Iris becomes guarded in 2060.
    const ch6 = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    const iris = group(ch6.strands[0]!.groups, 'characters').find((it) => it.id === 'H5')!;
    expect(iris.refs).toEqual([]);
    expect(iris.detail).not.toContain('Guarded');
    expect(ch6.ids).not.toContain('H5-voice-0');
  });

  test('SM-3 SB-2 the moments of the characters present up to the year are their backstory, with ages', () => {
    const ch6 = selectForSession(briefData(true), { kind: 'chapter', chapterId: 'CH6' });
    const moments = group(ch6.strands[0]!.groups, 'moments');
    // Iris (H5) and Daniel (H3) in 2045: Iris finds the letter that year; B5 (2050) is later.
    expect(moments.map((it) => [it.id, it.note])).toEqual([['B4', 'Iris Hale-Zhou, 2045, age 14']]);
    expect(moments[0]!.detail).toBe('Iris finds an envelope in the attic.');
    expect(ch6.ids).not.toContain('B5');
    expect(structuredBrief(ch6)).toContain('## 5. Backstory');
  });
});
