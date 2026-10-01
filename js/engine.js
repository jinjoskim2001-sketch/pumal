// Pure simulation for 품알 (SPEC section 5).
//
// Constraints that shape this file:
// - No DOM, no Date.now(), no Math.random() calls of our own: time and rng are parameters,
//   so the same state + inputs always produce the same result (tests rely on it).
// - iOS suspends JS seconds after the app is hidden, so nothing counts ticks. The state
//   carries `lastTick` and `advance` replays whole minutes up to `now`.
// - The save file is user data that may be old, hand-edited or half-written. Every entry
//   point sanitises the state first and `advance` never throws: a corrupt number must cost
//   at most a default value, never the pet.
// - Only `advance` and `act` mutate. `view` is read-only.

import {
  SPECIES, DEFAULT_NAME, NAME_MAX,
  EGG_HATCH_MIN, EGG_TAPS, HATCH_HUNGER, HATCH_HAPPY, BABY_POOP_AT,
  SPECIAL_CHECK_MIN, MATURE_MIN, SPECIAL_MATURE_MIN,
  AWAY_CAP_MIN, MAX_CATCHUP_MIN, MIN_AWAKE_MIN,
  GRACE, REPEAT_ZERO_MIN, LIGHTS_GRACE_REAL_MIN, TANTRUM_GRACE_REAL_MIN, TANTRUM_COOLDOWN_MIN, TANTRUM_CHANCE,
  METER_MAX, DISCIPLINE_MAX, WEIGHT_MAX, MEAL_WEIGHT, SNACK_WEIGHT, GAME_WEIGHT,
  BOND_PER_PET, BOND_PER_WIN, BOND_PER_LOSS, BOND_PER_STAR, PET_CAP, PET_WINDOW_REAL_MIN,
  POOP_MAX, DIRTY_SICK_MIN, SWEETS_COUNT, SWEETS_WINDOW_MIN,
  SICK_MISTAKE_EVERY_MIN, SICK_MISTAKE_MAX, SICK_DEATH_MIN, STARVE_MIN, NEGLECT_MISTAKES,
  OLD_AGE_START, OLD_AGE_SECOND, OLD_AGE_DECAY_MUL, OLD_AGE_DECAY_FLOOR_MIN,
} from './data.js';

export const VERSION = 1;

const MIN_MS = 60000;
const DAY_MIN = 1440;
// Largest timestamp a Date can hold. Above ~9e15 adding one minute to a double is no longer
// exact, so refusing anything beyond this also guarantees the step loop makes progress.
const MAX_TIME_MS = 8.64e15;
// A birthday needs half a day since the last one, so changing the schedule or the time zone
// back and forth cannot age the pet (natural wake-ups are a full day apart).
const BIRTHDAY_GAP_MS = 12 * 60 * MIN_MS;
const ALBUM_MAX = 300;
const COUNTER_MAX = 9999999;

const DEX_MAX = 64;   // room for ids a newer build may know, not for a junk import
// Everything a save holds at the top level. Anything else came from a hand-edited or imported
// file and is dropped, so it cannot ride along in every save from then on.
const STATE_KEYS = ['v', 'rulesMode', 'settings', 'createdAt', 'lastTick', 'hiTick', 'paused', 'pet', 'album', 'dex'];

const CALL_KEYS = ['hunger', 'happy', 'lights', 'tantrum'];
const DEATH_CAUSES = ['oldage', 'neglect', 'starve', 'sick'];
const SICK_CAUSES = ['dirty', 'sweets', 'age'];
const STAGE_FALLBACK = { baby: 'mongsil', child: 'tongtong', teen: 'kkabul', adult: 'dokkae', special: 'byeolbit' };
// The egg is a stage, not one of the 14 creatures; these numbers only keep its timers sane.
const EGG_SPECIES = Object.freeze({
  id: 'egg', stage: 'egg', hungerEvery: 4, happyEvery: 5, baseWeight: 5, doses: 2,
  poopEvery: null, stageMin: EGG_HATCH_MIN, lifespanMin: null,
});

// ---- small helpers ------------------------------------------------------------------

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isTime = (x) => isNum(x) && Math.abs(x) <= MAX_TIME_MS;

function int(x, lo, hi, fallback) {
  if (!isNum(x)) return fallback;
  const r = Math.round(x);
  return r < lo ? lo : r > hi ? hi : r;
}

