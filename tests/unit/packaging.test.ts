import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const builder = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * NF-4 checks on the packaging configuration that run in `npm test`. The built
 * bundle itself is inspected by `npm run test:package-smoke` (tests/package).
 */
describe('NF-4 packaging configuration', () => {
  test('NF-4 npm run package builds an unsigned macOS dmg for arm64 into release/', () => {
    expect(pkg.scripts.package).toBe('electron-vite build && electron-builder --mac dmg');
    expect(builder).toMatch(/^ {2}output: release$/m);
    expect(builder).toMatch(/- target: dmg\s+arch: \[arm64\]/);
    expect(builder).toMatch(/^ {2}identity: null$/m);
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^release\/$/m);
  });

  test('NF-4 ARCH-4 native modules and the Agent SDK are unpacked from app.asar', () => {
    const unpack = builder.slice(builder.indexOf('asarUnpack:'), builder.indexOf('\nmac:'));
    expect(unpack).toContain("'**/*.node'");
    expect(unpack).toContain("'**/node_modules/@anthropic-ai/claude-agent-sdk*/**'");
  });

  test('NF-4 T-4 the packaged smoke test and the journey have their own scripts, outside npm test', () => {
    expect(pkg.scripts['test:package-smoke']).toContain('playwright.package.config.ts');
    expect(pkg.scripts['test:journey']).toContain('playwright.journey.config.ts');
    expect(pkg.scripts.test).not.toContain('package-smoke');
    expect(pkg.scripts.test).not.toContain('journey');
  });
});
