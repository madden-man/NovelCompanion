import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc';
import type { Channel, EventName } from '../../src/shared/ipc';
import type { Appearance } from '../../src/shared/ipcApp';
import type { ClaudeHost, Host } from '../../src/main/host/types';
import { MemoryMongoUriStore } from '../../src/main/host/uri';
import { runHandler } from '../../src/main/ipc/validate';

// A58: the handler table must load in a process where none of these can. Each one throws on
// import, so importing the table below fails if anything in its module graph loads them.
vi.mock('electron', () => {
  throw new Error('electron was loaded');
});
vi.mock('@napi-rs/keyring', () => {
  throw new Error('the keyring was loaded');
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  throw new Error('the Agent SDK was loaded');
});

const { ELECTRON_ONLY_CHANNELS, registerHandlers } = await import('../../src/main/ipc/handlers');
const { NO_SAVE_DIALOG } = await import('../../src/main/ipc/exportTree');

const ROOT = join(import.meta.dirname, '../..');
const BANNED = ['electron', '@napi-rs/keyring', '@anthropic-ai/claude-agent-sdk'];

/** A host with no Electron, no disk, no dialogs and no Claude, all in memory. */
function memoryHost(extra: Partial<Host> = {}) {
  const sent: { event: EventName; payload: unknown }[] = [];
  const themes: Appearance[] = [];
  const host: Host = {
    userData: null,
    isPackaged: false,
    secrets: { mongoUris: () => new MemoryMongoUriStore(null) },
    broadcast: (event, payload) => sent.push({ event, payload }),
    dialogs: null,
    openExternal: null,
    setTheme: (appearance) => themes.push(appearance),
    claude: null,
    ...extra,
  };
  return { host, sent, themes };
}

/** A stand-in for Electron's Claude: every Claude channel, none of which is called here. */
const fakeClaude: ClaudeHost = {
  attach: () => ({
    runtime: { stopAll: async () => undefined },
    handlers: Object.fromEntries(
      ELECTRON_ONLY_CHANNELS.map((c) => [
        c,
        () => {
          throw new Error('not called');
        },
      ]),
    ) as never,
    sessionClaude: { summaries: null },
  }),
};

describe('A58 the handler table is built for a host, without Electron', () => {
  test('A58 every channel is in the table built with no Claude, or named Electron only', () => {
    const table = registerHandlers(memoryHost().host);
    const served = [...table.keys()];
    expect(ELECTRON_ONLY_CHANNELS.length).toBeGreaterThan(0);
    expect(served.filter((c) => (ELECTRON_ONLY_CHANNELS as Channel[]).includes(c))).toEqual([]);
    expect([...served, ...ELECTRON_ONLY_CHANNELS].sort()).toEqual([...CHANNELS].sort());
  });

  test('A58 with Claude, as the Electron host has it, the table serves every channel of the contract', () => {
    const table = registerHandlers(memoryHost({ claude: fakeClaude }).host);
    expect([...table.keys()].sort()).toEqual([...CHANNELS].sort());
  });

  test('A58 a packaged host gets no test seam channels', () => {
    const table = registerHandlers(memoryHost({ isPackaged: true }).host);
    expect(table.has('test.seed')).toBe(false);
    expect(table.has('test.propose')).toBe(false);
    expect(table.has('bible.list')).toBe(true);
  });

  test('A58 the table runs through the same validation, and reaches the machine only through the host', async () => {
    const { host, themes } = memoryHost();
    const table = registerHandlers(host);
    const call = (channel: Channel, payload: unknown) =>
      runHandler(channel, table.get(channel)!, payload);
    expect(await call('app.ping', { message: 'hello' })).toMatchObject({ message: 'hello' });
    expect(await call('appearance.set', { appearance: 'dark' })).toEqual({ appearance: 'dark' });
    expect(themes).toEqual(['dark']);
    expect(await call('appearance.get', {})).toEqual({ appearance: 'dark' });
    // No browser and no save dialog on this host: plain refusals, nothing thrown raw.
    expect(await call('app.openExternal', { url: 'https://github.com/' })).toEqual({
      ok: false,
      message: 'This link opens only in the desktop app.',
    });
    await expect(
      call('tree.export', { fileName: 'tree', png: 'data:image/png;base64,AA==' }),
    ).rejects.toThrow(NO_SAVE_DIALOG);
  });

  test('A58 nothing the table imports statically is Electron, the keyring or the Agent SDK', async () => {
    const result = await build({
      entryPoints: [join(ROOT, 'src/main/ipc/handlers.ts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const inputs = Object.values(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(20);
    const staticImports = inputs.flatMap((i) =>
      i.imports.filter((m) => m.kind === 'import-statement' || m.kind === 'require-call'),
    );
    expect(staticImports.some((m) => m.path === 'mongodb')).toBe(true);
    expect(staticImports.filter((m) => BANNED.includes(m.path))).toEqual([]);
    // The host files are where Electron lives; none is in the table's graph but the types.
    const files = Object.keys(result.metafile.inputs);
    expect(files.some((f) => f.endsWith('src/main/host/electron.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('src/main/secrets.ts'))).toBe(false);
  });
});
