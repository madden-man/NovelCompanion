/**
 * Moving one chapter strand to a new story year (TM-5). The preview the
 * Story Time dialog shows and the write the repository makes both come from
 * this one function, so what is shown is exactly what is written. A range
 * keeps its length; a single year stays a single year.
 */
import { isPlainObject } from './paths';

export interface StrandYears {
  startYear: number;
  endYear: number | null;
}

export interface StrandShift<S> {
  strand: S & { id: string; label: string } & StrandYears;
  from: StrandYears;
  to: StrandYears;
  /** Every strand of the chapter, with the one strand moved. */
  next: S[];
  unchanged: boolean;
}

type StrandLike = { id: string; label: string; startYear: number; endYear: number | null };

function isStrand(v: unknown): v is StrandLike {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.startYear === 'number' &&
    (v.endYear === null || v.endYear === undefined || typeof v.endYear === 'number')
  );
}

/** Move one strand to start in `year`. Null when the chapter has no such strand. */
export function shiftStrand<S extends object>(
  strands: readonly S[],
  strandId: string,
  year: number,
): StrandShift<S> | null {
  const strand = strands.find((s) => isStrand(s) && s.id === strandId) as
    (S & StrandLike) | undefined;
  if (!strand) return null;
  const end = strand.endYear ?? null;
  const shift = year - strand.startYear;
  const to: StrandYears = { startYear: year, endYear: end === null ? null : end + shift };
  const next = strands.map((s) =>
    s === strand ? ({ ...s, startYear: to.startYear, endYear: to.endYear } as S) : s,
  );
  return {
    strand: { ...strand, label: String(strand.label ?? ''), endYear: end },
    from: { startYear: strand.startYear, endYear: end },
    to,
    next,
    unchanged: shift === 0,
  };
}
