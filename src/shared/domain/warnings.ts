/**
 * Field warnings (ED-10). Pure functions over plain objects: they never block
 * a write, and every read returns them so the editor can show each one at its
 * field with a plain explanation. The checks come from the field manifests
 * (ranges, references, list items) plus the per-entity rules that need only
 * the entry and the entries it names: death before birth, years outside a
 * lifetime, and the FT-6 parent-age and
 * born-after-death checks. Tree-wide FT-6 checks (overlapping unions, a child
 * born before a union) use the whole tree when the context can list it.
 */
import type { StoryDate } from '../schema/common';
import type { FieldSpec } from '../schema/manifest';
import type { ListDoc } from '../schema/lists';
import {
  bornAfterDeathWarning,
  buildGraph,
  overlapWarning,
  parentAgeWarning,
  treeWarnings,
} from './tree';
import { compareStoryDates, formatStoryDate, isImpossibleDate, yearOf } from './dates';
import { isPlainObject, joinPath } from './paths';
import type { Doc } from './paths';
import { outgoingRefs } from './refs';
import { ROMANIZATION_META_ID, settingsFromMeta, termProblem } from './romanization';

export interface FieldWarning {
  /** Dotted path of the field, for example `death` or `strands.0.startYear`. */
  path: string;
  code: string;
  message: string;
}

