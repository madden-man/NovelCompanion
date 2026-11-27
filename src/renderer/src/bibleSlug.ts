import { RESERVED_SLUGS, slugify } from '../../shared/bible';

/**
 * A57: the ID of a new bible, made from its name, never one already taken.
 * A name with nothing usable in it becomes "bible"; a taken ID gets -2, -3 and on.
 */
export function uniqueSlug(name: string, taken: readonly string[]): string {
  const base = slugify(name) || 'bible';
  const used = new Set([...taken, ...RESERVED_SLUGS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(id)) return id;
  }
}
