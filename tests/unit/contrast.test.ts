import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  borderColorValue,
  contrast,
  mediaDarkTokens,
  over,
  readRules,
  resolveColor,
  themeTokens,
} from '../helpers/contrast';
import type { Rgba, Rule } from '../helpers/contrast';

/**
 * NF-2 contrast: every foreground and background token pair the renderer's
 * CSS uses, in both themes, computed from the token values (WCAG 2.x):
 * 4.5:1 for text, 3:1 for large text (24px, or 18.66px bold) and for the
 * borders, strokes, and focus indicators that carry meaning (WCAG 1.4.11).
 */
const R = join(import.meta.dirname, '../../src/renderer');
/** Every stylesheet under src/renderer, the token file first so its tokens resolve. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : [];
    });
}
const THEME = join(R, 'src/theme.css');
const CSS = [THEME, ...cssFiles(R).filter((f) => f !== THEME)];
const rules = readRules(CSS);
const THEMES = ['light', 'dark'] as const;

/** The surfaces any element without its own background can sit on. */
const AMBIENT = ['--bg', '--surface', '--surface-2'];
/** SVG text also sits on the chart surface. */
const SVG_AMBIENT = [...AMBIENT, '--chart-surface'];

/**
 * Token uses that are decoration, each with why. Everything else that draws
 * a border, a stroke, or an outline is held to 3:1.
 */
const DECORATIVE: { token: RegExp; why: string }[] = [
  {
    token: /^var\(--border\)$/,
    why: 'Dividers and panel edges; no control relies on --border alone (asserted below).',
  },
  { token: /^var\(--(grid|axis)\)$/, why: 'Chart gridlines; the labels carry the values.' },
  {
    token: /^var\(--chart-surface\)$/,
    why: 'A halo around timeline dots in the chart surface colour.',
  },
  {
    token: /^var\(--series-[1-4]\)$/,
    why: 'Family colour: every family mark also names the family or the person in text (chip label, legend, lifespan label), so colour is never the only carrier (WCAG 1.4.1).',
  },
];

const CONTROL = /(^|[\s,>+~])(input|select|textarea)\b|\.btn\b|\.picker\b|\.shape-toggle\b/;

interface Pair {
  theme: string;
  selector: string;
  prop: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
}

function sizePx(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^([\d.]+)(px|rem|em)$/.exec(v.trim());
  if (!m) return null;
  return m[2] === 'px' ? Number(m[1]) : Number(m[1]) * (m[2] === 'rem' ? 16 : 15);
}

function isLarge(r: Rule): boolean {
  const px = sizePx(r.decls.get('font-size'));
  if (px === null) return false;
  const weight = Number(r.decls.get('font-weight') ?? 400);
  return px >= 24 || (px >= 18.66 && weight >= 700);
}

