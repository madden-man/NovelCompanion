import type { FieldSpec } from '../schema/manifest';
import { isPlainObject, joinPath } from './paths';
import type { Doc } from './paths';

/** One reference from an entry to another, found through the field manifest. */
export interface OutgoingRef {
  targetId: string;
  /** The link kind for `links`, or the field label path for reference fields. */
  kind: string;
  /** Where the reference sits, for example `strands.0.characterIds.1`. */
  path: string;
  /** The collections the field allows, or `['*']`. */
  target: string[];
}

function walk(
  specs: readonly FieldSpec[],
  value: Doc,
  base: string,
  labelBase: string,
  out: OutgoingRef[],
): void {
  for (const s of specs) {
    const v = value[s.name];
    const path = joinPath(base, s.name);
    const label = labelBase ? `${labelBase}: ${s.label}` : s.label;
    const target = s.target ?? ['*'];
    switch (s.kind) {
      case 'ref':
        if (typeof v === 'string' && v) out.push({ targetId: v, kind: label, path, target });
        break;
      case 'refs':
      case 'refPair':
        if (Array.isArray(v)) {
          v.forEach((id, i) => {
            if (typeof id === 'string' && id) {
              out.push({ targetId: id, kind: label, path: joinPath(path, i), target });
            }
          });
        }
        break;
      case 'links':
        if (Array.isArray(v)) {
          v.forEach((l, i) => {
            if (isPlainObject(l) && typeof l.targetId === 'string') {
              out.push({
                targetId: l.targetId,
                kind: typeof l.kind === 'string' ? l.kind : 'link',
                path: joinPath(path, i),
                target: ['*'],
              });
            }
          });
        }
        break;
      case 'object':
        if (isPlainObject(v) && s.fields) walk(s.fields, v, path, label, out);
        break;
      case 'objectList':
        if (Array.isArray(v) && s.fields) {
          const fields = s.fields;
          v.forEach((item, i) => {
            if (isPlainObject(item)) {
              walk(fields, item, joinPath(path, i), label, out);
            }
          });
        }
        break;
      default:
        break;
    }
  }
}

/** Every reference an entry makes: its links and every reference field (ED-9). */
export function outgoingRefs(manifest: readonly FieldSpec[], doc: Doc): OutgoingRef[] {
  const out: OutgoingRef[] = [];
  walk(manifest, doc, '', '', out);
  return out;
}
