/** IP-1: the editing primitive and its helpers. Screens import from here. */
export { Editable, SAVED_TICK_MS } from './Editable';
export type {
  EditableCommonProps,
  EditableKindProps,
  EditableNote,
  EditableProps,
  SaveState,
} from './Editable';
export {
  EditableError,
  EntryEditable,
  entryOptions,
  listOptions,
  saveEntryField,
  useEditableSave,
  useEntryAddNew,
  useEntryDoc,
  useListAddNew,
  valueCommand,
} from './helpers';
export type { EntryEditableProps, SaveEntryFieldOptions } from './helpers';
export {
  ADD_NEW_LABEL,
  addNewReducer,
  chipChoices,
  fieldLabel,
  mergeCommands,
  parseDate,
  parseNumber,
  parseText,
  parseYear,
  patchForPath,
  shownText,
} from './model';
export type {
  AddNewAction,
  AddNewState,
  AddedItem,
  EditableKind,
  EditableOption,
  EditableValues,
  SaveInfo,
} from './model';
