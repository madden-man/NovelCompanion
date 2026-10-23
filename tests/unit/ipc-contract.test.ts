import { describe, expect, test } from 'vitest';
import {
  CHANNELS,
  IpcValidationError,
  contract,
  events,
  isChannel,
  parseRequest,
  parseResponse,
} from '../../src/shared/ipc';
import { runHandler } from '../../src/main/ipc/validate';

describe('ARCH-1 IPC contract', () => {
  test('ARCH-1 every channel has a zod request and response schema', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(['app.ping', 'bible.list']));
    for (const c of CHANNELS) {
      expect(typeof contract[c].request.safeParse).toBe('function');
      expect(typeof contract[c].response.safeParse).toBe('function');
    }
  });

  test('ARCH-1 app.ping accepts a valid request and response', () => {
    expect(parseRequest('app.ping', { message: 'hello' })).toEqual({ message: 'hello' });
    const at = new Date().toISOString();
    expect(parseResponse('app.ping', { message: 'hello', receivedAt: at })).toEqual({
      message: 'hello',
      receivedAt: at,
    });
  });

  test('ARCH-1 app.ping rejects bad requests', () => {
    for (const bad of [
      undefined,
      null,
      'hello',
      {},
      { message: '' },
      { message: 42 },
      { message: 'x'.repeat(201) },
      { message: 'hi', extra: true },
    ]) {
      expect(() => parseRequest('app.ping', bad)).toThrow(IpcValidationError);
    }
  });

  test('ARCH-1 app.ping rejects bad responses', () => {
    expect(() => parseResponse('app.ping', { message: 'hi' })).toThrow(IpcValidationError);
    expect(() => parseResponse('app.ping', { message: 'hi', receivedAt: 'yesterday' })).toThrow(
      IpcValidationError,
    );
  });

  test('ARCH-1 bible.list validates its request and response', () => {
    expect(parseRequest('bible.list', {})).toEqual({});
    expect(() => parseRequest('bible.list', { name: 'x' })).toThrow(IpcValidationError);
    expect(parseResponse('bible.list', { connection: 'connected', bibles: [] })).toEqual({
      connection: 'connected',
      bibles: [],
    });
    expect(() => parseResponse('bible.list', { connection: 'maybe', bibles: [] })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseResponse('bible.list', {
        connection: 'connected',
        bibles: [{ id: 'eastwinds', name: '' }],
      }),
    ).toThrow(IpcValidationError);
    expect(() => parseResponse('bible.list', { connection: 'connected' })).toThrow(
      IpcValidationError,
    );
  });

  test('ARCH-1 unknown channels are not part of the contract', () => {
    expect(isChannel('app.ping')).toBe(true);
    expect(isChannel('fs.readFile')).toBe(false);
    expect(isChannel('__proto__')).toBe(false);
    expect(isChannel(7)).toBe(false);
    // A53: history and the link index left the app.
    for (const gone of [
      'revisions.list',
      'revisions.diff',
      'revisions.restore',
      'revisions.prune',
      'entry.linkedFrom',
      'entry.backlinks',
    ]) {
      expect(isChannel(gone), gone).toBe(false);
    }
  });

  test('ARCH-1 main-side handler wrapper rejects a bad request before the handler runs', async () => {
    let ran = false;
    await expect(
      runHandler(
        'app.ping',
        () => {
          ran = true;
          return { message: 'x', receivedAt: new Date().toISOString() };
        },
        { message: 5 },
      ),
    ).rejects.toThrow(IpcValidationError);
    expect(ran).toBe(false);
  });

  test('ARCH-1 main-side handler wrapper rejects a bad response from the handler', async () => {
    await expect(
      runHandler('app.ping', () => ({ message: 'x' }) as never, { message: 'hi' }),
    ).rejects.toThrow(IpcValidationError);
  });

  test('ARCH-1 change events have a schema', () => {
    expect(
      events['bible.changed'].safeParse({
        bible: 'b',
        collection: 'characters',
        id: 'H1',
        op: 'create',
      }).success,
    ).toBe(true);
    expect(events['bible.changed'].safeParse({ bible: 'b', op: 'drop' }).success).toBe(false);
  });

  test('ARCH-1 bible.create validates the slug and name on both sides', () => {
    expect(parseRequest('bible.create', { slug: 'east-winds', name: 'East Winds' })).toEqual({
      slug: 'east-winds',
      name: 'East Winds',
    });
    expect(parseRequest('bible.create', { slug: 'tide', name: '  Tide  ' })).toEqual({
      slug: 'tide',
      name: 'Tide',
    });
    for (const bad of [
      {},
      { slug: 'Bad.ID', name: 'Bad' },
      { slug: 'bibles', name: 'Registry' },
      { slug: 'ok', name: '   ' },
      { slug: 'ok', name: 'x'.repeat(201) },
      { slug: 'ok', name: 'Ok', extra: 1 },
    ]) {
      expect(() => parseRequest('bible.create', bad), JSON.stringify(bad)).toThrow(
        IpcValidationError,
      );
    }
    expect(parseResponse('bible.create', { bible: { id: 'tide', name: 'Tide' } })).toEqual({
      bible: { id: 'tide', name: 'Tide' },
    });
    expect(() => parseResponse('bible.create', { bible: { id: 'tide' } })).toThrow(
      IpcValidationError,
    );
  });

  test('ARCH-1 bible.open validates the slug and the opened bible', () => {
    expect(parseRequest('bible.open', { slug: 'tide' })).toEqual({ slug: 'tide' });
    for (const bad of [{}, { slug: '' }, { slug: 'UPPER' }, { slug: 'a b' }, { id: 'tide' }]) {
      expect(() => parseRequest('bible.open', bad), JSON.stringify(bad)).toThrow(
        IpcValidationError,
      );
    }
    expect(() => parseResponse('bible.open', { bible: null })).toThrow(IpcValidationError);
    expect(() => parseResponse('bible.open', { bible: { id: '', name: 'x' } })).toThrow(
      IpcValidationError,
    );
  });

  test('ARCH-1 bible.current takes no arguments and returns a bible or null', () => {
    expect(parseRequest('bible.current', {})).toEqual({});
    expect(() => parseRequest('bible.current', { slug: 'x' })).toThrow(IpcValidationError);
    expect(parseResponse('bible.current', { bible: null })).toEqual({ bible: null });
    expect(parseResponse('bible.current', { bible: { id: 'tide', name: 'Tide' } })).toEqual({
      bible: { id: 'tide', name: 'Tide' },
    });
    expect(() => parseResponse('bible.current', {})).toThrow(IpcValidationError);
    expect(() => parseResponse('bible.current', { bible: 'tide' })).toThrow(IpcValidationError);
  });

  test('ED-1 entry.create checks the whole entry against its schema before it is sent', () => {
    const ok = { title: 'Hale', name: 'Hale' };
    expect(parseRequest('entry.create', { collection: 'families', data: ok })).toEqual({
      collection: 'families',
      data: ok,
    });
    expect(() =>
      parseRequest('entry.create', {
        collection: 'families',
        data: { title: 'x' },
      }),
    ).toThrow(/name/);
    expect(() => parseRequest('entry.create', { collection: 'nonsense', data: ok })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseRequest('entry.create', {
        collection: 'families',
        data: { ...ok, createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    ).toThrow(/set by the app/);
  });

  test('ED-1 entry.update checks each patched field and refuses unknown or system fields', () => {
    expect(
      parseRequest('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { death: { year: 2041 } },
      }),
    ).toEqual({
      collection: 'characters',
      id: 'H1',
      patch: { death: { year: 2041 } },
    });
    expect(() =>
      parseRequest('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { death: { year: 'x' } },
      }),
    ).toThrow(IpcValidationError);
    expect(() =>
      parseRequest('entry.update', { collection: 'characters', id: 'H1', patch: { shoeSize: 9 } }),
    ).toThrow(/no field shoeSize/);
    expect(() =>
      parseRequest('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { modifiedAt: 'now' },
      }),
    ).toThrow(/set by the app/);
  });

  test('ED-10 a write whose values only warn passes the contract; warnings travel back with it', () => {
    expect(() =>
      parseRequest('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { birth: { year: 2000 }, death: { year: 1990 } },
      }),
    ).not.toThrow();
    const res = parseResponse('entry.update', {
      entry: { _id: 'H1', modifiedAt: '2026-01-01T00:00:00.000Z', title: 'x' },
      warnings: [{ path: 'death', code: 'death-before-birth', message: 'plain words' }],
    });
    expect(res.warnings).toHaveLength(1);
  });

  test('ED-8 lists.rename needs a list it knows and a non-empty name', () => {
    expect(
      parseRequest('lists.rename', { listId: 'communities', itemId: 't', label: ' New ' }),
    ).toEqual({
      listId: 'communities',
      itemId: 't',
      label: 'New',
    });
    expect(() =>
      parseRequest('lists.rename', { listId: 'communities', itemId: 't', label: '  ' }),
    ).toThrow(/needs a name/);
    expect(() =>
      parseRequest('lists.rename', { listId: 'shoes', itemId: 't', label: 'x' }),
    ).toThrow(IpcValidationError);
  });
});

