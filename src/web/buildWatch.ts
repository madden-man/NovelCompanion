/**
 * A58 (PH-21): an answer carried another build id than this web build's.
 * The new service worker is fetched at once; the page reloads at the next
 * moment no field holds typing not yet stored, and never while one does.
 * One reload per new id in a session, so a site whose function and shell
 * disagree cannot loop.
 */
export interface BuildWatchDeps {
  /** True while a field holds typing (a focused text field). */
  isTyping: () => boolean;
  /** Store every pending edit; throws when one could not be stored. */
  save: () => Promise<void>;
  reload: () => void;
  updateWorker: () => Promise<void>;
  session: Pick<Storage, 'getItem' | 'setItem'>;
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
    let done: string | null = null;
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
export function typingIn(doc: Pick<Document, 'activeElement'>): boolean {
  const el = doc.activeElement;
  if (!el || typeof (el as Element).matches !== 'function') return false;
  return (el as Element).matches(
    'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]):not([type="range"])',
  );
}
