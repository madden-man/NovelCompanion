/**
 * T-5 editing coverage, shared by the integration suite and the end-to-end
 * suite. It walks every field manifest, so a field added to a schema is
 * covered without anyone listing it, and a field kind it cannot set throws.
 * All writes go through the IPC layer: the caller passes `invoke`, which is
 * `runHandler` in integration and `window.api.invoke` end to end.
 */
import { ENTRY_COLLECTIONS, editableFields, manifests } from '../../src/shared/schema';
import type { EntryCollection, FieldSpec } from '../../src/shared/schema';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { deepEqual, isPlainObject } from '../../src/shared/domain/paths';

export type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

type Doc = Record<string, unknown>;
type Variant = 0 | 1;

const POOL = 8;

export interface GenContext {
  /** Pool of live entry IDs for a collection, `*` meaning any entry. */
  pool(collection: string): string[];
  listItems(listId: string): string[];
}

function pick(ctx: GenContext, spec: FieldSpec, offset: number, v: number): string {
  const target = spec.target?.[0] ?? '*';
  const pool = ctx.pool(target);
  const id = pool[(offset + v) % pool.length];
  if (!id) throw new Error(`T-5 has no pool of ${target} entries for ${spec.name}`);
  return id;
}

/** A value for one field. Variant 1 differs from variant 0 at every leaf. */
export function valueFor(
  spec: FieldSpec,
  v: Variant,
  ctx: GenContext,
  ordinal: number,
  parent: Doc,
  mode: 'full' | 'minimal' = 'full',
): unknown {
  const offset = (2 * ordinal) % POOL;
  const isEnd = /^end|End$/.test(spec.name);
  switch (spec.kind) {
    case 'text':
      return `${spec.label} ${v === 0 ? 'first' : 'second'}`;
    case 'color':
      return v === 0 ? '#2a78d6' : '#1baf7a';
    case 'longText':
      return v === 0
        ? `${spec.label}, first version.\nIt has two lines.`
        : `${spec.label}, second version.\nIt has two lines too.`;
    case 'int':
      return (v === 0 ? 3 : 7) + (isEnd ? 10 : 0);
    case 'number':
      return v === 0 ? 2.5 : 4.75;
    case 'year':
      return (v === 0 ? 2040 : 2061) + (isEnd ? 10 : 0);
    case 'storyDate':
      return v === 0
        ? { year: 1990 + (isEnd ? 50 : 0), month: 3, day: 14 }
        : { year: 1995 + (isEnd ? 55 : 0), month: 7, day: 2 };
    case 'calendarDate':
      return v === 0 ? '2026-01-15' : '2026-02-20';
    case 'boolean':
      return v === 1;
    case 'enum': {
      const o = spec.options ?? [];
      if (o.length < 2) throw new Error(`T-5 needs two options for ${spec.name}`);
      return o[v]!.value;
    }
    case 'listItem': {
      const items = ctx.listItems(spec.listId!);
      if (items.length < 2) throw new Error(`T-5 needs two items in ${spec.listId}`);
      return items[v];
    }
    case 'listItems': {
      const items = ctx.listItems(spec.listId!);
      if (items.length < 2) throw new Error(`T-5 needs two items in ${spec.listId}`);
      return [items[v]];
    }
    case 'strings':
      return v === 0 ? [`${spec.label} a`, `${spec.label} b`] : [`${spec.label} c`];
    case 'ref':
      return pick(ctx, spec, offset, v);
    case 'refs':
      return [pick(ctx, spec, offset, v)];
    case 'refPair':
      return [pick(ctx, spec, offset, v), pick(ctx, spec, offset + 2, v)];
    case 'object':
      return build(spec.fields!, v, ctx, mode);
    case 'objectList':
      return [build(spec.fields!, v, ctx, mode)];
    case 'system':
      return `${spec.name}-${v}`;
  }
}

/**
 * Build a value for a group of fields. `minimal` fills only what the schema
 * requires; `full` fills every field. Nested system fields such as strand IDs
 * are always filled because the schema requires them.
 */
export function build(
  specs: readonly FieldSpec[],
  v: Variant,
  ctx: GenContext,
  mode: 'full' | 'minimal',
  topLevel = false,
): Doc {
  const out: Doc = {};
  specs.forEach((s, i) => {
    if (s.kind === 'system') {
      if (!topLevel) out[s.name] = valueFor(s, v, ctx, i, out, mode);
      return;
    }
    if (mode === 'minimal' && !s.required) return;
    out[s.name] = valueFor(s, v, ctx, i, out, mode);
  });
  return out;
}

