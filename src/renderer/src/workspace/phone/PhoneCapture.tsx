import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { WireList } from '../../../../shared/ipc';
import { collectionInfo } from '../../../../shared/schema';
import { fileLocalDrafts } from '../../../../shared/domain/capture';
import type { FiledEntry } from '../../../../shared/domain/capture';
import { newNestedId } from '../../../../shared/domain/blank';
import { CAPTURE_SECTIONS, LEXICON, WRITING_STRAND } from '../../../../shared/domain/captureRouter';
import type {
  CaptureDraft,
  CaptureFact,
  CaptureHint,
  RouterIndex,
} from '../../../../shared/domain/captureRouter';
import type { Op, UndoCommand } from '../../../../shared/domain/undoRunner';
import type { WaitingInput, WaitingLineWire } from '../../../../shared/phoneWaits';
import type { StoryTimeValue } from '../../../../shared/storyTime';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useBibleSettings } from '../bibleSettings';
import { captureNav, onCapturePrefill, routeTyped, routingKey, useCaptureOpen } from '../capture';
import type { EditMark, EditMarks } from '../capture';
import { DraftDiff, factTitle } from '../captureChips';
import {
  CAPTURE_MAX_FACTS,
  CAPTURE_TOO_MANY_FACTS,
  NO_CHOICE,
  TYPED_ASKS,
  draftsWith,
  loadCaptureBible,
  openAsks,
} from '../captureLocal';
import type { CaptureBible, FactChoice } from '../captureLocal';
import { useStore } from '../data';
import { RichText } from '../richText/RichText';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { useWorkspaceOpen } from '../Zh';
import { usePhoneNav } from './nav';
import type { PhoneNav } from './nav';
import { PhoneSheet } from './Sheet';
import '../capture.css';
import './capture.css';

/**
 * A58 U5 (PH-26, PH-27, PH-28, PH-36): capture on the phone. The + opens it
 * as a page over the current tab with the field focused, so the keyboard is
 * up, and the story year it files under in its head. As the sentence is
 * typed the Capture Router places it as the desk's box does (CR-6): a Route A
 * fact shows its chips as thumb-sized buttons that open their pickers as
 * sheets, and the diff of what it files. A fact the router cannot file
 * without Claude is never sent anywhere: the same press keeps it for the
 * desk (`capture.wait`), where the From the notebook tray offers it as a
 * card, and it shows here as waiting until the desk handles it or it is
 * taken back. Filing and keeping are one undo step. No Claude control, no
 * line that says how.
 */

/** A57: how long the typing rests before the router places the sentences (as on the desk). */
const ROUTE_PAUSE_MS = 300;

const FIELD = '.ph-page:not([hidden]) [data-testid="phone-capture-input"]';

function focusField(): void {
  document.querySelector<HTMLElement>(FIELD)?.focus({ preventScroll: true });
}

const isCapture = (nav: PhoneNav) => nav.top?.kind === 'screen' && nav.top.screen === 'capture';

/**
 * The +: the capture page over the current tab, its field focused inside the
 * tap itself so iOS raises the keyboard.
 */
export function openPhoneCapture(nav: PhoneNav): void {
  if (!isCapture(nav)) flushSync(() => nav.push({ kind: 'screen', screen: 'capture' }));
  focusField();
}

/** A prefill that came before the page was there ("Cultural context for Pacific States, 2055: "). */
let pendingPrefill: string | null = null;

/**
 * Mounted in the phone's frame in place of the desk's box: anything that asks
 * for the box (`captureNav.open`, with or without a prefill) opens the page.
 */
export function PhoneCaptureBridge() {
  const nav = usePhoneNav();
  const asked = useCaptureOpen();
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  useEffect(
    () =>
      onCapturePrefill((t) => {
        pendingPrefill = t;
      }),
    [],
  );
  useEffect(() => {
    if (!asked) return;
    captureNav.close();
    openPhoneCapture(navRef.current);
  }, [asked]);
  return null;
}

