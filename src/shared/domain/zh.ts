/**
 * Runs of Chinese characters in a text, each matched to a glossary term
 * (GL-3, stubbed for M2 and completed in M4): the exact term first, then the
 * longest term the run starts with. Pure, so the matching is unit tested.
 */
export interface ZhTerm {
  id: string;
  characters: string;
  romanization: string;
  meaning: string;
}

export type ZhPiece =
  { kind: 'text'; text: string } | { kind: 'zh'; text: string; term: ZhTerm | null };

const CJK = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]+/gu;

function match(run: string, terms: readonly ZhTerm[]): { term: ZhTerm | null; length: number } {
  const exact = terms.find((t) => t.characters === run);
  if (exact) return { term: exact, length: run.length };
  let best: ZhTerm | null = null;
  for (const t of terms) {
    if (t.characters && run.startsWith(t.characters)) {
      if (!best || t.characters.length > best.characters.length) best = t;
    }
  }
  return best ? { term: best, length: best.characters.length } : { term: null, length: run.length };
}

export function zhPieces(text: string, terms: readonly ZhTerm[]): ZhPiece[] {
  const out: ZhPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(CJK)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    let run = m[0];
    while (run) {
      const { term, length } = match(run, terms);
      if (term) {
        out.push({ kind: 'zh', text: run.slice(0, length), term });
        run = run.slice(length);
        continue;
      }
      // No term starts here: the characters up to the next term form one run to add to the glossary.
      let next = 1;
      while (next < run.length && !match(run.slice(next), terms).term) next++;
      out.push({ kind: 'zh', text: run.slice(0, next), term: null });
      run = run.slice(next);
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * One line of glossary detail for a name, for places that cannot show a hover
 * card, such as tree nodes (GL-3): "晓曦 xiǎoxī: dawn light". Empty when no
 * character in the text has a glossary term.
 */
export function zhHint(text: string, terms: readonly ZhTerm[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of zhPieces(text, terms)) {
    if (p.kind !== 'zh' || !p.term || seen.has(p.term.id)) continue;
    seen.add(p.term.id);
    const detail = [p.term.romanization, p.term.meaning].filter(Boolean).join(': ');
    parts.push(detail ? `${p.term.characters} ${detail}` : p.term.characters);
  }
  return parts.join('; ');
}
