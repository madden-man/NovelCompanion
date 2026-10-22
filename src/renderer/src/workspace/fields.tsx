import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { collectionInfo, entryTitle, isEntryCollection } from '../../../shared/schema';
import type { EntryCollection, FieldSpec } from '../../../shared/schema';
import { blankItem } from '../../../shared/domain/blank';
import { isPlainObject, joinPath } from '../../../shared/domain/paths';
import type { Doc } from '../../../shared/domain/paths';
import { warningsAt } from '../../../shared/domain/warnings';
import type { FieldWarning } from '../../../shared/domain/warnings';
import type { FieldIssue } from '../../../shared/domain/issues';
import { useEntries, useList } from './data';
import { EntryPicker, useLookup } from './pickers';
import { ZhMeaning } from './Zh';
import { RichText } from './richText/RichText';
import { ListSelect } from './listSelect';
import { ZhPreview } from './richText/MarkdownView';

export interface Messages {
  warnings: FieldWarning[];
  issues: FieldIssue[];
}

export interface FieldProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  messages: Messages;
  /** The entry being edited, for fields that depend on another (custom values). */
  root: Doc;
  /** Add a cross-link to the entry, used by `@` in long text (ED-9). */
  onMention: (targetId: string) => void;
  /** SM-1: a long text box that grows with its text. Since A44 every long text box does. */
  grow?: boolean;
}

/** Kinds whose parts are not separate fields, so their messages show on them. */
const OWNS_CHILD_MESSAGES = new Set([
  'refs',
  'refPair',
  'links',
  'tags',
  'strings',
  'listItems',
  'storyDate',
]);

function messagesFor(spec: FieldSpec, path: string, m: Messages) {
  const deep = OWNS_CHILD_MESSAGES.has(spec.kind);
  const match = (p: string) => p === path || (deep && p.startsWith(`${path}.`));
  return {
    warnings: deep ? warningsAt(m.warnings, path) : m.warnings.filter((w) => w.path === path),
    issues: m.issues.filter((i) => match(i.path)),
  };
}

function FieldShell(props: {
  spec: FieldSpec;
  path: string;
  messages: Messages;
  htmlFor?: string;
  /** A44: the label's own ID, for a rich text box that names itself by it. */
  labelId?: string;
  group?: boolean;
  children: ReactNode;
}) {
  const { spec, path, messages, htmlFor, labelId, group, children } = props;
  const mine = messagesFor(spec, path, messages);
  const notes = (
    <>
      {spec.hint && <p className="ed-hint">{spec.hint}</p>}
      {mine.warnings.map((w, i) => (
        <p key={`w${i}`} className="ed-warning" role="note" data-code={w.code}>
          {w.message}
        </p>
      ))}
      {mine.issues.map((issue, i) => (
        <p key={`e${i}`} className="ed-error" role="alert">
          Not saved: {issue.message}
        </p>
      ))}
    </>
  );
  const flagged = mine.warnings.length > 0 ? ' has-warning' : '';
  const errored = mine.issues.length > 0 ? ' has-error' : '';
  if (group) {
    return (
      <fieldset
        className={`ed-field ed-group${flagged}${errored}`}
        data-field={path}
        data-kind={spec.kind}
      >
        <legend className="ed-label">{spec.label}</legend>
        {children}
        {notes}
      </fieldset>
    );
  }
  return (
    <div className={`ed-field${flagged}${errored}`} data-field={path} data-kind={spec.kind}>
      <label
        className="ed-label"
        htmlFor={htmlFor}
        id={labelId}
        onClick={
          labelId
            ? () => document.querySelector<HTMLElement>(`[aria-labelledby="${labelId}"]`)?.focus()
            : undefined
        }
      >
        {spec.label}
      </label>
      {children}
      {notes}
    </div>
  );
}

const asString = (v: unknown) => (typeof v === 'string' ? v : '');
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function parseNumber(text: string, integer: boolean): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}

