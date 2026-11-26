import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildIndex } from '../../src/shared/domain/captureRouter';
import type { RouterIndexInput } from '../../src/shared/domain/captureRouter';
import {
  NO_MARKS,
  YEAR_ASK,
  factKey,
  lineKey,
  localDay,
  offeredPages,
  trayGroups,
  withMarks,
} from '../../src/shared/domain/tray';
import type { OfferedPage } from '../../src/shared/domain/tray';
import type { NotebookLine, NotebookPage } from '../../src/shared/schema';

const slice = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/capture/eastwinds-slice.json'), 'utf8'),
) as RouterIndexInput;
const index = buildIndex(slice);

const L = (id: string, text: string, extra: Partial<NotebookLine> = {}): NotebookLine => ({
  id,
  voice: 'ink',
  speakerId: null,
  paper: null,
  text,
  wise: false,
  kept: false,
  at: '2026-11-25T21:00:00.000Z',
  ...extra,
});

const page = (o: Partial<NotebookPage> & Pick<NotebookPage, '_id' | 'kind'>): NotebookPage => ({
  world: 'eastwinds',
  reading: null,
  title: '',
  date: '2026-11-25T21:00:00.000Z',
  year: 2066,
  lines: [],
  chips: { characterIds: [], placeIds: [] },
  research: null,
  questionId: null,
  characterIds: [],
  placeIds: [],
  chapterIds: [],
  years: [],
  sig: 's',
  createdAt: '2026-11-25T21:00:00.000Z',
  modifiedAt: '2026-11-25T21:00:00.000Z',
  ...o,
});

const MOVE = 'Mark moves to Seattle in 2061 for a job at a Compact logistics firm';
const MOVE_NO_YEAR = 'Mark moves to Seattle for a job at a Compact logistics firm';

describe('FN-1 what the tray offers', () => {
  test('FN-1 kept lines and councils about the story are offered; in-story councils, threads, research, papers, other voices and trashed pages are not', () => {
    const pages = [
      page({ _id: 'K1', kind: 'kept', lines: [L('K1', MOVE, { kept: true })] }),
      page({
        _id: 'C-about',
        kind: 'council',
        reading: 'about',
        title: 'Where does Mark go?',
        lines: [
          L('a1', 'He goes north.'),
          L('a2', 'I go to Seattle.', { voice: 'character', speakerId: 'mark' }),
          L('a3', 'A paper says so.', { voice: 'other', paper: { side: 'for' } }),
          L('a4', 'Another voice.', { voice: 'other' }),
          L('a5', '   '),
        ],
      }),
      page({ _id: 'C-in', kind: 'council', reading: 'in', lines: [L('i1', MOVE)] }),
      page({ _id: 'T1', kind: 'thread', lines: [L('t1', MOVE)] }),
      page({
        _id: 'R1',
        kind: 'research',
        lines: [],
        research: { question: MOVE, papers: [] },
      }),
      page({
        _id: 'K2',
        kind: 'kept',
        lines: [L('K2', MOVE)],
        deletedAt: '2026-11-26T00:00:00.000Z',
      }),
    ];
    const offered = offeredPages(pages);
    expect(offered.map((p) => p.id)).toEqual(['K1', 'C-about']);
    expect(offered[1]?.lines.map((l) => l.id)).toEqual(['a1', 'a2']);
  });

  test('FN-1 each fact is a card routed as the capture box routes it, kept lines grouped by day and each council its own group, newest first', () => {
    const pages: OfferedPage[] = [
      {
        id: 'K1',
        kind: 'kept',
        title: '',
        date: '2026-11-24T10:00:00.000Z',
        year: 2066,
        lines: [{ id: 'K1', text: MOVE, speakerId: null }],
      },
      {
        id: 'K2',
        kind: 'kept',
        title: '',
        date: '2026-11-24T18:00:00.000Z',
        year: 2066,
        lines: [
          {
            id: 'K2',
            text: 'Should Frank’s church split over the Compact in 2075?',
            speakerId: null,
          },
        ],
      },
      {
        id: 'C1',
        kind: 'council',
        title: 'Where does Mark go?',
        date: '2026-11-25T09:00:00.000Z',
        year: 2061,
        lines: [
          {
            id: 'c1',
            text: 'Chinese people in San Francisco begin to say yee haw ironically starting around 2065',
            speakerId: null,
          },
        ],
      },
    ];
    const groups = trayGroups(pages, index, { storyYear: 2066 });
    expect(groups.map((g) => [g.id, g.kind, g.title])).toEqual([
      ['council:C1', 'council', 'Where does Mark go?'],
      ['day:2026-11-24', 'day', ''],
    ]);
    const day = groups[1]!;
    expect(day.items.map((i) => i.pageId)).toEqual(['K2', 'K1']);
    const move = day.items.find((i) => i.pageId === 'K1')!;
    expect(move.fact.route).toBe('local');
    expect(move.fact.section).toBe('moments');
    expect(move.fact.years.start).toBe(2061);
    expect(move.key).toBe(factKey('K1', MOVE, 0));
    expect(move.needsYear).toBe(false);
    expect(groups[0]!.items[0]!.fact.section).toBe('culturalEntries');
  });
});