/** The first colour in a `background` shorthand. */
function backgroundValue(r: Rule): string | null {
  const v = r.decls.get('background-color') ?? r.decls.get('background');
  if (!v) return null;
  if (/^(var\(|#|rgb|color-mix|transparent|white|black)/.test(v)) {
    const depth = [...v].reduce(
      (acc, ch, i) => {
        if (acc.end >= 0) return acc;
        if (ch === '(') acc.d += 1;
        if (ch === ')') acc.d -= 1;
        if (acc.d === 0 && /\s/.test(ch)) acc.end = i;
        return acc;
      },
      { d: 0, end: -1 },
    );
    return depth.end < 0 ? v : v.slice(0, depth.end);
  }
  return null;
}

/** Rules indexed by each selector in their list, top level and both themes alike. */
const bySelector = new Map<string, Rule[]>();
for (const r of rules) {
  for (const s of r.selector.split(',').map((x) => x.trim())) {
    bySelector.set(s, [...(bySelector.get(s) ?? []), r]);
  }
}

/** Less specific selectors that style the same element or its container. */
function ancestors(selector: string): string[] {
  const out: string[] = [];
  const plain = selector.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
  if (plain && plain !== selector) out.push(plain);
  const parts = plain.split(/\s*[\s>+~]\s*/).filter(Boolean);
  const last = parts.at(-1) ?? '';
  const classes = last.match(/\.[\w-]+/g) ?? [];
  if (classes.length > 1) {
    out.push([...parts.slice(0, -1), last.replace(classes.at(-1)!, '')].join(' '));
  }
  if (parts.length > 1) out.push(parts.slice(0, -1).join(' '));
  return out.filter((s) => s && s !== selector);
}

/** What a rule's text sits on: its own background, else a container's, else every ambient surface. */
function backgrounds(
  selector: string,
  tokens: Map<string, string>,
  ambient: string[],
  seen = new Set<string>(),
): { label: string; color: Rgba }[] {
  const base = ambient.map((k) => ({ label: k, color: resolveColor(`var(${k})`, tokens)! }));
  for (const s of [selector, ...ancestors(selector)]) {
    if (seen.has(s)) continue;
    seen.add(s);
    for (const r of bySelector.get(s) ?? []) {
      if (r.at && !/prefers-color-scheme/.test(r.at)) continue;
      const v = backgroundValue(r);
      const c = v ? resolveColor(v, tokens) : null;
      // Transparent shows whatever is behind the element: the ambient surfaces.
      if (c && c[3] === 0) return base;
      if (c && c[3] > 0) {
        const under = c[3] < 1 ? backgrounds(ancestors(s)[0] ?? '', tokens, ambient, seen) : base;
        return under.map((b) => ({ label: `${v} over ${b.label}`, color: over(c, b.color) }));
      }
    }
    if (s !== selector) {
      const deeper = backgrounds(s, tokens, ambient, seen);
      if (deeper.some((d) => !ambient.includes(d.label))) return deeper;
    }
  }
  return base;
}

function pairs(theme: (typeof THEMES)[number]): { pairs: Pair[]; unresolved: string[] } {
  const tokens = themeTokens(rules, theme);
  const out: Pair[] = [];
  const unresolved: string[] = [];
  const ambient = AMBIENT.map((k) => ({ label: k, color: resolveColor(`var(${k})`, tokens)! }));
  for (const r of rules) {
    if (r.at && !/prefers-color-scheme/.test(r.at)) continue;
    if (/prefers-color-scheme/.test(r.at)) continue; // the same tokens as data-theme dark, checked below
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      const svg = /^\.(t|tl-|sw)/.test(sel) && r.decls.has('fill');
      // Text: `color`, and `fill` on SVG text.
      const textProps = [
        'color',
        ...(svg && /text|name|years|state|label|-end\b|tl-lane/.test(sel) ? ['fill'] : []),
      ];
      for (const prop of textProps) {
        const v = r.decls.get(prop);
        if (!v || /inherit|currentColor|transparent/.test(v)) continue;
        const fg = resolveColor(v, tokens);
        if (!fg) {
          unresolved.push(`${sel} ${prop}: ${v}`);
          continue;
        }
        const min = isLarge(r) ? 3 : 4.5;
        for (const b of backgrounds(sel, tokens, prop === 'fill' ? SVG_AMBIENT : AMBIENT)) {
          out.push({
            theme,
            selector: sel,
            prop,
            fg: v,
            bg: b.label,
            ratio: contrast(over(fg, b.color), b.color),
            min,
          });
        }
      }
      // Borders, outlines, and SVG strokes that carry meaning: 3:1 against what is around them.
      for (const [prop, value] of r.decls) {
        const cv = prop === 'stroke' ? value : borderColorValue(prop, value);
        if (!cv || /currentColor|transparent|inherit|none/.test(cv)) continue;
        if (DECORATIVE.some((d) => d.token.test(cv.trim()))) continue;
        const c = resolveColor(cv, tokens);
        if (!c) {
          unresolved.push(`${sel} ${prop}: ${value}`);
          continue;
        }
        const around = prop === 'stroke' ? SVG_AMBIENT : AMBIENT;
        for (const b of around.map((k) => ({
          label: k,
          color: resolveColor(`var(${k})`, tokens)!,
        }))) {
          out.push({
            theme,
            selector: sel,
            prop,
            fg: cv,
            bg: b.label,
            ratio: contrast(over(c, b.color), b.color),
            min: 3,
          });
        }
      }
    }
  }
  void ambient;
  return { pairs: out, unresolved };
}

describe('NF-2 contrast of the token pairs in both themes', () => {
  test('NF-2 every stylesheet under src/renderer is read, the alignment screen among them', () => {
    expect(CSS.map((f) => f.slice(R.length + 1))).toEqual(
      expect.arrayContaining([
        'src/theme.css',
        'src/app.css',
        'src/workspace/claude.css',
        'src/workspace/sessions/alignment.css',
      ]),
    );
  });

  test('NF-2 the system dark preference and the dark setting use the same tokens', () => {
    const media = mediaDarkTokens(rules);
    const dark = themeTokens(rules, 'dark');
    const light = themeTokens(rules, 'light');
    expect(media.size).toBeGreaterThan(20);
    for (const [k, v] of media) expect(dark.get(k), k).toBe(v);
    for (const k of light.keys()) {
      if (dark.get(k) !== light.get(k)) expect(media.get(k), k).toBe(dark.get(k));
    }
  });

  for (const theme of THEMES) {
    test(`NF-2 every text pair meets 4.5:1 (3:1 when large) in the ${theme} theme`, () => {
      const { pairs: all, unresolved } = pairs(theme);
      expect(unresolved).toEqual([]);
      const text = all.filter((p) => p.prop === 'color' || p.prop === 'fill');
      expect(text.length).toBeGreaterThan(150);
      const failing = text
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.selector} ${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < ${p.min}`);
      expect(failing).toEqual([]);
    });

    test(`NF-2 every border, stroke, and focus outline that carries meaning meets 3:1 in the ${theme} theme`, () => {
      const ui = pairs(theme).pairs.filter((p) => p.prop !== 'color' && p.prop !== 'fill');
      expect(ui.length).toBeGreaterThan(60);
      const failing = ui
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.selector} ${p.prop} ${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < 3`);
      expect(failing).toEqual([]);
    });
  }

  test('NF-2 no control is outlined only by the decorative --border token', () => {
    const offenders = rules
      .filter((r) => r.selector.split(',').some((s) => CONTROL.test(s)))
      .filter((r) =>
        [...r.decls].some(([p, v]) => borderColorValue(p, v)?.trim() === 'var(--border)'),
      )
      .filter((r) => !/:(hover|disabled)|\[disabled\]/.test(r.selector))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  test('NF-2 every element that loses the default focus outline has a focus-visible indicator in its place', () => {
    const parts = (r: Rule) => r.selector.split(',').map((s) => s.trim());
    const removes = (r: Rule) =>
      r.decls.get('all') === 'unset' || /^(none|0)\b/.test(r.decls.get('outline') ?? '');
    const bases = new Set<string>();
    for (const r of rules) {
      if (!removes(r)) continue;
      for (const p of parts(r)) {
        if (/:(hover|active)\b/.test(p) && !/:focus/.test(p)) continue;
        bases.add(p.replace(/:focus(-visible)?\b.*$/, ''));
      }
    }
    expect(bases.size).toBeGreaterThan(3);
    const missing = [...bases].filter(
      (base) =>
        !rules.some(
          (x) =>
            parts(x).some((p) => p.startsWith(`${base}:focus-visible`)) &&
            [...x.decls].some(
              ([p, v]) => /^(outline|stroke|border)/.test(p) && !/^(none|0)\b/.test(v),
            ),
        ),
    );
    expect(missing).toEqual([]);
  });

  test('NF-2 a focus indicator drawn as a background still stands out by 3:1', () => {
    for (const theme of THEMES) {
      const tokens = themeTokens(rules, theme);
      for (const r of rules) {
        if (!/:focus-visible/.test(r.selector)) continue;
        if ([...r.decls.keys()].some((p) => /^(outline|stroke|border)/.test(p))) continue;
        // The element keeps the global outline unless a later rule for it declares one.
        const bases = r.selector
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.includes(':focus-visible'))
          .map((s) => s.replace(/:focus-visible.*$/, ''));
        const outlined = bases.every((b) =>
          rules.some(
            (x) =>
              x.selector.split(',').some((p) => p.trim() === `${b}:focus-visible`) &&
              /^\d/.test(x.decls.get('outline') ?? ''),
          ),
        );
        if (outlined) continue;
        const v = backgroundValue(r);
        if (!v) continue;
        const c = resolveColor(v, tokens)!;
        for (const k of AMBIENT) {
          const b = resolveColor(`var(${k})`, tokens)!;
          expect(
            contrast(over(c, b), b),
            `${theme} ${r.selector} ${v} on ${k}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});
