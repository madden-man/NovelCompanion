import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Api } from '../../src/shared/ipc';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed[key] = value;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

let api: Api;

beforeAll(async () => {
  await import('../../src/preload/index');
  api = exposed.api as Api;
});

beforeEach(() => invoke.mockReset());

describe('ARCH-1 preload', () => {
  test('ARCH-1 preload exposes only window.api with invoke and on', () => {
    expect(Object.keys(exposed)).toEqual(['api']);
    expect(Object.keys(api).sort()).toEqual(['invoke', 'on']);
  });

  test('ARCH-1 preload invoke sends a valid request and returns the validated response', async () => {
    const at = new Date().toISOString();
    invoke.mockResolvedValue({ message: 'hello', receivedAt: at });
    await expect(api.invoke('app.ping', { message: 'hello' })).resolves.toEqual({
      message: 'hello',
      receivedAt: at,
    });
    expect(invoke).toHaveBeenCalledWith('nc:app.ping', { message: 'hello' });
  });

  test('ARCH-1 preload invoke rejects a bad request without sending it', async () => {
    await expect(api.invoke('app.ping', { message: 3 } as never)).rejects.toThrow(/not valid/);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('ARCH-1 preload invoke rejects an unknown channel without sending it', async () => {
    await expect(api.invoke('fs.readFile' as never, {} as never)).rejects.toThrow(
      /Unknown channel/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test('A57 preload invoke sends the bible a write was made in beside the request, and refuses a bad one unsent', async () => {
    invoke.mockResolvedValue({ entry: { _id: 'H1' }, warnings: [] });
    const request = { collection: 'characters', id: 'H1', patch: { role: 'x' } } as const;
    await api.invoke('entry.update', request, { bible: 'east-winds' }).catch(() => undefined);
    expect(invoke).toHaveBeenCalledWith('nc:entry.update', request, { bible: 'east-winds' });
    invoke.mockReset();
    await expect(
      api.invoke('entry.update', request, { bible: 'Not An ID!' } as never),
    ).rejects.toThrow(/not valid/);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('ARCH-1 preload invoke rejects a bad response from main', async () => {
    invoke.mockResolvedValue({ connection: 'connected', bibles: [{ wrong: 1 }] });
    await expect(api.invoke('bible.list', {})).rejects.toThrow(/not valid/);
  });
});
