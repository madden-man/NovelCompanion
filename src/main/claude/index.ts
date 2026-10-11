import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ClaudeStreamEvent } from '../../shared/claude';
import type { ClaudeClient, ModelCatalog } from './client';
import { FakeClaudeClient, FakeModelCatalog, loadRecordings } from './fake';
import type { ClaudeDeps } from './handlers';
import { KeychainKeyStore, MemoryKeyStore } from './keys';
import type { KeyStore } from './keys';
import { AnthropicModelCatalog } from './models';
import { ClaudeRuntime } from './runtime';
import { SdkClaudeClient } from './sdk';
import { FileSettingsStore } from './settings';

export { ClaudeRuntime } from './runtime';
export type { FeatureDefinition, RunStart, DraftOrProblem } from './runtime';
export type { ClaudeClient, ClaudeRequest, ClaudeEvent, ClaudeTool } from './client';
export { PROSE_PROHIBITION, systemPrompt, material } from './prompts';

/**
 * End-to-end tests set this (outside a packaged app only) so the app uses a
 * key held in memory, the fake model list, and recorded Claude responses:
 * no test touches the real keychain or the API (T-3).
 */
export const TEST_CLAUDE_ENV = 'NOVEL_COMPANION_TEST_CLAUDE';
export const TEST_ANTHROPIC_KEY_ENV = 'NOVEL_COMPANION_TEST_ANTHROPIC_KEY';
export const TEST_RECORDINGS_ENV = 'NOVEL_COMPANION_TEST_CLAUDE_RECORDINGS';
export const TEST_STEP_DELAY_ENV = 'NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS';

/** When packaged, the SDK's bundled binary is unpacked beside app.asar (electron-builder asarUnpack). */
function packagedExecutable(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const dir = require.resolve(`${pkg}/package.json`).replace(/package\.json$/, '');
    return join(dir, 'claude').replace(`app.asar${'/'}`, 'app.asar.unpacked/');
  } catch {
    return undefined;
  }
}

export function claudeDeps(opts: {
  isPackaged: boolean;
  userData: string;
  appRoot: string;
  env: NodeJS.ProcessEnv;
  version: string;
  emit(event: ClaudeStreamEvent): void;
}): ClaudeDeps {
  const testing = !opts.isPackaged && opts.env[TEST_CLAUDE_ENV] === '1';
  let keys: KeyStore;
  let catalog: ModelCatalog;
  let client: ClaudeClient;
  if (testing) {
    keys = new MemoryKeyStore(opts.env[TEST_ANTHROPIC_KEY_ENV] || null);
    catalog = new FakeModelCatalog();
    const path =
      opts.env[TEST_RECORDINGS_ENV] || join(opts.appRoot, 'fixtures/claude/recordings.json');
    client = new FakeClaudeClient(loadRecordings(path), Number(opts.env[TEST_STEP_DELAY_ENV]) || 0);
  } else {
    keys = new KeychainKeyStore();
    catalog = new AnthropicModelCatalog();
    client = new SdkClaudeClient({
      configDir: join(opts.userData, 'claude'),
      clientApp: `novel-companion/${opts.version}`,
      executablePath: opts.isPackaged ? packagedExecutable() : undefined,
    });
  }
  const runtime = new ClaudeRuntime({
    client,
    keys,
    settings: new FileSettingsStore(join(opts.userData, 'claude-settings.json')),
    emit: opts.emit,
  });
  return { runtime, keys, catalog };
}