/** The waiting lines the undo steps change, for the page to show at once. */
const waitingListeners = new Set<(lines: WaitingLineWire[]) => void>();
const publishWaiting = (lines: WaitingLineWire[]) => {
  for (const l of waitingListeners) l(lines);
};

/** PH-28: an undo or redo half that keeps sentences again, as they were. */
function keepOp(lines: WaitingInput[]): Op {
  return {
    kind: 'run',
    apply: async () => publishWaiting((await call('capture.wait', { lines })).lines),
    check: async () => null,
  };
}

/** PH-28: an undo or redo half that takes sentences back, refused once the desk has handled one. */
function takeBackOp(ids: string[]): Op {
  return {
    kind: 'run',
    apply: async () => publishWaiting((await call('capture.takeBack', { ids })).lines),
    check: async () => {
      const { lines } = await call('capture.waiting', {});
      return lines.some((l) => ids.includes(l.id) && l.handled)
        ? 'The Mac has already handled this sentence.'
        : null;
    },
  };
}

/** "Filed 2, 1 waiting for the Mac", for the press and the toast. */
function pressLabel(file: number, keep: number): string {
  if (file && keep) return `File ${file}, keep ${keep} for the Mac`;
  if (keep) return `Keep ${keep} for the Mac`;
  return file ? `File ${file}` : 'File';
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text);