function numberList(x, max, lo, hi) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (let i = 0; i < x.length; i++) {
    if (isNum(x[i])) out.push(x[i] < lo ? lo : x[i] > hi ? hi : x[i]);
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

function speciesOf(pet) {
  return hasOwn(SPECIES, pet.species) ? SPECIES[pet.species] : EGG_SPECIES;
}

const isGrown = (pet) => pet.stage === 'adult' || pet.stage === 'special';
const followsSchedule = (pet) => pet.stage !== 'egg' && pet.stage !== 'baby';

function decayInterval(base, mul) {
  if (!(mul < 1)) return base;
  return Math.min(base, Math.max(OLD_AGE_DECAY_FLOOR_MIN, Math.round(base * mul)));
}

function localMinute(t, tzOffsetMin) {
  return (((t / MIN_MS) + tzOffsetMin) % DAY_MIN + DAY_MIN) % DAY_MIN;
}

function scheduledAwake(settings, t) {
  const m = localMinute(t, settings.tzOffsetMin);
  const w = settings.wakeMin;
  const b = settings.bedMin;
  if (w === b) return true;
  return w < b ? (m >= w && m < b) : (m >= w || m < b);   // bed after midnight wraps
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  // NFC first: a decomposed Hangul syllable would otherwise count as three characters.
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

function careGrade(pet) {
  if (pet.adultMistakes === 0 && pet.careMistakes <= 2) return 'A';
  if (pet.adultMistakes <= 3 && pet.careMistakes <= 5) return 'B';
  return 'C';
}

// ---- construction ---------------------------------------------------------------------

function newEgg(now, gen) {
  return {
    name: DEFAULT_NAME, gen, stage: 'egg', species: 'egg', bornAt: now,
    alive: true, endCause: null, leftEgg: false,
    stageAwakeMin: 0, totalAwakeMin: 0, adultAwakeMin: 0, ageDays: 0,
    hunger: METER_MAX, happy: METER_MAX,
    hungerTimer: EGG_SPECIES.hungerEvery, happyTimer: EGG_SPECIES.happyEvery,
    hungerMul: 1, happyMul: 1,
    discipline: 0, weight: EGG_SPECIES.baseWeight, bond: 0, petLog: [],
    careMistakes: 0, adultMistakes: 0, missedScolds: 0,
    babyPlays: 0, babySnacks: 0, eggTaps: 0,
    poop: [], poopTimer: 0, snackLog: [], sick: null, sickCount: 0, oldAgeSick: 0,
    asleep: false, lightsOn: true, lastWakeAt: 0,
    calls: { hunger: null, happy: null, lights: null, tantrum: null },
    tantrumCooldown: 0, zeroHungerMin: 0, zeroRepeat: { hunger: 0, happy: 0 },
    specialChecked: false, departReady: false, matureAnnounced: false,
  };
}

export function newGame(now, opts) {
  const o = isObj(opts) ? opts : {};
  const t = isTime(now) ? now : 0;
  let wakeMin = int(o.wakeMin, 0, DAY_MIN - 1, 480);
  let bedMin = int(o.bedMin, 0, DAY_MIN - 1, 1380);
  if (wakeMin === bedMin) { wakeMin = 480; bedMin = 1380; }
  return {
    v: VERSION,
    rulesMode: o.rulesMode === 'classic' ? 'classic' : 'gentle',
    settings: { wakeMin, bedMin, tzOffsetMin: int(o.tzOffsetMin, -840, 840, 540) },
    createdAt: t,
    lastTick: t,
    hiTick: null,
    paused: false,
    pet: newEgg(t, 1),
    album: [],
    dex: {},
  };
}

// ---- sanitising -------------------------------------------------------------------------
// Runs once per advance/act (never per step). Idempotent on a healthy state.

function callValue(v, max, keepExpired) {
  if (!isNum(v)) return null;
  const r = Math.round(v);
  if (r <= 0) return keepExpired ? 0 : null;
  return r > max ? max : r;
}

function sanitizePet(state, p, now) {
  if (typeof p.species === 'string' && hasOwn(SPECIES, p.species)) {
    p.stage = SPECIES[p.species].stage;
  } else if (typeof p.stage === 'string' && hasOwn(STAGE_FALLBACK, p.stage)) {
    p.species = STAGE_FALLBACK[p.stage];
  } else {
    p.stage = 'egg';
    p.species = 'egg';
  }
  const sp = speciesOf(p);
  const classic = state.rulesMode === 'classic';

  const name = cleanName(p.name);
  p.name = name || DEFAULT_NAME;
  p.gen = int(p.gen, 1, 9999, 1);
  if (!isTime(p.bornAt)) p.bornAt = now;
  p.alive = p.alive !== false;
  p.endCause = p.alive ? null : (DEATH_CAUSES.includes(p.endCause) ? p.endCause : 'neglect');
  p.leftEgg = !p.alive && p.leftEgg === true;

  p.stageAwakeMin = int(p.stageAwakeMin, 0, COUNTER_MAX, 0);
  p.totalAwakeMin = int(p.totalAwakeMin, 0, COUNTER_MAX, 0);
  // Adult life is counted from becoming an adult and keeps running through the special stage.
  p.adultAwakeMin = isGrown(p) ? Math.max(p.stageAwakeMin, int(p.adultAwakeMin, 0, COUNTER_MAX, 0)) : 0;
  p.ageDays = int(p.ageDays, 0, 99999, 0);

  p.hunger = int(p.hunger, 0, METER_MAX, METER_MAX);
  p.happy = int(p.happy, 0, METER_MAX, METER_MAX);
  p.hungerMul = isNum(p.hungerMul) && p.hungerMul > 0 && p.hungerMul <= 1 ? Math.max(0.01, p.hungerMul) : 1;
  p.happyMul = isNum(p.happyMul) && p.happyMul > 0 && p.happyMul <= 1 ? Math.max(0.01, p.happyMul) : 1;
  const hungerEvery = decayInterval(sp.hungerEvery, p.hungerMul);
  const happyEvery = decayInterval(sp.happyEvery, p.happyMul);
  p.hungerTimer = int(p.hungerTimer, 1, hungerEvery, hungerEvery);
  p.happyTimer = int(p.happyTimer, 1, happyEvery, happyEvery);

  p.discipline = int(p.discipline, 0, DISCIPLINE_MAX, 0);
  p.weight = int(p.weight, sp.baseWeight, WEIGHT_MAX, sp.baseWeight);
  p.bond = int(p.bond, 0, COUNTER_MAX, 0);
  p.petLog = numberList(p.petLog, PET_CAP * 2, -MAX_TIME_MS, MAX_TIME_MS);
  p.careMistakes = int(p.careMistakes, 0, 9999, 0);
  p.adultMistakes = int(p.adultMistakes, 0, 9999, 0);
  p.missedScolds = int(p.missedScolds, 0, 9999, 0);
  p.babyPlays = int(p.babyPlays, 0, 9999, 0);
  p.babySnacks = int(p.babySnacks, 0, 9999, 0);
  p.eggTaps = int(p.eggTaps, 0, EGG_TAPS, 0);

  p.poop = numberList(p.poop, POOP_MAX, 0, COUNTER_MAX);
  p.poopTimer = sp.poopEvery ? int(p.poopTimer, 1, sp.poopEvery, sp.poopEvery) : 0;
  p.snackLog = numberList(p.snackLog, SWEETS_COUNT * 2, 0, COUNTER_MAX);
  if (isObj(p.sick) && p.stage !== 'egg') {
    const s = p.sick;
    if (!SICK_CAUSES.includes(s.cause)) s.cause = 'dirty';
    s.doses = int(s.doses, 1, 9, sp.doses);
    s.awakeMin = int(s.awakeMin, 0, COUNTER_MAX, 0);
    s.mistakes = int(s.mistakes, 0, SICK_MISTAKE_MAX, 0);
  } else {
    p.sick = null;
  }
  p.sickCount = int(p.sickCount, 0, 9999, 0);
  p.oldAgeSick = int(p.oldAgeSick, 0, 2, 0);

  p.asleep = followsSchedule(p) && p.alive && p.asleep === true;
  p.lightsOn = p.lightsOn !== false;
  if (!isTime(p.lastWakeAt)) p.lastWakeAt = 0;

  if (!isObj(p.calls)) p.calls = {};
  const c = p.calls;
  const grace = GRACE[state.rulesMode];
  // A meter call only exists while its meter is empty.
  c.hunger = p.alive && p.hunger === 0 ? callValue(c.hunger, grace, true) : null;
  c.happy = p.alive && p.happy === 0 ? callValue(c.happy, grace, true) : null;
  c.lights = p.asleep && p.lightsOn ? callValue(c.lights, LIGHTS_GRACE_REAL_MIN, false) : null;
  c.tantrum = p.alive && followsSchedule(p) ? callValue(c.tantrum, TANTRUM_GRACE_REAL_MIN, false) : null;

  p.tantrumCooldown = int(p.tantrumCooldown, 0, TANTRUM_COOLDOWN_MIN, 0);
  p.zeroHungerMin = int(p.zeroHungerMin, 0, COUNTER_MAX, 0);
  // The repeat counter only exists behind an expired call, and only gentle counts it -
  // never for the baby, whose stage costs nothing.
  if (!isObj(p.zeroRepeat)) p.zeroRepeat = { hunger: 0, happy: 0 };
  const z = p.zeroRepeat;
  const repeats = !classic && followsSchedule(p);
  z.hunger = repeats && c.hunger === 0 ? int(z.hunger, 0, REPEAT_ZERO_MIN - 1, 0) : 0;
  z.happy = repeats && c.happy === 0 ? int(z.happy, 0, REPEAT_ZERO_MIN - 1, 0) : 0;
  p.specialChecked = p.specialChecked === true;
  p.departReady = !classic && p.alive && isGrown(p) && p.departReady === true;
  p.matureAnnounced = p.matureAnnounced === true;
}

// Album entries are keepsakes written by albumEntry, but an imported file can hold anything.
// Repaired in place; fields this build does not know are left alone (a newer one may have
// written them), and an unknown species stays - the album shows it as '???'.
function albumSpecies(x) {
  if (typeof x !== 'string') return '';
  if (hasOwn(SPECIES, x)) return x;
  // Nothing that would resolve on Object.prototype when someone looks it up in a table.
  return x.length <= 24 && !(x in Object.prototype) ? x : '';
}

function sanitizeAlbumEntry(e) {
  e.name = cleanName(e.name) || DEFAULT_NAME;
  e.species = albumSpecies(e.species);
  e.gen = int(e.gen, 1, 9999, 1);
  e.ageDays = int(e.ageDays, 0, 99999, 0);
  if (!isTime(e.bornAt)) e.bornAt = null;
  if (!isTime(e.endedAt)) e.endedAt = null;
  e.end = e.end === 'star' ? 'star' : 'journey';
  if (hasOwn(e, 'cause') && !DEATH_CAUSES.includes(e.cause)) delete e.cause;
  e.mode = e.mode === 'classic' ? 'classic' : 'gentle';
  if (e.careGrade !== 'A' && e.careGrade !== 'B') e.careGrade = 'C';
  if (hasOwn(e, 'leftEgg')) e.leftEgg = e.leftEgg === true;
}

function sanitizeAlbum(state) {
  let album = state.album;
  if (!Array.isArray(album)) {
    state.album = [];
    return;
  }
  let sound = album.length <= ALBUM_MAX;
  for (let i = 0; sound && i < album.length; i++) sound = isObj(album[i]);
  if (!sound) {
    // Keep the newest ALBUM_MAX entries that are entries at all. Only a damaged album is
    // rebuilt, so the once-a-second pass over a healthy one allocates nothing.
    const kept = [];
    for (let i = album.length - 1; i >= 0 && kept.length < ALBUM_MAX; i--) {
      if (isObj(album[i])) kept.push(album[i]);
    }
    album = state.album = kept.reverse();
  }
  for (let i = 0; i < album.length; i++) sanitizeAlbumEntry(album[i]);
}

function sanitizeDex(state) {
  if (!isObj(state.dex)) {
    state.dex = {};
    return;
  }
  const dex = state.dex;
  let size = 0;
  for (const id in dex) {
    if (!hasOwn(dex, id)) continue;
    if (isTime(dex[id])) size++;
    else delete dex[id];   // a 도감 stamp is a first-seen time and nothing else
  }
  if (size <= DEX_MAX) return;
  for (const id in dex) {
    if (hasOwn(dex, id) && !hasOwn(SPECIES, id)) delete dex[id];
  }
}

function sanitize(state, now) {
  for (const key in state) {
    if (hasOwn(state, key) && !STATE_KEYS.includes(key)) delete state[key];
  }
  state.v = VERSION;
  if (state.rulesMode !== 'classic') state.rulesMode = 'gentle';
  if (!isObj(state.settings)) state.settings = {};
  const s = state.settings;
  s.wakeMin = int(s.wakeMin, 0, DAY_MIN - 1, 480);
  s.bedMin = int(s.bedMin, 0, DAY_MIN - 1, 1380);
  if (s.wakeMin === s.bedMin) { s.wakeMin = 480; s.bedMin = 1380; }
  s.tzOffsetMin = int(s.tzOffsetMin, -840, 840, 540);
  if (!isTime(state.createdAt)) state.createdAt = now;
  if (!isTime(state.lastTick)) state.lastTick = now;
  // Where lastTick stood when the clock last moved back (see advance); null when it never did.
  if (!isTime(state.hiTick)) state.hiTick = null;
  state.paused = state.paused === true;
  sanitizeAlbum(state);
  sanitizeDex(state);
  if (!isObj(state.pet)) state.pet = newEgg(now, 1);
  sanitizePet(state, state.pet, now);
}

// ---- rule pieces shared by step and act ---------------------------------------------------

function stampDex(state, id, t) {
  if (!hasOwn(state.dex, id) || !isNum(state.dex[id])) state.dex[id] = t;
}

function careMistake(state, ev) {
  const pet = state.pet;
  if (pet.stage === 'child' || pet.stage === 'teen') pet.careMistakes++;
  else if (isGrown(pet)) pet.adultMistakes++;
  else return;   // nothing in the baby stage has consequences
  ev.push({ type: 'careMistake' });
}

function startMeterCall(state, meter, ev) {
  state.pet.calls[meter] = GRACE[state.rulesMode];
  ev.push({ type: 'callStart', reason: meter });
}

function dropMeter(state, meter, ev) {
  const pet = state.pet;
  if (pet[meter] <= 0) return;
  pet[meter]--;
  ev.push({ type: 'heartLoss', meter });
  if (pet[meter] === 0 && pet.calls[meter] === null) startMeterCall(state, meter, ev);
}

function raiseMeter(pet, meter) {
  if (pet[meter] < METER_MAX) pet[meter]++;
  pet.calls[meter] = null;   // above zero again: the call ends and a new one may start later
  pet.zeroRepeat[meter] = 0;
  if (meter === 'hunger') pet.zeroHungerMin = 0;
}

function makeSick(state, cause, ev) {
  const pet = state.pet;
  pet.sick = { cause, doses: speciesOf(pet).doses, awakeMin: 0, mistakes: 0 };
  pet.sickCount++;
  ev.push({ type: 'sick', cause });
}

function addPoop(pet, ev) {
  if (pet.poop.length >= POOP_MAX) return;
  pet.poop.push(0);
  ev.push({ type: 'poop' });
}

function albumEntry(state, end, t, cause) {
  const pet = state.pet;
  const entry = {
    name: pet.name, species: pet.species, gen: pet.gen, ageDays: pet.ageDays,
    bornAt: pet.bornAt, endedAt: t, end,
  };
  if (cause) entry.cause = cause;
  entry.mode = state.rulesMode;
  entry.careGrade = careGrade(pet);
  if (end === 'star') entry.leftEgg = pet.leftEgg;
  state.album.push(entry);
  if (state.album.length > ALBUM_MAX) state.album.splice(0, state.album.length - ALBUM_MAX);
  return entry;
}

function die(state, cause, t, ev) {
  const pet = state.pet;
  pet.alive = false;
  pet.endCause = cause;
  pet.leftEgg = cause === 'oldage' && pet.adultMistakes <= 2;
  pet.asleep = false;
  pet.departReady = false;
  pet.calls.hunger = pet.calls.happy = pet.calls.lights = pet.calls.tantrum = null;
  albumEntry(state, 'star', t, cause);
  ev.push({ type: 'death', cause });
}

function hatch(state, t, ev) {
  const pet = state.pet;
  const sp = SPECIES.mongsil;
  pet.stage = sp.stage;
  pet.species = sp.id;
  pet.bornAt = t;
  pet.stageAwakeMin = 0;
  pet.hunger = HATCH_HUNGER;
  pet.happy = HATCH_HAPPY;
  pet.hungerTimer = sp.hungerEvery;
  pet.happyTimer = sp.happyEvery;
  pet.weight = sp.baseWeight;
  pet.asleep = false;
  pet.lightsOn = true;
  stampDex(state, sp.id, t);
  ev.push({ type: 'hatch' });
}

function nextSpecies(pet) {
  const m = pet.careMistakes;
  const d = pet.discipline;
  if (pet.stage === 'baby') return pet.babyPlays >= pet.babySnacks ? 'tongtong' : 'mallang';
  if (pet.stage === 'child') {
    if (m > 1) return 'ppittak';
    return d >= 2 ? 'saessak' : 'kkabul';
  }
  if (m <= 2) return d >= 3 ? 'banjjak' : 'narae';
  if (m <= 5) return pet.weight >= 30 ? 'podong' : 'dokkae';
  return d >= 2 ? 'gureum' : 'dwinggul';
}

function specialFor(pet) {
  if (pet.adultMistakes !== 0) return null;
  if (pet.species === 'narae' && pet.bond >= 60) return 'byeolbit';
  if (pet.species === 'dwinggul' && pet.discipline === DISCIPLINE_MAX) return 'haessal';
  return null;
}

function evolve(state, to, t, ev) {
  const pet = state.pet;
  const from = pet.species;
  const fromStage = pet.stage;
  const sp = SPECIES[to];
  if (fromStage === 'child') pet.discipline = Math.floor(pet.discipline / 2);
  pet.species = to;
  pet.stage = sp.stage;
  pet.stageAwakeMin = 0;
  pet.hungerMul = 1;
  pet.happyMul = 1;
  pet.hungerTimer = sp.hungerEvery;
  pet.happyTimer = sp.happyEvery;
  pet.poopTimer = sp.poopEvery;
  pet.oldAgeSick = 0;
  if (pet.weight < sp.baseWeight) pet.weight = sp.baseWeight;
  if (sp.stage === 'adult') { pet.adultAwakeMin = 0; pet.specialChecked = false; }
  if (fromStage === 'baby') {
    // Nothing from the baby stage may cost the child. A baby call outlives the 45 baby
    // minutes in both modes (GRACE is longer than the stage), so without this the first
    // absence after hatching would be billed a few minutes into childhood. Marking the call
    // expired means no mistake now, and the next call starts once the meter has been above
    // zero again.
    // (Gentle still counts REPEAT_ZERO_MIN from here, so a child that is never fed pays.)
    if (pet.calls.hunger > 0) pet.calls.hunger = 0;
    if (pet.calls.happy > 0) pet.calls.happy = 0;
  }
  stampDex(state, to, t);
  ev.push({ type: 'evolve', from, to });
}

function checkMature(state, ev) {
  const pet = state.pet;
  if (state.rulesMode !== 'gentle' || pet.departReady || !pet.alive || !isGrown(pet)) return;
  if (pet.stageAwakeMin < (pet.stage === 'special' ? SPECIAL_MATURE_MIN : MATURE_MIN)) return;
  pet.departReady = true;
  if (!pet.matureAnnounced) {
    pet.matureAnnounced = true;
    ev.push({ type: 'mature' });
  }
}

function classicDeathCause(pet, sp) {
  const grown = isGrown(pet);
  if (grown && pet.adultMistakes >= NEGLECT_MISTAKES) return 'neglect';
  if (pet.sick && pet.stage !== 'baby' && pet.sick.awakeMin >= SICK_DEATH_MIN) return 'sick';
  if (pet.zeroHungerMin >= STARVE_MIN) return 'starve';
  if (grown && sp.lifespanMin && pet.adultAwakeMin >= sp.lifespanMin) return 'oldage';
  return null;
}

// ---- one simulated minute -------------------------------------------------------------------
// `t` is the end of the minute. Returns true when the minute counted as an awake one.

function tickMeterCall(state, meter, ctx) {
  const pet = state.pet;
  const calls = pet.calls;
  const ev = ctx.events;
  if (calls[meter] > 0) {
    if (--calls[meter] > 0) return;
    calls[meter] = 0;   // expired: stays 0 until the meter has been above zero again
    ev.push({ type: 'callExpire', reason: meter });
    careMistake(state, ev);
    return;
  }
  // Gentle: an expired call is not a licence to leave the meter empty for good. Nobody dies
  // here, so without this a pet that is never fed again would cost one mistake for life.
  // Classic has starvation and sickness for that and keeps the single mistake.
  if (ctx.classic || calls[meter] !== 0 || pet.stage === 'baby') return;
  if (++pet.zeroRepeat[meter] < REPEAT_ZERO_MIN) return;
  pet.zeroRepeat[meter] = 0;
  careMistake(state, ev);
}

function step(state, t, ctx) {
  const pet = state.pet;
  const ev = ctx.events;
  const classic = ctx.classic;
  const calls = pet.calls;

  // Tantrum grace is real time: it keeps running through sleep.
  if (calls.tantrum !== null && --calls.tantrum <= 0) {
    calls.tantrum = null;
    pet.missedScolds++;
    ev.push({ type: 'callExpire', reason: 'tantrum' });
  }

  if (pet.stage === 'egg') {
    if (++pet.stageAwakeMin >= EGG_HATCH_MIN) hatch(state, t, ev);
    return true;
  }

  if (followsSchedule(pet) && !scheduledAwake(state.settings, t)) {
    if (!pet.asleep) {
      pet.asleep = true;
      ev.push({ type: 'sleep' });
      if (pet.lightsOn) {
        calls.lights = LIGHTS_GRACE_REAL_MIN;
        ev.push({ type: 'callStart', reason: 'lights' });
      }
    } else if (calls.lights !== null && --calls.lights <= 0) {
      calls.lights = null;
      pet.lightsOn = false;   // the pet gives up and switches it off itself
      if (ctx.live) {
        ev.push({ type: 'callExpire', reason: 'lights' });
        careMistake(state, ev);
        if (classic && isGrown(pet) && pet.adultMistakes >= NEGLECT_MISTAKES) die(state, 'neglect', t, ev);
      } else {
        // Absent, in either mode: the pet could not call a closed app, so this is not held
        // against the owner. It only costs a mistake when the app was open for the whole grace.
        ev.push({ type: 'lightsAuto' });
      }
    }
    return false;
  }

  if (pet.asleep) {
    pet.asleep = false;
    pet.lightsOn = true;
    calls.lights = null;
    const birthday = !pet.lastWakeAt || Math.abs(t - pet.lastWakeAt) >= BIRTHDAY_GAP_MS;
    pet.lastWakeAt = t;
    if (birthday) {
      if (pet.ageDays < 99999) pet.ageDays++;
      const sp0 = speciesOf(pet);
      if (classic && isGrown(pet) && sp0.lifespanMin && pet.adultAwakeMin / sp0.lifespanMin >= OLD_AGE_START) {
        pet.hungerMul = Math.max(0.01, pet.hungerMul * OLD_AGE_DECAY_MUL);
        pet.happyMul = Math.max(0.01, pet.happyMul * OLD_AGE_DECAY_MUL);
        pet.hungerTimer = Math.min(pet.hungerTimer, decayInterval(sp0.hungerEvery, pet.hungerMul));
        pet.happyTimer = Math.min(pet.happyTimer, decayInterval(sp0.happyEvery, pet.happyMul));
      }
    }
    ev.push({ type: 'wake' });
  }

  let sp = speciesOf(pet);
  const grown = isGrown(pet);
  pet.stageAwakeMin++;
  pet.totalAwakeMin++;
  if (grown) pet.adultAwakeMin++;
  if (pet.tantrumCooldown > 0) pet.tantrumCooldown--;

  // Calls tick before decay, so a call that starts this minute keeps its full grace.
  tickMeterCall(state, 'hunger', ctx);
  tickMeterCall(state, 'happy', ctx);
  if (pet.hunger === 0 && calls.hunger === null) startMeterCall(state, 'hunger', ev);
  if (pet.happy === 0 && calls.happy === null) startMeterCall(state, 'happy', ev);

  if (--pet.hungerTimer <= 0) {
    pet.hungerTimer = decayInterval(sp.hungerEvery, pet.hungerMul);
    dropMeter(state, 'hunger', ev);
  }
  pet.happyTimer -= pet.sick ? 2 : 1;
  if (pet.happyTimer <= 0) {
    pet.happyTimer = decayInterval(sp.happyEvery, pet.happyMul);
    dropMeter(state, 'happy', ev);
  }

  // Starvation only exists in classic; counting there alone means a switch to classic
  // starts the clock fresh instead of ending the pet on the spot.
  if (classic && pet.hunger === 0 && pet.stage !== 'baby') pet.zeroHungerMin++;
  else pet.zeroHungerMin = 0;

  if (pet.sick) {
    const s = pet.sick;
    s.awakeMin++;
    if (!classic && s.mistakes < SICK_MISTAKE_MAX && s.awakeMin >= SICK_MISTAKE_EVERY_MIN * (s.mistakes + 1)) {
      s.mistakes++;
      careMistake(state, ev);
    }
  }

  const poop = pet.poop;
  let oldest = 0;
  for (let i = 0; i < poop.length; i++) {
    if (++poop[i] > oldest) oldest = poop[i];
  }
  if (pet.stage === 'baby') {
    if (pet.stageAwakeMin === BABY_POOP_AT[0] || pet.stageAwakeMin === BABY_POOP_AT[1]) addPoop(pet, ev);
  } else if (--pet.poopTimer <= 0) {
    pet.poopTimer = sp.poopEvery;
    addPoop(pet, ev);
  }
  if (!pet.sick && oldest > ctx.dirtyMin) makeSick(state, 'dirty', ev);

  if (classic) {
    if (grown && sp.lifespanMin && !pet.sick && pet.oldAgeSick < 2) {
      const lived = pet.adultAwakeMin / sp.lifespanMin;
      if (lived >= (pet.oldAgeSick === 0 ? OLD_AGE_START : OLD_AGE_SECOND)) {
        pet.oldAgeSick++;
        makeSick(state, 'age', ev);
      }
    }
    const cause = classicDeathCause(pet, sp);
    if (cause) {
      die(state, cause, t, ev);
      return true;
    }
  }

  if (!pet.sick) {
    if (sp.stageMin && pet.stageAwakeMin >= sp.stageMin) {
      evolve(state, nextSpecies(pet), t, ev);
    } else if (pet.stage === 'adult' && !pet.specialChecked && pet.stageAwakeMin >= SPECIAL_CHECK_MIN) {
      pet.specialChecked = true;   // checked exactly once, pass or fail
      const to = specialFor(pet);
      if (to) evolve(state, to, t, ev);
    }
  }
  if (!classic) checkMature(state, ev);
  return true;
}

// ---- advance ----------------------------------------------------------------------------------

function settleToSchedule(state, now) {
  const pet = state.pet;
  const asleep = followsSchedule(pet) && !scheduledAwake(state.settings, now);
  pet.asleep = asleep;
  pet.lightsOn = !asleep;
  pet.calls.lights = null;
}

export function advance(state, now, opts) {
  const events = [];
  if (!isObj(state) || !isTime(now)) return events;
  try {
    sanitize(state, now);
    const back = now <= state.lastTick;
    if (back) {
      // Clock moved back: nothing is simulated or undone. Re-anchoring keeps the pet from
      // standing still until the wall clock catches up with a timestamp from the future;
      // hiTick remembers how far the pet has already lived.
      if (now < state.lastTick && (state.hiTick === null || state.hiTick < state.lastTick)) state.hiTick = state.lastTick;
      state.lastTick = now;
    }
    // A mark further ahead than the longest absence ever replayed was not a clock the pet
    // lived by (a wrong date, a forged save): honouring it would make every absence free
    // for that long, so it is dropped instead.
    if (state.hiTick !== null && state.hiTick - now > MAX_CATCHUP_MIN * MIN_MS) state.hiTick = null;
    if (back) return events;
    if (state.paused || !state.pet.alive) {
      state.lastTick = now;
      return events;
    }
    const live = isObj(opts) && opts.live === true;
    if (!live && state.hiTick !== null && state.hiTick > state.lastTick) {
      // Back after the clock was set back and then corrected: the stretch up to the mark was
      // lived before the clock moved, and replaying it would make the pet live those days
      // twice. Live play below the mark is real time passing and is simulated as usual.
      state.lastTick = Math.min(now, state.hiTick);
    }
    let steps = Math.floor((now - state.lastTick) / MIN_MS);
    if (steps <= 0) return events;
    if (steps > MAX_CATCHUP_MIN) {
      steps = MAX_CATCHUP_MIN;
      state.lastTick = now - steps * MIN_MS;
    }
    const classic = state.rulesMode === 'classic';
    const ctx = { events, classic, live, dirtyMin: DIRTY_SICK_MIN[state.rulesMode] };
    let budget = !classic && !live ? AWAY_CAP_MIN : Infinity;
    for (let i = 0; i < steps; i++) {
      const t = state.lastTick + MIN_MS;
      const awake = step(state, t, ctx);
      state.lastTick = t;
      if (!state.pet.alive) {
        state.lastTick = now;   // nothing else happens until newEgg
        break;
      }
      if (awake && --budget <= 0 && i + 1 < steps) {
        events.push({ type: 'awaySkip', minutes: steps - (i + 1) });
        state.lastTick = now;
        settleToSchedule(state, now);
        break;
      }
    }
  } catch (err) {
    // A broken save must never brick the app: drop the unsimulated time and carry on.
    try { state.lastTick = now; } catch (err2) { /* frozen state: nothing more to do */ }
  }
  return events;
}

// ---- actions ------------------------------------------------------------------------------------

const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra);
const done = (extra) => Object.assign({ ok: true }, extra);

// Refusals shared by every hands-on care action, in the order the player would notice them.
function careBlock(state, allowAsleep) {
  const pet = state.pet;
  if (!pet.alive) return 'dead';
  if (state.paused) return 'paused';
  if (pet.stage === 'egg') return 'egg';
  if (!allowAsleep && pet.asleep) return 'asleep';
  return null;
}

function rollTantrum(state, rng, ev) {
  const pet = state.pet;
  if (!followsSchedule(pet) || pet.sick || pet.tantrumCooldown > 0) return false;
  pet.tantrumCooldown = TANTRUM_COOLDOWN_MIN;
  let r = 1;
  try { r = rng(); } catch (err) { r = 1; }
  if (!isNum(r)) r = 1;
  if (!(r < TANTRUM_CHANCE[pet.discipline])) return false;
  pet.calls.tantrum = TANTRUM_GRACE_REAL_MIN;
  ev.push({ type: 'callStart', reason: 'tantrum' });
  return true;
}

function tapEgg(state, t, ev) {
  const pet = state.pet;
  pet.eggTaps++;
  if (pet.eggTaps < EGG_TAPS) return false;
  hatch(state, t, ev);
  return true;
}

const ACTIONS = Object.assign(Object.create(null), {
  tapEgg(state, p, t, rng, ev) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    if (pet.stage !== 'egg') return fail('notEgg');
    const hatched = tapEgg(state, t, ev);
    return done({ hatched, taps: hatched ? EGG_TAPS : pet.eggTaps });
  },

  meal(state, p, t, rng, ev) {
    const pet = state.pet;
    const block = careBlock(state);
    if (block) return fail(block);
    if (pet.sick) return fail('sick');
    if (pet.calls.tantrum !== null) return fail('refuse');
    if (pet.hunger >= METER_MAX) return fail('full');
    if (rollTantrum(state, rng, ev)) return fail('tantrum');
    raiseMeter(pet, 'hunger');
    pet.weight = Math.min(WEIGHT_MAX, pet.weight + MEAL_WEIGHT);
    return done();
  },

  snack(state, p, t, rng, ev) {
    const pet = state.pet;
    const block = careBlock(state);
    if (block) return fail(block);
    if (pet.sick) return fail('sick');
    let gaveIn = false;
    if (pet.calls.tantrum !== null) {
      pet.calls.tantrum = null;
      pet.missedScolds++;
      gaveIn = true;
    }
    raiseMeter(pet, 'happy');
    pet.weight = Math.min(WEIGHT_MAX, pet.weight + SNACK_WEIGHT);
    if (pet.stage === 'baby') {
      pet.babySnacks++;   // the baby is exempt from sweets sickness, so nothing is logged
    } else {
      const nowMin = pet.totalAwakeMin;
      const log = pet.snackLog.filter((m) => nowMin - m >= 0 && nowMin - m <= SWEETS_WINDOW_MIN);
      log.push(nowMin);
      pet.snackLog = log;
      if (log.length >= SWEETS_COUNT) {
        pet.snackLog = [];
        makeSick(state, 'sweets', ev);
      }
    }
    return done({ gaveIn });
  },

  playStart(state, p, t, rng, ev) {
    const pet = state.pet;
    const block = careBlock(state);
    if (block) return fail(block);
    if (pet.sick) return fail('sick');
    if (pet.calls.tantrum !== null) return fail('refuse');
    if (rollTantrum(state, rng, ev)) return fail('tantrum');
    return done();
  },

  playEnd(state, p) {
    const pet = state.pet;
    // A pet that fell asleep mid-game still gets what it earned.
    const block = careBlock(state, true);
    if (block) return fail(block);
    const completed = p.completed === true;
    const won = completed && p.won === true;
    if (completed) {
      pet.weight = Math.max(speciesOf(pet).baseWeight, pet.weight - GAME_WEIGHT);
      pet.bond = Math.min(COUNTER_MAX, pet.bond + (won ? BOND_PER_WIN : BOND_PER_LOSS));
      if (pet.stage === 'baby') pet.babyPlays++;
    }
    if (won) raiseMeter(pet, 'happy');
    return done({ completed, won });
  },

  clean(state) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    if (pet.poop.length === 0) return fail('nothing');
    const cleaned = pet.poop.length;
    pet.poop = [];
    return done({ cleaned });
  },

  medicine(state, p, t, rng, ev) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    if (pet.asleep) return fail('asleep');
    if (!pet.sick) return fail('notSick');
    pet.sick.doses--;
    if (pet.sick.doses > 0) return done({ cured: false, dosesLeft: pet.sick.doses });
    pet.sick = null;
    if (state.rulesMode === 'gentle') {
      // Gentle: an old mess gets a fresh grace period after the cure, so the pet is not
      // sick again one minute later before the owner has had a chance to clean.
      for (let i = 0; i < pet.poop.length; i++) pet.poop[i] = 0;
    }
    ev.push({ type: 'cured' });
    return done({ cured: true, dosesLeft: 0 });
  },

  scold(state, p, t, rng, ev) {
    const pet = state.pet;
    const block = careBlock(state);
    if (block) return fail(block);
    if (pet.calls.tantrum !== null) {
      pet.calls.tantrum = null;
      if (pet.discipline < DISCIPLINE_MAX) pet.discipline++;
      return done();
    }
    dropMeter(state, 'happy', ev);
    return fail('unfair');
  },

  light(state, p) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    const on = typeof p.on === 'boolean' ? p.on : !pet.lightsOn;
    pet.lightsOn = on;
    if (!on) pet.calls.lights = null;
    return done({ on });
  },

  pet(state, p, t, rng, ev) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    if (pet.stage === 'egg') {
      const hatched = tapEgg(state, t, ev);   // a tap on the egg is a tap on the egg
      return fail('egg', { hatched });
    }
    if (pet.asleep) return fail('asleep');
    const windowMs = PET_WINDOW_REAL_MIN * MIN_MS;
    // Stamps from the future (clock moved back) are dropped rather than counted forever.
    pet.petLog = pet.petLog.filter((s) => s <= t && t - s < windowMs);
    if (pet.petLog.length >= PET_CAP) return { ok: true, effective: false, reason: 'tired' };
    pet.petLog.push(t);
    pet.bond = Math.min(COUNTER_MAX, pet.bond + BOND_PER_PET);
    if (pet.stage === 'baby') pet.babyPlays++;
    return done({ effective: true });
  },

  name(state, p) {
    const name = cleanName(p.name);
    if (name) state.pet.name = name;   // empty keeps the old name
    return done({ name: state.pet.name });
  },

  depart(state, p, t) {
    const pet = state.pet;
    if (!pet.alive) return fail('dead');
    if (state.paused) return fail('paused');
    if (state.rulesMode !== 'gentle' || !pet.departReady) return fail('notReady');
    const entry = albumEntry(state, 'journey', t);
    state.pet = newEgg(t, Math.min(9999, pet.gen + 1));
    return done({ entry });
  },

  newEgg(state, p, t) {
    const pet = state.pet;
    if (pet.alive) return fail('alive');
    // The family line continues only through an egg the pet left behind.
    state.pet = newEgg(t, pet.leftEgg ? Math.min(9999, pet.gen + 1) : 1);
    return done();
  },

  pause(state, p, t) {
    const on = typeof p.on === 'boolean' ? p.on : !state.paused;
    state.paused = on;
    state.lastTick = t;
    return done({ paused: on });
  },

  setSchedule(state, p) {
    if (!isNum(p.wakeMin) || !isNum(p.bedMin)) return fail('invalid');
    const wakeMin = int(p.wakeMin, 0, DAY_MIN - 1, 480);
    const bedMin = int(p.bedMin, 0, DAY_MIN - 1, 1380);
    if (wakeMin === bedMin) return fail('invalid');   // an empty day would freeze the pet
    // Not in sanitize(): a save that already holds a shorter day must not be rewritten behind
    // the owner's back on the next launch. Only a new choice is refused.
    if ((bedMin - wakeMin + DAY_MIN) % DAY_MIN < MIN_AWAKE_MIN) return fail('invalid');
    state.settings.wakeMin = wakeMin;
    state.settings.bedMin = bedMin;
    return done();
  },

  setMode(state, p, t, rng, ev) {
    const mode = p.mode;
    if (mode !== 'gentle' && mode !== 'classic') return fail('invalid');
    if (mode === state.rulesMode) return done({ mode });
    const pet = state.pet;
    const calls = pet.calls;
    state.rulesMode = mode;
    if (mode === 'classic') {
      pet.departReady = false;
      if (calls.hunger > GRACE.classic) calls.hunger = GRACE.classic;
      if (calls.happy > GRACE.classic) calls.happy = GRACE.classic;
      // Timers that only kill in classic start from the moment of the switch.
      pet.zeroHungerMin = 0;
      if (pet.sick) pet.sick.awakeMin = 0;
      pet.zeroRepeat.hunger = pet.zeroRepeat.happy = 0;
      // Old age too: a gentle pet may have been kept far past its classic lifespan, and it
      // must not turn into a star the minute the rules change. It re-enters classic just
      // short of old age. Both counters move, because sanitizePet lifts adultAwakeMin back
      // up to stageAwakeMin.
      const sp = speciesOf(pet);
      if (isGrown(pet) && sp.lifespanMin) {
        const cap = Math.floor(OLD_AGE_START * sp.lifespanMin) - 1;
        if (pet.adultAwakeMin > cap) pet.adultAwakeMin = cap;
        if (pet.stageAwakeMin > cap) pet.stageAwakeMin = cap;
      }
    } else {
      const extra = GRACE.gentle - GRACE.classic;
      if (calls.hunger > 0) calls.hunger = Math.min(GRACE.gentle, calls.hunger + extra);
      if (calls.happy > 0) calls.happy = Math.min(GRACE.gentle, calls.happy + extra);
      const sp = speciesOf(pet);
      pet.hungerMul = 1;
      pet.happyMul = 1;
      pet.hungerTimer = Math.min(pet.hungerTimer, sp.hungerEvery);
      pet.happyTimer = Math.min(pet.happyTimer, sp.happyEvery);
      pet.zeroHungerMin = 0;
      if (pet.sick) {
        // Sick time already served is not billed as care mistakes after the fact.
        const served = Math.min(SICK_MISTAKE_MAX, Math.floor(pet.sick.awakeMin / SICK_MISTAKE_EVERY_MIN));
        if (pet.sick.mistakes < served) pet.sick.mistakes = served;
      }
      checkMature(state, ev);
    }
    return done({ mode });
  },

  setTz(state, p) {
    if (!isNum(p.tzOffsetMin)) return fail('invalid');
    state.settings.tzOffsetMin = int(p.tzOffsetMin, -840, 840, 540);
    return done();
  },
});

