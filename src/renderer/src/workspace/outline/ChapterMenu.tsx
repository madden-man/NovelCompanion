import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface ChapterMenuItem {
  label: string;
  /** The key that does the same where it works, shown beside the label. */
  keys: string;
  /** What screen readers hear for the key, as `aria-keyshortcuts` writes it. */
  shortcut: string;
  disabled?: boolean;
  danger?: boolean;
  testId: string;
  onSelect: () => void;
}

/**
 * A57: the "more" menu on a chapter bar. It lists what the bar does from the
 * keyboard, each with its key, and each item does it. Enter, Space or Down
 * opens it on the first item, Up on the last; the arrows, Home and End move
 * inside it; Escape closes it with the focus back on the button; Tab closes it
 * and moves on; a press outside closes it.
 */
export function ChapterMenu(props: { label: string; items: ChapterMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pending = useRef<'first' | 'last' | null>(null);
  const menuId = useId();
  const buttonId = useId();

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ??
        [],
    );

  useEffect(() => {
    if (!open) return;
    const list = items();
    const target = pending.current === 'last' ? list[list.length - 1] : list[0];
    pending.current = null;
    target?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const show = (at: 'first' | 'last') => {
    pending.current = at;
    setOpen(true);
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus({ preventScroll: true });
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      show('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      show('last');
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = at < 0 || at === list.length - 1 ? 0 : at + 1;
    else if (e.key === 'ArrowUp') next = at <= 0 ? list.length - 1 : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    list[next]?.focus();
  };

  return (
    <span className="cbar-menu">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="cbar-more"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="chapter-more"
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={onButtonKey}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-labelledby={buttonId}
        className="cbar-menu-list"
        hidden={!open}
        data-testid="chapter-menu"
        onKeyDown={onMenuKey}
      >
        {props.items.map((it) => (
          <button
            key={it.testId}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={it.danger ? 'danger' : undefined}
            disabled={it.disabled}
            aria-keyshortcuts={it.shortcut}
            data-testid={it.testId}
            onClick={() => {
              close(false);
              it.onSelect();
            }}
          >
            <span>{it.label}</span>
            <kbd aria-hidden="true">{it.keys}</kbd>
          </button>
        ))}
      </div>
    </span>
  );
}
