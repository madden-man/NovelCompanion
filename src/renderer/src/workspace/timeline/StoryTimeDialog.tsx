import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import type { StoryTimeValue } from '../../../../shared/storyTime';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { formatMoment, useStoryTime } from '../storyTime';
import { Zh } from '../Zh';
import { useFocusTrap } from '../focusTrap';
import { FamilyChips, StateText, span, useFamilies, useYearView } from './common';

type Preview = Response<'storyTime.promotePreview'>;

interface StrandOption {
  key: string;
  chapterId: string;
  strandId: string;
  label: string;
  year: number;
}

/** Every strand of every chapter, in reading order, for the strand anchor (TM-4). */
export function useStrandOptions(): StrandOption[] {
  const chapters = useEntries('chapters');
  return useMemo(() => {
    const out: StrandOption[] = [];
    const sorted = [...chapters].sort(
      (a, b) => Number(a.readingOrder ?? 0) - Number(b.readingOrder ?? 0),
    );
    for (const c of sorted) {
      const strands = Array.isArray(c.strands)
        ? (c.strands as { id: string; label: string; startYear: number; primary: boolean }[])
        : [];
      for (const s of strands) {
        out.push({
          key: `${c._id}|${s.id}`,
          chapterId: c._id,
          strandId: s.id,
          label: `Chapter ${String(c.readingOrder)}: ${String(c.title)}, ${s.label} (${s.startYear})`,
          year: s.startYear,
        });
      }
    }
    return out;
  }, [chapters]);
}

const intOrNull = (t: string): number | null => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);

/**
 * The Story Time dialog (TM-1 to TM-5). It opens from every screen with
 * Cmd+T. Setting the time writes only the bible's meta document; "Use as
 * strand year" is the one action here that changes an entry, and it shows
 * the change and waits for approval first (ED-7).
 */
