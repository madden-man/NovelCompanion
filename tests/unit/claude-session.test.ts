import { describe, expect, test } from 'vitest';
import {
  briefs,
  briefsInput,
  renderBrief,
  BriefsOutput,
} from '../../src/main/claude/features/briefs';
import type { BriefItem } from '../../src/main/claude/features/briefs';
import { summaries } from '../../src/main/claude/features/summaries';
import { featureSystemPrompt, jsonSchemaFor } from '../../src/main/claude/runtime';
import { MATERIAL_RULE, PROSE_PROHIBITION } from '../../src/main/claude/prompts';
import { selectForSession } from '../../src/shared/domain/brief/selection';
import {
  briefMaterial,
  citationProblems,
  markdownToHtml,
  missingLeadSections,
  uncitedLines,
} from '../../src/shared/domain/brief/render';
import { fromCollections } from '../../src/shared/domain/timeline';
import { briefCollections } from '../helpers/briefFixture';

const model = fromCollections(briefCollections(true) as never);
const sel = selectForSession(model as never, { kind: 'chapter', chapterId: 'CH6' });
const input = briefsInput(sel, briefMaterial(sel));
const item = (text: string, cites: string[], status: 'canon' | 'planned' = 'canon'): BriefItem => ({
  text,
  status,
  strand: null,
  cites,
});
const empty: BriefsOutput = {
  characters: [],
  worldEvents: [],
  culture: [],
  sections: [],
  plannedAhead: [],
};

