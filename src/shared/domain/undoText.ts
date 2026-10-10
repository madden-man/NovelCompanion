/**
 * Which text the focused field counts as saved after a save lands (ED-3, M1
 * review fix). Only the field that was part of the saved entry changes its
 * saved value, and it takes the value that was stored, not whatever the field
 * holds now. A field outside the saved entry keeps its saved value, so its
 * unsaved typing is still undone by Cmd+Z.
 */
import { getPath } from './paths';
import type { Doc } from './paths';

/** The stored text of a field path, or undefined when the path is not a text value of the entry. */
export function savedFieldText(saved: Doc, path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const v = getPath(saved, path);
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
