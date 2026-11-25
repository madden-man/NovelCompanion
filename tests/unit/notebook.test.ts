import { describe, expect, test } from 'vitest';
import { buildIndex } from '../../src/shared/domain/captureRouter';
import {
  assembleNotebook,
  chaptersNamed,
  firstLine,
  linkNotebook,
  notebookCaption,
  notebookRows,
  planNotebook,
  speakerOf,
} from '../../src/shared/domain/notebook';
import type { LinkContext, NotebookDraft } from '../../src/shared/domain/notebook';
import type { UpRow } from '../../src/shared/bridge';
import { NotebookPage } from '../../src/shared/schema';

/**
 * Rows shaped exactly as FlowState's function stores them in `bridge_up`
 * (`{ _id: "<world>:<table>:<id>", world, table, id, rev, deleted, row, at }`), with rows built
 * as FlowState's src/bridge/up.ts builds them.
 */
const W = 'eastwinds';
const up = (
  table: UpRow['table'],
  id: string,
  rev: number,
  row: Record<string, unknown> | null,
  world = W,
): UpRow => ({
  _id: `${world}:${table}:${id}`,
  world,
  table,
  id,
  rev,
  deleted: row === null,
  row,
  at: rev + 5,
});

const NOV25 = Date.parse('2026-11-25T21:00:00.000Z');
const council = (extra: Record<string, unknown> = {}) =>
  up('pages', 'P-council', 100, {
    id: 'P-council',
    kind: 'council',
    title: 'Does Siyuan leave before the flood, or after?',
    state: 'open',
    createdAt: NOV25,
    updatedAt: NOV25 + 60_000,
    seats: ['c:SIYUAN', 'c:DAWN'],
    reading: 'about',
    chips: { characterIds: [], placeIds: ['JINAN'], year: 2071 },
    year: 2071,
    ...extra,
  });
const line = (id: string, rev: number, at: number, extra: Record<string, unknown> = {}) =>
  up('messages', id, rev, {
    id,
    pageId: 'P-council',
    at,
    text: `Line ${id}`,
    kept: false,
    ...extra,
  });
const keptLine = (rev = 200, extra: Record<string, unknown> = {}) =>
  up('messages', 'M-kept', rev, {
    id: 'M-kept',
    at: NOV25 + 5,
    text: 'She keeps it for a year.',
    kept: true,
    kind: 'kept',
    date: NOV25,
    year: 2071,
    chips: { characterIds: ['DAWN'], placeIds: [] },
    ...extra,
  });

const ctx = { questions: new Map([['Q-flood', 'When does the flood come?']]) };

