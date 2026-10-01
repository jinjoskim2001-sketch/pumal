// js/scenes.js and js/minigames.js against the real engine and a fake LCD, and (at the end)
// js/main.js booted against a fake page.
// The fake LCD counts lit dots that fall outside the 48x32 matrix, which is how "a sprite is
// cut off at the edge" shows up without looking at a screenshot. What a scene looks like is
// still checked by eye with tools/shot.sh "?play=1&shot=<name>".
import test from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../js/engine.js';
import { SPECIES, SPECIES_IDS, AWAY_CAP_MIN } from '../js/data.js';
import { COLS, ROWS } from '../js/lcd.js';
import { createScenes } from '../js/scenes.js';
import { createGame, inkBox } from '../js/minigames.js';
import { SPECIES_ART } from '../js/sprites.js';
import { exportCode } from '../js/storage.js';
// Loaded here so that js/main.js finds them in the module cache when it imports them lazily.
import '../js/ui.js';
import '../js/debug.js';

const DAY = 86400000;
const NOON = Date.UTC(2026, 9, 1, 3, 0, 0);       // 12:00 at UTC+9, inside the default awake window

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeLcd() {
  const grid = new Uint8Array(COLS * ROWS);
  const lcd = {
    clipped: 0, tint: 'pea', backdrop: null, icons: { selected: -1, lit: [] },
    drawn: [],                                  // the bitmaps of the frame being drawn
    clear() { grid.fill(0); lcd.clipped = 0; lcd.drawn.length = 0; },
    dot(x, y, on = true) { put(Math.round(x), Math.round(y), on); },
    sprite(bmp, x, y, opts = {}) {
      lcd.drawn.push(bmp);
      const { flipX = false, invert = false, clear = false } = opts;
      for (let r = 0; r < bmp.length; r++) {
        const row = bmp[r];
        for (let c = 0; c < row.length; c++) {
          const ink = row[flipX ? row.length - 1 - c : c] === '#';
          if (invert) put(x + c, y + r, !ink);
          else if (ink) put(x + c, y + r, true);
          else if (clear) put(x + c, y + r, false);
        }
      }
    },
    rect(x, y, w, h, on = true) { for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) put(x + c, y + r, on); },
    frame(x, y, w, h) { lcd.rect(x, y, w, 1); lcd.rect(x, y + h - 1, w, 1); lcd.rect(x, y, 1, h); lcd.rect(x + w - 1, y, 1, h); },
    textWidth(str, font) {
      let w = 0;
      for (let i = 0; i < str.length; i++) w += (i ? 1 : 0) + (font[str[i]] ? font[str[i]][0].length : font[' '][0].length);
      return w;
    },
    text(str, x, y, font) {
      let cx = x;
      for (let i = 0; i < str.length; i++) {
        if (i) cx += 1;
        const g = font[str[i]];
        if (g) { lcd.sprite(g, cx, y); cx += g[0].length; } else cx += font[' '][0].length;
      }
      return cx;
    },
    present() {}, snap() {},
    setTint(name) { lcd.tint = name; },
    setBackdrop(name) { lcd.backdrop = name; },
    setIcons() {},
    setIconState(s) { Object.assign(lcd.icons, s); },
    lit() { let n = 0; for (const v of grid) n += v; return n; },
    hash() { let h = 0; for (let i = 0; i < grid.length; i++) if (grid[i]) h = (Math.imul(h, 31) + i) | 0; return h; },
  };
  function put(x, y, on) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) { if (on) lcd.clipped++; return; }
    grid[y * COLS + x] = on ? 1 : 0;
  }
  return lcd;
}

// A miniature of js/main.js: real engine, fake everything else.
function rig({ state, now = NOON, prefs, seed = 7 } = {}) {
  const lcd = fakeLcd();
  const rng = mulberry32(seed);
  const world = {
    lcd, now, sounds: [], captions: [], caption: '', shakes: 0, sheet: null, opened: [],
    prefs: { sound: true, haptics: true, skin: 'milk', tint: 'pea', solid: false, trial: false, seenGuide: true, ...prefs },
    state: state || engine.newGame(now, { tzOffsetMin: 540 }),
  };
  const host = {
    lcd, frozen: true, prefs: world.prefs,
    ui: {
      open(name, opts) { world.opened.push({ name, opts }); world.sheet = name; },
      close() { world.sheet = null; },
      isOpen: () => world.sheet !== null,
      toast() {},
    },
    view: () => engine.view(world.state, world.now),
    state: () => world.state,
    act(action, payload) {
      const r = engine.act(world.state, action, payload, world.now, { rng });
      world.scenes.onEvents(r.events, { away: false });
      world.scenes.refresh();
      return r;
    },
    setPrefs(patch) { Object.assign(world.prefs, patch); },
    sound(name) { world.sounds.push(name); },
    setCaption(text) { if (text !== world.caption) { world.caption = text; world.captions.push(text); } },
    shake() { world.shakes++; },
    now: () => world.now,
    rng,
  };
  world.scenes = createScenes(host);
  world.view = host.view;
  world.act = host.act;
  world.keys = (...ks) => ks.forEach((k) => world.scenes.key(k, new Set([k])));
  // Steps the scene clock and fails on the first frame that draws outside the matrix.
  world.run = (ticks, { strict = true } = {}) => {
    for (let i = 0; i < ticks; i++) {
      world.scenes.step(1);
      if (strict) assert.equal(lcd.clipped, 0, `clipped dots in scene "${world.scenes.name}" (caption "${world.caption}")`);
    }
  };
  return world;
}

function grown(id, patch = {}, now = NOON) {
  const state = engine.newGame(now - 3 * DAY, { tzOffsetMin: 540 });
  state.lastTick = now;
  const sp = SPECIES[id];
  Object.assign(state.pet, {
    species: id, stage: sp.stage, name: '가나다라마바', hunger: 4, happy: 4, weight: sp.baseWeight + 1,
    ageDays: 3, stageAwakeMin: 30, hungerTimer: sp.hungerEvery, happyTimer: sp.happyEvery,
    poopTimer: sp.poopEvery || 0, lastWakeAt: now - 3600000, eggTaps: 5, discipline: 2,
  }, patch);
  engine.advance(state, now, { live: true });
  return state;
}

const chars = (s) => Array.from(s).length;

// Which creatures (or the egg) the frame on the glass shows, by the bitmaps it drew.
const FRAME_OWNER = new Map();
for (const [id, art] of Object.entries(SPECIES_ART)) {
  for (const value of Object.values(art)) {
    for (const bmp of Array.isArray(value[0]) ? value : [value]) FRAME_OWNER.set(bmp, id);
  }
}
const showing = (world) => [...new Set(world.lcd.drawn.map((bmp) => FRAME_OWNER.get(bmp)).filter(Boolean))];

const microtasks = () => new Promise((resolve) => setImmediate(resolve));

function assertCaptions(world) {
  for (const c of world.captions) assert.ok(chars(c) <= 18, `caption too long (${chars(c)}): "${c}"`);
}

// ---- the home scene -----------------------------------------------------------------------

test('every creature wanders, hops and shows every mood without leaving the matrix', () => {
  const moods = [
    {},
    { hunger: 0, calls: { hunger: 100, happy: null, lights: null, tantrum: null } },
    { sick: { cause: 'dirty', doses: 2, awakeMin: 5, mistakes: 0 }, poop: [10] },
    { poop: [10, 20, 30, 40], happy: 2 },
    { calls: { hunger: null, happy: null, lights: null, tantrum: 10 } },
  ];
  for (const id of SPECIES_IDS) {
    moods.forEach((patch, i) => {
      const w = rig({ state: grown(id, patch), seed: 11 + i });
      w.scenes.start();
      assert.equal(w.scenes.name, 'idle');
      w.run(160);
      assert.ok(w.lcd.lit() > 20, `${id}: something is drawn`);
      assertCaptions(w);
    });
  }
});

test('the creature really moves and turns while idle', () => {
  const w = rig({ state: grown('tongtong'), seed: 3 });
  w.scenes.start();
  const seen = new Set();
  for (let i = 0; i < 400; i++) { w.scenes.step(1); seen.add(w.lcd.hash()); }
  assert.ok(seen.size > 20, `the picture keeps changing (${seen.size} different frames)`);
});

test('asleep with the light off uses the glow tint; with the light on it asks for the light', () => {
  const night = Date.UTC(2026, 9, 1, 14, 40, 0);   // 23:40 at UTC+9
  const dark = rig({ state: grown('tongtong', { asleep: true, lightsOn: false }, night), now: night });
  dark.scenes.start();
  dark.run(8);
  assert.equal(dark.lcd.tint, 'glow');
  assert.match(dark.caption, /자는 중/);

  const lit = rig({ state: grown('tongtong', { asleep: true, lightsOn: true, calls: { hunger: null, happy: null, lights: 10, tantrum: null } }, night), now: night });
  lit.scenes.start();
  lit.run(2);
  assert.equal(lit.lcd.tint, 'pea');
  assert.equal(lit.caption, '졸려요… 불 꺼 주세요');
  const blink = new Set();
  for (let i = 0; i < 4; i++) { lit.scenes.step(1); blink.add(lit.lcd.icons.lit.length); }
  assert.deepEqual([...blink].sort(), [0, 1], 'the call icon blinks');
});

// ---- keys and menu ----------------------------------------------------------------------------

test('A cycles the seven icons and back to none; C deselects; B with nothing selected shows the clock', () => {
  const w = rig({ state: grown('kkabul') });
  w.scenes.start();
  const order = [];
  for (let i = 0; i < 8; i++) { w.keys('A'); order.push(w.scenes.selected); }
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, -1]);
  w.keys('A', 'A', 'C');
  assert.equal(w.scenes.selected, -1);
  w.keys('B');
  assert.equal(w.scenes.name, 'clock');
  w.run(3);
  w.keys('C');
  assert.equal(w.scenes.name, 'idle');
  assert.ok(w.sounds.includes('key'));
});

test('the selection times out after 12 seconds', () => {
  const w = rig({ state: grown('kkabul') });
  w.scenes.start();
  w.keys('A');
  w.run(47);
  assert.equal(w.scenes.selected, 0);
  w.run(2);
  assert.equal(w.scenes.selected, -1);
});

