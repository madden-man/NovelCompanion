import { useEffect, useState } from 'react';
import { useWriteGuard } from '../connection';
import { WriteFieldset } from '../connection';
import { collectionInfo, isEntryCollection, manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { ProposalView } from '../../../shared/ipc';
import { labelPath } from '../../../shared/domain/issues';
import { getPath } from '../../../shared/domain/paths';
import type { FieldSpec } from '../../../shared/schema/manifest';
import { call, plainError } from '../api';
import { useList, useStore } from './data';
import type { Entry } from './data';
import { Field } from './fields';
import { formatTime } from './format';
import { showValue } from './history';
import { Editable, listOptions, patchForPath } from './editable';

const OP_TEXT = {
  create: 'Create',
  update: 'Change',
  delete: 'Move to trash',
  listAdd: 'Add',
} as const;
/** IP-17: a list item proposal's collection is `lists`, not a section. */
const kindOf = (c: string) =>
  isEntryCollection(c) ? collectionInfo[c].singular.toLowerCase() : 'list item';
const SOURCE_TEXT = { import: 'Import', claude: 'Claude', bulk: 'Bulk action' } as const;

/**
 * The review queue (ED-7): every change that re-import, Claude, or a bulk
 * action wants to make waits here. Nothing reaches the bible until approved.
 */
export function ReviewQueue() {
  const { version } = useStore();
  const [views, setViews] = useState<ProposalView[] | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      void call('proposal.list', {}).then((r) => {
        if (live) setViews(r.proposals);
      });
    load();
    const off = window.api.on('proposals.changed', load);
    return () => {
      live = false;
      off();
    };
  }, [version, reloads]);
  const pending = (views ?? []).filter((v) => v.proposal.state === 'pending');
  const decided = (views ?? []).filter((v) => v.proposal.state !== 'pending').reverse();
  return (
    <section className="ws-wide stack" aria-labelledby="review-title" data-testid="review-queue">
      <h2 id="review-title">Review queue</h2>
      <p className="lede">
        Changes proposed by an import, by Claude, or by a bulk action wait here. Each shows exactly
        what it would change. Nothing is saved until you approve it.
      </p>
      {views === null ? (
        <p>Loading.</p>
      ) : pending.length === 0 ? (
        <p className="example-note">Nothing is waiting for review.</p>
      ) : (
        pending.map((v) => (
          <ProposalCard key={v.proposal._id} view={v} onDone={() => setReloads((n) => n + 1)} />
        ))
      )}
      {decided.length > 0 && (
        <>
          <h3>Decided</h3>
          <ul className="trash-list">
            {decided.map((v) => (
              <li key={v.proposal._id}>
                <span>
                  {OP_TEXT[v.proposal.op]} {kindOf(v.proposal.collection)} {v.targetTitle ?? ''}
                </span>
                <span className="example-note">
                  {v.proposal.state === 'approved' ? 'Approved' : 'Rejected'}
                  {v.proposal.edited ? ' after editing' : ''}, {formatTime(v.proposal.decidedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ProposalCard({ view, onDone }: { view: ProposalView; onDone: () => void }) {
  const { proposal, conflict, targetTitle } = view;
  const collection = proposal.collection as EntryCollection;
  const manifest = isEntryCollection(collection) ? manifests[collection] : [];
  const [editing, setEditing] = useState<Entry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const title = `${OP_TEXT[proposal.op]} ${kindOf(collection)}${targetTitle ? ` ${targetTitle}` : ''}`;

  const ro = useWriteGuard();
  const act = async (fn: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setMessage(plainError(e));
    }
  };

  const editKeys = Object.keys(proposal.data).filter((k) => manifest.some((s) => s.name === k));

  return (
    <article className="panel stack" aria-label={title} data-proposal={proposal._id}>
      <header className="row tight item-row">
        <h3>{title}</h3>
        <span className="chip">{SOURCE_TEXT[proposal.source]}</span>
        {proposal.edited && <span className="chip">Edited</span>}
      </header>
      {proposal.reason && <p>{proposal.reason}</p>}
      {conflict && (
        <div className="callout warn" role="status">
          <p>
            This entry changed after the proposal was made, so it cannot be approved as it stands.
            Compare again to see it against the entry as it is now.
          </p>
          <button
            type="button"
            className="btn small"
            disabled={ro.off}
            {...ro.tip}
            onClick={() => void act(() => call('proposal.refresh', { id: proposal._id }))}
          >
            Compare again
          </button>
        </div>
      )}
      <ProposalDiff view={view} edit="label" onEdited={onDone} />
      <WriteFieldset className="stack">
        {editing && (
          <form
            className="editor-fields"
            aria-label="Edit the proposed values"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await call('proposal.edit', { id: proposal._id, data: editing });
                setEditing(null);
              });
            }}
          >
            {manifest
              .filter((s) => editKeys.includes(s.name))
              .map((spec) => (
                <Field
                  key={spec.name}
                  spec={spec}
                  value={editing[spec.name]}
                  path={spec.name}
                  messages={{ warnings: [], issues: [] }}
                  root={editing}
                  onMention={() => undefined}
                  onChange={(v) => setEditing((d) => (d ? ({ ...d, [spec.name]: v } as Entry) : d))}
                />
              ))}
            <div className="row">
              <button type="submit" className="btn primary">
                Save proposed values
              </button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={conflict}
            onClick={() => void act(() => call('proposal.approve', { id: proposal._id }))}
          >
            Approve
          </button>
          {proposal.op !== 'delete' && proposal.op !== 'listAdd' && !editing && (
            <button
              type="button"
              className="btn"
              onClick={() => setEditing({ ...proposal.data } as Entry)}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn danger"
            onClick={() => void act(() => call('proposal.reject', { id: proposal._id }))}
          >
            Reject
          </button>
        </div>
      </WriteFieldset>
      {message && (
        <p className="callout crit" role="alert">
          {message}
        </p>
      )}
    </article>
  );
}

/** The field spec at a dotted path such as `names.full`, or undefined inside a list or a missing field. */
function specAt(manifest: readonly FieldSpec[], path: string): FieldSpec | undefined {
  let specs: readonly FieldSpec[] | undefined = manifest;
  let spec: FieldSpec | undefined;
  for (const part of path.split('.')) {
    if (/^\d+$/.test(part)) return undefined;
    spec = specs?.find((s) => s.name === part);
    specs = spec?.fields;
  }
  return spec;
}

/** The value kinds a proposed value edits in place (IP-17); anything else keeps the Edit form. */
const EDITABLE_KINDS = new Set(['text', 'longText', 'year', 'int', 'number', 'enum', 'listItem']);

/**
 * Write a proposal's values again with one field changed, and read its diff
 * back. Nothing in the bible changes until the proposal is approved (AI-3).
 */
async function editProposed(view: ProposalView, path: string, next: unknown) {
  const data = view.proposal.data as Record<string, unknown>;
  await call('proposal.edit', {
    id: view.proposal._id,
    data: { ...data, ...patchForPath(data, path, next) },
  });
}

/** IP-17: rename the item a list item proposal adds, before approval. */
async function editProposedLabel(view: ProposalView, label: string) {
  await call('proposal.edit', { id: view.proposal._id, data: { label } });
}

/**
 * ED-7: what a proposal would change, field by field, against the entry as it
 * is now. IP-17: a new list item shows as a field ("Community: + Jinan").
 * `edit` makes the proposed side fields while the proposal waits: `label`
 * edits only a new list item's name (the review queue), `values` every
 * simple value too (the capture box). `onEdited` hears each saved edit.
 */
export function ProposalDiff({
  view,
  edit,
  onEdited,
}: {
  view: ProposalView;
  edit?: 'label' | 'values';
  onEdited?: () => Promise<void> | void;
}) {
  const { changes, proposal } = view;
  const c = proposal.collection;
  const manifest = isEntryCollection(c) ? manifests[c] : [];
  const pending = proposal.state === 'pending';
  const editor = (path: string, after: unknown) => {
    if (!edit || !pending) return null;
    if (proposal.op === 'listAdd' && proposal.listAdd) {
      const label = proposal.listAdd.label;
      return (
        <Editable
          kind="text"
          label={`Name of the new item for ${path}`}
          allowEmpty={false}
          value={label}
          testId="proposal-label"
          display={(t) => `+ ${t}`}
          onSave={async (next) => {
            await editProposedLabel(view, next);
            await onEdited?.();
          }}
        />
      );
    }
    if (edit !== 'values' || (proposal.op !== 'create' && proposal.op !== 'update')) return null;
    const spec = specAt(manifest, path);
    if (!spec || !EDITABLE_KINDS.has(spec.kind)) return null;
    return (
      <ProposedValue
        view={view}
        spec={spec}
        path={path}
        label={labelPath(manifest, path)}
        after={after}
        onEdited={onEdited}
      />
    );
  };
  return (
    <>
      {changes.length === 0 ? (
        <p className="example-note">This proposal would change nothing.</p>
      ) : (
        <table className="diff-table" data-testid="proposal-diff">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">Proposed</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((ch) => {
              const field = editor(ch.path, ch.after);
              return (
                <tr key={ch.path} data-path={ch.path}>
                  <th scope="row">{labelPath(manifest, ch.path)}</th>
                  <td>
                    <del>{showValue(ch.before)}</del>
                  </td>
                  <td>{field ?? <ins>{showValue(ch.after)}</ins>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** One proposed value as a field (IP-1, IP-17): saves into the proposal, never the bible. */
function ProposedValue(props: {
  view: ProposalView;
  spec: FieldSpec;
  path: string;
  label: string;
  after: unknown;
  onEdited?: () => Promise<void> | void;
}) {
  const { view, spec, path } = props;
  const list = useList(spec.listId);
  const raw = getPath(view.proposal.data as Record<string, unknown>, path);
  const save = async (next: unknown) => {
    await editProposed(view, path, next);
    await props.onEdited?.();
  };
  const common = {
    label: `Proposed ${props.label}`,
    testId: 'proposed-value',
    'data-field': path,
  };
  switch (spec.kind) {
    case 'text':
      return (
        <Editable
          {...common}
          kind="text"
          value={typeof raw === 'string' ? raw : ''}
          allowEmpty={!spec.required}
          onSave={save}
        />
      );
    case 'longText':
      return (
        <Editable
          {...common}
          kind="rich"
          layout="inline"
          value={typeof raw === 'string' ? raw : ''}
          onSave={save}
        />
      );
    case 'year':
      return (
        <Editable
          {...common}
          kind="year"
          value={typeof raw === 'number' ? raw : null}
          allowEmpty={spec.nullable === true}
          onSave={save}
        />
      );
    case 'int':
    case 'number':
      return (
        <Editable
          {...common}
          kind="number"
          integer={spec.kind === 'int'}
          value={typeof raw === 'number' ? raw : null}
          allowEmpty={spec.nullable === true}
          onSave={save}
        />
      );
    default: {
      // enum and listItem: the choices, with a new item this proposal set adds shown as "+ Name".
      const options =
        spec.kind === 'enum' ? [...(spec.options ?? [])] : listOptions(list).map((o) => ({ ...o }));
      const value = typeof raw === 'string' && raw !== '' ? raw : null;
      if (value && !options.some((o) => o.value === value)) {
        options.push({ value, label: showValue(props.after) });
      }
      return (
        <Editable
          {...common}
          kind="select"
          value={value}
          options={options}
          allowEmpty={spec.nullable === true}
          onSave={save}
        />
      );
    }
  }
}
