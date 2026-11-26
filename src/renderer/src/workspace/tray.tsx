import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClaudeStatusWire } from '../../../shared/claude';
import { collectionInfo } from '../../../shared/schema';
import type { FiledEntry } from '../../../shared/domain/capture';
import type { CaptureHint } from '../../../shared/domain/captureRouter';
import { NO_MARKS, trayGroups } from '../../../shared/domain/tray';
import type { OfferedPage, TrayGroup, TrayItem, TrayMarks } from '../../../shared/domain/tray';
import type { Op } from '../../../shared/domain/undoRunner';
import { useWriteGuard } from '../connection';
import { call, plainError } from '../api';
import { useBibleSettings } from './bibleSettings';
import { captureNav } from './capture';
import { FactCard } from './captureChips';
import { NO_CHOICE, draftsWith, loadCaptureBible, openAsks } from './captureLocal';
import type { CaptureBible, FactChoice } from './captureLocal';
import { Disclosure, claudeNav } from './claude';
import { useStore } from './data';
import { notebookDate } from './notebook';
import { useStoryTime } from './storyTime';
import { useUndo } from './undo';
import { fileTrayGroup, markOp } from './trayFile';
import './capture.css';
import './notebook.css';

type Mark = keyof TrayMarks | null;

const NO_KEY = 'No Anthropic key is set. Add one in Settings to ask Claude.';

/** "story year 2071", "the whole book", or "no story year". */
function yearWords(year: number | null | undefined): string {
  if (year === undefined) return 'no story year';
  return year === null ? 'the whole book' : `story year ${year}`;
}

function groupHeading(g: TrayGroup): string {
  const day = notebookDate(g.date);
  return g.kind === 'day'
    ? `Kept lines · ${day}`
    : `Council about the story · ${g.title || 'Untitled'} · ${day} · ${yearWords(g.year)}`;
}

/**
 * A56 (FN-1 to FN-6): From the notebook. Every fact the Capture Router finds
 * in a kept line or a council about the story, as the capture box shows it:
 * a Route A card with its chips, tick and drafts, filed by its group's File
 * it as one undo step; a Route B or C card waiting behind Send to Claude,
 * which hands the sentence to the capture box. Dismiss stays dismissed until
 * the line changes. Nothing is written or sent until he presses a button.
 */
