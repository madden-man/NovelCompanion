import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../renderer/src/theme.css';
import '../renderer/src/app.css';
import { App } from '../renderer/src/App';
import { presetCapabilities } from '../renderer/src/capabilities';
import { setPhone } from '../renderer/src/phone';
import { saveBeforeSwitch } from '../renderer/src/workspace/undo';
import { clearDrafts } from '../renderer/src/workspace/phone/captureDraft';
// PH-21: the same file the function imports, written by this build (scripts/build-id.ts).
import buildInfo from '../generated/build-id.json';
import { trackTyping, watchBuild } from './buildWatch';
import { KeyGate } from './KeyGate';
import { attachLifecycle } from './lifecycle';
import { registerServiceWorker, updateServiceWorker } from './serviceWorker';
import { PHONE_CHANNELS } from '../shared/ipcPhone';
import { LOCAL_CHANNELS, WebTransport } from './transport';
import { ReadStore, browserIndexedDb, indexedDbBackend } from './readStore';

/** Storage that may refuse (private browsing): the app still runs, keeping nothing. */
function storage(kind: 'localStorage' | 'sessionStorage'): Storage {
  try {
    const s = window[kind];
    s.getItem('nc');
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      get length() {
        return mem.size;
      },
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
}

const transport = new WebTransport({
  fetch: window.fetch.bind(window),
  storage: storage('localStorage'),
  buildId: buildInfo.id,
  // PH-25: what the phone read, for reading without a connection; none in private browsing.
  reads: new ReadStore(indexedDbBackend(browserIndexedDb())),
});
// The renderer reaches the bible only through `window.api`, as on the desk (ARCH-1 rule 3).
Object.defineProperty(window, 'api', { value: transport, configurable: false, writable: false });
presetCapabilities(PHONE_CHANNELS, LOCAL_CHANNELS);
// A58 U1: the phone's shell, layout and CSS (`usePhone`, `:root[data-phone]`).
setPhone(true);
attachLifecycle(transport, document, window);
transport.onSignedOut(clearDrafts);
const holdsTyping = trackTyping(document);
transport.onBuildChanged(
  watchBuild({
    isTyping: holdsTyping,
    save: saveBeforeSwitch,
    reload: () => window.location.reload(),
    updateWorker: updateServiceWorker,
    session: storage('sessionStorage'),
  }),
);
registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('The page has no root element.');
createRoot(root).render(
  <StrictMode>
    <KeyGate transport={transport}>
      <App />
    </KeyGate>
  </StrictMode>,
);
