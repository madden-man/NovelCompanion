/**
 * GL-1, ST-1, IP-1, IP-8: the romanization system for each language, one
 * `Editable` select per language that saves on pick as one undo step. "Add
 * new..." adds a system to the Romanization systems list and picks it; the
 * add and the pick are one undo step. The Romanization screen and Settings
 * both draw this; under ARCH-6 read-only each field stays text with the reason.
 */
import { Fragment, useEffect, useState } from 'react';
import type { Response } from '../../../shared/ipc';
import { romanizationCommand } from '../../../shared/undoCommands';
import { call, plainError } from '../api';
import { useReadOnly } from '../connection';
import { useList, useStore } from './data';
import { Editable, listOptions, mergeCommands, useListAddNew } from './editable';
import type { SaveInfo } from './editable';
import { useUndo } from './undo';
import './vocab.css';
import './romanizationSystems.css';

type Romanization = Response<'romanization.get'>;
type Language = Romanization['languages'][number];

export function RomanizationSystems(props: {
  /** The root's test ID; each field is `<testId>-<language ID>`, a read failure `<testId>-failed`. */
  testId: string;
}) {
  const undo = useUndo();
  // ARCH-6: Editable keeps each field shut with this reason as its title.
  const readOnly = useReadOnly();
  const { version } = useStore();
  const options = listOptions(useList('romanizationSystems'));
  const addNew = useListAddNew('romanizationSystems');
  const [data, setData] = useState<Romanization | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call('romanization.get', {}).then(
      (r) => {
        if (!live) return;
        setData(r);
        setFailed(null);
      },
      (e: unknown) => {
        if (live) setFailed(plainError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  /**
   * One step, with the system Add new made on the way when it made one (IP-8).
   * A failed save throws, so the field shows "Not saved" and keeps the item for
   * a second Enter; the add alone is not recorded.
   */
  const save = async (l: Language, systemId: string | null, info: SaveInfo) => {
    setNote(null);
    await undo.flush();
    const from = l.systemId;
    setData(await call('romanization.set', { languageId: l.id, systemId }));
    const step =
      (from ?? '') !== (systemId ?? '')
        ? romanizationCommand(call, l.label, l.id, from, systemId)
        : null;
    const added = info.added?.command;
    const both = step && added ? mergeCommands(step.label, added, step) : (step ?? added);
    if (both) undo.record(both);
    setNote(`Saved the romanization system for ${l.label}.`);
  };

  if (!data && failed) {
    return (
      <p className="callout crit" role="alert" data-testid={`${props.testId}-failed`}>
        The romanization systems could not be read. {failed}
      </p>
    );
  }
  if (!data) return <p>Loading the romanization systems.</p>;
  return (
    <div className="stack tight roman-systems" data-testid={props.testId}>
      {data.languages.length === 0 && (
        <p>The Languages list is empty. Add a language under Lists.</p>
      )}
      {data.languages.length > 0 && (
        <div className="settings-grid">
          {data.languages.map((l) => (
            <Fragment key={l.id}>
              <span className="settings-label" aria-hidden="true">
                {l.label}
              </span>
              <span className="settings-value">
                <Editable
                  kind="select"
                  label={`Romanization system for ${l.label}`}
                  value={l.systemId}
                  options={options}
                  allowEmpty
                  emptyLabel="No system"
                  placeholder="No system"
                  onAddNew={addNew}
                  disabled={readOnly !== null}
                  reason={readOnly ?? undefined}
                  testId={`${props.testId}-${l.id}`}
                  onSave={(next, info) => save(l, next, info)}
                />
                {l.note && (
                  <span
                    className="callout roman-note"
                    role="note"
                    data-testid="romanization-no-checker"
                  >
                    {l.note}
                  </span>
                )}
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {note && (
        <p className="example-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