/** One field of any kind, chosen from the manifest (ED-1). */
export function Field(props: FieldProps) {
  switch (props.spec.kind) {
    case 'text':
      return <TextField {...props} />;
    case 'longText':
      return <LongTextField {...props} />;
    case 'int':
    case 'year':
    case 'number':
      return <NumberField {...props} />;
    case 'storyDate':
      return <StoryDateField {...props} />;
    case 'calendarDate':
      return <CalendarDateField {...props} />;
    case 'boolean':
      return <BooleanField {...props} />;
    case 'enum':
      return <EnumField {...props} />;
    case 'listItem':
      return <ListItemField {...props} />;
    case 'listItems':
      return <ListItemsField {...props} />;
    case 'color':
      return <ColorField {...props} />;
    case 'tags':
      return <StringsField {...props} />;
    case 'strings':
      return <StringsField {...props} />;
    case 'ref':
      return <RefField {...props} />;
    case 'refs':
      return <RefsField {...props} />;
    case 'refPair':
      return <RefPairField {...props} />;
    case 'links':
      return <LinksField {...props} />;
    case 'object':
      return <ObjectField {...props} />;
    case 'objectList':
      return <ObjectListField {...props} />;
    case 'system':
      return null;
  }
}

function TextField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <input
        id={id}
        value={asString(value)}
        onChange={(e) => onChange(spec.nullable && e.target.value === '' ? null : e.target.value)}
      />
      <ZhMeaning text={asString(value)} />
    </FieldShell>
  );
}

/** A44: long text fields that hold a line or two, not pages: their box starts at three lines. */
const NOTE_FIELDS = new Set([
  'role',
  'meaning',
  'usageNote',
  'question',
  'decision',
  'stoppedAt',
  'sourceNote',
  'worldContext',
  'quote',
  'resolutionNote',
  'mustChange',
  'sceneNote',
]);

/** Long text as a rich text box (A44) with an `@` link picker (ED-9). */
function LongTextField({ spec, value, onChange, path, messages, onMention, root }: FieldProps) {
  const labelId = useId();
  const text = asString(value);
  const ids = asArray(root.links)
    .filter(isPlainObject)
    .map((l) => String(l.targetId ?? ''))
    .filter(Boolean);
  const found = useLookup(ids);
  const titles = ids.map((id) => found.get(id)?.title ?? '').filter(Boolean);
  return (
    <FieldShell spec={spec} path={path} messages={messages} labelId={labelId}>
      <RichText
        value={text}
        onChange={onChange}
        labelledBy={labelId}
        size={NOTE_FIELDS.has(spec.name) ? 'notes' : 'prose'}
        onMention={(hit) => onMention(hit.id)}
        mentionTitles={titles}
      />
      <ZhPreview text={text} />
    </FieldShell>
  );
}

function NumberField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step={spec.kind === 'number' ? 'any' : 1}
        className="num"
        value={numText(value)}
        onChange={(e) => onChange(parseNumber(e.target.value, spec.kind !== 'number'))}
      />
    </FieldShell>
  );
}

type DateMode = 'none' | 'unknown' | 'year' | 'full';

function StoryDateField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const d = isPlainObject(value) ? value : null;
  const mode: DateMode = !d
    ? 'none'
    : d.unknown === true
      ? 'unknown'
      : d.month !== undefined
        ? 'full'
        : 'year';
  const setMode = (m: DateMode) => {
    const year = typeof d?.year === 'number' ? d.year : new Date().getFullYear();
    if (m === 'none') onChange(null);
    else if (m === 'unknown') onChange({ unknown: true });
    else if (m === 'year') onChange({ year });
    else onChange({ year, month: typeof d?.month === 'number' ? d.month : 1, day: 1 });
  };
  const part = (key: 'year' | 'month' | 'day', text: string) => {
    const n = parseNumber(text, true);
    const rest = Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => k !== key));
    onChange(n === null ? rest : { ...rest, [key]: n });
  };
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      <div className="row date-row">
        <label className="sub-label" htmlFor={id}>
          Kind of date
          <select id={id} value={mode} onChange={(e) => setMode(e.target.value as DateMode)}>
            {spec.nullable && <option value="none">None</option>}
            <option value="year">A year</option>
            <option value="full">A full date</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        {(mode === 'year' || mode === 'full') && (
          <label className="sub-label">
            Year
            <input
              type="number"
              className="num year-input"
              value={numText(d?.year)}
              onChange={(e) => part('year', e.target.value)}
            />
          </label>
        )}
        {mode === 'full' && (
          <>
            <label className="sub-label">
              Month
              <input
                type="number"
                min={1}
                max={12}
                className="num small-input"
                value={numText(d?.month)}
                onChange={(e) => part('month', e.target.value)}
              />
            </label>
            <label className="sub-label">
              Day
              <input
                type="number"
                min={1}
                max={31}
                className="num small-input"
                value={numText(d?.day)}
                onChange={(e) => part('day', e.target.value)}
              />
            </label>
          </>
        )}
      </div>
    </FieldShell>
  );
}

