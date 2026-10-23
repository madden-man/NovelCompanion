/**
 * The selection as material (SB-4): the list of entries the alignment check
 * gives Claude (CC-3), and the IDs a text cites. Pure text functions.
 *
 * Citations are written `[[ID]]`.
 */
import type { GroupKind, Selection } from './selection';

const CITE = /\[\[([A-Za-z0-9_-]{1,64})\]\]/g;

/** Every ID a brief cites, once each, in the order first cited. */
export function citedIds(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(CITE)) {
    const id = m[1] as string;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** One entry as Claude receives it for a brief (SB-4): only what the selection holds. */
export interface BriefMaterial {
  id: string;
  collection: string;
  group: GroupKind;
  strand: string | null;
  title: string;
  status: string;
  /** A47 (IP-9): the status kind SB-5 reads; absent on runs saved before A47. */
  kind?: 'canon' | 'planned' | 'idea';
  note: string;
  detail: string;
  refs: string[];
}

/** SB-4: the manifest's contents, the only material a synthesized brief may draw on. */
export function briefMaterial(sel: Selection): BriefMaterial[] {
  const out: BriefMaterial[] = [];
  for (const s of sel.strands) {
    for (const g of s.groups) {
      for (const it of g.items) out.push({ ...it, group: g.kind, strand: s.label });
    }
  }
  for (const g of sel.shared) {
    for (const it of g.items) out.push({ ...it, group: g.kind, strand: null });
  }
  return out.map((m) => ({
    id: m.id,
    collection: m.collection,
    group: m.group,
    strand: m.strand,
    title: m.title,
    status: m.status,
    ...(m.kind ? { kind: m.kind } : {}),
    note: m.note,
    detail: m.detail,
    refs: m.refs,
  }));
}
