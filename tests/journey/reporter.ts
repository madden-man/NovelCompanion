import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

const OUT = join(import.meta.dirname, '../../test-results/journey');

interface Row {
  n: number;
  title: string;
  status: string;
  seconds: string;
  shot: string | null;
  note: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Writes test-results/journey/report.md and report.html: every step in order
 * with pass, fail, fixme, or skipped, its time, the reason for a failure or a
 * fixme, and the screenshot taken at the end of the step.
 */
export default class JourneyReporter implements Reporter {
  private suite: Suite | null = null;
  private results = new Map<TestCase, TestResult>();

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.results.set(test, result);
  }

  onEnd(result: FullResult): void {
    if (!this.suite) return;
    const rows: Row[] = this.suite.allTests().map((test, i) => {
      const r = this.results.get(test);
      const fixme = test.annotations.find((a) => a.type === 'fixme');
      let status = r?.status ?? 'not run';
      if (status === 'skipped') status = fixme ? 'fixme' : 'skipped';
      if (status === 'timedOut') status = 'failed';
      if (status === 'passed') status = 'pass';
      if (status === 'failed') status = 'fail';
      const shot = r?.attachments.find((a) => a.name === 'screenshot' && a.path)?.path ?? null;
      const error = r?.errors[0]?.message?.split('\n')[0] ?? '';
      return {
        n: i + 1,
        title: test.title,
        status,
        seconds: r ? (r.duration / 1000).toFixed(1) : '',
        shot: shot ? relative(OUT, shot) : null,
        note: status === 'fixme' ? (fixme?.description ?? '') : error,
      };
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const summary = `${rows.length} steps: ${count('pass')} pass, ${count('fail')} fail, ${count('fixme')} fixme, ${count('skipped')} skipped. Run ${result.status}, ${new Date().toISOString()}.`;
    mkdirSync(OUT, { recursive: true });
    const md = [
      '# Journey report',
      '',
      summary,
      '',
      '| # | Step | Result | Seconds | Screenshot | Note |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.n} | ${r.title.replace(/\|/g, '/')} | ${r.status} | ${r.seconds} | ${r.shot ? `[png](${r.shot})` : ''} | ${r.note.replace(/\|/g, '/')} |`,
      ),
      '',
    ].join('\n');
    writeFileSync(join(OUT, 'report.md'), md);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journey report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:1100px}
.step{border-top:1px solid #ccd;padding:12px 0}.pass{color:#17663a}.fail{color:#a11}.fixme,.skipped{color:#6b4e00}
img{max-width:100%;border:1px solid #ccd;margin-top:8px}</style></head><body>
<h1>Journey report</h1><p>${esc(summary)}</p>
${rows
  .map(
    (r) =>
      `<section class="step" id="step-${r.n}"><h2>${r.n}. ${esc(r.title)}</h2><p class="${r.status}"><strong>${r.status}</strong> ${r.seconds ? `in ${r.seconds} s` : ''}${r.note ? `: ${esc(r.note)}` : ''}</p>${r.shot ? `<img alt="Screen at the end of step ${r.n}" src="${esc(r.shot)}">` : ''}</section>`,
  )
  .join('\n')}
</body></html>`;
    writeFileSync(join(OUT, 'report.html'), html);
  }

  printsToStdio(): boolean {
    return false;
  }
}
