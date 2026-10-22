/**
 * A47 (IP-9): a status or provenance drawn from its list item: the item's
 * label, and its colour (`listColorCss`) on the chip's edge and dot. The
 * seeded theme tokens are the fallback only when the item has no colour. The
 * text stays in the primary text colour in both themes.
 */
import { listColorCss } from '../../../shared/domain/lists';
import { useList } from './data';
import './vocab.css';

/** The seeded items whose theme token draws them when they carry no colour of their own. */
const THEME_FALLBACK: Record<string, string> = {
  canon: 'var(--canon)',
  planned: 'var(--planned)',
  idea: 'var(--idea)',
};

/** An item's label and CSS colour (null when it has neither a colour nor a seeded token). */
export function useItemLook(
  listId: 'statuses' | 'provenance',
  id: string | null | undefined,
): { label: string; colour: string | null } {
  const item = useList(listId)?.items.find((i) => i.id === id);
  const colour = listColorCss(item?.color) ?? (id ? (THEME_FALLBACK[id] ?? null) : null);
  return { label: item?.label ?? id ?? '', colour };
}

/** A chip for a status or a provenance, in the list's label and colour. */
export function ListChip(props: {
  listId: 'statuses' | 'provenance';
  id: string | null | undefined;
  /** Keep the label as stored (Canon) instead of lower case (canon). */
  asIs?: boolean;
}) {
  const look = useItemLook(props.listId, props.id);
  if (!props.id) return null;
  return (
    <span
      className="chip list-chip"
      data-list={props.listId}
      data-item={props.id}
      style={look.colour ? { borderColor: look.colour } : undefined}
    >
      {look.colour && (
        <span className="dot" style={{ background: look.colour }} aria-hidden="true" />
      )}
      {props.asIs ? look.label : look.label.toLowerCase()}
    </span>
  );
}

/** A small square in the item's colour, beside a select that picks a status or a provenance. */
export function ListSwatch(props: { listId: 'statuses' | 'provenance'; id: string | null }) {
  const look = useItemLook(props.listId, props.id);
  if (!props.id || !look.colour) return null;
  return (
    <span
      className="vocab-swatch"
      data-list={props.listId}
      data-item={props.id}
      style={{ background: look.colour }}
      aria-hidden="true"
    />
  );
}
