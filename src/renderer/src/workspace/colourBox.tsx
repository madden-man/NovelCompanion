/** A47 (IP-9, IP-12): a colour picked with the system picker, saved as one undo step. */
import { useEffect, useRef, useState } from 'react';
import { plainError } from '../api';
import './vocab.css';

/** The grey a colour box shows for an item with no colour yet. */
const NO_COLOUR = '#808080';

/**
 * A colour box that saves when the picker closes (the `change` event), not on
 * every step of a drag across the colour field (`input`), so a pick is one step.
 */
export function ColourBox(props: {
  label: string;
  value: string | null;
  onPick: (hex: string) => Promise<void>;
  testId?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  /** What the box shows while the picker is open; the stored value otherwise. */
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { value, onPick } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const changed = () => {
      const hex = el.value.toLowerCase();
      if (hex === (value ?? '').toLowerCase()) {
        setDraft(null);
        return;
      }
      setError(null);
      onPick(hex).then(
        () => setDraft(null),
        (e: unknown) => {
          setError(plainError(e));
          setDraft(null);
        },
      );
    };
    el.addEventListener('change', changed);
    return () => el.removeEventListener('change', changed);
  }, [value, onPick]);
  return (
    <span className="colour-box">
      <input
        ref={ref}
        type="color"
        aria-label={props.label}
        title={props.label}
        value={draft ?? value ?? NO_COLOUR}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && (
        <span className="ed-error" role="alert">
          Not saved: {error}
        </span>
      )}
    </span>
  );
}
