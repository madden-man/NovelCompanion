import type { FieldSpec } from '../schema/manifest';
import type { Doc } from './paths';

/** A fresh ID for a nested item such as a strand or a custom field. */
export function newNestedId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** The starting value of a field in a new entry or a new list item. */
export function blankValue(spec: FieldSpec, today = new Date()): unknown {
  switch (spec.kind) {
    case 'text':
      return spec.nullable ? null : '';
    case 'longText':
      return '';
    case 'storyDate':
      return spec.nullable ? null : { unknown: true };
    case 'calendarDate':
      return today.toISOString().slice(0, 10);
    case 'boolean':
      return false;
    case 'enum':
      return spec.nullable ? null : (spec.options?.[0]?.value ?? null);
    case 'tags':
    case 'strings':
    case 'listItems':
    case 'refs':
    case 'links':
    case 'objectList':
      return [];
    case 'refPair':
      return ['', ''];
    case 'object':
      return blankItem(spec.fields ?? [], today);
    case 'system':
      return newNestedId();
    default:
      return null;
  }
}

/** A new nested item: system IDs, required fields, nothing else (defaults fill the rest). */
export function blankItem(fields: readonly FieldSpec[], today = new Date()): Doc {
  const out: Doc = {};
  for (const f of fields) {
    if (f.kind === 'system' || f.required) out[f.name] = blankValue(f, today);
  }
  return out;
}

/** A new top-level entry for the create form: required fields only, status preset to idea. */
export function blankEntry(manifest: readonly FieldSpec[], today = new Date()): Doc {
  const out: Doc = {};
  for (const f of manifest) {
    if (f.kind === 'system' || !f.required) continue;
    out[f.name] = f.name === 'status' ? 'idea' : blankValue(f, today);
  }
  return out;
}