/** PH-27, PH-28: the capture page. */
export function PhoneCaptureScreen() {
  const settings = useBibleSettings();
  const { lists, version } = useStore();
  const story = useStoryTime();
  const undo = useUndo();
  const ro = useWriteGuard();
  const nav = usePhoneNav();
  const open = useWorkspaceOpen();
  const time: StoryTimeValue = story.time ?? { year: story.year };
  const year = time.year;
  const timeKey = JSON.stringify(time);

  const [text, setText] = useState(() => {
    const t = pendingPrefill ?? '';
    pendingPrefill = null;
    return t;
  });
  const [quietText, setQuietText] = useState(text);
  const [marks, setMarks] = useState<EditMarks>({});
  const [bible, setBible] = useState<CaptureBible | null>(null);
  const [waiting, setWaiting] = useState<WaitingLineWire[] | null>(null);
  const [filed, setFiled] = useState<FiledEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The chip whose picker sheet is open. */
  const [picking, setPicking] = useState<Picking | null>(null);
  /** Bumped by a change made elsewhere, so the waiting list is read again. */
  const [reread, setReread] = useState(0);

  // A prefill while the page is open lands in an empty field.
  useEffect(
    () =>
      onCapturePrefill((t) => {
        pendingPrefill = null;
        setText((cur) => cur || t);
      }),
    [],
  );

  // A57: the router runs on a pause in the typing; an emptied field forgets its chips.
  useEffect(() => {
    const empty = !text.trim();
    const t = setTimeout(
      () => {
        setQuietText(empty ? '' : text);
        if (empty) setMarks({});
      },
      empty ? 0 : ROUTE_PAUSE_MS,
    );
    return () => clearTimeout(t);
  }, [text]);

  // The bible the typing is placed against: read on opening and after each write.
  useEffect(() => {
    let live = true;
    loadCaptureBible(
      call,
      settings.numbers.timelineEnd,
      JSON.parse(timeKey) as StoryTimeValue,
    ).then(
      (b) => {
        if (live) setBible(b);
      },
      (e: unknown) => {
        if (live) setMessage(`The bible could not be read: ${plainError(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [version, timeKey, settings.numbers.timelineEnd]);

  // PH-28: what waits for the desk, read again when the bible changes here or elsewhere.
  useEffect(() => {
    let live = true;
    call('capture.waiting', {}).then(
      (r) => {
        if (live) setWaiting(r.lines);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [version, reread]);
  useEffect(() => {
    const onLines = (lines: WaitingLineWire[]) => setWaiting(lines);
    waitingListeners.add(onLines);
    const off = window.api.on('bible.reloaded', () => setReread((n) => n + 1));
    return () => {
      waitingListeners.delete(onLines);
      off();
    };
  }, []);

  const preview = useMemo(() => {
    const body = quietText.trim();
    if (!body || !bible) return null;
    const p = routeTyped(body, bible, year, marks);
    return p.facts.length > CAPTURE_MAX_FACTS ? null : p;
  }, [quietText, bible, year, marks]);
  const tooMany = !!quietText.trim() && !!bible && preview === null;
  const current = quietText.trim() === text.trim();

  const facts = preview?.facts ?? [];
  const choiceAt = (i: number): FactChoice => preview?.choices[i] ?? NO_CHOICE;
  const tickedAt = (i: number): boolean => preview?.ticks[i] ?? true;
  const local = facts.filter((f) => f.route === 'local');
  const toFile = local.filter((f) => tickedAt(f.index));
  const waits = toFile.some((f) => openAsks(f, choiceAt(f.index)).length > 0);
  const toKeep = facts.filter((f) => f.route !== 'local');
  const pressOff =
    busy || ro.off || !current || waits || (toFile.length === 0 && toKeep.length === 0);

  /** A chip or tick changed: kept by the sentence's text, so typing elsewhere keeps it. */
  const markEdit = (i: number, change: (m: EditMark) => EditMark) => {
    const key = facts[i]?.text;
    if (key === undefined) return;
    setMarks((cur) => ({ ...cur, [key]: change(cur[key] ?? {}) }));
  };
  const choose = useCallback(
    (i: number, patch: ChoicePatch) => {
      const key = preview?.facts[i]?.text;
      if (key === undefined) return;
      setMarks((cur) => {
        const m = cur[key] ?? {};
        const c = m.choice ?? NO_CHOICE;
        return {
          ...cur,
          [key]: {
            ...m,
            choice: { hint: { ...c.hint, ...patch.hint }, typed: { ...c.typed, ...patch.typed } },
          },
        };
      });
    },
    [preview],
  );

  /**
   * PH-27, PH-28: file the ticked Route A facts and keep the rest for the
   * desk, as one undo step. The press does what the page shows: when a fresh
   * read of the bible places the text otherwise, the page catches up and
   * nothing is written.
   */
  const press = async () => {
    const body = text.trim();
    if (pressOff || !body || !preview) return;
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await loadCaptureBible(call, settings.numbers.timelineEnd, time);
      const typed = routeTyped(body, fresh, year, marks);
      if (routingKey(typed) !== routingKey(preview)) {
        setBible(fresh);
        return;
      }
      await undo.flush();
      const fileFacts = typed.facts.filter(
        (f) => f.route === 'local' && (typed.ticks[f.index] ?? true),
      );
      const keepFacts = typed.facts.filter((f) => f.route !== 'local');
      const drafts: CaptureDraft[] = [];
      const owner: number[] = [];
      for (const f of fileFacts) {
        for (const d of draftsWith(f, typed.choices[f.index] ?? NO_CHOICE)) {
          drafts.push(d);
          owner.push(f.index);
        }
      }
      const filing = drafts.length ? await fileLocalDrafts(call, drafts) : null;
      const failed = new Set(
        (filing?.failed ?? []).map((x) => owner[Number(x.id.replace('draft ', ''))] ?? -1),
      );
      const keep: WaitingInput[] = keepFacts.map((f) => ({
        id: newNestedId(),
        text: f.text,
        year,
        at: new Date().toISOString(),
      }));
      let kept = false;
      let keepError: string | null = null;
      if (keep.length) {
        try {
          setWaiting((await call('capture.wait', { lines: keep })).lines);
          kept = true;
        } catch (e) {
          keepError = plainError(e);
        }
      }
      const ids = keep.map((k) => k.id as string);
      const filedCount = filing?.filed.length ?? 0;
      const label = [
        filedCount ? (filing?.command?.label ?? `Filed ${filedCount}`) : '',
        kept ? `Kept ${keep.length} for the Mac` : '',
      ]
        .filter(Boolean)
        .join('; ');
      if (filing?.command || kept) {
        const cmd: UndoCommand = {
          label,
          undo: [...(filing?.command?.undo ?? []), ...(kept ? [takeBackOp(ids)] : [])],
          redo: [...(filing?.command?.redo ?? []), ...(kept ? [keepOp(keep)] : [])],
        };
        undo.record(cmd);
        const said: string[] = [];
        const one = filing?.filed[0];
        if (filedCount) {
          said.push(`Filed ${filedCount === 1 && one ? short(one.title) : `${filedCount} facts`}`);
        }
        if (kept) said.push(`${keep.length} waiting for the Mac`);
        undo.toast(said.join(', '));
      }
      // What did not land goes back in the field, so no sentence is lost.
      const back = typed.facts.filter((f) => failed.has(f.index) || (!kept && f.route !== 'local'));
      setText(back.map((f) => f.text).join(' '));
      setQuietText(back.map((f) => f.text).join(' '));
      setMarks({});
      setFiled(filing?.filed ?? []);
      const notes: string[] = [];
      if (filing?.failed.length) {
        notes.push(`Not filed: ${filing.failed[0]?.message ?? ''}`);
      }
      if (keepError) notes.push(`Not kept for the Mac: ${keepError}`);
      if (notes.length) setMessage(notes.join(' '));
    } catch (e) {
      setMessage(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  /** PH-28: take a waiting sentence back into the field before the desk handles it. One undo step. */
  const takeBack = async (line: WaitingLineWire) => {
    if (busy || ro.off) return;
    setBusy(true);
    setMessage(null);
    try {
      setWaiting((await call('capture.takeBack', { ids: [line.id] })).lines);
      const again: WaitingInput = { id: line.id, text: line.text, year: line.year, at: line.at };
      undo.record({
        label: `Took back ${short(line.text)}`,
        undo: [keepOp([again])],
        redo: [takeBackOp([line.id])],
      });
      setText((cur) => [cur.trim(), line.text].filter(Boolean).join(' '));
    } catch (e) {
      setMessage(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const shownWaiting = (waiting ?? []).filter((l) => !l.handled);
  const picked = picking ? facts[picking.fact] : undefined;

  return (
    <section className="ph-capture" aria-labelledby="ph-capture-title" data-testid="phone-capture">
      <header className="ph-capture-head">
        <h2 id="ph-capture-title">Add</h2>
        <button
          type="button"
          className="ph-capture-year"
          aria-haspopup="dialog"
          onClick={() => nav.openSheet('year')}
          data-testid="phone-capture-year"
        >
          Story year {year}
        </button>
      </header>
      <RichText
        mode="inline"
        size="quick"
        className="capture-input ph-capture-input"
        labelledBy="ph-capture-title"
        placeholder="A fact for the bible"
        value={text}
        onChange={setText}
        disabled={ro.off}
        testId="phone-capture-input"
      />
      {tooMany && <p className="callout crit">{CAPTURE_TOO_MANY_FACTS}</p>}
      {facts.length > 0 && bible && (
        <ol className="ph-capture-facts" aria-label="Where it goes" data-testid="capture-facts">
          {facts.map((f, i) => (
            <li key={i}>
              <PhoneFactCard
                fact={f}
                choice={choiceAt(i)}
                ticked={tickedAt(i)}
                lists={lists}
                index={bible.index}
                busy={busy || ro.off}
                onTick={(t) => markEdit(i, (m) => ({ ...m, ticked: t }))}
                onPick={(chip) => {
                  setPicking({ fact: i, chip });
                  nav.openSheet('capturePick');
                }}
              />
            </li>
          ))}
        </ol>
      )}
      <div className="ph-capture-actions">
        <button
          type="button"
          className="btn primary"
          disabled={pressOff}
          onClick={() => void press()}
          data-testid="phone-capture-file"
          data-current={current && bible !== null ? 'true' : 'false'}
        >
          {pressLabel(toFile.length, toKeep.length)}
        </button>
      </div>
      {message && (
        <p className="callout crit" role="alert">
          {message}
        </p>
      )}
      {filed.length > 0 && (
        <div className="ph-capture-filed" data-testid="phone-capture-filed">
          <h3 className="ph-group">Filed</h3>
          <ul className="ph-list">
            {filed.map((f) => (
              <li key={`${f.collection}:${f.id}`}>
                <button
                  type="button"
                  className="ph-row"
                  onClick={() => open?.(f.collection, f.id)}
                  data-testid="phone-capture-filed-link"
                >
                  {f.title}{' '}
                  <span className="ph-capture-kind">
                    {collectionInfo[f.collection].singular.toLowerCase()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {shownWaiting.length > 0 && (
        <div className="ph-capture-waiting" data-testid="phone-capture-waiting">
          <h3 className="ph-group">For the Mac</h3>
          <ul className="ph-list">
            {shownWaiting.map((l) => (
              <li key={l.id} className="ph-capture-wait" data-testid="phone-waiting-line">
                <p className="ph-capture-wait-text">{l.text}</p>
                <div className="ph-capture-wait-foot">
                  <span className="ph-capture-state" data-testid="phone-waiting-state">
                    Waiting
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || ro.off}
                    onClick={() => void takeBack(l)}
                    data-testid="phone-waiting-take-back"
                  >
                    Take back
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PhoneSheet
        name="capturePick"
        label={picking ? chipSpec(picking.chip).label : 'Pick'}
        title
        testId="capture-pick-sheet"
      >
        {picked && bible && picking && (
          <ChipPicker
            fact={picked}
            choice={choiceAt(picking.fact)}
            chip={picking.chip}
            lists={lists}
            index={bible.index}
            onChoose={(patch) => {
              choose(picking.fact, patch);
              nav.closeSheet();
            }}
          />
        )}
      </PhoneSheet>
    </section>
  );
}

type ChoicePatch = { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> };

/** The chips a fact can show, as on the desk (CR-6). */
type ChipName =
  'section' | 'community' | 'age' | 'year' | 'end' | 'character' | 'category' | `name:${string}`;

interface Picking {
  fact: number;
  chip: ChipName;
}

function chipSpec(chip: ChipName, section?: CaptureFact['section']): { label: string } {
  if (chip.startsWith('name:')) {
    return { label: TYPED_ASKS[chip.slice(5)]?.label ?? 'Name' };
  }
  const labels: Record<string, string> = {
    section: 'Section',
    community: 'Community',
    age: 'Age group',
    year: section === 'culturalEntries' ? 'From' : 'Year',
    end: 'Until',
    character: 'Character',
    category: 'Category',
  };
  return { label: labels[chip] ?? chip };
}

function draftValue(drafts: readonly CaptureDraft[], field: string): string | null {
  const v = drafts.find((d) => d.op === 'create')?.data?.[field];
  return typeof v === 'string' ? v : null;
}

function itemLabel(lists: readonly WireList[], listId: string, id: string | null): string | null {
  if (!id) return null;
  return lists.find((l) => l._id === listId)?.items.find((i) => i.id === id)?.label ?? id;
}

/** The chips of a fact: the section always, then the section's own, then a typed name it asks for. */
function chipsOf(fact: CaptureFact): ChipName[] {
  const out: ChipName[] = ['section'];
  const s = fact.section;
  if (s === 'culturalEntries') out.push('community', 'age', 'year', 'end');
  else if (s === 'moments') out.push('character', 'year');
  else if (s === 'worldEvents') out.push('category', 'year');
  else if (s === 'places') out.push('community');
  for (const ask of fact.asks) if (TYPED_ASKS[ask]) out.push(`name:${ask}`);
  return out;
}

/** What a chip shows, and whether it is still needed. */
function chipValue(
  chip: ChipName,
  fact: CaptureFact,
  choice: FactChoice,
  drafts: readonly CaptureDraft[],
  lists: readonly WireList[],
  index: RouterIndex,
): { value: string | null; needed: boolean } {
  const open = openAsks(fact, choice);
  if (chip.startsWith('name:')) {
    const ask = chip.slice(5);
    const key = TYPED_ASKS[ask]?.key ?? 'title';
    return { value: choice.typed[key]?.trim() || null, needed: open.includes(ask) };
  }
  switch (chip) {
    case 'section':
      return { value: LEXICON.sectionLabels[fact.section], needed: false };
    case 'community':
      return {
        value: itemLabel(lists, 'communities', draftValue(drafts, 'communityId')),
        needed: open.includes('Community'),
      };
    case 'age':
      return {
        value: itemLabel(lists, 'ageGroups', draftValue(drafts, 'demographic')),
        needed: false,
      };
    case 'category':
      return {
        value: itemLabel(lists, 'eventCategories', draftValue(drafts, 'categoryId')),
        needed: false,
      };
    case 'character': {
      const id = draftValue(drafts, 'characterId');
      return {
        value: index.characters.find((c) => c.id === id)?.name ?? null,
        needed: open.includes('Character'),
      };
    }
    case 'year':
      return open.includes('Year')
        ? { value: null, needed: true }
        : { value: String(fact.years.start), needed: false };
    case 'end':
      return {
        value: fact.years.end === null ? `Open (${index.timelineEnd})` : String(fact.years.end),
        needed: false,
      };
  }
  return { value: null, needed: false };
}

/** One fact on the phone: its tick and title (Route A) or its sentence, its chips, and its diff. */
function PhoneFactCard(props: {
  fact: CaptureFact;
  choice: FactChoice;
  ticked: boolean;
  lists: readonly WireList[];
  index: RouterIndex;
  busy: boolean;
  onTick(ticked: boolean): void;
  onPick(chip: ChipName): void;
}) {
  const { fact, choice, lists, index } = props;
  const drafts = draftsWith(fact, choice);
  const open = openAsks(fact, choice);
  const local = fact.route === 'local';
  const waiting = local && open.length > 0;
  return (
    <article
      className={`ph-capture-fact${waiting ? ' is-waiting' : ''}`}
      data-testid="capture-fact"
      data-route={fact.route}
      data-stand={local ? 'local' : 'desk'}
    >
      {local ? (
        <label className="ph-capture-fact-head">
          <input
            type="checkbox"
            checked={props.ticked && !waiting}
            disabled={waiting || props.busy}
            onChange={(e) => props.onTick(e.target.checked)}
            data-testid="capture-fact-tick"
          />
          <span>{factTitle(fact, drafts)}</span>
        </label>
      ) : (
        <div className="ph-capture-fact-head">
          <span>{fact.text}</span>
          <span className="ph-capture-state" data-testid="capture-fact-state">
            For the Mac
          </span>
        </div>
      )}
      <div className="ph-capture-chips" role="group" aria-label="Where it goes">
        {chipsOf(fact).map((chip) => {
          const v = chipValue(chip, fact, choice, drafts, lists, index);
          const label = chipSpec(chip, fact.section).label;
          return (
            <button
              key={chip}
              type="button"
              className={`ph-capture-chip${v.needed ? ' is-needed' : ''}`}
              aria-haspopup="dialog"
              aria-label={`${label}: ${v.value ?? 'Not set'}${v.needed ? ', needed' : ''}`}
              disabled={props.busy}
              onClick={() => props.onPick(chip)}
              data-testid={`chip-${chip.startsWith('name:') ? 'name' : chip}`}
              data-needed={v.needed ? 'true' : undefined}
            >
              <span className="ph-capture-chip-label">{label}</span>
              <span className="ph-capture-chip-value">{v.value ?? 'Not set'}</span>
            </button>
          );
        })}
      </div>
      {local && <DraftDiff drafts={drafts} lists={lists} index={index} />}
    </article>
  );
}

/** A chip's picker in its sheet: a list to tap, or a field for a year or a name. */
function ChipPicker(props: {
  fact: CaptureFact;
  choice: FactChoice;
  chip: ChipName;
  lists: readonly WireList[];
  index: RouterIndex;
  onChoose(patch: ChoicePatch): void;
}) {
  const { fact, choice, chip, lists, index } = props;
  const drafts = draftsWith(fact, choice);
  const listOpts = (listId: string) =>
    (lists.find((l) => l._id === listId)?.items ?? []).map((i) => ({
      value: i.id,
      label: i.label,
    }));
  if (chip === 'year' || chip === 'end') {
    return (
      <YearField
        initial={chip === 'year' ? fact.years.start : fact.years.end}
        open={chip === 'end' ? `Open (${index.timelineEnd})` : null}
        onSet={(v) =>
          props.onChoose({
            hint: chip === 'end' ? { endYear: v } : v === null ? {} : { startYear: v },
          })
        }
      />
    );
  }
  if (chip.startsWith('name:')) {
    const key = TYPED_ASKS[chip.slice(5)]?.key ?? 'title';
    return (
      <NameField
        initial={choice.typed[key] ?? ''}
        label={TYPED_ASKS[chip.slice(5)]?.label ?? 'Name'}
        onSet={(v) => props.onChoose({ typed: { [key]: v } })}
      />
    );
  }
  let options: { value: string; label: string }[] = [];
  let currentValue: string | null = null;
  let patchOf: (v: string) => ChoicePatch = () => ({});
  if (chip === 'section') {
    options = CAPTURE_SECTIONS.map((s) => ({ value: s, label: LEXICON.sectionLabels[s] }));
    currentValue = fact.section;
    patchOf = (v) => ({ hint: { section: v as CaptureFact['section'] } });
  } else if (chip === 'community') {
    // The writing strand's guess is offered first, never filled in (CR-3).
    const strand = fact.communities.find((c) => c.why === WRITING_STRAND)?.id;
    options = listOpts('communities').sort(
      (a, b) => Number(b.value === strand) - Number(a.value === strand),
    );
    currentValue = draftValue(drafts, 'communityId');
    patchOf = (v) => ({ hint: { communityId: v } });
  } else if (chip === 'age') {
    options = listOpts('ageGroups');
    currentValue = draftValue(drafts, 'demographic');
    patchOf = (v) => ({ hint: { demographic: v } });
  } else if (chip === 'category') {
    options = listOpts('eventCategories');
    currentValue = draftValue(drafts, 'categoryId');
    patchOf = (v) => ({ hint: { categoryId: v } });
  } else if (chip === 'character') {
    options = index.characters
      .map((c) => ({ value: c.id, label: c.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    currentValue = draftValue(drafts, 'characterId');
    patchOf = (v) => ({ hint: { characterId: v } });
  }
  return (
    <ul className="ph-list" data-testid="capture-pick-options">
      {options.map((o) => (
        <li key={o.value}>
          <button
            type="button"
            className="ph-row"
            aria-current={o.value === currentValue ? 'true' : undefined}
            onClick={() => props.onChoose(patchOf(o.value))}
            data-value={o.value}
          >
            {o.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SheetForm(props: { onSubmit(): void; children: ReactNode }) {
  return (
    <form
      className="ph-capture-pick-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      {props.children}
    </form>
  );
}

/** A year: digits only, so it cannot take the wrong thing; Until may be open. */
function YearField(props: {
  initial: number | null;
  open: string | null;
  onSet(v: number | null): void;
}) {
  const [draft, setDraft] = useState(props.initial === null ? '' : String(props.initial));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const valid = /^-?\d{1,5}$/.test(draft.trim());
  return (
    <SheetForm onSubmit={() => valid && props.onSet(Number(draft.trim()))}>
      <input
        ref={ref}
        className="num ph-year-input"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        aria-label="Year"
        value={draft}
        onChange={(e) => {
          if (/^-?\d{0,5}$/.test(e.target.value)) setDraft(e.target.value);
        }}
        data-testid="capture-pick-year"
      />
      <button
        type="submit"
        className="btn primary"
        disabled={!valid}
        data-testid="capture-pick-set"
      >
        Set
      </button>
      {props.open && (
        <button type="button" className="btn" onClick={() => props.onSet(null)}>
          {props.open}
        </button>
      )}
    </SheetForm>
  );
}

function NameField(props: { initial: string; label: string; onSet(v: string): void }) {
  const [draft, setDraft] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <SheetForm onSubmit={() => draft.trim() && props.onSet(draft.trim())}>
      <input
        ref={ref}
        aria-label={props.label}
        autoComplete="off"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="capture-pick-name"
      />
      <button
        type="submit"
        className="btn primary"
        disabled={!draft.trim()}
        data-testid="capture-pick-set"
      >
        Set
      </button>
    </SheetForm>
  );
}
