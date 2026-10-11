import type { DocBlock, DocSection } from './document';
import { blocksToBody, sectionsAt, spanOf } from './document';

export interface EraDraft {
  name: string;
  startYear: number;
  endYear: number;
  /** Fields filled from sub-headings such as Technology or Daily life. */
  fields: Partial<Record<'technology' | 'climate' | 'economy' | 'politics' | 'dailyLife', string>>;
  /** Text under the heading that no sub-heading claims. */
  body: string;
  first: number;
  last: number;
}

/** A year range in a heading: "2030-2039", "2030 to 2039", "2030s", or one year. */
export function yearsInHeading(text: string): { start: number; end: number } | null {
  const range = /(\d{4})\s*(?:-|\u2013|\u2014|to|through|until)\s*(\d{4})/i.exec(text);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return b >= a ? { start: a, end: b } : null;
  }
  const decade = /\b(\d{3}0)s\b/.exec(text);
  if (decade) return { start: Number(decade[1]), end: Number(decade[1]) + 9 };
  const single = /\b(\d{4})\b/.exec(text);
  return single ? { start: Number(single[1]), end: Number(single[1]) } : null;
}

const SUB_FIELDS: [RegExp, keyof EraDraft['fields']][] = [
  [/^tech/i, 'technology'],
  [/^(climate|environment|weather)/i, 'climate'],
  [/^(econom|money|work|jobs)/i, 'economy'],
  [/^(politic|government|geopolit|war)/i, 'politics'],
  [/^(daily|everyday|life|culture|home)/i, 'dailyLife'],
];

const ERA_LINE = /^\d{4}(?:\s*[-\u2013\u2014]\s*\d{4})?\s*:\s*\S/;

/** A short line of capitals, such as `2039: THE HINGE` or `A NOTE ON THE THROUGHLINE`. */
function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 90 || /[.!?]$/.test(t)) return false;
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length > 0.8 || (ERA_LINE.test(t) && upper / letters.length > 0.5);
}

/**
 * Word documents written without heading styles often use capitals for
 * headings. Treat such short lines as top headings so they can split the text.
 */
export function promoteCapsHeadings(blocks: DocBlock[]): DocBlock[] {
  return blocks.map((b) =>
    b.kind === 'paragraph' && looksLikeHeading(b.text) ? { ...b, kind: 'heading', level: 1 } : b,
  );
}

/**
 * Era states from a document's headings (WE-1): each top heading with a year
 * range is an era; sub-headings named Technology, Climate, Economy, Politics,
 * or Daily life fill those fields; other text stays in the body.
 * Headings with no years are returned as `skipped` so nothing disappears silently.
 */
export function erasFromBlocks(source: DocBlock[]): { eras: EraDraft[]; skipped: DocSection[] } {
  const blocks = source.some((b) => b.kind === 'heading') ? source : promoteCapsHeadings(source);
  // The era level is the heading level that most headings with years sit at.
  const perLevel = new Map<number, number>();
  for (const b of blocks) {
    if (b.kind === 'heading' && yearsInHeading(b.text)) {
      perLevel.set(b.level, (perLevel.get(b.level) ?? 0) + 1);
    }
  }
  const levels = [...perLevel.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const eraLevel = levels[0]?.[0];
  if (eraLevel === undefined) {
    return { eras: [], skipped: sectionsAt(blocks, 4).filter((s) => s.blocks.length || s.heading) };
  }
  const eras: EraDraft[] = [];
  const skipped: DocSection[] = [];
  for (const section of sectionsAt(blocks, eraLevel)) {
    const years = section.heading ? yearsInHeading(section.heading.text) : null;
    if (!section.heading || !years || section.heading.level !== eraLevel) {
      const isUpper = section.heading !== null && section.heading.level < eraLevel;
      if (!isUpper && (section.blocks.length || section.heading)) skipped.push(section);
      continue;
    }
    const subs = sectionsAt(section.blocks, 4);
    const fields: EraDraft['fields'] = {};
    const rest: DocBlock[] = [];
    for (const sub of subs) {
      const subHeading = sub.heading;
      const field = subHeading
        ? SUB_FIELDS.find(([re]) => re.test(subHeading.text))?.[1]
        : undefined;
      if (field && sub.heading) {
        const text = blocksToBody(sub.blocks);
        fields[field] = fields[field] ? `${fields[field]}${text}` : text;
      } else rest.push(...(sub.heading ? [sub.heading] : []), ...sub.blocks);
    }
    const span = spanOf([section.heading, ...section.blocks]);
    eras.push({
      name: section.heading.text,
      startYear: years.start,
      endYear: years.end,
      fields,
      body: blocksToBody(rest),
      first: span.first,
      last: span.last,
    });
  }
  return { eras, skipped };
}
