import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  STRUCTURAL_CHECKS,
  structuralFindings,
} from '../../src/shared/domain/continuity/structural';
import { fromCollections } from '../../src/shared/domain/timeline';
import {
  locateQuote,
  numberedLines,
  numberedText,
  textHash,
} from '../../src/shared/domain/continuity/lines';
import {
  changeProblem,
  changeSetPatches,
  checkChangeSet,
  describeChangeSet,
} from '../../src/shared/domain/continuity/changeSet';
import { AlignmentOutput, checkAlignment } from '../../src/shared/domain/continuity/alignment';
import {
  dismissalFor,
  fromAlignment,
  fromStructural,
  newFindingData,
  reconcile,
  resolutionCommand,
  stillDismissed,
} from '../../src/shared/domain/continuity/findings';
import type { FreshFinding } from '../../src/shared/domain/continuity/findings';
import { alignmentMaterial } from '../../src/shared/domain/continuity/plot';
import { ALIGNMENT_INSTRUCTIONS } from '../../src/main/claude/features/alignment';
import { Finding } from '../../src/shared/schema';
import type { Doc } from '../../src/shared/domain/paths';
import { briefCollections, briefData } from '../helpers/briefFixture';

const ROOT = join(import.meta.dirname, '../..');

interface Expected {
  findings: {
    id: string;
    check: string;
    chapterId: string;
    strandId: string;
    storyYear: number;
    entryIds: string[];
    explanation: string;
  }[];
  cleanChapterIds: string[];
}
const EXPECTED = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/expected/structural-findings.json'), 'utf8'),
) as Expected;

const shape = (f: {
  check: string;
  chapterId: string | null;
  strandId: string | null;
  storyYear: number | null;
  entryIds: string[];
}) => ({
  check: f.check,
  chapterId: f.chapterId,
  strandId: f.strandId,
  storyYear: f.storyYear,
  entryIds: f.entryIds,
});