test('first run: taps crack the egg, it hatches, the name sheet opens, then the guide teaches the keys', () => {
  const w = rig({ prefs: { seenGuide: false } });
  w.scenes.start();
  assert.equal(w.scenes.name, 'egg');
  assert.equal(w.caption, '알을 톡톡 두드려 보세요');
  w.keys('B', 'A', 'C');
  w.scenes.tap({ zone: 'matrix', x: 20, y: 20 });
  assert.equal(w.scenes.name, 'egg');
  w.keys('B');
  assert.equal(w.scenes.name, 'hatching');
  w.run(2);
  assert.ok(w.sounds.includes('hatch'));
  w.run(16);
  assert.equal(w.scenes.name, 'naming');
  assert.deepEqual(w.opened, [], 'the sheet waits until the presses have stopped for a second');
  w.run(4);
  assert.deepEqual(w.opened.map((o) => o.name), ['name']);
  assert.equal(w.opened[0].opts.first, true);
  w.run(4);
  assert.equal(w.scenes.name, 'naming', 'waits while the sheet is open');
  w.act('name', { name: '콩이' });
  w.sheet = null;
  w.run(1);
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.caption, 'A로 밥을 골라 B! C는 취소');
  w.keys('A', 'B');
  assert.equal(w.scenes.name, 'choice');
  w.keys('B');
  assert.equal(w.scenes.name, 'eating');
  assert.equal(w.prefs.seenGuide, true);
  assert.equal(w.view().hunger, 2);
  w.run(14);
  assert.equal(w.scenes.name, 'idle');
  assert.notEqual(w.caption, 'A로 밥을 골라 B! C는 취소');
  assertCaptions(w);
});

test('a press during an animation ends it instead of being lost, and A goes on to the menu', () => {
  const w = rig({ state: grown('tongtong', { hunger: 1, discipline: 4 }) });
  w.scenes.start();
  w.keys('A', 'B', 'B');
  assert.equal(w.scenes.name, 'eating');
  w.keys('A');
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.scenes.selected, 1, 'A moved on from food to play');
});

test('refusals: full, asleep, not sick, nothing to clean, unfair scold', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  w.keys('A', 'B', 'B');
  assert.equal(w.scenes.name, 'refuse');
  assert.equal(w.caption, '배불러요!');
  assert.equal(w.shakes, 1);
  assert.ok(w.sounds.includes('deny'));
  w.run(8);
  assert.equal(w.scenes.name, 'idle');

  w.scenes.tap({ zone: 'icon', index: 4 });
  assert.equal(w.caption, '아픈 데가 없어요');
  w.run(8);
  w.scenes.tap({ zone: 'icon', index: 2 });
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.caption, '이미 깨끗해요!');
  w.run(10);
  w.scenes.tap({ zone: 'icon', index: 5 });
  assert.equal(w.scenes.name, 'idle', 'with no tantrum the first touch on 훈육 only selects it');
  assert.equal(w.scenes.selected, 5);
  assert.equal(w.caption, '훈육하기 · B로 결정');
  assert.equal(w.view().happy, 4);
  w.scenes.tap({ zone: 'icon', index: 5 });
  assert.equal(w.scenes.name, 'scolding');
  w.run(4);
  assert.equal(w.caption, '잘못한 게 없는데… 시무룩');
  assert.equal(w.view().happy, 3);
  w.run(8);
  assertCaptions(w);
});

test('care actions: clean sweeps the mess, medicine cures, a fair scold raises discipline', () => {
  const w = rig({ state: grown('saessak', { poop: [5, 9, 12], sick: { cause: 'dirty', doses: 2, awakeMin: 3, mistakes: 0 } }) });
  w.scenes.start();
  w.scenes.tap({ zone: 'icon', index: 2 });
  assert.equal(w.scenes.name, 'cleaning');
  assert.equal(w.view().poop, 0);
  w.run(15, { strict: false });               // the wave enters and leaves through the edges
  assert.equal(w.scenes.name, 'idle');
  w.scenes.tap({ zone: 'icon', index: 4 });
  assert.equal(w.scenes.name, 'medicine');
  w.run(13);
  assert.equal(w.caption === '약이 더 필요해요' || w.scenes.name === 'idle', true);
  w.scenes.tap({ zone: 'icon', index: 4 });
  w.run(6);
  assert.equal(w.caption, '다 나았어요!');
  assert.equal(w.view().sick, false);
  w.run(8);

  w.state.pet.calls.tantrum = 10;
  w.scenes.tap({ zone: 'icon', index: 5 });
  assert.equal(w.scenes.name, 'scolding', 'during a tantrum one touch scolds');
  assert.equal(w.view().discipline, 3);
  w.run(11);
  assert.equal(w.scenes.name, 'idle');
  assertCaptions(w);
});

test('a tantrum refuses the meal loudly', () => {
  const w = rig({ state: grown('tongtong', { hunger: 2, calls: { hunger: null, happy: null, lights: null, tantrum: 12 } }) });
  w.scenes.start();
  assert.equal(w.caption, '싫어! 싫어! (떼쓰는 중)');
  w.keys('A', 'B', 'B');
  assert.equal(w.scenes.name, 'refuse');
  assert.ok(w.sounds.includes('tantrum'));
});

test('light menu: off gives the glow tint, on gives the chosen tint back', () => {
  const w = rig({ state: grown('tongtong'), prefs: { tint: 'amber' } });
  w.scenes.start();
  w.scenes.tap({ zone: 'icon', index: 3 });
  assert.equal(w.scenes.name, 'choice');
  assert.equal(w.caption, '불 끄기', 'starts on the opposite of the current state');
  w.keys('B');
  assert.equal(w.view().lightsOn, false);
  assert.equal(w.lcd.tint, 'glow');
  w.scenes.tap({ zone: 'icon', index: 3 });
  w.keys('B');
  assert.equal(w.view().lightsOn, true);
  assert.equal(w.lcd.tint, 'amber');
});

test('petting: a tap on the creature, hearts, and no petting while asleep', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  const before = w.state.pet.bond;
  w.scenes.tap({ zone: 'matrix', x: 24, y: 24 });
  assert.equal(w.state.pet.bond, before + 1);
  assert.ok(w.sounds.includes('pet'));
  assert.equal(w.caption, '쓰담쓰담~ 좋아요!');
  w.scenes.tap({ zone: 'icon', index: 7 });
  assert.equal(w.caption, '지금은 부르지 않아요');
});

test('status pages turn with A and close with C', () => {
  const w = rig({ state: grown('banjjak', { discipline: 3, bond: 40 }) });
  w.scenes.start();
  w.scenes.tap({ zone: 'icon', index: 6 });
  assert.equal(w.scenes.name, 'status');
  const seen = [w.caption];
  for (let i = 0; i < 3; i++) { w.keys('A'); w.run(1); seen.push(w.caption); }
  assert.equal(new Set(seen).size, 4);
  w.keys('C');
  assert.equal(w.scenes.name, 'idle');
  assertCaptions(w);
});

// ---- events ---------------------------------------------------------------------------------------

test('a single evolve during an absence still gets its animation, after the recap', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  w.state.pet.species = 'saessak';
  w.state.pet.stage = 'teen';
  w.scenes.onEvents([
    { type: 'sleep' }, { type: 'wake' }, { type: 'poop' }, { type: 'poop' },
    { type: 'evolve', from: 'tongtong', to: 'saessak' }, { type: 'careMistake' }, { type: 'careMistake' },
  ], { away: true, gapMin: 600 });
  assert.equal(w.scenes.name, 'recap');
  assert.equal(w.caption, '없는 동안…');
  w.run(8);
  assert.equal(w.caption, '쿨쿨 잘 잤어요');
  w.run(8);
  assert.equal(w.caption, '응가를 2번 했어요');
  w.run(8);
  assert.equal(w.scenes.name, 'evolving');
  assert.ok(!w.captions.some((c) => /실수/.test(c)), 'care mistakes are never shown');
  w.run(10, { strict: false });               // the flash frames light the whole matrix
  assert.ok(w.sounds.includes('evolve'));
  w.run(5, { strict: false });
  assert.equal(w.caption, '가나다라마바가 새싹으로 자랐어요!');
  w.run(14);
  assert.equal(w.scenes.name, 'idle');
  assertCaptions(w);
});

test('the recap is skippable with any key and still plays the evolve', () => {
  const w = rig({ state: grown('saessak') });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'poop' }, { type: 'evolve', from: 'tongtong', to: 'saessak' }], { away: true, gapMin: 90 });
  assert.equal(w.scenes.name, 'recap');
  w.keys('C');
  assert.equal(w.scenes.name, 'evolving');
});

test('a short absence shows no recap', () => {
  const w = rig({ state: grown('saessak') });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'poop' }], { away: true, gapMin: 3 });
  assert.equal(w.scenes.name, 'idle');
});

test('live events react on the home scene and queue behind an animation', () => {
  const w = rig({ state: grown('tongtong', { hunger: 1, discipline: 4 }) });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'poop' }], { away: false });
  assert.equal(w.caption, '앗, 응가했어요!');
  w.run(6);
  w.keys('A', 'B', 'B');
  assert.equal(w.scenes.name, 'eating');
  w.scenes.onEvents([{ type: 'evolve', from: 'tongtong', to: 'kkabul' }], { away: false });
  assert.equal(w.scenes.name, 'eating', 'the meal is not interrupted');
  w.run(14);
  assert.equal(w.scenes.name, 'evolving');
});

test('an egg that hatches by itself goes through the hatch animation', () => {
  const w = rig();
  w.scenes.start();
  w.now += 61000;
  const events = engine.advance(w.state, w.now, { live: true });
  w.scenes.onEvents(events, { away: false });
  assert.equal(w.scenes.name, 'hatching');
});

// ---- mini-games -------------------------------------------------------------------------------------

