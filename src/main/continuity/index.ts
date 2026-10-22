/**
 * The alignment check in the main process (CC-1 to CC-4): record a run's
 * findings, list them for the screens, and carry out the three resolutions.
 * The checks themselves are pure (src/shared/domain/continuity/); every
 * write here goes through the repository (ARCHITECTURE rule 2), each
 * operation in one transaction.
 */
import type { ClaudeRun } from '../../shared/claude';
import type { FindingWire } from '../../shared/ipcContinuity';
import { entryTitle } from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import {
  CHECK_LABELS,
  structuralFindings,
  chaptersInOrder,
} from '../../shared/domain/continuity/structural';
import type { StructuralCheck } from '../../shared/domain/continuity/structural';
import {
  AlignmentOutput,
  KIND_LABELS,
  checkAlignment,
} from '../../shared/domain/continuity/alignment';
import type { AlignmentKind } from '../../shared/domain/continuity/alignment';
import {
  changeSetPatches,
  collectionOf,
  describeChangeSet,
  findEntry,
} from '../../shared/domain/continuity/changeSet';
import type { ChangeProblem } from '../../shared/domain/continuity/changeSet';
import {
  dismissalFor,
  fromAlignment,
  fromStructural,
  reconcile,
} from '../../shared/domain/continuity/findings';
import type { FreshFinding, ReconcilePlan } from '../../shared/domain/continuity/findings';
import { numberedLines, textHash } from '../../shared/domain/continuity/lines';
import { chapterYear } from '../../shared/domain/position';
import type { Doc } from '../../shared/domain/paths';
import type { OpenBible } from '../db/session';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function findings(session: OpenBible): Doc[] {
  return session.model.all('findings').filter((f) => !f.deletedAt);
}

async function write(session: OpenBible, plan: ReconcilePlan, note: string): Promise<void> {
  await session.repo.writeBatch(
    [
      ...plan.creates.map((data) => ({
        op: 'create' as const,
        collection: 'findings' as const,
        data,
      })),
      ...plan.updates.map((u) => ({
        op: 'update' as const,
        collection: 'findings' as const,
        id: u.id,
        patch: u.patch,
      })),
      ...plan.trash.map((id) => ({
        op: 'softDelete' as const,
        collection: 'findings' as const,
        id,
      })),
    ],
    { note },
  );
}

/** CC-1, CC-2: run the structural checks on one chapter or all and record what they find. */
export async function checkStructure(session: OpenBible, chapterId: string | null) {
  const data = session.model;
  if (chapterId && !findEntry(data, 'chapters', chapterId)) {
    throw new Error('That chapter is not in the bible.');
  }
  const fresh = structuralFindings(data, { chapterId }).map(fromStructural);
  const plan = reconcile(
    findings(session),
    fresh,
    (f) => f.kind === 'structural' && (chapterId === null || f.chapterId === chapterId),
    data,
  );
  await write(session, plan, 'Structural check');
  const chapters = chaptersInOrder(data).filter((c) => chapterId === null || c._id === chapterId);
  return {
    found: fresh.length,
    hidden: plan.hidden,
    chapters: chapters.map((c) => ({
      id: str(c._id),
      title: entryTitle(c),
      readingOrder: num(c.readingOrder),
      lines: numberedLines(c.manuscriptText).length,
    })),
  };
}

/**
 * CC-3: after an alignment run, check Claude's findings and record the valid
 * ones for the chapter. A run that did not finish records nothing and leaves
 * the earlier findings as they were.
 */
export async function recordAlignment(
  session: OpenBible,
  chapterId: string,
  run: ClaudeRun,
  runId: string,
): Promise<{ found: number; hidden: number; rejected: ChangeProblem[]; skipped: string | null }> {
  const none = { found: 0, hidden: 0, rejected: [] as ChangeProblem[], skipped: null };
  const turn = run.turns.find((t) => t.id === runId) ?? run.turns[0];
  const parsed = AlignmentOutput.safeParse(run.output);
  if (!turn || turn.status !== 'done' || !parsed.success) return none;
  const data = session.model;
  const chapter = findEntry(data, 'chapters', chapterId);
  if (!chapter) return none;
  // The line numbers Claude used belong to the text it was sent: check it is still the text now.
  const sent = (run.input as { textHash?: unknown } | undefined)?.textHash;
  const text = typeof chapter.manuscriptText === 'string' ? chapter.manuscriptText : '';
  if (typeof sent !== 'string' || sent !== textHash(text)) {
    return {
      ...none,
      skipped:
        'The chapter text changed while Claude was reading it, so its line numbers no longer match and nothing was recorded. Check this chapter again.',
    };
  }
  const checked = checkAlignment(parsed.data, {
    chapterId,
    lines: numberedLines(chapter.manuscriptText),
    data,
  });
  const fresh: FreshFinding[] = checked.findings.map((f) =>
    fromAlignment(f, { storyYear: chapterYear(chapter), runId }),
  );
  const plan = reconcile(
    findings(session),
    fresh,
    (f) => f.kind === 'alignment' && f.chapterId === chapterId,
    data,
  );
  await write(session, plan, `Alignment check, run ${runId}`);
  return { found: fresh.length, hidden: plan.hidden, rejected: checked.rejected, skipped: null };
}