describe('NB-4 the notebook pages a world rows hold', () => {
  test('NB-4 a council arrives whole: its page and every line that names it, in the order written, with its reading and year', () => {
    const rows = [
      line('L2', 102, NOV25 + 2000, { voiceId: 'c:DAWN', text: 'I can keep it.', wise: true }),
      council(),
      line('L1', 101, NOV25 + 1000, { voiceId: 'c:SIYUAN', text: 'After. Always after.' }),
      line('L3', 103, NOV25 + 3000, { text: 'He leaves in spring.' }),
    ];
    const { pages, deleted } = assembleNotebook(rows, W, ctx);
    expect(deleted.size).toBe(0);
    expect(pages).toHaveLength(1);
    const p = pages[0]!;
    expect(p).toMatchObject({
      _id: 'P-council',
      world: W,
      kind: 'council',
      reading: 'about',
      title: 'Does Siyuan leave before the flood, or after?',
      date: '2026-11-25T21:00:00.000Z',
      year: 2071,
      chips: { characterIds: ['SIYUAN', 'DAWN'], placeIds: ['JINAN'] },
      research: null,
      questionId: null,
    });
    expect(p.lines.map((l) => [l.id, l.speakerId, l.text, l.wise])).toEqual([
      ['L1', 'SIYUAN', 'After. Always after.', false],
      ['L2', 'DAWN', 'I can keep it.', true],
      ['L3', null, 'He leaves in spring.', false],
    ]);
    expect(p.sig).toBe('messages:L1:101 messages:L2:102 messages:L3:103 pages:P-council:100');
  });

  test('NB-4 a council in the story keeps its reading; one with no reading is about the story; null year is the whole book', () => {
    const [inStory] = assembleNotebook([council({ reading: 'in' })], W, ctx).pages;
    expect(inStory!.reading).toBe('in');
    const [about] = assembleNotebook([council({ reading: undefined, year: null })], W, ctx).pages;
    expect(about!.reading).toBe('about');
    expect(about!.year).toBeNull();
  });

  test('NB-4 a kept journal line is a page of one line, its ID the line ID, with its page date, year and chips', () => {
    const { pages } = assembleNotebook([keptLine()], W, ctx);
    expect(pages).toEqual([
      expect.objectContaining({
        _id: 'M-kept',
        kind: 'kept',
        reading: null,
        title: '',
        date: '2026-11-25T21:00:00.000Z',
        year: 2071,
        chips: { characterIds: ['DAWN'], placeIds: [] },
        lines: [
          {
            id: 'M-kept',
            speakerId: null,
            text: 'She keeps it for a year.',
            wise: false,
            kept: true,
            at: new Date(NOV25 + 5).toISOString(),
          },
        ],
      }),
    ]);
  });

  test('NB-4 a question page is a thread on the bible question of the same ID; lines on a bible question with no page row still make its thread', () => {
    const thread = up('pages', 'Q-flood', 300, {
      id: 'Q-flood',
      kind: 'question',
      title: 'When does the flood come?',
      state: 'open',
      createdAt: NOV25,
    });
    const own = assembleNotebook([thread], W, ctx).pages[0]!;
    expect(own).toMatchObject({ kind: 'thread', reading: null, questionId: 'Q-flood' });

    const orphan = up('messages', 'QL1', 301, {
      id: 'QL1',
      pageId: 'Q-flood',
      at: NOV25,
      text: 'Spring 2071.',
      kept: false,
      wise: true,
    });
    const made = assembleNotebook([orphan], W, ctx).pages;
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      _id: 'Q-flood',
      kind: 'thread',
      title: 'When does the flood come?',
      questionId: 'Q-flood',
    });
    // Lines on a page the bible does not know wait for their page.
    const stray = up('messages', 'X1', 302, {
      id: 'X1',
      pageId: 'P-unknown',
      at: NOV25,
      text: 'x',
      kept: false,
    });
    expect(assembleNotebook([stray], W, ctx).pages).toEqual([]);
  });

  test('NB-4 a question researched is a research page with its papers, on the question it was asked from', () => {
    const inquiry = up('inquiries', 'I1', 400, {
      id: 'I1',
      askedAt: NOV25,
      question: 'How long does a river flood last?',
      state: 'done',
      pageId: 'Q-flood',
      papers: [
        {
          id: 'p1',
          title: 'Flood duration',
          journal: 'Hydrology',
          year: 2019,
          doi: '10.1/x',
          kind: 'study',
          tier: 1,
          side: 'for',
        },
      ],
    });
    const [p] = assembleNotebook([inquiry], W, ctx).pages;
    expect(p).toMatchObject({
      kind: 'research',
      title: 'How long does a river flood last?',
      questionId: 'Q-flood',
      lines: [],
      research: {
        question: 'How long does a river flood last?',
        papers: [
          {
            id: 'p1',
            title: 'Flood duration',
            journal: 'Hydrology',
            year: 2019,
            doi: '10.1/x',
            side: 'for',
          },
        ],
      },
    });
  });

  test('NB-4 another world, an entry page, songs and takes are not notebook pages, and every page is valid for the schema', () => {
    const rows = [
      council(),
      up('pages', 'P-entry', 1, { id: 'P-entry', kind: 'entry', createdAt: NOV25 }),
      up('songs', 'S1', 1, { id: 'S1', title: 'Low tide' }),
      up('takes', 'T1', 1, { id: 'T1' }),
      { ...keptLine(), world: 'other', _id: 'other:messages:M-kept' },
    ];
    const { pages } = assembleNotebook(rows, W, ctx);
    expect(pages.map((p) => p._id)).toEqual(['P-council']);
    const at = '2026-11-25T22:00:00.000Z';
    for (const p of [...pages, ...assembleNotebook([keptLine()], W, ctx).pages]) {
      const r = NotebookPage.safeParse({
        ...p,
        characterIds: [],
        placeIds: [],
        chapterIds: [],
        years: [],
        createdAt: at,
        modifiedAt: at,
      });
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  test('NB-4 a council voice c:<id> is that character; plain ink and every other voice is nobody', () => {
    expect(speakerOf('c:Z3')).toBe('Z3');
    expect(speakerOf(undefined)).toBeNull();
    expect(speakerOf('v:architect')).toBeNull();
  });
});

describe('NB-6 deletes and the trash', () => {
  test('NB-6 a deleted council and a line no longer kept are listed to trash; a deleted council line only leaves its page', () => {
    const rows = [
      up('pages', 'P-gone', 500, null),
      keptLine(201, { kept: false }),
      council(),
      line('L1', 101, NOV25),
      up('messages', 'L2', 150, null),
    ];
    const { pages, deleted } = assembleNotebook(rows, W, ctx);
    expect([...deleted.keys()].sort()).toEqual(['L2', 'M-kept', 'P-gone']);
    expect(deleted.get('P-gone')).toBe('deleted pages:P-gone:500');
    expect(pages[0]!.lines.map((l) => l.id)).toEqual(['L1']);
  });

  test('NB-6 a kept line unkept arrives as a delete; planNotebook trashes it once, and a second pull plans nothing', () => {
    const first = assembleNotebook([keptLine()], W, ctx);
    const noLinks = () => ({ characterIds: [], placeIds: [], chapterIds: [], years: [] });
    const ops = planNotebook(first, [], noLinks);
    expect(ops.map((o) => o.op)).toEqual(['put']);
    const stored = [{ _id: 'M-kept', sig: first.pages[0]!.sig, world: W }];
    // The same rows again: nothing.
    expect(planNotebook(first, stored, noLinks)).toEqual([]);

    const gone = assembleNotebook([up('messages', 'M-kept', 250, null)], W, ctx);
    expect(planNotebook(gone, stored, noLinks)).toEqual([
      { op: 'trash', id: 'M-kept', sig: 'deleted messages:M-kept:250' },
    ]);
    const trashed = [
      { ...stored[0]!, sig: 'deleted messages:M-kept:250', deletedAt: '2026-11-26T00:00:00.000Z' },
    ];
    expect(planNotebook(gone, trashed, noLinks)).toEqual([]);
    // Kept again on the phone, a newer rev: it comes back with its links read again.
    const back = assembleNotebook([keptLine(300)], W, ctx);
    const again = planNotebook(back, trashed, noLinks);
    expect(again.map((o) => o.op)).toEqual(['put']);
  });
});

const index = buildIndex({
  lists: [],
  entries: {
    characters: [
      { _id: 'SIYUAN', title: 'Siyuan Li', names: { full: 'Siyuan Li' } },
      { _id: 'DAWN', title: 'Dawn Li', names: { full: 'Dawn Li' } },
      {
        _id: 'GONE',
        title: 'Old Name',
        names: { full: 'Old Name' },
        deletedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    places: [{ _id: 'JINAN', title: 'Jinan', communityId: null }],
  },
  timelineEnd: 2100,
});
const linkCtx: LinkContext = {
  index,
  chapters: [
    { id: 'CH-FLOOD', title: 'The Flood', number: 3 },
    { id: 'CH-ROOF', title: 'Roof', number: 7 },
  ],
  known: new Set(['SIYUAN', 'DAWN', 'JINAN', 'CH-FLOOD', 'CH-ROOF']),
  storyYear: 2060,
};
const draft = (o: Partial<NotebookDraft>): NotebookDraft => ({
  _id: 'P',
  world: W,
  kind: 'kept',
  reading: null,
  title: '',
  date: '2026-11-25T21:00:00.000Z',
  year: null,
  lines: [],
  chips: { characterIds: [], placeIds: [] },
  research: null,
  questionId: null,
  sig: '',
  ...o,
});
const ln = (text: string, speakerId: string | null = null) => ({
  id: `l-${text.length}`,
  speakerId,
  text,
  wise: false,
  kept: false,
  at: null,
});

describe('NB-5 a page is linked to what it names', () => {
  test('NB-5 names in the lines resolve through the router: characters by full and first name, places, years in the text', () => {
    const links = linkNotebook(
      draft({ lines: [ln('Siyuan leaves Jinan in 2071. Dawn keeps it until 2072.')] }),
      linkCtx,
    );
    expect(links).toEqual({
      characterIds: ['DAWN', 'SIYUAN'],
      placeIds: ['JINAN'],
      chapterIds: [],
      years: [2071, 2072],
    });
  });

  test('NB-5 chips, seats, speakers and the page year link too; an ID the bible lacks is dropped', () => {
    const links = linkNotebook(
      draft({
        kind: 'council',
        year: 2071,
        chips: { characterIds: ['DAWN', 'NOBODY'], placeIds: ['JINAN'] },
        lines: [ln('After.', 'SIYUAN'), ln('No names here at all.')],
      }),
      linkCtx,
    );
    expect(links.characterIds).toEqual(['DAWN', 'SIYUAN']);
    expect(links.placeIds).toEqual(['JINAN']);
    expect(links.years).toEqual([2071]);
  });

  test('NB-5 chapters by their title as written or by "chapter N"; a lowercase word that is a title is not one', () => {
    expect(chaptersNamed('This belongs before The Flood.', linkCtx.chapters)).toEqual(['CH-FLOOD']);
    expect(chaptersNamed('Move it to chapter 7.', linkCtx.chapters)).toEqual(['CH-ROOF']);
    expect(chaptersNamed('the flood came; the roof held', linkCtx.chapters)).toEqual([]);
    expect(chaptersNamed('chapter 70', linkCtx.chapters)).toEqual([]);
    const links = linkNotebook(draft({ title: 'Chapter 3 needs Dawn', lines: [] }), linkCtx);
    expect(links.chapterIds).toEqual(['CH-FLOOD']);
    expect(links.characterIds).toEqual(['DAWN']);
  });

  test('NB-5 a trashed character is not matched by name', () => {
    expect(
      linkNotebook(draft({ lines: [ln('Old Name was here.')] }), linkCtx).characterIds,
    ).toEqual([]);
  });
});

const page = (o: Partial<NotebookPage>): NotebookPage => ({
  ...draft({}),
  characterIds: [],
  placeIds: [],
  chapterIds: [],
  years: [],
  createdAt: '2026-11-25T21:00:00.000Z',
  modifiedAt: '2026-11-25T21:00:00.000Z',
  ...o,
});

describe('NB-7 the Notebook list of an entry', () => {
  test('NB-7 rows are the live pages that name the entry, newest first, date and first line captioned by kind and story year', () => {
    const pages = [
      page({
        _id: 'k1',
        kind: 'kept',
        year: 2071,
        date: '2026-11-24T10:00:00.000Z',
        characterIds: ['DAWN'],
        lines: [{ ...ln('She keeps it.'), kept: true }],
      }),
      page({
        _id: 'c1',
        kind: 'council',
        reading: 'about',
        title: 'Before or after?',
        year: 2071,
        date: '2026-11-25T10:00:00.000Z',
        characterIds: ['DAWN', 'SIYUAN'],
      }),
      page({
        _id: 'c2',
        kind: 'council',
        reading: 'in',
        title: '',
        lines: [ln('Keep this for me.')],
        year: null,
        date: '2026-11-23T10:00:00.000Z',
        characterIds: ['DAWN'],
      }),
      page({
        _id: 'gone',
        kind: 'kept',
        characterIds: ['DAWN'],
        deletedAt: '2026-11-25T11:00:00.000Z',
      }),
      page({ _id: 'other', kind: 'kept', characterIds: ['SIYUAN'] }),
    ];
    expect(notebookRows(pages, 'characters', 'DAWN')).toEqual([
      {
        id: 'c1',
        kind: 'council',
        reading: 'about',
        date: '2026-11-25T10:00:00.000Z',
        year: 2071,
        firstLine: 'Before or after?',
        caption: 'Council, about the story · story year 2071',
        opens: true,
      },
      {
        id: 'k1',
        kind: 'kept',
        reading: null,
        date: '2026-11-24T10:00:00.000Z',
        year: 2071,
        firstLine: 'She keeps it.',
        caption: 'Kept line · story year 2071',
        opens: false,
      },
      {
        id: 'c2',
        kind: 'council',
        reading: 'in',
        date: '2026-11-23T10:00:00.000Z',
        year: null,
        firstLine: 'Keep this for me.',
        caption: 'Council, in the story · the whole book',
        opens: true,
      },
    ]);
    expect(notebookRows(pages, 'places', 'DAWN')).toEqual([]);
  });

  test('NB-7 captions name every kind', () => {
    expect(notebookCaption({ kind: 'thread', reading: null, year: 2050 })).toBe(
      'Question thread · story year 2050',
    );
    expect(notebookCaption({ kind: 'research', reading: null, year: null })).toBe(
      'Research · the whole book',
    );
    expect(firstLine({ kind: 'kept', title: 'ignored', lines: [ln('The line.')] })).toBe(
      'The line.',
    );
  });
});
