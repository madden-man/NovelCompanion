import { describe, expect, test } from 'vitest';
import type { UpRow } from '../../src/shared/bridge';
import {
  phoneQuestions,
  planQuestions,
  questionCommand,
} from '../../src/shared/domain/phoneQuestions';
import type { BibleQuestion } from '../../src/shared/domain/phoneQuestions';

const W = 'eastwinds';
const T = Date.parse('2026-11-25T12:00:00.000Z');

function up(
  table: UpRow['table'],
  id: string,
  row: Record<string, unknown> | null,
  world = W,
): UpRow {
  return {
    _id: `${world}:${table}:${id}`,
    world,
    table,
    id,
    rev: 1,
    deleted: row === null,
    row,
    at: T,
  };
}

const qPage = (id: string, extra: Record<string, unknown> = {}) =>
  up('pages', id, {
    id,
    kind: 'question',
    title: 'Does Siyuan leave before the flood?',
    state: 'open',
    createdAt: T - 1000,
    updatedAt: T,
    ...extra,
  });
const line = (id: string, pageId: string, text: string, at: number, extra = {}) =>
  up('messages', id, { id, pageId, at, updatedAt: at, text, wise: false, kept: false, ...extra });

const bibleQ = (id: string, extra: Partial<BibleQuestion> = {}): BibleQuestion => ({
  id,
  state: 'open',
  decision: '',
  modifiedAt: new Date(T - 60_000).toISOString(),
  ...extra,
});

