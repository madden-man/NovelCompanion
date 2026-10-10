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
    const ok = { title: 'Hale', status: 'canon', name: 'Hale' };
    expect(parseRequest('entry.create', { collection: 'families', data: ok })).toEqual({
      collection: 'families',
      data: ok,
    });
    expect(() =>
      parseRequest('entry.create', {
        collection: 'families',
        data: { title: 'x', status: 'canon' },
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
    expect(parseRequest('lists.rename', { listId: 'tags', itemId: 't', label: ' New ' })).toEqual({
      listId: 'tags',
      itemId: 't',
      label: 'New',
    });
    expect(() =>
      parseRequest('lists.rename', { listId: 'tags', itemId: 't', label: '  ' }),
    ).toThrow(/needs a name/);
    expect(() =>
      parseRequest('lists.rename', { listId: 'shoes', itemId: 't', label: 'x' }),
    ).toThrow(IpcValidationError);
  });
});