/**
 * ARCH-1: every channel added after the first milestones rejects bad input on
 * the request side, which is what the preload and main both run. One row per
 * channel; a channel with no row fails the first test, so a new channel cannot
 * ship without bad-input cases.
 */
const LONG = 'x'.repeat(10_000);
const BAD: Record<string, unknown[]> = {
  'claude.status': [{ extra: 1 }],
  'claude.setKey': [{}, { key: 5 }, { key: LONG }, { key: 'k', extra: 1 }],
  'claude.clearKey': [{ extra: 1 }],
  'claude.models': [{ extra: 1 }],
  'claude.setModel': [{}, { feature: 'nope', model: 'm' }, { feature: 'panel', model: '' }],
  'claude.acknowledge': [{ extra: 1 }],
  'claude.ask': [
    {},
    { runId: 'short', conversationId: null, question: 'q' },
    { runId: 'run-12345678', conversationId: null, question: '' },
    { runId: 'run-12345678', conversationId: null, question: LONG },
    { runId: 'run 12345678', conversationId: null, question: 'q' },
    { runId: 'run-12345678', conversationId: '', question: 'q' },
  ],
  'claude.stop': [{}, { runId: '' }, { runId: 7 }],
  'claude.runs': [{ feature: 'nope' }, { extra: 1 }],
  'claude.run': [{}, { id: '' }],
  'claude.alignment': [
    {},
    { chapterId: 'CH1' },
    { runId: 5, chapterId: 'CH1' },
    { runId: 'r', chapterId: '' },
    { runId: 'r', chapterId: 'CH1', extra: 1 },
  ],
  'claude.capture': [
    {},
    { runId: 'run-12345678', text: 'Lan moved.' },
    { runId: 'run-12345678', text: '   ', storyTime: { year: 2034 } },
    { runId: 'run-12345678', text: LONG, storyTime: { year: 2034 } },
    { runId: 'short', text: 'Lan moved.', storyTime: { year: 2034 } },
    { runId: 'run-12345678', text: 'Lan moved.', storyTime: { year: 2034, strandId: 'S1' } },
    { runId: 'run-12345678', text: 'Lan moved.', storyTime: { year: 2034 }, extra: 1 },
  ],
  'session.relevant': [{}, { input: { kind: 'chapter' } }, { input: 5 }],
  'brief.settings.get': [{ extra: 1 }],
  'brief.settings.set': [{ window: -1 }, { window: 1.5 }, { budget: 10_000_001 }, { window: 'a' }],
  'manuscript.sources': [{ extra: 1 }],
  'manuscript.read': [
    {},
    { chapterId: '' },
    { chapterId: 'c', sourceId: LONG },
    { chapterId: 'c', locator: 'doc' },
  ],
  'manuscript.apply': [{}, { token: '', baseModifiedAt: 'x' }, { token: 't' }],
  'chapter.page': [{}, { id: '' }, { id: LONG }],
  'chapter.summarize': [{}, { chapterId: '' }, { chapterId: 'c', runId: 'short' }],
  // a47-guard
  'claude.instructions.get': [{ extra: 1 }],
  'claude.instructions.set': [
    {},
    { feature: 'nope', text: null },
    { feature: 'panel' },
    { feature: 'panel', text: 'x'.repeat(20_001) },
  ],
  'claude.conversation.rename': [
    {},
    { id: 'c' },
    { id: '', title: 'A title' },
    { id: 'c', title: '   ' },
    { id: 'c', title: LONG },
  ],
  'claude.conversation.clear': [{}, { id: '' }, { id: 'c', extra: 1 }],
  'claude.conversation.delete': [{}, { id: '' }, { id: 'c', extra: 1 }],
  'manuscript.reimport': [{}, { chapterId: '' }, { chapterId: 'c', sourceId: 'word' }],
};

describe('ARCH-1 every newer channel rejects bad input on the request side', () => {
  test('ARCH-1 each claude, session, brief, manuscript and chapter channel has bad-input rows', () => {
    const wanted = CHANNELS.filter((c) => /^(claude|session|brief|manuscript|chapter)\./.test(c));
    expect(Object.keys(BAD).sort()).toEqual([...wanted].sort());
  });

  test.each(Object.entries(BAD))(
    'ARCH-1 %s rejects its bad requests and non-objects',
    (channel, bads) => {
      for (const bad of [...bads, null, 'x', 7, [], { __unknown: true }]) {
        expect(
          () => parseRequest(channel as never, bad),
          `${channel} ${JSON.stringify(bad)}`,
        ).toThrow(IpcValidationError);
      }
    },
  );

  test('ARCH-1 claude.stream rejects a payload that is not one of its event kinds', () => {
    for (const bad of [
      {},
      { kind: 'nope' },
      { runId: 'r', conversationId: 'c', kind: 'text' },
      { runId: 'r', conversationId: 'c', kind: 'finished', status: 'maybe', error: null },
      null,
    ]) {
      expect(events['claude.stream'].safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