describe('FN-2 years', () => {
  test('FN-2 a number is the year the line is read in', () => {
    const [g] = trayGroups(
      [
        {
          id: 'K',
          kind: 'kept',
          title: '',
          date: '2026-11-25T00:00:00Z',
          year: 2071,
          lines: [{ id: 'K', text: MOVE_NO_YEAR, speakerId: null }],
        },
      ],
      index,
      { storyYear: 2050 },
    );
    expect(g!.items[0]!.fact.years.start).toBe(2071);
    expect(g!.items[0]!.needsYear).toBe(false);
  });

  test('FN-2 the whole book or no year known: a draft that needs a year asks for it with the Year chip, and a year in the words needs none', () => {
    for (const year of [null, undefined]) {
      const p: OfferedPage = {
        id: 'K',
        kind: 'kept',
        title: '',
        date: '2026-11-25T00:00:00Z',
        ...(year === undefined ? {} : { year }),
        lines: [{ id: 'K', text: MOVE_NO_YEAR, speakerId: null }],
      };
      const [g] = trayGroups([p], index, { storyYear: 2050 });
      const item = g!.items[0]!;
      expect(item.needsYear).toBe(true);
      expect(item.fact.asks).toContain(YEAR_ASK);
      const withYear = trayGroups(
        [{ ...p, lines: [{ id: 'K', text: MOVE, speakerId: null }] }],
        index,
        { storyYear: 2050 },
      );
      expect(withYear[0]!.items[0]!.needsYear).toBe(false);
      // Picking the year answers the ask.
      const picked = trayGroups([p], index, {
        storyYear: 2050,
        hints: { [item.key]: { startYear: 2072 } },
      });
      expect(picked[0]!.items[0]!.needsYear).toBe(false);
      expect(picked[0]!.items[0]!.fact.years.start).toBe(2072);
    }
  });
});

describe('FN-4 FN-5 keys and marks', () => {
  const p = (text: string): OfferedPage => ({
    id: 'K',
    kind: 'kept',
    title: '',
    date: '2026-11-25T00:00:00Z',
    year: 2066,
    lines: [{ id: 'K', text, speakerId: null }],
  });

  test('FN-4 a dismissed fact is not offered while the line is unchanged; an edited line is offered again', () => {
    const [g] = trayGroups([p(MOVE)], index, { storyYear: 2066 });
    const key = g!.items[0]!.key;
    const marks = withMarks(NO_MARKS, [key], 'dismissed');
    expect(trayGroups([p(MOVE)], index, { storyYear: 2066, marks })).toEqual([]);
    const edited = trayGroups([p(`${MOVE}.`.replace('2061', '2062'))], index, {
      storyYear: 2066,
      marks,
    });
    expect(edited[0]!.items).toHaveLength(1);
    expect(edited[0]!.items[0]!.key).not.toBe(key);
    expect(lineKey('K', MOVE)).not.toBe(lineKey('K', `${MOVE} `));
  });

  test('FN-4 FN-3 a key holds one mark; filed and sent leave the tray too, and clearing a mark offers it again', () => {
    const [g] = trayGroups([p(MOVE)], index, { storyYear: 2066 });
    const key = g!.items[0]!.key;
    let marks = withMarks(NO_MARKS, [key, key], 'filed');
    expect(marks).toEqual({ dismissed: [], filed: [key], sent: [] });
    expect(trayGroups([p(MOVE)], index, { storyYear: 2066, marks })).toEqual([]);
    marks = withMarks(marks, [key], 'sent');
    expect(marks).toEqual({ dismissed: [], filed: [], sent: [key] });
    expect(trayGroups([p(MOVE)], index, { storyYear: 2066, marks })).toEqual([]);
    marks = withMarks(marks, [key], null);
    expect(trayGroups([p(MOVE)], index, { storyYear: 2066, marks })[0]!.items).toHaveLength(1);
  });

  test('FN-5 the cards follow the line as it is now, and a page in the trash takes its facts with it', () => {
    const before = trayGroups([p(MOVE)], index, { storyYear: 2066 });
    const after = trayGroups(
      [p('Mark moves to Portland in 2063 for a job at a Compact logistics firm')],
      index,
      { storyYear: 2066 },
    );
    expect(before[0]!.items[0]!.fact.drafts).not.toEqual(after[0]!.items[0]!.fact.drafts);
    expect(after[0]!.items[0]!.fact.years.start).toBe(2063);
    const trashed = offeredPages([
      page({
        _id: 'K',
        kind: 'kept',
        lines: [L('K', MOVE)],
        deletedAt: '2026-11-26T00:00:00.000Z',
      }),
    ]);
    expect(trayGroups(trashed, index, { storyYear: 2066 })).toEqual([]);
  });
});

describe('FN-1 days are the local days the headings show', () => {
  test('FN-1 a line kept before 09:00 in Japan groups with that day, not the UTC day before', () => {
    const at = (id: string, date: string): OfferedPage => ({
      id,
      kind: 'kept',
      title: '',
      date,
      year: 2066,
      lines: [{ id, text: MOVE, speakerId: null }],
    });
    // 08:30 and 11:00 on 26 November in Tokyo; 25 and 26 November in UTC.
    const pages = [at('E', '2026-11-25T23:30:00.000Z'), at('L', '2026-11-26T02:00:00.000Z')];
    const tokyo = trayGroups(pages, index, { storyYear: 2066, timeZone: 'Asia/Tokyo' });
    expect(tokyo.map((g) => g.id)).toEqual(['day:2026-11-26']);
    expect(tokyo[0]!.items.map((i) => i.pageId)).toEqual(['L', 'E']);
    expect(localDay('2026-11-25T23:30:00.000Z', 'Asia/Tokyo')).toBe('2026-11-26');
    const utc = trayGroups(pages, index, { storyYear: 2066, timeZone: 'UTC' });
    expect(utc.map((g) => g.id)).toEqual(['day:2026-11-26', 'day:2026-11-25']);
  });
});
