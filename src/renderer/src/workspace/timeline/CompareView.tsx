import { useEffect, useId, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import type { LifeState } from '../../../../shared/domain/ages';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import { useStoryTime } from '../storyTime';

type Rows = Response<'timeline.compare'>['rows'];

function cell(s: LifeState): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `${s.age} (dies this year)` : String(s.age);
    case 'dead':
      return `dead (${s.deathYear})`;
    case 'unborn':
      return 'not yet born';
    case 'unknown':
      return 'age unknown';
  }
}

const intOrNull = (t: string): number | null => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);

/** TL-7: two characters' ages side by side across a year range, every year or every five. */
export function CompareView() {
  const { version } = useStore();
  const story = useStoryTime();
  const characters = useEntries('characters');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [from, setFrom] = useState(() => String(story.year));
  const [to, setTo] = useState(() => String(story.year + 40));
  const [step, setStep] = useState<1 | 5>(5);
  const [rows, setRows] = useState<Rows>([]);
  const ids = { a: useId(), b: useId(), from: useId(), to: useId(), step: useId() };
  const first = a || characters[0]?._id || '';
  const second = b || characters[1]?._id || characters[0]?._id || '';
  const f = intOrNull(from);
  const t = intOrNull(to);

  useEffect(() => {
    if (!first || !second || f === null || t === null) return;
    let live = true;
    void call('timeline.compare', { a: first, b: second, from: f, to: t, step }).then((r) => {
      if (live) setRows(r.rows);
    });
    return () => {
      live = false;
    };
  }, [first, second, f, t, step, version]);

  const name = (cid: string) => {
    const c = characters.find((x) => x._id === cid);
    return String((c?.names as { full?: string } | undefined)?.full ?? c?.title ?? cid);
  };
  const options = characters.map((c) => (
    <option key={c._id} value={c._id}>
      {name(c._id)}
    </option>
  ));

  return (
    <section className="ws-wide stack" aria-labelledby="compare-title" data-testid="compare-view">
      <h2 id="compare-title">Compare two characters</h2>
      <p className="example-note">Ages side by side across a year range, worked out in code.</p>
      <div className="tree-toolbar">
        <div className="field">
          <label htmlFor={ids.a}>First</label>
          <select id={ids.a} value={first} onChange={(e) => setA(e.target.value)}>
            {options}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.b}>Second</label>
          <select id={ids.b} value={second} onChange={(e) => setB(e.target.value)}>
            {options}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.from}>From</label>
          <input
            id={ids.from}
            type="number"
            className="num year-input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.to}>To</label>
          <input
            id={ids.to}
            type="number"
            className="num year-input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.step}>Step</label>
          <select
            id={ids.step}
            value={step}
            onChange={(e) => setStep(e.target.value === '1' ? 1 : 5)}
          >
            <option value={5}>Every 5 years</option>
            <option value={1}>Every year</option>
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table className="compact" data-testid="compare-table">
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">{name(first)}</th>
              <th scope="col">{name(second)}</th>
              <th scope="col">Age gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.year}
                data-year={r.year}
                className={r.year === story.year ? 'is-story-year' : undefined}
              >
                <td className="num">{r.year}</td>
                <td className="num">{cell(r.a)}</td>
                <td className="num">{cell(r.b)}</td>
                <td className="num">{r.gap === null ? '' : `${r.gap} years`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
