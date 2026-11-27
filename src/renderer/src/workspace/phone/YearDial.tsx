import { useRef, useState } from 'react';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { typedNumber } from '../editable/model';
import { useStoryTime } from '../storyTime';
import { useYearView } from '../timeline/common';
import { useStrandOptions } from '../timeline/StoryTimeDialog';
import { useYearBounds } from '../TopBar';
import type { StoryTimeValue } from '../../../../shared/storyTime';
import './year.css';

const STEPS = [-10, -1, 1, 10] as const;
const stepLabel = (by: number) =>
  `${by < 0 ? 'Back' : 'Forward'} ${Math.abs(by)} ${Math.abs(by) === 1 ? 'year' : 'years'}`;

/**
 * A58 U3 (PH-29, TM-1, TM-4): the story year dial in the year sheet. The year
 * large in the middle, typed or stepped by one and ten with the thumb, the era
 * under it; the slider over the bible's years; month and day once asked for;
 * a person and an age that move the year; the Writing strand; and the year
 * view as a page. It sets the story time as the desk does (`useStoryTime`):
 * screens redraw at once and the value is saved a moment later, no entry
 * written (TM-5).
 */
export function YearDial(props: { onOpenYear: () => void }) {
  const story = useStoryTime();
  const strands = useStrandOptions();
  const bounds = useYearBounds();
  const characters = useEntries('characters');
  const time: StoryTimeValue = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [draft, setDraft] = useState<string | null>(null);
  const [wantDate, setWantDate] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [age, setAge] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const ask = useRef(0);
  const monthInput = useRef<HTMLInputElement>(null);
  const showDate = wantDate || time.month !== undefined;
  const writing = strands.find(
    (s) => s.chapterId === time.chapterId && s.strandId === time.strandId,
  );

  const keep = (t: StoryTimeValue): StoryTimeValue => ({
    ...t,
    ...(time.chapterId ? { chapterId: time.chapterId } : {}),
    ...(time.chapterId && time.strandId ? { strandId: time.strandId } : {}),
  });
  const setTo = (t: StoryTimeValue) => {
    setNote(null);
    story.set(t);
  };
  // The typed year commits on Enter or blur, never per keystroke (2045 must not set 2, 20, 204).
  const commit = () => {
    const t = draft;
    setDraft(null);
    if (t !== null && /^-?\d{1,5}$/.test(t.trim())) setTo(keep({ year: Number(t) }));
  };
  const step = (by: number) => {
    setDraft(null);
    setTo(keep({ year: time.year + by }));
  };
  const onDate = (part: 'month' | 'day', text: string) => {
    const v = text.replace(/\D/g, '').slice(0, 2);
    (part === 'month' ? setMonth : setDay)(v);
    const m = part === 'month' ? v : (month ?? (time.month ? String(time.month) : ''));
    const d = part === 'day' ? v : (day ?? (time.day ? String(time.day) : ''));
    if (m === '') return setTo(keep({ year: time.year }));
    const mm = Number(m);
    const dd = d === '' ? null : Number(d);
    if (mm < 1 || mm > 12) return;
    if (dd !== null && (dd < 1 || dd > 31)) return;
    setTo(keep({ year: time.year, month: mm, ...(dd !== null ? { day: dd } : {}) }));
  };
  const yearOnly = () => {
    setWantDate(false);
    setMonth(null);
    setDay(null);
    setTo(keep({ year: time.year }));
  };
  /** TM-4: a person and an age move the year as soon as both are there. */
  const byAge = async (characterId: string, ageText: string) => {
    if (!characterId || ageText === '') return;
    const n = ++ask.current;
    try {
      const r = await call('storyTime.anchorAge', { characterId, age: Number(ageText) });
      if (n !== ask.current) return;
      if (r.year === null) return setNote(r.message);
      setDraft(null);
      setTo(keep({ year: r.year }));
    } catch (e) {
      if (n === ask.current) setNote(plainError(e));
    }
  };
  const pickStrand = (key: string) => {
    const s = strands.find((o) => o.key === key);
    if (!s) setTo({ year: time.year });
    else setTo({ year: s.year ?? time.year, chapterId: s.chapterId, strandId: s.strandId });
  };

  return (
    <div className="ph-dial" data-testid="year-dial">
      <div className="ph-dial-row">
        {STEPS.slice(0, 2).map((by) => (
          <button
            key={by}
            type="button"
            className="ph-step"
            aria-label={stepLabel(by)}
            onClick={() => step(by)}
            data-testid={`year-step-${by}`}
          >
            {by}
          </button>
        ))}
        <input
          className="num ph-dial-year"
          aria-label="Story year"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={6}
          value={draft ?? String(time.year)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const v = typedNumber('year', e.target.value);
            if (v !== null) setDraft(v);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') setDraft(null);
          }}
          data-testid="sheet-year"
        />
        {STEPS.slice(2).map((by) => (
          <button
            key={by}
            type="button"
            className="ph-step"
            aria-label={stepLabel(by)}
            onClick={() => step(by)}
            data-testid={`year-step-${by}`}
          >
            +{by}
          </button>
        ))}
      </div>
      <p className="ph-dial-era" data-testid="sheet-era">
        {view?.era ? view.era.name : view ? 'No era' : ' '}
      </p>
      <input
        type="range"
        aria-label="Story year"
        min={bounds.min}
        max={bounds.max}
        value={time.year}
        onChange={(e) => {
          setDraft(null);
          setTo(keep({ year: Number(e.target.value) }));
        }}
        data-testid="sheet-year-slider"
      />
      {showDate ? (
        <div className="ph-dial-date" role="group" aria-label="Month and day">
          <label className="field">
            Month
            <input
              className="num"
              inputMode="numeric"
              maxLength={2}
              ref={monthInput}
              value={month ?? (time.month ? String(time.month) : '')}
              onChange={(e) => onDate('month', e.target.value)}
              onBlur={() => setMonth(null)}
              data-testid="sheet-month"
            />
          </label>
          <label className="field">
            Day
            <input
              className="num"
              inputMode="numeric"
              maxLength={2}
              value={day ?? (time.day ? String(time.day) : '')}
              onChange={(e) => onDate('day', e.target.value)}
              onBlur={() => setDay(null)}
              data-testid="sheet-day"
            />
          </label>
          <button type="button" className="btn" onClick={yearOnly}>
            Year only
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn ph-dial-more"
          onClick={() => {
            setWantDate(true);
            requestAnimationFrame(() => monthInput.current?.focus());
          }}
          data-testid="sheet-add-month"
        >
          + month
        </button>
      )}
      <div className="ph-dial-age" role="group" aria-label="Year by age">
        <label className="field">
          Person
          <select
            value={person}
            onChange={(e) => {
              setPerson(e.target.value);
              void byAge(e.target.value, age);
            }}
            data-testid="sheet-person"
          >
            <option value="">None</option>
            {characters.map((c) => (
              <option key={c._id} value={c._id}>
                {String((c.names as { full?: string } | undefined)?.full ?? c.title)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Age
          <input
            className="num"
            inputMode="numeric"
            maxLength={3}
            value={age}
            onChange={(e) => {
              const a = e.target.value.replace(/\D/g, '').slice(0, 3);
              setAge(a);
              void byAge(person, a);
            }}
            data-testid="sheet-age"
          />
        </label>
      </div>
      {note && (
        <p className="callout warn" role="status" data-testid="sheet-note">
          {note}
        </p>
      )}
      <label className="field">
        Writing
        <select
          value={writing?.key ?? ''}
          onChange={(e) => pickStrand(e.target.value)}
          data-testid="sheet-writing"
        >
          <option value="">No chapter picked</option>
          {strands.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn ph-dial-open"
        onClick={props.onOpenYear}
        data-testid="sheet-open-year"
      >
        Year view
      </button>
    </div>
  );
}
