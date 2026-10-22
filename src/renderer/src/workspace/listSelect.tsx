/**
 * A47 (IP-8): a select over a list's items for a form that saves later (a new
 * entry, an autosaving editor box, an import's fixed values). "Add new..." is
 * its last choice: picking it puts a name box in the select's place, Enter
 * adds the item to the list (one undo step) and picks it, Escape puts the
 * select back. A value the list no longer holds stays shown as it is.
 *
 * A stored value that saves on pick uses `Editable` with `onAddNew` instead.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { itemPath } from '../../../shared/domain/lists';
import { plainError } from '../api';
import { useReadOnly } from '../connection';
import { useList } from './data';
import { useUndo } from './undo';
import { ADD_NEW_LABEL, useListAddNew } from './editable';
import type { EditableOption } from './editable';
import type { UndoCommand } from '../../../shared/domain/undoRunner';

const ADD = '\u0000add-new';

/** The items of a list as choices in the stored order, a hierarchical one by path. */
export function useListChoices(listId: string): EditableOption[] {
  const list = useList(listId);
  if (!list) return [];
  const doc = { _id: list._id, label: list.label, items: list.items };
  const nested = list.items.some((i) => i.parentId);
  return list.items.map((i) => ({ value: i.id, label: nested ? itemPath(doc, i.id) : i.label }));
}

export function ListSelect(props: {
  listId: string;
  value: string;
  /**
   * The pick. With `joinAdd`, a pick Add new made also passes the add's undo
   * command, for a caller that saves at once to record with its write as one step.
   */
  onChange: (value: string | null, added?: UndoCommand) => void;
  /** The caller saves on pick and records the add with it (IP-8): one step, not two. */
  joinAdd?: boolean;
  /** The select's own ID, for a label outside it. */
  id?: string;
  'aria-label'?: string;
  /** Offer a blank choice with this text ("None", "Any status"). */
  emptyLabel?: string;
  /** The parent a new item is added under. */
  parentId?: string | null;
  /** Choices to leave out, such as the items already picked. */
  exclude?: readonly string[];
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const list = useList(props.listId);
  const choices = useListChoices(props.listId);
  const undo = useUndo();
  const readOnly = useReadOnly();
  const addNew = useListAddNew(props.listId, props.parentId ?? null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const backToSelect = useRef(false);
  const nameId = useId();
  const errorId = useId();
  const listLabel = list?.label ?? props.listId;

  useEffect(() => {
    if (naming) boxRef.current?.focus();
    else if (backToSelect.current) {
      backToSelect.current = false;
      selectRef.current?.focus();
    }
  }, [naming]);

  const close = () => {
    backToSelect.current = true;
    setNaming(false);
    setName('');
    setError(null);
  };

  const add = async () => {
    const label = name.trim();
    if (!label) {
      setError(`A new item for ${listLabel} needs a name.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const made = await addNew(label);
      if (made.command && !props.joinAdd) undo.record(made.command);
      props.onChange(made.id, props.joinAdd ? made.command : undefined);
      close();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  if (naming) {
    return (
      <span
        className="list-select-new"
        data-testid={props.testId ? `${props.testId}-new` : undefined}
      >
        <label className="sr-only" htmlFor={nameId}>
          Name of the new item for {listLabel}
        </label>
        <input
          ref={boxRef}
          id={nameId}
          value={name}
          disabled={busy}
          placeholder={`New item for ${listLabel}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        <button type="button" className="btn small" disabled={busy} onClick={() => void add()}>
          Add to {listLabel}
        </button>
        <button type="button" className="btn small" onClick={close}>
          Cancel
        </button>
        {error && (
          <span id={errorId} className="ed-error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  const exclude = new Set(props.exclude ?? []);
  const known = choices.some((c) => c.value === props.value);
  return (
    <select
      ref={selectRef}
      id={props.id}
      aria-label={props.id ? undefined : props['aria-label']}
      className={props.className}
      value={props.value}
      disabled={props.disabled}
      data-testid={props.testId}
      onChange={(e) => {
        if (e.target.value === ADD) {
          setNaming(true);
          return;
        }
        props.onChange(e.target.value === '' ? null : e.target.value);
      }}
    >
      {(props.emptyLabel !== undefined || !props.value) && (
        <option value="">{props.emptyLabel ?? 'Choose one'}</option>
      )}
      {props.value && !known && (
        <option value={props.value}>{props.value} (not in the list)</option>
      )}
      {choices
        .filter((c) => !exclude.has(c.value))
        .map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      {!readOnly && <option value={ADD}>{ADD_NEW_LABEL}</option>}
    </select>
  );
}