describe('CC-2 CC-5 structural checks against the fixture novel', () => {
  for (const withSupplement of [false, true]) {
    const label = withSupplement ? 'with the M7 supplement' : 'as in section 7';
    test(`CC-5 the whole manuscript yields exactly S1 and S3 from the expected file (${label})`, () => {
      const found = structuralFindings(briefData(withSupplement));
      expect(found.map(shape)).toEqual(EXPECTED.findings.map(shape));
    });

    test(`CC-5 every clean chapter yields no structural finding when checked alone (${label})`, () => {
      const data = briefData(withSupplement);
      for (const id of EXPECTED.cleanChapterIds) {
        expect(structuralFindings(data, { chapterId: id }), id).toEqual([]);
      }
    });
  }

  test('CC-2 each finding cites both sides in plain words: the chapter, its year, the entry, and the year it conflicts with', () => {
    const found = structuralFindings(briefData(false));
    for (const exp of EXPECTED.findings) {
      const f = found.find((x) => x.chapterId === exp.chapterId && x.check === exp.check)!;
      expect(f, exp.id).toBeDefined();
      for (const id of exp.entryIds) expect(f.explanation).toContain(id);
      expect(f.explanation).toContain(
        `Chapter ${exp.chapterId.slice(2)} is set in ${exp.storyYear}`,
      );
      // The year on the other side, as the expected explanation gives it.
      const otherYear = exp.explanation.match(/(\d{4})\.$/)![1]!;
      expect(f.explanation).toContain(otherYear);
    }
  });

  test('CC-2 one chapter alone gives only that chapter: Chapter 6 yields S3', () => {
    const found = structuralFindings(briefData(false), { chapterId: 'CH6' });
    expect(found.map((f) => f.check)).toEqual(['event-linked-as-happened-after-story-year']);
  });

  test('CC-2 SM-2 the facts step is gone: a check list without facts, and no finding about one', () => {
    const found = structuralFindings(briefData(true));
    expect(found.some((f) => f.check === ('fact-acted-on-before-learned' as never))).toBe(false);
    expect(STRUCTURAL_CHECKS).toEqual([
      'character-present-while-dead',
      'character-present-while-unborn',
      'event-linked-as-happened-after-story-year',
      'strand-year-outside-pov-lifetime',
      'tree-warning',
    ]);
  });

  test('CC-2 keys are stable across runs and differ between findings', () => {
    const a = structuralFindings(briefData(false)).map((f) => f.key);
    const b = structuralFindings(briefData(false)).map((f) => f.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a[0]).toBe('structural:character-present-while-dead:CH4:CH4-present:H2');
  });

  test('CC-2 an unborn character present, a point of view outside their lifetime, a backstory strand, and the FT-6 tree warnings', () => {
    const c = briefCollections(false);
    const ch2 = c.chapters!.find((x) => x._id === 'CH2')!;
    const strands = ch2.strands as Record<string, unknown>[];
    // Backstory strand 2032: Noor (born 2058) present, and Peter (died 2030) telling it.
    strands[1] = { ...strands[1], characterIds: ['Z3', 'Z5'], povCharacterId: 'H2' };
    // A biological parent link that makes Margaret a mother at 80: an FT-6 warning.
    c.parentLinks = [
      ...(c.parentLinks ?? []),
      {
        _id: 'PL-LATE',
        title: 'Late child',
        status: 'idea',
        parentId: 'H1',
        childId: 'Z5',
        type: 'biological',
        startYear: null,
        createdAt: '2026-01-15T09:00:00.000Z',
        modifiedAt: '2026-01-15T09:00:00.000Z',
      },
    ];
    const found = structuralFindings(fromCollections(c));
    const ch2Found = found.filter((f) => f.chapterId === 'CH2');
    expect(ch2Found.map((f) => [f.check, f.strandId, f.entryIds])).toEqual([
      ['character-present-while-unborn', 'CH2-backstory', ['Z5']],
      ['strand-year-outside-pov-lifetime', 'CH2-backstory', ['H2']],
    ]);
    expect(ch2Found[0]!.explanation).toBe(
      "Chapter 2's backstory strand is set in 2032 and lists Noor Zhou (Z5) as present. Noor Zhou is born in 2058.",
    );
    const tree = found.filter((f) => f.check === 'tree-warning');
    expect(tree.length).toBeGreaterThan(0);
    expect(tree.every((f) => f.chapterId === null && f.entryIds.includes('PL-LATE'))).toBe(true);
    // One chapter alone never carries tree warnings: they belong to no chapter.
    expect(structuralFindings(fromCollections(c), { chapterId: 'CH2' })).toHaveLength(2);
  });

  test('CC-2 TL-4 a character in the year they die is alive, so present is fine; a year range counts while they are alive in it', () => {
    const c = briefCollections(false);
    const ch4 = c.chapters!.find((x) => x._id === 'CH4')!;
    // Peter dies in 2030: a 2030 strand is fine, and so is a 2028 to 2034 range.
    for (const [startYear, endYear] of [
      [2030, null],
      [2028, 2034],
    ]) {
      ch4.strands = [{ ...(ch4.strands as Record<string, unknown>[])[0], startYear, endYear }];
      expect(structuralFindings(fromCollections(c), { chapterId: 'CH4' })).toEqual([]);
    }
  });
});

const STAMP = '2026-01-15T09:00:00.000Z';

describe('CC-3 line numbering', () => {
  test('CC-3 one paragraph per line from 1, a scene break is its own line, and the same text always numbers the same', () => {
    const ch2 = briefCollections(false).chapters!.find((c) => c._id === 'CH2')!;
    const lines = numberedLines(ch2.manuscriptText);
    expect(lines).toEqual([
      { n: 1, text: 'Daniel burned the rice again while Iris did her homework at the counter.' },
      { n: 2, text: '* * *' },
      {
        n: 3,
        text: 'Thirteen years earlier, Meiling held the baby and sang the song her own mother had sung.',
      },
    ]);
    expect(numberedLines(ch2.manuscriptText)).toEqual(lines);
    // Markup that does not change the paragraphs does not move a line.
    expect(
      numberedLines(String(ch2.manuscriptText).replace('<p>Daniel', '<p> <em>Daniel</em>')),
    ).toEqual(lines);
    expect(numberedText(lines).split('\n')[2]).toBe(
      '3: Thirteen years earlier, Meiling held the baby and sang the song her own mother had sung.',
    );
  });

  test('CC-3 a quote is found on its lines ignoring case, spacing, and curly quotes, and across an ellipsis', () => {
    const lines = numberedLines(
      '<p>One line here.</p><p>Lan said “it rained” sideways.</p><p>Then it stopped.</p>',
    );
    expect(locateQuote(lines, 'lan said "it RAINED"')).toEqual({ start: 2, end: 2 });
    expect(locateQuote(lines, 'it rained ... Then it')).toEqual({ start: 2, end: 3 });
    expect(locateQuote(lines, 'not in the text')).toBeNull();
  });
});

