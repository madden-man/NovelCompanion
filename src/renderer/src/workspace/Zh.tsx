import { createContext, useContext, useId, useMemo, useState } from 'react';
import { useWriteGuard } from '../connection';
import type { KeyboardEvent } from 'react';
import { createCommand } from '../../../shared/domain/undoRunner';
import { zhPieces } from '../../../shared/domain/zh';
import type { ZhTerm } from '../../../shared/domain/zh';
import type { EntryCollection } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries, useList } from './data';
import { useUndo } from './undo';

/** Opens an entry in its section; the workspace provides it so a name can link to its term (GL-3). */
const NavContext = createContext<((collection: EntryCollection, id: string) => void) | null>(null);
export const ZhNavProvider = NavContext.Provider;

/** Glossary terms as the matcher wants them. */
export function useGlossary(): ZhTerm[] {
  const entries = useEntries('glossaryTerms');
  return useMemo(
    () =>
      entries.map((e) => ({
        id: e._id,
        characters: typeof e.characters === 'string' ? e.characters : '',
        romanization: typeof e.romanization === 'string' ? e.romanization : '',
        meaning: typeof e.meaning === 'string' ? e.meaning : '',
      })),
    [entries],
  );
}

function ZhRun(props: { text: string; term: ZhTerm | null; actions: boolean }) {
  const { text, term, actions } = props;
  const tipId = useId();
  const nav = useContext(NavContext);
  const undo = useUndo();
  const languages = useList('languages');
  const [message, setMessage] = useState<string | null>(null);
  const linked = actions && term !== null && nav !== null;

  const open = () => {
    if (linked) nav('glossaryTerms', term.id);
  };

  const ro = useWriteGuard();
  const add = async () => {
    setMessage(null);
    try {
      const language =
        languages?.items.find((i) => i.id === 'mandarin')?.id ??
        languages?.items[0]?.id ??
        'mandarin';
      const { entry } = await call('entry.create', {
        collection: 'glossaryTerms',
        data: { title: text, characters: text, language },
      });
      undo.record(createCommand('glossaryTerms', entry._id, text));
      nav?.('glossaryTerms', entry._id);
    } catch (e) {
      setMessage(plainError(e));
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (linked && e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  };

  return (
    <span
      className="zh-run"
      tabIndex={0}
      role={linked ? 'link' : undefined}
      aria-describedby={tipId}
      data-testid="zh"
      data-term={term?.id}
      onClick={
        linked
          ? (e) => {
              e.stopPropagation();
              open();
            }
          : undefined
      }
      onKeyDown={onKey}
    >
      <span className={`zh-chars${linked ? ' zh-linked' : ''}`} lang="zh">
        {text}
      </span>
      <span className="zh-tip" role="tooltip" id={tipId}>
        {term ? (
          <span>{`${term.romanization || 'No romanization yet'}: ${term.meaning || 'no meaning yet'}`}</span>
        ) : (
          <>
            <span>Not in the glossary yet.</span>
            {actions && nav && (
              <button
                type="button"
                className="btn small"
                disabled={ro.off}
                {...ro.tip}
                onClick={(e) => {
                  e.stopPropagation();
                  void add();
                }}
              >
                Add to glossary
              </button>
            )}
            {message && <span role="alert">{message}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/**
 * Text with its Chinese characters shown as characters. Hovering or focusing
 * a run shows the romanization and meaning from the glossary term (the exact
 * term first, then the longest term the run starts with). A run with a term
 * links to it; a run without one offers "Add to glossary" (GL-3). Where the
 * text sits inside a button, pass `actions={false}` to keep only the hover card.
 */
export function Zh({ text, actions = true }: { text: string; actions?: boolean }) {
  const terms = useGlossary();
  const pieces = useMemo(() => zhPieces(text, terms), [text, terms]);
  return (
    <>
      {pieces.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <ZhRun key={i} text={p.text} term={p.term} actions={actions} />
        ),
      )}
    </>
  );
}

const CJK_TEST = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/u;

/** True when the text holds any Chinese character. */
export function hasCjk(text: string): boolean {
  return CJK_TEST.test(text);
}

/**
 * GL-3: a small "Meaning" control beside a short field with Chinese characters.
 * Hovering or focusing it shows the romanization and meaning of each run from
 * the glossary, and says when a run has no term yet.
 */
export function ZhMeaning({ text }: { text: string }) {
  const terms = useGlossary();
  const tipId = useId();
  const runs = useMemo(
    () =>
      zhPieces(text, terms).flatMap((p) =>
        p.kind === 'zh' ? [{ chars: p.text, term: p.term }] : [],
      ),
    [text, terms],
  );
  if (runs.length === 0) return null;
  return (
    <span className="zh-run zh-meaning">
      <button type="button" className="btn small" aria-describedby={tipId} data-testid="zh-meaning">
        Meaning
      </button>
      <span className="zh-tip" role="tooltip" id={tipId}>
        {runs.map((r, i) => (
          <span key={i}>
            <span lang="zh">{r.chars}</span>
            {': '}
            {r.term
              ? `${r.term.romanization || 'No romanization yet'}, ${r.term.meaning || 'no meaning yet'}`
              : 'not in the glossary yet'}
          </span>
        ))}
      </span>
    </span>
  );
}
