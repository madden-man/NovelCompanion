import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Appearance } from '../shared/ipcApp';

/**
 * App-wide settings that belong to no bible (ST-1): for now the appearance.
 * Kept beside `claude-settings.json` in the app's data folder. No secret is
 * ever in it; secrets live in the keychain (ARCH-5).
 */
export const AppSettings = z.object({
  appearance: Appearance.default('system'),
});
export type AppSettings = z.infer<typeof AppSettings>;

export interface AppSettingsStore {
  read(): AppSettings;
  write(next: AppSettings): void;
}

export class FileAppSettingsStore implements AppSettingsStore {
  constructor(private readonly path: string) {}

  read(): AppSettings {
    try {
      return AppSettings.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return AppSettings.parse({});
    }
  }

  write(next: AppSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(AppSettings.parse(next), null, 2));
    renameSync(tmp, this.path);
  }
}