describe('CC-3 change set checks', () => {
  const data = () => briefData(true);
  test('CC-3 a change to a real field with a value that fits passes; each wrong one is refused with a plain reason', () => {
    const d = data();
    const ok = (collection: string, id: string, field: string, value: unknown) =>
      changeProblem(d, { collection, id, field, value });
    expect(ok('characters', 'H1', 'birth', { year: 1970 })).toBeNull();
    expect(ok('characters', 'Z3', 'backstory', 'Raised in Shanghai.')).toBeNull();
    expect(ok('moments', 'B4', 'year', 2046)).toBeNull();
    expect(ok('chapters', 'CH4', 'strands.CH4-present.startYear', 2029)).toBeNull();
    expect(ok('characters', 'H9', 'birth', { year: 1970 })).toBe('there is no characters entry H9');
    expect(ok('characters', 'H1', 'hometown', 'x')).toBe('hometown is not a field of characters');
    expect(ok('characters', 'H1', 'birth', 'seventy')).toMatch(/^the value does not fit the field/);
    expect(ok('chapters', 'CH5', 'manuscriptText', 'x')).toBe(
      'manuscriptText is not a field a change set may write',
    );
    expect(ok('chapters', 'CH4', 'strands.CH9-x.startYear', 2029)).toBe(
      'the chapter has no strand CH9-x',
    );
    expect(ok('moments', 'B4', 'characterId', 'CH99')).toBe(
      'it points to CH99, which is not in the bible',
    );
    // SM-2: a dropped section is not a part of the bible any more.
    expect(ok('plotBeats', 'B4', 'year', 2046)).toBe(
      'plotBeats is not a part of the bible a change set may write',
    );
    expect(ok('findings', 'X', 'text', 'x')).toBe(
      'findings is not a part of the bible a change set may write',
    );
    expect(ok('characters', 'H1', 'birth', { year: 1958 })).toBe(
      'the bible already holds this value',
    );
  });

  test('CC-3 values arrive as JSON text; changes to one entry compose into one patch; the diff shows before and after', () => {
    const d = data();
    const { valid, rejected } = checkChangeSet(d, [
      {
        collection: 'chapters',
        id: 'CH2',
        field: 'strands.CH2-backstory.startYear',
        value: '2033',
      },
      { collection: 'chapters', id: 'CH2', field: 'strands.CH2-present.startYear', value: '2046' },
      { collection: 'moments', id: 'Z3-lives-0', field: 'title', value: '"Lives in Shanghai"' },
      { collection: 'characters', id: 'Z3', field: 'nickname', value: '"Lan"' },
    ]);
    expect(valid.map((v) => v.value)).toEqual([2033, 2046, 'Lives in Shanghai']);
    expect(rejected).toEqual([
      { summary: 'characters Z3 nickname: "Lan"', reason: 'nickname is not a field of characters' },
    ]);
    const patches = changeSetPatches(d, valid);
    expect(patches.map((p) => [p.collection, p.id, Object.keys(p.patch)])).toEqual([
      ['chapters', 'CH2', ['strands']],
      ['moments', 'Z3-lives-0', ['title']],
    ]);
    expect((patches[0]!.patch.strands as { startYear: number }[]).map((s) => s.startYear)).toEqual([
      2046, 2033,
    ]);
    expect(describeChangeSet(d, valid).map((r) => [r.entry, r.label, r.before, r.after])).toEqual([
      ['Two Kitchens', 'backstory strand: Story year', '2032', '2033'],
      ['Two Kitchens', 'present strand: Story year', '2045', '2046'],
      ['Lives in Guangzhou', 'What happens', 'Lives in Guangzhou', 'Lives in Shanghai'],
    ]);
  });
});