export function act(state, action, payload, now, opts) {
  let events = [];
  if (!isObj(state)) return { ok: false, reason: 'invalid', events };
  try {
    const rng = isObj(opts) && typeof opts.rng === 'function' ? opts.rng : Math.random;
    events = advance(state, now, { live: true, rng });
    // advance bails out before sanitising when `now` is unusable; actions still need a clean state.
    const t = isTime(now) ? now : (isTime(state.lastTick) ? state.lastTick : 0);
    if (!isTime(now)) sanitize(state, t);
    const handler = typeof action === 'string' ? ACTIONS[action] : undefined;
    if (typeof handler !== 'function') return { ok: false, reason: 'unknown', events };
    const result = handler(state, isObj(payload) ? payload : {}, t, rng, events);
    result.events = events;
    return result;
  } catch (err) {
    return { ok: false, reason: 'error', events };
  }
}

// ---- view ---------------------------------------------------------------------------------------

export function view(state, now) {
  const pet = isObj(state) && isObj(state.pet) ? state.pet : newEgg(0, 1);
  const calls = isObj(pet.calls) ? pet.calls : {};
  const stage = typeof pet.stage === 'string' ? pet.stage : 'egg';
  const alive = pet.alive !== false;
  const hunger = int(pet.hunger, 0, METER_MAX, METER_MAX);
  const happy = int(pet.happy, 0, METER_MAX, METER_MAX);
  const poop = Array.isArray(pet.poop) ? Math.min(POOP_MAX, pet.poop.length) : 0;
  const sick = isObj(pet.sick);
  const asleep = alive && pet.asleep === true;
  const paused = isObj(state) && state.paused === true;
  // Only calls the player can answer right now. A sleeping pet keeps its hunger / happy
  // grace frozen until morning and cannot be fed or scolded, and a paused game refuses
  // everything; the stored calls are untouched and show again when they can be answered.
  const callReasons = !alive || paused ? []
    : CALL_KEYS.filter((k) => calls[k] > 0 && (!asleep || k === 'lights'));
  const tantrum = callReasons.includes('tantrum');

  let mood = 'ok';
  if (stage === 'egg') mood = 'ok';
  else if (!alive) mood = 'sad';
  else if (asleep) mood = 'asleep';
  else if (sick) mood = 'sick';
  else if (tantrum) mood = 'upset';
  else if (hunger === 0 || happy === 0) mood = 'sad';
  else if (hunger >= 3 && happy >= 3 && poop === 0) mood = 'happy';

  return {
    stage,
    species: typeof pet.species === 'string' ? pet.species : 'egg',
    name: typeof pet.name === 'string' && pet.name ? pet.name : DEFAULT_NAME,
    gen: int(pet.gen, 1, 9999, 1),
    alive,
    paused,
    mode: isObj(state) && state.rulesMode === 'classic' ? 'classic' : 'gentle',
    asleep,
    lightsOn: pet.lightsOn !== false,
    sick,
    dosesLeft: sick ? int(pet.sick.doses, 0, 9, 0) : 0,
    poop,
    hunger,
    happy,
    discipline: int(pet.discipline, 0, DISCIPLINE_MAX, 0),
    weight: int(pet.weight, 0, WEIGHT_MAX, 0),
    ageDays: int(pet.ageDays, 0, 99999, 0),
    bondStars: Math.min(5, Math.floor(int(pet.bond, 0, COUNTER_MAX, 0) / BOND_PER_STAR)),
    calling: callReasons.length > 0,
    callReasons,
    tantrum,
    departReady: alive && pet.departReady === true,
    leftEgg: pet.leftEgg === true,
    endCause: typeof pet.endCause === 'string' ? pet.endCause : null,
    mood,
  };
}
