import { useEffect, useRef, useState } from 'react';
import type { Response } from '../../../shared/ipc';
import type { EntryCollection } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useStore } from './data';
import { Zh } from './Zh';
import './notebook.css';

type Row = Response<'notebook.list'>['rows'][number];
type Page = Response<'notebook.get'>['page'];
export type NotebookAbout = 'characters' | 'places' | 'chapters';

/** "25 Nov 2026": the day the page was written on the phone. */
export function notebookDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** True for the entry sections that have a Notebook list (A55, NB-7). */
export const hasNotebook = (c: EntryCollection): c is NotebookAbout =>
  c === 'characters' || c === 'places' || c === 'chapters';

/**
 * A55 (NB-7): the Notebook list on a character, place or chapter: the pages
 * from the phone that name it, newest first, each its date and first line
 * captioned by kind and story year. A kept line is its own row and is all
 * there is to read; a council, a question thread or research opens across
 * the screen. Nothing here edits a page: they follow the phone.
 */
export function NotebookList(props: {
  collection: NotebookAbout;
  id: string;
  onOpenPage: (pageId: string) => void;
  /** The page just closed, whose row takes the focus back. */
  returnTo?: string | null;
}) {
  const { version } = useStore();
  const [rows, setRows] = useState<Row[] | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    call('notebook.list', { collection: props.collection, id: props.id })
      .then((r) => {
        if (live) setRows(r.rows);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [props.collection, props.id, version]);

  useEffect(() => {
    if (!props.returnTo || !rows) return;
    listRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-notebook-id="${CSS.escape(props.returnTo)}"] button`,
      )
      ?.focus();
  }, [props.returnTo, rows]);

  if (!rows || rows.length === 0) return null;
  return (
    <section className="nb-section" aria-labelledby={`nb-${props.id}`} data-testid="notebook-list">
      <h3 id={`nb-${props.id}`}>Notebook</h3>
      <NotebookRowList rows={rows} ref={listRef} onOpenPage={props.onOpenPage} />
    </section>
  );
}

/** The rows of a Notebook list: date, first line and caption; a page that opens is a button. */
function NotebookRowList(props: {
  rows: Row[];
  ref?: React.Ref<HTMLUListElement>;
  onOpenPage: (pageId: string) => void;
}) {
  const { rows, ref, onOpenPage } = props;
  return (
    <ul className="nb-list" ref={ref}>
      {rows.map((r) => {
        const body = (
          <>
            <time dateTime={r.date}>{notebookDate(r.date)}</time>
            <span className="nb-first">
              <Zh text={r.firstLine || 'Untitled'} actions={false} />
            </span>
            <em className="nb-caption">{r.caption}</em>
          </>
        );
        return (
          <li key={r.id} data-notebook-id={r.id} data-kind={r.kind}>
            {r.opens ? (
              <button type="button" className="nb-row" onClick={() => onOpenPage(r.id)}>
                {body}
              </button>
            ) : (
              <div className="nb-row kept">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A56 (FN-9): on Relevant to Session, the pages from the phone that touch the
 * scene: its characters, its places (or a place inside one) or its story
 * year. For him to read; nothing is ticked or sent.
 */
export function NotebookTouches(props: {
  characterIds: readonly string[];
  placeIds: readonly string[];
  year: number | null;
  onOpenPage: (pageId: string) => void;
}) {
  const { version } = useStore();
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = JSON.stringify([props.characterIds, props.placeIds, props.year]);
  useEffect(() => {
    let live = true;
    const [characterIds, placeIds, year] = JSON.parse(key) as [string[], string[], number | null];
    call('notebook.relevant', { characterIds, placeIds, year })
      .then((r) => {
        if (live) setRows(r.rows);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [key, version]);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="nb-section" aria-labelledby="nb-touches" data-testid="relevant-notebook">
      <h3 id="nb-touches">From the notebook</h3>
      <NotebookRowList rows={rows} onOpenPage={props.onOpenPage} />
    </section>
  );
}

type VoiceRowWire = Response<'notebook.voice'>['rows'][number];

/**
 * A56 (FN-8): a character's Voice, their lines in councils in the story, read
 * from the pages: by story year, each opening its council across the screen.
 */
export function VoiceList(props: { characterId: string; onOpenPage: (pageId: string) => void }) {
  const { version } = useStore();
  const [rows, setRows] = useState<VoiceRowWire[] | null>(null);
  useEffect(() => {
    let live = true;
    call('notebook.voice', { id: props.characterId })
      .then((r) => {
        if (live) setRows(r.rows);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [props.characterId, version]);
  if (!rows || rows.length === 0) return null;
  return (
    <section
      className="nb-section"
      aria-labelledby={`voice-${props.characterId}`}
      data-testid="voice-list"
    >
      <h3 id={`voice-${props.characterId}`}>Voice</h3>
      <ul className="nb-list">
        {rows.map((r) => (
          <li key={`${r.pageId}:${r.lineId}`} data-notebook-id={r.pageId} data-line-id={r.lineId}>
            <button type="button" className="nb-row" onClick={() => props.onOpenPage(r.pageId)}>
              <time dateTime={r.date}>
                {r.year === undefined ? 'No year' : r.year === null ? 'The whole book' : r.year}
              </time>
              <span className="nb-first">
                <Zh text={r.text} actions={false} />
              </span>
              <em className="nb-caption">In the story · {notebookDate(r.date)}</em>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A55 (NB-8): one council, question thread or research page across the
 * screen (the A49 and A50 pattern): its caption and date, then every line
 * as written, his own in plain ink and each character's under their name,
 * the wiser lines in italic; what it names opens its page. Close or Escape
 * goes back to where it was opened.
 */
export function NotebookPageView(props: {
  id: string;
  onClose: () => void;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { version } = useStore();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const { onClose } = props;

  useEffect(() => {
    let live = true;
    call('notebook.get', { id: props.id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [props.id, version]);

  useEffect(() => {
    if (page) headRef.current?.focus();
  }, [page?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const close = (
    <button type="button" className="btn small" onClick={onClose}>
      Close
    </button>
  );
  if (error) {
    return (
      <section className="nb-page" data-testid="notebook-page">
        <p className="callout warn" role="alert">
          {error}
        </p>
        {close}
      </section>
    );
  }
  if (!page) return <p aria-live="polite">Loading the notebook page.</p>;
  return (
    <section
      className="nb-page"
      aria-labelledby="nb-page-title"
      data-testid="notebook-page"
      data-page-id={page.id}
    >
      <header className="nb-page-head">
        <div className="stack tight">
          <span className="eyebrow">{page.caption}</span>
          <h2 id="nb-page-title" tabIndex={-1} ref={headRef}>
            <Zh text={page.firstLine || 'Untitled'} actions={false} />
          </h2>
          <time dateTime={page.date}>{notebookDate(page.date)}</time>
        </div>
        {close}
      </header>
      {page.inTrash && (
        <p className="callout warn" role="status">
          The phone deleted this page, so it is in the trash. It comes back if the phone sends it
          again.
        </p>
      )}
      {page.lines.length > 0 && (
        <ol className="nb-lines" aria-label="Lines">
          {page.lines.map((l) => (
            <li
              key={l.id}
              data-line-id={l.id}
              data-voice={l.voice}
              className={[l.wise ? 'wise' : '', l.voice].filter(Boolean).join(' ')}
            >
              {l.voice === 'character' && l.speaker && (
                <strong className="nb-speaker">{l.speaker}</strong>
              )}
              {l.paper && (
                <span className="nb-voice-note">
                  {l.paper.side ? `Paper, ${l.paper.side}` : 'Paper'}
                </span>
              )}
              <span className="nb-text">
                <Zh text={l.text} actions={false} />
              </span>
              {l.kept && <span className="nb-kept">kept</span>}
            </li>
          ))}
        </ol>
      )}
      {page.research && (
        <section className="nb-research" aria-label="Papers">
          <h3>Papers</h3>
          {page.research.papers.length === 0 ? (
            <p>No papers were picked.</p>
          ) : (
            <ul>
              {page.research.papers.map((p) => (
                <li key={p.id || p.title}>
                  <span className="nb-paper-title">{p.title}</span>
                  <span className="nb-paper-meta">
                    {[p.journal, p.year, p.side, p.doi]
                      .filter((x) => x !== null && x !== '')
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {page.links.length > 0 && (
        <nav className="nb-links" aria-label="What this page names">
          <h3>Names</h3>
          <ul>
            {page.links.map((l) => (
              <li key={`${l.collection}:${l.id}`}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => props.onOpen(l.collection, l.id)}
                >
                  <Zh text={l.title} actions={false} />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
}
