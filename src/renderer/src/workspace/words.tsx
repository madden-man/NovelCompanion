import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { KINDS, kindInfo, posText } from '../../../shared/domain/words';
import type { WordKind, WordResult } from '../../../shared/domain/words';
import { call, plainError } from '../api';
import './words.css';

type Shown = { kind: WordKind; word: string; results: WordResult[] };

/**
 * WT-1: writing tools. Type a word, pick a lookup, and read the results from
 * Datamuse; any result word runs the same lookup again, so one word leads to
 * the next. The request goes through main (the renderer has no network).
 */
export function WritingToolsView() {
  const ids = { word: useId(), kind: useId(), hint: useId() };
  const [word, setWord] = useState('');
  const [kind, setKind] = useState<WordKind>('synonyms');
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);

  const lookup = async (w: string, k: WordKind) => {
    const text = w.trim();
    if (!text) {
      setError('Type a word first.');
      input.current?.focus();
      return;
    }
    const n = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await call('words.lookup', { kind: k, word: text });
      if (n !== seq.current) return;
      setShown({ kind: r.kind, word: r.word, results: r.results });
    } catch (e) {
      if (n !== seq.current) return;
      setError(plainError(e));
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void lookup(word, kind);
  };

  /** A result word becomes the next lookup of the same kind. */
  const follow = (next: string) => {
    setWord(next);
    void lookup(next, kind);
  };

  const info = kindInfo(kind);
  const shownInfo = shown ? kindInfo(shown.kind) : null;

  return (
    <section className="stack writing-tools" aria-label="Writing tools" data-testid="writing-tools">
      <p className="lede">
        Synonyms, rhymes and related words from Datamuse, a free service. It needs an internet
        connection.
      </p>
      <form className="words-form" onSubmit={submit} aria-label="Look up a word">
        <div className="field words-word">
          <label htmlFor={ids.word}>Word</label>
          <input
            id={ids.word}
            ref={input}
            value={word}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={ids.hint}
            onChange={(e) => setWord(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.kind}>Look up</label>
          <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as WordKind)}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn primary" disabled={busy}>
          Look up
        </button>
      </form>
      <p className="words-hint" id={ids.hint}>
        {info.hint}
      </p>
      {error && (
        <p className="callout crit" role="alert" data-testid="words-error">
          {error}
        </p>
      )}
      <div aria-live="polite" aria-busy={busy ? 'true' : 'false'} className="stack tight">
        {busy && (
          <p className="example-note" data-testid="words-busy">
            Looking up {word.trim()}.
          </p>
        )}
        {!busy && shown && shownInfo && (
          <>
            <h3 className="words-title">
              {shownInfo.label} for <span className="words-term">{shown.word}</span>
            </h3>
            {shown.results.length === 0 ? (
              <p className="example-note" data-testid="words-empty">
                Datamuse has nothing for {shown.word} under {shownInfo.label.toLowerCase()}. Try
                another lookup or a simpler form of the word.
              </p>
            ) : shown.kind === 'definition' ? (
              <Definitions results={shown.results} />
            ) : (
              <Results shown={shown} syllables={shownInfo.syllables} onFollow={follow} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Results(props: { shown: Shown; syllables: boolean; onFollow: (word: string) => void }) {
  const { shown } = props;
  return (
    <ul className="words-results" data-testid="words-results">
      {shown.results.map((r) => (
        <li key={r.word} className="words-result" data-word={r.word}>
          <button
            type="button"
            className="words-chip"
            title={`Look up ${r.word}`}
            onClick={() => props.onFollow(r.word)}
          >
            {r.word}
          </button>
          {(props.syllables && r.syllables !== null) || r.partsOfSpeech.length > 0 ? (
            <span className="words-meta">
              {props.syllables && r.syllables !== null && (
                <span data-testid="words-syllables">
                  {r.syllables} {r.syllables === 1 ? 'syllable' : 'syllables'}
                </span>
              )}
              {r.partsOfSpeech.length > 0 && (
                <span data-testid="words-pos">{r.partsOfSpeech.map(posText).join(', ')}</span>
              )}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Definitions(props: { results: WordResult[] }) {
  const entries = props.results.filter((r) => (r.definitions?.length ?? 0) > 0);
  if (entries.length === 0) {
    return (
      <p className="example-note" data-testid="words-empty">
        Datamuse has no definition for this word. Check the spelling, or try a simpler form of the
        word.
      </p>
    );
  }
  return (
    <div className="stack tight" data-testid="words-results">
      {entries.map((r) => (
        <div key={r.word} className="words-entry" data-word={r.word}>
          <p className="words-headword">
            <strong>{r.word}</strong>
            {r.syllables !== null && (
              <span className="words-meta">
                {r.syllables} {r.syllables === 1 ? 'syllable' : 'syllables'}
              </span>
            )}
          </p>
          <ol className="words-defs">
            {(r.definitions ?? []).map((d, i) => (
              <li key={i}>
                {d.pos && <span className="words-pos">{posText(d.pos)}</span>} {d.text}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** A42, SM-6: Writing tools as its own screen in the rail. Lookups change nothing in the bible. */
export function WritingToolsScreen() {
  return (
    <div className="ws-wide-area" data-testid="writing-tools-screen">
      <div className="ws-wide stack">
        <h2>Writing tools</h2>
        <WritingToolsView />
      </div>
    </div>
  );
}