export function StoryTimeDialog() {
  const story = useStoryTime();
  const close = story.closeDialog;
  const time: StoryTimeValue = story.time ?? { year: story.year };
  const view = useYearView(time);
  const families = useFamilies();
  const characters = useEntries('characters');
  const strands = useStrandOptions();
  const [yearDraft, setYearDraft] = useState<string | null>(null);
  const [monthDraft, setMonthDraft] = useState<string | null>(null);
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  const [anchorChar, setAnchorChar] = useState('');
  const [anchorAge, setAnchorAge] = useState('');
  const [anchorStrand, setAnchorStrand] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const yearInput = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const ids = {
    title: useId(),
    year: useId(),
    month: useId(),
    day: useId(),
    char: useId(),
    age: useId(),
    strand: useId(),
  };

  useEffect(() => {
    opener.current = document.activeElement;
    yearInput.current?.focus();
    yearInput.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [close]);

  const keep = (t: StoryTimeValue): StoryTimeValue => ({
    ...t,
    ...(time.chapterId ? { chapterId: time.chapterId } : {}),
    ...(time.chapterId && time.strandId ? { strandId: time.strandId } : {}),
  });
  const setTo = (t: StoryTimeValue, why: string | null) => {
    setPreview(null);
    story.set(t);
    setNote(why ? { text: `Story time set to ${formatMoment(t)} (${why}).`, bad: false } : null);
  };

  const onYear = (text: string) => {
    const y = intOrNull(text);
    if (y === null) return setYearDraft(text);
    setYearDraft(null);
    setTo(keep({ year: y }), null);
  };
  const onDate = (part: 'month' | 'day', text: string) => {
    (part === 'month' ? setMonthDraft : setDayDraft)(text);
    const m = part === 'month' ? text : (monthDraft ?? (time.month ? String(time.month) : ''));
    const d = part === 'day' ? text : (dayDraft ?? (time.day ? String(time.day) : ''));
    const mm = intOrNull(m);
    const dd = intOrNull(d);
    if (m.trim() === '') return setTo(keep({ year: time.year }), null);
    if (mm === null || mm < 1 || mm > 12) return;
    if (d.trim() !== '' && (dd === null || dd < 1 || dd > 31)) return;
    setTo(keep({ year: time.year, month: mm, ...(dd !== null ? { day: dd } : {}) }), null);
  };
  const step = (by: number) => {
    setYearDraft(null);
    setTo(keep({ year: time.year + by }), `${by > 0 ? '+' : ''}${by}`);
  };
  const anchorByAge = async () => {
    const age = intOrNull(anchorAge);
    if (!anchorChar) return setNote({ text: 'Pick a character first.', bad: true });
    if (age === null || age < 0)
      return setNote({ text: 'Enter an age in whole years.', bad: true });
    try {
      const r = await call('storyTime.anchorAge', { characterId: anchorChar, age });
      if (r.year === null) return setNote({ text: r.message, bad: true });
      setYearDraft(null);
      setTo(keep({ year: r.year }), r.message.replace(/\.$/, ''));
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
  };
  const anchorByStrand = () => {
    const s = strands.find((o) => o.key === anchorStrand);
    if (!s) return setNote({ text: 'Pick a strand first.', bad: true });
    setYearDraft(null);
    setTo({ year: s.year, chapterId: s.chapterId, strandId: s.strandId }, s.label);
  };
  const clearChapter = () => setTo({ year: time.year }, null);

  const current = strands.find(
    (o) => o.chapterId === time.chapterId && o.strandId === time.strandId,
  );
  const askPromote = async () => {
    if (!time.chapterId || !time.strandId) return;
    try {
      await story.flush();
      setPreview(
        await call('storyTime.promotePreview', {
          chapterId: time.chapterId,
          strandId: time.strandId,
        }),
      );
      setNote(null);
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
  };
  const promote = async () => {
    if (!preview) return;
    try {
      await call('storyTime.promote', {
        chapterId: preview.chapterId,
        strandId: preview.strandId,
        baseModifiedAt: preview.baseModifiedAt,
      });
      setNote({
        text: `${preview.chapterTitle}, ${preview.strandLabel} strand, now has the year ${preview.year}.`,
        bad: false,
      });
      setPreview(null);
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
  };

  const rangeText = (r: { startYear: number; endYear: number | null }) =>
    r.endYear === null ? String(r.startYear) : span(r.startYear, r.endYear);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        data-testid="story-time-dialog"
      >
        <header className="dialog-head">
          <div className="stack tight">
            <span className="eyebrow">Story time</span>
            <h2 id={ids.title}>Where in the story are you writing?</h2>
          </div>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </header>
        <div className="time-controls">
          <div className="stack">
            <div className="time-now num" data-testid="time-now" aria-live="polite">
              {formatMoment(time)}
            </div>
            <div className="row tight">
              <div className="field">
                <label htmlFor={ids.year}>Year</label>
                <input
                  ref={yearInput}
                  id={ids.year}
                  type="number"
                  className="num year-input"
                  value={yearDraft ?? String(time.year)}
                  onChange={(e) => onYear(e.target.value)}
                  onBlur={() => setYearDraft(null)}
                  data-testid="time-year"
                />
              </div>
              <div className="field">
                <label htmlFor={ids.month}>Month</label>
                <input
                  id={ids.month}
                  type="number"
                  min={1}
                  max={12}
                  className="num date-input"
                  value={monthDraft ?? (time.month ? String(time.month) : '')}
                  onChange={(e) => onDate('month', e.target.value)}
                  onBlur={() => setMonthDraft(null)}
                />
              </div>
              <div className="field">
                <label htmlFor={ids.day}>Day</label>
                <input
                  id={ids.day}
                  type="number"
                  min={1}
                  max={31}
                  className="num date-input"
                  value={dayDraft ?? (time.day ? String(time.day) : '')}
                  onChange={(e) => onDate('day', e.target.value)}
                  onBlur={() => setDayDraft(null)}
                />
              </div>
            </div>
            <p className="example-note">Leave month and day blank to work by year.</p>
            <div className="row tight" role="group" aria-label="Step the year">
              <button
                type="button"
                className="btn small"
                onClick={() => step(-10)}
                aria-label="Back 10 years"
              >
                -10
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => step(-1)}
                aria-label="Back 1 year"
              >
                -1
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => step(1)}
                aria-label="Forward 1 year"
              >
                +1
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => step(10)}
                aria-label="Forward 10 years"
              >
                +10
              </button>
            </div>
          </div>
          <div className="stack">
            <span className="eyebrow">Anchor by a character&rsquo;s age</span>
            <div className="field">
              <label htmlFor={ids.char}>Character</label>
              <select
                id={ids.char}
                value={anchorChar}
                onChange={(e) => setAnchorChar(e.target.value)}
              >
                <option value="">Pick a character</option>
                {characters.map((c) => (
                  <option key={c._id} value={c._id}>
                    {String((c.names as { full?: string } | undefined)?.full ?? c.title)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.age}>is this old</label>
              <input
                id={ids.age}
                type="number"
                min={0}
                className="num"
                value={anchorAge}
                onChange={(e) => setAnchorAge(e.target.value)}
              />
            </div>
            <button type="button" className="btn" onClick={() => void anchorByAge()}>
              Set year from age
            </button>
          </div>
          <div className="stack">
            <span className="eyebrow">Anchor by a chapter strand</span>
            <div className="field">
              <label htmlFor={ids.strand}>Strand</label>
              <select
                id={ids.strand}
                value={anchorStrand}
                onChange={(e) => setAnchorStrand(e.target.value)}
              >
                <option value="">Pick a strand</option>
                {strands.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn" onClick={anchorByStrand}>
              Use this strand&rsquo;s year
            </button>
            <p className="example-note">
              Setting the time never changes an entry. To change a strand&rsquo;s year, use the
              strand year action below and approve the change.
            </p>
          </div>
        </div>
        {note && (
          <p
            className={note.bad ? 'callout warn' : 'callout time'}
            role="status"
            data-testid="time-note"
          >
            {note.text}
          </p>
        )}
        <div className="panel stack tight" data-testid="time-chapter">
          <span className="eyebrow">Chapter you are writing</span>
          {current ? (
            <>
              <p>{current.label}</p>
              <div className="row tight">
                <button type="button" className="btn small" onClick={() => void askPromote()}>
                  Use {time.year} as strand year
                </button>
                <button type="button" className="btn small" onClick={clearChapter}>
                  Clear the chapter
                </button>
              </div>
            </>
          ) : (
            <p>None set. Anchor by a strand to record the chapter and strand you are writing.</p>
          )}
          {preview && (
            <div
              className="panel stack confirm-change"
              role="group"
              aria-label="Approve the strand change"
              data-testid="promote-preview"
            >
              <strong>Change this strand?</strong>
              {preview.unchanged ? (
                <p>
                  {preview.chapterTitle}, {preview.strandLabel} strand, already has the year{' '}
                  {preview.year}. Nothing would change.
                </p>
              ) : (
                <table className="compact diff-table">
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Now</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">
                        {preview.chapterTitle}, {preview.strandLabel} strand year
                      </th>
                      <td>
                        <del>{rangeText(preview.from)}</del>
                      </td>
                      <td>
                        <ins>{rangeText(preview.to)}</ins>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
              <div className="row tight">
                {!preview.unchanged && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => void promote()}
                  >
                    Approve and write
                  </button>
                )}
                <button type="button" className="btn small" onClick={() => setPreview(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="two-col">
          <section className="panel stack tight" aria-label={`Everyone in ${time.year}`}>
            <h3>Everyone in {formatMoment(time)}</h3>
            <div className="table-wrap">
              <table className="compact state-table" data-testid="time-states">
                <thead>
                  <tr>
                    <th scope="col">Character</th>
                    <th scope="col">Family</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {(view?.rows ?? []).map((r) => (
                    <tr key={r.id} data-person={r.id}>
                      <td>
                        <Zh text={r.name} /> {r.chinese && <Zh text={r.chinese} />}
                      </td>
                      <td>
                        <FamilyChips ids={r.familyIds} families={families} />
                      </td>
                      <td>
                        <StateText state={r.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="stack">
            <section className="panel stack tight" data-testid="time-era">
              <span className="eyebrow">Era</span>
              {view?.era ? (
                <>
                  <h3>
                    {view.era.name}{' '}
                    <span className="num">({span(view.era.startYear, view.era.endYear)})</span>
                  </h3>
                  {view.eras.length > 1 && (
                    <p className="callout warn">
                      {view.eras.length} eras cover {view.year}. The one that started last applies.
                    </p>
                  )}
                  <dl className="kv">
                    {(
                      [
                        ['Technology', view.era.technology],
                        ['Climate', view.era.climate],
                        ['Economy', view.era.economy],
                        ['Politics', view.era.politics],
                        ['Daily life', view.era.dailyLife],
                      ] as const
                    )
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <Fragment key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </Fragment>
                      ))}
                  </dl>
                </>
              ) : (
                <p>No era covers {time.year}.</p>
              )}
            </section>
            <section className="panel stack tight" data-testid="time-events">
              <span className="eyebrow">World events in {time.year}</span>
              {view && view.events.length > 0 ? (
                <ul className="plain-list">
                  {view.events.map((e) => (
                    <li key={e.id}>
                      <span className="num">{span(e.startYear, e.endYear)}</span> {e.title}
                      {e.formative && <span className="chip canon">formative</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No world event falls in {time.year}.</p>
              )}
            </section>
            <section className="panel stack tight" data-testid="time-strands">
              <span className="eyebrow">Chapter strands in {time.year}</span>
              {view && view.strands.length > 0 ? (
                <ul className="plain-list">
                  {view.strands.map((s) => (
                    <li key={`${s.chapterId}|${s.strandId}`}>
                      Chapter {s.readingOrder ?? '?'}: {s.chapterTitle}, {s.label}
                      {s.primary ? ' (primary)' : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No chapter strand falls in {time.year}.</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