function labelOf(f: Doc): string {
  const check = str(f.check);
  if (f.kind === 'structural') return CHECK_LABELS[check as StructuralCheck] ?? 'Structural';
  return KIND_LABELS[check as AlignmentKind] ?? 'Alignment';
}

/** The entries a change set writes, each with the revision it has now. */
function shownRevisions(
  data: OpenBible['model'],
  changeSet: FreshFinding['changeSet'],
): FindingWire['shown'] {
  const out = new Map<string, FindingWire['shown'][number]>();
  for (const c of changeSet) {
    const d = findEntry(data, c.collection, c.id);
    if (d)
      out.set(`${c.collection}:${c.id}`, {
        collection: c.collection,
        id: c.id,
        modifiedAt: str(d.modifiedAt),
      });
  }
  return [...out.values()];
}

/** A stored finding as the screens show it, with the change set compared against the bible now. */
export function findingWire(session: OpenBible, f: Doc): FindingWire {
  const data = session.model;
  const chapter = str(f.chapterId) ? findEntry(data, 'chapters', str(f.chapterId)) : undefined;
  const start = num(f.lineStart);
  const quote = str(f.quote);
  const lines =
    start !== null && quote ? quote.split('\n').map((text, i) => ({ n: start + i, text })) : [];
  const now = chapter ? numberedLines(chapter.manuscriptText) : [];
  // The quote the check read, not a hand edit of it (IP-7), says whether the chapter text moved on.
  const generated = (f.generated ?? null) as { quote?: unknown } | null;
  const read = typeof generated?.quote === 'string' ? generated.quote : quote;
  const textChanged =
    f.kind === 'alignment' &&
    start !== null &&
    read !== '' &&
    read.split('\n').some((text, i) => now[start + i - 1]?.text !== text);
  const entryIds = Array.isArray(f.entryIds) ? (f.entryIds as string[]) : [];
  const changeSet = Array.isArray(f.changeSet) ? (f.changeSet as FreshFinding['changeSet']) : [];
  return {
    id: str(f._id),
    key: str(f.key),
    kind: f.kind === 'structural' ? 'structural' : 'alignment',
    check: str(f.check),
    label: labelOf(f),
    chapterId: str(f.chapterId) || null,
    chapter: chapter ? entryTitle(chapter) : null,
    readingOrder: chapter ? num(chapter.readingOrder) : null,
    strandId: str(f.strandId) || null,
    storyYear: num(f.storyYear),
    title: entryTitle(f),
    text: str(f.text),
    lines,
    lineStart: start,
    lineEnd: num(f.lineEnd),
    textChanged,
    entries: entryIds.map((id) => {
      const c = collectionOf(data, id);
      const d = c ? findEntry(data, c, id) : undefined;
      return { collection: c ?? '', id, title: d ? entryTitle(d) : id, found: !!d };
    }),
    mustChange: str(f.mustChange),
    state: (['open', 'manuscriptWins', 'rewrite', 'dismissed'].includes(str(f.state))
      ? f.state
      : 'open') as FindingWire['state'],
    changes: describeChangeSet(data, changeSet),
    rejectedChanges: Array.isArray(f.rejectedChanges) ? (f.rejectedChanges as ChangeProblem[]) : [],
    shown: shownRevisions(data, changeSet),
    createdAt: str(f.createdAt),
  };
}

/** CC-3, CC-4: the findings for one chapter or all, in reading order; dismissed ones only counted. */
export function listFindings(
  session: OpenBible,
  chapterId: string | null,
  states: FindingWire['state'][] = ['open', 'manuscriptWins', 'rewrite'],
): { findings: FindingWire[]; dismissed: number } {
  const all = findings(session).filter((f) => chapterId === null || f.chapterId === chapterId);
  const order = (f: Doc) => {
    const c = str(f.chapterId) ? findEntry(session.model, 'chapters', str(f.chapterId)) : undefined;
    return c ? (num(c.readingOrder) ?? 0) : Number.MAX_SAFE_INTEGER;
  };
  const shown = all
    .filter((f) => states.includes(str(f.state) as FindingWire['state']))
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        (a.kind === b.kind ? 0 : a.kind === 'structural' ? -1 : 1) ||
        (num(a.lineStart) ?? 0) - (num(b.lineStart) ?? 0) ||
        str(a.createdAt).localeCompare(str(b.createdAt)) ||
        str(a._id).localeCompare(str(b._id)),
    );
  return {
    findings: shown.map((f) => findingWire(session, f)),
    dismissed: all.filter((f) => f.state === 'dismissed').length,
  };
}