describe('FN-7 questions written directly', () => {
  test('FN-7 This answers it: the newest wise line by time is the decision, and the question is decided', () => {
    const rows = [
      qPage('Q1', { state: 'answered', answeredAt: T }),
      line('m1', 'Q1', 'Before the flood.', T - 500, { wise: true }),
      line('m2', 'Q1', 'After it, in the spring.', T - 100, { wise: true }),
      line('m3', 'Q1', 'Not wise, newest.', T - 10),
    ];
    const phone = phoneQuestions(rows, W);
    expect(phone).toEqual([
      {
        id: 'Q1',
        title: 'Does Siyuan leave before the flood?',
        state: 'answered',
        resolvedByTap: false,
        decision: 'After it, in the spring.',
        changedAt: T,
      },
    ]);
    expect(planQuestions(phone, new Map([['Q1', bibleQ('Q1')]]))).toEqual([
      {
        op: 'set',
        id: 'Q1',
        modifiedAt: new Date(T - 60_000).toISOString(),
        before: { state: 'open', decision: '' },
        after: { state: 'decided', decision: 'After it, in the spring.' },
      },
    ]);
  });

  test('FN-7 Resolve with no wise line decides the question and leaves its decision as it was', () => {
    const phone = phoneQuestions([qPage('Q1', { state: 'answered', resolvedByTap: true })], W);
    expect(phone[0]?.decision).toBeNull();
    const ops = planQuestions(phone, new Map([['Q1', bibleQ('Q1', { decision: 'Draft note' })]]));
    expect(ops).toEqual([
      {
        op: 'set',
        id: 'Q1',
        modifiedAt: new Date(T - 60_000).toISOString(),
        before: { state: 'open', decision: 'Draft note' },
        after: { state: 'decided', decision: 'Draft note' },
      },
    ]);
  });

  test('FN-7 taken back: the page open again reopens a decided question and keeps its decision text', () => {
    const phone = phoneQuestions([qPage('Q1', { state: 'open' })], W);
    const ops = planQuestions(
      phone,
      new Map([['Q1', bibleQ('Q1', { state: 'decided', decision: 'After the flood.' })]]),
    );
    expect(ops).toEqual([
      {
        op: 'set',
        id: 'Q1',
        modifiedAt: new Date(T - 60_000).toISOString(),
        before: { state: 'decided', decision: 'After the flood.' },
        after: { state: 'open', decision: 'After the flood.' },
      },
    ]);
  });

  test('FN-7 a question page the bible does not hold is a new question with the phone ID, decided when the phone says so', () => {
    const open = phoneQuestions([qPage('3f2b-uuid', { title: 'Who keeps the key?' })], W);
    expect(planQuestions(open, new Map())).toEqual([
      {
        op: 'ask',
        id: '3f2b-uuid',
        data: {
          title: 'Who keeps the key?',
          question: 'Who keeps the key?',
          state: 'open',
          decision: '',
        },
      },
    ]);
    const answered = phoneQuestions(
      [
        qPage('3f2b-uuid', { title: 'Who keeps the key?', state: 'answered' }),
        line('m1', '3f2b-uuid', 'Dawn does.', T, { wise: true }),
      ],
      W,
    );
    expect(planQuestions(answered, new Map())[0]).toMatchObject({
      op: 'ask',
      data: { state: 'decided', decision: 'Dawn does.' },
    });
  });

  test('FN-7 the newer change wins: a desktop edit after the phone change stands, and a question already as the phone says is left alone', () => {
    const phone = phoneQuestions([qPage('Q1', { state: 'answered', resolvedByTap: true })], W);
    const later = bibleQ('Q1', { modifiedAt: new Date(T + 1).toISOString() });
    expect(planQuestions(phone, new Map([['Q1', later]]))).toEqual([]);
    const same = bibleQ('Q1', { state: 'decided', decision: '' });
    expect(planQuestions(phone, new Map([['Q1', same]]))).toEqual([]);
    // Equal times: the bible's change is not older, so it stands.
    const equal = bibleQ('Q1', { modifiedAt: new Date(T).toISOString() });
    expect(planQuestions(phone, new Map([['Q1', equal]]))).toEqual([]);
  });

  test('FN-7 a question in the trash, a deleted page, another world, a council and the bible decision line are left alone', () => {
    const rows = [
      qPage('Q1', { state: 'answered' }),
      up('pages', 'Q2', null),
      qPage('Q3', { state: 'answered' }),
      up('pages', 'C1', { id: 'C1', kind: 'council', title: 'Council', state: 'answered' }),
      line('d:Q1', 'Q1', 'The bible decision came down.', T + 5, { wise: true }),
    ];
    rows[2] = { ...rows[2]!, world: 'other' };
    const phone = phoneQuestions(rows, W);
    expect(phone.map((p) => p.id)).toEqual(['Q1']);
    expect(phone[0]?.decision).toBeNull();
    const trashed = bibleQ('Q1', { deletedAt: new Date(T).toISOString() });
    expect(planQuestions(phone, new Map([['Q1', trashed]]))).toEqual([]);
  });

  test('FN-7 each change is one undo step: undo writes the state and decision back, a question asked on the phone goes to the trash', () => {
    const set = questionCommand({
      id: 'Q1',
      title: 'Does Siyuan leave?',
      before: { state: 'open', decision: '' },
      after: { state: 'decided', decision: 'After.' },
    });
    expect(set.label).toBe('From the phone: Does Siyuan leave?');
    expect(set.undo).toEqual([
      {
        kind: 'update',
        collection: 'openQuestions',
        id: 'Q1',
        patch: { state: 'open', decision: '' },
        expect: { state: 'decided', decision: 'After.' },
      },
    ]);
    const asked = questionCommand({
      id: 'u-1',
      title: 'Who keeps the key?',
      before: null,
      after: { state: 'open', decision: '' },
    });
    expect(asked.undo).toEqual([{ kind: 'delete', collection: 'openQuestions', id: 'u-1' }]);
    expect(asked.redo).toEqual([{ kind: 'restore', collection: 'openQuestions', id: 'u-1' }]);
  });

  test('FN-7 an ID the bible held once (given to the phone, made from it, or deleted forever) is never asked again', () => {
    const phone = phoneQuestions([qPage('Q-gone', { state: 'answered' })], W);
    expect(planQuestions(phone, new Map(), new Set(['Q-gone']))).toEqual([]);
    expect(planQuestions(phone, new Map(), new Set(['other']))).toHaveLength(1);
  });

  test('FN-7 a wise line edited on the phone is a change: the newest of the page and its decision line wins', () => {
    const rows = [
      qPage('Q1', { state: 'answered', updatedAt: T - 100_000 }),
      line('w1', 'Q1', 'After the flood, edited.', T - 200_000, { wise: true, updatedAt: T }),
    ];
    const [p] = phoneQuestions(rows, W);
    expect(p?.changedAt).toBe(T);
    const q = bibleQ('Q1', {
      state: 'decided',
      decision: 'After the flood.',
      modifiedAt: new Date(T - 50_000).toISOString(),
    });
    expect(planQuestions([p!], new Map([['Q1', q]]))).toEqual([
      {
        op: 'set',
        id: 'Q1',
        modifiedAt: q.modifiedAt,
        before: { state: 'decided', decision: 'After the flood.' },
        after: { state: 'decided', decision: 'After the flood, edited.' },
      },
    ]);
  });
});
