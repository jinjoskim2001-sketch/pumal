// LCD scene machine and key handling (SPEC 11.1-11.3).
//
// Constraints that shape this file:
// - Two clocks that never mix. Everything here runs on a 250 ms logic tick and draws whole
//   dots through the lcd API; the only smooth thing inside the glass is the LCD's own
//   response-time ghosting. Sprite idle frames flip every second tick (500 ms).
// - Scene timing counts ticks, which is fine for animation. Nothing about the pet's life is
//   counted here: that is the engine's job and it is driven by timestamps.
// - A press is never lost. Keys act on the way down; an animation that is running is cut
//   short by a press instead of swallowing it, and A is passed on to the menu underneath.
// - The engine reports what happened as events. Big ones (hatch, evolve, mature, death) are
//   queued and played one after another when the screen is back at its home scene, so an
//   event that arrives in the middle of a meal is not dropped.
// - Nothing plays unseen. While a sheet (or the install guide) covers the device the queue
//   waits, and until a queued hatch or growth has played the glass keeps showing what the
//   player last saw: the egg, or the old shape. The reveal is the point of the game.
// - What cannot be undone is never one press away. The journey menu opens on "stay", a tap
//   may only point at "go", and the animations that lead to it cannot be mashed through.
// - Captions are one line of at most 18 Hangul characters. In-matrix text is digits only
//   (the bitmap fonts have no letters), so words always go to the caption.

import { SPECIES_ART, ITEMS, FONT_SMALL, FONT_BIG } from './sprites.js';
import { SPECIES } from './data.js';
import { COLS, ROWS } from './lcd.js';
import { createGame, inkBox } from './minigames.js';

export const TICK_MS = 250;

const GROUND_Y = 15;              // top of a standing 16-row sprite: its feet are on row 30
const MENU_IDS = ['food', 'play', 'clean', 'light', 'medicine', 'scold', 'status'];
const ICON_CALL = 7;              // never selectable, lit while the pet is calling
const SELECT_TIMEOUT = 48;        // 12 s
const CALL_BEEP_MS = 20000;
const RECAP_MIN_GAP = 5;          // minutes away before a recap is worth showing
const RECAP_CARD_TICKS = 8;
const CHORD_TICKS = 3;            // A and C within this many ticks count as pressed together
const MATURE_LOCK_TICKS = 8;      // 2 s of "all grown up" before a press can open the journey menu
const NAME_QUIET_TICKS = 4;       // the name sheet opens after 1 s without a press…
const NAME_WAIT_TICKS = 16;       // …or after 4 s at the latest
const SCOLD = 5;                  // index of the scold icon (MENU_IDS)
const AWAY_ORDER = ['hatching', 'recap', 'evolving', 'mature', 'dying'];   // what plays first after an absence

const MENU_LABEL = [
  '밥 주기 · B로 결정', '놀아 주기 · B로 결정', '씻겨 주기 · B로 결정', '불 켜고 끄기 · B로 결정',
  '약 주기 · B로 결정', '훈육하기 · B로 결정', '수첩 보기 · B로 결정',
];
const GUIDE = 'A로 밥을 골라 B! C는 취소';
const CALL_HINT = {
  hunger: '배고프대요! 밥을 주세요',
  happy: '심심하대요! 놀아 주세요',
  lights: '졸리대요! 불을 꺼 주세요',
  tantrum: '떼쓰는 중! 훈육해 주세요',
};
const REFUSE_TEXT = {
  full: '배불러요!',
  sick: '아파서 싫대요… 약 먼저!',
  asleep: '쿨쿨… 자고 있어요',
  tantrum: '싫어! 싫어! (떼쓰는 중)',
  refuse: '싫어! 싫어! (떼쓰는 중)',
  notSick: '아픈 데가 없어요',
  nothing: '이미 깨끗해요!',
  egg: '아직 알이에요',
  paused: '돌보미와 있어요',
};
const EGG_TEXT = ['알을 톡톡 두드려 보세요', '톡! 알이 흔들려요', '톡톡! 금이 갔어요', '조금만 더…!', '곧 나올 것 같아요!'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// Mess piles, right side of the room: first column, then a second one further in.
const POOP_SLOTS = [[40, 23], [40, 14], [31, 23], [31, 14]];
// Hop offsets by steps remaining (index 0 = on the ground).
const HOP_Y = [0, -1, -3, -2];

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

// ---- Korean particles ------------------------------------------------------------------
// The pet's name is typed by the owner, so the particle after it has to be chosen at run time.

function finalConsonant(word) {
  const s = String(word || '');
  const code = s.charCodeAt(s.length - 1) - 0xAC00;
  return code >= 0 && code <= 11171 ? code % 28 : 0;    // not Hangul: treat as open syllable
}
const withIGa = (w) => w + (finalConsonant(w) ? '이' : '가');
const withEuro = (w) => {
  const f = finalConsonant(w);
  return w + (f && f !== 8 ? '으로' : '로');           // ㄹ takes 로
};

// ---- bitmap helpers ----------------------------------------------------------------------

const solidCache = new WeakMap();

// Filled outline of a sprite: everything that cannot be reached from outside the box.
// Hollow line art would otherwise make a poor silhouette.
function silhouette(bmp) {
  let out = solidCache.get(bmp);
  if (out) return out;
  const h = bmp.length, w = bmp[0].length;
  const W = w + 2, H = h + 2;
  const seen = new Uint8Array(W * H);
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j]) continue;
      const inside = nx >= 1 && nx <= w && ny >= 1 && ny <= h;
      if (inside && bmp[ny - 1][nx - 1] === '#') continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  out = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += seen[(y + 1) * W + x + 1] ? '.' : '#';
    out.push(row);
  }
  solidCache.set(bmp, out);
  return out;
}

const artOf = (id) => SPECIES_ART[id] || SPECIES_ART.mongsil;
const frameOf = (a, name) => a[name] || (a.idle && a.idle[0]) || SPECIES_ART.mongsil.idle[0];
const speciesName = (id) => (SPECIES[id] ? SPECIES[id].name : '알');