/** Every leaf path of a value, for checking that two variants differ everywhere. */
export function leaves(value: unknown, base = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (x: unknown, p: string) => {
    if (isPlainObject(x)) for (const [k, y] of Object.entries(x)) walk(y, p ? `${p}.${k}` : k);
    else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${p}.${i}`));
    else out.set(p, x);
  };
  walk(value, base);
  return out;
}

/** Collections whose entries the generator points at, in an order that satisfies required refs. */
function poolOrder(): string[] {
  const targets = new Set<string>();
  const visit = (specs: readonly FieldSpec[]) => {
    for (const s of specs) {
      for (const t of s.target ?? []) if (t !== '*') targets.add(t);
      if (s.fields) visit(s.fields);
    }
  };
  for (const c of ENTRY_COLLECTIONS) visit(manifests[c]);
  targets.add('characters'); // the pool for `*`
  const requiredTargets = (c: string): string[] => {
    const out: string[] = [];
    const walk = (specs: readonly FieldSpec[]) => {
      for (const s of specs) {
        if (!s.required) continue;
        for (const t of s.target ?? []) if (t !== '*' && t !== c) out.push(t);
        if (s.fields) walk(s.fields);
      }
    };
    walk(manifests[c as EntryCollection]);
    return out;
  };
  const order: string[] = [];
  const place = (c: string, stack: string[] = []) => {
    if (order.includes(c)) return;
    if (stack.includes(c)) throw new Error(`T-5 found a required reference cycle at ${c}`);
    for (const t of requiredTargets(c)) place(t, [...stack, c]);
    order.push(c);
  };
  for (const c of [...targets].sort()) place(c);
  return order;
}

export interface PlanItem {
  collection: EntryCollection;
  id: string;
  fields: string[];
  expected: Doc;
}

export interface T5Plan {
  items: PlanItem[];
  /** Problems found while writing, for example a field whose two values do not differ. */
  problems: string[];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Write phase: one entry per collection, created with the first variant of
 * every field, then every field set to the second variant by its own update.
 */
export async function t5Write(invoke: Invoke): Promise<T5Plan> {
  const problems: string[] = [];
  const pools = new Map<string, string[]>();

  // Lists the generator needs at least two items in.
  const listIds = new Set<string>();
  const visit = (specs: readonly FieldSpec[]) => {
    for (const s of specs) {
      if ((s.kind === 'listItem' || s.kind === 'listItems') && s.listId) listIds.add(s.listId);
      if (s.fields) visit(s.fields);
    }
  };
  for (const c of ENTRY_COLLECTIONS) visit(manifests[c]);
  const { lists } = await invoke('lists.get', {});
  const items = new Map<string, string[]>();
  for (const id of listIds) {
    const list = lists.find((l) => l._id === id);
    if (!list) throw new Error(`T-5 found no list ${id}`);
    const ids = list.items.map((i) => i.id);
    for (const label of ['Example item one', 'Example item two']) {
      if (ids.length >= 2) break;
      const { item } = await invoke('lists.addItem', { listId: list._id, label, parentId: null });
      ids.push(item.id);
    }
    items.set(id, ids);
  }

  const ctx: GenContext = {
    pool: (c) => pools.get(c === '*' ? 'characters' : c) ?? [],
    listItems: (id) => items.get(id) ?? [],
  };

  for (const c of poolOrder() as EntryCollection[]) {
    const ids: string[] = [];
    for (let i = 0; i < POOL; i++) {
      const data = { ...build(manifests[c], 0, ctx, 'minimal', true), title: `Pool ${c} ${i + 1}` };
      const { entry } = await invoke('entry.create', { collection: c, data });
      ids.push(entry._id);
    }
    pools.set(c, ids);
  }

  const plan: PlanItem[] = [];
  for (const c of ENTRY_COLLECTIONS) {
    const manifest = manifests[c];
    const a = build(manifest, 0, ctx, 'full', true);
    const b = build(manifest, 1, ctx, 'full', true);
    let id: string;
    try {
      ({
        entry: { _id: id },
      } = await invoke('entry.create', { collection: c, data: a }));
    } catch (e) {
      problems.push(`${c}: create failed: ${errorText(e)}`);
      continue;
    }
    const fields = editableFields(manifest).map((s) => s.name);
    const expected: Doc = {};
    for (const name of fields) {
      const la = leaves(a[name]);
      const lb = leaves(b[name]);
      for (const p of new Set([...la.keys(), ...lb.keys()])) {
        if (deepEqual(la.get(p), lb.get(p))) {
          problems.push(`${c}.${name}${p ? `.${p}` : ''}: both variants are the same`);
        }
      }
      try {
        const { entry } = await invoke('entry.update', {
          collection: c,
          id,
          patch: { [name]: b[name] },
        });
        if (!deepEqual(entry[name], b[name])) {
          problems.push(`${c}.${name}: the update returned ${JSON.stringify(entry[name])}`);
        }
      } catch (e) {
        problems.push(`${c}.${name}: update failed: ${errorText(e)}`);
      }
      expected[name] = b[name];
    }
    plan.push({ collection: c, id, fields, expected });
  }
  return { items: plan, problems };
}

/** Verify phase, after a restart: every field holds the value written. */
export async function t5Verify(invoke: Invoke, plan: T5Plan): Promise<string[]> {
  const problems: string[] = [];
  for (const item of plan.items) {
    const { entry } = await invoke('entry.get', { collection: item.collection, id: item.id });
    for (const name of item.fields) {
      if (!deepEqual(entry[name], item.expected[name])) {
        problems.push(
          `${item.collection}.${name}: expected ${JSON.stringify(item.expected[name])}, found ${JSON.stringify(entry[name])}`,
        );
      }
    }
  }
  return problems;
}
