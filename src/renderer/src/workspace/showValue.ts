import { formatStoryDate } from '../../../shared/domain/dates';
import { isPlainObject } from '../../../shared/domain/paths';

/** A field value in plain text, for a side-by-side change view. */
export function showValue(v: unknown): string {
  if (v === undefined) return 'Not set';
  if (v === null || v === '') return 'Blank';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'None';
    return v.map((x) => showValue(x)).join('; ');
  }
  if (isPlainObject(v)) {
    if ('year' in v || 'unknown' in v) return formatStoryDate(v as never);
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${showValue(x)}`)
      .join(', ');
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
