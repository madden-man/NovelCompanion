import { useWriteGuard } from '../connection';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo, entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Request, Response } from '../../../shared/ipc';
import { groupLabel } from '../../../shared/domain/numbering';
import { DOCUMENT_KIND_LABELS } from '../../../shared/domain/import/documents';
import type { DocumentKind } from '../../../shared/domain/import/documents';
import type { GridMapping, Mapping, TableMapping } from '../../../shared/domain/import/types';
import { call, plainError } from '../api';
import { useEntries } from './data';
import { formatTime } from './format';
import { ZhHtml } from './Zh';
import { ImportProposals } from './importProposals';

type WorkbookInfo = Response<'import.workbook'>;
type Plan = Response<'import.plan'>;
type Applied = Response<'import.apply'>;
type Preview = Response<'import.preview'>;
type Fields = Response<'import.fields'>['fields'];
type DocInfo = Response<'import.document'>;

const STATUS_CHOICES = [
  ['canon', 'Canon'],
  ['planned', 'Planned'],
  ['idea', 'Idea'],
] as const;

type PickedFile = NonNullable<Response<'import.pickFile'>['file']>;

/**
 * Import (IM-1 to IM-7): pick a workbook or a Word document, map it, compare
 * it, approve changes. GD-2, GD-3: `initialFile` is a file main already read
 * (from Google Drive); the same mapping and comparison steps follow.
 */