describe('CC-3 checking what Claude returns', () => {
  const lines = numberedLines(
    '<p>Ruth counted the candles twice. Her mother was seventy and still refused to let anyone else light them.</p><p>Sam held the matches and waited.</p>',
  );
  const base = {
    kind: 'age' as const,
    lineStart: 1,
    lineEnd: 1,
    quote: 'Her mother was seventy',
    citedIds: ['H1'],
    explanation: 'Margaret is 82.',
    mustChange: 'Her stated age must be 82.',
    changeSet: [],
  };
  test('CC-3 every cited ID must exist, lines must be in the chapter, and a quote found elsewhere moves the line numbers', () => {
    const out = AlignmentOutput.parse({
      findings: [
        base,
        { ...base, citedIds: ['H1', 'NOPE'] },
        { ...base, citedIds: [] },
        { ...base, lineStart: 2, lineEnd: 2 },
        { ...base, lineStart: 9, lineEnd: 9, quote: 'Sam held the matches' },
        { ...base, lineStart: 9, lineEnd: 12, quote: 'nothing like this' },
      ],
    });
    const r = checkAlignment(out, { chapterId: 'CH5', lines, data: briefData(false) });
    expect(r.findings.map((f) => [f.lineStart, f.lineEnd, f.key])).toEqual([
      [1, 1, 'alignment:CH5:age:H1'],
      [1, 1, 'alignment:CH5:age:H1#2'],
      [2, 2, 'alignment:CH5:age:H1#3'],
    ]);
    expect(r.findings[0]!.quote).toBe(lines[0]!.text);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'It cites NOPE, which is not in the bible.',
      'It cites no entry or beat.',
      'Its lines 9 to 12 are not in the chapter, which has 2 lines, and its quote is not in the text.',
    ]);
  });

  test('CC-3 a finding whose lines are in range but whose quote is nowhere in the chapter is refused, not stored with those lines', () => {
    const out = AlignmentOutput.parse({
      findings: [{ ...base, lineStart: 1, lineEnd: 2, quote: 'the moon was green' }],
    });
    const r = checkAlignment(out, { chapterId: 'CH5', lines, data: briefData(false) });
    expect(r.findings).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'Its quote is not in the chapter text, so lines 1 to 2 cannot be trusted.',
    ]);
  });

  test('CC-3 AI-4 an explanation or a what-must-change over 300 characters fails the output schema', () => {
    const long = 'x'.repeat(301);
    expect(AlignmentOutput.safeParse({ findings: [{ ...base, explanation: long }] }).success).toBe(
      false,
    );
    expect(AlignmentOutput.safeParse({ findings: [{ ...base, mustChange: long }] }).success).toBe(
      false,
    );
    expect(
      AlignmentOutput.safeParse({ findings: [{ ...base, mustChange: 'x'.repeat(300) }] }).success,
    ).toBe(true);
  });

  test('CC-3 a citation of a collection a change set cannot write (a finding, a brief) is refused', () => {
    const data = briefData(false);
    const withFinding = {
      ...data,
      all: (c: string) => (c === 'findings' ? [{ _id: 'FND1', title: 'f' }] : data.all(c)),
    } as typeof data;
    const out = AlignmentOutput.parse({ findings: [{ ...base, citedIds: ['FND1'] }] });
    const r = checkAlignment(out, { chapterId: 'CH5', lines, data: withFinding });
    expect(r.findings).toEqual([]);
    expect(r.rejected[0]!.reason).toBe('It cites FND1, which is not part of the story bible.');
  });

  test('CC-3 AI-4 the output and the stored finding have no field for suggested text, and the instructions forbid replacement text', () => {
    const suggested = /suggest|replacement|rewritten|prose|draft|newText|revised/i;
    const props = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema, { io: 'output' }));
    const keys = (json: string) => [...json.matchAll(/"([A-Za-z]+)":\{/g)].map((m) => m[1]!);
    expect(keys(props(AlignmentOutput)).filter((k) => suggested.test(k))).toEqual([]);
    expect(Object.keys(Finding.shape).filter((k) => suggested.test(k))).toEqual([]);
    expect(ALIGNMENT_INSTRUCTIONS).toMatch(
      /describing the change without writing any replacement text/,
    );
    expect(ALIGNMENT_INSTRUCTIONS).toMatch(/material tags/);
  });

  test('CC-3 the material is deterministic: numbered lines, the plot as stored, and the selection', () => {
    const a = alignmentMaterial(briefData(true), 'CH6');
    expect(alignmentMaterial(briefData(true), 'CH6')).toEqual(a);
    expect(a.heading).toBe('Chapter 6: The Letter [CH6]');
    expect(a.storyYear).toBe(2045);
    // A39: no beats, arcs, or facts in play; the moments come with the selected entries.
    expect(a.plot).not.toMatch(/Beats|Facts in play/);
    expect(a.plot).toContain('8. Noor [CH8], 2085');
    expect(a.entries).toContain('[B4] Iris finds the letter (moments; planned)');
    expect(a.given.map((g) => g.id)).toEqual(expect.arrayContaining(['CH6', 'B4', 'H5', 'E3']));
    expect(() => alignmentMaterial(briefData(true), 'CH99')).toThrow(
      'That chapter is not in the bible.',
    );
  });
});

