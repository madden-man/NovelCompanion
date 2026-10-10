import { z } from 'zod';

/** Bible IDs are lowercase so collection names stay predictable; no dots, so prefixes never nest. */
export const BIBLE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** `bibles` is the registry collection, so no bible may use it as an ID. */
export const RESERVED_SLUGS: readonly string[] = ['bibles'];

export const BIBLE_SLUG_RULE =
  'Use up to 40 lowercase letters, digits, dashes, or underscores, starting with a letter or digit.';

export const BibleSlug = z
  .string()
  .regex(BIBLE_SLUG_PATTERN, BIBLE_SLUG_RULE)
  .refine((s) => !RESERVED_SLUGS.includes(s), { message: 'That ID is reserved.' });

export const BibleName = z.string().trim().min(1, 'A bible needs a name.').max(200);

/** Suggest an ID from a bible name. Returns an empty string when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
