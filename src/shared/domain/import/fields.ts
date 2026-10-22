import { f, manifests } from '../../schema';
import type { FieldSpec } from '../../schema';
import { getPath, isPlainObject } from '../paths';
import type { Doc } from '../paths';
import type { Target } from './types';

export interface ImportField {
  /** A field path such as `title`, `names.full`, `values.<id>`, or `strand.startYear`. */
  path: string;
  label: string;
  spec: FieldSpec;
}

/** Field kinds a spreadsheet column can fill. */
const FILLABLE = new Set([
  'text',
  'longText',
  'int',
  'number',
  'year',
  'storyDate',
  'calendarDate',
  'boolean',
  'enum',
  'listItem',
  'listItems',
  'color',
  'tags',
  'strings',
  'ref',
  'refs',
]);

/** Fields the importer sets or the app owns. */
const NOT_IMPORTABLE = new Set(['sourceRef']);

function collect(
  specs: readonly FieldSpec[],
  prefix: string,
  labelPrefix: string,
  out: ImportField[],
  depth: number,
): void {
  for (const spec of specs) {
    if (spec.derived || spec.kind === 'system' || NOT_IMPORTABLE.has(spec.name)) continue;
    const path = prefix + spec.name;
    const label = labelPrefix + spec.label;
    if (FILLABLE.has(spec.kind)) out.push({ path, label, spec });
    else if (spec.kind === 'object' && spec.fields && depth < 1) {
      collect(spec.fields, `${path}.`, `${label}: `, out, depth + 1);
    }
  }
}

/**
 * Pseudo fields of a chapter's main strand. A chapter keeps its year, point of
 * view, and label inside its strands (A5); the importer fills the main one.
 */
const STRAND_FIELDS: ImportField[] = [
  {
    path: 'strand.startYear',
    label: 'Story year (main strand)',
    spec: f.year('strand.startYear', 'Story year (main strand)'),
  },
  {
    path: 'strand.endYear',
    label: 'Ends in year (main strand)',
    spec: f.year('strand.endYear', 'Ends in year (main strand)', { nullable: true }),
  },
  {
    path: 'strand.label',
    label: 'Strand label (main strand)',
    spec: f.text('strand.label', 'Strand label (main strand)'),
  },
  {
    path: 'strand.povCharacterId',
    label: 'Point of view (main strand)',
    spec: f.ref('strand.povCharacterId', 'Point of view (main strand)', ['characters'], {
      nullable: true,
    }),
  },
  // A29: the chapter's second strand: "Backstory: ..." when it jumps back in story time, or a later one such as "Forestory: John".
  {
    path: 'backstory.label',
    label: 'Strand label (second strand)',
    spec: f.text('backstory.label', 'Strand label (second strand)'),
  },
  {
    path: 'backstory.startYear',
    label: 'Story year (second strand)',
    spec: f.year('backstory.startYear', 'Story year (second strand)'),
  },
  {
    path: 'backstory.endYear',
    label: 'Ends in year (second strand)',
    spec: f.year('backstory.endYear', 'Ends in year (second strand)', { nullable: true }),
  },
];

/** Every field a mapping may assign for a target (IM-1). */
export function importableFields(target: Target): ImportField[] {
  const out: ImportField[] = [];
  collect(manifests[target.collection], '', '', out, 0);
  if (target.collection === 'chapters') out.push(...STRAND_FIELDS);
  return out;
}

export function isVirtual(path: string): boolean {
  return path.startsWith('strand.') || path.startsWith('backstory.');
}

/** Set a dotted path on a plain object, making the groups on the way. */
export function setPath(doc: Doc, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = doc;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (isPlainObject(next)) cur = next;
    else {
      const made: Doc = {};
      cur[key] = made;
      cur = made;
    }
  }
  cur[keys[keys.length - 1] ?? ''] = value;
}

type StrandLike = Doc & { primary?: boolean };

function primaryStrand(doc: Doc): StrandLike | undefined {
  const strands = Array.isArray(doc.strands) ? (doc.strands as StrandLike[]) : [];
  return strands.find((s) => s.primary) ?? strands[0];
}

/** The first strand that is not the main one: the backstory strand of a two-strand chapter (A29). */
function otherStrand(doc: Doc): StrandLike | undefined {
  const strands = Array.isArray(doc.strands) ? (doc.strands as StrandLike[]) : [];
  const main = primaryStrand(doc);
  return strands.find((s) => s !== main);
}

/** A field's value on a document, reading a chapter's main strand for `strand.*` paths and its other strand for `backstory.*`. */
export function readField(doc: Doc, path: string): unknown {
  if (path.startsWith('backstory.')) return otherStrand(doc)?.[path.slice('backstory.'.length)];
  if (isVirtual(path)) return primaryStrand(doc)?.[path.slice('strand.'.length)];
  return getPath(doc, path);
}

/** Write one imported value into a document (a copy is the caller's job). */
export function writeField(doc: Doc, path: string, value: unknown): void {
  if (!isVirtual(path)) return setPath(doc, path, value);
  const backstory = path.startsWith('backstory.');
  const key = path.slice((backstory ? 'backstory.' : 'strand.').length);
  let strands = Array.isArray(doc.strands) ? (doc.strands as StrandLike[]) : null;
  if (!strands || strands.length === 0) {
    strands = [
      {
        id: 's1',
        label: 'present',
        startYear: null,
        endYear: null,
        primary: true,
        povCharacterId: null,
        characterIds: [],
        placeIds: [],
      },
    ];
    doc.strands = strands;
  }
  if (backstory) {
    let other = otherStrand(doc);
    if (!other) {
      const ids = new Set(strands.map((s) => String(s.id)));
      let n = strands.length + 1;
      while (ids.has(`s${n}`)) n += 1;
      other = {
        id: `s${n}`,
        label: 'backstory',
        startYear: null,
        endYear: null,
        primary: false,
        povCharacterId: null,
        characterIds: [],
        placeIds: [],
      };
      strands.push(other);
    }
    other[key] = value;
    return;
  }
  const strand = primaryStrand(doc);
  if (strand) strand[key] = value;
}

/** Copy a document and apply imported values to it. */
export function applyFields(doc: Doc, fields: Record<string, unknown>): Doc {
  const next = structuredClone(doc);
  for (const [path, value] of Object.entries(fields)) writeField(next, path, value);
  return next;
}