/** What the checks may look up: other entries and lists. */
export interface WarningContext {
  get(collection: string, id: string): Doc | undefined;
  /** Find an entry in any collection, for links and `*` targets. */
  find(id: string): { collection: string; doc: Doc } | undefined;
  list(listId: string): ListDoc | undefined;
  /** Every stored entry of a collection, for checks that need the whole tree (FT-6). */
  all?: (collection: string) => Doc[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asDate(v: unknown): StoryDate | null {
  return isPlainObject(v) ? (v as StoryDate) : null;
}

function titleOf(doc: Doc | undefined): string {
  const t = doc?.title ?? doc?.name;
  return typeof t === 'string' && t.trim() ? t : 'that entry';
}

/** Range, date, and list checks that come straight from the manifest. */
function manifestChecks(
  specs: readonly FieldSpec[],
  value: Doc,
  base: string,
  ctx: WarningContext,
  out: FieldWarning[],
): void {
  for (const s of specs) {
    const v = value[s.name];
    const path = joinPath(base, s.name);
    if (s.rangeEnd) {
      const start = num(v);
      const end = num(value[s.rangeEnd]);
      if (start !== null && end !== null && end < start) {
        out.push({
          path: joinPath(base, s.rangeEnd),
          code: 'range-end-before-start',
          message: `This range ends in ${end}, before it starts in ${start}.`,
        });
      }
    }
    if (s.kind === 'storyDate' && isImpossibleDate(asDate(v))) {
      out.push({
        path,
        code: 'impossible-date',
        message: `${formatStoryDate(asDate(v))} is not a real date: that month has fewer days.`,
      });
    }
    if (s.kind === 'listItem' && typeof v === 'string' && s.listId) {
      const list = ctx.list(s.listId);
      if (list && !list.items.some((i) => i.id === v)) {
        out.push({
          path,
          code: 'unknown-list-item',
          message: `"${v}" is not in the ${list.label} list. Add it there or pick another.`,
        });
      }
    }
    if (s.kind === 'refPair' && Array.isArray(v) && v.length === 2 && v[0] === v[1]) {
      out.push({ path, code: 'same-twice', message: 'The same entry is chosen twice.' });
    }
    if (s.kind === 'object' && s.fields && isPlainObject(v)) {
      manifestChecks(s.fields, v, path, ctx, out);
    }
    if (s.kind === 'objectList' && s.fields && Array.isArray(v)) {
      const fields = s.fields;
      v.forEach((item, i) => {
        if (isPlainObject(item)) manifestChecks(fields, item, joinPath(path, i), ctx, out);
      });
    }
  }
}

/** References to entries that do not exist or are in the trash. */
function referenceChecks(
  manifest: readonly FieldSpec[],
  doc: Doc,
  ctx: WarningContext,
  out: FieldWarning[],
): void {
  for (const ref of outgoingRefs(manifest, doc)) {
    const found = ref.target.includes('*')
      ? ctx.find(ref.targetId)?.doc
      : ref.target.map((c) => ctx.get(c, ref.targetId)).find(Boolean);
    // Links point at whole entries; report them on the links field itself.
    const path = ref.path.replace(/^links\.\d+$/, 'links');
    if (!found) {
      out.push({
        path,
        code: 'missing-target',
        message: `No entry has the ID ${ref.targetId}. It may have been deleted for good.`,
      });
    } else if (found.deletedAt) {
      out.push({
        path,
        code: 'missing-target',
        message: `${titleOf(found)} is in the trash. Restore it or pick another.`,
      });
    } else if (ref.targetId === doc._id && path === 'parentId') {
      out.push({ path, code: 'self-reference', message: 'A place cannot sit inside itself.' });
    }
  }
}

function characterChecks(doc: Doc, out: FieldWarning[]): void {
  const birth = asDate(doc.birth);
  const death = asDate(doc.death);
  const cmp = compareStoryDates(death, birth);
  if (cmp !== null && cmp < 0) {
    out.push({
      path: 'death',
      code: 'death-before-birth',
      message: `The death date ${formatStoryDate(death)} is before the birth date ${formatStoryDate(birth)}. It still saves.`,
    });
  }
}

/**
 * SM-3: a moment outside its character's lifetime, as the old voice note
 * check did. Never blocks: backstory may mean family history before birth.
 */
function momentChecks(doc: Doc, ctx: WarningContext, out: FieldWarning[]): void {
  const who =
    typeof doc.characterId === 'string' ? ctx.get('characters', doc.characterId) : undefined;
  if (!who) return;
  const born = yearOf(asDate(who.birth));
  const died = yearOf(asDate(who.death));
  const name = titleOf(who);
  const year = num(doc.year);
  const end = num(doc.endYear);
  if (year !== null && born !== null && year < born) {
    out.push({
      path: 'year',
      code: 'outside-lifetime',
      message: `${year} is before ${name} is born in ${born}.`,
    });
  } else if (year !== null && died !== null && year > died) {
    out.push({
      path: 'year',
      code: 'outside-lifetime',
      message: `${year} is after ${name} dies in ${died}.`,
    });
  }
  if (end !== null && died !== null && end > died && !(year !== null && year > died)) {
    out.push({
      path: 'endYear',
      code: 'outside-lifetime',
      message: `${end} is after ${name} dies in ${died}.`,
    });
  }
}

/**
 * FT-6 parent age at the child's birth, and a child born over a year after the
 * parent died. The same pure checks the tree uses, so both say the same thing.
 * They apply to biological links; other parents may be any age.
 */
function parentLinkChecks(doc: Doc, ctx: WarningContext, out: FieldWarning[]): void {
  const parent = typeof doc.parentId === 'string' ? ctx.get('characters', doc.parentId) : undefined;
  const child = typeof doc.childId === 'string' ? ctx.get('characters', doc.childId) : undefined;
  if (!parent || !child || doc.type !== 'biological') return;
  const named = (d: Doc) => ({ name: titleOf(d), birth: asDate(d.birth), death: asDate(d.death) });
  const age = parentAgeWarning(named(parent), named(child));
  if (age) out.push({ path: 'parentId', code: 'parent-age', message: age });
  const late = bornAfterDeathWarning(named(parent), named(child));
  if (late) out.push({ path: 'childId', code: 'born-after-parent-death', message: late });
}

/** FT-6 tree-wide checks on a union: overlapping unions and children born before it. */
function unionTreeChecks(doc: Doc, ctx: WarningContext, out: FieldWarning[]): void {
  if (!ctx.all || doc.deletedAt) return;
  const unions = ctx.all('unions').filter((u) => u._id !== doc._id);
  const g = buildGraph(ctx.all('characters'), [...unions, doc], ctx.all('parentLinks'));
  const me = g.unions.find((u) => u.id === doc._id);
  if (!me) return;
  for (const other of g.unions) {
    if (other.id === me.id) continue;
    const msg = overlapWarning(g, me, other);
    if (msg) out.push({ path: 'startYear', code: 'overlapping-unions', message: msg });
  }
  for (const w of treeWarnings(g)) {
    if (w.code === 'born-before-union' && w.entryIds.includes(me.id)) {
      out.push({ path: 'startYear', code: 'born-before-union', message: w.message });
    }
  }
}

function unionChecks(doc: Doc, ctx: WarningContext, out: FieldWarning[]): void {
  const start = num(doc.startYear);
  if (start === null || !Array.isArray(doc.partnerIds)) return;
  for (const id of doc.partnerIds) {
    const p = typeof id === 'string' ? ctx.get('characters', id) : undefined;
    const born = yearOf(asDate(p?.birth));
    if (p && born !== null && start < born) {
      out.push({
        path: 'startYear',
        code: 'union-before-birth',
        message: `This union starts in ${start}, before ${titleOf(p)} is born in ${born}.`,
      });
    }
  }
}

function chapterChecks(doc: Doc, out: FieldWarning[]): void {
  const strands = Array.isArray(doc.strands) ? doc.strands : [];
  const primaries = strands.filter((s) => isPlainObject(s) && s.primary === true).length;
  if (strands.length > 0 && primaries !== 1) {
    out.push({
      path: 'strands',
      code: 'primary-strand-count',
      message:
        primaries === 0
          ? 'No strand is primary. Mark one so the chapter has a story year.'
          : `${primaries} strands are primary. Mark only one; the first is used until then.`,
    });
  }
}

/** GL-1: a romanization that does not follow the language's system is flagged, never blocked. */
function glossaryChecks(doc: Doc, ctx: WarningContext, out: FieldWarning[]): void {
  const problem = termProblem(
    {
      language: typeof doc.language === 'string' ? doc.language : '',
      romanization: typeof doc.romanization === 'string' ? doc.romanization : '',
    },
    settingsFromMeta(ctx.get('meta', ROMANIZATION_META_ID)),
    ctx.list('romanizationSystems'),
  );
  if (problem) out.push({ path: 'romanization', code: 'romanization-system', message: problem });
}

function worldEventChecks(doc: Doc, out: FieldWarning[]): void {
  const cmp = compareStoryDates(asDate(doc.end), asDate(doc.start));
  if (cmp !== null && cmp < 0) {
    out.push({
      path: 'end',
      code: 'range-end-before-start',
      message: `This event ends ${formatStoryDate(asDate(doc.end))}, before it starts ${formatStoryDate(asDate(doc.start))}.`,
    });
  }
}

function openQuestionChecks(doc: Doc, out: FieldWarning[]): void {
  if (doc.state === 'decided' && !String(doc.decision ?? '').trim()) {
    out.push({
      path: 'decision',
      code: 'decided-without-decision',
      message: 'This question is marked decided, but no decision is written down.',
    });
  }
}

/** Every warning for one entry. Never throws for odd data; it only reports. */
export function computeWarnings(
  collection: string,
  manifest: readonly FieldSpec[],
  doc: Doc,
  ctx: WarningContext,
): FieldWarning[] {
  const out: FieldWarning[] = [];
  manifestChecks(manifest, doc, '', ctx, out);
  referenceChecks(manifest, doc, ctx, out);
  switch (collection) {
    case 'characters':
      characterChecks(doc, out);
      break;
    case 'parentLinks':
      parentLinkChecks(doc, ctx, out);
      break;
    case 'unions':
      unionChecks(doc, ctx, out);
      unionTreeChecks(doc, ctx, out);
      break;
    case 'moments':
      momentChecks(doc, ctx, out);
      break;
    case 'chapters':
      chapterChecks(doc, out);
      break;
    case 'worldEvents':
      worldEventChecks(doc, out);
      break;
    case 'glossaryTerms':
      glossaryChecks(doc, ctx, out);
      break;
    case 'openQuestions':
      openQuestionChecks(doc, out);
      break;
    default:
      break;
  }
  return out;
}

/** The warnings for one field path and everything under it. */
export function warningsAt(warnings: readonly FieldWarning[], path: string): FieldWarning[] {
  return warnings.filter((w) => w.path === path || w.path.startsWith(`${path}.`));
}
