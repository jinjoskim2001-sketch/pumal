// Test hooks (SPEC 11.7). Loaded by main.js only when the URL has ?play=1.
//
// ?shot=<name> builds a fixed state at a fixed time of day and stops live time, so
// tools/shot.sh always captures the same picture. A shot never reads or writes the save.
// Optional: &species=<id>, &skin=<id>, and for convenience &tint=<id>, &page=<n> (status
// page), &tick=<n> (extra 250 ms scene steps after the shot is set up).
// ?gate=install|escape forces a gate screen.
// window.__pumal = { app, skip(minutes), setSpecies(id), give(patch) } is for manual testing.
// &keys=<script> (with a ?shot=, or on a local dev host only: it must never run on a real
// save) replays input through the real DOM listeners, so a headless screenshot can
// show a whole flow: A B C = taps on the device keys, a s d = the keyboard, x = Escape,
// p = a tap on the creature, 0-7 = a tap on that menu icon, '.' = wait 250 ms, ',' = wait 1 s.
// Example: ?play=1&keys=BBBBB,,,,,,xAB.B  (hatch, skip the name sheet, feed; the sheet opens
// 5.5 s after the hatch: 4.5 s of animation and one quiet second).
// &snap=1 turns the LCD ghosting off: under a headless virtual-time budget the animation
// frames that settle it never run, and a live screenshot would show a smear.
//
// States are built by writing pet fields directly. The engine range-checks the whole state
// on its next advance/act, which is why a hook can afford to be this blunt.

import { SPECIES } from './data.js';

const SHOTS = [
  'egg', 'baby', 'idle', 'hungry', 'menu', 'food', 'eating', 'poop', 'sick', 'sleep', 'status',
  'clock', 'rps', 'catch', 'evolve', 'depart', 'memorial', 'paused',
  'dex', 'album', 'settings', 'name', 'postcard',
];
const SKINS = ['milk', 'grape', 'graphite', 'ice', 'lagoon', 'sakura'];
const TINTS = ['pea', 'warm', 'amber'];
const DAY_MS = 86400000;

