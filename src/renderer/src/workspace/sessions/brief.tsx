import { useWriteGuard } from '../../connection';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  citationProblems,
  markdownToHtml,
  missingLeadSections,
  uncitedLines,
} from '../../../../shared/domain/brief/render';
import { editCommand } from '../../../../shared/domain/undoRunner';
import { entryTitle } from '../../../../shared/schema';
import { call, plainError } from '../../api';
import type { Entry } from '../data';
import { SaveState, useAutosave } from '../editor';
import { EntryPicker } from '../pickers';
import { useUndo } from '../undo';
import { useClaudeRun } from './claudeRun';
import { SelectionBody } from './common';
import type { OpenEntry, SelectionView } from './common';

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * A saved brief (SB-8): its text, editable and saved as you type (ED-2,
 * ED-6), with every citation checked against its manifest (SB-4); the
 * selection it came from, where entries can be removed or added before
 * regenerating (SB-9); and export to Markdown and PDF.
 */
export function BriefView({
  id,
  onOpen,
  note: startNote = null,
}: {
  id: string;
  onOpen: OpenEntry;
  /** Why a just-started brief is the structured one (SB-7), from Start session. */
  note?: string | null;
}) {
  const ed = useAutosave('briefs', id);
  const undo = useUndo();
  const [editing, setEditing] = useState(false);
  const ro = useWriteGuard();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(
    startNote ? { text: startNote, bad: false } : null,
  );
  const claude = useClaudeRun('the brief');
  const [claudeAvailable, setClaudeAvailable] = useState(false);
  useEffect(() => {
    void call('brief.settings.get', {}).then((s) => setClaudeAvailable(s.claudeAvailable));
  }, []);
  const textId = useId();
  const brief = ed.draft;
  const content = typeof brief?.content === 'string' ? brief.content : '';
  const manifest = useMemo(() => ids(brief?.entryIds), [brief?.entryIds]);
  const problems = useMemo(() => citationProblems(content, manifest), [content, manifest]);
  const missing = useMemo(() => missingLeadSections(content), [content]);
  // SB-4: a Claude-written brief must cite something on every line; the structured one does by construction.
  const synthesized = brief?.synthesized === true;
  const uncited = useMemo(() => (synthesized ? uncitedLines(content) : []), [synthesized, content]);
  const html = useMemo(
    () => markdownToHtml(content, manifest, { flagUncited: synthesized }),
    [content, manifest, synthesized],
  );

  if (ed.status === 'missing') return <p className="callout warn">This brief no longer exists.</p>;
  if (!brief) return <p aria-live="polite">Loading the brief.</p>;
  const selection = brief.selection as SelectionView | null;

  const regenerate = () => {
    setNote(null);
    claude.begin(claudeAvailable, (runId) => write(runId));
  };

  const write = async (runId: string | undefined) => {
    setBusy(true);
    try {
      await ed.flush();
      const before = (await call('entry.get', { collection: 'briefs', id })).entry as Entry;
      const r = await call('brief.regenerate', {
        id,
        add: [...ids(brief.added).filter((x) => !remove.includes(x)), ...add],
        remove: [...ids(brief.removed).filter((x) => !add.includes(x)), ...remove],
        runId,
      });
      undo.record(
        editCommand(`Regenerated ${entryTitle(r.brief)}`, 'briefs', id, before, r.brief as Entry),
      );
      setAdd([]);
      setRemove([]);
      setNote(r.note ? { text: r.note, bad: false } : { text: 'Brief written again.', bad: false });
      ed.reload();
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (format: 'markdown' | 'pdf') => {
    setNote(null);
    try {
      await ed.flush();
      const r = await call('brief.export', { id, format });
      if (r.saved) setNote({ text: `Saved to ${r.path}`, bad: false });
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
  };

  return (
    <div className="ws-wide stack" data-testid="brief-view">
      <div className="row">
        <h2>{entryTitle(brief)}</h2>
        {typeof brief.storyYear === 'number' && (
          <span className="chip time">{brief.storyYear}</span>
        )}
        <span className="chip" data-testid="brief-model">
          {brief.synthesized
            ? `Written by ${String(brief.model)}`
            : 'Structured brief, no synthesis'}
        </span>
        {typeof brief.chapterId === 'string' && brief.chapterId && (
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpen('chapters', brief.chapterId as string)}
          >
            Open the chapter
          </button>
        )}
        <SaveState status={ed.status} error={ed.error} />
      </div>
      {problems.length > 0 && (
        <p className="callout crit" role="alert" data-testid="brief-problems">
          These citations are not in the selection: {problems.join(', ')}. Check those lines.
        </p>
      )}
      {uncited.length > 0 && (
        <p className="callout crit" role="alert" data-testid="brief-uncited">
          {uncited.length === 1 ? 'One line cites' : `${uncited.length} lines cite`} no entry, so it
          cannot be checked against the selection: {uncited.join(' / ')}
        </p>
      )}
      {missing.length > 0 && (
        <p className="callout warn" data-testid="brief-missing-lead">
          The brief should open with: {missing.join('; ')}.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn small"
          onClick={() => setEditing((v) => !v)}
          disabled={ro.off && !editing}
          {...ro.tip}
        >
          {editing ? 'Show the brief' : 'Edit the text'}
        </button>
        <button type="button" className="btn small" onClick={() => void exportAs('markdown')}>
          Export Markdown
        </button>
        <button type="button" className="btn small" onClick={() => void exportAs('pdf')}>
          Export PDF
        </button>
      </div>
      {note && (
        <p className={note.bad ? 'callout crit' : 'callout'} role="status" data-testid="brief-note">
          {note.text}
        </p>
      )}
      {editing ? (
        <div className="field">
          <label htmlFor={textId}>Brief text</label>
          <textarea
            id={textId}
            rows={24}
            value={content}
            onChange={(e) => ed.setField('content', e.target.value)}
            data-testid="brief-text"
          />
        </div>
      ) : (
        <article
          className="panel brief-body"
          data-testid="brief-body"
          // Escaped by markdownToHtml before any markup is added.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <section className="panel stack" aria-label="Selection" data-testid="brief-selection">
        <h3>Selection</h3>
        <p className="example-note">
          Remove an entry or add one, then write the brief again. {manifest.length} entries in the
          manifest.
        </p>
        <div className="row">
          <EntryPicker
            label="Add an entry to the selection"
            onPick={(pick) => {
              setRemove((r) => r.filter((x) => x !== pick));
              setAdd((a) => (a.includes(pick) ? a : [...a, pick]));
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busy || claude.disclosure !== null || ro.off}
            {...ro.tip}
            onClick={regenerate}
            data-testid="brief-regenerate"
          >
            Regenerate
          </button>
          {claude.progress ?? (busy && <span role="status">Writing the brief.</span>)}
        </div>
        {claude.disclosure}
        {(add.length > 0 || remove.length > 0) && (
          <p data-testid="brief-pending">
            {add.length > 0 && `To add: ${add.join(', ')}. `}
            {remove.length > 0 && `To remove: ${remove.join(', ')}.`}
          </p>
        )}
        {selection && Array.isArray(selection.strands) && (
          <SelectionBody
            selection={selection}
            onOpen={onOpen}
            action={(item) =>
              remove.includes(item.id) ? (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setRemove((r) => r.filter((x) => x !== item.id))}
                >
                  Keep
                </button>
              ) : (
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => setRemove((r) => [...r, item.id])}
                >
                  Remove
                </button>
              )
            }
          />
        )}
      </section>
    </div>
  );
}
