import type { FieldSpec } from '../schema/manifest';

/** The parts of a zod issue this module reads. */
export interface IssueLike {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  input?: unknown;
  expected?: string;
  minimum?: number | bigint;
  origin?: string;
}

export interface FieldIssue {
  /** Dotted path, the same form warnings use. */
  path: string;
  message: string;
}

/** A schema problem in plain words, for showing at the field. */
export function plainIssue(issue: IssueLike): string {
  if (issue.code === 'invalid_type') {
    if (issue.input === null || issue.input === undefined) return 'Needs a value.';
    if (issue.expected === 'int' || issue.expected === 'number') return 'Needs a whole number.';
    return 'This value has the wrong form.';
  }
  if (issue.code === 'too_small') {
    if (issue.origin === 'string') return 'Cannot be empty.';
    if (issue.origin === 'array') return `Needs at least ${String(issue.minimum)}.`;
    return `Must be at least ${String(issue.minimum)}.`;
  }
  if (issue.code === 'too_big') return 'This is too long or too large.';
  if (issue.code === 'invalid_value') return 'Pick one of the choices.';
  if (issue.code === 'invalid_format') return 'This is not in the expected form.';
  if (issue.code === 'invalid_union') return 'This value has the wrong form.';
  if (issue.code === 'unrecognized_keys') return 'Has a field the app does not know.';
  return issue.message;
}

/** Turn schema issues into plain messages keyed by field path. */
export function fieldIssues(issues: readonly IssueLike[]): FieldIssue[] {
  return issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: plainIssue(i),
  }));
}

/** A field's label path for a message, for example "Strands, item 1, Story year". */
export function labelPath(manifest: readonly FieldSpec[], path: string): string {
  const out: string[] = [];
  let specs: readonly FieldSpec[] | undefined = manifest;
  for (const part of path.split('.')) {
    if (/^\d+$/.test(part)) {
      out.push(`item ${Number(part) + 1}`);
      continue;
    }
    const spec: FieldSpec | undefined = specs?.find((s) => s.name === part);
    out.push(spec?.label ?? part);
    specs = spec?.fields;
  }
  return out.join(', ');
}