const AGE_BY_STAGE = { baby: 0, child: 1, teen: 3, adult: 6, special: 9 };
// What a creature grew from, for the evolve shot.
const GREW_FROM = {
  tongtong: 'mongsil', mallang: 'mongsil',
  saessak: 'tongtong', kkabul: 'tongtong', ppittak: 'mallang',
  banjjak: 'saessak', narae: 'saessak', podong: 'kkabul', dokkae: 'kkabul', gureum: 'ppittak', dwinggul: 'ppittak',
  byeolbit: 'narae', haessal: 'dwinggul',
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function readShot(params) {
  const name = params.get('shot');
  if (!name || !SHOTS.includes(name)) return null;
  const species = params.get('species');
  const skin = params.get('skin');
  const tint = params.get('tint');
  const int = (key) => {
    const n = parseInt(params.get(key), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    name,
    species: species && has(SPECIES, species) ? species : null,
    skin: SKINS.includes(skin) ? skin : null,
    tint: TINTS.includes(tint) ? tint : null,
    page: int('page'),
    tick: int('tick'),
  };
}

export function readGate(params) {
  const g = params.get('gate');
  return g === 'install' || g === 'escape' ? g : null;
}

function albumEntries(now) {
  return [
    { name: '보리', species: 'podong', gen: 1, ageDays: 9, bornAt: now - 40 * DAY_MS, endedAt: now - 30 * DAY_MS, end: 'journey', mode: 'gentle', careGrade: 'B' },
    { name: '두부', species: 'gureum', gen: 1, ageDays: 6, bornAt: now - 28 * DAY_MS, endedAt: now - 21 * DAY_MS, end: 'star', cause: 'neglect', mode: 'classic', careGrade: 'C', leftEgg: false },
    { name: '솜이', species: 'banjjak', gen: 2, ageDays: 12, bornAt: now - 20 * DAY_MS, endedAt: now - 7 * DAY_MS, end: 'journey', mode: 'gentle', careGrade: 'A' },
  ];
}

// → { state, now, prefs, rng }
export function shotState(shot, engine) {
  const night = shot.name === 'sleep';
  const d = new Date();
  d.setHours(night ? 23 : 14, night ? 40 : 5, 0, 0);
  const now = d.getTime();
  const born = now - 3 * DAY_MS;
  const state = engine.newGame(born, { tzOffsetMin: -d.getTimezoneOffset() });
  state.lastTick = now;
  const pet = state.pet;

  const grow = (id) => {
    const sp = SPECIES[id];
    Object.assign(pet, {
      species: id, stage: sp.stage, name: '콩이', bornAt: born,
      hunger: 4, happy: 4, weight: sp.baseWeight + 2, ageDays: AGE_BY_STAGE[sp.stage],
      discipline: 2, bond: 30, stageAwakeMin: 30, totalAwakeMin: 600,
      hungerTimer: sp.hungerEvery, happyTimer: sp.happyEvery, poopTimer: sp.poopEvery || 0,
      lastWakeAt: now - 6 * 3600000, eggTaps: 5,
    });
    state.dex[id] = born;
  };

  const pick = (fallback) => shot.species || fallback;
  const prefs = { seenGuide: true };
  if (shot.skin) prefs.skin = shot.skin;
  if (shot.tint) prefs.tint = shot.tint;

  switch (shot.name) {
    case 'egg':
      break;
    case 'baby':
    case 'name':
      grow('mongsil');
      Object.assign(pet, { name: '몽실이', hunger: 1, happy: 1, weight: 5, stageAwakeMin: 2 });
      prefs.seenGuide = false;
      break;
    case 'hungry':
      grow(pick('tongtong'));
      Object.assign(pet, { hunger: 0, happy: 2 });
      pet.calls.hunger = 120;
      break;
    case 'eating':
      grow(pick('tongtong'));
      Object.assign(pet, { hunger: 2, happy: 3 });
      break;
    case 'poop':
      grow(pick('tongtong'));
      pet.poop = [100, 60, 20];
      break;
    case 'sick':
      grow(pick('tongtong'));
      Object.assign(pet, { happy: 2, poop: [200], sick: { cause: 'dirty', doses: 2, awakeMin: 30, mistakes: 0 }, sickCount: 1 });
      break;
    case 'sleep':
      grow(pick('tongtong'));
      Object.assign(pet, { asleep: true, lightsOn: false });
      break;
    case 'evolve':
      grow(pick('saessak'));
      state.dex[GREW_FROM[pet.species] || 'mongsil'] = born;
      break;
    case 'depart':
      grow(shot.species && SPECIES[shot.species].stage !== 'adult' && SPECIES[shot.species].stage !== 'special' ? 'narae' : pick('narae'));
      Object.assign(pet, { stageAwakeMin: 3000, adultAwakeMin: 3000, departReady: true, matureAnnounced: true, specialChecked: true });
      break;
    case 'memorial':
      grow(pick('banjjak'));
      state.rulesMode = 'classic';
      Object.assign(pet, { alive: false, endCause: 'oldage', leftEgg: true, ageDays: 14 });
      state.album = albumEntries(now);
      state.album.push({ name: pet.name, species: pet.species, gen: 1, ageDays: 14, bornAt: born, endedAt: now, end: 'star', cause: 'oldage', mode: 'classic', careGrade: 'A', leftEgg: true });
      break;
    case 'paused':
      grow(pick('tongtong'));
      state.paused = true;
      break;
    case 'dex':
    case 'album':
    case 'postcard':
    case 'settings':
      grow(pick('saessak'));
      for (const id of ['mongsil', 'tongtong', 'podong', 'gureum', 'banjjak', 'kkabul']) state.dex[id] = now - 20 * DAY_MS;
      state.album = albumEntries(now);
      break;
    default:
      grow(pick('tongtong'));
  }

  engine.advance(state, now, { live: true });     // no time passes; this is the range check
  return { state, now, prefs, rng: seeded(20261001) };
}

// Runs after the scenes have started and the sheets module has loaded.
export function applyShot(shot, { app, scenes, ui }) {
  switch (shot.name) {
    case 'menu':
      scenes.select(1);
      break;
    case 'food':
      scenes.menu('food');
      break;
    case 'eating':
      scenes.select(0);
      scenes.menu('food');
      scenes.key('B');            // the real meal, then stop on the second bite
      scenes.step(4);
      break;
    case 'status':
      scenes.select(6);
      scenes.go('status', { page: shot.page || 0 });
      break;
    case 'clock':
      scenes.go('clock');
      break;
    case 'rps':
      scenes.go('game', { kind: 'rps' });
      scenes.key('B');
      scenes.step(4);
      break;
    case 'catch':
      scenes.go('game', { kind: 'catch' });
      scenes.step(7);
      break;
    case 'evolve': {
      const to = app.view().species;
      scenes.go('evolving', { from: GREW_FROM[to] || 'mongsil', to });
      scenes.step(16);
      break;
    }
    case 'depart':
      scenes.menu('depart');      // opens on "stay"
      scenes.key('A');
      scenes.key('B');            // the real departure: album entry, new egg, farewell scene
      scenes.step(9);
      break;
    case 'dex':
      ui.open('dex');
      break;
    case 'album':
      ui.open('dex', { tab: 'album' });
      break;
    case 'settings':
      ui.open('settings');
      break;
    case 'name':
      ui.open('name', { first: true });
      break;
    case 'postcard': {
      const album = app.state.album;
      ui.open('postcard', { entry: album[album.length - 1] });
      break;
    }
    default:
      break;
  }
  if (shot.tick) scenes.step(shot.tick);
}

// Replays a key script (see the header). Frozen shots have no timers, so there a wait steps
// the scene clock by hand.
export function playKeys(script, { scenes, frozen }) {
  const steps = Array.from(String(script || ''));
  const CODES = { a: 'KeyA', s: 'KeyS', d: 'KeyD' };
  let pointerId = 100;

  const tapEl = (el, x, y) => {
    const init = { bubbles: true, cancelable: true, pointerId: ++pointerId, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', init));
  };
  const typeKey = (init) => {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }));
  };

  const next = () => {
    while (steps.length) {
      const ch = steps.shift();
      if (ch === '.' || ch === ',') {
        const ticks = ch === ',' ? 4 : 1;
        if (frozen) { scenes.step(ticks); continue; }
        setTimeout(next, ticks * 250);
        return;
      }
      if (ch === 'A' || ch === 'B' || ch === 'C') {
        const el = document.getElementById(`key${ch}`);
        const r = el.getBoundingClientRect();
        tapEl(el, r.left + r.width / 2, r.top + r.height / 2);
      } else if (CODES[ch]) {
        typeKey({ code: CODES[ch], key: ch });
      } else if (ch === 'x') {
        typeKey({ code: 'Escape', key: 'Escape' });
      } else if (ch >= '0' && ch <= '7') {
        // icon strips: four 12-dot cells above and below the 32-row matrix, inside a 50x50 canvas
        const k = Number(ch);
        const r = document.getElementById('lcd').getBoundingClientRect();
        tapEl(document.getElementById('bezel'), r.left + (r.width * (7 + (k % 4) * 12)) / 50, r.top + (r.height * (k < 4 ? 5 : 45)) / 50);
      } else if (ch === 'p') {
        const r = document.getElementById('lcd').getBoundingClientRect();
        tapEl(document.getElementById('bezel'), r.left + r.width / 2, r.top + r.height * 0.62);
      }
    }
  };
  next();
}

export function install({ app, clock, sync }) {
  // Re-checks a hand-edited state, saves it and redraws: a no-op action is enough for that.
  const settle = () => {
    app.act('setTz', { tzOffsetMin: app.state.settings.tzOffsetMin });
    return app.view();
  };

  window.__pumal = {
    app,

    // Moves the game clock forward. Two minutes or more is replayed as an absence (with the
    // recap); less is live time.
    skip(minutes = 1) {
      const ms = Math.round(Number(minutes) * 60000) || 0;
      if (clock.fixed !== null) clock.fixed += ms; else clock.offset += ms;
      sync();
      return app.view();
    },

    setSpecies(id) {
      if (!has(SPECIES, id)) return null;
      const pet = app.state.pet;
      pet.species = id;
      pet.stage = SPECIES[id].stage;
      pet.alive = true;
      pet.stageAwakeMin = 0;
      if (!has(app.state.dex, id)) app.state.dex[id] = clock.now();
      return settle();
    },

    give(patch) {
      if (patch && typeof patch === 'object') Object.assign(app.state.pet, patch);
      return settle();
    },
  };
}
