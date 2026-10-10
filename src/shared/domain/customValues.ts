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

export interface CustomValueIssue {
  fieldId: string;
  message: string;
}

/**
 * Values that no longer fit their section (CS-1): a field that was removed, a
 * choice that is gone, or a value of another kind after the field changed.
 * They are ED-10 warnings, never a reason to refuse a write.
 */
export function customValueIssues(
  section: Pick<CustomSection, 'fields' | 'name'>,
  values: Record<string, unknown>,
): CustomValueIssue[] {
  const issues: CustomValueIssue[] = [];
  for (const key of Object.keys(values)) {
    const field = section.fields.find((f) => f.id === key);
    if (!field) {
      if (values[key] !== null) {
        issues.push({
          fieldId: key,
          message: `The section ${section.name} no longer has this field. The old value is kept.`,
        });
      }
      continue;
    }
    const problem = check(field, values[key]);
    if (problem) issues.push({ fieldId: key, message: `${field.label} ${problem}.` });
  }
  return issues;
}

/** True when a custom value counts as filled in, so removing its field would lose it. */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.values(v).some((x) => x !== null && x !== undefined);
  return true;
}
