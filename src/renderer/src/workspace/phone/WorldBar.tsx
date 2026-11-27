import type { ReactNode } from 'react';
import type { Zoom } from '../../../../shared/domain/worldGrid';
import { usePhoneNav } from './nav';
import { PhoneSheet } from './Sheet';
import './world.css';

/** The zoom names that fit three across a thumb row. */
const SHORT: Record<Zoom, string> = { fit: 'Whole', default: 'Medium', close: 'Close' };

/**
 * A58 U3: the World screen's controls on the phone, in one thumb row: the
 * three zooms, and Filter, which opens the category and region filters as a
 * sheet. Filter carries how many filters are on.
 */
export function PhoneWorldBar(props: {
  zoom: Zoom;
  zooms: readonly { zoom: Zoom; label: string }[];
  onZoom: (z: Zoom) => void;
  /** How many filters narrow the grid now. */
  filtered: number;
  /** The category and region controls the desk shows in its toolbar. */
  children: ReactNode;
}) {
  const nav = usePhoneNav();
  return (
    <>
      <div className="ph-world-bar" data-testid="world-bar">
        <div className="ph-seg" role="group" aria-label="Zoom">
          {props.zooms.map((z) => (
            <button
              key={z.zoom}
              type="button"
              className="ph-seg-btn"
              aria-pressed={props.zoom === z.zoom}
              aria-label={z.label}
              onClick={() => props.onZoom(z.zoom)}
            >
              {SHORT[z.zoom]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn ph-filter-btn"
          aria-haspopup="dialog"
          aria-expanded={nav.sheet === 'world-filters'}
          onClick={() => nav.openSheet('world-filters')}
          data-testid="world-filter"
        >
          Filter
          {props.filtered > 0 && (
            <span className="ph-count num" data-testid="world-filter-count">
              {props.filtered}
            </span>
          )}
        </button>
      </div>
      <PhoneSheet name="world-filters" label="Filter" title testId="world-filters">
        <div className="ph-world-filters">{props.children}</div>
      </PhoneSheet>
    </>
  );
}
