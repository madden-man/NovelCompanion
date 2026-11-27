import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import './bibleMenu.css';

interface BibleRef {
  id: string;
  name: string;
}

/**
 * A57: the open bible's name in the app header is the switcher. It lists every
 * bible to open, and its last row makes a new one from a name and opens it.
 * Enter, Space or ArrowDown opens it; the arrows move between rows; Escape
 * closes it and gives the focus back to the button; leaving it closes it.
 */
export function BibleMenu(props: {
  current: BibleRef;
  bibles: readonly BibleRef[];
  /** False while MongoDB is out of reach or a snapshot is open read-only. */
  canCreate: boolean;
  busy: boolean;
  onOpen: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const { current, bibles, canCreate, busy, onOpen, onCreate } = props;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row]:not([disabled])') ?? []);

  useEffect(() => {
    if (!open) return;
    const all = rows();
    (all.find((r) => r.getAttribute('aria-current') === 'true') ?? all[0])?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!listRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    setName('');
    if (focusButton) buttonRef.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown'
        ? at < 0 || at === all.length - 1
          ? 0
          : at + 1
        : at <= 0
          ? all.length - 1
          : at - 1;
    e.preventDefault();
    all[next]?.focus();
  };

  const pick = async (id: string) => {
    close(true);
    if (id !== current.id) await onOpen(id);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      if (await onCreate(name.trim())) close(true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bible-menu">
      <button
        ref={buttonRef}
        type="button"
        className="btn bible-menu-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Bible: ${current.name}`}
        aria-busy={busy}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKey}
        data-testid="bible-menu-button"
      >
        <span data-testid="current-bible">{current.name}</span>
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="group"
          aria-label="Bibles"
          className="bible-menu-list"
          onKeyDown={onListKey}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !listRef.current?.contains(to) && !buttonRef.current?.contains(to)) {
              close(false);
            }
          }}
          data-testid="bible-menu"
        >
          {bibles.map((b) => (
            <button
              key={b.id}
              type="button"
              data-row
              className="bible-menu-row"
              aria-current={b.id === current.id ? 'true' : undefined}
              disabled={busy}
              onClick={() => void pick(b.id)}
            >
              {b.name}
            </button>
          ))}
          {canCreate && (
            <form className="bible-menu-new" onSubmit={(e) => void submit(e)}>
              <input
                data-row
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New bible"
                aria-label="Name of a new bible"
                disabled={creating}
                data-testid="bible-menu-new"
              />
              <button
                type="submit"
                className="btn small"
                aria-label="Create and open"
                disabled={creating || busy || !name.trim()}
              >
                <kbd aria-hidden="true">⏎</kbd>
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
