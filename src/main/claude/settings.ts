import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CLAUDE_FEATURES, ClaudeFeature, DEFAULT_MODELS } from '../../shared/claude';

/**
 * App-wide Claude settings (DB-4, AI-6): the model per feature and when the
 * disclosure was confirmed. They belong to the app, not to a bible, so they
 * live in a small JSON file in the app's data folder. No secret is in it:
 * the key is in the keychain (ARCH-5).
 */
export const ClaudeSettings = z.object({
  models: z.partialRecord(ClaudeFeature, z.string().min(1).max(100)).default({}),
  /** AI-6: when the disclosure was confirmed, by bible ID (the first use in each bible). */
  acknowledged: z.record(z.string(), z.string()).default({}),
});
export type ClaudeSettings = z.infer<typeof ClaudeSettings>;

export interface SettingsStore {
  read(): ClaudeSettings;
  write(next: ClaudeSettings): void;
}

/** Defaults filled in for every feature the person has not changed. */
export function modelsWithDefaults(s: ClaudeSettings): Record<ClaudeFeature, string> {
  return Object.fromEntries(
    CLAUDE_FEATURES.map((f) => [f, s.models[f] ?? DEFAULT_MODELS[f]]),
  ) as Record<ClaudeFeature, string>;
}

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly path: string) {}

  read(): ClaudeSettings {
    try {
      return ClaudeSettings.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return ClaudeSettings.parse({});
    }
  }

  write(next: ClaudeSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ClaudeSettings.parse(next), null, 2));
    renameSync(tmp, this.path);
  }
}

export class MemorySettingsStore implements SettingsStore {
  private value: ClaudeSettings = ClaudeSettings.parse({});
  read(): ClaudeSettings {
    return structuredClone(this.value);
  }
  write(next: ClaudeSettings): void {
    this.value = ClaudeSettings.parse(structuredClone(next));
  }
}