test('가위바위보 through the scene: five rounds, then playEnd is applied', () => {
  const w = rig({ state: grown('tongtong', { happy: 2, discipline: 4 }), seed: 5 });
  w.scenes.start();
  w.keys('A', 'A', 'B');
  assert.equal(w.caption, '가위바위보 (C 길게: 그만)');
  w.keys('B');
  assert.equal(w.scenes.name, 'game');
  const bond = w.state.pet.bond;
  for (let i = 0; i < 200 && w.scenes.name === 'game'; i++) {
    w.keys('B');
    w.run(1);
  }
  assert.equal(w.scenes.name, 'idle');
  assert.ok(w.state.pet.bond > bond, 'a finished game always adds bond');
  assert.ok(w.sounds.includes('win') || w.sounds.includes('lose'));
  assertCaptions(w);
});

test('a long press of C leaves a game with no effect', () => {
  const w = rig({ state: grown('tongtong', { discipline: 4 }) });
  w.scenes.start();
  w.keys('A', 'A', 'B', 'A', 'B');
  assert.equal(w.scenes.name, 'game');
  const before = JSON.stringify(w.state.pet);
  w.keys('C');
  assert.equal(w.scenes.name, 'game', 'a plain C is a game key');
  w.scenes.longPress('C');
  assert.equal(w.scenes.name, 'idle');
  assert.equal(JSON.stringify(w.state.pet), before);
});

test('rps rules: win, loss, draw replays twice and then counts as a loss', () => {
  // rng 0.1 -> the creature shows scissors (0). Rock beats it, paper loses, scissors draws.
  const play = (key) => {
    const g = createGame('rps', { rng: () => 0.1, art: SPECIES_ART.tongtong, stage: 'child' });
    for (let i = 0; i < 400 && !g.done; i++) { g.key(key); g.tick(250); }
    return g;
  };
  assert.deepEqual(play('B').result, { completed: true, won: true });
  assert.deepEqual(play('C').result, { completed: true, won: false });
  const draws = play('A');
  assert.deepEqual(draws.result, { completed: true, won: false });

  const quit = createGame('rps', { rng: () => 0.1, art: SPECIES_ART.tongtong });
  quit.key('B');
  quit.quit();
  assert.deepEqual(quit.result, { completed: false, won: false });
});

test('별 받기: standing under every star wins, standing elsewhere loses, drawing stays inside', () => {
  const run = (keys, stage = 'child') => {
    const lcd = fakeLcd();
    const g = createGame('catch', { rng: () => 0, art: SPECIES_ART.kkabul, stage });
    keys.forEach((k) => g.key(k));
    let below = 0;
    for (let i = 0; i < 2000 && !g.done; i++) {
      g.tick(250);
      lcd.clear();
      g.draw(lcd);
      below = Math.max(below, lcd.clipped);
    }
    return { g, below };
  };
  const good = run(['A']);                         // rng 0 -> everything falls in the left lane
  assert.deepEqual(good.g.result, { completed: true, won: true });
  assert.match(good.g.caption, /별 10개/);
  const bad = run(['C']);
  assert.deepEqual(bad.g.result, { completed: true, won: false });
  // Items enter from above the matrix; nothing may be drawn below or beside it.
  assert.ok(good.below <= 36, 'only the entering item is ever clipped');
  const teen = run(['A'], 'teen');                 // a constant rng places one drop; catching it costs a point
  assert.match(teen.g.caption, /별 9개/);
});

test('every creature fits both games', () => {
  for (const id of SPECIES_IDS) {
    const lcd = fakeLcd();
    const g = createGame('rps', { rng: mulberry32(9), art: SPECIES_ART[id], stage: SPECIES[id].stage });
    for (let i = 0; i < 300 && !g.done; i++) {
      g.key('ABC'[i % 3]);
      g.tick(250);
      lcd.clear();
      g.draw(lcd);
      assert.equal(lcd.clipped, 0, `${id} clipped in rps`);
    }
    assert.ok(g.done);
  }
});

// ---- endings ------------------------------------------------------------------------------------------

test('gentle: a mature pet leaves on a journey, an egg remains, the postcard opens', () => {
  const w = rig({ state: grown('narae', { stageAwakeMin: 3000, adultAwakeMin: 3000, departReady: true, matureAnnounced: true }) });
  w.scenes.start();
  w.scenes.tap({ zone: 'icon', index: 6 });
  for (let i = 0; i < 4; i++) w.keys('A');
  assert.equal(w.caption, 'B: 여행 보내기');
  w.keys('B');
  assert.equal(w.scenes.name, 'choice');
  assert.equal(w.caption, '조금 더 같이 있을래요', 'the menu opens on the answer that keeps the pet');
  w.keys('A');
  assert.equal(w.caption, '여행을 보내 줄까요?');
  w.keys('B');
  assert.equal(w.scenes.name, 'farewell');
  assert.equal(w.state.album.length, 1);
  assert.equal(w.view().stage, 'egg');
  w.run(26, { strict: false });               // it walks off through the right edge
  assert.equal(w.scenes.name, 'egg');
  assert.equal(w.opened.at(-1).name, 'postcard');
  assert.equal(w.opened.at(-1).opts.entry.end, 'journey');
  assertCaptions(w);
});

test('the mature event offers the journey; declining keeps the pet', () => {
  const w = rig({ state: grown('podong', { stageAwakeMin: 3000, adultAwakeMin: 3000, departReady: true, matureAnnounced: true }) });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'mature' }], { away: false });
  assert.equal(w.scenes.name, 'mature');
  assert.ok(w.sounds.includes('mature'));
  w.run(14);
  assert.equal(w.scenes.name, 'choice');
  w.keys('B');
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.view().species, 'podong');
  assert.equal(w.state.album.length, 0);
});

test('classic: death plays, the memorial stays, A+C starts a new egg', () => {
  const state = grown('banjjak', { adultAwakeMin: 13000, stageAwakeMin: 13000 });
  state.rulesMode = 'classic';
  const w = rig({ state });
  w.scenes.start();
  w.now += 61000;
  const events = engine.advance(w.state, w.now, { live: true });
  assert.ok(events.some((e) => e.type === 'death'));
  w.scenes.onEvents(events, { away: false });
  assert.equal(w.scenes.name, 'dying');
  assert.ok(w.sounds.includes('death'));
  w.run(24);
  assert.equal(w.scenes.name, 'memorial');
  w.keys('B');
  w.run(1);
  assert.match(w.caption, /살 · \d+g/);
  w.keys('B');
  w.scenes.tap({ zone: 'matrix', x: 20, y: 10 });
  assert.equal(w.opened.at(-1).name, 'postcard');
  assert.equal(w.opened.at(-1).opts.newEgg, true);
  w.keys('A');
  assert.equal(w.scenes.name, 'memorial', 'A alone only explains');
  w.run(6);
  w.scenes.key('A', new Set(['A', 'C']));
  assert.equal(w.scenes.name, 'egg');
  assert.ok(w.sounds.includes('newEgg'));
  assertCaptions(w);
});

test('pausing from outside switches to the sitter scene and back', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  w.act('pause', { on: true });
  assert.equal(w.scenes.name, 'paused');
  assert.equal(w.caption, '돌보미와 있어요');
  w.run(4);
  w.act('pause', { on: false });
  assert.equal(w.scenes.name, 'idle');
});

test('marks are placed by the creature\'s real height', () => {
  assert.ok(inkBox(SPECIES_ART.dwinggul.idle[0]).top >= 5, 'the flat adult is short');
  assert.ok(inkBox(SPECIES_ART.haessal.idle[0]).top <= 1, 'the special stands tall');
});

test('care animations stay inside the matrix from the far right, with and without a mess', () => {
  for (const id of SPECIES_IDS) {
    if (SPECIES[id].stage === 'baby') continue;
    for (const poop of [[], [5]]) {
      // discipline 4: no tantrum roll, so the meal below is always eaten
      const w = rig({ state: grown(id, { hunger: 2, happy: 2, discipline: 4, poop, sick: { cause: 'sweets', doses: 1, awakeMin: 3, mistakes: 0 } }) });
      w.scenes.start();
      const park = () => { w.scenes.placePet(COLS, 1); assert.equal(w.lcd.clipped, 0, `${id} parked`); };

      park();
      w.scenes.tap({ zone: 'icon', index: 4 });           // the one dose cures
      assert.equal(w.scenes.name, 'medicine', id);
      w.run(13);
      assert.equal(w.view().sick, false, id);

      park();
      w.scenes.tap({ zone: 'icon', index: 0 });
      w.keys('B');                                        // meal
      assert.equal(w.scenes.name, 'eating', id);
      w.run(14);

      park();
      w.scenes.tap({ zone: 'icon', index: 0 });
      w.keys('A', 'B');                                   // snack
      assert.equal(w.scenes.name, 'eating', id);
      w.run(14);

      park();
      w.scenes.tap({ zone: 'icon', index: 5 });           // nothing to scold: select, then the unfair branch
      w.scenes.tap({ zone: 'icon', index: 5 });
      assert.equal(w.scenes.name, 'scolding', id);
      w.run(11);

      park();
      w.scenes.tap({ zone: 'icon', index: 4 });           // not sick any more: a refusal
      assert.equal(w.scenes.name, 'refuse', id);
      w.run(8);
      assertCaptions(w);
    }
  }
});

// ---- nothing irreversible is one press away ---------------------------------------------------------

const READY = { stageAwakeMin: 3000, adultAwakeMin: 3000, departReady: true, matureAnnounced: true, hunger: 2, discipline: 4 };

test('mashing B through a meal, the mature scene and the journey menu keeps the pet', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.keys('A', 'B', 'B');
  assert.equal(w.scenes.name, 'eating');
  w.scenes.onEvents([{ type: 'mature' }], { away: false });      // the minute rolled over during the meal
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    w.keys('B');
    seen.add(w.scenes.name);
    w.run(1);
  }
  assert.ok(seen.has('mature') && seen.has('choice'), 'the offer was made');
  assert.ok(!seen.has('farewell'));
  assert.equal(w.view().species, 'narae');
  assert.equal(w.state.album.length, 0);
});

