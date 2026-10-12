/**
 * Alignment findings by Claude (CC-3): the structured output Claude returns
 * and the checks code runs on it before anything is stored. Every cited ID
 * must be a live entry or beat, the line numbers must be in the chapter (a
 * quote found elsewhere in the chapter moves the numbers to where it is), and
 * every change set item must target a real field with a value that fits.
 * A finding that fails is reported with the reason, never stored.
 *
 * AI-4: a finding says what conflicts and, for a rewrite, what must change.
 * There is no field for replacement text, and the instructions forbid it.
 */
import { z } from 'zod';
import type { ChangeSetItem } from '../../schema';
import { checkChangeSet, collectionOf } from './changeSet';
import type { ChangeProblem } from './changeSet';
import { locateQuote } from './lines';
import type { NumberedLine } from './lines';
import type { TimelineData } from '../timeline';

export const ALIGNMENT_KINDS = [
  'age',
  'date',
  'place',
  'knowledge',
  'beatMissing',
  'order',
  'strandYear',
  'other',
] as const;
export type AlignmentKind = (typeof ALIGNMENT_KINDS)[number];

export const KIND_LABELS: Record<AlignmentKind, string> = {
  age: 'Age',
  date: 'Date',
  place: 'Place',
  knowledge: 'Knowledge',
  beatMissing: 'Planned beat not in the text',
  order: 'Chapter order',
  strandYear: 'Strand year',
  other: 'Other',
};

const ChangeOut = z.strictObject({
  /** The bible section, for example "characters", "plotBeats", or "chapters". */
  collection: z.string(),
  /** The entry's ID. */
  id: z.string(),
  /** The field, or "strands.<strand ID>.<field>" for a chapter strand. */
  field: z.string(),
  /** The new value as JSON text, for example "1970", "\"Shanghai\"", or "{\"year\": 1970}". */
  value: z.string(),
});

const FindingOut = z.strictObject({
  kind: z.enum(ALIGNMENT_KINDS),
  /** First and last line of the passage, from the line numbers in the material. */
  lineStart: z.int(),
  lineEnd: z.int(),
  /** The passage, quoted exactly from the chapter. */
  quote: z.string(),
  /** IDs of the entries or beats the passage conflicts with. */
  citedIds: z.array(z.string()),
  /** One or two plain sentences: what the text says, what the bible says. */
  explanation: z.string(),
  /** For a rewrite: a plain description of what must change in the text to match the bible. Never replacement text. */
  mustChange: z.string(),
  /** The field changes that would make the bible match the chapter instead. */
  changeSet: z.array(ChangeOut),
});
export type AlignmentFindingOut = z.infer<typeof FindingOut>;

export const AlignmentOutput = z.strictObject({ findings: z.array(FindingOut) });
export type AlignmentOutput = z.infer<typeof AlignmentOutput>;

/** A checked alignment finding, ready to be stored. */
export interface CheckedAlignment {
  key: string;
  check: AlignmentKind;
  chapterId: string;
  title: string;
  text: string;
  quote: string;
  lineStart: number;
  lineEnd: number;
  entryIds: string[];
  mustChange: string;
  changeSet: ChangeSetItem[];
  rejectedChanges: ChangeProblem[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The stable key of an alignment finding: chapter, kind, and the entries it cites. */
export function alignmentKey(chapterId: string, kind: string, cited: readonly string[]): string {
  return ['alignment', chapterId, kind, [...cited].sort().join('+')].join(':');
}

/** CC-3: check Claude's findings for one chapter against its lines and the read model. */
export function checkAlignment(
  output: AlignmentOutput,
  ctx: { chapterId: string; lines: readonly NumberedLine[]; data: TimelineData },
): { findings: CheckedAlignment[]; rejected: ChangeProblem[] } {
  const findings: CheckedAlignment[] = [];
  const rejected: ChangeProblem[] = [];
  const seen = new Map<string, number>();
  for (const f of output.findings) {
    const summary = `${KIND_LABELS[f.kind]}: ${oneLine(f.explanation).slice(0, 120)}`;
    const cited = [...new Set(f.citedIds.map((s) => s.trim()).filter(Boolean))];
    if (!cited.length) {
      rejected.push({ summary, reason: 'It cites no entry or beat.' });
      continue;
    }
    const missing = cited.filter((id) => collectionOf(ctx.data, id) === null);
    if (missing.length) {
      rejected.push({
        summary,
        reason: `It cites ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the bible.`,
      });
      continue;
    }
    const n = ctx.lines.length;
    const inRange = f.lineStart >= 1 && f.lineEnd >= f.lineStart && f.lineEnd <= n;
    let start = f.lineStart;
    let end = f.lineEnd;
    const given = inRange ? locateQuote(ctx.lines.slice(start - 1, end), f.quote) : null;
    if (!given) {
      const found = locateQuote(ctx.lines, f.quote);
      if (found) ({ start, end } = found);
      else if (!inRange) {
        rejected.push({
          summary,
          reason: `Its lines ${f.lineStart} to ${f.lineEnd} are not in the chapter, which has ${n} lines, and its quote is not in the text.`,
        });
        continue;
      }
    }
    const { valid, rejected: badChanges } = checkChangeSet(ctx.data, f.changeSet);
    let key = alignmentKey(ctx.chapterId, f.kind, cited);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) key = `${key}#${count}`;
    findings.push({
      key,
      check: f.kind,
      chapterId: ctx.chapterId,
      title: summary.slice(0, 200),
      text: oneLine(f.explanation),
      quote: ctx.lines
        .slice(start - 1, end)
        .map((l) => l.text)
        .join('\n'),
      lineStart: start,
      lineEnd: end,
      entryIds: cited,
      mustChange: oneLine(f.mustChange),
      changeSet: valid,
      rejectedChanges: badChanges,
    });
  }
  return { findings, rejected };
}
