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
});