test('the mature scene cannot be skipped in its first two seconds', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'mature' }], { away: false });
  assert.equal(w.scenes.name, 'mature');
  for (let i = 0; i < 7; i++) { w.keys('B'); w.scenes.tap({ zone: 'matrix', x: 20, y: 10 }); w.run(1); }
  assert.equal(w.scenes.name, 'mature');
  w.run(1);
  w.keys('B');
  assert.equal(w.scenes.name, 'choice');
  assert.equal(w.caption, '조금 더 같이 있을래요');
});

test('mashing B through the recap after an absence keeps a pet that matured meanwhile', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.scenes.onEvents([{ type: 'poop' }, { type: 'mature' }], { away: true, gapMin: 180 });
  assert.equal(w.scenes.name, 'recap');
  for (let i = 0; i < 80; i++) { w.keys('B'); w.run(1); }
  assert.equal(w.view().species, 'narae');
  assert.equal(w.state.album.length, 0);
});

test('taps alone never send the pet away: not through the status pages, not on the mature scene', () => {
  const spot = { zone: 'matrix', x: 20, y: 10 };                 // upper left: where "go" sits in the menu
  const pages = rig({ state: grown('narae', READY) });
  pages.scenes.start();
  pages.scenes.tap({ zone: 'icon', index: 6 });
  const captions = [];
  for (let i = 0; i < 6; i++) { captions.push(pages.caption); pages.scenes.tap(spot); }
  assert.equal(captions[4], 'B: 여행 보내기');
  assert.equal(pages.scenes.name, 'status', 'a tap on the last page turns back to the first');
  assert.equal(captions[5], captions[0]);
  for (let i = 0; i < 60; i++) { pages.scenes.tap(spot); pages.run(1); }
  assert.equal(pages.state.album.length, 0);

  const offer = rig({ state: grown('narae', READY) });
  offer.scenes.start();
  offer.scenes.onEvents([{ type: 'mature' }], { away: false });
  for (let i = 0; i < 9; i++) { offer.scenes.tap(spot); offer.run(1); }
  assert.equal(offer.scenes.name, 'choice');
  for (let i = 0; i < 20; i++) { offer.scenes.tap(spot); offer.run(1); }
  assert.equal(offer.scenes.name, 'choice', 'tapping "go" only points at it');
  assert.equal(offer.state.album.length, 0);
  assert.ok(offer.captions.includes('여행을 보내 줄까요?'));
  assert.ok(offer.captions.includes('B 버튼으로 결정해요'), 'and says how to decide');
  offer.keys('B');
  assert.equal(offer.scenes.name, 'farewell', 'B decides');
  assert.equal(offer.state.album.length, 1);
  assertCaptions(offer);
});

test('a tap on "stay" in the journey menu keeps the pet; other menus still pick on a tap', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.scenes.menu('depart');
  w.scenes.tap({ zone: 'matrix', x: 12, y: 24 });
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.state.album.length, 0);
  w.scenes.tap({ zone: 'icon', index: 0 });
  w.scenes.tap({ zone: 'matrix', x: 12, y: 8 });                  // the meal
  assert.equal(w.scenes.name, 'eating');
});

test('a single touch on 훈육 never costs a heart: it selects, C takes it back', () => {
  const state = engine.newGame(NOON, { tzOffsetMin: 540 });
  for (let i = 0; i < 5; i++) engine.act(state, 'tapEgg', {}, NOON);
  const w = rig({ state });
  w.scenes.start();
  const happy = w.view().happy;
  w.scenes.tap({ zone: 'icon', index: 5 });
  assert.equal(w.scenes.name, 'idle');
  assert.equal(w.scenes.selected, 5);
  assert.equal(w.view().happy, happy);
  assert.equal(w.shakes, 0);
  w.keys('C');
  assert.equal(w.scenes.selected, -1);
  assert.equal(w.view().happy, happy);
});

// ---- sheets and the event queue --------------------------------------------------------------------

test('an egg that hatches while a sheet is open waits for it: nothing plays unseen, nothing replaces the sheet', () => {
  const w = rig();
  w.scenes.start();
  w.sheet = 'settings';                                         // the player is pasting a save code
  w.now += 61000;
  const events = engine.advance(w.state, w.now, { live: true });
  assert.ok(events.some((e) => e.type === 'hatch'));
  w.scenes.onEvents(events, { away: false });
  w.run(60);
  assert.equal(w.scenes.name, 'egg', 'the glass still shows the egg');
  assert.deepEqual(showing(w), ['egg']);
  assert.equal(w.sheet, 'settings');
  assert.deepEqual(w.opened, []);
  assert.ok(!w.sounds.includes('hatch'));
  w.sheet = null;
  w.run(1);
  assert.equal(w.scenes.name, 'hatching');
  w.run(18);
  assert.equal(w.scenes.name, 'naming');
  w.run(4);
  assert.deepEqual(w.opened.map((o) => o.name), ['name']);
});

test('a sheet opened during the hatch animation is not replaced by the name sheet', () => {
  const w = rig();
  w.scenes.start();
  w.keys('B', 'B', 'B', 'B', 'B');
  assert.equal(w.scenes.name, 'hatching');
  w.run(6);
  w.sheet = 'settings';
  w.run(40);
  assert.equal(w.scenes.name, 'naming');
  assert.deepEqual(w.opened, []);
  assert.equal(w.sheet, 'settings');
  w.sheet = null;
  w.run(3);
  assert.deepEqual(w.opened, [], 'a full quiet second after the sheet closed');
  w.run(1);
  assert.deepEqual(w.opened.map((o) => o.name), ['name']);
});

test('still tapping the egg through the hatch does not open the name sheet under the finger', () => {
  const w = rig();
  w.scenes.start();
  const tap = () => w.scenes.tap({ zone: 'matrix', x: 20, y: 20 });
  for (let i = 0; i < 5; i++) tap();
  assert.equal(w.scenes.name, 'hatching');
  for (let i = 0; i < 17; i++) { tap(); w.keys('B'); w.run(1); }
  assert.equal(w.scenes.name, 'hatching', 'the reveal is not cut short');
  w.run(1);
  assert.equal(w.scenes.name, 'naming');
  for (let i = 0; i < 6; i++) { tap(); w.run(1); }
  assert.deepEqual(w.opened, [], 'not while the taps keep coming');
  w.run(2);                                                     // 3 ticks since the last tap
  assert.deepEqual(w.opened, []);
  w.run(1);
  assert.deepEqual(w.opened.map((o) => o.name), ['name'], 'one quiet second later');

  const masher = rig();
  masher.scenes.start();
  masher.keys('B', 'B', 'B', 'B', 'B');
  masher.run(18);
  for (let i = 0; i < 15; i++) { masher.keys('B'); masher.run(1); }
  assert.deepEqual(masher.opened, []);
  masher.keys('B');
  masher.run(1);
  assert.deepEqual(masher.opened.map((o) => o.name), ['name'], 'after four seconds at the latest');
});

test('with no sheets at all the naming scene still moves on', () => {
  const w = rig();
  w.scenes.start();
  w.keys('B', 'B', 'B', 'B', 'B');
  w.run(18);
  assert.equal(w.scenes.name, 'naming');
  w.run(4);
  w.sheet = null;                                               // the stub "opened" it: pretend it could not
  w.run(2);
  assert.equal(w.scenes.name, 'idle');
});

test('a growth that lands while a sheet is open plays when the sheet closes, from the old shape', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  w.sheet = 'dex';
  w.state.pet.species = 'saessak';
  w.state.pet.stage = 'teen';
  w.scenes.onEvents([{ type: 'evolve', from: 'tongtong', to: 'saessak' }], { away: false });
  w.run(40);
  assert.equal(w.scenes.name, 'idle');
  assert.deepEqual(showing(w), ['tongtong'], 'the new shape is not given away under the sheet');
  assert.ok(!w.sounds.includes('evolve'));
  w.sheet = null;
  w.run(1);
  assert.equal(w.scenes.name, 'evolving');
  w.run(28, { strict: false });
  assert.equal(w.scenes.name, 'idle');
  assert.deepEqual(showing(w), ['saessak']);
});

test('returning from an absence with a sheet open holds the recap and the offer until it closes', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.sheet = 'settings';
  w.scenes.onEvents([{ type: 'poop' }, { type: 'mature' }], { away: true, gapMin: 180 });
  w.run(120);
  assert.equal(w.scenes.name, 'idle');
  assert.ok(!w.sounds.includes('mature'));
  // a second absence under the same sheet: one recap, not two
  w.scenes.onEvents([{ type: 'poop' }], { away: true, gapMin: 30 });
  w.sheet = null;
  w.run(1);
  assert.equal(w.scenes.name, 'recap');
  w.run(16);
  assert.equal(w.scenes.name, 'mature');
  assert.equal(w.captions.filter((c) => c === '없는 동안…').length, 1);
});

test('a journey offer that went stale while it waited is dropped', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.sheet = 'settings';
  w.scenes.onEvents([{ type: 'mature' }], { away: false });
  w.act('setMode', { mode: 'classic' });                        // no journeys in 매운맛
  w.sheet = null;
  w.run(4);
  assert.equal(w.scenes.name, 'idle');
  assert.ok(!w.sounds.includes('mature'));
});

test('the farewell postcard waits for a sheet that was opened during the farewell', () => {
  const w = rig({ state: grown('narae', READY) });
  w.scenes.start();
  w.scenes.menu('depart');
  w.keys('A', 'B');
  assert.equal(w.scenes.name, 'farewell');
  w.run(5, { strict: false });
  w.sheet = 'dex';
  w.run(40, { strict: false });
  assert.equal(w.scenes.name, 'farewell');
  assert.deepEqual(w.opened, []);
  w.sheet = null;
  w.run(1, { strict: false });
  assert.equal(w.opened.at(-1).name, 'postcard');
});

// ---- the reveal is not given away --------------------------------------------------------------------

