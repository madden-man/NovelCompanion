/**
 * Manuscript chapters (MS-1 to MS-5): the text diff shown on re-import and
 * the "summary may be out of date" rule. Pure functions; nothing here writes
 * anywhere, and no code path in the app writes to a manuscript file or
 * document (MS-5, A4).
 */
import { plain } from './brief/selection';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The manuscript as lines of plain text, one per paragraph; a scene break is `* * *`. */
export function manuscriptLines(body: string): string[] {
  return plain(body)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Line number in the old text (removed, same) or the new text (added). */
  line: number;
}

/**
 * MS-4: a line diff of two texts (longest common subsequence), in reading
 * order: removed lines before the added lines that replace them.
 */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // LCS lengths from the end, so the walk below goes forward.
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => table[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i] ?? '', line: i + 1 });
      i++;
      j++;
    } else if (j >= m || (i < n && at(i + 1, j) >= at(i, j + 1))) {
      out.push({ kind: 'removed', text: before[i] ?? '', line: i + 1 });
      i++;
    } else {
      out.push({ kind: 'added', text: after[j] ?? '', line: j + 1 });
      j++;
    }
  }
  return out;
}

export interface ManuscriptChange {
  changed: boolean;
  diff: DiffLine[];
  added: number;
  removed: number;
  /** MS-4: true when the text changed and the chapter has a summary to doubt. */
  summaryOutOfDate: boolean;
}

/** MS-4: what re-importing a chapter changes, and whether its summary may be out of date. */
export function manuscriptChange(
  chapter: Record<string, unknown>,
  nextBody: string,
): ManuscriptChange {
  const before = manuscriptLines(str(chapter.manuscriptText));
  const after = manuscriptLines(nextBody);
  const diff = lineDiff(before, after);
  const added = diff.filter((d) => d.kind === 'added').length;
  const removed = diff.filter((d) => d.kind === 'removed').length;
  const changed = added + removed > 0;
  const hadText = before.length > 0;
  return {
    changed,
    diff,
    added,
    removed,
    summaryOutOfDate:
      chapter.summaryOutOfDate === true ||
      (changed && hadText && str(chapter.summary).trim() !== ''),
  };
}
