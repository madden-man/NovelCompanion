import { planTitleCleanup } from '../../shared/domain/numbering';
import type { TitleCleanupPlan } from '../../shared/domain/numbering';
import type { OpenBible } from '../db/session';

export interface TitleCleanupOptions {
  /** The revision note on every rename and new question. */
  note: string;
  /** Tags for the open question written for each title whose number disagrees. */
  questionTags: string[];
}

export interface TitleCleanupResult {
  plan: TitleCleanupPlan;
  renamed: Record<'books' | 'parts' | 'chapters', number>;
  questions: number;
}

const KIND_WORD = { books: 'book', parts: 'part', chapters: 'chapter' } as const;

/**
 * Rewrite book, part, and chapter titles that repeat a structural number to
 * the bare name (PL-3), through the write path in one batch, so each rename
 * has a revision with the note. A title whose number disagrees with where the
 * entry is stays as it is, and an open question names both numbers. Only
 * titles change; numbers and reading order are left as they are.
 */
export async function applyTitleCleanup(
  open: OpenBible,
  opts: TitleCleanupOptions,
): Promise<TitleCleanupResult> {
  const plan = planTitleCleanup(open.model);
  const ops = [
    ...plan.renames.map((r) => ({
      op: 'update' as const,
      collection: r.collection,
      id: r.id,
      patch: { title: r.to },
    })),
    ...plan.disagreements.map((d) => ({
      op: 'create' as const,
      collection: 'openQuestions' as const,
      data: {
        title: `"${d.title}": which ${KIND_WORD[d.collection]} number is right?`,
        question: `The title "${d.title}" says ${KIND_WORD[d.collection]} ${d.says}, but the entry is at ${d.is}. The title was left as it is. Which is right? Once the place is right, the number in the title can go, since the app shows the number from the ${d.collection === 'chapters' ? 'reading order' : 'number field'}.`,
        tags: opts.questionTags,
        links: [{ targetId: d.id, kind: 'about' }],
        status: 'planned',
        state: 'open',
      },
    })),
  ];
  await open.repo.writeBatch(ops, { note: opts.note });
  const renamed = { books: 0, parts: 0, chapters: 0 };
  for (const r of plan.renames) renamed[r.collection] += 1;
  return { plan, renamed, questions: plan.disagreements.length };
}
