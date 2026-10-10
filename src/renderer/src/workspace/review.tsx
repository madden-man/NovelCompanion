import { useEffect, useState } from 'react';
import { collectionInfo, manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { ProposalView } from '../../../shared/ipc';
import { labelPath } from '../../../shared/domain/issues';
import { call, plainError } from '../api';
import { useStore } from './data';
import type { Entry } from './data';
import { Field } from './fields';
import { formatTime } from './format';
import { showValue } from './history';

const OP_TEXT = { create: 'Create', update: 'Change', delete: 'Move to trash' } as const;
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
                  {OP_TEXT[v.proposal.op]}{' '}
                  {collectionInfo[v.proposal.collection as EntryCollection].singular.toLowerCase()}{' '}
                  {v.targetTitle ?? ''}
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
  const { proposal, changes, conflict, targetTitle } = view;
  const collection = proposal.collection as EntryCollection;
  const manifest = manifests[collection];
  const [editing, setEditing] = useState<Entry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const title = `${OP_TEXT[proposal.op]} ${collectionInfo[collection].singular.toLowerCase()}${targetTitle ? ` ${targetTitle}` : ''}`;

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
            onClick={() => void act(() => call('proposal.refresh', { id: proposal._id }))}
          >
            Compare again
          </button>
        </div>
      )}
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
            {changes.map((c) => (
              <tr key={c.path}>
                <th scope="row">{labelPath(manifest, c.path)}</th>
                <td>
                  <del>{showValue(c.before)}</del>
                </td>
                <td>
                  <ins>{showValue(c.after)}</ins>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        {proposal.op !== 'delete' && !editing && (
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
      {message && (
        <p className="callout crit" role="alert">
          {message}
        </p>
      )}
    </article>
  );
}
