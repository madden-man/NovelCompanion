/**
 * The paths in a value that its schema has no field for, at any depth. A
 * proposal is checked with this when it is made (ED-7), so a field A39
 * dropped, top level or nested (for example `names.romanization`), is refused
 * then and not when the proposal is approved.
 */
import type { z } from 'zod';
import { isPlainObject } from './paths';

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
}

const def = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

function unwrap(s: z.ZodType): z.ZodType {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const d = def(cur);
    if (WRAPPERS.has(d.type) && d.innerType) cur = d.innerType;
    else if (d.type === 'pipe' && d.in) cur = d.in;
    else break;
  }
  return cur;
}

const join = (base: string, key: string | number) => (base ? `${base}.${key}` : String(key));

/** Every path in `value` that `schema` has no field for. Own keys only. */
export function unknownPaths(schema: z.ZodType, value: unknown, path = ''): string[] {
  const s = unwrap(schema);
  const d = def(s);
  const { shape, element } = d;
  if (d.type === 'object' && shape && isPlainObject(value)) {
    // A strict object refuses keys it does not name; a loose one keeps or strips them.
    const strict = d.catchall !== undefined && def(d.catchall).type === 'never';
    const out: string[] = [];
    for (const k of Object.keys(value)) {
      const field = Object.hasOwn(shape, k) ? shape[k] : undefined;
      if (field) out.push(...unknownPaths(field, value[k], join(path, k)));
      else if (strict) out.push(join(path, k));
    }
    return out;
  }
  if (d.type === 'array' && element && Array.isArray(value)) {
    return value.flatMap((v, i) => unknownPaths(element, v, join(path, i)));
  }
  if (d.type === 'union' && d.options) {
    let best: string[] | null = null;
    for (const o of d.options) {
      const r = unknownPaths(o, value, path);
      if (r.length === 0) return [];
      if (!best || r.length < best.length) best = r;
    }
    return best ?? [];
  }
  return [];
}
