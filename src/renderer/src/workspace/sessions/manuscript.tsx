import { WriteFieldset } from '../../connection';
import { useEffect, useId, useMemo, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { entryTitle, isEntryCollection } from '../../../../shared/schema';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import type { Entry } from '../data';
import { useUndo } from '../undo';
import { OpenSettingsButton, claudeNav } from '../claude';
import { DriveDocumentPicker } from '../drive';
import { useClaudeRun } from './claudeRun';
import { ManuscriptDiff, Reimport } from './Reimport';
import { EntryEditable } from '../editable';
import { numberedLines } from '../../../../shared/domain/continuity/lines';
import { updateWithUndo } from './common';
import { RichText } from '../richText/RichText';
import type { OpenEntry } from './common';
import './alignment.css';

type Read = Response<'manuscript.read'>;
type Establishment = Response<'chapter.establishes'>['items'][number];

/**
 * The manuscript (MS-1 to MS-5): import a chapter from a Word file or a
 * Google Doc (chosen with the Drive browser), read a linked file again and
 * see the text diff,
 * and mark a chapter as written: a summary to approve and the planned
 * entries it establishes to promote. The app only reads manuscripts; it
 * never writes to one.
 */
export function ManuscriptView({
  onOpen,
  chapterId,
  openFlow,
}: {
  onOpen: OpenEntry;
  /** MS-2: the chapter just ticked Written in its editor, opened with the flow showing. */
  chapterId?: string;
  openFlow?: boolean;
}) {
  const chapters = useEntries('chapters');
  const [selected, setSelected] = useState<string | null>(chapterId ?? null);
  const sorted = useMemo(
    () => [...chapters].sort((a, b) => Number(a.readingOrder ?? 0) - Number(b.readingOrder ?? 0)),
    [chapters],
  );
  const chapter = sorted.find((c) => c._id === selected) ?? null;
  return (
    <div className="ws-wide stack" data-testid="manuscript-view">
      <h2>Manuscript</h2>
      <p className="example-note">
        Chapters are read from your manuscript files. The app never changes a manuscript.
      </p>
      <div className="two-col">
        <ul className="plain-list stack tight" aria-label="Chapters" data-testid="ms-chapters">
          {sorted.map((c) => (
            <li key={c._id}>
              <button
                type="button"
                className="link-btn"
                aria-current={c._id === selected ? 'true' : undefined}
                onClick={() => setSelected(c._id)}
                data-chapter={c._id}
              >
                {`Chapter ${String(c.readingOrder)}: ${entryTitle(c)}`}
              </button>{' '}
              {c.written === true && <span className="chip canon">written</span>}
              {c.summaryOutOfDate === true && (
                <span className="chip planned">summary may be out of date</span>
              )}
            </li>
          ))}
        </ul>
        {chapter ? (
          <ChapterManuscript
            key={chapter._id}
            chapter={chapter}
            onOpen={onOpen}
            openFlow={openFlow && chapter._id === chapterId}
          />
        ) : (
          <p className="lede">Pick a chapter.</p>
        )}
      </div>
    </div>
  );
}

function ChapterManuscript({
  chapter,
  onOpen,
  openFlow,
}: {
  chapter: Entry;
  onOpen: OpenEntry;
  openFlow?: boolean;
}) {
  const undo = useUndo();
  const [sources, setSources] = useState<Response<'manuscript.sources'>['sources']>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // MS-2: arriving from the chapter editor's Written offer shows the flow once the save lands.
  const [flowSet, setFlow] = useState<boolean | null>(null);
  const flow = flowSet ?? (openFlow === true && chapter.written === true);
  useEffect(() => {
    void call('manuscript.sources', {}).then((r) => setSources(r.sources));
  }, []);

  const doRead = async (sourceId?: string, locator?: string) => {
    setError(null);
    setNote(null);
    setPicking(null);
    try {
      const r = await call('manuscript.read', { chapterId: chapter._id, sourceId, locator });
      setRead(r.token ? r : null);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const apply = async () => {
    if (!read?.token) return;
    try {
      const before = (await call('entry.get', { collection: 'chapters', id: chapter._id }))
        .entry as Entry;
      // IP-18: only the importer writes the manuscript text, so an import is not an undo step (A40).
      await call('manuscript.apply', {
        token: read.token,
        baseModifiedAt: String(before.modifiedAt),
      });
      setNote(
        read.summaryOutOfDate ? 'Imported. The summary may be out of date now.' : 'Imported.',
      );
      setRead(null);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const markWritten = async () => {
    setError(null);
    try {
      await updateWithUndo(undo, 'chapters', chapter._id, { written: true }, 'Marked as written');
      setFlow(true);
    } catch (e) {
      setError(plainError(e));
    }
  };

  // IP-7: the flag clears as one step, and the summary flow closes with it.
  const markNotWritten = async () => {
    setError(null);
    try {
      await updateWithUndo(
        undo,
        'chapters',
        chapter._id,
        { written: false },
        'Marked as not written',
      );
      setFlow(false);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const source = typeof chapter.manuscriptSource === 'string' ? chapter.manuscriptSource : '';
  const lines = numberedLines(chapter.manuscriptText);
  return (
    <section className="panel stack" data-testid="ms-chapter" aria-label={entryTitle(chapter)}>
      <div className="row">
        <h3>{entryTitle(chapter)}</h3>
        {chapter.written === true ? (
          <span className="chip canon">written</span>
        ) : (
          <span className="chip planned">not written</span>
        )}
        <button type="button" className="link-btn" onClick={() => onOpen('chapters', chapter._id)}>
          Open the chapter
        </button>
      </div>
      <p data-testid="ms-source">
        {chapter.sourceFile ? `Source: ${String(chapter.sourceFile)}` : 'No manuscript imported.'}
      </p>
      {/* IP-7: the approved summary shows and edits on the chapter's row, as one step; a hand
          edit is an approval, so it clears the out of date flag in the same step. */}
      <EntryEditable
        collection="chapters"
        id={chapter._id}
        entry={chapter}
        path="summary"
        kind="rich"
        label="Approved summary"
        showLabel
        placeholder="No approved summary yet. Write one here."
        testId="ms-summary"
        extraPatch={(_next, e) => (e.summaryOutOfDate === true ? { summaryOutOfDate: false } : {})}
      />
      {chapter.summaryOutOfDate === true && (
        <p className="callout warn" data-testid="summary-stale">
          The summary may be out of date: the text changed after it was written.
        </p>
      )}
      <WriteFieldset className="row">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className="btn small"
            aria-expanded={s.picker === 'drive' ? picking === s.id : undefined}
            onClick={() => (s.picker === 'drive' ? setPicking(s.id) : void doRead(s.id))}
          >
            Import from a {s.label}
          </button>
        ))}
        {source && (
          <button type="button" className="btn small" onClick={() => void doRead()}>
            Read the linked file again
          </button>
        )}
        {chapter.written === true ? (
          <>
            <button type="button" className="btn small" onClick={() => setFlow(true)}>
              Summary and promotions
            </button>
            <button type="button" className="btn small" onClick={() => void markNotWritten()}>
              Not written after all
            </button>
          </>
        ) : (
          <button type="button" className="btn primary small" onClick={() => void markWritten()}>
            Mark as written
          </button>
        )}
      </WriteFieldset>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="callout" role="status" data-testid="ms-note">
          {note}
        </p>
      )}
      {picking && (
        <DriveDocumentPicker
          onPick={(item) => void doRead(picking, item.id)}
          onCancel={() => setPicking(null)}
          onOpenSettings={claudeNav.openSettings}
        />
      )}
      {read && (
        <div className="sunken stack" data-testid="ms-compare">
          <span className="eyebrow">
            {read.name}:{' '}
            {read.changed
              ? `${read.added} lines added, ${read.removed} removed`
              : 'no change from the text in the bible'}
          </span>
          {read.changed && <ManuscriptDiff diff={read.diff} />}
          {read.summaryOutOfDate && (
            <p className="callout warn">The summary will be marked as possibly out of date.</p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn primary small"
              disabled={!read.changed && chapter.manuscriptSource === read.source}
              onClick={() => void apply()}
            >
              Apply
            </button>
            <button type="button" className="btn small" onClick={() => setRead(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
      {flow && <WrittenFlow chapter={chapter} onOpen={onOpen} />}
      {lines.length > 0 && (
        <div className="ms-text-row" data-testid="ms-text-row">
          {/* IP-18: the text is imported, never edited here; Re-import heads it. */}
          <Reimport chapter={chapter} />
          <ol
            className="ms-text"
            data-testid="ms-text"
            tabIndex={0}
            aria-label="Manuscript text, read only. Use Re-import to change it."
            title="The manuscript text is imported, not edited here. Use Re-import."
          >
            {lines.map((l) => (
              <li key={l.n} value={l.n}>
                {l.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** MS-2 and MS-3: after a chapter is marked written. */
function WrittenFlow({ chapter, onOpen }: { chapter: Entry; onOpen: OpenEntry }) {
  const undo = useUndo();
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSettings, setMessageSettings] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [items, setItems] = useState<Establishment[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const summaryId = useId();

  const loadItems = () =>
    void call('chapter.establishes', { chapterId: chapter._id }).then((r) => setItems(r.items));

  const claude = useClaudeRun('the summary');

  const summarize = (available: boolean) =>
    claude.begin(available, async (runId) => {
      const r = await call('chapter.summarize', { chapterId: chapter._id, runId });
      setDraft(r.draft);
      setMessage(r.message);
      setMessageSettings(r.needsSettings);
      setModel(r.model);
    });

  useEffect(() => {
    let live = true;
    void call('chapter.establishes', { chapterId: chapter._id }).then((r) => {
      if (live) setItems(r.items);
    });
    // MS-2: offer a generated summary as soon as the chapter is written (after the AI-6
    // disclosure on the first use in this bible). Without Claude, it is written by hand.
    void call('brief.settings.get', {}).then((s) => {
      if (live) summarize(s.claudeAvailable);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter._id]);

  const approve = async () => {
    setError(null);
    try {
      await updateWithUndo(
        undo,
        'chapters',
        chapter._id,
        { summary: draft ?? '', summaryOutOfDate: false },
        'Approved the summary',
      );
      setDone('Summary saved.');
      setDraft(null);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const promote = async () => {
    setError(null);
    try {
      for (const id of checked) {
        const item = items?.find((i) => i.id === id);
        if (!item || !isEntryCollection(item.collection)) continue;
        await updateWithUndo(undo, item.collection, id, { status: 'canon' }, 'Promoted to canon');
      }
      setChecked([]);
      loadItems();
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <div className="stack" data-testid="written-flow">
      <div className="sunken stack tight" data-testid="summary-step">
        <span className="eyebrow">
          {model ? `Generated summary (${model}), edit before approving` : 'Summary'}
        </span>
        {claude.disclosure}
        {claude.progress}
        {message && (
          <p className="example-note" data-testid="summary-message">
            {message} {messageSettings && <OpenSettingsButton />}
          </p>
        )}
        {draft !== null ? (
          <>
            <div className="field">
              <label id={summaryId}>Summary to approve</label>
              <RichText labelledBy={summaryId} value={draft} onChange={setDraft} />
            </div>
            <div className="row">
              <button
                type="button"
                className="btn primary small"
                disabled={!draft.trim()}
                onClick={() => void approve()}
              >
                Approve summary
              </button>
              <button type="button" className="btn small" onClick={() => setDraft(null)}>
                Discard
              </button>
              <span className="example-note">Nothing is saved until you approve.</span>
            </div>
          </>
        ) : (
          done && (
            <p role="status" data-testid="summary-done">
              {done}
            </p>
          )
        )}
      </div>
      <div className="sunken stack tight" data-testid="promote-step">
        <span className="eyebrow">Planned entries this chapter establishes</span>
        {items === null ? (
          <p aria-live="polite">Loading.</p>
        ) : items.length === 0 ? (
          <p className="example-note">Nothing planned is established here.</p>
        ) : (
          <>
            <ul className="plain-list stack tight" data-testid="promote-list">
              {items.map((it) => (
                <li key={it.id} className="row tight">
                  <input
                    type="checkbox"
                    id={`promote-${it.id}`}
                    checked={checked.includes(it.id)}
                    onChange={(e) =>
                      setChecked((c) =>
                        e.target.checked ? [...c, it.id] : c.filter((x) => x !== it.id),
                      )
                    }
                  />
                  <label htmlFor={`promote-${it.id}`}>
                    {it.title} ({it.why})
                  </label>
                  {isEntryCollection(it.collection) && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        isEntryCollection(it.collection) && onOpen(it.collection, it.id)
                      }
                    >
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="row">
              <button
                type="button"
                className="btn primary small"
                disabled={!checked.length}
                onClick={() => void promote()}
              >
                Promote checked to canon
              </button>
              <span className="example-note">Unchecked entries stay planned.</span>
            </div>
          </>
        )}
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
