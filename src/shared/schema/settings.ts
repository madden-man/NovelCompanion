import { z } from 'zod';
import { Year } from './common';

/**
 * A47: the bible's own settings, kept in one `meta` document
 * (`bibleSettings`). Every part is optional when stored; the helpers below
 * fill in the defaults, so a bible made before A47 reads the values it always
 * had.
 */

/** IP-10: the span of years the Cultural data screen steps over. */
export const CULTURE_UNITS = ['decade', 'five', 'one'] as const;
export type CultureUnit = (typeof CULTURE_UNITS)[number];

/** How many years each cultural unit covers. */
export const CULTURE_UNIT_YEARS: Record<CultureUnit, number> = { decade: 10, five: 5, one: 1 };

const Whole = (min: number, max: number, what: string) =>
  z
    .int(`${what} is a whole number of years.`)
    .min(min, `${what} is ${min} or more.`)
    .max(max, `${what} is ${max} or fewer.`);

/** IP-11: the per-bible numbers. */
export const BibleNumbers = z
  .strictObject({
    /** The first year of both grids (default 2025). */
    timelineStart: Year,
    /** The last year of both grids (default 2100). */
    timelineEnd: Year,
    /** Years before the story year the world window and the brief take in (default 3). */
    windowBefore: Whole(0, 200, 'Years before'),
    /** Years after the story year the world window and the brief look ahead (default 1). */
    windowAfter: Whole(0, 200, 'Years after'),
    /** Years either side of a moment the Relevant world events picker reaches (default 1). */
    pickerReach: Whole(0, 100, 'The picker reach'),
    /**
     * Milliseconds after the last keystroke before a field saves (default 500).
     * At most 750, so the longest wait stays under a second (BK-4).
     */
    autosaveMs: z
      .int('The autosave delay is a whole number of milliseconds.')
      .min(100, 'The autosave delay is at least 100 milliseconds.')
      .max(
        750,
        'The autosave delay is at most 750 milliseconds, so a change saves within a second.',
      ),
  })
  .refine((n) => n.timelineEnd > n.timelineStart, {
    message: 'The last year of the timeline comes after the first.',
    path: ['timelineEnd'],
  });
export type BibleNumbers = z.infer<typeof BibleNumbers>;

export const DEFAULT_NUMBERS: BibleNumbers = {
  timelineStart: 2025,
  timelineEnd: 2100,
  windowBefore: 3,
  windowAfter: 1,
  pickerReach: 1,
  autosaveMs: 500,
};

/** IP-11: the longest an edit waits before it saves: the larger of 700 and the delay plus 200. */
export function autosaveMaxMs(numbers: Pick<BibleNumbers, 'autosaveMs'>): number {
  return Math.max(700, numbers.autosaveMs + 200);
}

/** DB-2: the brief's section headings, in order, as the app has always written them. */
export const DEFAULT_BRIEF_HEADINGS = [
  '1. Characters and their ages',
  '2. World events ongoing',
  '3. Cultural expectations',
  '4. Places',
  '5. Backstory',
  '6. Previous chapters',
  '7. Glossary and open questions',
  '8. Last session note',
  '9. Added by you',
] as const;

/** The tree legend's labels for each union and parent link type (FT-1). */
export const DEFAULT_LINK_TYPE_LABELS: Record<string, string> = {
  married: 'Married',
  partnered: 'Partnered',
  biological: 'Biological parent',
  adoptive: 'Adoptive parent',
  step: 'Step parent',
  guardian: 'Guardian parent',
};

const Name = z
  .string()
  .trim()
  .min(1, 'A default name cannot be empty.')
  .max(200, 'A default name is 200 characters or fewer.');

/** IP-14: the names everything that creates a thing starts it with. `{n}` is its number. */
export const BibleTemplates = z.strictObject({
  chapterTitle: Name,
  sectionTitle: Name,
  partTitle: Name,
  bookTitle: Name,
  strandPresent: Name,
  strandBackstory: Name,
  eraName: Name,
  briefHeadings: z.array(Name).length(DEFAULT_BRIEF_HEADINGS.length),
  linkTypeLabels: z.record(z.string().min(1).max(64), Name),
});
export type BibleTemplates = z.infer<typeof BibleTemplates>;

