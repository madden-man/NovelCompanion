import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('T-7 one command runs the full suite', () => {
  test('T-7 npm test runs lint, typecheck, unit, integration, and e2e in order and stops on the first failure', () => {
    expect(pkg.scripts.test).toBe(
      'npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run test:e2e',
    );
    for (const s of [
      'lint',
      'typecheck',
      'test:unit',
      'test:integration',
      'test:e2e',
      'test:live',
      'dev',
      'build',
      'package',
    ]) {
      expect(pkg.scripts[s], s).toBeTruthy();
    }
    expect(pkg.scripts.test).not.toContain('test:live');
    expect(pkg.scripts.test).not.toContain('||');
    expect(pkg.scripts.test).not.toContain(';');
  });

  test('T-7 every dependency is pinned to an exact version', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
