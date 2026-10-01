// Runs sw.js inside a vm with a fake Cache Storage and fetch, so the install / activate /
// fetch rules can be checked without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const BASE = 'https://example.github.io/pumal/';
const FONT = 'https://cdn.jsdelivr.net/gh/neodgm/neodgm-webfont@1.601/neodgm/neodgm.woff2';
// Read from the file so a deploy that bumps the version does not break these tests.
const VERSION = /^const VERSION = '([^']+)';$/m.exec(SOURCE)[1];

function makeResponse(status = 200, body = 'ok') {
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    redirected: false,
    body,
    clone() {
      return this;
    },
  };
}

function stripSearch(url) {
  const u = new URL(url);
  u.search = '';
  return u.href;
}

/**
 * @param {(url: string, request: object) => object} serve  returns a response or throws
 * @param {Record<string, string[]>} existing  cache name → urls already stored
 */
function boot(serve, existing = {}) {
  const stores = new Map();
  for (const [name, urls] of Object.entries(existing)) {
    stores.set(name, new Map(urls.map((u) => [u, makeResponse()])));
  }
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const map = stores.get(name);
      return {
        async put(req, res) {
          map.set(keyOf(req), res);
        },
        async match(req, opts = {}) {
          const key = keyOf(req);
          if (map.has(key)) return map.get(key);
          if (opts.ignoreSearch) {
            for (const [k, v] of map) if (stripSearch(k) === stripSearch(key)) return v;
          }
          return undefined;
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };

  const listeners = {};
  const flags = { skipWaiting: 0, claim: 0 };
  const fetchLog = [];
  class FakeRequest {
    constructor(url, init = {}) {
      this.url = url;
      this.method = init.method || 'GET';
      this.cache = init.cache || 'default';
      this.mode = init.mode || 'cors';
    }
  }
  const self = {
    location: { href: `${BASE}sw.js` },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    async skipWaiting() {
      flags.skipWaiting += 1;
    },
    clients: {
      async claim() {
        flags.claim += 1;
      },
    },
  };
  const fetch = async (input, init = {}) => {
    const request = typeof input === 'string' ? new FakeRequest(input, init) : input;
    fetchLog.push({ url: request.url, cache: request.cache });
    return serve(request.url, request);
  };

  vm.runInNewContext(SOURCE, { self, caches, fetch, URL, Request: FakeRequest, Promise, Error, console });

  const dispatch = async (type, extra = {}) => {
    let waited;
    let responded;
    listeners[type]({
      ...extra,
      waitUntil(p) {
        waited = p;
      },
      respondWith(p) {
        responded = p;
      },
    });
    return { waited, responded };
  };

  return { stores, flags, fetchLog, dispatch, FakeRequest };
}

test('the version constant is on its own line at the top', () => {
  assert.match(SOURCE, /^const VERSION = 'pumal-v\d+';$/m);
});

test('no root-absolute paths are precached', () => {
  const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(SOURCE)[1];
  const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 20);
  for (const p of paths) assert.ok(!p.startsWith('/') && !p.includes('://'), p);
  for (const need of ['js/main.js', 'js/engine.js', 'js/install.js', 'css/app.css', 'css/gate.css', 'manifest.webmanifest']) {
    assert.ok(paths.includes(need), need);
  }
  // The style anchor is not shipped.
  assert.ok(!paths.includes('js/art/anchor.js'));
});

test('install: a 404 on an optional file is skipped, everything else is cached fresh', async () => {
  const missing = new Set([`${BASE}js/debug.js`, `${BASE}icons/icon-512.png`, `${BASE}manifest.webmanifest`]);
  const sw = boot((url) => (missing.has(url) ? makeResponse(404) : makeResponse(200)));
  const { waited } = await sw.dispatch('install');
  await waited;

  const cached = sw.stores.get(VERSION);
  assert.ok(cached.has(BASE), 'the page itself is cached as ./');
  assert.ok(cached.has(`${BASE}js/main.js`));
  assert.ok(cached.has(`${BASE}css/sheets.css`));
  assert.ok(cached.has(`${BASE}icons/apple-touch-icon-180.png`));
  for (const url of missing) assert.ok(!cached.has(url), url);
  assert.equal(sw.flags.skipWaiting, 1);

  const shellFetches = sw.fetchLog.filter((f) => f.url.startsWith(BASE));
  assert.ok(shellFetches.length >= 20);
  for (const f of shellFetches) assert.equal(f.cache, 'reload', f.url);
});

test('install: a non-OK answer for a file the page needs fails the install', async () => {
  // Every script and stylesheet is needed to boot. Installing without one would let activate
  // delete the complete previous cache and reload the page into a dead shell.
  const cases = [
    [`${BASE}js/scenes.js`, 503],
    [`${BASE}css/sheets.css`, 404],
    [`${BASE}js/art/young.js`, 500],
    [`${BASE}js/ui.js`, 404],
  ];
  for (const [bad, status] of cases) {
    const previous = 'pumal-v0-previous';
    const sw = boot((url) => (url === bad ? makeResponse(status) : makeResponse(200)), {
      [previous]: [BASE, bad],
    });
    await assert.rejects((await sw.dispatch('install')).waited, /precache/, bad);
    assert.equal(sw.flags.skipWaiting, 0, bad);
    assert.ok(sw.stores.get(previous).has(bad), 'the previous cache is untouched');
    assert.ok(!sw.stores.get(VERSION).has(bad), 'the bad answer is not stored');
  }
});

