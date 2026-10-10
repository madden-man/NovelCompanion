import type { CustomField, CustomSection } from '../schema/custom';
import { isPlainObject } from './paths';

function check(field: CustomField, v: unknown): string | null {
  if (v === null) return null;
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'link':
      return typeof v === 'string' ? null : 'needs text';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'needs a number';
    case 'year':
      return Number.isInteger(v) ? null : 'needs a whole year';
    case 'yearRange':
      return isPlainObject(v) ? null : 'needs a year range';
    case 'singleChoice':
      if (typeof v !== 'string') return 'needs one of its choices';
      return field.options.includes(v) ? null : `has no choice called "${v}"`;
    case 'tags':
      return Array.isArray(v) && v.every((t) => typeof t === 'string') ? null : 'needs tags';
  }
}

/**
 * Problems with a custom entry's values against its section (CS-1). These are
 * shape errors, not story warnings, so the write path refuses them.
 */
export function customValueIssues(
  section: Pick<CustomSection, 'fields' | 'name'>,
  values: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(values)) {
    const field = section.fields.find((f) => f.id === key);
    if (!field) {
      issues.push(`The section ${section.name} has no field with the ID ${key}.`);
      continue;
    }
    const problem = check(field, values[key]);
    if (problem) issues.push(`${field.label} ${problem}.`);
  }
  return issues;
}
