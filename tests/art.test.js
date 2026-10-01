// Contract tests for the pixel art (SPEC sections 4 and 12).
// Scenes, the dex and the icon tool index these bitmaps by key and assume fixed sizes, so a
// missing frame or a ragged row shows up here instead of as a blank or shifted creature.
import test from 'node:test';
import assert from 'node:assert/strict';

import { YOUNG } from '../js/art/young.js';
import { ADULTS } from '../js/art/adults.js';
import { ICONS, ITEMS, FONT_SMALL, FONT_BIG } from '../js/art/ui.js';
import * as sprites from '../js/sprites.js';
import { SPECIES } from '../js/data.js';

// SPEC section 4, in table order.
const SPECIES_IDS = [
  'mongsil', 'tongtong', 'mallang', 'saessak', 'kkabul', 'ppittak',
  'banjjak', 'narae', 'podong', 'dokkae', 'gureum', 'dwinggul', 'byeolbit', 'haessal',
];
const YOUNG_IDS = SPECIES_IDS.slice(0, 6);
const ADULT_IDS = SPECIES_IDS.slice(6);
const ART = { ...YOUNG, ...ADULTS };

const DIGITS = '0123456789'.split('');
const FONT_SMALL_GLYPHS = [...DIGITS, ':', '.', '-', '/', 'g', '!', '?', ' ', 'x'];
const FONT_BIG_GLYPHS = [...DIGITS, ':', ' '];

// ---- helpers ----

function isBitmap(v) {
  return Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string');
}

// Asserts the bitmap is a rectangle of '#' and '.' and returns [width, height].
function shape(bmp, label) {
  assert.ok(isBitmap(bmp), `${label}: not a bitmap (array of strings)`);
  const w = bmp[0].length;
  assert.ok(w > 0, `${label}: zero-width rows`);
  bmp.forEach((row, y) => {
    assert.equal(row.length, w, `${label}: row ${y} is ${row.length} wide, expected ${w}`);
    assert.match(row, /^[#.]+$/, `${label}: row ${y} has characters other than '#' and '.'`);
  });
  return [w, bmp.length];
}

function assertSize(bmp, w, h, label) {
  assert.deepEqual(shape(bmp, label), [w, h], `${label}: expected ${w}x${h}`);
}

function assertFits(bmp, maxW, maxH, label) {
  const [w, h] = shape(bmp, label);
  assert.ok(w <= maxW && h <= maxH, `${label}: ${w}x${h} does not fit ${maxW}x${maxH}`);
}

function ink(bmp) {
  return bmp.reduce((n, row) => n + row.split('#').length - 1, 0);
}

function assertNotEmpty(bmp, label) {
  assert.ok(ink(bmp) > 0, `${label}: no lit dots`);
}

// Number of cells that differ between two bitmaps of the same size.
function dotsApart(a, b) {
  let n = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) n++;
  }
  return n;
}

function creatureFrames(id) {
  const a = ART[id];
  return [
    ['idle[0]', a.idle?.[0]], ['idle[1]', a.idle?.[1]],
    ['happy', a.happy], ['upset', a.upset], ['eat', a.eat], ['sleep', a.sleep],
  ];
}

