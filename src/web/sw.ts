/**
 * A58 (PH-24): the phone's service worker. It precaches the app shell (the
 * page, its scripts and styles, the manifest and icons) so the app opens with
 * no connection. The bible itself is never cached here: `/rpc` always goes to
 * the network, and a lost connection shows the ARCH-6 banner. Built by
 * `vite.web.config.ts`, which fills in the build id and the file list.
 */
declare const __NC_BUILD_ID__: string;
declare const __NC_PRECACHE__: string[];

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface WorkerScope {
  readonly location: Location;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope;
const PREFIX = 'nc-shell-';
const CACHE = `${PREFIX}${__NC_BUILD_ID__}`;

scope.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(__NC_PRECACHE__.map((u) => new Request(u, { cache: 'reload' }))),
      )
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.location.origin) return;
  if (url.pathname === '/rpc') return;
  if (request.mode === 'navigate') {
    // The newest shell when online; the precached one without a connection.
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match('/index.html', { cacheName: CACHE })) ?? Response.error(),
      ),
    );
    return;
  }
  event.respondWith(
    caches.match(request, { cacheName: CACHE }).then((hit) => hit ?? fetch(request)),
  );
});
