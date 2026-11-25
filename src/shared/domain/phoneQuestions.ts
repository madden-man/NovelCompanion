/**
 * A56 (FN-7): the bible's open questions as the phone left them. A question
 * page the phone sent says whether it is answered (This answers it, with
 * its wise lines), resolved (`resolvedByTap`, maybe no wise line), taken back
 * (open again) or asked there (an ID the bible does not hold). This reads
 * those rows and says what to write, the newer change winning. Pure: no
 * Electron, MongoDB or React (ARCHITECTURE rule 1).
 */
import type { UpRow } from '../bridge';
import { createCommand, editCommand } from './undoRunner';
import type { UndoCommand } from './undoRunner';

/** A question page as the phone last sent it. */
export interface PhoneQuestion {
  id: string;
  /** The question as asked (the page's title). */
  title: string;
  state: 'open' | 'answered';
  resolvedByTap: boolean;
  /** The newest wise line's text, by `at`; null when no line is wise. */
  decision: string | null;
  /** When the phone last changed the page, in milliseconds. */
  changedAt: number;
}

/** What the bible holds of a question: its state, decision and last change. */
export interface BibleQuestion {
  id: string;
  state: 'open' | 'decided';
  decision: string;
  modifiedAt: string;
  deletedAt?: string;
}

export type QuestionOp =
  | {
      op: 'ask';
      id: string;
      data: { title: string; question: string; state: 'open' | 'decided'; decision: string };
    }
  | {
      op: 'set';
      id: string;
      before: { state: 'open' | 'decided'; decision: string };
      after: { state: 'open' | 'decided'; decision: string };
    };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The longest question title the bible takes from the phone. */
const TITLE_MAX = 2000;

/** FN-7: every question page one world's rows hold, with its decision read from its wise lines. */
export function phoneQuestions(rows: readonly UpRow[], world: string): PhoneQuestion[] {
  const mine = rows.filter((r) => r.world === world && !r.deleted && isObj(r.row));
  const wise = new Map<string, { at: number; id: string; text: string }>();
  for (const r of mine) {
    if (r.table !== 'messages') continue;
    const row = r.row as Record<string, unknown>;
    if (row.wise !== true || typeof row.pageId !== 'string' || typeof row.text !== 'string') {
      continue;
    }
    // The bible's own decision line came down and never goes up; if one does, it is not his.
    if (r.id.startsWith('d:')) continue;
    const at = num(row.at) ?? 0;
    const have = wise.get(row.pageId);
    if (!have || at > have.at || (at === have.at && r.id > have.id)) {
      wise.set(row.pageId, { at, id: r.id, text: row.text });
    }
  }
  const out: PhoneQuestion[] = [];
  for (const r of mine) {
    if (r.table !== 'pages') continue;
    const row = r.row as Record<string, unknown>;
    if (row.kind !== 'question') continue;
    const state = row.state === 'answered' ? 'answered' : 'open';
    const changedAt =
      num(row.updatedAt) ?? num(row.answeredAt) ?? num(row.createdAt) ?? num(r.at) ?? 0;
    out.push({
      id: r.id,
      title: (typeof row.title === 'string' ? row.title : '').trim().slice(0, TITLE_MAX),
      state,
      resolvedByTap: row.resolvedByTap === true,
      decision: wise.get(r.id)?.text.trim() || null,
      changedAt,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * FN-7: what the phone's question pages write into the bible. Answered: the
 * newest wise line is the decision and the question is decided; resolved with
 * no wise line: decided, the decision left as it was; open again: open, the
 * decision kept. An ID the bible lacks is a new question with the phone's ID.
 * A page changes its question only when the phone changed it after the
 * question last changed in the bible (the newer change wins), and never a
 * question in the trash or one already as the phone says.
 */
export function planQuestions(
  phone: readonly PhoneQuestion[],
  bible: ReadonlyMap<string, BibleQuestion>,
): QuestionOp[] {
  const ops: QuestionOp[] = [];
  for (const p of phone) {
    const q = bible.get(p.id);
    if (!q) {
      if (!p.title) continue;
      const decided = p.state === 'answered';
      ops.push({
        op: 'ask',
        id: p.id,
        data: {
          title: p.title.length > 120 ? `${p.title.slice(0, 119)}…` : p.title,
          question: p.title,
          state: decided ? 'decided' : 'open',
          decision: decided ? (p.decision ?? '') : '',
        },
      });
      continue;
    }
    if (q.deletedAt) continue;
    const bibleAt = Date.parse(q.modifiedAt);
    if (Number.isFinite(bibleAt) && p.changedAt <= bibleAt) continue;
    const before = { state: q.state, decision: q.decision };
    const after =
      p.state === 'answered'
        ? { state: 'decided' as const, decision: p.decision ?? q.decision }
        : { state: 'open' as const, decision: q.decision };
    if (after.state === before.state && after.decision === before.decision) continue;
    ops.push({ op: 'set', id: p.id, before, after });
  }
  return ops;
}

/** One question the phone changed, as main tells the renderer (event `notebook.questions`). */
export interface QuestionStep {
  id: string;
  /** The question's title in the bible, for the Changes list. */
  title: string;
  /** Null for a question asked on the phone (a new entry). */
  before: { state: 'open' | 'decided'; decision: string } | null;
  after: { state: 'open' | 'decided'; decision: string };
}

/**
 * FN-7 (ED-3): the undo step of one question the phone changed: undo puts the
 * state and decision back (or moves a question asked on the phone to the
 * trash), redo writes the phone's again; a step whose fields changed since is
 * skipped by the runner, as every step is.
 */
export function questionCommand(step: QuestionStep): UndoCommand {
  if (!step.before) {
    const c = createCommand('openQuestions', step.id, step.title);
    return { ...c, label: `Asked on the phone: ${step.title}` };
  }
  const c = editCommand(
    `From the phone: ${step.title}`,
    'openQuestions',
    step.id,
    step.before,
    step.after,
  );
  return c;
}