describe('CC-4 dismissals and re-runs', () => {
  const finding = (over: Doc = {}): Doc => ({
    _id: 'F-1',
    title: 't',
    status: 'planned',
    kind: 'alignment',
    chapterId: 'CH5',
    entryIds: ['H1'],
    key: 'alignment:CH5:age:H1',
    state: 'dismissed',
    createdAt: STAMP,
    modifiedAt: STAMP,
    ...over,
  });

  test('CC-4 a dismissal holds a hash of the chapter text and of each cited entry revision; either change lifts it', () => {
    const c = briefCollections(false);
    const data = fromCollections(c);
    const d = dismissalFor(data, { kind: 'alignment', chapterId: 'CH5', entryIds: ['H1'] });
    expect(d.textHash).toBe(
      textHash(String(c.chapters!.find((x) => x._id === 'CH5')!.manuscriptText)),
    );
    expect(stillDismissed(finding({ dismissal: d }), data)).toBe(true);
    // The chapter summary is not the text: editing it keeps the dismissal.
    const ch5 = c.chapters!.find((x) => x._id === 'CH5')!;
    ch5.summary = 'A new summary.';
    expect(stillDismissed(finding({ dismissal: d }), fromCollections(c))).toBe(true);
    ch5.manuscriptText = String(ch5.manuscriptText).replace('twice', 'three times');
    expect(stillDismissed(finding({ dismissal: d }), fromCollections(c))).toBe(false);
    const c2 = briefCollections(false);
    c2.characters!.find((x) => x._id === 'H1')!.modifiedAt = '2026-02-01T00:00:00.000Z';
    expect(stillDismissed(finding({ dismissal: d }), fromCollections(c2))).toBe(false);
    expect(stillDismissed(finding({ dismissal: null }), data)).toBe(false);
  });

  test('CC-4 a structural dismissal is held against the chapter plot fields, not its text', () => {
    const c = briefCollections(false);
    const d = dismissalFor(fromCollections(c), {
      kind: 'structural',
      chapterId: 'CH4',
      entryIds: ['H2'],
    });
    const ch4 = c.chapters!.find((x) => x._id === 'CH4')!;
    ch4.manuscriptText = '<p>Changed.</p>';
    const f = finding({ kind: 'structural', chapterId: 'CH4', entryIds: ['H2'], dismissal: d });
    expect(stillDismissed(f, fromCollections(c))).toBe(true);
    ch4.strands = [{ ...(ch4.strands as Doc[])[0], characterIds: ['H1', 'H2'] }];
    expect(stillDismissed(f, fromCollections(c))).toBe(false);
  });

  test('CC-4 a re-run creates new keys, refreshes open ones, keeps rewrite tasks, hides unchanged dismissals, reopens changed ones and applied ones, and trashes open ones no longer found', () => {
    // A third planted error (S2 went with the facts, A39): Noor (born 2058) in Chapter 3 (2029).
    const cols = briefCollections(false);
    const ch3 = cols.chapters!.find((x) => x._id === 'CH3')!;
    ch3.strands = (ch3.strands as Doc[]).map((st) => ({
      ...st,
      characterIds: [...(st.characterIds as string[]), 'Z5'],
    }));
    const data = fromCollections(cols);
    const fresh = structuralFindings(data).map(fromStructural);
    const [s2, s1, s3] = fresh;
    const dis = dismissalFor(data, s2!);
    const stored: Doc[] = [
      finding({ _id: 'A', kind: 'structural', key: s1!.key, state: 'open', text: 'old words' }),
      finding({
        _id: 'B',
        kind: 'structural',
        key: s2!.key,
        state: 'dismissed',
        dismissal: dis,
        ...{ chapterId: s2!.chapterId, entryIds: s2!.entryIds },
      }),
      finding({ _id: 'C', kind: 'structural', key: s3!.key, state: 'rewrite' }),
      finding({
        _id: 'D',
        kind: 'structural',
        key: 'structural:gone:CH1:-:H1',
        chapterId: 'CH1',
        state: 'open',
      }),
      finding({
        _id: 'E',
        kind: 'structural',
        key: 'structural:gone:CH2:-:H1',
        chapterId: 'CH2',
        state: 'dismissed',
      }),
    ];
    const plan = reconcile(stored, fresh, (f) => f.kind === 'structural', data);
    expect(plan.creates).toEqual([]);
    expect(plan.hidden).toBe(1);
    expect(plan.updates.map((u) => u.id)).toEqual(['A']);
    expect(plan.updates[0]!.patch.text).toBe(s1!.text);
    expect(plan.trash).toEqual(['D']);

    const changed = reconcile(
      [
        finding({
          _id: 'B',
          kind: 'structural',
          key: s2!.key,
          state: 'dismissed',
          dismissal: { textHash: 'x', entryHash: 'y' },
        }),
        finding({ _id: 'W', kind: 'structural', key: s1!.key, state: 'manuscriptWins' }),
      ],
      fresh,
      () => true,
      data,
    );
    // In the order the run found them: Chapter 3 (B) before Chapter 4 (W).
    expect(changed.updates.map((u) => [u.id, u.patch.state])).toEqual([
      ['B', 'open'],
      ['W', 'open'],
    ]);
    expect(changed.creates.map((c) => c.key)).toEqual([s3!.key]);
    expect(changed.creates[0]).toMatchObject({
      state: 'open',
      kind: 'structural',
      chapterId: 'CH6',
    });
  });

  test('CC-4 a dismissed alignment finding is found again under a different key (another cited set or order): it stays hidden, and a changed text reopens it', () => {
    const data = briefData(false);
    const quote = 'Her mother was seventy and still refused to let anyone else light them.';
    const dis = dismissalFor(data, { kind: 'alignment', chapterId: 'CH5', entryIds: ['H1'] });
    const stored = [finding({ check: 'age', quote, dismissal: dis, key: 'alignment:CH5:age:H1' })];
    const fresh = (over: Partial<FreshFinding> = {}): FreshFinding => ({
      ...fromAlignment(
        {
          key: 'alignment:CH5:age:H1+H2',
          check: 'age',
          chapterId: 'CH5',
          title: 't',
          text: 't',
          quote,
          lineStart: 1,
          lineEnd: 1,
          entryIds: ['H1', 'H2'],
          mustChange: '',
          changeSet: [],
          rejectedChanges: [],
        },
        { storyYear: 2040, runId: 'r' },
      ),
      ...over,
    });
    const plan = reconcile(stored, [fresh()], (f) => f.kind === 'alignment', data);
    expect(plan.creates).toEqual([]);
    expect(plan.hidden).toBe(1);
    // A different quoted passage is a new finding.
    const other = reconcile(stored, [fresh({ quote: 'Sam held the matches.' })], () => true, data);
    expect(other.creates).toHaveLength(1);
    // The same quote on changed text reopens the stored one.
    const moved = reconcile(
      [finding({ check: 'age', quote, dismissal: { textHash: 'x', entryHash: 'y' } })],
      [fresh()],
      () => true,
      data,
    );
    expect(moved.creates).toEqual([]);
    expect(moved.updates.map((u) => [u.id, u.patch.state])).toEqual([['F-1', 'open']]);
  });

  test('IP-7 ED-7 a re-run keeps a hand-edited finding and records what the check now says', () => {
    const data = briefData(false);
    const run = (text: string, mustChange = 'Make her 82.'): FreshFinding =>
      fromAlignment(
        {
          key: 'alignment:CH5:age:H1',
          check: 'age',
          chapterId: 'CH5',
          title: 't',
          text,
          quote: 'Her mother was seventy.',
          lineStart: 1,
          lineEnd: 1,
          entryIds: ['H1'],
          mustChange,
          changeSet: [],
          rejectedChanges: [],
        },
        { storyYear: 2040, runId: 'r2' },
      );
    const first = run('Margaret is 82, not seventy.');
    const created = newFindingData(first);
    // A new finding remembers its own words.
    expect(created).toMatchObject({
      generated: {
        text: 'Margaret is 82, not seventy.',
        quote: 'Her mother was seventy.',
        mustChange: 'Make her 82.',
      },
      proposed: null,
    });
    // It parses, and a finding stored before the field existed parses too.
    expect(Finding.parse({ ...finding({ state: 'open' }), ...created }).generated).not.toBeNull();
    expect(Finding.parse(finding()).generated).toBeNull();
    expect(Finding.parse(finding()).proposed).toBeNull();

    const stored = (over: Doc) =>
      finding({ ...created, _id: 'F-1', state: 'open', key: first.key, ...over });

    // Untouched: the re-run updates it as before.
    const plain = reconcile([stored({})], [run('Margaret is 82 in 2040.')], () => true, data);
    expect(plain.updates).toEqual([
      {
        id: 'F-1',
        patch: {
          text: 'Margaret is 82 in 2040.',
          generated: { ...(created.generated as Doc), text: 'Margaret is 82 in 2040.' },
        },
      },
    ]);

    // Hand-edited text: the edit stays, the new wording is proposed; the untouched field updates.
    const edited = stored({ text: 'Ruth rounds her mother down.' });
    const plan = reconcile(
      [edited],
      [run('Margaret is 82 in 2040.', 'Make her eighty-two.')],
      () => true,
      data,
    );
    const patch = plan.updates[0]!.patch;
    expect(patch).not.toHaveProperty('text');
    expect(patch.mustChange).toBe('Make her eighty-two.');
    expect(patch.proposed).toEqual({ text: 'Margaret is 82 in 2040.' });
    expect(patch.generated).toEqual({
      text: 'Margaret is 82 in 2040.',
      quote: 'Her mother was seventy.',
      mustChange: 'Make her eighty-two.',
    });

    // The same words again: the proposal stays pending and nothing else changes.
    const after = { ...edited, ...patch };
    const again = reconcile(
      [after],
      [run('Margaret is 82 in 2040.', 'Make her eighty-two.')],
      () => true,
      data,
    );
    expect(again.updates).toEqual([]);

    // A run that says what the writer wrote clears the proposal.
    const agreed = reconcile(
      [after],
      [run('Ruth rounds her mother down.', 'Make her eighty-two.')],
      () => true,
      data,
    );
    expect(agreed.updates[0]!.patch).toMatchObject({ proposed: null });
    expect(agreed.updates[0]!.patch).not.toHaveProperty('text');

    // An edit that matches the last run's words exactly is no edit: the run's words win.
    const repeated = reconcile([stored({})], [run(first.text)], () => true, data);
    expect(repeated.updates).toEqual([]);
  });

  test('CC-4 ED-3 a resolution undoes as one step: every changed entry and the finding state, editable fields only', () => {
    const cmd = resolutionCommand('Manuscript wins', [
      {
        collection: 'characters',
        id: 'H1',
        before: { _id: 'H1', birth: { year: 1958 }, modifiedAt: 'a' },
        after: { _id: 'H1', birth: { year: 1970 }, modifiedAt: 'b' },
      },
      {
        collection: 'findings',
        id: 'F',
        before: { _id: 'F', state: 'open', dismissal: null },
        after: { _id: 'F', state: 'dismissed', dismissal: { textHash: 'x', entryHash: 'y' } },
      },
    ]);
    expect(cmd.undo).toEqual([
      {
        kind: 'update',
        collection: 'findings',
        id: 'F',
        patch: { state: 'open' },
        expect: { state: 'dismissed' },
      },
      {
        kind: 'update',
        collection: 'characters',
        id: 'H1',
        patch: { birth: { year: 1958 } },
        expect: { birth: { year: 1970 } },
      },
    ]);
    expect(cmd.redo.map((o) => (o.kind === 'update' ? o.patch : null))).toEqual([
      { birth: { year: 1970 } },
      { state: 'dismissed' },
    ]);
  });
});
