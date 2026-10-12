import { readFileSync } from 'node:fs';

/**
 * NF-2 contrast measurement: read the renderer's CSS, resolve its tokens in
 * each theme, and compute WCAG 2 contrast ratios. Pure functions over text,
 * so the check runs in the unit suite without a browser.
 */

export type Rgba = [number, number, number, number];

export interface Rule {
  file: string;
  selector: string;
  /** The @media or other at-rule the rule sits in, '' at the top level. */
  at: string;
  decls: Map<string, string>;
}

/** Split CSS into rules, descending into @media blocks. Comments are dropped. */
export function parseCss(css: string, file: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (src: string, at: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@')) {
        if (/^@(media|supports|layer)/.test(head)) walk(body, head);
      } else {
        const decls = new Map<string, string>();
        for (const part of body.split(';')) {
          const k = part.indexOf(':');
          if (k < 0) continue;
          decls.set(part.slice(0, k).trim(), part.slice(k + 1).trim());
        }
        rules.push({ file, selector: head.replace(/\s+/g, ' '), at, decls });
      }
      i = j;
    }
  };
  walk(text, '');
  return rules;
}

export function readRules(files: string[]): Rule[] {
  return files.flatMap((f) => parseCss(readFileSync(f, 'utf8'), f));
}

/** Token values for one theme: light is `:root`; dark lays `:root[data-theme='dark']` over it. */
export function themeTokens(rules: Rule[], theme: 'light' | 'dark'): Map<string, string> {
  const out = new Map<string, string>();
  const take = (r: Rule) => {
    for (const [k, v] of r.decls) if (k.startsWith('--')) out.set(k, v);
  };
  for (const r of rules) if (r.at === '' && r.selector === ':root') take(r);
  if (theme === 'dark') {
    for (const r of rules) {
      if (r.at === '' && /^:root\[data-theme=['"]dark['"]\]$/.test(r.selector)) take(r);
    }
  }
  return out;
}

/** The token block the system dark preference applies, to check it matches the explicit one. */
export function mediaDarkTokens(rules: Rule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (/prefers-color-scheme:\s*dark/.test(r.at)) {
      for (const [k, v] of r.decls) if (k.startsWith('--')) out.set(k, v);
    }
  }
  return out;
}

const hex = (h: string): Rgba => {
  let s = h.slice(1);
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('');
  const n = (k: number) => parseInt(s.slice(k, k + 2), 16);
  return [n(0), n(2), n(4), s.length === 8 ? n(6) / 255 : 1];
};

const NAMED: Record<string, Rgba> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Split on commas or spaces at the top level of a value. */
function topLevel(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// sRGB <-> OKLab, for color-mix(in oklab, ...).
const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
};
function toOklab([r, g, b]: Rgba): [number, number, number] {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: [number, number, number], alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

/** Resolve a CSS color value against the tokens, or null when it is not a color. */
export function resolveColor(value: string, tokens: Map<string, string>, depth = 0): Rgba | null {
  if (depth > 10) return null;
  const v = value.trim().replace(/\s*!important$/, '');
  const varM = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (varM) {
    const t = tokens.get(varM[1]!);
    if (t !== undefined) return resolveColor(t, tokens, depth + 1);
    return varM[2] ? resolveColor(varM[2], tokens, depth + 1) : null;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return hex(v);
  if (Object.hasOwn(NAMED, v)) return [...NAMED[v]!] as Rgba;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const p = rgb[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  const mix = /^color-mix\(\s*in\s+(oklab|srgb)\s*,(.+)\)$/.exec(v);
  if (mix) {
    const parts = topLevel(mix[2]!, ',');
    const read = (p: string) => {
      const bits = topLevel(p, ' ');
      const pct = bits.find((b) => /%$/.test(b));
      const col = bits.filter((b) => !/%$/.test(b)).join(' ');
      return {
        color: resolveColor(col, tokens, depth + 1),
        pct: pct ? parseFloat(pct) / 100 : null,
      };
    };
    const [a, b] = [read(parts[0]!), read(parts[1]!)];
    if (!a.color || !b.color) return null;
    const pa = a.pct ?? (b.pct !== null ? 1 - b.pct : 0.5);
    const pb = b.pct ?? 1 - pa;
    const alpha = a.color[3] * pa + b.color[3] * pb;
    if (alpha === 0) return [0, 0, 0, 0];
    // Premultiplied interpolation, as CSS Color 5 specifies.
    const wa = (a.color[3] * pa) / alpha;
    const wb = (b.color[3] * pb) / alpha;
    if (mix[1] === 'srgb') {
      return [0, 1, 2].map((k) => a.color![k]! * wa + b.color![k]! * wb).concat(alpha) as Rgba;
    }
    const [la, lb] = [toOklab(a.color), toOklab(b.color)];
    return fromOklab(
      [0, 1, 2].map((k) => la[k]! * wa + lb[k]! * wb) as [number, number, number],
      alpha,
    );
  }
  return null;
}

/** Paint a translucent color over an opaque one. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((k) => top[k]! * a + bottom[k]! * (1 - a)).concat(1) as Rgba;
}

const luminance = ([r, g, b]: Rgba) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** WCAG 2 contrast ratio between two opaque colors. */
export function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The colour a border declaration paints, from `border`, `border-left`, or `border-color`. */
export function borderColorValue(prop: string, value: string): string | null {
  if (/^border(-(top|right|bottom|left|inline|block)(-(start|end))?)?-color$/.test(prop)) {
    return value;
  }
  if (/^(border(-(top|right|bottom|left|inline|block)(-(start|end))?)?|outline)$/.test(prop)) {
    if (/^(0|none)\b/.test(value)) return null;
    const bits = topLevel(value, ' ');
    return bits.find((b) => /^(var\(|#|rgb|color-mix|white|black)/.test(b)) ?? null;
  }
  if (prop === 'outline-color') return value;
  return null;
}
