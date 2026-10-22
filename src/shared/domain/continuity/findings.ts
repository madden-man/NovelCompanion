/**
 * Findings as stored entries (CC-4): what a run writes, how a re-run meets
 * the findings already stored, and what Dismiss is stored against. Pure; the
 * main process writes the plan through the repository in one transaction.
 *
 * Re-run rules, by the finding's stable key:
 * - new key: a new open finding;
 * - open: its text, lines, and change set are refreshed, except a text,
 *   quote or what must change the writer edited since the last run (IP-7,
 *   ED-7): the edit stays, and what the check says now is kept in `proposed`
 *   for the card to offer;
 * - dismissed: stays dismissed and hidden while the chapter text (or, for a
 *   structural finding, the chapter's strands and links) and
 *   every cited entry's revision are unchanged; otherwise it opens again;
 * - rewrite: the task stands as it is;
 * - manuscript wins: the change was applied, yet the conflict is back, so it opens again;
 * - an open finding in the run's scope that is no longer found goes to the trash.
 */
import { manifests } from '../../schema';
import type { ChangeSetItem, EntryCollection } from '../../schema';
import { patchBetween } from '../diff';
import type { Doc } from '../paths';
import type { TimelineData } from '../timeline';
import type { UndoCommand, Op } from '../undoRunner';
import { collectionOf, findEntry } from './changeSet';
import type { ChangeProblem } from './changeSet';
import { textHash } from './lines';
import type { CheckedAlignment } from './alignment';
import type { StructuralFinding } from './structural';

export type FindingState = 'open' | 'manuscriptWins' | 'rewrite' | 'dismissed';

/** A finding as a run produces it, before it meets the stored ones. */
export interface FreshFinding {
  key: string;
  kind: 'structural' | 'alignment';
  check: string;
  chapterId: string | null;
  strandId: string | null;
  storyYear: number | null;
  entryIds: string[];
  title: string;
  text: string;
  quote: string;
  lineStart: number | null;
  lineEnd: number | null;
  mustChange: string;
  changeSet: ChangeSetItem[];
  rejectedChanges: ChangeProblem[];
  runId: string | null;
}

export function fromStructural(f: StructuralFinding): FreshFinding {
  return {
    key: f.key,
    kind: 'structural',
    check: f.check,
    chapterId: f.chapterId,
    strandId: f.strandId,
    storyYear: f.storyYear,
    entryIds: f.entryIds,
    title: f.title,
    text: f.explanation,
    quote: '',
    lineStart: null,
    lineEnd: null,
    mustChange: '',
    changeSet: [],
    rejectedChanges: [],
    runId: null,
  };
}

export function fromAlignment(
  f: CheckedAlignment,
  extra: { storyYear: number | null; runId: string },
): FreshFinding {
  return {
    key: f.key,
    kind: 'alignment',
    check: f.check,
    chapterId: f.chapterId,
    strandId: null,
    storyYear: extra.storyYear,
    entryIds: f.entryIds,
    title: f.title,
    text: f.text,
    quote: f.quote,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    mustChange: f.mustChange,
    changeSet: f.changeSet,
    rejectedChanges: f.rejectedChanges,
    runId: extra.runId,
  };
}

/**
 * CC-4 Dismiss: a hash of the chapter text (alignment) or of the chapter's
 * plot fields (structural), and a hash of each cited entry's revision.
 */
export function dismissalFor(
  data: TimelineData,
  f: { kind: string; chapterId: string | null; entryIds: readonly string[] },
): { textHash: string; entryHash: string } {
  const chapter = f.chapterId ? findEntry(data, 'chapters', f.chapterId) : undefined;
  const text = !chapter
    ? ''
    : f.kind === 'alignment'
      ? typeof chapter.manuscriptText === 'string'
        ? chapter.manuscriptText
        : ''
      : // The empty middle slot held facts in play before A39; kept so earlier dismissals still match.
        JSON.stringify([chapter.strands ?? [], [], chapter.links ?? []]);
  const revisions = [...new Set(f.entryIds)]
    .sort()
    .map((id) => {
      const c = collectionOf(data, id);
      const d = c ? findEntry(data, c, id) : undefined;
      return `${id}@${d ? String(d.modifiedAt) : 'missing'}`;
    })
    .join('|');
  return { textHash: textHash(text), entryHash: textHash(revisions) };
}

/** True while a dismissed finding should stay hidden: neither the text nor a cited entry changed. */
export function stillDismissed(stored: Doc, data: TimelineData): boolean {
  const d = stored.dismissal as { textHash?: string; entryHash?: string } | null | undefined;
  if (!d) return false;
  const now = dismissalFor(data, {
    kind: String(stored.kind),
    chapterId: typeof stored.chapterId === 'string' ? stored.chapterId : null,
    entryIds: Array.isArray(stored.entryIds) ? (stored.entryIds as string[]) : [],
  });
  return now.textHash === d.textHash && now.entryHash === d.entryHash;
}

function content(f: FreshFinding): Doc {
  return {
    title: f.title,
    text: f.text,
    quote: f.quote,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    entryIds: f.entryIds,
    check: f.check,
    strandId: f.strandId,
    storyYear: f.storyYear,
    mustChange: f.mustChange,
    changeSet: f.changeSet,
    rejectedChanges: f.rejectedChanges,
    runId: f.runId,
  };
}

/** IP-7, ED-7: the fields a writer may edit on the card, which a re-run never writes over. */
export const WORDING_FIELDS = ['text', 'quote', 'mustChange'] as const;
export type WordingField = (typeof WORDING_FIELDS)[number];
type Wording = Record<WordingField, string>;