/**
 * CC-4: carry out a resolution. Manuscript wins takes a snapshot, then writes
 * every change in the set and the finding's new state in one transaction.
 * Returns each entry before and after, for one undo step in the renderer.
 */
export async function resolveFinding(
  session: OpenBible,
  id: string,
  action: 'manuscriptWins' | 'rewrite' | 'dismiss' | 'done',
  shown?: readonly { collection: string; id: string; modifiedAt: string }[],
) {
  const data = session.model;
  const f = findEntry(data, 'findings', id);
  if (!f) throw new Error('That finding is not in the bible.');
  // A resolution starts from the state the person saw: an open finding, or a rewrite task for Done.
  const needs = action === 'done' ? 'rewrite' : 'open';
  if (f.state !== needs) {
    throw new Error(
      action === 'done'
        ? 'This finding is not a rewrite task, so it cannot be marked done.'
        : f.state === 'dismissed'
          ? 'This finding was already dismissed.'
          : f.state === 'manuscriptWins'
            ? 'The bible was already updated from this finding.'
            : f.state === 'rewrite'
              ? 'This finding is already a rewrite task. Mark it done from the rewrite tasks.'
              : 'This finding is not open.',
    );
  }
  const ops: Parameters<OpenBible['repo']['writeBatch']>[0] = [];
  const before = new Map<string, { collection: EntryCollection; id: string; doc: Doc }>();
  let note: string;
  if (action === 'manuscriptWins') {
    if (f.kind !== 'alignment') throw new Error('A structural finding has no change set to apply.');
    const changeSet = Array.isArray(f.changeSet) ? (f.changeSet as FreshFinding['changeSet']) : [];
    if (!changeSet.length) {
      throw new Error(
        'This finding has no change set to apply. Choose Rewrite recommended or Dismiss.',
      );
    }
    const patches = changeSetPatches(data, changeSet);
    for (const p of patches) {
      const seen = shown?.find((x) => x.collection === p.collection && x.id === p.id);
      if (shown && (!seen || seen.modifiedAt !== str(p.before.modifiedAt))) {
        throw new Error(
          `${entryTitle(p.before)} changed after this comparison was shown, so nothing was applied. Close the comparison and open it again.`,
        );
      }
      before.set(`${p.collection}:${p.id}`, { collection: p.collection, id: p.id, doc: p.before });
      ops.push({ op: 'update', collection: p.collection, id: p.id, patch: p.patch });
    }
    ops.push({ op: 'update', collection: 'findings', id, patch: { state: 'manuscriptWins' } });
    note = `Manuscript wins: ${entryTitle(f)}`;
  } else if (action === 'rewrite') {
    if (f.kind !== 'alignment') throw new Error('A structural finding has no lines to rewrite.');
    ops.push({ op: 'update', collection: 'findings', id, patch: { state: 'rewrite' } });
    note = 'Rewrite recommended';
  } else {
    const kindOf = {
      kind: str(f.kind),
      chapterId: str(f.chapterId) || null,
      entryIds: Array.isArray(f.entryIds) ? (f.entryIds as string[]) : [],
    };
    ops.push({
      op: 'update',
      collection: 'findings',
      id,
      patch: { state: 'dismissed', dismissal: dismissalFor(data, kindOf) },
    });
    note = action === 'done' ? 'Rewrite task done' : 'Dismissed';
  }
  before.set(`findings:${id}`, { collection: 'findings', id, doc: f });
  const written = await session.repo.writeBatch(ops, {
    note,
    ...(action === 'manuscriptWins' ? { bulk: 'manuscript wins' } : {}),
  });
  const after = new Map(written.map((d) => [d._id, d]));
  const changes = [...before.values()].map((b) => ({
    collection: b.collection,
    id: b.id,
    before: b.doc as Doc & { _id: string; modifiedAt: string },
    after: after.get(b.id) as unknown as Doc & { _id: string; modifiedAt: string },
  }));
  const warnings = changes
    .filter((c) => c.collection !== ('findings' as string) && c.after)
    .flatMap((c) =>
      session.repo.warnings(c.collection, c.after as never).map((w) => ({
        collection: c.collection,
        id: c.id,
        entry: entryTitle(c.after),
        path: w.path,
        code: w.code,
        message: w.message,
      })),
    );
  return {
    finding: findingWire(session, (findEntry(session.model, 'findings', id) ?? f) as Doc),
    changes,
    warnings,
  };
}
