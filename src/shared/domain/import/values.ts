import { newItemId } from '../lists';
import type { FieldSpec } from '../../schema/manifest';
import type { Cell, ListAdd, MapContext } from './types';

export type Coerced =
  { ok: true; value: unknown } | { ok: false; reason: string } | { ok: 'blank' };

const BLANK: Coerced = { ok: 'blank' };

/** A cell as trimmed text; whole numbers lose a trailing `.0`. Empty cells give an empty string. */
export function cellText(raw: Cell | undefined): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return Number.isInteger(raw) ? String(raw) : String(raw);
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  return raw.trim();
}

export function isBlank(raw: Cell | undefined): boolean {
  return cellText(raw) === '';
}

const ISO_DATE = /^(-?\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

/** A whole year from a cell: 2055, "2055", "2055.0", or an ISO date. Null when it is not one. */
export function parseYear(raw: Cell | undefined): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && Math.abs(raw) <= 10000 ? raw : null;
  }
  const text = raw.trim();
  const iso = ISO_DATE.exec(text);
  if (iso) return Number(iso[1]);
  if (/^-?\d{1,5}(\.0+)?$/.test(text)) {
    const n = Number(text);
    return Math.abs(n) <= 10000 ? n : null;
  }
  return null;
}

/** A year header such as 2055, "2055.0", "2030-2039", or "2030s": its first year and optional last. */
export function parseYearHeader(
  raw: Cell | undefined,
): { start: number; end: number | null } | null {
  const single = parseYear(raw);
  if (single !== null) return { start: single, end: null };
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const range = /^(-?\d{1,5})(?:\.0+)?\s*(?:-|\u2013|to)\s*(-?\d{1,5})(?:\.0+)?$/.exec(text);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Math.abs(a) <= 10000 && Math.abs(b) <= 10000 && b >= a) return { start: a, end: b };
  }
  const decade = /^(\d{3}0)s$/.exec(text);
  if (decade) return { start: Number(decade[1]), end: Number(decade[1]) + 9 };
  return null;
}

function fail(reason: string): Coerced {
  return { ok: false, reason };
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'x']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);

export function splitList(text: string): string[] {
  return text
    .split(/[;|\n]|,(?!\s*\d)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const quoted = (text: string) => `"${text.length > 40 ? `${text.slice(0, 37)}...` : text}"`;

export interface CoerceEnv {
  ctx: MapContext;
  addMissingListItems: boolean;
  createMissing: boolean;
  /** Choices added so far in this import, so later rows find them. */
  listAdds: ListAdd[];
  /** Resolve a name to an entry ID, or null; may record a stub to create. */
  resolveName: (spec: FieldSpec, name: string) => string | null | 'ambiguous';
}

function listChoice(spec: FieldSpec, text: string, env: CoerceEnv): Coerced {
  const listId = spec.listId ?? '';
  const list = env.ctx.list(listId);
  const items = [...(list?.items ?? []), ...env.listAdds.filter((a) => a.listId === listId)];
  const lower = text.toLowerCase();
  const hit = items.find((i) => i.label.toLowerCase() === lower || i.id.toLowerCase() === lower);
  if (hit) return { ok: true, value: hit.id };
  if (!env.addMissingListItems || listId === 'tags') {
    return fail(`${quoted(text)} is not in the ${spec.label} list`);
  }
  const draft = { _id: listId, label: listId, items: items.map((i) => ({ ...i })) };
  const id = newItemId(draft, text);
  env.listAdds.push({ listId, id, label: text, parentId: null });
  return { ok: true, value: id };
}

/**
 * Turn one cell into the value a field stores (IM-1, IM-2). A blank cell
 * gives `blank`, which leaves the field alone. A cell that does not fit gives
 * the reason in plain words.
 */
export function coerceCell(spec: FieldSpec, raw: Cell | undefined, env: CoerceEnv): Coerced {
  const text = cellText(raw);
  if (text === '') return BLANK;
  switch (spec.kind) {
    case 'text':
    case 'longText':
      return { ok: true, value: text };
    case 'int':
    case 'year': {
      const year = parseYear(raw);
      return year === null
        ? fail(`${quoted(text)} is not a whole number${spec.kind === 'year' ? ' year' : ''}`)
        : { ok: true, value: year };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : fail(`${quoted(text)} is not a number`);
    }
    case 'storyDate': {
      if (text.toLowerCase() === 'unknown') return { ok: true, value: { unknown: true } };
      const iso = ISO_DATE.exec(text);
      if (iso) {
        const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
        return { ok: true, value: { year: y, month: m, day: d } };
      }
      const year = parseYear(raw);
      return year === null
        ? fail(`${quoted(text)} is not a year, a date, or "unknown"`)
        : { ok: true, value: { year } };
    }
    case 'calendarDate': {
      const iso = ISO_DATE.exec(text);
      return iso ? { ok: true, value: text.slice(0, 10) } : fail(`${quoted(text)} is not a date`);
    }
    case 'boolean': {
      const word = text.toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return fail(`${quoted(text)} is not yes or no`);
    }
    case 'enum': {
      const options = spec.options ?? [];
      const lower = text.toLowerCase();
      const hit = options.find(
        (o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower,
      );
      return hit
        ? { ok: true, value: hit.value }
        : fail(`${quoted(text)} is not one of ${options.map((o) => o.label).join(', ')}`);
    }
    case 'color':
      return /^#[0-9a-f]{6}$/i.test(text)
        ? { ok: true, value: text.toLowerCase() }
        : fail(`${quoted(text)} is not a hex colour such as #2a78d6`);
    case 'listItem':
      return listChoice(spec, text, env);
    case 'listItems': {
      // A47 (IP-8): each name becomes the item ID, added to the list when the import may add.
      const ids: string[] = [];
      for (const name of splitList(text)) {
        const one = listChoice(spec, name, env);
        if (one.ok !== true) return one;
        if (!ids.includes(one.value as string)) ids.push(one.value as string);
      }
      return { ok: true, value: ids };
    }
    case 'tags':
    case 'strings':
      return { ok: true, value: splitList(text) };
    case 'ref': {
      const id = env.resolveName(spec, text);
      if (id === 'ambiguous') return fail(`More than one entry is called ${quoted(text)}`);
      return id ? { ok: true, value: id } : fail(`No entry is called ${quoted(text)}`);
    }
    case 'refs': {
      const ids: string[] = [];
      for (const name of splitList(text)) {
        const id = env.resolveName(spec, name);
        if (id === 'ambiguous') return fail(`More than one entry is called ${quoted(name)}`);
        if (!id) return fail(`No entry is called ${quoted(name)}`);
        if (!ids.includes(id)) ids.push(id);
      }
      return { ok: true, value: ids };
    }
    default:
      return fail(`${spec.label} cannot be filled from a spreadsheet column`);
  }
}

/** A saved pattern as a case blind expression, or null when it is not a valid one. */
export function labelRegex(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}