function CalendarDateField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <input
        id={id}
        type="date"
        value={asString(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

function BooleanField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const mine = messagesFor(spec, path, messages);
  return (
    <div
      className={`ed-field ed-check${mine.warnings.length ? ' has-warning' : ''}`}
      data-field={path}
      data-kind={spec.kind}
    >
      <label className="ed-label check-label" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {spec.label}
      </label>
      {spec.hint && <p className="ed-hint">{spec.hint}</p>}
      {mine.warnings.map((w, i) => (
        <p key={i} className="ed-warning" role="note" data-code={w.code}>
          {w.message}
        </p>
      ))}
    </div>
  );
}

function EnumField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <select
        id={id}
        value={asString(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        {(spec.nullable || value === null || value === undefined) && (
          <option value="">{spec.nullable ? 'None' : 'Choose one'}</option>
        )}
        {(spec.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function ListItemField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const v = asString(value);
  // A47 (IP-8): the list's items in the stored order, with Add new last (a47-vocab).
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <ListSelect
        id={id}
        listId={spec.listId ?? ''}
        value={v}
        emptyLabel={spec.nullable ? 'None' : undefined}
        onChange={onChange}
      />
    </FieldShell>
  );
}

/** A47 (IP-12): a hex colour, picked with the system colour picker. */
function ColorField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <input
        id={id}
        type="color"
        value={asString(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

/** A47 (IP-8): several items of one list, such as regions: chips by label and a select to add. */
function ListItemsField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const items = useList(spec.listId)?.items ?? [];
  const values = asArray(value).map(String);
  const label = (v: string) => items.find((i) => i.id === v)?.label ?? `${v} (not in the list)`;
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {label(v)}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${label(v)} from ${spec.label}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <ListSelect
        id={id}
        listId={spec.listId ?? ''}
        value=""
        emptyLabel="Add one"
        exclude={values}
        onChange={(v) => v && onChange([...values, v])}
      />
    </FieldShell>
  );
}

/** Free strings and tags: chips with a box to add more. */
function StringsField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const listId = useId();
  const [draft, setDraft] = useState('');
  const tags = useList(spec.kind === 'tags' ? 'tags' : undefined);
  const values = asArray(value).map(String);
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    if (!values.includes(t)) onChange([...values, t]);
    setDraft('');
  };
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${v} from ${spec.label}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row add-row">
        <input
          id={id}
          value={draft}
          list={tags ? listId : undefined}
          placeholder={spec.kind === 'tags' ? 'Add a tag' : 'Add one'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn small" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {tags && (
        <datalist id={listId}>
          {tags.items.map((t) => (
            <option key={t.id} value={t.label} />
          ))}
        </datalist>
      )}
    </FieldShell>
  );
}

function targetCollection(spec: FieldSpec): EntryCollection | null {
  const t = spec.target?.[0];
  return t && t !== '*' && isEntryCollection(t) ? t : null;
}

