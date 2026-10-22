/*
 * Asterlie offline support.
 *
 * Keeps a copy of the game on the device so it opens without a connection.
 * Each launch also checks for a newer copy in the background; if one is
 * found, the next launch uses it.
 *
 * Only a page that registers this script is saved, so a sign-in page, an
 * error page or a Wi-Fi login portal can never replace the game.
 * The page loads the puzzle engine as engine.js?v=…, and a page is only saved
 * once the engine it names is saved too, so a saved page always has its
 * engine. Each engine version has its own address, so an older page that is
 * still open keeps its own copy.
 * If you change the icons or the manifest, bump VERSION.
 */
const VERSION = 'v5';
const CACHE = 'star-battle-' + VERSION;
const PAGE = './';
const PAGE_MARKER = "serviceWorker.register('sw.js')";
const FILES = [
  './manifest.json',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Responses that came through a redirect can't be replayed for a page load,
// so store a plain copy instead.
async function plain(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// The page's text if the response is the game page, else null
async function gamePage(res) {
  if (!res.ok || res.type !== 'basic') return null;
  const text = await res.clone().text();
  return text.includes(PAGE_MARKER) ? text : null;
}

// The full address of the engine a page loads, or null
function engineOf(text) {
  const m = /<script id="engine" src="([^"]+)"/.exec(text);
  return m ? new URL(m[1], self.location).href : null;
}
function isEngine(url) { return new URL(url).pathname.endsWith('/engine.js'); }

// Save a game page together with the engine it names. Nothing is saved unless both
// arrive; engines that neither this page nor the one it replaces use are dropped.
async function savePage(cache, res, text) {
  const engine = engineOf(text);
  if (!engine) throw new Error('The page names no engine');
  if (!(await cache.match(engine))) {
    const er = await fetch(new Request(engine, { cache: 'reload' }));
    if (!er.ok) throw new Error('Could not save ' + engine + ' (' + er.status + ')');
    await cache.put(engine, await plain(er));
  }
  const old = await cache.match(PAGE);
  const keep = [engine, old ? engineOf(await old.text()) : null];
  await cache.put(PAGE, await plain(res));
  for (const req of await cache.keys()) if (isEngine(req.url) && keep.indexOf(req.url) < 0) await cache.delete(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch(new Request(PAGE, { cache: 'reload' }));
    const text = await gamePage(res);
    if (!text) throw new Error('Could not save the game page (' + res.status + ')');
    await Promise.all(FILES.map(async (file) => {
      const r = await fetch(new Request(file, { cache: 'reload' }));
      const type = r.headers.get('content-type') || '';
      if (!r.ok || type.includes('text/html')) throw new Error('Could not save ' + file + ' (' + r.status + ')');
      await cache.put(file, await plain(r));
    }));
    await savePage(cache, res, text);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('star-battle-') && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') event.respondWith(openPage(event));
  else if (isEngine(req.url)) event.respondWith(getEngine(req));
  else event.respondWith(getFile(req));
});

// The game page: the saved copy straight away, refreshed in the background
// (with its engine) for the next launch.
async function openPage(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(PAGE);
  const fromNetwork = fetch(event.request).then(async (res) => {
    const text = await gamePage(res);
    if (text) await savePage(cache, res.clone(), text).catch(() => { });
    return res;
  });
  if (saved) {
    event.waitUntil(fromNetwork.catch(() => { }));
    return saved;
  }
  return fromNetwork; // nothing saved yet: show whatever the network returns
}

// The engine: the saved copy of exactly this version, else the network.
async function getEngine(req) {
  const cache = await caches.open(CACHE);
  return (await cache.match(req)) || fetch(req);
}

// Icons and manifest: saved copy first.
async function getFile(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req, { ignoreSearch: true });
  return saved || fetch(req);
}
