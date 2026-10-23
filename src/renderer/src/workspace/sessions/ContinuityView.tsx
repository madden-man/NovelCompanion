import { useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlignmentView } from './alignment';
import type { OpenEntry } from './common';
import { ManuscriptView } from './manuscript';

export type ContinuityTab = 'alignment' | 'manuscript';

const TABS: { tab: ContinuityTab; label: string }[] = [
  { tab: 'alignment', label: 'Alignment check' },
  { tab: 'manuscript', label: 'Manuscript' },
];

/**
 * SM-11: the Continuity checker. The alignment check (CC-1 to CC-5: run,
 * findings and their three resolutions, rewrite tasks) and, as a second tab,
 * the manuscript it reads (MS-1 to MS-5: the chapters that hold text, import
 * from Word, the re-import diff, marking a chapter written).
 */
export function ContinuityView(props: {
  tab: ContinuityTab;
  onTab: (tab: ContinuityTab) => void;
  onOpen: OpenEntry;
  /** MS-2: the chapter just ticked Written, opened on the Manuscript tab with its flow. */
  chapterId?: string;
  openFlow?: boolean;
}) {
  const baseId = useId();
  const refs = useRef<Partial<Record<ContinuityTab, HTMLButtonElement | null>>>({});
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'End') next = e.key === 'End' ? TABS.length - 1 : i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'Home') next = e.key === 'Home' ? 0 : i - 1;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length]?.tab;
    if (!target) return;
    props.onTab(target);
    refs.current[target]?.focus();
  };
  return (
    <div className="stack continuity" data-testid="continuity-view" data-tab={props.tab}>
      <div className="screen-tabs" role="tablist" aria-label="Continuity checker">
        {TABS.map((t, i) => (
          <button
            key={t.tab}
            ref={(el) => {
              refs.current[t.tab] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.tab}`}
            aria-selected={props.tab === t.tab}
            aria-controls={`${baseId}-panel`}
            tabIndex={props.tab === t.tab ? 0 : -1}
            onClick={() => props.onTab(t.tab)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${props.tab}`}>
        {props.tab === 'alignment' ? (
          <AlignmentView onOpen={props.onOpen} />
        ) : (
          <ManuscriptView
            key={props.chapterId ?? ''}
            onOpen={props.onOpen}
            chapterId={props.chapterId}
            openFlow={props.openFlow}
          />
        )}
      </div>
    </div>
  );
}