test('first return: the egg hatches before the recap talks about the baby', () => {
  const w = rig();
  w.scenes.start();
  assert.deepEqual(showing(w), ['egg']);
  w.now += 20 * 60000;
  const events = engine.advance(w.state, w.now, { live: false });
  assert.ok(events.some((e) => e.type === 'hatch'));
  w.scenes.onEvents(events, { away: true, gapMin: 20 });
  assert.equal(w.scenes.name, 'hatching');
  assert.deepEqual(showing(w), ['egg']);
  w.run(18);
  assert.equal(w.scenes.name, 'naming');
  w.run(4);
  w.sheet = null;
  w.run(2);
  if (w.scenes.name === 'recap') {                              // whether 20 minutes leave a card is the engine's business
    assert.equal(w.caption, '없는 동안…');
    assert.deepEqual(showing(w), ['mongsil']);
  }
  assert.ok(!w.captions.slice(0, w.captions.indexOf('빠직… 빠지직!')).includes('없는 동안…'));
});

test('an egg left for hours: hatch, name and recap show the baby, and only then does it grow', () => {
  const w = rig();
  w.scenes.start();
  for (let i = 0; i < 5; i++) engine.act(w.state, 'tapEgg', {}, w.now);
  Object.assign(w.state.pet, { species: 'tongtong', stage: 'child' });
  w.scenes.onEvents([
    { type: 'hatch' }, { type: 'poop' }, { type: 'evolve', from: 'mongsil', to: 'tongtong' },
  ], { away: true, gapMin: 180 });
  assert.equal(w.scenes.name, 'hatching');
  const seen = { naming: new Set(), recap: new Set() };
  for (let i = 0; i < 80 && w.scenes.name !== 'evolving'; i++) {
    w.run(1);
    if (w.sheet) w.sheet = null;
    if (seen[w.scenes.name]) showing(w).forEach((id) => seen[w.scenes.name].add(id));
  }
  assert.deepEqual([...seen.naming], ['mongsil'], 'the name sheet sits over what just hatched');
  assert.deepEqual([...seen.recap], ['mongsil']);
  assert.equal(w.scenes.name, 'evolving');
  assert.deepEqual(showing(w), ['mongsil'], 'the growth starts from the baby');
  w.run(16, { strict: false });
  assert.deepEqual(showing(w), ['tongtong']);
});

test('the recap after a growth shows the shape the player left, not the new one', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  w.state.pet.species = 'banjjak';
  w.state.pet.stage = 'adult';
  w.scenes.onEvents([
    { type: 'poop' }, { type: 'evolve', from: 'tongtong', to: 'saessak' }, { type: 'evolve', from: 'saessak', to: 'banjjak' },
  ], { away: true, gapMin: 2000 });
  assert.equal(w.scenes.name, 'recap');
  const seen = new Set();
  while (w.scenes.name === 'recap') { showing(w).forEach((id) => seen.add(id)); w.run(1); }
  assert.deepEqual([...seen], ['tongtong']);
  assert.ok(w.captions.includes('그동안 쑥쑥 자랐어요'));
  assert.equal(w.scenes.name, 'evolving');
  assert.deepEqual(showing(w), ['tongtong'], 'one animation, from the shape that was left');
  w.run(16, { strict: false });
  assert.deepEqual(showing(w), ['banjjak']);
});

test('a growth that arrives while a menu is open does not swap the creature watching from the side', () => {
  const w = rig({ state: grown('tongtong', { hunger: 2 }) });
  w.scenes.start();
  w.keys('A', 'B');
  assert.equal(w.scenes.name, 'choice');
  w.state.pet.species = 'saessak';
  w.state.pet.stage = 'teen';
  w.scenes.onEvents([{ type: 'evolve', from: 'tongtong', to: 'saessak' }], { away: false });
  w.run(2);
  assert.equal(w.scenes.name, 'choice');
  assert.deepEqual(showing(w), ['tongtong']);
  w.keys('C');
  assert.equal(w.scenes.name, 'evolving');
});

// ---- mini-games: never waiting for ever, never throwing a finished game away --------------------------

function spyWakeLock(t) {
  const log = { requests: 0, releases: 0 };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { wakeLock: { request: async () => { log.requests++; return { release: async () => { log.releases++; } }; } } },
  });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'navigator', before); else delete globalThis.navigator; });
  return log;
}

test('가위바위보 left on the choose screen gives up after 20 seconds and lets the display sleep', async (t) => {
  const g = createGame('rps', { rng: () => 0.1, art: SPECIES_ART.tongtong, stage: 'child' });
  for (let i = 0; i < 79; i++) g.tick(250);
  assert.equal(g.done, false);
  g.tick(250);
  assert.deepEqual(g.result, { completed: false, won: false });

  const answered = createGame('rps', { rng: () => 0.1, art: SPECIES_ART.tongtong, stage: 'child' });
  for (let i = 0; i < 70; i++) answered.tick(250);
  answered.key('B');
  for (let i = 0; i < 40; i++) answered.tick(250);
  assert.equal(answered.done, false, 'the wait starts again with every round');

  const wake = spyWakeLock(t);
  const w = rig({ state: grown('tongtong', { discipline: 4 }) });
  w.scenes.start();
  w.keys('A', 'A', 'B', 'B');
  assert.equal(w.scenes.name, 'game');
  await microtasks();
  assert.deepEqual(wake, { requests: 1, releases: 0 });
  const pet = JSON.stringify(w.state.pet);
  w.run(79);
  assert.equal(w.scenes.name, 'game');
  w.run(1);
  assert.equal(w.scenes.name, 'idle');
  await microtasks();
  assert.deepEqual(wake, { requests: 1, releases: 1 });
  assert.equal(JSON.stringify(w.state.pet), pet, 'an abandoned game has no effect');
});

test('a game under a sheet stands still without holding the wake lock', async (t) => {
  const wake = spyWakeLock(t);
  const w = rig({ state: grown('tongtong', { discipline: 4 }) });
  w.scenes.start();
  w.keys('A', 'A', 'B', 'A', 'B');                              // 별 받기
  assert.equal(w.scenes.name, 'game');
  await microtasks();
  w.run(3, { strict: false });                                 // falling items enter through the top edge
  const frame = w.lcd.hash();
  w.sheet = 'settings';
  w.run(400, { strict: false });
  await microtasks();
  assert.equal(w.scenes.name, 'game');
  assert.equal(w.lcd.hash(), frame, 'nothing falls unseen');
  assert.deepEqual(wake, { requests: 1, releases: 1 });
  w.sheet = null;
  w.run(1, { strict: false });
  await microtasks();
  assert.deepEqual(wake, { requests: 2, releases: 1 });
  w.scenes.longPress('C');
  await microtasks();
  assert.deepEqual(wake, { requests: 2, releases: 2 });
});

test('quitting on the final score keeps the finished game', () => {
  const rps = createGame('rps', { rng: () => 0.1, art: SPECIES_ART.tongtong, stage: 'child' });
  for (let i = 0; i < 400 && !/^\d승 \d패/.test(rps.caption); i++) { rps.key('B'); rps.tick(250); }
  assert.equal(rps.caption, '5승 0패! 이겼어요');
  assert.equal(rps.done, false);
  rps.quit();
  assert.deepEqual(rps.result, { completed: true, won: true });

  const stars = createGame('catch', { rng: () => 0, art: SPECIES_ART.kkabul, stage: 'child' });
  stars.key('A');
  for (let i = 0; i < 2000 && !/^별 \d+개[!…]/.test(stars.caption); i++) stars.tick(250);
  assert.equal(stars.caption, '별 10개! 이겼어요');
  assert.equal(stars.done, false);
  stars.quit();
  assert.deepEqual(stars.result, { completed: true, won: true });

  const early = createGame('catch', { rng: () => 0, art: SPECIES_ART.kkabul, stage: 'child' });
  early.key('A');
  for (let i = 0; i < 20; i++) early.tick(250);
  early.quit();
  assert.deepEqual(early.result, { completed: false, won: false }, 'before the end a quit is still a quit');

  // through the scene: C held on the score screen must not throw the win away
  const w = rig({ state: grown('tongtong', { happy: 2, discipline: 4 }), seed: 5 });
  w.scenes.start();
  w.keys('A', 'A', 'B', 'B');
  const bond = w.state.pet.bond;
  for (let i = 0; i < 400 && !/^\d승 \d패/.test(w.caption); i++) { w.keys('B'); w.run(1); }
  assert.equal(w.scenes.name, 'game');
  w.scenes.longPress('C');
  assert.equal(w.scenes.name, 'idle');
  assert.ok(w.state.pet.bond > bond, 'the finished game counted');
});

// ---- the memorial chord ------------------------------------------------------------------------------

test('a lone A on one memorial does not arm the A+C chord on the next', () => {
  const dead = (state) => { Object.assign(state.pet, { alive: false, endCause: 'neglect', leftEgg: false }); return state; };
  const state = dead(grown('banjjak'));
  state.rulesMode = 'classic';
  const w = rig({ state });
  w.scenes.start();
  assert.equal(w.scenes.name, 'memorial');
  w.run(430);
  w.keys('A');
  assert.equal(w.scenes.name, 'memorial');
  w.act('newEgg');                                              // what the postcard sheet's button does
  assert.equal(w.scenes.name, 'egg');
  dead(w.state);
  w.scenes.refresh();
  assert.equal(w.scenes.name, 'memorial');
  w.run(8);
  w.keys('C');
  assert.equal(w.scenes.name, 'memorial', 'one stray key must not end the memorial');
  assert.equal(w.view().alive, false);
  w.run(1);
  w.keys('A');
  assert.equal(w.scenes.name, 'egg', 'A right after C is the chord');
});

// ---- js/main.js against a fake page --------------------------------------------------------------------
// main.js is the wiring: the one door through which time moves, the keys, the touch layer and
// the app object the sheets talk to. It boots itself on import, so each test installs a small
// fake page, imports a fresh copy and drives it through the listeners it registered. Timers
// are node's mock timers; the wall clock is moved by hand, so "the phone slept for three
// days" is one line and no timer fires for the time that was slept through.

const SAVE_KEY = 'pumal.save.v1';
const PREFS_KEY = 'pumal.prefs.v1';
const LOCAL_NOON = new Date(2026, 9, 1, 12, 0, 0).getTime();      // the app reads the machine's own time zone
const MIN = 60000;
let bootCount = 0;

