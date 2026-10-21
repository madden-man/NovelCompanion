import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface AppMenuItem {
  label: string;
  active: boolean;
  onSelect: () => void;
}

/**
 * SM-6: the utilities that left the rail, under one App button at its foot.
 * A menu of menu items: Enter, Space or ArrowDown opens it on the first item,
 * ArrowUp on the last; the arrows, Home and End move inside it; Escape closes
 * it and gives the focus back to the button; Tab closes it and moves on. The
 * items stay in the page while it is closed, hidden, so the active one still
 * carries `aria-current`.
 */
export function AppMenu(props: { groups: { label: string; items: AppMenuItem[] }[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pending = useRef<'first' | 'last' | null>(null);
  const menuId = useId();
  const buttonId = useId();

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

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
    if (focusButton) buttonRef.current?.focus();
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
    <div className="app-menu">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="app-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={onButtonKey}
        data-testid="app-menu-button"
      >
        App
      </button>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-labelledby={buttonId}
        className="app-menu-list"
        hidden={!open}
        onKeyDown={onMenuKey}
        data-testid="app-menu"
      >
        {props.groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="app-menu-group">
            <span className="eyebrow" aria-hidden="true">
              {g.label}
            </span>
            {g.items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-current={it.active ? 'page' : undefined}
                onClick={() => {
                  close(true);
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