// Every bitmap reachable from a value, with its key path.
function walk(v, path, out = []) {
  if (isBitmap(v)) { out.push([path, v]); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`, out);
  return out;
}

// ---- creatures ----

test('young and adult files hold exactly the species of SPEC section 4, plus the egg', () => {
  assert.deepEqual(Object.keys(YOUNG).sort(), ['egg', ...YOUNG_IDS].sort());
  assert.deepEqual(Object.keys(ADULTS).sort(), [...ADULT_IDS].sort());
});

test('the species table in js/data.js and the art agree on the 14 ids', () => {
  assert.deepEqual(Object.keys(SPECIES).sort(), [...SPECIES_IDS].sort());
});

for (const id of SPECIES_IDS) {
  test(`${id}: idle[2], happy, upset, eat, sleep are 16x16 bitmaps`, () => {
    const a = ART[id];
    assert.ok(a, `${id}: missing`);
    assert.ok(Array.isArray(a.idle), `${id}.idle: missing`);
    assert.equal(a.idle.length, 2, `${id}.idle: expected 2 frames`);
    assert.deepEqual(Object.keys(a).sort(), ['eat', 'happy', 'idle', 'sleep', 'upset']);
    for (const [name, bmp] of creatureFrames(id)) {
      assertSize(bmp, 16, 16, `${id}.${name}`);
      assertNotEmpty(bmp, `${id}.${name}`);
    }
  });

  test(`${id}: every frame stands on the last row and the idle pair is two drawings`, () => {
    // Scenes place creatures by their bottom edge; a frame floating above row 15 would hover.
    for (const [name, bmp] of creatureFrames(id)) {
      assert.ok(bmp[15].includes('#'), `${id}.${name}: nothing on the bottom row`);
    }
    const a = ART[id];
    assert.ok(dotsApart(a.idle[0], a.idle[1]) > 0, `${id}: idle[0] and idle[1] are identical`);
    // Each mood must be visibly its own frame, not a copy of the portrait.
    for (const name of ['happy', 'upset', 'eat', 'sleep']) {
      assert.ok(dotsApart(a.idle[0], a[name]) >= 8, `${id}.${name}: barely differs from idle[0]`);
    }
  });
}

test('egg: idle[2] and crack[3], each 16x16', () => {
  const egg = ART.egg;
  assert.ok(egg, 'egg: missing');
  assert.deepEqual(Object.keys(egg).sort(), ['crack', 'idle']);
  assert.equal(egg.idle.length, 2, 'egg.idle: expected 2 frames');
  assert.equal(egg.crack.length, 3, 'egg.crack: expected 3 frames');
  egg.idle.forEach((bmp, i) => { assertSize(bmp, 16, 16, `egg.idle[${i}]`); assertNotEmpty(bmp, `egg.idle[${i}]`); });
  egg.crack.forEach((bmp, i) => { assertSize(bmp, 16, 16, `egg.crack[${i}]`); assertNotEmpty(bmp, `egg.crack[${i}]`); });
  assert.ok(dotsApart(egg.idle[0], egg.idle[1]) > 0, 'egg: idle frames are identical');
  // The crack must progress: no two stages alike, and none equal to the whole egg.
  const stages = [egg.idle[0], ...egg.crack];
  for (let i = 0; i < stages.length; i++) {
    for (let j = i + 1; j < stages.length; j++) {
      assert.ok(dotsApart(stages[i], stages[j]) > 0, `egg: crack stages ${i - 1} and ${j - 1} are identical`);
    }
  }
});

test('all 14 portraits (idle[0]) differ pairwise by at least 20 dots', () => {
  const tooClose = [];
  for (let i = 0; i < SPECIES_IDS.length; i++) {
    for (let j = i + 1; j < SPECIES_IDS.length; j++) {
      const a = SPECIES_IDS[i];
      const b = SPECIES_IDS[j];
      const n = dotsApart(ART[a].idle[0], ART[b].idle[0]);
      if (n < 20) tooClose.push(`${a}/${b}: ${n}`);
    }
  }
  assert.deepEqual(tooClose, []);
});

test('the egg is not mistaken for any creature portrait either', () => {
  for (const id of SPECIES_IDS) {
    assert.ok(dotsApart(ART.egg.idle[0], ART[id].idle[0]) >= 20, `egg/${id}: too close`);
  }
});

// ---- icons ----

test('ICONS: the eight menu icons of SPEC section 12, each 12x10', () => {
  const keys = ['food', 'play', 'clean', 'light', 'medicine', 'scold', 'status', 'call'];
  assert.deepEqual(Object.keys(ICONS).sort(), [...keys].sort());
  for (const k of keys) {
    assertSize(ICONS[k], 12, 10, `ICONS.${k}`);
    assertNotEmpty(ICONS[k], `ICONS.${k}`);
  }
  // Icons live at ghost alpha most of the time; two that share most cells would blur together.
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      assert.ok(dotsApart(ICONS[keys[i]], ICONS[keys[j]]) >= 20, `ICONS.${keys[i]}/${keys[j]}: too alike`);
    }
  }
});

// ---- items ----

// [key, frame count (0 = a single bitmap), size rule]. exact = SPEC states the size;
// max = SPEC says "or smaller" or only "small mark".
const ITEM_SPEC = [
  ['meal', 3, { exact: [8, 8] }],
  ['snack', 3, { exact: [8, 8] }],
  ['poop', 2, { exact: [8, 8] }],
  ['skull', 0, { exact: [8, 8] }],
  ['zzz', 2, { exact: [8, 8] }],
  ['heartFull', 0, { exact: [7, 6] }],
  ['heartEmpty', 0, { exact: [7, 6] }],
  ['starFull', 0, { exact: [7, 7] }],
  ['starEmpty', 0, { exact: [7, 7] }],
  ['pill', 0, { max: [8, 8] }],
  ['sparkle', 2, { max: [8, 8] }],
  ['heartPop', 0, { max: [8, 8] }],
  ['bang', 0, { max: [8, 8] }],
  ['sweat', 0, { max: [8, 8] }],
  ['note', 0, { max: [8, 8] }],
  ['arrow', 0, { exact: [5, 5] }],
  ['bulbOn', 0, { exact: [12, 12] }],
  ['bulbOff', 0, { exact: [12, 12] }],
  ['wave', 0, { exact: [8, 32] }],
  ['rock', 0, { exact: [12, 12] }],
  ['paper', 0, { exact: [12, 12] }],
  ['scissors', 0, { exact: [12, 12] }],
  ['star', 0, { exact: [6, 6] }],
  ['drop', 0, { exact: [6, 6] }],
  ['sun', 0, { max: [8, 8] }],
  ['moon', 0, { max: [8, 8] }],
  ['cake', 0, { max: [8, 8] }],
  ['scale', 0, { max: [8, 8] }],
  ['sitter', 0, { max: [8, 8] }],
  ['journeyBag', 0, { exact: [12, 12] }],
  ['bigStar', 0, { exact: [12, 12] }],
];

test('ITEMS: exactly the keys of SPEC section 12', () => {
  assert.deepEqual(Object.keys(ITEMS).sort(), ITEM_SPEC.map(([k]) => k).sort());
});

for (const [key, frames, rule] of ITEM_SPEC) {
  const sizeText = rule.exact ? rule.exact.join('x') : `at most ${rule.max.join('x')}`;
  test(`ITEMS.${key}: ${frames ? `${frames} frames, ` : ''}${sizeText}`, () => {
    const v = ITEMS[key];
    assert.ok(v, `ITEMS.${key}: missing`);
    let list;
    if (frames) {
      assert.ok(Array.isArray(v) && !isBitmap(v), `ITEMS.${key}: expected an array of frames`);
      assert.equal(v.length, frames, `ITEMS.${key}: expected ${frames} frames`);
      list = v.map((bmp, i) => [`ITEMS.${key}[${i}]`, bmp]);
    } else {
      list = [[`ITEMS.${key}`, v]];
    }
    for (const [label, bmp] of list) {
      if (rule.exact) assertSize(bmp, rule.exact[0], rule.exact[1], label);
      else assertFits(bmp, rule.max[0], rule.max[1], label);
      assertNotEmpty(bmp, label);
    }
    // Frames of one animation share a box, or the item would jitter when it animates.
    if (frames) {
      const first = shape(list[0][1], list[0][0]);
      for (const [label, bmp] of list) assert.deepEqual(shape(bmp, label), first, `${label}: frame size differs`);
    }
  });
}

test('ITEMS: pairs that carry meaning by contrast stay clearly apart', () => {
  const pairs = [
    ['heartFull', 'heartEmpty', 6], ['starFull', 'starEmpty', 6], ['bulbOn', 'bulbOff', 20],
    ['star', 'drop', 12], ['rock', 'paper', 20], ['rock', 'scissors', 20], ['paper', 'scissors', 20],
  ];
  for (const [a, b, min] of pairs) {
    const n = dotsApart(ITEMS[a], ITEMS[b]);
    assert.ok(n >= min, `ITEMS.${a}/${b}: only ${n} dots apart`);
  }
  // The wave is tiled down the matrix in 8-row steps during the cleaning sweep.
  for (let y = 8; y < 32; y++) assert.equal(ITEMS.wave[y], ITEMS.wave[y - 8], `ITEMS.wave: row ${y} breaks the 8-row tile`);
});

// ---- fonts ----

function checkFont(font, name, glyphs, height, digitWidth) {
  assert.deepEqual(Object.keys(font).sort(), [...glyphs].sort(), `${name}: glyph set`);
  for (const ch of glyphs) {
    const label = `${name}['${ch}']`;
    const [w, h] = shape(font[ch], label);
    assert.equal(h, height, `${label}: height ${h}, expected ${height}`);
    assert.ok(w >= 1 && w <= digitWidth, `${label}: width ${w} outside 1..${digitWidth}`);
    if (ch === ' ') assert.equal(ink(font[ch]), 0, `${label}: the space must be blank`);
    else assertNotEmpty(font[ch], label);
  }
  // Digits are monospaced so numbers line up and a ticking clock does not shift.
  for (const d of DIGITS) assert.equal(font[d][0].length, digitWidth, `${name}['${d}']: width`);
}

test('FONT_SMALL: every listed glyph, 5 rows tall, digits 3 wide', () => {
  checkFont(FONT_SMALL, 'FONT_SMALL', FONT_SMALL_GLYPHS, 5, 3);
});

test('FONT_BIG: every listed glyph, 9 rows tall, digits 5 wide', () => {
  checkFont(FONT_BIG, 'FONT_BIG', FONT_BIG_GLYPHS, 9, 5);
  // Blinking the colon swaps ':' for ' '; equal widths keep the digits still.
  assert.equal(FONT_BIG[':'][0].length, FONT_BIG[' '][0].length, "FONT_BIG: ':' and ' ' widths differ");
});

test('fonts: no two digits can be confused by a single dot', () => {
  for (const [font, name, min] of [[FONT_SMALL, 'FONT_SMALL', 2], [FONT_BIG, 'FONT_BIG', 5]]) {
    const tooClose = [];
    for (let i = 0; i < 10; i++) {
      for (let j = i + 1; j < 10; j++) {
        const n = dotsApart(font[DIGITS[i]], font[DIGITS[j]]);
        if (n < min) tooClose.push(`${DIGITS[i]}/${DIGITS[j]}: ${n}`);
      }
    }
    assert.deepEqual(tooClose, [], `${name}: digits fewer than ${min} dots apart`);
  }
});

// ---- whole set ----

test('no bitmap anywhere in the art is empty or ragged', () => {
  const all = [
    ...walk(YOUNG, 'YOUNG'), ...walk(ADULTS, 'ADULTS'), ...walk(ICONS, 'ICONS'),
    ...walk(ITEMS, 'ITEMS'), ...walk(FONT_SMALL, 'FONT_SMALL'), ...walk(FONT_BIG, 'FONT_BIG'),
  ];
  // 41 young + 48 adult bitmaps (14 creatures and the egg), 8 icons, at least one bitmap per
  // item key, 19 + 12 glyphs: a sudden drop means a key was lost.
  assert.ok(all.length >= 41 + 48 + 8 + 31 + 19 + 12, `only ${all.length} bitmaps found`);
  for (const [path, bmp] of all) {
    shape(bmp, path);
    const isSpace = /^FONT_(SMALL|BIG)\. $/.test(path);
    if (!isSpace) assertNotEmpty(bmp, path);
  }
});

test('js/sprites.js re-exports the same art under the names scenes use', () => {
  assert.deepEqual(Object.keys(sprites.SPECIES_ART).sort(), ['egg', ...SPECIES_IDS].sort());
  for (const id of ['egg', ...SPECIES_IDS]) assert.equal(sprites.SPECIES_ART[id], ART[id], `SPECIES_ART.${id}`);
  assert.equal(sprites.ICONS, ICONS);
  assert.equal(sprites.ITEMS, ITEMS);
  assert.equal(sprites.FONT_SMALL, FONT_SMALL);
  assert.equal(sprites.FONT_BIG, FONT_BIG);
});