function fakeElement(tag, id = '', classes = '') {
  const listeners = {};
  const cls = new Set(classes ? classes.split(' ') : []);
  const attrs = {};
  const node = {
    tagName: tag.toUpperCase(), id, dataset: {}, children: [], parentElement: null, textContent: '',
    style: { setProperty() {} }, offsetWidth: 0, clientWidth: 300, clientHeight: 0, focusVisible: false,
    width: 0, height: 0,
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on = !cls.has(c)) => (on ? cls.add(c) : cls.delete(c)),
    },
    get childElementCount() { return node.children.length; },
    get parentNode() { return node.parentElement; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute(k) { delete attrs[k]; },
    appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
    append(...kids) { kids.forEach((k) => node.appendChild(k)); },
    remove() {
      const up = node.parentElement;
      if (up) up.children.splice(up.children.indexOf(node), 1);
      node.parentElement = null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    // stopImmediatePropagation is honoured (js/install.js relies on it to keep a page that is
    // reloading away from the save); capture and bubble are one list, in registration order.
    emit(type, ev = {}) {
      for (const fn of listeners[type] || []) {
        fn(ev);
        if (ev && ev.stopped === true) break;
      }
    },
    dispatchEvent(ev) { if (!ev.target) ev.target = node; node.emit(ev.type, ev); return true; },
    matches(selector) {
      return selector.split(',').some((part) => {
        const one = part.trim();
        if (one === ':focus-visible') return node.focusVisible;
        if (one[0] === '.') return cls.has(one.slice(1));
        if (one[0] === '[') return one.slice(1, -1) in attrs;
        return node.tagName === one.toUpperCase();
      });
    },
    closest(selector) {
      for (let n = node; n; n = n.parentElement) if (n.matches(selector)) return n;
      return null;
    },
    contains: () => true,
    focus() {},
    getBoundingClientRect() {
      const w = parseFloat(node.style.width) || 300, h = parseFloat(node.style.height) || 300;
      return { left: 0, top: 0, width: w, height: h };
    },
    getContext() {
      const gradient = { addColorStop() {} };
      return new Proxy({}, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
          if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
          return () => {};
        },
        set(target, prop, value) { target[prop] = value; return true; },
      });
    },
  };
  return node;
}