export const DEFAULT_TEMPLATES: BibleTemplates = {
  chapterTitle: 'New chapter',
  sectionTitle: 'New section',
  partTitle: 'Part {n}',
  bookTitle: 'Book {n}',
  strandPresent: 'present',
  strandBackstory: 'backstory',
  eraName: 'New era',
  briefHeadings: [...DEFAULT_BRIEF_HEADINGS],
  linkTypeLabels: { ...DEFAULT_LINK_TYPE_LABELS },
};

/** The whole settings, defaults filled in. */
export const BibleSettings = z.strictObject({
  cultureUnit: z.enum(CULTURE_UNITS),
  numbers: BibleNumbers,
  templates: BibleTemplates,
});
export type BibleSettings = z.infer<typeof BibleSettings>;

export const DEFAULT_BIBLE_SETTINGS: BibleSettings = {
  cultureUnit: 'decade',
  numbers: DEFAULT_NUMBERS,
  templates: DEFAULT_TEMPLATES,
};

/** A change to the settings: any part, any field of a part. */
export const BibleSettingsPatch = z.strictObject({
  cultureUnit: z.enum(CULTURE_UNITS).optional(),
  numbers: z
    .strictObject({
      timelineStart: Year.optional(),
      timelineEnd: Year.optional(),
      windowBefore: z.int().optional(),
      windowAfter: z.int().optional(),
      pickerReach: z.int().optional(),
      autosaveMs: z.int().optional(),
    })
    .optional(),
  templates: z
    .strictObject({
      chapterTitle: z.string().optional(),
      sectionTitle: z.string().optional(),
      partTitle: z.string().optional(),
      bookTitle: z.string().optional(),
      strandPresent: z.string().optional(),
      strandBackstory: z.string().optional(),
      eraName: z.string().optional(),
      briefHeadings: z.array(z.string()).optional(),
      linkTypeLabels: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
export type BibleSettingsPatch = z.infer<typeof BibleSettingsPatch>;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The settings from whatever is stored (a `meta` document, part of one, or
 * nothing), each value that is missing or no longer valid replaced by its
 * default. Never throws.
 */
export function bibleSettings(stored: unknown): BibleSettings {
  const raw = obj(stored);
  const unit =
    CULTURE_UNITS.find((u) => u === raw.cultureUnit) ?? DEFAULT_BIBLE_SETTINGS.cultureUnit;
  const n = obj(raw.numbers);
  const numbers = { ...DEFAULT_NUMBERS };
  for (const k of Object.keys(DEFAULT_NUMBERS) as (keyof BibleNumbers)[]) {
    const tryIt = { ...numbers, [k]: n[k] };
    if (n[k] !== undefined && BibleNumbers.safeParse(tryIt).success) numbers[k] = n[k] as number;
  }
  if (!BibleNumbers.safeParse(numbers).success) {
    numbers.timelineStart = DEFAULT_NUMBERS.timelineStart;
    numbers.timelineEnd = DEFAULT_NUMBERS.timelineEnd;
  }
  return { cultureUnit: unit, numbers, templates: templates(raw) };
}

/** IP-14: the templates of the settings (stored or whole), with the defaults filled in. */
export function templates(settings: unknown): BibleTemplates {
  const t = obj(obj(settings).templates);
  const out: BibleTemplates = {
    ...DEFAULT_TEMPLATES,
    briefHeadings: [...DEFAULT_TEMPLATES.briefHeadings],
    linkTypeLabels: { ...DEFAULT_TEMPLATES.linkTypeLabels },
  };
  const shape = BibleTemplates.shape;
  for (const k of Object.keys(DEFAULT_TEMPLATES) as (keyof BibleTemplates)[]) {
    const r = shape[k].safeParse(t[k]);
    if (r.success) (out as Record<string, unknown>)[k] = r.data;
  }
  out.linkTypeLabels = { ...DEFAULT_LINK_TYPE_LABELS, ...out.linkTypeLabels };
  return out;
}

/** "Part {n}" with n = 2 is "Part 2". A template with no `{n}` is used as it is. */
export function fillTemplate(template: string, n?: number): string {
  return template.replace(/\{n\}/g, n === undefined ? '' : String(n)).trim();
}
