import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { structuralFindings } from '../../src/shared/domain/continuity/structural';
import { fromCollections } from '../../src/shared/domain/timeline';
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
    test(`CC-5 the whole manuscript yields exactly S1, S2, S3 from the expected file (${label})`, () => {
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

  test('CC-2 one chapter alone gives only that chapter: Chapter 6 yields S2 and S3', () => {
    const found = structuralFindings(briefData(false), { chapterId: 'CH6' });
    expect(found.map((f) => f.check)).toEqual([
      'fact-acted-on-before-learned',
      'event-linked-as-happened-after-story-year',
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
