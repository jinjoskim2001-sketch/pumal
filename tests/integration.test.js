// Whole-product checks: the things no single module can test for itself.
// - every import names an export that exists
// - the service worker precaches exactly what the page can load, and nothing from tools/
// - the version constant is the same in sw.js and js/main.js
// - rule 0.1 (forbidden words) and rule 0.2 (relative URLs only) hold for everything that ships
// - the page still honours the DOM contract of SPEC section 7

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function walk(dir, skip = []) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (skip.includes(rel)) continue;
    if (entry.isDirectory()) out.push(...walk(rel, skip));
    else out.push(rel);
  }
  return out;
}

// Everything in the repository except the research notes, git, and OS litter.
const FILES = walk('.', ['.git', 'docs', 'node_modules']).filter((f) => !f.endsWith('.DS_Store'));
const TEXT = FILES.filter((f) => /\.(js|html|css|webmanifest|md|py|sh|json|txt)$/.test(f) || f === '.gitignore');

// Static imports, re-exports and dynamic imports with a literal specifier.
const IMPORT_RE = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]|export\s+(?:\{([^}]*)\}|\*)\s*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(source) {
  const out = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[3] || m[5] || m[6];
    const names = (m[2] || m[4] || '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push({ spec, names, wantsDefault: Boolean(m[1]) });
  }
  return out;
}

function parsePrecache() {
  const sw = read('sw.js');
  const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(list, 'sw.js has a PRECACHE list');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every relative import resolves to a file and to exports that exist', async () => {
  const sources = FILES.filter((f) => /^(js|tests)\/.*\.js$/.test(f) || /\.html$/.test(f));
  const problems = [];
  for (const file of sources) {
    for (const imp of importsOf(read(file))) {
      if (!imp.spec.startsWith('.')) {
        if (!imp.spec.startsWith('node:')) problems.push(`${file}: non-relative import ${imp.spec}`);
        continue;
      }
      const target = path.resolve(ROOT, path.dirname(file), imp.spec);
      if (!fs.existsSync(target)) { problems.push(`${file}: ${imp.spec} does not exist`); continue; }
      if (!imp.names.length && !imp.wantsDefault) continue;
      const mod = await import(pathToFileURL(target).href);
      if (imp.wantsDefault && !('default' in mod)) problems.push(`${file}: ${imp.spec} has no default export`);
      for (const name of imp.names) {
        if (!(name in mod)) problems.push(`${file}: ${imp.spec} does not export ${name}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the precache list is exactly what the page can load', () => {
  const precache = parsePrecache();

  for (const p of precache) {
    assert.ok(exists(p), `precached file exists: ${p}`);
    assert.ok(!/^(tools|tests|docs)\//.test(p), `dev file is not precached: ${p}`);
  }
  assert.equal(new Set(precache).size, precache.length, 'no duplicates');

  // What index.html pulls in: stylesheets, icons, the manifest and its icons, and the whole
  // module graph behind js/main.js (static and dynamic imports).
  const html = read('index.html');
  const needed = new Set();
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1])) needed.add(m[1]);
  }
  for (const icon of JSON.parse(read('manifest.webmanifest')).icons) needed.add(icon.src);
  const queue = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  while (queue.length) {
    const file = queue.pop();
    if (needed.has(file)) continue;
    needed.add(file);
    for (const imp of importsOf(read(file))) {
      if (imp.spec.startsWith('.')) queue.push(path.posix.join(path.posix.dirname(file), imp.spec));
    }
  }

  const missing = [...needed].filter((f) => !precache.includes(f)).sort();
  assert.deepEqual(missing, [], 'every file the page loads is precached');
  const extra = precache.filter((f) => !needed.has(f)).sort();
  assert.deepEqual(extra, [], 'nothing is precached that the page never loads');
});

test('the version constant is the same in sw.js and js/main.js', () => {
  const sw = /^const VERSION = '([^']+)';/m.exec(read('sw.js'));
  const main = /^const VERSION = '([^']+)';/m.exec(read('js/main.js'));
  assert.ok(sw && main);
  assert.equal(main[1], sw[1]);
});

test('rule 0.1: no forbidden word in any file or file name', () => {
  // Spelled in pieces so that this file passes its own check.
  const words = [
    'ta' + 'ma',
    'got' + 'chi',
    String.fromCharCode(0xB2E4, 0xB9C8, 0xACE0, 0xCE58),
    String.fromCharCode(0x305F, 0x307E, 0x3054),
  ];
  const re = new RegExp(words.join('|'), 'i');
  const hits = [];
  for (const file of FILES) {
    if (re.test(file)) hits.push(`file name: ${file}`);
    // Binary files are scanned too (as latin1): an icon must not carry the words in metadata.
    const body = fs.readFileSync(path.join(ROOT, file), TEXT.includes(file) ? 'utf8' : 'latin1');
    const m = re.exec(body);
    if (m) hits.push(`${file}: "${body.slice(Math.max(0, m.index - 20), m.index + 24).replace(/\s+/g, ' ')}"`);
  }
  assert.deepEqual(hits, []);
});

test('rule 0.2: shipped pages use relative URLs only', () => {
  const shipped = FILES.filter((f) => f === 'index.html' || f === 'sw.js' || f === 'manifest.webmanifest' || /^(js|css)\//.test(f));
  const rootAbsolute = /(?:src|href)=["']\/(?!\/)|url\(\s*["']?\/(?!\/)|(?:from|import\(|fetch\(|register\()\s*["']\/(?!\/)/;
  const hits = shipped.filter((f) => rootAbsolute.test(read(f)));
  assert.deepEqual(hits, []);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(!('id' in manifest), 'no id member (SPEC 10.2)');
});

test('index.html keeps the DOM contract and loads no dev harness', () => {
  const html = read('index.html');
  for (const id of ['stage', 'chrome', 'btnDex', 'brand', 'btnSettings', 'device', 'bezel', 'lcd', 'glass',
    'caption', 'keys', 'keyA', 'keyB', 'keyC', 'sheetRoot', 'gateRoot', 'toastRoot']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} is in the page`);
  }
  assert.ok(/<script type="module" src="js\/main\.js"><\/script>/.test(html));
  assert.ok(!/tools\/|demo-/.test(html), 'no reference to tools/ or a demo page');
  // The sheet and gate roots must be truly empty: their CSS hides them with :empty.
  assert.ok(/<div id="sheetRoot"><\/div>/.test(html));
  assert.ok(/<div id="gateRoot"><\/div>/.test(html));
});
