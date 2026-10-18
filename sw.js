/*
 * Asterlie offline support.
 *
 * Keeps a copy of the game on the device so it opens without a connection.
 * Each launch also checks for a newer copy in the background; if one is
 * found, the next launch uses it.
 *
 * Only a page that registers this script is saved, so a sign-in page, an
 * error page or a Wi-Fi login portal can never replace the game.
 * If you change the icons or the manifest, bump VERSION.
 */
const VERSION = 'v4';
const CACHE = 'star-battle-' + VERSION;
const PAGE = './';
const PAGE_MARKER = "serviceWorker.register('sw.js')";
const FILES = [
  PAGE,
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

async function isGamePage(res) {
  return res.ok && res.type === 'basic' && (await res.clone().text()).includes(PAGE_MARKER);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async (file) => {
      const res = await fetch(new Request(file, { cache: 'reload' }));
      const type = res.headers.get('content-type') || '';
      const good = file === PAGE ? await isGamePage(res) : res.ok && !type.includes('text/html');
      if (!good) throw new Error('Could not save ' + file + ' (' + res.status + ')');
      await cache.put(file, await plain(res));
    }));
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
  event.respondWith(req.mode === 'navigate' ? openPage(event) : getFile(req));
});

// The game page: the saved copy straight away, refreshed in the background.
async function openPage(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(PAGE);
  const fromNetwork = fetch(event.request).then(async (res) => {
    if (await isGamePage(res)) await cache.put(PAGE, await plain(res.clone()));
    return res;
  });
  if (saved) {
    event.waitUntil(fromNetwork.catch(() => { }));
    return saved;
  }
  return fromNetwork; // nothing saved yet: show whatever the network returns
}

// Icons and manifest: saved copy first.
async function getFile(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req, { ignoreSearch: true });
  return saved || fetch(req);
}