function backdropAt(ms) {
  const h = new Date(ms).getHours();
  if (h >= 6 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

// ---------------------------------------------------------------------------------------------
// host: { lcd, view(), state(), act(action, payload), prefs, setPrefs(patch), ui, sound(name),
//         setCaption(text), shake(), now(), rng(), frozen, noGhost,
//         covered()  optional: true while something other than a sheet lies over the device }
// ---------------------------------------------------------------------------------------------

export function createScenes(host) {
  const lcd = host.lcd;
  const rng = () => {
    const r = host.rng ? host.rng() : Math.random();
    return r >= 0 && r < 1 ? r : 0;
  };
  const rint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  let v = host.view();
  let cur = { name: 'idle', t: 0, p: {} };
  let sel = -1, selAge = 0;
  let blink = true;
  let pending = [];           // big events waiting for the home scene: [{ name, p }]
  let acting = 0;             // > 0 while one of our own handlers is inside host.act()
  let timer = 0;
  let note = null;            // short-lived caption on the home scene: { text, ticks }
  let lastBeep = -Infinity;
  let game = null, wakeLock = null, wakeAsked = false;
  let iconKey = '';
  let eggShake = 0;
  const lastPress = { A: -99, B: -99, C: -99 };

  // The creature keeps its place and facing between scenes, so coming back from a menu
  // never teleports it.
  const pet = { x: 16, face: 1, mode: 'stand', wait: 6, target: 16, hop: 0, react: null };

  const queued = (name) => pending.some((q) => q.name === name);

  // The species on the glass. A hatch or a growth that is still waiting for its animation
  // has not happened yet as far as the player can see.
  function shownSpecies() {
    for (const q of pending) {
      if (q.name === 'hatching') return 'egg';
      if (q.name === 'evolving' && q.p && q.p.from) return q.p.from;
    }
    return v.species;
  }
  const art = () => artOf(shownSpecies());
  const flipFrame = () => (cur.t >> 1) & 1;
  const say = (text, ticks = 8) => { note = { text, ticks }; };

  function doAct(action, payload) {
    acting++;
    try {
      const r = host.act(action, payload) || { ok: false, reason: 'error', events: [] };
      v = host.view();
      return r;
    } finally {
      acting--;
    }
  }

  // ---- placement ---------------------------------------------------------------------------

  const roomRight = () => (v.poop === 0 ? COLS : v.poop <= 2 ? 39 : 30);
  const maxPetX = () => (v.poop === 0 ? COLS - 16 : roomRight() - 17);   // one clear column before the mess

  // Where a w*h mark goes for a creature frame drawn at px: beside the head, on the side
  // that has room, otherwise above it. Uses the frame's real ink, not the 16x16 box.
  function markSpot(bmp, w, h, px = pet.x, flip = false) {
    const b = inkBox(bmp);
    const left = flip ? 15 - b.right : b.left;
    const right = flip ? 15 - b.left : b.right;
    const top = GROUND_Y + b.top;
    let x = px + right + 2;
    let y = clamp(top - 2, 0, ROWS - h);
    if (x + w > roomRight()) {
      x = px + left - w - 1;
      if (x < 0) {
        x = clamp(px + 4, 0, COLS - w);
        y = Math.max(0, top - h - 1);
      }
    }
    return [x, y];
  }

  function drawMark(mark, frame, px = pet.x, flip = false) {
    const [x, y] = markSpot(frame, mark[0].length, mark.length, px, flip);
    lcd.sprite(mark, x, y);
  }

  function drawPoops(count = v.poop, slots = POOP_SLOTS.length, beforeX = COLS) {
    const n = Math.min(count, slots);
    for (let i = 0; i < n; i++) {
      const [x, y] = POOP_SLOTS[i];
      if (x < beforeX) lcd.sprite(ITEMS.poop[flipFrame()], x, y);
    }
  }

  function drawSparkles() {
    const f = flipFrame();
    lcd.sprite(ITEMS.sparkle[f], 3, 5);
    lcd.sprite(ITEMS.sparkle[1 - f], 38, 3);
    lcd.sprite(ITEMS.sparkle[f], 36, 20);
  }

  function drawPageDots(n, at) {
    const x0 = (COLS - (n * 4 - 2)) >> 1;
    for (let i = 0; i < n; i++) {
      if (i === at) lcd.rect(x0 + i * 4, 29, 2, 2, true);
      else lcd.dot(x0 + i * 4, 30);
    }
  }

  function centerText(str, y, font) {
    const w = lcd.textWidth(str, font);
    return lcd.text(str, (COLS - w) >> 1, y, font);
  }

  // ---- scene switching -----------------------------------------------------------------------

  const baseName = () => (!v.alive ? 'memorial' : v.paused ? 'paused'
    : v.stage === 'egg' || queued('hatching') ? 'egg' : 'idle');
  const isBase = () => cur.name === 'idle' || cur.name === 'egg' || cur.name === 'paused' || cur.name === 'memorial';

  function releaseWake() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock && typeof lock.release === 'function') {
      try { Promise.resolve(lock.release()).catch(() => {}); } catch (err) { /* already gone */ }
    }
  }

  // Held only while a game is really being played: not under a sheet, not after it ended.
  function requestWake() {
    if (wakeLock || wakeAsked) return;
    try {
      const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null;
      if (!wl || typeof wl.request !== 'function') return;
      wakeAsked = true;
      wl.request('screen').then((lock) => {
        wakeAsked = false;
        if (game && cur.name === 'game' && !cur.p.covered && !wakeLock) wakeLock = lock;
        else Promise.resolve(lock.release()).catch(() => {});
      }).catch(() => { wakeAsked = false; });
    } catch (err) { wakeAsked = false; /* the wake lock is a nicety */ }
  }

  function go(name, p) {
    if (game && name !== 'game') {     // a game cut off by something else simply did not happen
      game = null;
      releaseWake();
    }
    cur = { name, t: 0, p: p || {} };
    const def = SCENES[name];
    if (def.enter) def.enter(cur.p);
    render();
  }

  // True while something lies over the device: a sheet, or the install guide.
  function sheetOpen() {
    try {
      return host.ui.isOpen() === true || (typeof host.covered === 'function' && host.covered() === true);
    } catch (err) {
      return false;
    }
  }

  // The next queued scene that still makes sense. The offer of a journey is dropped when the
  // pet is no longer ready for one (the rules were switched while it waited).
  function nextQueued() {
    while (pending.length) {
      const next = pending.shift();
      if (next.name === 'mature' && !v.departReady) continue;
      return next;
    }
    return null;
  }

  function home() {
    v = host.view();
    // Under a sheet the queue waits: tick() calls settle() every 250 ms, so the hatch, the
    // growth or the recap starts the moment the sheet is gone.
    const next = sheetOpen() ? null : nextQueued();
    if (next) {
      go(next.name, next.p);
      return;
    }
    selAge = 0;
    go(baseName());
  }

  // Runs after every input and every outside change: plays what is queued, and follows the
  // game when its base state changed under us (paused in settings, new egg, reset).
  function settle() {
    if (acting || !isBase()) return;
    if (cur.name === 'memorial' && v.alive) host.sound('newEgg');     // started from the postcard sheet
    if ((pending.length && !sheetOpen()) || baseName() !== cur.name) home();
  }

  // ---- drawing and chrome ----------------------------------------------------------------------

  function chrome(def) {
    const dark = v.alive && !v.paused && v.stage !== 'egg' && !v.lightsOn;
    lcd.setTint(dark ? 'glow' : host.prefs.tint);
    const want = typeof def.backdrop === 'function' ? def.backdrop() : def.backdrop;
    const bd = want === false ? null : typeof want === 'string' ? want : backdropAt(host.now());
    lcd.setBackdrop(bd);

    const selected = def.icon ? def.icon() : -1;
    const lit = v.calling && blink;
    const key = `${selected}|${lit ? 1 : 0}`;
    if (key !== iconKey) {
      iconKey = key;
      lcd.setIconState({ selected, lit: lit ? [ICON_CALL] : [] });
    }
    host.setCaption(def.caption ? def.caption() : '');
  }

  function render(snap) {
    const def = SCENES[cur.name];
    chrome(def);
    lcd.clear();
    def.draw();
    if (snap || host.frozen || host.noGhost) lcd.snap(); else lcd.present();
  }

  function tick() {
    v = host.view();
    blink = !blink;
    cur.t++;
    if (note && --note.ticks <= 0) note = null;
    if (v.calling && cur.name === 'idle') beep();
    const def = SCENES[cur.name];
    if (def.tick) def.tick();
    settle();
    render();
  }

  // The call beeps at most once every 20 s, and only while someone can be looking.
  function beep() {
    const t = Date.now();
    if (t - lastBeep < CALL_BEEP_MS) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    lastBeep = t;
    host.sound('call');
    if (!v.asleep && !pet.react) pet.react = { mark: ITEMS.bang, ticks: 4 };
  }

  // ---- shared actions --------------------------------------------------------------------------

  function refuse(reason) {
    const loud = reason === 'tantrum' || reason === 'refuse';
    const soft = reason === 'asleep';               // no buzzer and no shake next to a sleeping pet
    go('refuse', {
      text: REFUSE_TEXT[reason] || '지금은 안 된대요',
      sound: loud ? 'tantrum' : soft ? 'cancel' : 'deny',
      mark: loud ? ITEMS.bang : null,
      soft,
    });
  }

  function feed(kind) {
    const r = doAct(kind);
    if (!r.ok) { refuse(r.reason); return; }
    if (!host.prefs.seenGuide) host.setPrefs({ seenGuide: true });
    go('eating', { kind, gaveIn: r.gaveIn === true });
  }

  function play(kind) {
    const r = doAct('playStart');
    if (!r.ok) { refuse(r.reason); return; }
    go('game', { kind });
  }

  function switchLight(on) {
    const r = doAct('light', { on });
    if (!r.ok) { refuse(r.reason); return; }
    host.sound('light');
    home();
    say(on ? '불을 켰어요' : (v.asleep ? '쉿… 잘 자요' : '불을 껐어요'));
  }

  function depart() {
    const a = art();
    const name = v.name;
    const r = doAct('depart');
    if (!r.ok) { home(); return; }
    go('farewell', { art: a, name, entry: r.entry || null });
  }

  function foodMenu() {
    return {
      icon: 0,
      opts: [
        { bmp: ITEMS.meal[0], text: '밥을 줄까요?', pick: () => feed('meal') },
        { bmp: ITEMS.snack[0], text: '간식을 줄까요?', pick: () => feed('snack') },
      ],
    };
  }

  function playMenu() {
    return {
      icon: 1,
      opts: [
        { bmp: ITEMS.scissors, text: '가위바위보 (C 길게: 그만)', pick: () => play('rps') },
        { bmp: ITEMS.bigStar, text: '별 받기 (C 길게: 그만)', pick: () => play('catch') },
      ],
    };
  }

  function lightMenu() {
    return {
      icon: 3,
      index: v.lightsOn ? 1 : 0,
      opts: [
        { bmp: ITEMS.bulbOn, text: '불 켜기', pick: () => switchLight(true) },
        { bmp: ITEMS.bulbOff, text: '불 끄기', pick: () => switchLight(false) },
      ],
    };
  }

  // Sending the pet away cannot be undone, so nothing about this menu is one press away:
  // it opens on "stay" (B alone keeps the pet), and a tap may point at "go" but only the
  // B key decides it.
  function departMenu() {
    return {
      icon: 6,
      index: 1,
      guard: 0,
      opts: [
        { bmp: ITEMS.journeyBag, text: '여행을 보내 줄까요?', pick: depart },
        { bmp: ITEMS.heartFull, text: '조금 더 같이 있을래요', pick: () => { host.sound('cancel'); home(); } },
      ],
    };
  }

  // B on a selected icon, or a direct tap on an icon.
  function confirm(i) {
    sel = i;
    selAge = 0;
    note = null;
    const id = MENU_IDS[i];
    if (id === 'food') { host.sound('confirm'); go('choice', foodMenu()); return; }
    if (id === 'play') { host.sound('confirm'); go('choice', playMenu()); return; }
    if (id === 'light') { host.sound('confirm'); go('choice', lightMenu()); return; }
    if (id === 'status') { host.sound('confirm'); go('status', { page: 0 }); return; }
    if (id === 'clean') {
      const count = v.poop;
      const r = doAct('clean');
      if (r.ok) { go('cleaning', { count }); return; }
      if (r.reason === 'nothing') {
        host.sound('select');
        say(REFUSE_TEXT.nothing);
        if (!v.asleep) pet.react = { mark: ITEMS.sparkle[0], ticks: 4 };
        return;
      }
      refuse(r.reason);
      return;
    }
    if (id === 'medicine') {
      const r = doAct('medicine');
      if (r.ok) go('medicine', { cured: r.cured === true });
      else refuse(r.reason);
      return;
    }
    if (id === 'scold') {
      const r = doAct('scold');
      if (r.ok) go('scolding', { fair: true });
      else if (r.reason === 'unfair') go('scolding', { fair: false });
      else refuse(r.reason);
    }
  }

  function stroke() {
    const r = doAct('pet');
    if (r.ok) {
      host.sound('pet');
      pet.react = { frame: 'happy', mark: ITEMS.heartPop, ticks: 5, text: r.effective === false ? '헤헤, 간지러워요' : '쓰담쓰담~ 좋아요!' };
      pet.hop = 0;
    } else if (r.reason === 'asleep') {
      say('쉿… 자고 있어요', 6);
    }
  }

  function callHint() {
    const reason = v.callReasons[0];
    host.sound(reason ? 'call' : 'select');
    say(reason ? CALL_HINT[reason] || '부르고 있어요!' : '지금은 부르지 않아요');
  }

  const guideOn = () => !host.prefs.seenGuide && v.alive && v.stage !== 'egg' && !v.asleep && !v.sick && !v.tantrum;

  function tapEgg() {
    const r = doAct('tapEgg');
    eggShake = 3;
    if (r.ok && !r.hatched) host.sound('select');
  }

  function finishGame() {
    const g = game;
    game = null;
    releaseWake();
    const r = g && g.result ? g.result : { completed: false, won: false };
    if (r.completed) doAct('playEnd', { won: r.won === true, completed: true });
    else host.sound('cancel');
    home();
  }

  function lastEntry() {
    const album = host.state().album;
    return Array.isArray(album) && album.length ? album[album.length - 1] : null;
  }

  function openPostcard(entry, extra) {
    if (!entry) return;
    try { host.ui.open('postcard', { entry, ...extra }); } catch (err) { /* the sheet is optional */ }
  }

  // Default for scenes without their own key handler: a press ends the animation, and A
  // carries on into the menu so cycling never feels stuck behind an animation.
  function skip(k) {
    const def = SCENES[cur.name];
    if (def.locked && def.locked()) return;
    if (def.end) def.end(); else home();
    if (k === 'A' && cur.name === 'idle') SCENES.idle.key('A');
  }

  // ---- the home scene: wandering ------------------------------------------------------------------

  function wander() {
    const maxX = maxPetX();
    if (pet.react && --pet.react.ticks <= 0) pet.react = null;
    if (v.asleep) { pet.mode = 'stand'; pet.hop = 0; pet.x = clamp(pet.x, 0, maxX); return; }
    if (pet.x > maxX) { pet.x--; pet.face = -1; pet.mode = 'stand'; return; }   // step away from the mess
    const mood = v.mood;
    if (mood === 'sick') { pet.hop = 0; return; }
    if (mood === 'upset') { if (cur.t % 2 === 0) pet.face = -pet.face; return; }  // stomping about
    if (pet.react) return;
    if (pet.hop > 0) { pet.hop--; return; }
    const slow = mood === 'sad';
    if (pet.mode === 'walk') {
      if (slow && cur.t % 2) return;
      pet.target = clamp(pet.target, 0, maxX);
      if (pet.x === pet.target) {
        pet.mode = 'stand';
        pet.wait = rint(4, 12) * (slow ? 2 : 1);
        return;
      }
      pet.face = pet.target > pet.x ? 1 : -1;
      pet.x += pet.face;
      return;
    }
    if (--pet.wait > 0) return;
    const r = rng();
    if (!slow && r < (mood === 'happy' ? 0.3 : 0.08)) {
      pet.hop = 3;
      pet.wait = rint(3, 8);
    } else if (r < 0.5) {
      pet.face = -pet.face;
      pet.wait = rint(3, 10);
    } else {
      pet.mode = 'walk';
      pet.target = rint(0, maxX);
    }
  }

  function drawHome() {
    drawPoops();
    const a = art();
    const f = flipFrame();
    if (v.asleep) {
      const frame = frameOf(a, 'sleep');
      lcd.sprite(frame, pet.x, GROUND_Y, { flipX: pet.face < 0 });
      drawMark(ITEMS.zzz[f], frame, pet.x, pet.face < 0);
      return;
    }
    const mood = v.mood;
    const flip = pet.face < 0;
    let frame = a.idle[f];
    let mark = null;
    let dx = 0, dy = 0;
    if (pet.react) {
      if (pet.react.frame) frame = frameOf(a, pet.react.frame);
      mark = pet.react.mark || null;
      if (pet.react.frame === 'happy' && pet.react.ticks % 2) dy = -1;
    } else if (pet.hop > 0) {
      frame = frameOf(a, 'happy');
      dy = HOP_Y[pet.hop] || 0;
    } else if (mood === 'sick') {
      frame = frameOf(a, 'upset');
      mark = ITEMS.skull;
      if (cur.t % 4 === 3) dx = 1;                       // a shiver
    } else if (mood === 'upset') {
      frame = frameOf(a, 'upset');
      if (f === 0) mark = ITEMS.bang;
    } else if (mood === 'sad') {
      frame = f ? frameOf(a, 'upset') : a.idle[0];
      if (f === 0) mark = v.hunger === 0 ? ITEMS.meal[2] : ITEMS.heartEmpty;   // what it is missing
    }
    if (!mark && guideOn() && sel < 0 && f === 0) mark = ITEMS.meal[0];        // first run: asking for food
    lcd.sprite(frame, pet.x + dx, GROUND_Y + dy, { flipX: flip });
    if (mark) drawMark(mark, frame, pet.x, flip);
  }

  function homeCaption() {
    if (note) return note.text;
    if (sel >= 0) return MENU_LABEL[sel];
    if (v.asleep) return v.callReasons.includes('lights') ? '졸려요… 불 꺼 주세요' : `쿨쿨… ${v.name} 자는 중`;
    if (pet.react && pet.react.text) return pet.react.text;
    if (v.tantrum) return '싫어! 싫어! (떼쓰는 중)';
    if (v.sick) return '아파요… 약 주세요';
    if (guideOn()) return GUIDE;
    if (v.hunger === 0) return '배고파요…';
    if (v.happy === 0) return '심심해요… 놀아 줘요';
    if (v.poop > 0) return '응가 치워 주세요!';
    if (v.departReady && (cur.t >> 4) & 1) return '여행을 떠나고 싶대요';
    return `${v.name} · ${v.ageDays}살`;
  }

  // ---- status pages -------------------------------------------------------------------------------

  const statusPages = () => (v.departReady ? 5 : 4);

  function drawHearts(n, y) {
    for (let i = 0; i < 4; i++) lcd.sprite(i < n ? ITEMS.heartFull : ITEMS.heartEmpty, 5 + i * 10, y);
  }

  function drawAgeWeight() {
    lcd.sprite(ITEMS.cake, 6, 3);
    lcd.text(String(v.ageDays), 19, 2, FONT_BIG);
    lcd.sprite(ITEMS.scale, 6, 17);
    const x = lcd.text(String(v.weight), 19, 16, FONT_BIG);
    lcd.text('g', x + 2, 20, FONT_SMALL);
  }

  function drawStatus(page) {
    if (page === 0) {
      drawAgeWeight();
    } else if (page === 1) {
      lcd.sprite(ITEMS.meal[0], 20, 4);
      drawHearts(v.hunger, 17);
    } else if (page === 2) {
      lcd.sprite(ITEMS.note, 20, 4);
      drawHearts(v.happy, 17);
    } else if (page === 3) {
      for (let i = 0; i < 4; i++) {
        if (i < v.discipline) lcd.rect(3 + i * 11, 5, 9, 6, true); else lcd.frame(3 + i * 11, 5, 9, 6);
      }
      for (let i = 0; i < 5; i++) lcd.sprite(i < v.bondStars ? ITEMS.starFull : ITEMS.starEmpty, 2 + i * 9, 17);
    } else {
      lcd.sprite(ITEMS.journeyBag, 8, 8);
      lcd.sprite(ITEMS.arrow, 23, 12);
      lcd.sprite(SPECIES_ART.egg.idle[flipFrame()], 30, 7);
    }
    drawPageDots(statusPages(), page);
  }

  function statusCaption(page) {
    if (page === 0) return `${v.ageDays}살 · ${v.weight}g`;
    if (page === 1) return v.hunger === 4 ? '배부름 · 든든해요' : v.hunger === 0 ? '배부름 · 텅 비었어요' : '배부름';
    if (page === 2) return v.happy === 4 ? '기분 · 최고예요' : v.happy === 0 ? '기분 · 시무룩해요' : '기분';
    if (page === 3) return '버릇 · 교감';
    return 'B: 여행 보내기';
  }

  // ---- scenes --------------------------------------------------------------------------------------

  const SCENES = {
    egg: {
      enter() { eggShake = 0; },
      tick() { if (eggShake > 0) eggShake--; },
      draw() {
        const e = SPECIES_ART.egg;
        const taps = host.state().pet.eggTaps | 0;
        let frame;
        if (taps >= 3) frame = e.crack[1];
        else if (taps >= 1) frame = e.crack[0];
        else frame = e.idle[(cur.t % 12) < 4 ? flipFrame() : 0];     // a wobble, then a rest
        const dx = eggShake > 0 ? (eggShake % 2 ? 1 : -1) : 0;
        lcd.sprite(frame, 16 + dx, GROUND_Y);
      },
      key() { tapEgg(); },
      tap(hit) {
        if (hit.zone === 'icon') { host.sound('select'); say(REFUSE_TEXT.egg, 6); return; }
        tapEgg();
      },
      caption() {
        if (note) return note.text;
        return EGG_TEXT[clamp(host.state().pet.eggTaps | 0, 0, EGG_TEXT.length - 1)];
      },
    },

    hatching: {
      tick() {
        if (cur.t === 2) host.sound('hatch');       // its three shell ticks fall on the cracks, the fanfare on the baby
        if (cur.t >= 18) go('naming');
      },
      // The player is told to keep tapping the egg, so presses keep coming: they must not
      // cut the one reveal of this pet short. It is 4.5 s long and ends by itself.
      locked: () => true,
      draw() {
        const e = SPECIES_ART.egg;
        const t = cur.t;
        if (t < 2) lcd.sprite(e.crack[0], 16 + (t % 2 ? 1 : -1), GROUND_Y);
        else if (t < 4) lcd.sprite(e.crack[1], 16 + (t % 2 ? 1 : -1), GROUND_Y);
        else if (t < 8) {
          lcd.sprite(e.crack[2], 16, GROUND_Y);
          lcd.sprite(ITEMS.sparkle[flipFrame()], 4, 6);
          lcd.sprite(ITEMS.sparkle[1 - flipFrame()], 37, 8);
        } else {
          const a = SPECIES_ART.mongsil;
          const up = t % 4 < 2;
          lcd.sprite(up ? a.happy : a.idle[0], 16, GROUND_Y - (up ? 2 : 0));
          drawSparkles();
        }
      },
      caption: () => (cur.t < 4 ? '빠직… 빠지직!' : '알에서 깨어났어요!'),
    },

    // Opens the name sheet and waits under it. The sheet has no close callback in its
    // contract, so this watches isOpen(); with no sheet at all it simply moves on.
    // The sheet is never opened under a finger: its backdrop closes it, so a player who is
    // still tapping the egg would dismiss it unseen and the pet would keep the default name.
    // It opens once the presses have stopped for a second (or after four at the latest), and
    // never on top of another sheet: ui.open() replaces whatever is showing.
    naming: {
      enter(p) { p.asked = false; p.waited = 0; },
      tick() {
        const p = cur.p;
        if (p.asked) {
          if (cur.t >= 2 && !sheetOpen()) home();
          return;
        }
        if (sheetOpen()) { cur.t = 0; return; }
        p.waited++;
        if (cur.t < NAME_QUIET_TICKS && p.waited < NAME_WAIT_TICKS) return;
        p.asked = true;
        cur.t = 0;
        try { host.ui.open('name', { first: true }); } catch (err) { /* no sheet: keep the default name */ }
      },
      draw() { lcd.sprite(art().idle[flipFrame()], 16, GROUND_Y); },
      caption: () => '이름을 지어 주세요',
      // Before the sheet: a press only restarts the quiet second. After it (keys are blocked
      // while it is open, so it has just closed or never came): the press moves on.
      key(k) {
        if (!cur.p.asked) { cur.t = 0; return; }
        if (sheetOpen()) return;
        home();
        if (k === 'A' && cur.name === 'idle') SCENES.idle.key('A');
      },
      tap() {
        if (!cur.p.asked) cur.t = 0;
        else if (!sheetOpen()) home();
      },
    },

    idle: {
      tick() {
        if (sel >= 0 && ++selAge >= SELECT_TIMEOUT) sel = -1;
        wander();
      },
      draw: drawHome,
      caption: homeCaption,
      icon: () => sel,
      key(k) {
        if (k === 'A') {
          sel = sel >= MENU_IDS.length - 1 ? -1 : sel + 1;
          selAge = 0;
          note = null;
          host.sound('select');
        } else if (k === 'B') {
          if (sel < 0) { host.sound('confirm'); go('clock'); } else confirm(sel);
        } else if (sel >= 0) {
          sel = -1;
          host.sound('cancel');
        } else if (!v.asleep && v.mood !== 'sick' && v.mood !== 'upset' && !pet.react) {
          pet.face = -pet.face;                 // nothing to cancel: it looks round at you
          if (v.mood !== 'sad') pet.hop = 3;
        }
      },
      tap(hit) {
        if (hit.zone === 'icon') {
          if (hit.index === ICON_CALL) callHint();
          else if (hit.index === SCOLD && !v.tantrum && sel !== SCOLD) {
            // The one icon whose confirm costs something (an unfair scold takes a heart), and
            // it sits right under the creature's feet: with no tantrum the first tap only
            // selects it, as A would. A second tap, or B, scolds.
            sel = SCOLD;
            selAge = 0;
            note = null;
            host.sound('select');
          } else confirm(hit.index);
          return;
        }
        if (v.asleep || (hit.x >= pet.x - 3 && hit.x <= pet.x + 18)) { stroke(); return; }
        pet.mode = 'walk';                      // a tap on the floor: it comes over
        pet.target = clamp(hit.x - 8, 0, maxPetX());
        pet.react = null;
      },
    },

    // Two-option submenu: food, play, light, farewell. The creature watches from the right.
    choice: {
      enter(p) { p.index = p.index || 0; p.hint = 0; },
      tick() {
        if (cur.p.hint > 0) cur.p.hint--;
        if (cur.t >= SELECT_TIMEOUT) home();
      },
      draw() {
        const p = cur.p;
        p.opts.forEach((o, i) => {
          const h = o.bmp.length;
          const y = (i === 0 ? 8 : 23) - (h >> 1);
          lcd.sprite(o.bmp, 11, y);
          if (i === p.index) lcd.sprite(ITEMS.arrow, 3, (i === 0 ? 8 : 23) - 3);
        });
        const a = art();
        lcd.sprite(v.asleep ? frameOf(a, 'sleep') : a.idle[flipFrame()], 31, GROUND_Y, { flipX: true });
      },
      caption: () => (cur.p.hint > 0 ? 'B 버튼으로 결정해요' : cur.p.opts[cur.p.index].text),
      icon: () => cur.p.icon,
      key(k) {
        const p = cur.p;
        p.hint = 0;
        if (k === 'A') { p.index = (p.index + 1) % p.opts.length; cur.t = 0; host.sound('select'); }
        else if (k === 'B') p.opts[p.index].pick();
        else { host.sound('cancel'); home(); }
      },
      tap(hit) {
        if (hit.zone === 'icon') { home(); if (cur.name === 'idle') SCENES.idle.tap(hit); return; }
        if (hit.x >= 30) return;                         // the creature is only watching
        const p = cur.p;
        const i = hit.y < 16 ? 0 : 1;
        if (p.guard === i) {
          // The guarded option (see departMenu): a tap points at it and says how to decide.
          if (p.index === i) p.hint = 10;
          p.index = i;
          cur.t = 0;
          host.sound('select');
          return;
        }
        p.index = i;
        p.opts[i].pick();
      },
    },

    eating: {
      enter() { pet.x = Math.min(pet.x, (v.poop ? 39 : COLS) - 26); pet.face = 1; pet.react = null; pet.hop = 0; },   // room for the dish on its right
      tick() {
        const t = cur.t;
        if (t === 2 || t === 4 || t === 6) host.sound(cur.p.kind === 'snack' ? 'snack' : 'eat');
        if (t === 8) host.sound('happy');
        if (t >= 14) home();
      },
      draw() {
        const a = art();
        const t = cur.t;
        const item = ITEMS[cur.p.kind === 'snack' ? 'snack' : 'meal'];
        drawPoops(v.poop, 2);
        if (t < 8) {
          const bite = t >= 2 && t % 2 === 0;
          const left = t < 3 ? 0 : t < 5 ? 1 : t < 7 ? 2 : 3;      // how much has been eaten
          lcd.sprite(bite ? frameOf(a, 'eat') : a.idle[0], pet.x, GROUND_Y);
          if (left < 3) lcd.sprite(item[left], pet.x + 18, GROUND_Y + 7);
        } else {
          const frame = frameOf(a, 'happy');
          lcd.sprite(frame, pet.x, GROUND_Y - (t % 2 ? 2 : 0));
          lcd.sprite(ITEMS.heartPop, pet.x + 19, GROUND_Y + 1);
        }
      },
      caption() {
        if (cur.t < 8) return cur.p.kind === 'snack' ? '간식이다! 냠냠' : '냠냠… 맛있어요';
        return cur.p.gaveIn ? '간식으로 달랬어요…' : '잘 먹었어요!';
      },
      icon: () => 0,
    },

    refuse: {
      enter(p) { host.sound(p.sound || 'deny'); if (!p.soft) host.shake(); },
      tick() { if (cur.t >= 8) home(); },
      draw() {
        drawPoops();
        const a = art();
        if (v.stage === 'egg') { lcd.sprite(SPECIES_ART.egg.idle[cur.t % 2], 16, GROUND_Y); return; }
        if (v.asleep) {
          const frame = frameOf(a, 'sleep');
          lcd.sprite(frame, pet.x, GROUND_Y, { flipX: pet.face < 0 });
          drawMark(ITEMS.zzz[flipFrame()], frame, pet.x, pet.face < 0);
          return;
        }
        const frame = frameOf(a, 'upset');
        const flip = cur.t < 6 ? cur.t % 2 === 1 : pet.face < 0;       // head shake
        lcd.sprite(frame, pet.x, GROUND_Y, { flipX: flip });
        if (cur.p.mark && cur.t % 2 === 0) drawMark(cur.p.mark, frame, pet.x, false);
      },
      caption: () => cur.p.text,
      icon: () => sel,
    },

    cleaning: {
      enter() { host.sound('clean'); },
      tick() { if (cur.t >= 15) home(); },
      draw() {
        const a = art();
        const waveX = 44 - cur.t * 5;                  // sweeps right to left, 5 dots a tick
        const washed = waveX < pet.x;
        drawPoops(cur.p.count, POOP_SLOTS.length, waveX);
        const frame = v.asleep ? frameOf(a, 'sleep') : washed ? frameOf(a, 'happy') : a.idle[flipFrame()];
        lcd.sprite(frame, pet.x, GROUND_Y, { flipX: pet.face < 0 });
        if (waveX > -8) lcd.sprite(ITEMS.wave, waveX, 0, { clear: true });
        else drawSparkles();
      },
      caption: () => (cur.t < 11 ? '쓱싹쓱싹…' : '깨끗해졌어요!'),
      icon: () => 2,
    },

    medicine: {
      enter() { pet.x = Math.min(pet.x, (v.poop ? 39 : COLS) - 30); pet.face = 1; pet.react = null; host.sound('medicine'); },
      tick() {
        if (cur.t === 5 && cur.p.cured) host.sound('cured');
        if (cur.t >= 13) home();
      },
      draw() {
        const a = art();
        const t = cur.t;
        drawPoops(v.poop, 2);
        if (t < 3) {
          lcd.sprite(frameOf(a, 'upset'), pet.x, GROUND_Y);
          lcd.sprite(ITEMS.pill, pet.x + 22 - t * 2, GROUND_Y + 7);
        } else if (t < 5) {
          lcd.sprite(frameOf(a, 'eat'), pet.x, GROUND_Y);
        } else if (cur.p.cured) {
          lcd.sprite(frameOf(a, 'happy'), pet.x, GROUND_Y - (t % 2 ? 2 : 0));
          lcd.sprite(ITEMS.sparkle[flipFrame()], pet.x + 19, GROUND_Y);
          // kept inside the room: the matrix edge, or the mess pile when there is one
          lcd.sprite(ITEMS.sparkle[1 - flipFrame()], Math.min(pet.x + 28, (v.poop ? 39 : COLS) - 7), GROUND_Y + 8);
        } else {
          const frame = frameOf(a, 'upset');
          lcd.sprite(frame, pet.x, GROUND_Y);
          drawMark(ITEMS.skull, frame, pet.x, false);
        }
      },
      caption() {
        if (cur.t < 5) return '꿀꺽… 약을 먹어요';
        return cur.p.cured ? '다 나았어요!' : '약이 더 필요해요';
      },
      icon: () => 4,
    },

    scolding: {
      enter(p) { host.sound('scold'); if (!p.fair) host.shake(); },
      tick() {
        if (cur.t === 5 && !cur.p.fair) host.sound('sad');
        if (cur.t >= 11) home();
      },
      draw() {
        drawPoops();
        const a = art();
        const t = cur.t;
        const flip = pet.face < 0;
        const frame = frameOf(a, 'upset');
        if (t < 3) {
          lcd.sprite(frame, pet.x, GROUND_Y, { flipX: flip });
          if (t % 2 === 0) drawMark(ITEMS.bang, frame, pet.x, flip);
        } else if (cur.p.fair) {
          // a bow: the body dips and the floor line hides what goes below it
          const dip = t % 2 ? 3 : 1;
          lcd.sprite(a.idle[1].slice(0, 16 - dip), pet.x, GROUND_Y + dip, { flipX: flip });
        } else {
          lcd.sprite(frame, pet.x, GROUND_Y, { flipX: flip });
          drawMark(ITEMS.sweat, frame, pet.x, flip);
        }
      },
      caption() {
        if (cur.t < 3) return '이놈!';
        return cur.p.fair ? '떼를 뚝! 버릇이 늘었어요' : '잘못한 게 없는데… 시무룩';
      },
      icon: () => 5,
    },

    status: {
      tick() { if (cur.t >= 80) home(); },
      draw() { drawStatus(cur.p.page); },
      caption: () => statusCaption(cur.p.page),
      icon: () => 6,
      backdrop: false,
      key(k) {
        const n = statusPages();
        if (k === 'C') { host.sound('cancel'); home(); return; }
        if (k === 'B' && cur.p.page === 4) { host.sound('confirm'); go('choice', departMenu()); return; }
        if (k === 'B' && cur.p.page >= n - 1) { home(); return; }
        cur.p.page = (cur.p.page + 1) % n;
        cur.t = 0;
        host.sound('select');
      },
      tap(hit) {
        if (hit.zone === 'icon') { home(); if (cur.name === 'idle') SCENES.idle.tap(hit); return; }
        // A tap only turns the pages. Opening the journey menu takes the B key, so tapping
        // through the pages can never run on into it.
        SCENES.status.key('A');
      },
    },

    clock: {
      tick() { if (cur.t >= 40) home(); },
      draw() {
        const d = new Date(host.now());
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const h = d.getHours();
        lcd.sprite(h >= 6 && h < 18 ? ITEMS.sun : ITEMS.moon, 20, 1);
        // ' ' is as wide as ':' in the big font, so the blink never moves the digits
        centerText(`${hh}${flipFrame() ? ' ' : ':'}${mm}`, 12, FONT_BIG);
        centerText(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`, 25, FONT_SMALL);
      },
      caption() {
        const d = new Date(host.now());
        return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
      },
      backdrop: false,
    },

    game: {
      enter(p) {
        game = createGame(p.kind, { rng: host.rng, art: art(), stage: v.stage, sound: host.sound });
        requestWake();
      },
      tick() {
        if (!game) { home(); return; }
        // Keys are blocked under a sheet: do not let stars fall unseen, and do not keep the
        // display awake for a game nobody can play.
        if (sheetOpen()) {
          if (!cur.p.covered) { cur.p.covered = true; releaseWake(); }
          return;
        }
        if (cur.p.covered) { cur.p.covered = false; requestWake(); }
        game.tick(TICK_MS);
        if (game.done) finishGame();
      },
      draw() { if (game) game.draw(lcd); },
      caption: () => (game ? game.caption : ''),
      icon: () => 1,
      backdrop: false,
      key(k) {
        if (!game) return;
        game.key(k);
        if (game.done) finishGame();
      },
      tap(hit) {
        if (hit.zone !== 'matrix') return;
        SCENES.game.key(hit.x < 16 ? 'A' : hit.x < 32 ? 'B' : 'C');   // thirds, in key order
      },
    },

    evolving: {
      tick() {
        if (cur.t >= 4 && cur.t < 10 && cur.t % 2 === 0) host.sound('countdown');
        if (cur.t === 10) host.sound('evolve');     // 1.1 s long: it ends as the new shape is revealed
        if (cur.t >= 28) home();
      },
      locked: () => cur.t < 14,
      draw() {
        const t = cur.t;
        const from = artOf(cur.p.from), to = artOf(cur.p.to);
        const still = calm && calm.matches;
        if (t < 4) {
          lcd.sprite(from.idle[flipFrame()], 16, GROUND_Y);
        } else if (t < 10) {
          // 250 ms per state = a 2 Hz flash, inside the 3 Hz limit
          if (t % 2 === 0 && !still) {
            lcd.rect(0, 0, COLS, ROWS, true);
            lcd.sprite(from.idle[0], 16, GROUND_Y, { invert: true });
          } else {
            lcd.sprite(silhouette(from.idle[0]), 16, GROUND_Y);
          }
        } else if (t < 14) {
          if (t % 2 === 0 && !still) {
            lcd.rect(0, 0, COLS, ROWS, true);
            lcd.sprite(to.idle[0], 16, GROUND_Y, { invert: true });
          } else {
            lcd.sprite(silhouette(to.idle[0]), 16, GROUND_Y);
          }
        } else {
          const up = t % 4 < 2;
          lcd.sprite(up ? frameOf(to, 'happy') : to.idle[0], 16, GROUND_Y - (up ? 2 : 0));
          drawSparkles();
        }
      },
      caption() {
        if (cur.t < 4) return '어라…? 몸이 반짝여요';
        if (cur.t < 14) return '두근두근…!';
        return `${withIGa(v.name)} ${withEuro(speciesName(cur.p.to))} 자랐어요!`;
      },
      backdrop: false,
    },

    recap: {
      enter() { host.sound('toast'); },
      tick() {
        if (cur.t >= cur.p.cards.length * RECAP_CARD_TICKS) { home(); return; }
        if (cur.t % RECAP_CARD_TICKS === 0) host.sound('select');
      },
      draw() {
        const card = cur.p.cards[Math.min(cur.p.cards.length - 1, Math.floor(cur.t / RECAP_CARD_TICKS))];
        const a = art();
        if (v.stage === 'egg') lcd.sprite(SPECIES_ART.egg.idle[flipFrame()], 4, GROUND_Y);
        else lcd.sprite(card.frame === 'idle' ? a.idle[flipFrame()] : frameOf(a, card.frame), 4, GROUND_Y);
        if (card.poops) {
          for (let i = 0; i < card.poops; i++) lcd.sprite(ITEMS.poop[flipFrame()], 26 + (i % 2) * 11, i < 2 ? 18 : 6);
        }
        (card.marks || []).forEach((m, i) => lcd.sprite(m, 27 + i * 10, 10));
        drawPageDots(cur.p.cards.length, Math.min(cur.p.cards.length - 1, Math.floor(cur.t / RECAP_CARD_TICKS)));
      },
      caption() {
        return cur.p.cards[Math.min(cur.p.cards.length - 1, Math.floor(cur.t / RECAP_CARD_TICKS))].text;
      },
      backdrop: false,
    },

    mature: {
      enter() { host.sound('mature'); pet.x = clamp(8, 0, maxPetX()); pet.face = 1; },
      tick() { if (cur.t >= 14) go('choice', departMenu()); },
      // Arrives unannounced, often while B is being pressed for something else.
      locked: () => cur.t < MATURE_LOCK_TICKS,
      end() { go('choice', departMenu()); },
      draw() {
        const a = art();
        const up = cur.t % 4 < 2;
        lcd.sprite(up ? frameOf(a, 'happy') : a.idle[0], 8, GROUND_Y - (up ? 2 : 0));
        lcd.sprite(ITEMS.journeyBag, 30, GROUND_Y + 4);
        lcd.sprite(ITEMS.sparkle[flipFrame()], 38, 4);
      },
      caption: () => '다 자랐어요! 여행 갈까요?',
    },

    farewell: {
      enter() { host.sound('depart'); },
      // ui.open() replaces whatever is showing, so the postcard waits for an open sheet.
      tick() { if (cur.t >= 26 && !sheetOpen()) SCENES.farewell.end(); },
      end() { const entry = cur.p.entry; home(); openPostcard(entry); },
      draw() {
        const a = cur.p.art;
        const x = 14 + cur.t * 2;                       // walks off to the right, bag on its back
        if (x < COLS) {
          lcd.sprite(a.idle[flipFrame()], x, GROUND_Y);
          lcd.sprite(ITEMS.journeyBag, x - 13, GROUND_Y + 4);
        }
        if (cur.t >= 8) lcd.sprite(SPECIES_ART.egg.idle[flipFrame()], 2, GROUND_Y);
      },
      caption: () => (cur.t < 12 ? `${withIGa(cur.p.name)} 길을 나서요` : '알을 남기고 떠났어요'),
    },

    dying: {
      enter() { host.sound('death'); },
      tick() { if (cur.t >= 24) home(); },
      draw() {
        const a = art();
        const t = cur.t;
        if (t < 8) {
          if (t % 2 === 0) lcd.sprite(frameOf(a, 'sleep'), 16, GROUND_Y);
        } else {
          const y = Math.max(2, 18 - (t - 8) * 2);
          lcd.sprite(ITEMS.bigStar, 18, y);
          if (y === 2) { lcd.sprite(ITEMS.sparkle[flipFrame()], 5, 6); lcd.sprite(ITEMS.sparkle[1 - flipFrame()], 36, 9); }
        }
      },
      caption: () => (cur.t < 8 ? '…' : `${withIGa(v.name)} 별이 되었어요`),
      backdrop: 'night',
    },

    memorial: {
      // cur.t restarts with every scene, so presses remembered from an earlier memorial (or
      // from before this one) must not count towards the A+C chord here.
      enter() { lastPress.A = lastPress.B = lastPress.C = -99; },
      tick() { if (cur.p.info > 0) cur.p.info--; },
      draw() {
        if (cur.p.info > 0) { drawAgeWeight(); return; }
        const f = flipFrame();
        lcd.sprite(ITEMS.bigStar, 18, 2 + ((cur.t >> 2) & 1));
        lcd.sprite(ITEMS.sparkle[f], 4, 5);
        lcd.sprite(ITEMS.sparkle[1 - f], 38, 17);
        if (v.leftEgg) lcd.sprite(SPECIES_ART.egg.idle[(cur.t % 12) < 4 ? f : 0], 16, GROUND_Y);
      },
      caption() {
        if (note) return note.text;
        if (cur.p.info > 0) return `${v.ageDays}살 · ${v.weight}g`;
        if ((cur.t >> 4) & 1) return 'B 기록 · A+C 새 알';
        return v.leftEgg ? '알을 남기고 별이 됐어요' : `${withIGa(v.name)} 별이 되었어요`;
      },
      backdrop: () => (cur.p.info > 0 ? false : 'night'),     // the record page is plain, like the status pages
      key(k, held) {
        const other = k === 'A' ? 'C' : k === 'C' ? 'A' : null;
        const since = other ? cur.t - lastPress[other] : -1;
        const chord = other && ((held && held.has(other)) || (since >= 0 && since <= CHORD_TICKS));
        lastPress[k] = cur.t;
        if (chord) {
          const r = doAct('newEgg');
          if (r.ok) { lastPress.A = lastPress.C = -99; settle(); }
          return;
        }
        if (k === 'B') { cur.p.info = cur.p.info > 0 ? 0 : 16; host.sound('select'); return; }
        say('A와 C를 함께: 새 알', 8);
      },
      tap(hit) {
        if (hit.zone === 'matrix') openPostcard(lastEntry(), { newEgg: true });   // the sheet's button starts the new egg
        else say('B 기록 · A+C 새 알', 8);
      },
    },

    paused: {
      draw() {
        const a = art();
        if (v.stage === 'egg') lcd.sprite(SPECIES_ART.egg.idle[0], 6, GROUND_Y);
        else lcd.sprite(a.idle[flipFrame()], 6, GROUND_Y);
        lcd.sprite(ITEMS.sitter, 28, GROUND_Y + 6 - flipFrame());
      },
      caption: () => (note ? note.text : '돌보미와 있어요'),
      key() { say('설정에서 다시 데려와요', 10); },
      tap() { say('설정에서 다시 데려와요', 10); },
    },
  };

  // ---- engine events ---------------------------------------------------------------------------------

  function recapCards(events) {
    const count = (type) => events.reduce((n, e) => n + (e.type === type ? 1 : 0), 0);
    const called = (reason) => events.some((e) => e.type === 'callStart' && e.reason === reason);
    const cards = [];
    if (count('wake')) cards.push({ frame: 'sleep', marks: [ITEMS.zzz[0]], text: '쿨쿨 잘 잤어요' });
    if (count('lightsAuto')) cards.push({ frame: 'sleep', marks: [ITEMS.bulbOff], text: '혼자 불 끄고 잤어요' });
    const poops = count('poop');
    if (poops) cards.push({ frame: 'idle', poops: Math.min(4, poops), text: `응가를 ${poops}번 했어요` });
    if (count('sick')) cards.push({ frame: 'upset', marks: [ITEMS.skull], text: '아파서 끙끙 앓았어요' });
    if (called('hunger')) cards.push({ frame: 'upset', marks: [ITEMS.meal[2]], text: '배가 많이 고팠어요' });
    else if (called('happy')) cards.push({ frame: 'upset', marks: [ITEMS.heartEmpty], text: '많이 심심했어요' });
    if (count('awaySkip')) cards.push({ frame: 'upset', marks: [ITEMS.sweat], text: '오래오래 기다렸어요' });
    if (count('evolve') > 1) cards.push({ frame: 'happy', marks: [ITEMS.sparkle[0]], text: '그동안 쑥쑥 자랐어요' });
    if (!cards.length) return cards;
    if (cards.length > 4) cards.length = 4;
    const night = count('sleep') > 0 || count('wake') > 0;
    cards.unshift({ frame: 'idle', marks: [night ? ITEMS.moon : ITEMS.sun], text: '없는 동안…' });
    return cards;
  }

  function onAway(events, gapMin) {
    const has = (type) => events.some((e) => e.type === type);
    const died = has('death');
    const seq = [];
    // The egg hatches first: the recap is about a creature the player has not met until then.
    // Not for a pet that is already gone (매운맛, an egg left for days): the hatch ends in the
    // name sheet, and nobody should be asked to name a star.
    if (died) pending = pending.filter((q) => q.name !== 'hatching');
    else if (has('hatch')) seq.push({ name: 'hatching' });
    if (!died && gapMin >= RECAP_MIN_GAP) {
      const cards = recapCards(events);
      if (cards.length) seq.push({ name: 'recap', p: { cards } });
    }
    if (!died) {
      // One animation for all the growing that happened: from the shape the player last saw
      // to the one it has now (the stages in between are a recap card). Until it plays,
      // every scene, the recap included, keeps drawing the old shape (shownSpecies).
      let first = null, last = null;
      for (const e of events) if (e.type === 'evolve') { first = first || e; last = e; }
      if (last) seq.push({ name: 'evolving', p: { from: first.from, to: last.to } });
      if (has('mature')) seq.push({ name: 'mature' });
    } else {
      seq.push({ name: 'dying' });
    }
    // Something may still be waiting from an earlier return (it was held under a sheet): a
    // recap that never played is replaced by the newer one, and the order stays the same as
    // above (the sort is stable, so two growths keep theirs).
    if (seq.some((q) => q.name === 'recap')) pending = pending.filter((q) => q.name !== 'recap');
    pending = pending.concat(seq).sort((a, b) => AWAY_ORDER.indexOf(a.name) - AWAY_ORDER.indexOf(b.name));
    // Whatever was half-done before the absence is stale now: the selected icon, a short
    // caption, a hop or a reaction in progress.
    sel = -1;
    note = null;
    pet.hop = 0;
    pet.react = null;
    // Replayed from inside one of our own actions (the catch-up ran first, as it must): that
    // handler is about to choose the next scene itself, and settle() plays the queue after it.
    if (acting) return;
    // An absence always lands on the home scene, whatever was open before.
    if (pending.length || !isBase() || baseName() !== cur.name) home(); else render();
  }

  function onEvents(events, opts) {
    v = host.view();
    if (!Array.isArray(events) || !events.length) {
      if (opts && opts.away && !isBase()) home();
      return;
    }
    if (opts && opts.away) { onAway(events, opts.gapMin || 0); return; }
    const quiet = acting > 0 || cur.name !== 'idle';       // small reactions only on the home scene
    for (const e of events) {
      if (e.type === 'hatch') pending.push({ name: 'hatching' });
      else if (e.type === 'evolve') pending.push({ name: 'evolving', p: { from: e.from, to: e.to } });
      else if (e.type === 'mature') pending.push({ name: 'mature' });
      else if (e.type === 'death') pending.push({ name: 'dying' });
      else if (quiet) continue;
      else if (e.type === 'poop') { host.sound('miss'); pet.react = { frame: 'upset', ticks: 4, text: '앗, 응가했어요!' }; }
      else if (e.type === 'sick') { host.sound('sad'); pet.react = { frame: 'upset', mark: ITEMS.skull, ticks: 6, text: '으으… 아파요' }; }
      else if (e.type === 'sleep') { host.sound('sleep'); say('쿨쿨… 잘 자요', 8); }
      else if (e.type === 'wake') { host.sound('wake'); pet.react = { frame: 'happy', ticks: 6, text: '좋은 아침이에요!' }; }
      else if (e.type === 'callStart') beep();
    }
    settle();
    if (!acting) render();          // the reaction shows now, not a tick later
  }

  // ---- public API --------------------------------------------------------------------------------------

  function startTimer() {
    if (timer || host.frozen) return;
    timer = setInterval(tick, TICK_MS);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = 0; }
  }

  return {
    get name() { return cur.name; },
    get selected() { return sel; },
    // True when a page reload would cost the player nothing: the home scene, nothing queued,
    // no action in flight and no icon selected (js/main.js asks before applying an update).
    get quiet() { return isBase() && pending.length === 0 && acting === 0 && sel < 0; },

    start() {
      v = host.view();
      pet.x = clamp(16, 0, maxPetX());
      home();
      render(true);
      startTimer();
    },

    pause() { stopTimer(); releaseWake(); },
    resume() { startTimer(); if (game && !sheetOpen()) requestWake(); render(); },

    key(k, held) {
      if (k !== 'A' && k !== 'B' && k !== 'C') return;
      host.sound('key');
      v = host.view();
      const def = SCENES[cur.name];
      if (def.key) def.key(k, held); else skip(k);
      settle();
      render();
    },

    // C is a game key in both mini-games, so leaving a game is a long press of C.
    longPress(k) {
      if (k !== 'C' || cur.name !== 'game' || !game) return;
      game.quit();
      finishGame();
    },

    tap(hit) {
      if (!hit) return;
      v = host.view();
      const def = SCENES[cur.name];
      if (def.tap) def.tap(hit); else skip('B');
      settle();
      render();
    },

    onEvents,

    // Something outside changed the game or the prefs (a sheet, a setting).
    refresh() {
      v = host.view();
      settle();
      render();
    },

    // A different game was loaded, or the game was started over.
    reset() {
      pending = [];
      note = null;
      sel = -1;
      pet.x = 16; pet.face = 1; pet.mode = 'stand'; pet.wait = 6; pet.hop = 0; pet.react = null;
      v = host.view();
      cur = { name: baseName(), t: 0, p: {} };
      home();
      render(true);
    },

    // Debug hooks (js/debug.js): put the screen in a known scene and step it by hand.
    go(name, p) { if (SCENES[name]) { v = host.view(); go(name, p); } },
    step(n = 1) { for (let i = 0; i < n; i++) tick(); },
    select(i) { sel = clamp(i | 0, -1, MENU_IDS.length - 1); selAge = 0; render(); },
    menu(id) {
      const m = id === 'food' ? foodMenu() : id === 'play' ? playMenu() : id === 'light' ? lightMenu() : departMenu();
      v = host.view();
      go('choice', m);
    },
    placePet(x, face) { pet.x = clamp(x | 0, 0, maxPetX()); if (face) pet.face = face < 0 ? -1 : 1; render(); },
  };
}