// → the page: { el(id), caption(), saved(), app, keyDown/keyUp, tapKey, tapLcd, hide, show, sleep, run, flush }
// sheetFailures: how many times js/ui.js fails to come up before it works (0 = never fails).
// sw: give the page a service worker that already controls it; page.newWorker() is an update.
async function bootMain(t, {
  search = '?play=1', hostname = 'pumal.example', state = null, now = LOCAL_NOON, prefs = { seenGuide: true },
  sheetFailures = 0, sw = false,
} = {}) {
  const wall = { now };
  const page = { wall, reloads: 0, sheetFailures };
  const els = new Map();
  const make = (tag, id, classes, parent) => {
    const node = fakeElement(tag, id, classes);
    els.set(id, node);
    if (parent) els.get(parent).appendChild(node);
    return node;
  };
  make('div', 'stage');
  make('div', 'device', '', 'stage');
  make('div', 'bezel', '', 'device');
  make('canvas', 'lcd', '', 'bezel');
  make('p', 'caption', '', 'device');
  for (const k of ['A', 'B', 'C']) make('div', `key${k}`, 'key', 'device');
  make('button', 'btnDex', 'chip', 'stage');
  make('button', 'btnSettings', 'chip', 'stage');
  for (const id of ['gateRoot', 'sheetRoot', 'toastRoot']) make('div', id);
  page.el = (id) => els.get(id) || null;

  const hub = (extra) => {
    const node = fakeElement('div');
    return Object.assign(node, extra);
  };
  const body = fakeElement('body');
  const doc = hub({
    hidden: false, visibilityState: 'visible', body, activeElement: body,
    getElementById: (id) => {
      // js/ui.js looks its root up first thing in initUI: failing there (and only there, other
      // modules look at #sheetRoot too) is "the sheets did not load".
      if (id === 'sheetRoot' && page.sheetFailures > 0 && /\binitUI\b/.test(new Error().stack)) {
        page.sheetFailures--;
        throw new Error('sheets unavailable (test)');
      }
      return page.el(id);
    },
    createElement: (tag) => fakeElement(tag),
  });
  const win = hub({ devicePixelRatio: 3, scrollX: 0, scrollY: 0, scrollTo() {} });
  // a real event walks up to the document and the window
  for (const node of [body, ...els.values()]) {
    const own = node.dispatchEvent;
    node.dispatchEvent = (ev) => { own(ev); doc.emit(ev.type, ev); win.emit(ev.type, ev); return true; };
  }
  doc.dispatchEvent = (ev) => { if (!ev.target) ev.target = doc; doc.emit(ev.type, ev); win.emit(ev.type, ev); return true; };

  const store = new Map();
  const session = new Map();      // node has a sessionStorage of its own, shared by every test
  if (state) store.set(SAVE_KEY, JSON.stringify(state));
  if (prefs) store.set(PREFS_KEY, JSON.stringify(prefs));
  class FakeEvent {
    constructor(type, init) { Object.assign(this, init, { type }); }
    preventDefault() {}
    stopPropagation() {}
  }
  const globals = {
    document: doc,
    window: win,
    location: { search, hostname, href: `https://${hostname}/pumal/${search}`, reload() { page.reloads++; }, replace() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => { session.set(k, String(v)); },
      removeItem: (k) => { session.delete(k); },
    },
    navigator: { userAgent: 'node', platform: 'test', maxTouchPoints: 0, ...(sw ? { serviceWorker: fakeWorkers(page) } : {}) },
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px', position: 'relative' }),
    matchMedia: (q) => ({ matches: /reduced-motion/.test(q), addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    PointerEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
  };
  const before = {};
  for (const [name, value] of Object.entries(globals)) {
    before[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const realNow = Date.now;
  Date.now = () => wall.now;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  page.flush = async () => { for (let i = 0; i < 6; i++) await microtasks(); };
  t.after(async () => {
    await page.flush();
    t.mock.timers.reset();
    Date.now = realNow;
    for (const [name, desc] of Object.entries(before)) {
      if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
    }
  });

  await import(`../js/main.js?boot=${++bootCount}`);
  await page.flush();

  page.app = win.__pumal ? win.__pumal.app : null;
  page.caption = () => page.el('caption').textContent;
  page.saved = () => JSON.parse(store.get(SAVE_KEY));
  // time passes with the page awake: timers fire as they would
  page.run = (ms) => {
    for (let left = ms; left > 0; left -= 250) { wall.now += Math.min(250, left); t.mock.timers.tick(Math.min(250, left)); }
  };
  // time passes with the page frozen (suspended by the system): nothing runs
  page.sleep = (ms) => { wall.now += ms; };
  const lifeEvent = (extra) => ({ ...extra, stopped: false, stopImmediatePropagation() { this.stopped = true; } });
  page.hide = () => { doc.hidden = true; doc.visibilityState = 'hidden'; doc.emit('visibilitychange', lifeEvent()); };
  page.show = () => { doc.hidden = false; doc.visibilityState = 'visible'; doc.emit('visibilitychange', lifeEvent()); };
  page.pageshow = () => { doc.hidden = false; doc.visibilityState = 'visible'; win.emit('pageshow', lifeEvent({ persisted: true })); };
  page.toasts = () => page.el('toastRoot').children.map((n) => n.textContent);
  // another instance of the app (a second tab) stores its own save
  page.storeElsewhere = (other) => store.set(SAVE_KEY, JSON.stringify(other));
  const keyEvent = (key, code, target) => ({
    type: 'key', key, code, target: target || body, repeat: false, metaKey: false, ctrlKey: false, altKey: false,
    prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {},
  });
  page.keyDown = (key, code = '', target) => { const ev = keyEvent(key, code, target); win.emit('keydown', ev); return ev; };
  page.keyUp = (key, code = '', target) => { win.emit('keyup', keyEvent(key, code, target)); };
  page.type = (key, code, target) => { page.keyDown(key, code, target); page.keyUp(key, code, target); };
  let pointer = 0;
  page.tapKey = (k) => {
    const pointerId = ++pointer;
    page.el(`key${k}`).emit('pointerdown', { pointerType: 'touch', button: 0, pointerId, isPrimary: true });
    win.emit('pointerup', { pointerId });
  };
  // col 0-47, row 0-31 of the matrix, or an icon: the canvas is 50 dots square (1 margin, 8 strip)
  const lcdPoint = (u, v) => {
    const r = page.el('lcd').getBoundingClientRect();
    return { clientX: ((u + 0.5) / 50) * r.width, clientY: ((v + 0.5) / 50) * r.height };
  };
  page.tapLcd = (col, row, isPrimary = true) => {
    page.el('bezel').emit('pointerdown', { pointerType: 'touch', button: 0, isPrimary, ...lcdPoint(col + 1, row + 9) });
  };
  page.tapIcon = (i, isPrimary = true) => {
    page.el('bezel').emit('pointerdown', { pointerType: 'touch', button: 0, isPrimary, ...lcdPoint(1 + (i % 4) * 12 + 6, i < 4 ? 4 : 45) });
  };
  page.sheet = (open) => win.emit('pumal:sheet', { detail: { open, name: open ? 'settings' : null } });
  return page;
}

// navigator.serviceWorker with a worker already in control, so the next controllerchange is
// "a new version took over" (js/install.js ignores the first claim of an uncontrolled page).
function fakeWorkers(page) {
  const listeners = [];
  page.newWorker = () => listeners.forEach((fn) => fn({}));
  return {
    controller: {},
    addEventListener(type, fn) { if (type === 'controllerchange') listeners.push(fn); },
    register: () => Promise.resolve({ update: () => Promise.resolve() }),
  };
}

// A saved game as the app would have left it at local time `now`.
function savedGame(id, patch = {}, now = LOCAL_NOON, mode = 'gentle') {
  const state = grown(id, patch, now);
  state.rulesMode = mode;
  state.settings.tzOffsetMin = -new Date(now).getTimezoneOffset();
  engine.advance(state, now, { live: true });
  return state;
}

test('main boots against the fake page: loads the save, draws, saves, runs live time', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  assert.match(page.caption(), /가나다라마바/);
  assert.equal(page.el('lcd').getAttribute('aria-label'), `품알 화면: ${page.caption()}`);
  page.run(61000);
  assert.equal(page.saved().lastTick, LOCAL_NOON + MIN, 'a live minute was consumed and saved');
  page.type('a', 'KeyA');
  assert.equal(page.caption(), '밥 주기 · B로 결정');
});

// LEAD NOTE: a long absence is never processed as live time, whatever runs first on the way back.
const RETURNS = {
  'the visibility event': (page) => page.show(),
  'a bfcache pageshow': (page) => page.pageshow(),
  'a key on the keyboard, before any visibility event': (page) => page.type('s', 'KeyS'),
  'a tap on a device key': (page) => page.tapKey('B'),
  'a touch on the LCD': (page) => page.tapIcon(0),
  'an action from a sheet': (page) => page.app.act('meal'),
  'the 1 s live timer of a page that was frozen without being hidden': (page) => page.run(1000),
};

for (const [what, comeBack] of Object.entries(RETURNS)) {
  test(`after three days away, ${what} replays the absence with the away rules first`, async (t) => {
    const page = await bootMain(t, { state: savedGame('saessak', { hunger: 4, happy: 4 }) });
    const before = page.saved().pet.totalAwakeMin;
    const frozen = /frozen/.test(what);
    if (!frozen) page.hide();
    page.sleep(3 * DAY);
    comeBack(page);
    const s = page.saved();
    assert.equal(s.lastTick, page.wall.now, 'caught up to now');
    // 순한맛 charges an absence at most AWAY_CAP_MIN awake minutes; live time has no cap
    // (three days of it are about 2700 awake minutes).
    assert.ok(s.pet.totalAwakeMin - before <= AWAY_CAP_MIN, `charged ${s.pet.totalAwakeMin - before} awake minutes`);
    assert.ok(s.pet.totalAwakeMin - before >= AWAY_CAP_MIN - 1);
    assert.equal(s.pet.alive, true);
    if (/key|touch/.test(what)) {
      // the press that woke the page is the answer to the absence, not a game input
      assert.equal(s.pet.hunger, 0);
      assert.notEqual(page.caption(), '밥을 줄까요?');
    }
    if (!frozen && !/visibility|pageshow/.test(what)) page.show();     // the late event changes nothing
    assert.equal(page.saved().pet.totalAwakeMin, s.pet.totalAwakeMin);
  });
}

test('the light left on over bedtime during an absence is not billed as a live mistake, even if a key comes first', async (t) => {
  const evening = new Date(2026, 9, 1, 22, 50, 0).getTime();
  const page = await bootMain(t, { now: evening, state: savedGame('saessak', { lightsOn: true, careMistakes: 0 }, evening) });
  assert.equal(page.saved().pet.asleep, false);
  page.hide();
  page.sleep(40 * MIN);                                         // bedtime 23:00 passes with the light on
  page.type('s', 'KeyS');
  const pet = page.saved().pet;
  assert.equal(pet.asleep, true);
  assert.equal(pet.lightsOn, false, 'it turned the light off itself');
  assert.equal(pet.careMistakes, 0, 'which costs nothing when nobody was there (순한맛)');
});

test('a gap under two minutes is live time; the recap only follows a real absence', async (t) => {
  const page = await bootMain(t, { state: savedGame('saessak') });
  page.hide();
  page.sleep(90000);
  page.show();
  assert.equal(page.saved().lastTick, LOCAL_NOON + MIN);
  assert.notEqual(page.caption(), '없는 동안…');
});

// ---- save codes and reset ---------------------------------------------------------------------------

test('restoring a save code does not replay the time since it was exported', async (t) => {
  for (const mode of ['classic', 'gentle']) {
    const page = await bootMain(t, {});
    const exportedAt = LOCAL_NOON - 2 * DAY;
    const old = savedGame('saessak', { hunger: 4, happy: 4, careMistakes: 1 }, exportedAt, mode);
    const res = page.app.importCode(exportCode(old));
    assert.deepEqual(res, { ok: true });
    const s = page.saved();
    assert.equal(s.lastTick, LOCAL_NOON, mode);
    assert.equal(s.paused, false, mode);
    assert.equal(s.rulesMode, mode);
    assert.equal(s.pet.alive, true, `${mode}: the pet arrives alive`);
    assert.equal(s.pet.species, 'saessak');
    assert.deepEqual([s.pet.hunger, s.pet.happy, s.pet.careMistakes], [4, 4, 1], `${mode}: as it was saved`);
    assert.equal(s.pet.sick, null);
    assert.equal(s.pet.totalAwakeMin, old.pet.totalAwakeMin);
    page.run(61000);                                            // and life goes on from here
    assert.equal(page.saved().lastTick, LOCAL_NOON + MIN);
    assert.equal(page.saved().pet.alive, true);
    t.mock.timers.reset();
  }
});

test('restoring a code keeps a pet that was with the sitter paused, range-checks the numbers, refuses junk', async (t) => {
  const page = await bootMain(t, {});
  const old = savedGame('tongtong', {}, LOCAL_NOON - 5 * DAY);
  old.paused = true;
  old.pet.hunger = 99;
  old.pet.weight = -5;
  assert.deepEqual(page.app.importCode(exportCode(old)), { ok: true });
  const s = page.saved();
  assert.equal(s.paused, true);
  assert.equal(s.lastTick, LOCAL_NOON);
  assert.equal(s.pet.hunger, 4);
  assert.ok(s.pet.weight >= SPECIES.tongtong.baseWeight);
  assert.equal(page.caption(), '돌보미와 있어요');

  const bad = page.app.importCode('PUMAL1.not-a-code');
  assert.equal(bad.ok, false);
  assert.equal(page.saved().pet.species, 'tongtong', 'the game is untouched');
});

test('처음부터 다시 wipes the pet, the 도감 and the album but keeps the owner\'s hours and 돌봄 방식', async (t) => {
  const state = savedGame('saessak');
  state.dex = { mongsil: 1, tongtong: 2, saessak: 3 };
  state.album = [{ name: '보리', species: 'podong', gen: 1, ageDays: 9, bornAt: 1, endedAt: 2, end: 'journey', mode: 'gentle', careGrade: 'B' }];
  const page = await bootMain(t, { state });
  assert.equal(page.app.act('setSchedule', { wakeMin: 360, bedMin: 1290 }).ok, true);
  assert.equal(page.app.act('setMode', { mode: 'classic' }).ok, true);
  page.app.resetGame();
  const s = page.saved();
  assert.equal(s.pet.stage, 'egg');
  assert.equal(s.pet.gen, 1);
  assert.deepEqual(s.album, []);
  assert.deepEqual(s.dex, {});
  assert.deepEqual([s.settings.wakeMin, s.settings.bedMin], [360, 1290]);
  assert.equal(s.rulesMode, 'classic');
  assert.equal(s.createdAt, LOCAL_NOON);
  assert.equal(page.caption(), '알을 톡톡 두드려 보세요');
});

// ---- keyboard and touch wiring --------------------------------------------------------------------------

test('game keys still work with the focus on a chip button; Enter and Space stay the button\'s own', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  const chip = page.el('btnDex');                               // where ui.js puts the focus back after 도감 closes
  const enter = page.keyDown('Enter', 'Enter', chip);
  page.keyUp('Enter', 'Enter', chip);
  assert.equal(enter.prevented, false, 'Enter activates the button, it is not B');
  assert.match(page.caption(), /가나다라마바/);
  page.type('a', 'KeyA', chip);
  assert.equal(page.caption(), '밥 주기 · B로 결정');
  page.type('ArrowLeft', 'ArrowLeft', chip);
  assert.equal(page.caption(), '놀아 주기 · B로 결정');
  page.type('Escape', 'Escape', chip);
  assert.match(page.caption(), /가나다라마바/, 'Escape is C: it deselects');

  const input = fakeElement('input');
  page.type('a', 'KeyA', input);
  assert.match(page.caption(), /가나다라마바/, 'typing in a field is never a game key');
});

test('a key that was down when a sheet opened is let go, so its next press is not swallowed', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  page.keyDown('s', 'KeyS');                                    // B: shows the clock
  assert.match(page.caption(), /요일$/);
  assert.equal(page.el('keyB').classList.contains('is-pressed'), true);
  page.sheet(true);                                             // from here ui.js swallows the keyup
  assert.equal(page.el('keyB').classList.contains('is-pressed'), false);
  page.sheet(false);
  page.run(250);
  page.type('s', 'KeyS');                                       // ends the clock
  assert.match(page.caption(), /가나다라마바/, 'the first press after the sheet works');
  page.type('s', 'KeyS');
  assert.match(page.caption(), /요일$/);
  page.keyUp('s', 'KeyS');                                      // a stray release is harmless
});

test('a second finger on the LCD plays in a mini-game and is ignored everywhere else', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong', { discipline: 4 }) });
  page.tapIcon(6, false);                                       // a resting finger must not open the status pages
  assert.match(page.caption(), /가나다라마바/);
  page.tapIcon(1);
  assert.equal(page.caption(), '가위바위보 (C 길게: 그만)');
  page.tapLcd(12, 24);                                          // the lower option: 별 받기
  assert.equal(page.caption(), 'A 왼쪽 · B 폴짝 · C 오른쪽');
  page.tapLcd(40, 20, false);                                   // right thumb lands while the left is still down
  assert.match(page.caption(), /^별 0개/, 'the move was played');
});

test('the install guide lying over the device holds the hatch like a sheet does', async (t) => {
  const page = await bootMain(t, {});
  assert.equal(page.caption(), '알을 톡톡 두드려 보세요');
  const gate = page.el('gateRoot').appendChild(fakeElement('div'));
  page.run(70000);
  assert.equal(page.saved().pet.stage, 'baby', 'the egg hatched by time');
  assert.equal(page.caption(), '알을 톡톡 두드려 보세요', 'but the reveal waits');
  gate.remove();
  page.run(250);
  assert.equal(page.caption(), '빠직… 빠지직!');
});

