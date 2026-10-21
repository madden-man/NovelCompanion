import { useEffect, useId, useState } from 'react';
import { WriteFieldset } from '../../connection';
import type { Response } from '../../../../shared/ipc';
import { editableFields, manifests } from '../../../../shared/schema';
import type { FieldSpec } from '../../../../shared/schema';
import { call } from '../../api';
import { useStore } from '../data';
import { SaveState, TrashControls, useAutosave } from '../editor';
import { Field } from '../fields';
import { Zh } from '../Zh';
import type { OutlineWrites } from './actions';
import { InlineName } from './InlineName';
import { StrandsEditor } from './Strands';

type Outline = Response<'outline.get'>;
type Page = Response<'chapter.page'>['page'];

/** Fields the chapter page edits in its own controls, so the generic list leaves them out. */
const OWN = new Set(['title', 'partId', 'readingOrder', 'strands']);
/** Fields shown open on the chapter page; every other one sits under More fields. */
const MAIN = ['written'];
const chapterSpecs = editableFields(manifests.chapters);
/** A field of the chapter manifest by name; a renamed field fails here at once, not quietly. */
function chapterSpec(name: string): FieldSpec {
  const spec = chapterSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`The chapter manifest has no field named ${name}.`);
  return spec;
}
const mainSpecs = MAIN.map(chapterSpec);
const moreSpecs = chapterSpecs.filter((s) => !OWN.has(s.name) && !MAIN.includes(s.name));

/** The stored chapter page, reloaded after every change in the bible. */
function useChapterPage(id: string): Page | null {
  const { version } = useStore();
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    let live = true;
    void call('chapter.page', { id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch(() => {
        if (live) setPage(null);
      });
    return () => {
      live = false;
    };
  }, [id, version]);
  return page;
}

/**
 * KB-3: the chapter page in the outline's inspector. It shows who is present
 * and how old and the places, and edits them in place: the title in the
 * heading, the part through Move to part, strands, and written. Arcs, beats,
 * themes, and facts in play went with A39. Every edit autosaves through the
 * one write path.
 */
export function ChapterPanel(props: {
  id: string;
  outline: Outline;
  writes: OutlineWrites;
  onClose: () => void;
  onMove: (by: -1 | 1) => void;
  onToPart: (partId: string) => void;
  canMove: { up: boolean; down: boolean };
}) {
  const { id, outline, writes } = props;
  const ed = useAutosave('chapters', id);
  const page = useChapterPage(id);
  const partSelect = useId();
  const draft = ed.draft;
  const row = outline.rows.find((r) => r.kind === 'chapter' && r.id === id);
  const partId = row?.kind === 'chapter' ? row.partId : '';

  if (ed.status === 'missing') {
    return (
      <div className="stack tight">
        <p className="callout warn">This chapter no longer exists.</p>
        <button type="button" className="btn small" onClick={props.onClose}>
          Close the chapter
        </button>
      </div>
    );
  }
  if (!draft || !page) return <p aria-live="polite">Loading the chapter page.</p>;
  const inTrash = Boolean(draft.deletedAt);
  const messages = { warnings: ed.warnings, issues: ed.issues };
  const title = typeof draft.title === 'string' ? draft.title : '';
  const field = (spec: FieldSpec) => (
    <Field
      key={spec.name}
      spec={spec}
      value={draft[spec.name]}
      path={spec.name}
      messages={messages}
      root={draft}
      onMention={(targetId) => {
        const links = Array.isArray(draft.links)
          ? (draft.links as { targetId: string; kind: string }[])
          : [];
        if (!links.some((l) => l.targetId === targetId)) {
          ed.setField('links', [...links, { targetId, kind: 'mention' }]);
        }
      }}
      onChange={(v) => ed.setField(spec.name, v)}
    />
  );
  const books = outline.rows.filter((r) => r.kind === 'book' && !r.missing);
  const partsOf = (bookId: string) =>
    outline.rows.filter((r) => r.kind === 'part' && !r.missing && r.bookId === bookId);

  return (
    <div className="stack" data-testid="editor" data-entry-id={id}>
      <div className="row tight">
        <button type="button" className="btn small" onClick={props.onClose}>
          Close the chapter
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!props.canMove.up || writes.ro.off}
          {...writes.ro.tip}
          onClick={() => props.onMove(-1)}
        >
          Move earlier in its part
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!props.canMove.down || writes.ro.off}
          {...writes.ro.tip}
          onClick={() => props.onMove(1)}
        >
          Move later in its part
        </button>
      </div>
      <div className="field">
        <label htmlFor={partSelect}>Move to part</label>
        <select
          id={partSelect}
          value={partId}
          disabled={writes.ro.off}
          {...writes.ro.tip}
          onChange={(e) => props.onToPart(e.target.value)}
        >
          {!books.some((b) => partsOf(b.id).some((p) => p.id === partId)) && (
            <option value={partId}>No part (pick one)</option>
          )}
          {books.map((b) => (
            <optgroup key={b.id} label={b.kind === 'book' ? b.label : ''}>
              {partsOf(b.id).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === 'part' ? p.label : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <section className="stack chapter-page" aria-label="Chapter page" data-testid="chapter-page">
        <header className="editor-head">
          <h3 className="ol-chapter-title">
            <span>Chapter {page.readingOrder}: </span>
            <InlineName
              value={title}
              label="Chapter title"
              disabled={writes.ro.off || inTrash}
              testId="chapter-title"
              onSave={(next) => {
                ed.setField('title', next);
                return ed.flush();
              }}
            >
              <Zh text={title || 'Untitled chapter'} actions={false} />
            </InlineName>
          </h3>
          <SaveState status={ed.status} error={ed.error} />
        </header>
        {inTrash && (
          <p className="callout warn" role="status">
            This chapter is in the trash. Restore it to bring it back with its links.
          </p>
        )}
        <p className="example-note">
          {page.storyYear === null ? 'No story year yet' : `Story year ${page.storyYear}`}
          {page.written ? ', written' : ', not written yet'}
        </p>
        <WriteFieldset>
          <StrandsEditor
            value={draft.strands}
            page={page.strands}
            storyYear={page.storyYear ?? new Date().getFullYear()}
            messages={messages}
            root={draft}
            onChange={(next) => ed.setField('strands', next)}
          />
        </WriteFieldset>
      </section>
      <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
        <WriteFieldset>
          {mainSpecs.map(field)}
          <details className="ol-more">
            <summary>More fields</summary>
            {moreSpecs.map(field)}
          </details>
        </WriteFieldset>
      </form>
      <TrashControls
        collection="chapters"
        id={id}
        title={title || 'Untitled chapter'}
        inTrash={inTrash}
        beforeDelete={ed.flush}
        onChanged={ed.reload}
      />
    </div>
  );
}
