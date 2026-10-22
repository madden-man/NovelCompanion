import { familyToken } from '../../../../shared/domain/lists';
import { useEffect, useMemo, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { describeState } from '../../../../shared/domain/ages';
import type { LifeState } from '../../../../shared/domain/ages';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import { Zh } from '../Zh';
import '../vocab.css';

export type YearView = Response<'timeline.year'>;
export type Moment = { year: number; month?: number; day?: number };

/** Everyone's state, the era, the events, and the strands at a moment (TL-2, TM-2, WE-3). */
export function useYearView(at: Moment | null): YearView | null {
  const { version } = useStore();
  const [view, setView] = useState<YearView | null>(null);
  const year = at?.year ?? null;
  const month = at?.month;
  const day = at?.day;
  useEffect(() => {
    if (year === null) return;
    let live = true;
    const moment: Moment = {
      year,
      ...(month !== undefined ? { month } : {}),
      ...(month !== undefined && day !== undefined ? { day } : {}),
    };
    void call('timeline.year', { at: moment }).then((r) => {
      if (live) setView(r);
    });
    return () => {
      live = false;
    };
  }, [year, month, day, version]);
  return view;
}

/** Family names and display colors, for chips and lifespan bars. */
export function useFamilies(): Map<string, { name: string; color: string }> {
  const families = useEntries('families');
  return useMemo(
    () =>
      new Map(
        families.map((f) => [
          f._id,
          {
            name: typeof f.name === 'string' ? f.name : f._id,
            // IP-12: a seeded colour draws through its theme token; any other hex as itself.
            color:
              familyToken(f.color) ??
              (typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color)
                ? f.color.toLowerCase()
                : 'series-4'),
          },
        ]),
      ),
    [families],
  );
}

/** The class name the state dot and text use: alive, dying, dead, unborn, unknown. */
export function stateClass(s: LifeState): string {
  return s.state === 'alive' && s.dyingThisYear ? 'dying' : s.state;
}

export function StateText({ state }: { state: LifeState }) {
  return (
    <span className={`st ${stateClass(state)}`} data-state={stateClass(state)}>
      {describeState(state)}
    </span>
  );
}

export function FamilyChips(props: {
  ids: string[];
  families: Map<string, { name: string; color: string }>;
}) {
  if (!props.ids.length) return <span className="chip fam fam-none">No family</span>;
  return (
    <span className="row tight">
      {props.ids.map((id) => {
        const f = props.families.get(id);
        const hex = f?.color.startsWith('#') ? f.color : null;
        return hex ? (
          <span
            key={id}
            className="chip fam fam-hex"
            style={{ borderColor: hex }}
            data-family={hex}
          >
            <span className="fam-dot" style={{ background: hex }} aria-hidden="true" />
            <Zh text={f?.name ?? id} />
          </span>
        ) : (
          <span key={id} className={`chip fam fam-${f?.color ?? 'series-4'}`}>
            <Zh text={f?.name ?? id} />
          </span>
        );
      })}
    </span>
  );
}

/** "2040" or "2048 to 2051". */
export function span(a: number, b: number): string {
  return a === b ? String(a) : `${a} to ${b}`;
}