test('a key script in the URL never plays on a real save, only on a dev host or a shot', async (t) => {
  const live = await bootMain(t, { search: '?play=1&keys=BBB', hostname: 'pumal.example' });
  assert.equal(live.saved().pet.eggTaps, 0, 'the recipient\'s egg is untouched');
  assert.equal(live.caption(), '알을 톡톡 두드려 보세요');
  t.mock.timers.reset();

  const dev = await bootMain(t, { search: '?play=1&keys=BBB', hostname: '127.0.0.1' });
  assert.equal(dev.saved().pet.eggTaps, 3, 'tools/shot.sh and local testing keep working');
});

// ---- two instances of one save -----------------------------------------------------------------------

test('a stale instance adopts the save another instance stored, instead of failing to save for good', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  assert.equal(page.app.state.pet.species, 'tongtong');
  // the other tab raised the pet further and saved
  const theirs = savedGame('podong', { bond: 60, name: '다른탭' });
  page.storeElsewhere(theirs);
  page.run(1000);                                               // the 1 s live loop notices
  assert.equal(page.app.state.pet.species, 'podong');
  assert.equal(page.app.state.pet.bond, 60);
  assert.match(page.caption(), /다른탭/, 'the screen shows the adopted pet');
  assert.deepEqual(page.toasts(), [], 'and nobody is told that saving does not work');
  // from here it saves again like any other instance
  page.run(61000);
  assert.equal(page.saved().pet.species, 'podong');
  assert.equal(page.saved().lastTick, LOCAL_NOON + MIN);
});

test('a key pressed in a stale instance shows the adopted pet and is not played on it', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong', { hunger: 2 }) });
  page.hide();
  page.storeElsewhere(savedGame('podong', { hunger: 2, name: '다른탭' }));
  page.tapIcon(0);                                              // would open the food menu
  assert.equal(page.app.state.pet.species, 'podong');
  assert.notEqual(page.caption(), '밥을 줄까요?', 'the press was the wake-up, not an input');
  assert.equal(page.saved().pet.hunger, 2);
});

test('an import made in a stale instance wins over the save stored elsewhere', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  page.storeElsewhere(savedGame('podong'));
  const code = exportCode(savedGame('saessak', { name: '가져온펫' }, LOCAL_NOON - DAY));
  assert.deepEqual(page.app.importCode(code), { ok: true });
  assert.equal(page.saved().pet.species, 'saessak');
  assert.equal(page.app.state.pet.species, 'saessak');
  page.run(1000);
  assert.equal(page.app.state.pet.species, 'saessak', 'and it is not swapped back a second later');
});

test('a clock that was set back and then corrected is not reported as a long absence', async (t) => {
  // one minute from a mess, so the three real minutes below leave an event to talk about
  const page = await bootMain(t, { state: savedGame('saessak', { poopTimer: 2 }) });
  page.hide();
  page.wall.now = LOCAL_NOON - 2 * DAY;                         // the owner sets the date back two days
  page.show();
  assert.equal(page.saved().hiTick, LOCAL_NOON, 'the engine remembers how far the pet has lived');
  page.hide();
  page.wall.now = LOCAL_NOON + 3 * MIN;                         // and corrects it
  page.show();
  const s = page.saved();
  assert.equal(s.lastTick, LOCAL_NOON + 3 * MIN);
  assert.equal(s.pet.poop.length, 1, 'three minutes were lived');
  assert.notEqual(page.caption(), '없는 동안…', 'three minutes are not an absence worth a recap');
});

// ---- the sheets module and updates --------------------------------------------------------------------

test('the install guide opened from 설정 closes back into the game and explains the save code', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong') });
  page.app.showInstallGuide();
  const html = page.el('gateRoot').innerHTML;
  assert.match(html, /닫고 계속 키우기/);
  assert.match(html, /저장 코드/);
  assert.ok(!/옮겨지지 않고/.test(html), 'not the first-run trial warning: this player has a pet and a code');
});

test('sheets that failed to load are tried again on the next tap that needs one', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const page = await bootMain(t, { state: savedGame('tongtong'), sheetFailures: 1 });
  assert.match(page.caption(), /가나다라마바/, 'the toy itself started');
  page.el('btnDex').emit('click', {});
  assert.deepEqual(page.toasts(), ['잠시 후 다시 눌러 주세요']);
  await page.flush();
  assert.equal(page.sheetFailures, 0);
  page.el('btnSettings').emit('click', {});
  assert.deepEqual(page.toasts(), ['잠시 후 다시 눌러 주세요'], 'the second tap reached the sheets: no new apology');
});

test('with an update waiting, a tap that needs the missing sheets reloads instead of mixing versions', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const page = await bootMain(t, { state: savedGame('tongtong'), sheetFailures: 5, sw: true });
  page.type('a', 'KeyA');                                       // an icon is selected: not a moment to reload
  page.newWorker();
  assert.equal(page.reloads, 0);
  page.el('btnDex').emit('click', {});
  assert.equal(page.reloads, 0, 'not in the middle of a selection');
  assert.equal(page.sheetFailures, 4, 'and no retry either: the old cache is gone');
  page.type('d', 'KeyD');                                       // deselect
  page.el('btnDex').emit('click', {});
  assert.equal(page.reloads, 1);
});

test('an update reloads at once only on an untouched, idle screen', async (t) => {
  const idle = await bootMain(t, { state: savedGame('tongtong'), sw: true });
  idle.newWorker();
  assert.equal(idle.reloads, 1);
  assert.equal(idle.saved().lastTick, LOCAL_NOON, 'saved before the reload');
  t.mock.timers.reset();

  // three days away: the recap is on the glass when the new worker takes over
  const recap = await bootMain(t, { state: savedGame('saessak', {}, LOCAL_NOON - 3 * DAY), sw: true });
  assert.equal(recap.caption(), '없는 동안…');
  recap.newWorker();
  assert.equal(recap.reloads, 0, 'the recap plays once and is not wiped by a reload');
});

test('an update waiting on return: a short look away keeps a running game, a real absence reloads before it is replayed', async (t) => {
  const page = await bootMain(t, { state: savedGame('tongtong', { discipline: 4 }), sw: true });
  page.tapIcon(1);
  page.tapLcd(12, 24);                                          // 별 받기
  assert.equal(page.caption(), 'A 왼쪽 · B 폴짝 · C 오른쪽');
  page.newWorker();
  assert.equal(page.reloads, 0, 'never under the player\'s hands');
  page.hide();
  page.sleep(30000);
  page.show();
  assert.equal(page.reloads, 0, 'half a minute away: the game is still there');
  assert.notEqual(page.caption(), '', 'and still on the glass');

  page.hide();
  const before = page.saved().lastTick;
  page.sleep(3 * DAY);
  page.show();
  assert.equal(page.reloads, 1);
  assert.equal(page.saved().lastTick, before, 'the absence is left for the reloaded page to replay and show');
});

test('a bfcache return with an update waiting reloads before the absence is replayed', async (t) => {
  const page = await bootMain(t, { state: savedGame('saessak'), sw: true });
  page.type('a', 'KeyA');
  page.newWorker();
  page.hide();
  const before = page.saved().lastTick;
  page.sleep(3 * DAY);
  page.pageshow();
  assert.equal(page.reloads, 1);
  assert.equal(page.saved().lastTick, before);
});

// ---- an egg nobody came back to (매운맛) ---------------------------------------------------------------

test('an egg that hatched and died in one absence goes straight to the star: no name sheet for a pet that is gone', () => {
  const state = engine.newGame(NOON, { tzOffsetMin: 540, rulesMode: 'classic' });
  const w = rig({ state });
  w.scenes.start();
  w.now += 6 * DAY;
  const events = engine.advance(w.state, w.now, { live: false });
  assert.ok(events.some((e) => e.type === 'hatch'));
  assert.ok(events.some((e) => e.type === 'death'), 'six days alone are more than a 매운맛 child survives');
  w.scenes.onEvents(events, { away: true, gapMin: 6 * 1440 });
  assert.equal(w.scenes.name, 'dying');
  w.run(24);
  assert.equal(w.scenes.name, 'memorial');
  w.run(30);
  assert.deepEqual(w.opened, [], 'no sheet asked for a name');
  assert.ok(!w.captions.includes('이름을 지어 주세요'));
});

test('scenes.quiet is true only on a resting home scene', () => {
  const w = rig({ state: grown('tongtong') });
  w.scenes.start();
  assert.equal(w.scenes.quiet, true);
  w.keys('A');
  assert.equal(w.scenes.quiet, false, 'an icon is selected');
  w.keys('C');
  assert.equal(w.scenes.quiet, true);
  w.keys('B');
  assert.equal(w.scenes.name, 'clock');
  assert.equal(w.scenes.quiet, false, 'a scene is playing');
  w.keys('B');
  w.sheet = 'settings';
  w.scenes.onEvents([{ type: 'evolve', from: 'tongtong', to: 'kkabul' }], { away: false });
  assert.equal(w.scenes.quiet, false, 'a reveal is waiting under the sheet');
});

test('a pet brought in by a save code does not get the first-run feeding guide', async (t) => {
  const page = await bootMain(t, { prefs: null });              // a fresh install: an egg, no prefs
  assert.equal(page.app.prefs.seenGuide, false);
  const full = savedGame('saessak', { hunger: 4, happy: 4, name: '옮긴펫' }, LOCAL_NOON - DAY);
  assert.deepEqual(page.app.importCode(exportCode(full)), { ok: true });
  page.run(500);
  assert.equal(page.app.prefs.seenGuide, true);
  assert.match(page.caption(), /옮긴펫/, 'the home caption, not "A로 밥을 골라 B!" over a pet that is full');

  // an imported egg is still a first run
  t.mock.timers.reset();
  const fresh = await bootMain(t, { prefs: null });
  const egg = engine.newGame(LOCAL_NOON - MIN, { tzOffsetMin: -new Date(LOCAL_NOON).getTimezoneOffset() });
  assert.deepEqual(fresh.app.importCode(exportCode(egg)), { ok: true });
  assert.equal(fresh.app.prefs.seenGuide, false);
});