describe('DB-2 SB-4 SB-5 the brief is laid out by code from Claude structured items', () => {
  test('DB-2 the three lead sections come first and are present even when Claude returns nothing for them', () => {
    const md = renderBrief(
      { ...empty, sections: [{ heading: '9. Beats', items: [item('Iris finds it.', ['B4'])] }] },
      input,
      sel,
    );
    expect(missingLeadSections(md)).toEqual([]);
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual([
      '## 1. Characters and their ages',
      '## 2. World events ongoing',
      '## 3. Cultural expectations',
      '## 4. Beats',
    ]);
    // "Nothing selected." and the app's own opening line are not claims.
    expect(uncitedLines(md)).toEqual([]);
  });

  test('SB-4 every item cites as [[ID]]; an item with no citation and an ID outside the manifest are caught', () => {
    const md = renderBrief(
      {
        ...empty,
        characters: [item('Iris is 14.', ['H5']), item('Iris hates rain.', [])],
        worldEvents: [item('A stray event.', ['Z2'])],
      },
      input,
      sel,
    );
    expect(md).toContain('- Iris is 14. [[H5]]');
    expect(uncitedLines(md)).toEqual(['Iris hates rain.']);
    expect(citationProblems(md, sel.ids)).toEqual(['Z2']);
  });

  test('SB-5 an item is canon only if every entry it cites is canon; an item citing only a planned-ahead entry moves under Planned ahead', () => {
    const md = renderBrief(
      {
        ...empty,
        worldEvents: [
          item('The forties.', ['ERA-2040'], 'canon'),
          item('Robots outnumber cars.', ['E9'], 'canon'),
          item('The king tide.', ['E3'], 'canon'),
        ],
      },
      input,
      sel,
    );
    const lines = md.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(at('Planned or idea:')).toBeLessThan(at('[[ERA-2040]]'));
    expect(at('Canon:')).toBeLessThan(at('[[E3]]'));
    expect(at('[[E3]]')).toBeLessThan(at('Planned or idea:'));
    expect(at('## Planned ahead (after 2045)')).toBeLessThan(at('[[E9]]'));
  });

  test('SB-6 left-out entries are listed by code and never flagged as uncited', () => {
    const removed = selectForSession(
      model as never,
      { kind: 'chapter', chapterId: 'CH6' },
      undefined,
      { remove: ['E5'] },
    );
    const md = renderBrief(empty, briefsInput(removed, briefMaterial(removed)), removed);
    expect(md).toContain('## Left out');
    expect(md).toMatch(
      /- Grid batteries replace the last coal plant in Guangdong \(.*\): removed by you/,
    );
    expect(uncitedLines(md)).toEqual([]);
    expect(markdownToHtml(md, removed.ids, { flagUncited: true })).not.toContain('uncited-flag');
  });

  test('SB-6 A25 the over-budget note gives the lead sections size, not the whole selection size', () => {
    const over = selectForSession(
      model as never,
      { kind: 'chapter', chapterId: 'CH6' },
      { window: 10, budget: 0 },
    );
    expect(over.overBudget).toBe(true);
    const md = renderBrief(empty, briefsInput(over, briefMaterial(over)), over);
    expect(md).toContain(
      `The lead sections alone are ${over.leadSize} characters, over the budget of 0.`,
    );
    expect(over.leadSize).toBeLessThanOrEqual(over.size);
  });

  test('A24 an item citing a decided question moves to a code-written Decided block, apart from the open ones', () => {
    const decided = input.material.find((m) => m.group === 'decidedQuestions')!;
    const open = input.material.find((m) => m.group === 'openQuestions')!;
    const md = renderBrief(
      {
        ...empty,
        sections: [
          {
            heading: 'Open questions',
            items: [
              item('Open: still unsure.', [open.id], 'planned'),
              item('Decided: Iris is left-handed.', [decided.id], 'planned'),
            ],
          },
        ],
      },
      input,
      sel,
    );
    const lines = md.split('\n');
    const at = (t: string) => lines.findIndex((l) => l.includes(t));
    expect(at('### Decided')).toBeGreaterThan(at('Open: still unsure.'));
    expect(at('Decided: Iris is left-handed.')).toBeGreaterThan(at('### Decided'));
    expect(uncitedLines(md)).toEqual([]);
  });

  test('SB-4 a cite that is not one manifest ID, and [[ID]] typed into the text, are flagged as uncited', () => {
    const md = renderBrief(
      {
        ...empty,
        characters: [
          item('Iris and Daniel.', ['H5, H3']),
          item('Iris is 14 [[H5]].', []),
          item('Iris is 14 [[H5]].', ['H5']),
        ],
      },
      input,
      sel,
    );
    expect(md).not.toContain('[[H5, H3]]');
    expect(uncitedLines(md)).toEqual(['Iris and Daniel.', 'Iris is 14 .']);
    expect(md).toContain('- Iris is 14 . [[H5]]');
    expect(BriefsOutput.safeParse({ ...empty, characters: [item('x', ['H5, H3'])] }).success).toBe(
      false,
    );
  });

  test('SB-5 a cited ID with no material, such as a chapter ID, is not canon', () => {
    const md = renderBrief({ ...empty, culture: [item('Chapter six.', ['CH6'])] }, input, sel);
    const lines = md.split('\n');
    expect(lines.findIndex((l) => l === 'Planned or idea:')).toBeLessThan(
      lines.findIndex((l) => l.includes('[[CH6]]')),
    );
    expect(md).not.toContain('Canon:\n- Chapter six.');
  });

  test('SB-4 AI-5 the brief prompt holds the selection material only, wrapped as material', () => {
    const { prompt, given } = briefs.build(input, null as never);
    expect(prompt).toContain('<material source="session selection">');
    expect(prompt).toContain('[H5] Iris Hale-Zhou');
    for (const g of given) expect(sel.ids).toContain(g.id);
    expect(briefs.build(input, null as never).prompt).toBe(prompt);
  });

  test('AI-4 the brief and summary prompts carry the prohibition and the material rule, and their outputs become JSON Schema', () => {
    for (const f of [briefs, summaries]) {
      expect(featureSystemPrompt(f)).toContain(PROSE_PROHIBITION);
      expect(featureSystemPrompt(f)).toContain(MATERIAL_RULE);
    }
    const schema = jsonSchemaFor(briefs.output) as { required: string[] };
    expect(schema.required).toEqual([
      'characters',
      'worldEvents',
      'culture',
      'sections',
      'plannedAhead',
    ]);
    expect(jsonSchemaFor(summaries.output)).toMatchObject({ required: ['summary'] });
  });
});