const wordingOf = (f: FreshFinding): Wording => ({
  text: f.text,
  quote: f.quote,
  mustChange: f.mustChange,
});

const storedWording = (v: unknown): Wording | null =>
  v !== null &&
  typeof v === 'object' &&
  WORDING_FIELDS.every((k) => typeof (v as Doc)[k] === 'string')
    ? (v as Wording)
    : null;

/**
 * IP-7, ED-7: the patch a re-run makes to a stored finding. A wording field
 * that differs from what the last run wrote was edited by the writer: it
 * stays, and a new wording from this run goes to `proposed` (a proposal
 * still pending stays). A finding stored before `generated` existed counts
 * as untouched. Only the fields that change are in the patch.
 */
function refresh(s: Doc, f: FreshFinding): Doc {
  const now = wordingOf(f);
  const kept = new Set<string>();
  const last = storedWording(s.generated);
  const prior = (s.proposed && typeof s.proposed === 'object' ? s.proposed : {}) as Doc;
  const proposed: Partial<Wording> = {};
  for (const k of WORDING_FIELDS) {
    const mine = typeof s[k] === 'string' ? (s[k] as string) : '';
    if (last === null || mine === last[k]) continue;
    kept.add(k);
    if (now[k] !== mine && (now[k] !== last[k] || prior[k] === now[k])) proposed[k] = now[k];
  }
  const out: Doc = {
    ...Object.fromEntries(Object.entries(content(f)).filter(([k]) => !kept.has(k))),
    generated: now,
    proposed: Object.keys(proposed).length ? proposed : null,
  };
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => !same(s[k], v)));
}

/** The new entry for a fresh finding. */
export function newFindingData(f: FreshFinding): Doc {
  return {
    ...content(f),
    generated: wordingOf(f),
    proposed: null,
    key: f.key,
    kind: f.kind,
    chapterId: f.chapterId,
    status: 'planned',
    state: 'open',
  };
}

export interface ReconcilePlan {
  creates: Doc[];
  updates: { id: string; patch: Doc }[];
  trash: string[];
  /** Dismissed findings found again with nothing changed: kept hidden. */
  hidden: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Meet a run's findings with the stored ones. `inScope` says which stored
 * findings the run covered, so an open one it no longer finds can go.
 */
export function reconcile(
  stored: readonly Doc[],
  fresh: readonly FreshFinding[],
  inScope: (f: Doc) => boolean,
  data: TimelineData,
): ReconcilePlan {
  const plan: ReconcilePlan = { creates: [], updates: [], trash: [], hidden: 0 };
  const live = stored.filter((d) => !d.deletedAt && typeof d.key === 'string' && d.key);
  const byKey = new Map<string, Doc>();
  // The newest stored finding with a key decides.
  for (const d of [...live].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  )) {
    byKey.set(String(d.key), d);
  }
  const found = new Set<string>();
  for (const f of fresh) {
    if (found.has(f.key)) continue;
    found.add(f.key);
    let s = byKey.get(f.key);
    // A live model may cite a different set or order, which makes a new key. A
    // dismissed finding of the same chapter and kind on the same quoted lines is the same finding.
    // The quote the check wrote decides, so a hand edit to the quote (IP-7) does not bring it back.
    if (!s && f.kind === 'alignment') {
      const qh = textHash(f.quote);
      s = live.find(
        (d) =>
          d.state === 'dismissed' &&
          d.kind === 'alignment' &&
          d.chapterId === f.chapterId &&
          d.check === f.check &&
          [storedWording(d.generated)?.quote, d.quote].some(
            (q) => typeof q === 'string' && textHash(q) === qh,
          ),
      );
      if (s) found.add(String(s.key));
    }
    if (!s) {
      plan.creates.push(newFindingData(f));
      continue;
    }
    const id = String(s._id);
    const changed = (): Doc => refresh(s, f);
    switch (s.state as FindingState) {
      case 'open': {
        const patch = changed();
        if (Object.keys(patch).length) plan.updates.push({ id, patch });
        break;
      }
      case 'dismissed':
        if (stillDismissed(s, data)) plan.hidden++;
        else plan.updates.push({ id, patch: { ...changed(), state: 'open', dismissal: null } });
        break;
      case 'manuscriptWins':
        plan.updates.push({ id, patch: { ...changed(), state: 'open' } });
        break;
      case 'rewrite':
        break;
    }
  }
  for (const s of live) {
    if (s.state === 'open' && inScope(s) && !found.has(String(s.key)))
      plan.trash.push(String(s._id));
  }
  return plan;
}

/** Only fields a person may edit, so an undo step goes through `entry.update` like any other. */
function editable(collection: EntryCollection, patch: Doc): Doc {
  const system = new Set(
    manifests[collection].filter((s) => s.kind === 'system').map((s) => s.name),
  );
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !system.has(k)));
}

/**
 * One undo step for a resolution (ED-3, CC-4): every entry it changed goes
 * back, and the finding goes back to its earlier state. Steps replay through
 * the write path and are skipped if an entry changed since.
 */
export function resolutionCommand(
  label: string,
  changes: readonly { collection: EntryCollection; before: Doc; after: Doc; id: string }[],
): UndoCommand {
  const undo: Op[] = [];
  const redo: Op[] = [];
  for (const c of changes) {
    const { forward, backward } = patchBetween(c.before, c.after);
    const fwd = editable(c.collection, forward);
    const back = editable(c.collection, backward);
    if (!Object.keys(fwd).length) continue;
    undo.push({ kind: 'update', collection: c.collection, id: c.id, patch: back, expect: fwd });
    redo.push({ kind: 'update', collection: c.collection, id: c.id, patch: fwd, expect: back });
  }
  return { label, undo: undo.reverse(), redo };
}
