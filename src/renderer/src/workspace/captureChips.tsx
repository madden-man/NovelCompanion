/**
 * One fact of a capture in the box (A48, CR-6, CR-9): its chips in one row
 * under the title, the cue labels that placed it, and, for a fact the box
 * files itself (Route A), its tick and its drafts as the ED-7 diff. A chip is
 * an `Editable` select or year field (A47); a change re-routes the fact. A
 * required field the router could not fill is a highlighted chip, and the
 * card cannot be ticked until it is filled. A fact sent to Claude shows its
 * chips read-only, as the hints that went with the text. Nothing here writes
 * to the bible. A57: no sentence says what a control does; with no key the
 * Claude buttons become Add a Claude key, which opens `ClaudeKeyField`.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClaudeStatusWire } from '../../../shared/claude';
import type { WireList } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { collectionInfo, isEntryCollection, manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { FieldSpec } from '../../../shared/schema/manifest';
import { CAPTURE_SECTIONS, LEXICON, WRITING_STRAND } from '../../../shared/domain/captureRouter';
import type {
  CaptureDraft,
  CaptureFact,
  CaptureHint,
  RouterIndex,
} from '../../../shared/domain/captureRouter';
import { Editable, fieldLabel } from './editable';
import type { EditableOption } from './editable';
import { showValue } from './showValue';
import { TYPED_ASKS, draftsWith, openAsks } from './captureLocal';
import type { FactChoice } from './captureLocal';

/** Where a fact stands in the box. */
export type FactStand =
  /** Route A: the box files it. */
  | 'local'
  /** Re-routed by a chip to Route B or C, not sent yet. */
  | 'unsent'
  /** Sent to Claude with the text. */
  | 'sent'
  /** KB-7 with no key: saved with the other sentences that need Claude as an open question. */
  | 'question';

const ROUTE_WORDS = {
  fast: 'fast file',
  full: 'full capture',
} as const;

/** "New cultural entry Teenagers in Guangzhou ..." from the fact's first new entry. */
export function factTitle(fact: CaptureFact, drafts: readonly CaptureDraft[]): string {
  const made = drafts.find((d) => d.op === 'create');
  const c = made?.collection;
  if (!made || !c || !isEntryCollection(c)) return fact.text;
  const data = made.data ?? {};
  const name =
    typeof data.title === 'string' && data.title.trim() ? data.title : 'with no name yet';
  return `New ${collectionInfo[c].singular.toLowerCase()} ${name}`;
}

/** The draft value as the writer reads it: list items and entries by name, new items with a plus. */
function shownDraftValue(
  spec: FieldSpec | undefined,
  value: unknown,
  lists: readonly WireList[],
  index: RouterIndex,
  drafts: readonly CaptureDraft[],
): string {
  const itemLabel = (listId: string | undefined, id: unknown) => {
    if (typeof id !== 'string') return showValue(id);
    const fresh = drafts.find((d) => d.op === 'listAdd' && d.ref === id);
    if (fresh?.label) return `+ ${fresh.label}`;
    const item = lists.find((l) => l._id === listId)?.items.find((i) => i.id === id);
    return item?.label ?? id;
  };
  if (spec?.kind === 'listItem') return itemLabel(spec.listId, value);
  if (spec?.kind === 'listItems' && Array.isArray(value)) {
    return value.length ? value.map((v) => itemLabel(spec.listId, v)).join('; ') : 'None';
  }
  if (spec?.kind === 'ref' && typeof value === 'string') {
    return (
      index.characters.find((c) => c.id === value)?.name ??
      index.places.find((p) => p.id === value)?.name ??
      value
    );
  }
  return showValue(value);
}

/**
 * The drafts of a Route A fact as the ED-7 table: Field, Now, Proposed. Every
 * row is a new value, so Now reads "Not set" as it does for a created entry
 * in the review queue.
 */
