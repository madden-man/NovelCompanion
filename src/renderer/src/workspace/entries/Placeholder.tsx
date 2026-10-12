import { collectionInfo } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';

/** The screens the Entries screen holds as tabs (KB-5). */
export type EntryTool = 'culture' | 'places' | 'romanization' | 'glossary';

const KINDS: readonly EntryCollection[] = [
  'facts',
  'culturalEntries',
  'places',
  'glossaryTerms',
  'themes',
  'openQuestions',
  'customEntries',
];

const TOOLS: readonly { kind: EntryTool; label: string }[] = [
  { kind: 'culture', label: 'Culture by year' },
  { kind: 'places', label: 'Place tree' },
  { kind: 'romanization', label: 'Romanization' },
  { kind: 'glossary', label: 'Glossary table' },
];

/**
 * KB-1: what the Entries rail item opens until the KB-5 Entries screen
 * (entries/EntriesView.tsx) replaces it at integration. It reaches every
 * entry list and tool that left the rail, so nothing is lost meanwhile.
 */
export function EntriesView(props: {
  onSection: (collection: EntryCollection) => void;
  onTool: (tool: EntryTool) => void;
}) {
  return (
    <section className="ws-wide stack" aria-labelledby="entries-title" data-testid="entries-view">
      <h2 id="entries-title">Entries</h2>
      <div className="stack tight">
        <span className="eyebrow">Lists</span>
        <div className="row tight">
          {KINDS.map((c) => (
            <button key={c} type="button" className="btn" onClick={() => props.onSection(c)}>
              {collectionInfo[c].plural}
            </button>
          ))}
        </div>
      </div>
      <div className="stack tight">
        <span className="eyebrow">Views</span>
        <div className="row tight">
          {TOOLS.map((t) => (
            <button key={t.kind} type="button" className="btn" onClick={() => props.onTool(t.kind)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
