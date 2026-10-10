import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

/** Common telemetry, analytics, and crash reporting packages (ARCH-7). */
const DENYLIST: RegExp[] = [
  /^@sentry\//,
  /^sentry/,
  /^raven/,
  /^@segment\//,
  /^analytics-node$/,
  /^@rudderstack\//,
  /^posthog/,
  /^mixpanel/,
  /^@amplitude\//,
  /^amplitude/,
  /^universal-analytics$/,
  /^electron-google-analytics/,
  /^ga-4-react$/,
  /^react-ga/,
  /^@bugsnag\//,
  /^bugsnag/,
  /^rollbar$/,
  /^newrelic$/,
  /^@newrelic\//,
  /^dd-trace$/,
  /^@datadog\//,
  /^applicationinsights$/,
  /^@microsoft\/applicationinsights/,
  /^@elastic\/apm/,
  /^elastic-apm/,
  /^logrocket/,
  /^@honeybadger-io\//,
  /^raygun/,
  /^trackjs$/,
  /^heap-api$/,
  /^@vercel\/analytics$/,
  /^electron-crash-reporter/,
  /^@opentelemetry\//,
];

/** Word-start matches, so an identifier such as isEntryCollection is not a hit. */
const forbidden = /\b(sentry|segment|posthog|mixpanel|amplitude)|(^|\W)ga\(|crashReporter/im;

const denied = (name: string) => DENYLIST.some((r) => r.test(name));

type Pkg = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe('ARCH-7 no telemetry, analytics, or crash reporters', () => {
  test('ARCH-7 package.json declares no telemetry packages', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Pkg;
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    });
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(denied)).toEqual([]);
  });

  test('ARCH-7 no installed package in the lockfile is a telemetry package', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    const names = Object.keys(lock.packages)
      .filter((p) => p.includes('node_modules/'))
      .map((p) => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter(denied)).toEqual([]);
  });

  test('ARCH-7 the denylist recognizes common telemetry packages', () => {
    for (const n of [
      '@sentry/electron',
      'posthog-js',
      'mixpanel-browser',
      '@amplitude/analytics-node',
      '@segment/analytics-next',
      'universal-analytics',
    ]) {
      expect(denied(n)).toBe(true);
    }
    expect(denied('mongodb')).toBe(false);
  });

  test('ARCH-7 the source pattern catches telemetry references', () => {
    for (const s of [
      "import * as Sentry from '@sentry/electron'",
      'analytics.segment.com',
      "window.ga('send')",
      "ga('create')",
      'posthog.init()',
      'crashReporter.start()',
    ]) {
      expect(forbidden.test(s), s).toBe(true);
    }
    expect(forbidden.test('isEntryCollection(name)')).toBe(false);
  });

  test('ARCH-7 no source file references a telemetry service or the crash reporter', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|cjs|html|css|json)$/.test(name)) files.push(p);
      }
    };
    ['src', 'scripts'].forEach((d) => walk(join(ROOT, d)));
    ['package.json', 'electron.vite.config.ts', 'electron-builder.yml'].forEach((f) =>
      files.push(join(ROOT, f)),
    );
    expect(files.length).toBeGreaterThan(10);
    const hits = files
      .filter((f) => forbidden.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
