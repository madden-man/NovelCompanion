import { useId, useMemo } from 'react';
import { zhPieces } from '../../../shared/domain/zh';
import type { ZhTerm } from '../../../shared/domain/zh';
import { useEntries } from './data';

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

function ZhRun({ text, term }: { text: string; term: ZhTerm | null }) {
  const tipId = useId();
  const tip = term
    ? `${term.romanization || 'No romanization yet'}: ${term.meaning || 'no meaning yet'}`
    : 'Not in the glossary yet.';
  return (
    <span className="zh-run" tabIndex={0} aria-describedby={tipId} data-testid="zh">
      <span className="zh-chars" lang="zh">
        {text}
      </span>
      <span className="zh-tip" role="tooltip" id={tipId}>
        {tip}
      </span>
    </span>
  );
}

/**
 * Text with its Chinese characters shown as characters; hovering or focusing
 * a run shows the romanization and meaning from the glossary (GL-3, M2 stub).
 */
export function Zh({ text }: { text: string }) {
  const terms = useGlossary();
  const pieces = useMemo(() => zhPieces(text, terms), [text, terms]);
  return (
    <>
      {pieces.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <ZhRun key={i} text={p.text} term={p.term} />
        ),
      )}
    </>
  );
}