/** Options for a reference select: live entries of the target section. */
function useRefOptions(spec: FieldSpec) {
  const c = targetCollection(spec);
  const entries = useEntries(c ?? 'characters');
  if (!c) return null;
  return entries
    .map((e) => ({ id: e._id, title: entryTitle(e) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function RefSelect(props: {
  id?: string;
  spec: FieldSpec;
  value: string;
  onChange: (id: string | null) => void;
  label: string;
  allowNone: boolean;
}) {
  const options = useRefOptions(props.spec) ?? [];
  const known = options.some((o) => o.id === props.value);
  const found = useLookup(props.value && !known ? [props.value] : []);
  return (
    <select
      id={props.id}
      aria-label={props.id ? undefined : props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{props.allowNone ? 'None' : 'Choose one'}</option>
      {props.value && !known && (
        <option value={props.value}>
          {found.get(props.value)?.title ?? props.value}
          {found.get(props.value)?.inTrash ? ' (in the trash)' : ''}
        </option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.title}
        </option>
      ))}
    </select>
  );
}

function RefField({ spec, value, onChange, path, messages }: FieldProps) {
  const id = useId();
  const v = asString(value);
  const anywhere = targetCollection(spec) === null;
  const found = useLookup(anywhere && v ? [v] : []);
  if (anywhere) {
    return (
      <FieldShell spec={spec} path={path} messages={messages} group>
        <div className="chips">
          {v ? (
            <span className="chip">
              {found.get(v)?.title ?? v}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Clear ${spec.label}`}
                onClick={() => onChange(null)}
              >
                ×
              </button>
            </span>
          ) : (
            <span className="example-note">None</span>
          )}
        </div>
        <EntryPicker
          label={`Find an entry for ${spec.label}`}
          onPick={(picked) => onChange(picked)}
        />
      </FieldShell>
    );
  }
  return (
    <FieldShell spec={spec} path={path} messages={messages} htmlFor={id}>
      <RefSelect
        id={id}
        spec={spec}
        value={v}
        label={spec.label}
        allowNone={Boolean(spec.nullable)}
        onChange={(next) => onChange(next ?? (spec.nullable ? null : ''))}
      />
    </FieldShell>
  );
}

function RefsField({ spec, value, onChange, path, messages }: FieldProps) {
  const ids = asArray(value).map(String);
  const found = useLookup(ids);
  const anywhere = targetCollection(spec) === null;
  const add = (id: string | null) => {
    if (id && !ids.includes(id)) onChange([...ids, id]);
  };
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      <div className="chips">
        {ids.length === 0 && <span className="example-note">None yet</span>}
        {ids.map((id) => (
          <span key={id} className="chip">
            {found.get(id)?.title ?? id}
            {found.get(id)?.inTrash ? ' (in the trash)' : ''}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${found.get(id)?.title ?? id} from ${spec.label}`}
              onClick={() => onChange(ids.filter((x) => x !== id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {anywhere ? (
        <EntryPicker label={`Add to ${spec.label}`} onPick={(id) => add(id)} />
      ) : (
        <RefSelect
          spec={spec}
          value=""
          label={`Add to ${spec.label}`}
          allowNone={false}
          onChange={add}
        />
      )}
    </FieldShell>
  );
}

function RefPairField({ spec, value, onChange, path, messages }: FieldProps) {
  const pair = asArray(value).map((x) => (typeof x === 'string' ? x : ''));
  const set = (i: number, id: string | null) => {
    const next = [pair[0] ?? '', pair[1] ?? ''];
    next[i] = id ?? '';
    onChange(next);
  };
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      <div className="row">
        {[0, 1].map((i) => (
          <RefSelect
            key={i}
            spec={spec}
            value={pair[i] ?? ''}
            label={`${spec.label}, ${i === 0 ? 'first' : 'second'}`}
            allowNone={false}
            onChange={(id) => set(i, id)}
          />
        ))}
      </div>
    </FieldShell>
  );
}

/** Cross-links to any entry (ED-9): chips with their kind, a search to add one. */
function LinksField({ spec, value, onChange, path, messages }: FieldProps) {
  const links = asArray(value).filter(isPlainObject) as { targetId: string; kind: string }[];
  const found = useLookup(links.map((l) => l.targetId));
  const [kind, setKind] = useState('mention');
  const kindId = useId();
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      <div className="chips">
        {links.length === 0 && <span className="example-note">No links yet</span>}
        {links.map((l, i) => {
          const f = found.get(l.targetId);
          return (
            <span key={`${l.targetId}:${l.kind}:${i}`} className="chip link-chip">
              {f ? `${collectionInfo[f.collection].singular}: ${f.title}` : l.targetId}
              <span className="link-kind">{l.kind}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove the link to ${f?.title ?? l.targetId}`}
                onClick={() => onChange(links.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="row add-row">
        <label className="sub-label" htmlFor={kindId}>
          Link kind
          <input
            id={kindId}
            className="kind-input"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          />
        </label>
        <EntryPicker
          label="Find an entry to link"
          onPick={(id) => {
            const k = kind.trim() || 'mention';
            if (!links.some((l) => l.targetId === id && l.kind === k)) {
              onChange([...links, { targetId: id, kind: k }]);
            }
          }}
        />
      </div>
    </FieldShell>
  );
}

function SubFields(props: {
  fields: readonly FieldSpec[];
  value: Doc;
  onChange: (v: Doc) => void;
  path: string;
  messages: Messages;
  root: Doc;
  onMention: (id: string) => void;
}) {
  return (
    <div className="sub-fields">
      {props.fields.map((f) => (
        <Field
          key={f.name}
          spec={f}
          value={props.value[f.name]}
          path={joinPath(props.path, f.name)}
          messages={props.messages}
          root={props.root}
          onMention={props.onMention}
          onChange={(v) => props.onChange({ ...props.value, [f.name]: v })}
        />
      ))}
    </div>
  );
}

function ObjectField(props: FieldProps) {
  const { spec, value, onChange, path, messages } = props;
  const doc = isPlainObject(value) ? value : {};
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      <SubFields
        fields={spec.fields ?? []}
        value={doc}
        onChange={onChange}
        path={path}
        messages={messages}
        root={props.root}
        onMention={props.onMention}
      />
    </FieldShell>
  );
}

function ObjectListField(props: FieldProps) {
  const { spec, value, onChange, path, messages } = props;
  const items = asArray(value).filter(isPlainObject);
  const min = spec.minItems ?? 0;
  const move = (i: number, by: number) => {
    const next = [...items];
    const moved = next.splice(i, 1);
    next.splice(i + by, 0, ...moved);
    onChange(next);
  };
  const itemName = (item: Doc, i: number) => {
    const raw = spec.itemLabel ? item[spec.itemLabel] : '';
    const text = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
    return text
      ? `${i + 1}. ${text.length > 40 ? `${text.slice(0, 40)}...` : text}`
      : `Item ${i + 1}`;
  };
  return (
    <FieldShell spec={spec} path={path} messages={messages} group>
      {items.length === 0 && <p className="example-note">None yet</p>}
      <ol className="item-list">
        {items.map((item, i) => (
          <li key={i} className="item-card" data-item={i}>
            <div className="item-head">
              <span className="item-name">{itemName(item, i)}</span>
              <div className="row">
                <button
                  type="button"
                  className="btn small"
                  disabled={i === 0}
                  aria-label={`Move ${itemName(item, i)} up`}
                  onClick={() => move(i, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={i === items.length - 1}
                  aria-label={`Move ${itemName(item, i)} down`}
                  onClick={() => move(i, 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={items.length <= min}
                  aria-label={`Remove ${itemName(item, i)} from ${spec.label}`}
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            </div>
            <SubFields
              fields={spec.fields ?? []}
              value={item}
              path={joinPath(path, i)}
              messages={messages}
              root={props.root}
              onMention={props.onMention}
              onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
            />
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn small"
        onClick={() => onChange([...items, blankItem(spec.fields ?? [])])}
      >
        Add to {spec.label}
      </button>
    </FieldShell>
  );
}
