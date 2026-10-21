import { useState } from 'react';

/**
 * A whole-number field that writes on Enter or on leaving it, and goes back
 * to the stored value when the write is refused or the number is out of
 * range (KB-3, PL-6). Escape drops what was typed.
 */
export function NumberField(props: {
  id?: string;
  label: string;
  testId: string;
  value: number | null;
  min: number;
  max: number;
  width: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onCommit: (value: number | null) => Promise<boolean>;
}) {
  const shown = props.value === null ? '' : String(props.value);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    setSeen(shown);
    if (!editing) setDraft(shown);
  }
  const commit = async () => {
    setEditing(false);
    const t = draft.trim();
    if (t === shown) return;
    const n = t === '' ? null : Number(t);
    const valid = n === null || (Number.isInteger(n) && n >= props.min && n <= props.max);
    const ok = valid && (await props.onCommit(n));
    if (!ok) setDraft(shown);
  };
  return (
    <input
      id={props.id}
      type="number"
      inputMode="numeric"
      className="ch-number"
      style={{ width: props.width }}
      value={draft}
      min={props.min}
      max={props.max}
      step={1}
      disabled={props.disabled}
      {...props.tip}
      aria-label={props.label}
      data-testid={props.testId}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          setDraft(shown);
          setEditing(false);
        }
      }}
    />
  );
}
