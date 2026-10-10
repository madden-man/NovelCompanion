import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import {
  CUSTOM_FIELD_TYPES,
  ENTRY_COLLECTIONS,
  collectionInfo,
  customFieldSpecs,
  editableFields,
  entrySchemas,
  manifests,
} from '../../src/shared/schema';
import type { FieldSpec } from '../../src/shared/schema';

interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  items?: z.ZodType[];
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
  options?: z.ZodType[];
}
const def = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Peel optional, nullable, and default wrappers off a zod schema. */
function unwrap(s: z.ZodType): { core: z.ZodType; optional: boolean; nullable: boolean } {
  let optional = false;
  let nullable = false;
  let cur = s;
  for (;;) {
    const d = def(cur);
    if (d.type === 'optional' || d.type === 'default' || d.type === 'prefault') optional = true;
    else if (d.type === 'nullable') nullable = true;
    else return { core: cur, optional, nullable };
    cur = d.innerType!;
  }
}

const SCALAR: Partial<Record<FieldSpec['kind'], string[]>> = {
  text: ['string'],
  longText: ['string'],
  calendarDate: ['string'],
  int: ['number'],
  number: ['number'],
  year: ['number'],
  boolean: ['boolean'],
  enum: ['enum'],
  listItem: ['string'],
  ref: ['string'],
  refs: ['array'],
  tags: ['array'],
  strings: ['array'],
  links: ['array'],
  refPair: ['tuple'],
  storyDate: ['union'],
  yearOrAge: ['union'],
  customValues: ['record'],
  object: ['object'],
  objectList: ['array'],
};

/** Every mismatch between a manifest and the zod shape it describes. */
function compare(
  specs: readonly FieldSpec[],
  shape: Record<string, z.ZodType>,
  at: string,
): string[] {
  const out: string[] = [];
  const names = specs.map((s) => s.name);
  for (const key of Object.keys(shape)) {
    if (!names.includes(key)) out.push(`${at}${key}: in the schema but not the manifest`);
  }
  for (const spec of specs) {
    const field = shape[spec.name];
    if (!field) {
      out.push(`${at}${spec.name}: in the manifest but not the schema`);
      continue;
    }
    const { core, optional, nullable } = unwrap(field);
    const d = def(core);
    if (spec.kind !== 'system') {
      if (spec.required !== !optional) out.push(`${at}${spec.name}: required is ${spec.required}`);
      if (Boolean(spec.nullable) !== nullable) {
        out.push(`${at}${spec.name}: nullable is ${String(spec.nullable)}`);
      }
      const types = SCALAR[spec.kind];
      if (types && !types.includes(d.type)) {
        out.push(`${at}${spec.name}: kind ${spec.kind} but the schema is ${d.type}`);
      }
    }
    if (spec.kind === 'enum') {
      const values = Object.values(d.entries ?? {});
      expect(spec.options?.map((o) => o.value).sort(), `${at}${spec.name}`).toEqual(values.sort());
    }
    if (spec.kind === 'object') {
      out.push(...compare(spec.fields ?? [], d.shape ?? {}, `${at}${spec.name}.`));
    }
    if (spec.kind === 'objectList') {
      const el = def(unwrap(d.element!).core);
      out.push(...compare(spec.fields ?? [], el.shape ?? {}, `${at}${spec.name}[].`));
    }
  }
  return out;
}

describe('T-5 field manifests match the schemas', () => {
  test('T-5 every schema field has a manifest entry and every manifest entry is a schema field, at every depth', () => {
    const problems: string[] = [];
    for (const c of ENTRY_COLLECTIONS) {
      const shape = (entrySchemas[c] as unknown as { shape: Record<string, z.ZodType> }).shape;
      problems.push(...compare(manifests[c], shape, `${c}.`));
    }
    expect(problems).toEqual([]);
  });

  test('T-5 a field added to a schema without a manifest entry is caught', () => {
    const shape = (entrySchemas.families as unknown as { shape: Record<string, z.ZodType> }).shape;
    const withExtra = { ...shape, motto: shape.notes! };
    expect(compare(manifests.families, withExtra, 'families.')).toEqual([
      'families.motto: in the schema but not the manifest',
    ]);
  });

  test('T-5 every manifest field has a kind, a label in plain words, and no em dash', () => {
    const walk = (specs: readonly FieldSpec[]) => {
      for (const s of specs) {
        expect(s.label.trim().length, s.name).toBeGreaterThan(0);
        expect(`${s.label}${s.hint ?? ''}`).not.toMatch(/\u2014|--/);
        if (s.kind === 'listItem' || s.kind === 'tags') expect(s.listId, s.name).toBeTruthy();
        if (['ref', 'refs', 'refPair'].includes(s.kind))
          expect(s.target?.length, s.name).toBeGreaterThan(0);
        if (s.fields) walk(s.fields);
      }
    };
    for (const c of ENTRY_COLLECTIONS) walk(manifests[c]);
  });
});

describe('ED-1 every entity in section 4 has a schema and an editor manifest', () => {
  test('ED-1 every section 4 entity is a collection with an editable manifest', () => {
    const section4 = [
      'families',
      'characters',
      'unions',
      'parentLinks',
      'relationships',
      'books',
      'parts',
      'arcs',
      'chapters',
      'plotBeats',
      'worldEvents',
      'eraStates',
      'culturalEntries',
      'places',
      'glossaryTerms',
      'facts',
      'knowledgeRecords',
      'themes',
      'openQuestions',
      'sessionLogs',
      'customSections',
      'customEntries',
    ];
    for (const c of section4) {
      expect(ENTRY_COLLECTIONS, c).toContain(c);
      expect(editableFields(manifests[c as keyof typeof manifests]).length, c).toBeGreaterThan(0);
      expect(collectionInfo[c as keyof typeof collectionInfo].plural, c).toBeTruthy();
    }
  });

  test('ED-1 entries share the common fields of section 4', () => {
    const common = ['title', 'body', 'status', 'provenance', 'sourceNote', 'tags', 'links'];
    for (const c of ENTRY_COLLECTIONS.filter((x) => x !== 'customSections')) {
      expect(
        manifests[c].map((s) => s.name),
        c,
      ).toEqual(expect.arrayContaining(common));
    }
  });

  test('ED-1 a custom section yields a manifest with one field per CS-1 kind', () => {
    const specs = customFieldSpecs({
      fields: CUSTOM_FIELD_TYPES.map((t, i) => ({
        id: `f${i}`,
        label: t,
        type: t,
        options: ['A', 'B'],
      })),
    });
    expect(specs.map((s) => s.kind)).toEqual([
      'text',
      'longText',
      'number',
      'year',
      'object',
      'enum',
      'tags',
      'ref',
    ]);
  });
});

describe('ED-6 generated content is ordinary editable fields', () => {
  test('ED-6 chapter summaries, briefs, and continuity findings are editable long text in the manifest', () => {
    const kindOf = (c: keyof typeof manifests, name: string) =>
      manifests[c].find((s) => s.name === name)?.kind;
    expect(kindOf('chapters', 'summary')).toBe('longText');
    expect(kindOf('briefs', 'content')).toBe('longText');
    expect(kindOf('findings', 'text')).toBe('longText');
    expect(kindOf('findings', 'resolutionNote')).toBe('longText');
    // Imported content too: manuscript text and the source file are ordinary fields.
    expect(kindOf('chapters', 'manuscriptText')).toBe('longText');
    expect(kindOf('chapters', 'sourceFile')).toBe('text');
  });
});