test('install: only files the page can boot without are optional', () => {
  const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(SOURCE)[1];
  const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const isOptional = vm.runInNewContext(`${/const isOptional = [\s\S]*?;\n/.exec(SOURCE)[0]} isOptional`);
  const optional = paths.filter((p) => isOptional(p));
  assert.ok(optional.length > 0);
  for (const p of optional) assert.match(p, /^icons\/|^manifest\.webmanifest$|^js\/debug\.js$/, p);
  for (const p of paths.filter((x) => /\.(js|css)$/.test(x) && x !== 'js/debug.js')) {
    assert.equal(isOptional(p), false, p);
  }
});

test('install: the font failing never fails the install', async () => {
  const sw = boot((url) => {
    if (url === FONT) throw new TypeError('offline');
    return makeResponse(200);
  });
  const { waited } = await sw.dispatch('install');
  await waited;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.flags.skipWaiting, 1);
  assert.ok(!sw.stores.get('pumal-font-1.601')?.has(FONT));
});

test('install: a missing page fails the install so the old worker stays', async () => {
  const sw = boot((url) => (url === BASE ? makeResponse(404) : makeResponse(200)));
  const { waited } = await sw.dispatch('install');
  await assert.rejects(waited);
  assert.equal(sw.flags.skipWaiting, 0);
});

test('install: one network hiccup is retried, a dead network fails the install', async () => {
  let first = true;
  const flaky = boot((url) => {
    if (url === `${BASE}js/engine.js` && first) {
      first = false;
      throw new TypeError('reset');
    }
    return makeResponse(200);
  });
  await (await flaky.dispatch('install')).waited;
  assert.ok(flaky.stores.get(VERSION).has(`${BASE}js/engine.js`));

  const dead = boot((url) => {
    if (url === `${BASE}js/engine.js`) throw new TypeError('offline');
    return makeResponse(200);
  });
  await assert.rejects((await dead.dispatch('install')).waited);
  assert.equal(dead.flags.skipWaiting, 0);
});

test('activate: only our own old caches are deleted', async () => {
  const sw = boot(() => makeResponse(200), {
    'pumal-v0-old': [BASE],
    [VERSION]: [BASE],
    'pumal-font-1.601': [FONT],
    'pumal-font-1.500': [FONT],
    'other-site-v3': ['https://example.github.io/other/'],
  });
  await (await sw.dispatch('activate')).waited;
  assert.deepEqual([...sw.stores.keys()].sort(), ['other-site-v3', 'pumal-font-1.601', VERSION].sort());
  assert.equal(sw.flags.claim, 1);
});

test('fetch: cache first, ignoring the query string', async () => {
  const sw = boot(() => {
    throw new TypeError('offline');
  }, { [VERSION]: [BASE, `${BASE}js/main.js`] });

  const nav = new sw.FakeRequest(`${BASE}?play=1&shot=idle`, { mode: 'navigate' });
  const a = await sw.dispatch('fetch', { request: nav });
  assert.equal((await a.responded).ok, true);

  const script = new sw.FakeRequest(`${BASE}js/main.js?v=2`);
  const b = await sw.dispatch('fetch', { request: script });
  assert.equal((await b.responded).ok, true);
  assert.equal(sw.fetchLog.length, 0, 'nothing went to the network');
});

test('fetch: offline navigation to an uncached in-scope URL falls back to the page', async () => {
  const sw = boot(() => {
    throw new TypeError('offline');
  }, { [VERSION]: [BASE] });
  const nav = new sw.FakeRequest(`${BASE}index.html`, { mode: 'navigate' });
  const { responded } = await sw.dispatch('fetch', { request: nav });
  assert.equal((await responded).ok, true);

  const asset = new sw.FakeRequest(`${BASE}js/nope.js`);
  const miss = await sw.dispatch('fetch', { request: asset });
  await assert.rejects(miss.responded);
});

test('fetch: a miss goes to the network and heals the cache', async () => {
  const sw = boot(() => makeResponse(200), { [VERSION]: [BASE] });
  const req = new sw.FakeRequest(`${BASE}js/ui.js`);
  const { responded } = await sw.dispatch('fetch', { request: req });
  assert.equal((await responded).ok, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw.stores.get(VERSION).has(`${BASE}js/ui.js`));
});

test('fetch: other origins, other folders and non-GET are left alone', async () => {
  const sw = boot(() => makeResponse(200), { [VERSION]: [BASE] });
  const cases = [
    new sw.FakeRequest('https://example.github.io/other-project/app.js'),
    new sw.FakeRequest('https://cdn.example.com/x.js'),
    new sw.FakeRequest(`${BASE}js/main.js`, { method: 'POST' }),
  ];
  for (const request of cases) {
    const { responded } = await sw.dispatch('fetch', { request });
    assert.equal(responded, undefined, request.url);
  }
});

test('fetch: the web font is cached at runtime in its own cache', async () => {
  const sw = boot(() => makeResponse(200));
  const req = new sw.FakeRequest(FONT);
  const { responded } = await sw.dispatch('fetch', { request: req });
  assert.equal((await responded).ok, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw.stores.get('pumal-font-1.601').has(FONT));
});
