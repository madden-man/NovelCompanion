import { useEffect, useId, useMemo, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { createCommand } from '../../../../shared/domain/undoRunner';
import { characterName } from '../../../../shared/domain/timeline';
import { entryTitle } from '../../../../shared/schema';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { useStoryTime } from '../storyTime';
import { useStrandOptions } from '../timeline/StoryTimeDialog';
import { useUndo } from '../undo';
import { SelectionBody } from './common';
import type { OpenEntry } from './common';
import { useSelection } from './relevant';
import type { BriefInput } from './relevant';

type Kind = BriefInput['kind'];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'chapter', label: 'A chapter' },
  { kind: 'strand', label: 'A chapter strand' },
  { kind: 'part', label: 'A part' },
  { kind: 'pov', label: 'A story year and point of view' },
];

/**
 * DB-2, DB-3: start a session for a section of plot. The section defaults to
 * the chapter picked in Writing. The person sees the deterministic selection
 * first; starting writes the brief (Claude when available, else the
 * structured brief, SB-7), logs the session, and sets the story time.
 */
export function StartSessionView(props: {
  onOpen: OpenEntry;
  onStarted: (briefId: string) => void;
}) {
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const undo = useUndo();
  const chapters = useEntries('chapters');
  const parts = useEntries('parts');
  const characters = useEntries('characters');
  const strands = useStrandOptions();
  const [kind, setKind] = useState<Kind>(time.chapterId ? 'chapter' : 'pov');
  const [chapterId, setChapterId] = useState(time.chapterId ?? '');
  const [strandKey, setStrandKey] = useState(
    time.chapterId && time.strandId ? `${time.chapterId}|${time.strandId}` : '',
  );
  const [partId, setPartId] = useState('');
  const [year, setYear] = useState(String(time.year));
  const [pov, setPov] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Response<'brief.settings.get'> | null>(null);
  const ids = { chapter: useId(), strand: useId(), part: useId(), year: useId(), pov: useId() };

  useEffect(() => {
    void call('brief.settings.get', {}).then(setSettings);
  }, []);

  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => Number(a.readingOrder ?? 0) - Number(b.readingOrder ?? 0)),
    [chapters],
  );
  const firstChapter = sortedChapters[0]?._id ?? '';
  const firstPart = parts[0]?._id ?? '';

  const input: BriefInput | null = useMemo(() => {
    if (kind === 'chapter') {
      const id = chapterId || firstChapter;
      return id ? { kind, chapterId: id } : null;
    }
    if (kind === 'strand') {
      const key = strandKey || strands[0]?.key || '';
      const [c, s] = key.split('|');
      return c && s ? { kind, chapterId: c, strandId: s } : null;
    }
    if (kind === 'part') {
      const id = partId || firstPart;
      return id ? { kind, partId: id } : null;
    }
    const y = /^-?\d{1,5}$/.test(year.trim()) ? Number(year) : null;
    return y !== null && pov ? { kind, year: y, povCharacterId: pov } : null;
  }, [kind, chapterId, firstChapter, strandKey, strands, partId, firstPart, year, pov]);

  const { result, error: selError } = useSelection(input);

  const start = async () => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      await story.flush();
      const r = await call('session.start', { input, add: [], remove: [] });
      undo.record(createCommand('briefs', r.brief._id, entryTitle(r.brief)));
      undo.record(createCommand('sessionLogs', r.log._id, entryTitle(r.log)));
      props.onStarted(r.brief._id);
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  };

  return (
    <div className="ws-wide stack" data-testid="start-session">
      <h2>Start session</h2>
      <div className="panel stack">
        <div className="row" role="group" aria-label="Section of plot">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="btn small"
              aria-pressed={kind === k.kind}
              onClick={() => setKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
        {kind === 'chapter' && (
          <div className="field">
            <label htmlFor={ids.chapter}>Chapter</label>
            <select
              id={ids.chapter}
              value={chapterId || firstChapter}
              onChange={(e) => setChapterId(e.target.value)}
              data-testid="start-chapter"
            >
              {sortedChapters.map((c) => (
                <option key={c._id} value={c._id}>
                  {`Chapter ${String(c.readingOrder)}: ${entryTitle(c)}`}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === 'strand' && (
          <div className="field">
            <label htmlFor={ids.strand}>Strand</label>
            <select
              id={ids.strand}
              value={strandKey || strands[0]?.key || ''}
              onChange={(e) => setStrandKey(e.target.value)}
            >
              {strands.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === 'part' && (
          <div className="field">
            <label htmlFor={ids.part}>Part</label>
            <select
              id={ids.part}
              value={partId || firstPart}
              onChange={(e) => setPartId(e.target.value)}
            >
              {parts.map((p) => (
                <option key={p._id} value={p._id}>
                  {entryTitle(p)}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === 'pov' && (
          <div className="row">
            <div className="field">
              <label htmlFor={ids.year}>Story year</label>
              <input
                id={ids.year}
                className="num"
                value={year}
                inputMode="numeric"
                onChange={(e) => setYear(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.pov}>Point of view</label>
              <select id={ids.pov} value={pov} onChange={(e) => setPov(e.target.value)}>
                <option value="">Pick a character</option>
                {[...characters]
                  .sort((a, b) => characterName(a).localeCompare(characterName(b)))
                  .map((c) => (
                    <option key={c._id} value={c._id}>
                      {characterName(c)}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        )}
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={!input || busy}
            onClick={() => void start()}
            data-testid="start-session-go"
          >
            {settings?.claudeAvailable ? `Start session with ${settings.model}` : 'Start session'}
          </button>
          {settings && !settings.claudeAvailable && (
            <span className="example-note" data-testid="claude-unavailable">
              Claude is not available, so the brief will be the selected entries with no synthesis.
            </span>
          )}
          {busy && <span role="status">Writing the brief.</span>}
        </div>
        {(error ?? selError) && (
          <p className="callout crit" role="alert">
            {error ?? selError}
          </p>
        )}
      </div>
      {result && (
        <>
          <div className="row">
            <h3>What the bible selects: {result.selection.label}</h3>
            <span className="chip time">{result.selection.year}</span>
            <span>{result.selection.ids.length} entries</span>
          </div>
          <SelectionBody selection={result.selection} onOpen={props.onOpen} />
        </>
      )}
    </div>
  );
}