export function NotebookTray() {
  const settings = useBibleSettings();
  const { lists, version } = useStore();
  const story = useStoryTime();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [pages, setPages] = useState<OfferedPage[] | null>(null);
  const [marks, setMarks] = useState<TrayMarks>(NO_MARKS);
  const [bible, setBible] = useState<CaptureBible | null>(null);
  const [status, setStatus] = useState<ClaudeStatusWire | null>(null);
  const [choices, setChoices] = useState<Record<string, FactChoice>>({});
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filed, setFiled] = useState<FiledEntry[]>([]);

  useEffect(() => {
    let live = true;
    Promise.all([
      call('notebook.offered', {}),
      call('tray.state', {}),
      loadCaptureBible(call, settings.numbers.timelineEnd, { year: story.year }),
      call('claude.status', {}).catch(() => null),
    ]).then(
      ([offered, m, b, s]) => {
        if (!live) return;
        setPages(offered.pages);
        setMarks(m);
        setBible(b);
        setStatus(s);
      },
      (e: unknown) => {
        if (live) setMessage(`The notebook could not be read: ${plainError(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [version, settings.numbers.timelineEnd, story.year]);

  const hints = useMemo(() => {
    const out: Record<string, Omit<CaptureHint, 'fact'>> = {};
    for (const [k, c] of Object.entries(choices)) if (Object.keys(c.hint).length) out[k] = c.hint;
    return out;
  }, [choices]);

  const groups = useMemo(
    () =>
      pages && bible ? trayGroups(pages, bible.index, { storyYear: story.year, hints, marks }) : [],
    [pages, bible, story.year, hints, marks],
  );

  const choiceOf = (i: TrayItem) => choices[i.key] ?? NO_CHOICE;

  /** A `run` step that sets or clears marks, for undo and redo (FN-3, FN-4). */
  const markStep = useCallback(
    (keys: string[], mark: Mark): Op => markOp(call, keys, mark, setMarks),
    [],
  );

  /** FN-4: dismiss facts as one undo step. */
  const dismiss = async (keys: string[], label: string) => {
    if (!keys.length || busy || ro.off) return;
    setBusy(true);
    setMessage(null);
    try {
      setMarks(await call('tray.mark', { keys, mark: 'dismissed' }));
      undo.record({
        label: `Dismissed ${label}`,
        undo: [markStep(keys, null)],
        redo: [markStep(keys, 'dismissed')],
      });
    } catch (e) {
      setMessage(`Nothing was dismissed: ${plainError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Route A facts of a group that File it would write now: ticked, and no chip left to fill. */
  const ready = (g: TrayGroup) =>
    g.items.filter(
      (i) =>
        i.fact.route === 'local' && !unticked.has(i.key) && !openAsks(i.fact, choiceOf(i)).length,
    );

  /** FN-3: write a group's ticked drafts as plain new entries, one undo step. */
  const file = async (g: TrayGroup) => {
    const items = ready(g);
    if (!items.length || busy || ro.off) return;
    setBusy(true);
    setMessage(null);
    setFiled([]);
    try {
      await undo.flush();
      const r = await fileTrayGroup(
        call,
        items.map((i) => ({ key: i.key, drafts: draftsWith(i.fact, choiceOf(i)) })),
        marks,
        undo.record,
        setMarks,
      );
      setMarks(r.marks);
      setFiled(r.filed);
      const notes: string[] = [];
      if (r.failedKeys.length) {
        notes.push(
          `${r.failedKeys.length === 1 ? 'One fact was' : `${r.failedKeys.length} facts were`} not filed and still wait here: ${r.firstFailure ?? ''}`,
        );
      }
      if (r.markError) {
        notes.push(
          `Filed, but the tray could not remember it, so it may be offered again after a restart: ${r.markError}`,
        );
      }
      if (notes.length) setMessage(notes.join(' '));
    } catch (e) {
      setMessage(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  /** FN-6: hand the sentence to the capture box, which sends it on its route; then it leaves the tray. */
  const send = async (i: TrayItem, all: boolean) => {
    if (busy) return;
    const c = choiceOf(i);
    const year = c.hint.startYear ?? (typeof i.year === 'number' ? i.year : i.fact.years.start);
    setMessage(null);
    // The sent mark is stored before an unfiled call-back can clear it, whichever comes first.
    let sentMark: Promise<unknown> = Promise.resolve();
    const result = await captureNav.send({
      text: i.fact.text,
      year,
      hint: c.hint,
      all,
      // FN-6: a run that fails or stops, or a box closed unfiled, offers the card again.
      onUnfiled: () => {
        void sentMark
          .then(() => call('tray.mark', { keys: [i.key], mark: null }))
          .then(setMarks, () => undefined);
      },
    });
    if (result === 'sent') {
      sentMark = call('tray.mark', { keys: [i.key], mark: 'sent' }).then(setMarks, (e: unknown) =>
        setMessage(plainError(e)),
      );
      await sentMark;
    } else if (result === 'busy') {
      setMessage('The Add box is busy with another capture. Finish or close it, then send again.');
    } else {
      setMessage('Nothing was sent. The Add box says why.');
    }
  };

  const needsAck = status !== null && status.key.set && !status.acknowledgedAt;
  const claudeOff = (i: TrayItem): string | null => {
    if (ro.off) return ro.tip.title ?? 'The bible is read-only.';
    if (status !== null && !status.key.set) return NO_KEY;
    if (needsAck) return 'Confirm what Claude sends first, at the top of this screen.';
    if (openAsks(i.fact, choiceOf(i)).includes('Year')) return 'Pick the year first.';
    return null;
  };

  const choose = (
    key: string,
    patch: { hint?: Omit<CaptureHint, 'fact'>; typed?: Record<string, string> },
  ) =>
    setChoices((cur) => {
      const c = cur[key] ?? NO_CHOICE;
      return {
        ...cur,
        [key]: { hint: { ...c.hint, ...patch.hint }, typed: { ...c.typed, ...patch.typed } },
      };
    });

  return (
    <section className="ws-wide stack" aria-labelledby="tray-title" data-testid="notebook-tray">
      <h2 id="tray-title">From the notebook</h2>
      {needsAck && (
        <Disclosure onConfirm={() => void call('claude.acknowledge', {}).then(setStatus)} />
      )}
      {filed.length > 0 && (
        <div className="callout stack tight" role="status" data-testid="tray-filed">
          <strong>Filed</strong>
          <ul className="capture-filed-list">
            {filed.map((f) => (
              <li key={`${f.collection}:${f.id}`}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => claudeNav.openEntry(f.collection, f.id)}
                >
                  {f.title}
                </button>{' '}
                <span className="capture-kind">
                  ({collectionInfo[f.collection].singular.toLowerCase()})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {message && (
        <p className="callout crit" role="alert">
          {message}
        </p>
      )}
      {pages === null || bible === null ? (
        <p aria-live="polite">Loading the notebook.</p>
      ) : groups.length === 0 ? (
        <p data-testid="tray-empty">Nothing from the notebook waits here.</p>
      ) : (
        groups.map((g) => {
          const fileable = ready(g).length;
          const local = g.items.filter((i) => i.fact.route === 'local').length;
          return (
            <section
              key={g.id}
              className="panel stack tight tray-group"
              aria-label={groupHeading(g)}
              data-testid="tray-group"
              data-group={g.id}
            >
              <h3>{groupHeading(g)}</h3>
              <ol className="capture-facts">
                {g.items.map((i, n) => {
                  const firstOfLine = n === 0 || g.items[n - 1]?.lineId !== i.lineId;
                  return (
                    <li key={i.key} data-key={i.key} data-testid="tray-item">
                      {firstOfLine && (
                        <blockquote className="capture-sent" data-testid="tray-line">
                          {i.lineText}
                          {g.kind === 'day' && (
                            <span className="capture-kind"> ({yearWords(i.year)})</span>
                          )}
                        </blockquote>
                      )}
                      <FactCard
                        fact={i.fact}
                        choice={choiceOf(i)}
                        stand={i.fact.route === 'local' ? 'local' : 'unsent'}
                        ticked={!unticked.has(i.key)}
                        first={false}
                        lists={lists}
                        index={bible.index}
                        busy={busy || ro.off}
                        claudeOff={claudeOff(i)}
                        onTick={(t) =>
                          setUnticked((cur) => {
                            const next = new Set(cur);
                            if (t) next.delete(i.key);
                            else next.add(i.key);
                            return next;
                          })
                        }
                        onChoose={(patch) => choose(i.key, patch)}
                        onAskClaude={() => void send(i, true)}
                        onSend={() => void send(i, false)}
                        onDismiss={() => void dismiss([i.key], i.fact.text)}
                      />
                    </li>
                  );
                })}
              </ol>
              <div className="row capture-actions">
                {local > 0 && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || ro.off || fileable === 0}
                    {...ro.tip}
                    onClick={() => void file(g)}
                    data-testid="tray-file"
                  >
                    {fileable === local ? 'File it' : `File ${fileable} of ${local}`}
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy || ro.off}
                  onClick={() =>
                    void dismiss(
                      g.items.map((i) => i.key),
                      groupHeading(g),
                    )
                  }
                  data-testid="tray-dismiss-group"
                >
                  Dismiss all
                </button>
              </div>
            </section>
          );
        })
      )}
    </section>
  );
}
