/**
 * GL-1, ST-1, IP-8: the romanization system for each language, one select
 * per language that saves on pick as one undo step. "Add new..." on a select
 * adds a system to the Romanization systems list and picks it; the add and
 * the pick are one undo step. The Romanization screen and Settings both draw
 * this; ARCH-6 read-only turns every select off with the reason.
 */
import { useEffect, useId, useState } from 'react';
import type { Response } from '../../../shared/ipc';
import type { UndoCommand } from '../../../shared/domain/undoRunner';
import { romanizationCommand } from '../../../shared/undoCommands';
import { call, plainError } from '../api';
import { useWriteGuard } from '../connection';
import { useStore } from './data';
import { mergeCommands } from './editable';
import { ListSelect } from './listSelect';
import { useUndo } from './undo';
import './vocab.css';
import './romanizationSystems.css';

type Romanization = Response<'romanization.get'>;
type Language = Romanization['languages'][number];

export function RomanizationSystems(props: {
  /** The root's test ID; each select is `<testId>-<language ID>`, a read failure `<testId>-failed`. */
  testId: string;
}) {
  const undo = useUndo();
  const ro = useWriteGuard();
  const { version } = useStore();
  const prefix = useId();
  const [data, setData] = useState<Romanization | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

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

  /** One step, with the system Add new made on the way when it made one (IP-8). */
  const choose = async (l: Language, systemId: string | null, added?: UndoCommand) => {
    setNote(null);
    await undo.flush();
    const from = l.systemId;
    try {
      setData(await call('romanization.set', { languageId: l.id, systemId }));
    } catch (e) {
      // The new system stays in the list, so its add is still a step of its own.
      if (added) undo.record(added);
      setNote({ text: plainError(e), bad: true });
      return;
    }
    const step =
      (from ?? '') !== (systemId ?? '')
        ? romanizationCommand(call, l.label, l.id, from, systemId)
        : null;
    const both = step && added ? mergeCommands(step.label, added, step) : (step ?? added);
    if (both) undo.record(both);
    setNote({ text: `Saved the romanization system for ${l.label}.`, bad: false });
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
            <RomanizationRow
              key={l.id}
              language={l}
              id={`${prefix}-${l.id}`}
              testId={`${props.testId}-${l.id}`}
              disabled={ro.off}
              tip={ro.tip}
              onChange={(systemId, added) => void choose(l, systemId, added)}
            />
          ))}
        </div>
      )}
      {note && (
        <p className={note.bad ? 'callout crit' : 'example-note'} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}

function RomanizationRow(props: {
  language: Language;
  id: string;
  testId: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onChange: (systemId: string | null, added?: UndoCommand) => void;
}) {
  const l = props.language;
  return (
    <>
      <label className="settings-label" htmlFor={props.id}>
        {l.label}
      </label>
      <span className="settings-value roman-value" {...props.tip}>
        <ListSelect
          listId="romanizationSystems"
          id={props.id}
          value={l.systemId ?? ''}
          emptyLabel="No system"
          joinAdd
          disabled={props.disabled}
          testId={props.testId}
          onChange={props.onChange}
        />
        {l.note && (
          <span className="callout roman-note" role="note" data-testid="romanization-no-checker">
            {l.note}
          </span>
        )}
      </span>
    </>
  );
}
