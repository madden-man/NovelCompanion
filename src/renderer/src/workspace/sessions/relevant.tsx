import { WriteFieldset } from '../../connection';
import { useEffect, useId, useMemo, useState } from 'react';
import type { Request, Response } from '../../../../shared/ipc';
import { characterName } from '../../../../shared/domain/timeline';
import { call, plainError } from '../../api';
import { useEntries, useStore } from '../data';
import { useStoryTime } from '../storyTime';
import { SelectionBody } from './common';
import { PovExtras } from './povPickers';
import type { OpenEntry, SelectionView } from './common';

export type BriefInput = Request<'session.relevant'>['input'];

/**
 * The section a session is about, from the story time: the chapter picked in
 * Writing, else the story year and a point of view picked here (SB-1, TM-3).
 */
export function useSessionInput(
  pov: string | null,
  extras: { placeIds?: string[]; characterIds?: string[] } = {},
): BriefInput | null {
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const places = extras.placeIds;
  const chars = extras.characterIds;
  return useMemo(() => {
    // A picked strand is that strand, not the whole chapter (SB-1).
    if (time.chapterId && time.strandId) {
      return { kind: 'strand', chapterId: time.chapterId, strandId: time.strandId };
    }
    if (time.chapterId) return { kind: 'chapter', chapterId: time.chapterId };
    if (pov) {
      return {
        kind: 'pov',
        year: time.year,
        povCharacterId: pov,
        ...(places?.length ? { placeIds: places } : {}),
        ...(chars?.length ? { characterIds: chars } : {}),
      };
    }
    return null;
  }, [time.chapterId, time.strandId, time.year, pov, places, chars]);
}

/** The SB-2 selection for an input, kept live as the bible and the settings change. */
export function useSelection(
  input: BriefInput | null,
  overrides: { add?: string[]; remove?: string[] } = {},
  bump = 0,
) {
  const { version } = useStore();
  const [result, setResult] = useState<Response<'session.relevant'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([input, overrides.add ?? [], overrides.remove ?? []]);
  useEffect(() => {
    if (!input) return;
    let live = true;
    call('session.relevant', {
      input,
      add: overrides.add ?? [],
      remove: overrides.remove ?? [],
    })
      .then((r) => {
        if (!live) return;
        setResult(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
    // The key holds the input and overrides; version and bump reload on any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, bump]);
  // With no input there is nothing to show, whatever was loaded before.
  return { result: input ? result : null, error };
}

/**
 * SB-2 step 3 window and SB-6 size budget, stored in the bible (ST-1). Shown
 * folded in Relevant to Session and as a panel in Settings.
 */
export function BriefSettings({
  onChanged,
  variant = 'details',
}: {
  onChanged?: () => void;
  variant?: 'details' | 'panel';
}) {
  const [s, setS] = useState<Response<'brief.settings.get'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { window: useId(), budget: useId() };
  useEffect(() => {
    void call('brief.settings.get', {}).then(setS);
  }, []);
  if (!s) return null;
  const save = async (patch: { window?: number; budget?: number }) => {
    try {
      setS(await call('brief.settings.set', patch));
      setError(null);
      onChanged?.();
    } catch (e) {
      setError(plainError(e));
    }
  };
  const fields = (
    <WriteFieldset className="stack tight">
      <div className="row">
        <div className="field">
          <label htmlFor={ids.window}>World events window (years)</label>
          <input
            id={ids.window}
            type="number"
            min={0}
            max={200}
            defaultValue={s.window}
            onBlur={(e) => void save({ window: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.budget}>Size budget (characters)</label>
          <input
            id={ids.budget}
            type="number"
            min={0}
            defaultValue={s.budget}
            onBlur={(e) => void save({ budget: Number(e.target.value) })}
          />
        </div>
        <span>Briefs are written with {s.model}.</span>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </WriteFieldset>
  );
  if (variant === 'panel') {
    return (
      <div className="panel stack tight" data-testid="settings-briefs">
        <h4>Session briefs</h4>
        {fields}
      </div>
    );
  }
  return (
    <details className="sunken" data-testid="brief-settings">
      <summary>Brief settings</summary>
      {fields}
    </details>
  );
}

/**
 * Relevant to Session: the most important entries for the chapter being
 * written (characters and ages, the era, world events, cultural expectations,
 * places, who knows what, earlier chapters, beats, linked glossary, themes,
 * and open questions, the last session note). It is the same selection the
 * brief is written from (SB-2, SB-3), shown live.
 */
export function RelevantView({ onOpen }: { onOpen: OpenEntry }) {
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const characters = useEntries('characters');
  const [pov, setPov] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [placeIds, setPlaceIds] = useState<string[]>([]);
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const input = useSessionInput(pov, { placeIds, characterIds });
  const { result, error } = useSelection(input, {}, bump);
  const povId = useId();
  const sel: SelectionView | null = result?.selection ?? null;

  return (
    <div className="ws-wide stack" data-testid="relevant-view">
      <div className="row">
        <h2>Relevant to Session</h2>
        {sel && <span className="chip time">{sel.year}</span>}
      </div>
      {time.chapterId ? (
        <p className="lede" data-testid="relevant-label">
          {sel ? sel.label : 'Loading the selection.'}
        </p>
      ) : (
        <div className="field narrow">
          <label htmlFor={povId}>Point of view in {time.year}</label>
          <select id={povId} value={pov ?? ''} onChange={(e) => setPov(e.target.value || null)}>
            <option value="">Pick a point of view</option>
            {[...characters]
              .sort((a, b) => characterName(a).localeCompare(characterName(b)))
              .map((c) => (
                <option key={c._id} value={c._id}>
                  {characterName(c)}
                </option>
              ))}
          </select>
          <p className="example-note">
            Pick a chapter in Writing above, or a point of view here, to see what matters for the
            session.
          </p>
          {pov && (
            <PovExtras
              pov={pov}
              placeIds={placeIds}
              characterIds={characterIds}
              onPlaces={setPlaceIds}
              onCharacters={setCharacterIds}
            />
          )}
        </div>
      )}
      <BriefSettings onChanged={() => setBump((n) => n + 1)} />
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {sel && (
        <>
          <p className="example-note">
            {sel.ids.length} entries, selected the same way the brief selects them.
          </p>
          <SelectionBody
            selection={sel}
            onOpen={onOpen}
            writing={time.chapterId ? { chapterId: time.chapterId, strandId: time.strandId } : null}
          />
        </>
      )}
    </div>
  );
}
