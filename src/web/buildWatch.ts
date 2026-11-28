/**
 * A58 (PH-21): an answer carried another build id than this web build's.
 * The new service worker is fetched at once; the page reloads at the next
 * moment no field holds typing not yet stored, and never while one does.
 * One reload per new id in a session, so a site whose function and shell
 * disagree cannot loop.
 */
export interface BuildWatchDeps {
  /** True while a field holds typing: a focused text field, or one typed in that still holds text. */
  isTyping: () => boolean;
  /** Store every pending edit; throws when one could not be stored. */
  save: () => Promise<void>;
  reload: () => void;
  updateWorker: () => Promise<void>;
  session: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  every?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const RELOADED_FOR = 'nc.reloadedFor';

export function watchBuild(deps: BuildWatchDeps): (id: string) => void {
  const every = deps.every ?? 1000;
  const later = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let waiting: string | null = null;
  const tryReload = async (id: string) => {
    if (!deps.isTyping()) {
      try {
        await deps.save();
        if (!deps.isTyping()) {
          deps.session.setItem(RELOADED_FOR, id);
          deps.reload();
          return;
        }
      } catch {
        // Something could not be stored yet; wait and try again.
      }
    }
    later(() => void tryReload(id), every);
  };
  return (id) => {
    if (waiting === id) return;
    let done: string | null;
    try {
      done = deps.session.getItem(RELOADED_FOR);
    } catch {
      done = null;
    }
    if (done === id) return;
    waiting = id;
    void deps.updateWorker().catch(() => undefined);
    void tryReload(id);
  };
}

/** A focused field that takes typing. */
export function typingIn(doc: {
  activeElement: { matches(selector: string): boolean } | null;
}): boolean {
  const el = doc.activeElement;
  if (!el || typeof el.matches !== 'function') return false;
  return el.matches(
    'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]):not([type="range"])',
  );
}

interface TypedField {
  readonly isConnected: boolean;
  readonly value?: unknown;
}

/**
 * PH-21: typing not yet stored can sit in a field that lost focus (the
 * capture box while a chip's sheet is open, a dialog's field). A field the
 * person typed in holds the reload while it is on screen with text in it;
 * a focused text field always does.
 */
export function trackTyping(doc: {
  activeElement: { matches(selector: string): boolean } | null;
  addEventListener(type: 'input', fn: (e: { target: unknown }) => void, capture?: boolean): void;
}): () => boolean {
  const typed = new Set<TypedField>();
  doc.addEventListener(
    'input',
    (e) => {
      const el = e.target as TypedField | null;
      if (el && typeof el.value === 'string') typed.add(el);
    },
    true,
  );
  return () => {
    if (typingIn(doc)) return true;
    for (const el of [...typed]) {
      if (!el.isConnected) typed.delete(el);
      else if (typeof el.value === 'string' && el.value !== '') return true;
    }
    return false;
  };
}
