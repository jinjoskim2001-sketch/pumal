// Service worker for 품알. Bump VERSION on every deploy (and the matching constant in
// js/main.js): a byte-different file is what makes the browser install the new worker.
// This file must never be renamed or removed — Safari unregisters a worker whose script 404s.
const VERSION = 'pumal-v1';

// Every cache this app owns starts with this. The origin is shared with other project
// sites under the same github.io user, so cleanup must never touch foreign caches.
const PREFIX = 'pumal-';
const FONT_CACHE = 'pumal-font-1.601';
const FONT_URL = 'https://cdn.jsdelivr.net/gh/neodgm/neodgm-webfont@1.601/neodgm/neodgm.woff2';

// Everything the app needs to run offline. Relative to this file, so it works under
// https://<user>.github.io/<repo>/ and on localhost alike.
const SHELL = './';
const PRECACHE = [
  'manifest.webmanifest',
  'css/app.css',
  'css/sheets.css',
  'css/gate.css',
  'js/main.js',
  'js/engine.js',
  'js/data.js',
  'js/storage.js',
  'js/lcd.js',
  'js/sprites.js',
  'js/art/young.js',
  'js/art/adults.js',
  'js/art/ui.js',
  'js/scenes.js',
  'js/minigames.js',
  'js/debug.js',
  'js/ui.js',
  'js/audio.js',
  'js/haptics.js',
  'js/install.js',
  'icons/apple-touch-icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
];

// Files the page can boot without. Everything else in PRECACHE is required: the app is one
// static module graph, so a single missing script or stylesheet means a dead screen.
const isOptional = (path) =>
  path.startsWith('icons/') || path === 'manifest.webmanifest' || path === 'js/debug.js';

const SCOPE = new URL('./', self.location.href);

// cache:'reload' skips the HTTP cache; GitHub Pages serves everything with max-age=600 and
// a stale file frozen into a fresh precache would survive until the next deploy.
function fetchFresh(path) {
  return fetch(new Request(new URL(path, SCOPE).href, { cache: 'reload' }));
}

// A non-OK answer (404, 5xx) for a required file fails the install: the previous worker and
// its complete cache stay in charge, and the next update check (launch / return to visible)
// tries again. Activating instead would delete that complete cache and leave a page that
// cannot boot. Only the optional files above may be skipped.
// A network failure is retried once and then fails the install, for any file.
async function precacheOne(cache, path, required) {
  let response;
  try {
    response = await fetchFresh(path);
  } catch {
    response = await fetchFresh(path);
  }
  if (!response.ok) {
    if (required) throw new Error(`precache: ${path} answered ${response.status}`);
    return false;
  }
  await cache.put(new URL(path, SCOPE).href, response);
  return true;
}

async function precacheFont() {
  try {
    const cache = await caches.open(FONT_CACHE);
    if (await cache.match(FONT_URL)) return;
    const response = await fetch(FONT_URL, { mode: 'cors', credentials: 'omit' });
    if (response.ok) await cache.put(FONT_URL, response);
  } catch {
    // Best effort only: the page falls back to system fonts.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await precacheOne(cache, SHELL, true);
      await Promise.all(PRECACHE.map((path) => precacheOne(cache, path, !isOptional(path))));
      // Not awaited: a slow CDN must not hold the install open.
      precacheFont();
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && name !== VERSION && name !== FONT_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function fromShell(request) {
  const cache = await caches.open(VERSION);
  // ignoreSearch: ?play=1, ?shot=…, ?openExternalBrowser=1 and ?v=… all map to the same file.
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    // Heal a precache that skipped an optional file (or a file added later) the first time it is used.
    // (A redirected response cannot be replayed for a navigation, so those are left alone.)
    if (response.ok && response.type === 'basic' && !response.redirected) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    if (request.mode === 'navigate') {
      const shell = await cache.match(SCOPE.href);
      if (shell) return shell;
    }
    throw err;
  }
}

async function fromFontCache(request) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(FONT_URL);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(FONT_URL, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.href === FONT_URL) {
    event.respondWith(fromFontCache(request));
    return;
  }
  // Same origin, inside our folder only; everything else goes straight to the network.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  event.respondWith(fromShell(request));
});
