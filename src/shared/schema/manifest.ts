/**
 * Field manifests. Every schema exports one so a generic editor can render it
 * and the T-5 coverage test can walk it. A manifest lists every field the
 * schema stores; a unit test checks the two never drift apart.
 */

export type FieldKind =
  /** One line of text. */
  | 'text'
  /** Several lines of plain text. `@` opens the link picker. */
  | 'longText'
  /** A whole number. */
  | 'int'
  /** Any number. */
  | 'number'
  /** A story year. */
  | 'year'
  /** A full date, a year, or unknown (ARCHITECTURE rule 6). */
  | 'storyDate'
  /** A calendar date as YYYY-MM-DD, for things that happen in real life. */
  | 'calendarDate'
  | 'boolean'
  /** One of a fixed set of values. */
  | 'enum'
  /** The ID of an item in a user-editable list (ED-8). */
  | 'listItem'
  /** A47 (IP-8): the IDs of several items in a user-editable list, for example regions. */
  | 'listItems'
  /** A47 (IP-12): a CSS hex colour such as `#2a78d6`. */
  | 'color'
  /** Free strings. */
  | 'strings'
  /** The ID of one entry. */
  | 'ref'
  /** IDs of several entries. */
  | 'refs'
  /** Exactly two entry IDs, for example the partners in a union. */
  | 'refPair'
  /** A nested group of fields. */
  | 'object'
  /** A list of nested groups. */
  | 'objectList'
  /** Set by the app, shown but never edited directly. */
  | 'system';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label: string;
  /** Must be given when the entry is created; there is no default. */
  required: boolean;
  /** The field accepts null (shown as blank). */
  nullable?: boolean;
  /** For `enum`. */
  options?: FieldOption[];
  /** For `listItem`, `listItems` and `tags`. */
  listId?: string;
  /** For `ref`, `refs`, `refPair`: the collections a target may come from. */
  target?: string[];
  /** For `object` and `objectList`. */
  fields?: FieldSpec[];
  /** For a start year: the sibling field that ends the range. */
  rangeEnd?: string;
  /** Warning codes this field can carry (ED-10). */
  warnings: string[];
  /** A short plain hint shown under the field. */
  hint?: string;
  /** For `objectList`: the field whose value labels each item. */
  itemLabel?: string;
  /** For `objectList`: the fewest items the schema accepts. */
  minItems?: number;
  /**
   * Not stored on this entry. The value is read from other entries and a
   * write to it is carried out on them (chapter themes come from each theme's
   * appearances).
   */
  derived?: boolean;
}

type Extra = Partial<Omit<FieldSpec, 'name' | 'kind' | 'label'>>;

function spec(kind: FieldKind, name: string, label: string, extra: Extra = {}): FieldSpec {
  return { name, kind, label, required: false, warnings: [], ...extra };
}

/** Small builders so manifests read like the schema they describe. */
export const f = {
  text: (name: string, label: string, extra?: Extra) => spec('text', name, label, extra),
  longText: (name: string, label: string, extra?: Extra) => spec('longText', name, label, extra),
  int: (name: string, label: string, extra?: Extra) => spec('int', name, label, extra),
  number: (name: string, label: string, extra?: Extra) => spec('number', name, label, extra),
  year: (name: string, label: string, extra?: Extra) => spec('year', name, label, extra),
  storyDate: (name: string, label: string, extra?: Extra) => spec('storyDate', name, label, extra),
  calendarDate: (name: string, label: string, extra?: Extra) =>
    spec('calendarDate', name, label, extra),
  boolean: (name: string, label: string, extra?: Extra) => spec('boolean', name, label, extra),
  color: (name: string, label: string, extra?: Extra) => spec('color', name, label, extra),
  enum: (name: string, label: string, options: FieldOption[], extra?: Extra) =>
    spec('enum', name, label, { options, ...extra }),
  listItem: (name: string, label: string, listId: string, extra?: Extra) =>
    spec('listItem', name, label, { listId, warnings: ['unknown-list-item'], ...extra }),
  listItems: (name: string, label: string, listId: string, extra?: Extra) =>
    spec('listItems', name, label, { listId, warnings: ['unknown-list-item'], ...extra }),
  strings: (name: string, label: string, extra?: Extra) => spec('strings', name, label, extra),
  ref: (name: string, label: string, target: string[], extra?: Extra) =>
    spec('ref', name, label, { target, warnings: ['missing-target'], ...extra }),
  refs: (name: string, label: string, target: string[], extra?: Extra) =>
    spec('refs', name, label, { target, warnings: ['missing-target'], ...extra }),
  refPair: (name: string, label: string, target: string[], extra?: Extra) =>
    spec('refPair', name, label, {
      target,
      required: true,
      warnings: ['missing-target', 'same-twice'],
      ...extra,
    }),
  object: (name: string, label: string, fields: FieldSpec[], extra?: Extra) =>
    spec('object', name, label, { fields, ...extra }),
  objectList: (name: string, label: string, fields: FieldSpec[], extra?: Extra) =>
    spec('objectList', name, label, { fields, ...extra }),
  system: (name: string, label: string) => spec('system', name, label),
};

/** A start and end year pair that warns when the end comes first (ED-10). */
export function yearRange(
  start: string,
  end: string,
  labels: [string, string] = ['Start year', 'End year'],
  opts: { startRequired?: boolean; nullable?: boolean } = {},
): FieldSpec[] {
  const nullable = opts.nullable ?? true;
  return [
    f.year(start, labels[0], {
      rangeEnd: end,
      nullable: opts.startRequired ? false : nullable,
      required: opts.startRequired ?? false,
      warnings: ['range-end-before-start'],
    }),
    f.year(end, labels[1], { nullable, warnings: ['range-end-before-start'] }),
  ];
}

/** Every entry collection, for a reference that may point anywhere. */
export const ANY = ['*'];

/** The fields every entry shares (SPEC section 4, top paragraph). */
export const commonFields: FieldSpec[] = [
  f.system('_id', 'ID'),
  f.text('title', 'Title', { required: true }),
  f.longText('body', 'Body'),
  f.system('createdAt', 'Created'),
  f.system('modifiedAt', 'Last changed'),
  f.system('deletedAt', 'Moved to trash'),
];

/** The fields a person edits, in display order, leaving out system fields. */
export function editableFields(manifest: readonly FieldSpec[]): FieldSpec[] {
  return manifest.filter((s) => s.kind !== 'system');
}

export function fieldByName(manifest: readonly FieldSpec[], name: string): FieldSpec | undefined {
  return manifest.find((s) => s.name === name);
}