export function ImportView(props: { initialFile?: PickedFile; heading?: string } = {}) {
  const { initialFile } = props;
  const [workbook, setWorkbook] = useState<{ info: WorkbookInfo; initial: Mapping | null } | null>(
    null,
  );
  const [document, setDocument] = useState<DocInfo | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(initialFile !== undefined);

  const reset = () => {
    setPlan(null);
    setApplied(null);
    setError(null);
  };

  const pick = async (kind: 'workbook' | 'document') => {
    reset();
    setBusy(true);
    try {
      const { file } = await call('import.pickFile', { kind });
      if (!file) return;
      await load(file);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const load = async (file: PickedFile) => {
    if (file.kind === 'workbook') {
      setDocument(null);
      const info = await call('import.workbook', { fileId: file.id });
      const first = info.sheets[0];
      // A sheet with no saved mapping starts from its columns matched by header.
      const initial =
        info.saved.find((s) => s.sheet === first?.name)?.mapping ??
        (first
          ? (
              await call('import.guess', {
                fileId: file.id,
                sheet: first.name,
                shape: first.shape,
                collection: first.shape === 'grid' ? 'worldEvents' : 'characters',
              })
            ).mapping
          : null);
      setWorkbook({ info, initial });
    } else {
      setWorkbook(null);
      setDocument(await call('import.document', { fileId: file.id }));
    }
  };

  useEffect(() => {
    if (!initialFile) return;
    load(initialFile)
      .catch((e: unknown) => setError(plainError(e)))
      .finally(() => setBusy(false));
    // Load once per file handed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile?.id]);

  return (
    <section className="ws-wide stack" aria-labelledby="import-title" data-testid="import-view">
      <h2 id="import-title">{props.heading ?? 'Import'}</h2>
      {initialFile ? (
        <p className="lede">
          {initialFile.name} from Google Drive. Map it and compare: nothing is saved until you
          approve the changes.
        </p>
      ) : (
        <p className="lede">
          Bring in an Excel workbook or a Word document. You choose where each column goes and see
          the result before anything is saved. Importing the same file again updates the entries it
          made.
        </p>
      )}
      <div className="row" hidden={initialFile !== undefined}>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          data-testid="import-pick-workbook"
          onClick={() => void pick('workbook')}
        >
          Choose an Excel workbook
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="import-pick-document"
          onClick={() => void pick('document')}
        >
          Choose a Word document
        </button>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {busy ? (
        <p aria-live="polite">Reading the file.</p>
      ) : applied ? (
        <AppliedReport
          applied={applied}
          onAgain={() => {
            setApplied(null);
            setPlan(null);
          }}
        />
      ) : plan ? (
        <ChangeSetView
          plan={plan}
          onBack={() => setPlan(null)}
          onApplied={(a) => {
            setApplied(a);
            setPlan(null);
          }}
          onError={setError}
        />
      ) : workbook ? (
        <WorkbookMapper
          key={workbook.info.file.id}
          info={workbook.info}
          initial={workbook.initial}
          onPlan={(p) => {
            setError(null);
            setPlan(p);
          }}
          onError={setError}
        />
      ) : document ? (
        <DocumentImporter
          info={document}
          onPlan={(p) => {
            setError(null);
            setPlan(p);
          }}
          onError={setError}
        />
      ) : null}
      {document && !busy && (
        <ImportProposals
          key={document.file.id}
          fileId={document.file.id}
          fileName={document.file.name}
        />
      )}
    </section>
  );
}

// ---------- workbook mapping ----------

function targetKey(target: Mapping['target']): string {
  return target.collection;
}

function WorkbookMapper(props: {
  info: WorkbookInfo;
  /** The saved mapping for the first sheet, or one matched by header when none is saved. */
  initial: Mapping | null;
  onPlan: (p: Plan) => void;
  onError: (m: string | null) => void;
}) {
  const { info, onPlan, onError } = props;
  const sheetId = useId();
  const sectionId = useId();
  const first = info.sheets[0];
  const firstSaved = info.saved.find((s) => s.sheet === first?.name)?.mapping ?? null;
  const [sheetName, setSheetName] = useState(first?.name ?? '');
  const sheet = info.sheets.find((s) => s.name === sheetName);
  const [shape, setShape] = useState<'table' | 'grid'>(
    firstSaved?.shape ?? first?.shape ?? 'table',
  );
  const [target, setTarget] = useState<string>(
    firstSaved ? targetKey(firstSaved.target) : 'characters',
  );
  const [mapping, setMapping] = useState<Mapping | null>(props.initial);
  const [fields, setFields] = useState<Fields>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [usedSaved, setUsedSaved] = useState(firstSaved !== null);
  const fileId = info.file.id;

  const targetParts = useMemo(() => {
    return { collection: target as EntryCollection };
  }, [target]);

  // The fields a column can fill, for the section chosen.
  useEffect(() => {
    if (shape === 'grid') return;
    let live = true;
    void call('import.fields', targetParts).then((r) => {
      if (live) setFields(r.fields);
    });
    return () => {
      live = false;
    };
  }, [shape, targetParts]);

  const guess = useCallback(
    async (sheet: string, nextShape: 'table' | 'grid', nextTarget: string) => {
      const collection = nextTarget as EntryCollection;
      try {
        const r = await call('import.guess', {
          fileId,
          sheet,
          shape: nextShape,
          collection: nextShape === 'grid' ? 'worldEvents' : collection,
        });
        setMapping(r.mapping);
        setUsedSaved(false);
      } catch (e) {
        onError(plainError(e));
      }
    },
    [fileId, onError],
  );

  const chooseSheet = (name: string) => {
    const saved = info.saved.find((x) => x.sheet === name)?.mapping ?? null;
    const picked = info.sheets.find((x) => x.name === name);
    setSheetName(name);
    if (saved) {
      setShape(saved.shape);
      setTarget(targetKey(saved.target));
      setMapping(saved);
      setUsedSaved(true);
    } else if (picked) {
      setShape(picked.shape);
      setMapping(null);
      setUsedSaved(false);
      void guess(name, picked.shape, picked.shape === 'grid' ? 'worldEvents' : target);
    }
  };

  // Live preview of the first rows (IM-1, IM-2).
  useEffect(() => {
    if (!mapping) return;
    let live = true;
    const t = setTimeout(() => {
      call('import.preview', { fileId, mapping, limit: 12 })
        .then((r) => {
          if (live) setPreview(r);
        })
        .catch((e: unknown) => {
          if (live) onError(plainError(e));
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [fileId, mapping, onError]);

  const change = (patch: Partial<TableMapping> | Partial<GridMapping>) =>
    setMapping((m) => (m ? ({ ...m, ...patch } as Mapping) : m));

  const compare = async () => {
    if (!mapping) return;
    onError(null);
    try {
      onPlan(await call('import.plan', { fileId, mapping }));
    } catch (e) {
      onError(plainError(e));
    }
  };

  const sectionOptions = ENTRY_COLLECTIONS.map(
    (c) => [c as string, collectionInfo[c].plural] as const,
  );

  return (
    <div className="stack" data-testid="import-workbook">
      <div className="panel stack">
        <h3>{info.file.name}</h3>
        <p className="example-note">Last modified {formatTime(info.file.modifiedAt)}</p>
        <div className="row">
          <label className="field" htmlFor={sheetId}>
            Sheet
            <select
              id={sheetId}
              data-testid="import-sheet"
              value={sheetName}
              onChange={(e) => chooseSheet(e.target.value)}
            >
              {info.sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.rows} rows)
                </option>
              ))}
            </select>
          </label>
          <fieldset className="field shape-toggle">
            <legend>Shape of the sheet</legend>
            <label>
              <input
                type="radio"
                name="shape"
                checked={shape === 'table'}
                onChange={() => {
                  setShape('table');
                  void guess(sheetName, 'table', target);
                }}
              />{' '}
              Table: one row per entry
            </label>
            <label>
              <input
                type="radio"
                name="shape"
                checked={shape === 'grid'}
                onChange={() => {
                  setShape('grid');
                  void guess(sheetName, 'grid', 'worldEvents');
                }}
              />{' '}
              Grid: row label by year column
            </label>
          </fieldset>
          {shape === 'table' && (
            <label className="field" htmlFor={sectionId}>
              Section
              <select
                id={sectionId}
                data-testid="import-section"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  void guess(sheetName, 'table', e.target.value);
                }}
              >
                {sectionOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {usedSaved && (
          <p className="callout" role="status" data-testid="import-saved-note">
            Using the mapping saved for this file and sheet.
          </p>
        )}
        {sheet && <SheetPreview rows={sheet.preview} />}
      </div>

      {mapping?.shape === 'table' && (
        <TableMappingEditor
          sheetPreview={sheet?.preview ?? []}
          mapping={mapping}
          fields={fields}
          onChange={change}
        />
      )}
      {mapping?.shape === 'grid' && <GridMappingEditor mapping={mapping} onChange={change} />}
      {mapping && <CommonOptions mapping={mapping} onChange={change} />}

      {preview && <PreviewTable preview={preview} />}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          data-testid="import-compare"
          disabled={!mapping || (preview !== null && preview.total === 0)}
          onClick={() => void compare()}
        >
          Compare with the bible
        </button>
      </div>
    </div>
  );
}

function SheetPreview({ rows }: { rows: (string | number | boolean | null)[][] }) {
  return (
    <details>
      <summary>The first rows of the sheet</summary>
      <div className="table-scroll">
        <table className="compact">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                {r.map((c, j) => (
                  <td key={j}>{c === null ? '' : String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function TableMappingEditor(props: {
  sheetPreview: (string | number | boolean | null)[][];
  mapping: TableMapping;
  fields: Fields;
  onChange: (patch: Partial<TableMapping>) => void;
}) {
  const { mapping, fields, sheetPreview, onChange } = props;
  const headerId = useId();
  const headers = (sheetPreview[mapping.headerRow - 1] ?? []).map((c) =>
    c === null ? '' : String(c),
  );
  const assignmentFor = (index: number) => mapping.columns.find((c) => c.index === index);
  const setColumn = (index: number, header: string, field: string) => {
    const rest = mapping.columns.filter((c) => c.index !== index);
    onChange({
      columns: field ? [...rest, { header, index, field }].sort((a, b) => a.index - b.index) : rest,
    });
  };
  const assigned = mapping.columns.map((c) => c.field);
  const identity = mapping.identity.length
    ? mapping.identity
    : assigned.includes('title')
      ? ['title']
      : assigned.slice(0, 1);
  return (
    <div className="panel stack" data-testid="import-columns">
      <h3>Match each column to a field</h3>
      <label className="field narrow" htmlFor={headerId}>
        Row with the column headers
        <input
          id={headerId}
          type="number"
          min={1}
          value={mapping.headerRow}
          onChange={(e) => onChange({ headerRow: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Goes to</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h, index) =>
              h === '' ? null : (
                <tr key={index}>
                  <th scope="row">{h}</th>
                  <td>
                    <select
                      aria-label={`Field for column ${h}`}
                      value={assignmentFor(index)?.field ?? ''}
                      onChange={(e) => setColumn(index, h, e.target.value)}
                    >
                      <option value="">Skip this column</option>
                      {fields.map((f) => (
                        <option key={f.path} value={f.path}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {assigned.length > 0 && (
        <fieldset className="field">
          <legend>These fields tell one entry from another on re-import</legend>
          <div className="row">
            {[...new Set(assigned)].map((path) => (
              <label key={path} className="check">
                <input
                  type="checkbox"
                  checked={identity.includes(path)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...identity, path]
                      : identity.filter((p) => p !== path);
                    onChange({ identity: next });
                  }}
                />{' '}
                {fields.find((f) => f.path === path)?.label ?? path}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

function GridMappingEditor(props: {
  mapping: GridMapping;
  onChange: (patch: Partial<GridMapping>) => void;
}) {
  const { mapping, onChange } = props;
  return (
    <div className="panel stack" data-testid="import-grid-options">
      <h3>How the grid reads</h3>
      <p className="example-note">
        Each filled cell becomes a world event. Its column gives the year. Its row label and the
        heading row above it give the category.
      </p>
      <div className="row">
        <label className="field narrow">
          Column with the row labels
          <input
            type="number"
            min={1}
            value={mapping.labelColumn + 1}
            onChange={(e) =>
              onChange({ labelColumn: Math.max(0, (Number(e.target.value) || 1) - 1) })
            }
          />
        </label>
        <label className="field narrow">
          Row of year headers (blank finds it)
          <input
            type="number"
            min={1}
            value={mapping.headerRow ?? ''}
            onChange={(e) =>
              onChange({ headerRow: e.target.value ? Math.max(1, Number(e.target.value)) : null })
            }
          />
        </label>
        <label className="field narrow">
          Add to every year
          <input
            type="number"
            min={0}
            value={mapping.yearOffset}
            onChange={(e) => onChange({ yearOffset: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="field">
          Put every category under
          <input
            value={mapping.categoryRoot ?? ''}
            placeholder="Optional"
            onChange={(e) =>
              onChange({ categoryRoot: e.target.value.trim() ? e.target.value : null })
            }
          />
        </label>
      </div>
      <div className="row">
        <label className="field">
          Which rows are headings
          <select
            value={mapping.headingBy ?? 'style'}
            onChange={(e) => onChange({ headingBy: e.target.value as GridMapping['headingBy'] })}
          >
            <option value="style">Bold rows with no cells</option>
            <option value="any">Every row with a label and no cells</option>
            <option value="pattern">Rows whose label matches a pattern</option>
            <option value="rows">Rows I list by number</option>
          </select>
        </label>
        {mapping.headingBy === 'pattern' && (
          <label className="field">
            Heading label pattern
            <input
              value={mapping.headingPattern ?? ''}
              placeholder="For example ^Section"
              onChange={(e) =>
                onChange({ headingPattern: e.target.value.trim() ? e.target.value : undefined })
              }
            />
          </label>
        )}
        {mapping.headingBy === 'rows' && (
          <label className="field">
            Heading row numbers
            <input
              value={(mapping.headingRows ?? []).join(', ')}
              placeholder="For example 2, 5, 7"
              onChange={(e) =>
                onChange({
                  headingRows: e.target.value
                    .split(/[\s,]+/)
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n >= 1),
                })
              }
            />
          </label>
        )}
      </div>
    </div>
  );
}

function CommonOptions(props: {
  mapping: Mapping;
  onChange: (patch: Partial<TableMapping> | Partial<GridMapping>) => void;
}) {
  const { mapping, onChange } = props;
  const status = typeof mapping.fixed.status === 'string' ? mapping.fixed.status : 'planned';
  const provenance = typeof mapping.fixed.provenance === 'string' ? mapping.fixed.provenance : '';
  const fixed = (patch: Record<string, unknown>) => {
    const next = Object.fromEntries(
      Object.entries({ ...mapping.fixed, ...patch }).filter(([, v]) => v !== ''),
    );
    onChange({ fixed: next });
  };
  return (
    <div className="panel stack" data-testid="import-options">
      <h3>Every imported entry</h3>
      <div className="row">
        <label className="field narrow">
          Status
          <select value={status} onChange={(e) => fixed({ status: e.target.value })}>
            {STATUS_CHOICES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          Provenance
          <select value={provenance} onChange={(e) => fixed({ provenance: e.target.value })}>
            <option value="">Not set</option>
            <option value="researched">Researched</option>
            <option value="invented">Invented</option>
          </select>
        </label>
      </div>
      {mapping.shape === 'table' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={mapping.addMissingListItems}
              onChange={(e) => onChange({ addMissingListItems: e.target.checked })}
            />{' '}
            Add a list choice that is not in its list yet, instead of failing the row
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={mapping.createMissing}
              onChange={(e) => onChange({ createMissing: e.target.checked })}
            />{' '}
            Make a new entry for a name that matches no entry, instead of failing the row
          </label>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={mapping.matchIn === 'section'}
          onChange={(e) => onChange({ matchIn: e.target.checked ? 'section' : 'sheet' })}
        />{' '}
        On re-import, match any entry in this section, not only those from this sheet
      </label>
    </div>
  );
}

function PreviewTable({ preview }: { preview: Preview }) {
  return (
    <div className="panel stack" data-testid="import-preview">
      <h3>Preview</h3>
      <p data-testid="import-preview-counts">
        {preview.total} {preview.total === 1 ? 'row' : 'rows'}: {preview.ok} ready,{' '}
        <strong>{preview.failed} will fail</strong>.
        {preview.rows.length < preview.total ? ` Showing the first ${preview.rows.length}.` : ''}
      </p>
      {preview.notes.map((n) => (
        <p key={n} className="callout warn" role="status">
          {n}
        </p>
      ))}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Result</th>
              <th scope="col">Entry</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => (
              <tr key={r.where} data-ok={r.ok} data-testid="import-preview-row">
                <th scope="row">{r.where}</th>
                <td>
                  {r.ok ? (
                    <span className="chip">Ready</span>
                  ) : (
                    <span className="import-fail">Will fail: {r.reason}</span>
                  )}
                </td>
                <td>
                  {r.ok && <strong>{r.title}</strong>}
                  {r.values.length > 0 && (
                    <span className="import-values">
                      {r.values.map((v) => `${v.label}: ${v.text}`).join('; ')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- documents ----------

function DocumentImporter(props: {
  info: DocInfo;
  onPlan: (p: Plan) => void;
  onError: (m: string | null) => void;
}) {
  const { info, onPlan, onError } = props;
  const characters = useEntries('characters');
  const chapters = useEntries('chapters');
  const parts = useEntries('parts');
  const [kind, setKind] = useState<DocumentKind>('chapter');
  const [characterId, setCharacterId] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [title, setTitle] = useState(info.title);
  const [partId, setPartId] = useState('');
  const [year, setYear] = useState('');
  const [noteTitle, setNoteTitle] = useState(info.title);

  const ready =
    kind === 'backstory'
      ? characterId !== ''
      : kind === 'chapter'
        ? chapterId !== '' || (title.trim() !== '' && partId !== '' && year.trim() !== '')
        : noteTitle.trim() !== '';

  const compare = async () => {
    onError(null);
    const request: Request<'import.documentPlan'> = {
      fileId: info.file.id,
      target:
        kind === 'backstory'
          ? { kind, characterId }
          : kind === 'chapter'
            ? chapterId
              ? { kind, chapterId }
              : { kind, chapterId: null, title: title.trim(), partId, year: Number(year) }
            : { kind, title: noteTitle.trim() },
    };
    try {
      onPlan(await call('import.documentPlan', request));
    } catch (e) {
      onError(plainError(e));
    }
  };

  return (
    <div className="stack" data-testid="import-document">
      <div className="panel stack">
        <h3>{info.file.name}</h3>
        <p className="example-note">
          Last modified {formatTime(info.file.modifiedAt)}. {info.paragraphs} paragraphs,{' '}
          {info.headings.length} headings, {info.sceneBreaks} scene breaks.
        </p>
        <div className="row">
          <label className="field">
            Bring it in as
            <select
              data-testid="import-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
            >
              {(Object.keys(DOCUMENT_KIND_LABELS) as DocumentKind[]).map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {kind === 'backstory' && (
            <label className="field">
              Character
              <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                <option value="">Choose a character</option>
                {characters.map((c) => (
                  <option key={c._id} value={c._id}>
                    {entryTitle(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'chapter' && (
            <label className="field">
              Chapter
              <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
                <option value="">A new chapter</option>
                {chapters.map((c) => (
                  <option key={c._id} value={c._id}>
                    {entryTitle(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {kind === 'chapter' && chapterId === '' && (
          <div className="row">
            <label className="field">
              Chapter title
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              Part
              <select value={partId} onChange={(e) => setPartId(e.target.value)}>
                <option value="">Choose a part</option>
                {parts.map((p) => (
                  <option key={p._id} value={p._id}>
                    {groupLabel('part', p.number, entryTitle(p))}
                  </option>
                ))}
              </select>
            </label>
            <label className="field narrow">
              Story year
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
            </label>
          </div>
        )}
        {kind === 'note' && (
          <label className="field">
            Note title
            <input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} />
          </label>
        )}
      </div>
      <div className="panel stack" data-testid="import-document-preview">
        <h3>Preview</h3>
        {info.headings.length > 0 && (
          <ul className="doc-outline" aria-label="Headings kept">
            {info.headings.map((h) => (
              <li key={h.index} className={`level-${h.level}`}>
                {h.text || '(empty heading)'}
              </li>
            ))}
          </ul>
        )}
        <div className="doc-preview">
          <ZhHtml html={info.body} />
        </div>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          data-testid="import-compare"
          disabled={!ready}
          onClick={() => void compare()}
        >
          Compare with the bible
        </button>
      </div>
    </div>
  );
}

// ---------- the change set ----------

function ChangeSetView(props: {
  plan: Plan;
  onBack: () => void;
  onApplied: (a: Applied) => void;
  onError: (m: string | null) => void;
}) {
  const { plan, onBack, onApplied, onError } = props;
  const changed = plan.items.filter((i) => i.kind === 'changed');
  const created = plan.items.filter((i) => i.kind === 'new');
  const [approved, setApproved] = useState<Set<string>>(() => new Set(plan.items.map((i) => i.id)));
  const [saveMapping, setSaveMapping] = useState(true);
  const [busy, setBusy] = useState(false);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  /** Approving an item also approves the new items it points at, and theirs in turn, so no link dangles. */
  const withNeeds = (ids: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    const queue = [...ids];
    while (queue.length) {
      const id = queue.pop() as string;
      if (out.has(id) || !byId.has(id)) continue;
      out.add(id);
      queue.push(...(byId.get(id)?.needs ?? []));
    }
    return out;
  };
  const toggle = (id: string, on: boolean) =>
    setApproved((prev) => {
      if (on) return withNeeds([...prev, id]);
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  // What will be written: the approved items and what they need.
  const effective = withNeeds(approved);
  const alsoCreates = (item: (typeof plan.items)[number]) =>
    (item.needs ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map((n) => n.title || 'Untitled');
  /** The approved items that point at this one, which is why it cannot be unchecked. */
  const neededBy = (id: string) =>
    plan.items
      .filter((o) => o.id !== id && effective.has(o.id) && (o.needs ?? []).includes(id))
      .map((o) => o.title || 'Untitled');
  const allNew = created.length > 0 && created.every((i) => effective.has(i.id));
  const someNew = created.some((i) => effective.has(i.id));

  const ro = useWriteGuard();
  const apply = async () => {
    setBusy(true);
    onError(null);
    try {
      onApplied(
        await call('import.apply', {
          planId: plan.planId,
          approved: [...effective],
          saveMapping,
        }),
      );
    } catch (e) {
      onError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" data-testid="import-changes">
      <div className="panel stack">
        <h3>Changes from {plan.file}</h3>
        <p data-testid="import-summary">
          <strong>{plan.created}</strong> new, <strong>{plan.changed}</strong> changed,{' '}
          <strong>{plan.unchanged}</strong> unchanged, <strong>{plan.failed.length}</strong> failed.
          {plan.conflicts > 0 && ` ${plan.conflicts} fields where sources disagree.`}
        </p>
        {plan.listAdds.length > 0 && (
          <p className="example-note">
            New list choices: {plan.listAdds.slice(0, 12).join(', ')}
            {plan.listAdds.length > 12 ? `, and ${plan.listAdds.length - 12} more` : ''}.
          </p>
        )}
        {plan.notes.map((n) => (
          <p key={n} className="callout warn" role="status">
            {n}
          </p>
        ))}
        <p className="example-note">
          Nothing is saved until you press Import. A snapshot of the bible is taken first.
        </p>
      </div>

      {plan.failed.length > 0 && (
        <div className="panel stack" data-testid="import-failed">
          <h3>Rows that cannot be imported</h3>
          <p className="example-note">
            The other rows still import. Fix these in the file and import again.
          </p>
          <ul className="fail-list">
            {plan.failed.map((f, i) => (
              <li key={`${f.ref}-${i}`}>
                <strong>{f.where}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {changed.length > 0 && (
        <div className="stack" data-testid="import-changed">
          <h3>Changes to entries already imported</h3>
          {changed.map((item) => (
            <article
              key={item.id}
              className="panel stack"
              data-testid="import-change"
              data-title={item.title}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={effective.has(item.id)}
                  onChange={(e) => toggle(item.id, e.target.checked)}
                />{' '}
                <strong>{item.title}</strong>
                <span className="example-note"> {item.ref}</span>
                {effective.has(item.id) && alsoCreates(item).length > 0 && (
                  <span className="example-note" data-testid="import-also-creates">
                    {' '}
                    also creates {alsoCreates(item).join(', ')}
                  </span>
                )}
              </label>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Now</th>
                    <th scope="col">From the file</th>
                  </tr>
                </thead>
                <tbody>
                  {item.deltas.map((d) => (
                    <tr key={d.path}>
                      <th scope="row">{d.label}</th>
                      <td>
                        <del>{d.before}</del>
                      </td>
                      <td>
                        <ins>{d.after}</ins>
                        {d.outcome === 'keep' && (
                          <span className="example-note">
                            {' '}
                            (not applied: the current value is newer)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {item.deltas
                .filter((d) => d.conflict)
                .map((d) => (
                  <div key={d.path} className="callout warn" data-testid="import-conflict">
                    <p>
                      <strong>Sources disagree about {d.label}.</strong> The most recently modified
                      source wins, and an open question will list them all.
                    </p>
                    <ul>
                      {d.conflict?.claims.map((c, i) => (
                        <li key={i}>
                          {c.ref}, modified {formatTime(c.at)}: {c.value}
                          {c.kept ? ' (kept)' : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </article>
          ))}
        </div>
      )}

      {created.length > 0 && (
        <div className="panel stack" data-testid="import-new">
          <label className="check">
            <input
              type="checkbox"
              checked={allNew}
              ref={(el) => {
                if (el) el.indeterminate = someNew && !allNew;
              }}
              onChange={(e) => {
                setApproved((prev) => {
                  const next = new Set(prev);
                  for (const i of created) {
                    if (e.target.checked) next.add(i.id);
                    else next.delete(i.id);
                  }
                  return next;
                });
              }}
            />{' '}
            <strong>
              Add {created.length} new {created.length === 1 ? 'entry' : 'entries'}
            </strong>
          </label>
          <details>
            <summary>Choose which new entries to add</summary>
            <ul className="new-list">
              {created.slice(0, 300).map((i) => (
                <li key={i.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={effective.has(i.id)}
                      disabled={neededBy(i.id).length > 0}
                      onChange={(e) => toggle(i.id, e.target.checked)}
                    />{' '}
                    {i.title || 'Untitled'}{' '}
                    <span className="example-note">
                      {collectionInfo[i.collection].singular}, {i.ref}
                      {i.note ? `. ${i.note}` : ''}
                    </span>
                    {neededBy(i.id).length > 0 && (
                      <span className="example-note" data-testid="import-needed-by">
                        {' '}
                        needed by {neededBy(i.id).join(', ')}
                      </span>
                    )}
                    {effective.has(i.id) && alsoCreates(i).length > 0 && (
                      <span className="example-note" data-testid="import-also-creates">
                        {' '}
                        also creates {alsoCreates(i).join(', ')}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            {created.length > 300 && (
              <p className="example-note">
                {created.length - 300} more follow the same choice as the box above.
              </p>
            )}
          </details>
        </div>
      )}

      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={saveMapping}
            onChange={(e) => setSaveMapping(e.target.checked)}
          />{' '}
          Save this mapping for the file and sheet
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          data-testid="import-apply"
          disabled={busy || effective.size === 0 || ro.off}
          {...ro.tip}
          onClick={() => void apply()}
        >
          Import {effective.size} {effective.size === 1 ? 'change' : 'changes'}
        </button>
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function AppliedReport({ applied, onAgain }: { applied: Applied; onAgain: () => void }) {
  return (
    <div className="panel stack" role="status" data-testid="import-result">
      <h3>Import finished</h3>
      <p data-testid="import-result-counts">
        Created {applied.created}, updated {applied.updated}, left {applied.unchanged} unchanged.
        {applied.questions > 0 &&
          ` ${applied.questions} open ${applied.questions === 1 ? 'question lists' : 'questions list'} where sources disagreed.`}
      </p>
      {applied.snapshot && <p className="example-note">Snapshot taken first: {applied.snapshot}</p>}
      {applied.failed.length > 0 && (
        <>
          <h4>Rows that failed</h4>
          <ul className="fail-list">
            {applied.failed.map((f, i) => (
              <li key={`${f.ref}-${i}`}>
                <strong>{f.where}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={onAgain}>
          Import something else
        </button>
      </div>
    </div>
  );
}