export function DraftDiff(props: {
  drafts: readonly CaptureDraft[];
  lists: readonly WireList[];
  index: RouterIndex;
}) {
  const { drafts, lists, index } = props;
  const rows: { key: string; field: string; value: string }[] = [];
  for (const [i, d] of drafts.entries()) {
    if (d.op === 'listAdd') {
      const list = lists.find((l) => l._id === d.listId);
      rows.push({
        key: `${i}:item`,
        field: `New item in ${list?.label ?? d.listId ?? 'a list'}`,
        value: `+ ${d.label ?? ''}`,
      });
      continue;
    }
    const c = d.collection;
    if (d.op !== 'create' || !c || !isEntryCollection(c)) continue;
    const manifest = manifests[c as EntryCollection];
    for (const [path, value] of Object.entries(d.data ?? {})) {
      if (value === '' || value === undefined) continue;
      const spec = manifest.find((s) => s.name === path);
      rows.push({
        key: `${i}:${path}`,
        field: fieldLabel(c as EntryCollection, path),
        value: shownDraftValue(spec, value, lists, index, drafts),
      });
    }
  }
  return (
    <table className="diff-table" data-testid="draft-diff">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Now</th>
          <th scope="col">Proposed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-path={r.key.split(':')[1]}>
            <th scope="row">{r.field}</th>
            <td>
              <del>Not set</del>
            </td>
            <td>
              <ins>{r.value}</ins>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One chip: its label, and the field that changes it. Highlighted while it is needed. */
function Chip(props: { label: string; needed?: boolean; testId: string; children: ReactNode }) {
  return (
    <span
      className={`capture-chip${props.needed ? ' is-needed' : ''}`}
      data-testid={props.testId}
      data-needed={props.needed ? 'true' : undefined}
    >
      <span className="capture-chip-label">
        {props.label}
        {props.needed ? ' (needed)' : ''}
      </span>
      {props.children}
    </span>
  );
}

const SECTION_OPTIONS: EditableOption[] = CAPTURE_SECTIONS.map((s) => ({
  value: s,
  label: LEXICON.sectionLabels[s],
}));

/** The value the draft holds at a field, or null. */
function draftValue(drafts: readonly CaptureDraft[], field: string): string | null {
  const made = drafts.find((d) => d.op === 'create');
  const v = made?.data?.[field];
  return typeof v === 'string' ? v : null;
}

/** The chips of a fact: Section always, then the section's own (CR-6). */
function Chips(props: {
  fact: CaptureFact;
  choice: FactChoice;
  drafts: readonly CaptureDraft[];
  lists: readonly WireList[];
  index: RouterIndex;
  /** Read-only once the fact is sent or saved; the route line says which. */
  locked: boolean;
  onChoose(patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> }): void;
}) {
  const { fact, choice, drafts, lists, index } = props;
  const open = openAsks(fact, choice);
  const off = props.locked;
  // A chip changes no stored value, so it shows no saved tick (quiet).
  const common = {
    disabled: off,
    layout: 'inline' as const,
    quiet: true,
  };
  const listOpts = (listId: string): EditableOption[] =>
    (lists.find((l) => l._id === listId)?.items ?? []).map((i) => ({
      value: i.id,
      label: i.label,
    }));
  // The writing strand's guess is offered first, never filled in (CR-3).
  const strand = fact.communities.find((c) => c.why === WRITING_STRAND)?.id;
  const communityOpts = listOpts('communities').sort(
    (a, b) => Number(b.value === strand) - Number(a.value === strand),
  );
  const s = fact.section;
  const chips: ReactNode[] = [
    <Chip key="section" label="Section" testId="chip-section">
      <Editable
        {...common}
        kind="select"
        label="Section"
        value={s}
        options={SECTION_OPTIONS}
        testId="chip-section-field"
        onSave={async (v) => {
          if (v) props.onChoose({ hint: { section: v as CaptureFact['section'] } });
        }}
      />
    </Chip>,
  ];
  const community = (
    <Chip
      key="community"
      label="Community"
      needed={open.includes('Community')}
      testId="chip-community"
    >
      <Editable
        {...common}
        kind="select"
        label="Community"
        value={draftValue(drafts, 'communityId')}
        options={communityOpts}
        placeholder="Not set"
        testId="chip-community-field"
        onSave={async (v) => {
          if (v) props.onChoose({ hint: { communityId: v } });
        }}
      />
    </Chip>
  );
  // A56 (FN-2): a year the tray will not guess shows empty and highlighted until picked.
  const yearNeeded = open.includes('Year');
  const year = (label: string) => (
    <Chip key="year" label={label} needed={yearNeeded} testId="chip-year">
      <Editable
        {...common}
        kind="year"
        label={label}
        value={yearNeeded ? null : fact.years.start}
        placeholder={yearNeeded ? 'Not set' : undefined}
        testId="chip-year-field"
        onSave={async (v) => {
          if (v !== null) props.onChoose({ hint: { startYear: v } });
        }}
      />
    </Chip>
  );
  if (s === 'culturalEntries') {
    chips.push(
      community,
      <Chip key="age" label="Age group" testId="chip-age">
        <Editable
          {...common}
          kind="select"
          label="Age group"
          value={draftValue(drafts, 'demographic')}
          options={listOpts('ageGroups')}
          testId="chip-age-field"
          onSave={async (v) => {
            if (v) props.onChoose({ hint: { demographic: v } });
          }}
        />
      </Chip>,
      year('From'),
      <Chip key="end" label="Until" testId="chip-end">
        <Editable
          {...common}
          kind="year"
          label="Until"
          value={fact.years.end}
          allowEmpty
          placeholder={`Open (${index.timelineEnd})`}
          testId="chip-end-field"
          onSave={async (v) => props.onChoose({ hint: { endYear: v } })}
        />
      </Chip>,
    );
  } else if (s === 'moments') {
    chips.push(
      <Chip
        key="character"
        label="Character"
        needed={open.includes('Character')}
        testId="chip-character"
      >
        <Editable
          {...common}
          kind="select"
          label="Character"
          value={draftValue(drafts, 'characterId')}
          options={index.characters
            .map((c) => ({ value: c.id, label: c.name }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          placeholder="Not set"
          testId="chip-character-field"
          onSave={async (v) => {
            if (v) props.onChoose({ hint: { characterId: v } });
          }}
        />
      </Chip>,
      year('Year'),
    );
  } else if (s === 'worldEvents') {
    chips.push(
      <Chip key="category" label="Category" testId="chip-category">
        <Editable
          {...common}
          kind="select"
          label="Category"
          value={draftValue(drafts, 'categoryId')}
          options={listOpts('eventCategories')}
          placeholder="Not set"
          testId="chip-category-field"
          onSave={async (v) => {
            if (v) props.onChoose({ hint: { categoryId: v } });
          }}
        />
      </Chip>,
      year('Year'),
    );
  } else if (s === 'places') {
    chips.push(community);
  }
  for (const ask of fact.asks) {
    const typed = TYPED_ASKS[ask];
    if (!typed) continue;
    const path = typed.key;
    chips.push(
      <Chip key={ask} label={typed.label} needed={open.includes(ask)} testId="chip-name">
        <Editable
          {...common}
          kind="text"
          label={typed.label}
          value={choice.typed[path] ?? ''}
          placeholder={typed.label}
          testId="chip-name-field"
          onSave={async (v) => props.onChoose({ typed: { [path]: v } })}
        />
      </Chip>,
    );
  }
  return (
    <div className="capture-chips" role="group" aria-label="Where it goes">
      {chips}
    </div>
  );
}

/**
 * One fact's card. `children` are the Claude runs that handle it (their
 * streamed text and proposal cards), drawn under its chips.
 */
export function FactCard(props: {
  fact: CaptureFact;
  choice: FactChoice;
  stand: FactStand;
  /** The route the fact went to Claude on, once sent. */
  sentRoute?: 'fast' | 'full';
  ticked: boolean;
  first: boolean;
  lists: readonly WireList[];
  index: RouterIndex;
  busy: boolean;
  /** The fact cannot go to Claude now (read-only, not confirmed, a year to pick). */
  claudeOff: boolean;
  /** A57: no key is set; the Claude buttons give way to Add a Claude key. */
  keyMissing?: boolean;
  onAddKey?: () => void;
  onTick(ticked: boolean): void;
  onChoose(patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> }): void;
  onAskClaude(): void;
  onSend(): void;
  /** A56 (FN-4): the tray's Dismiss; the capture box has none. */
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const { fact, choice, stand } = props;
  const id = useId();
  const drafts = draftsWith(fact, choice);
  const open = openAsks(fact, choice);
  const waiting = stand === 'local' && open.length > 0;
  const cues = fact.cues[fact.section] ?? [];
  // A sent or saved fact's chips are read-only; the route line says which.
  const locked = stand === 'sent' || stand === 'question';
  const where =
    stand === 'local'
      ? 'Files here, without Claude.'
      : stand === 'sent'
        ? `Sent to Claude, ${ROUTE_WORDS[props.sentRoute ?? 'full']}.`
        : stand === 'question'
          ? 'Needs Claude and no key is set, so it was saved as an open question.'
          : `Needs Claude, ${ROUTE_WORDS[fact.route === 'fast' ? 'fast' : 'full']}: ${fact.reasons.join('; ') || 'the section is not clear'}.`;
  return (
    <article
      className={`capture-fact${waiting ? ' is-waiting' : ''}`}
      aria-labelledby={id}
      data-testid="capture-fact"
      data-route={stand === 'sent' ? props.sentRoute : fact.route}
      data-stand={stand}
    >
      {stand === 'local' ? (
        <label className="capture-card-head">
          <input
            type="checkbox"
            checked={props.ticked && !waiting}
            disabled={waiting || props.busy}
            onChange={(e) => props.onTick(e.target.checked)}
            data-focus-first={props.first ? '' : undefined}
            data-testid="capture-fact-tick"
          />
          <span id={id}>{factTitle(fact, drafts)}</span>
        </label>
      ) : (
        <p className="capture-card-head" id={id}>
          {fact.text}
        </p>
      )}
      <Chips
        fact={fact}
        choice={choice}
        drafts={drafts}
        lists={props.lists}
        index={props.index}
        locked={locked}
        onChoose={props.onChoose}
      />
      <p className="capture-cues" data-testid="capture-route">
        {where}
        {cues.length ? ` Placed by: ${cues.join(', ')}.` : ''}
      </p>
      {stand === 'local' && <DraftDiff drafts={drafts} lists={props.lists} index={props.index} />}
      {(stand === 'local' || stand === 'unsent') && (
        <div className="row capture-fact-actions">
          {props.keyMissing && props.onAddKey ? (
            <button
              type="button"
              className="btn small"
              disabled={props.busy}
              onClick={props.onAddKey}
              data-testid="capture-add-key"
            >
              Add a Claude key
            </button>
          ) : (
            <>
              {stand === 'unsent' && (
                <button
                  type="button"
                  className="btn small"
                  disabled={props.busy || props.claudeOff || props.keyMissing}
                  onClick={props.onSend}
                  data-testid="capture-send-fact"
                >
                  Send to Claude
                </button>
              )}
              <button
                type="button"
                className="btn small"
                disabled={props.busy || props.claudeOff || props.keyMissing}
                onClick={props.onAskClaude}
                data-testid="capture-ask-claude"
              >
                Ask Claude instead
              </button>
            </>
          )}
          {props.onDismiss && (
            <button
              type="button"
              className="btn small"
              disabled={props.busy}
              onClick={props.onDismiss}
              data-testid="tray-dismiss"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {props.children}
    </article>
  );
}

/**
 * A57: the Anthropic key field in place, opened by Add a Claude key in the
 * capture box or the tray, so a missing key is fixed where it is missed. It
 * saves through `claude.setKey` as Settings does; a refused key says why.
 */
export function ClaudeKeyField(props: {
  onSaved(status: ClaudeStatusWire): void;
  onCancel(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => input.current?.focus(), []);
  const save = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call('claude.setKey', { key: draft.trim() });
      if (res.ok) props.onSaved(res.status);
      else setError(res.message);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="capture-key stack tight"
      data-testid="capture-key-field"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Escape closes the field, not the box around it.
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <label htmlFor={id}>Anthropic key</label>
      <div className="row tight">
        <input
          ref={input}
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk-ant-…"
          data-testid="capture-key-input"
        />
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !draft.trim()}
          data-testid="capture-key-save"
        >
          Save
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
