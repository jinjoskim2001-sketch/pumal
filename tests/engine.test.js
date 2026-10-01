// Engine, data and storage tests. Run: node --test tests/
// Everything here is time-zone independent: the state carries its own tzOffsetMin (540 = KST)
// and every timestamp is built from a fixed UTC base.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { VERSION, newGame, advance, act, view } from '../js/engine.js';
import {
  SPECIES, SPECIES_IDS, STAGE_ORDER, SKINS, DEFAULT_NAMES, DEFAULT_NAME, POSTCARDS, postcardText,
  GRACE, REPEAT_ZERO_MIN, AWAY_CAP_MIN, MIN_AWAKE_MIN, DIRTY_SICK_MIN, SPECIAL_CHECK_MIN, MATURE_MIN, SPECIAL_MATURE_MIN, TANTRUM_CHANCE,
} from '../js/data.js';
import {
  loadGame, saveGame, clearGame, changedElsewhere, exportCode, importCode, loadPrefs, savePrefs, DEFAULT_PREFS,
} from '../js/storage.js';

const MIN = 60000;
const DAY = 1440 * MIN;
const BASE = Date.UTC(2026, 9, 1, 0, 0, 0);   // 09:00 local at tzOffsetMin 540

// Local wall-clock time (KST) on day `day` as a timestamp.
const at = (h, m = 0, day = 0) => BASE + ((h - 9) * 60 + m + day * 1440) * MIN;

// Small seeded rng (mulberry32) so tantrum rolls are reproducible.
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
const never = () => 0.999;   // no tantrum
const always = () => 0;      // tantrum whenever the chance is above zero

// A healthy pet of the given species, standing at `now` with full meters.
function make(id, { mode = 'gentle', now = at(9), settings, ...patch } = {}) {
  const s = newGame(now, { rulesMode: mode, ...settings });
  const sp = SPECIES[id];
  Object.assign(s.pet, {
    stage: sp.stage, species: id, hunger: 4, happy: 4,
    hungerTimer: sp.hungerEvery, happyTimer: sp.happyEvery,
    weight: sp.baseWeight, poopTimer: sp.poopEvery ?? 0,
  }, patch);
  s.dex[id] = now;
  return s;
}

// Minute-by-minute live play, the way the 1 s loop drives the engine.
function live(s, minutes) {
  const ev = [];
  const from = s.lastTick;
  for (let i = 1; i <= minutes; i++) ev.push(...advance(s, from + i * MIN, { live: true }));
  return ev;
}

const types = (ev) => ev.map((e) => e.type);
const count = (ev, type) => ev.filter((e) => e.type === type).length;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------------------------

describe('data', () => {
  // The SPEC section 4 table, repeated here so a typo in data.js cannot hide.
  const TABLE = {
    mongsil: ['몽실', 'baby', 4, 5, 5, 2, null, 45, null],
    tongtong: ['통통', 'child', 45, 50, 10, 2, 150, 900, null],
    mallang: ['말랑', 'child', 50, 45, 10, 2, 150, 900, null],
    saessak: ['새싹', 'teen', 60, 65, 20, 2, 180, 1320, null],
    kkabul: ['까불', 'teen', 55, 55, 20, 2, 180, 1320, null],
    ppittak: ['삐딱', 'teen', 50, 45, 20, 2, 180, 1320, null],
    banjjak: ['반짝', 'adult', 90, 95, 30, 1, 180, null, 12000],
    narae: ['나래', 'adult', 85, 80, 25, 1, 180, null, 10000],
    podong: ['포동', 'adult', 60, 85, 40, 3, 120, null, 7000],
    dokkae: ['도깨', 'adult', 75, 60, 30, 2, 180, null, 8000],
    gureum: ['구름', 'adult', 80, 90, 30, 2, 180, null, 6000],
    dwinggul: ['뒹굴', 'adult', 70, 70, 30, 2, 180, null, 5000],
    byeolbit: ['별빛', 'special', 100, 100, 30, 1, 180, null, 14000],
    haessal: ['햇살', 'special', 95, 100, 30, 1, 180, null, 14000],
  };

  test('14 species with the numbers from the spec table', () => {
    assert.deepEqual(SPECIES_IDS, Object.keys(TABLE));
    for (const [id, row] of Object.entries(TABLE)) {
      const sp = SPECIES[id];
      assert.deepEqual(
        [sp.name, sp.stage, sp.hungerEvery, sp.happyEvery, sp.baseWeight, sp.doses, sp.poopEvery, sp.stageMin, sp.lifespanMin],
        row, id);
      assert.equal(sp.id, id);
    }
  });

  test('Korean copy: blurbs and hints exist, hints carry no numbers, no name ends in 치', () => {
    for (const sp of Object.values(SPECIES)) {
      assert.match(sp.blurb, /[가-힣]/, sp.id);
      assert.match(sp.hint, /[가-힣]/, sp.id);
      assert.doesNotMatch(sp.hint, /[0-9]/, sp.id);
      assert.ok(!sp.name.endsWith('치'), sp.id);
    }
    assert.ok(DEFAULT_NAMES.length >= 3);
    for (const n of [...DEFAULT_NAMES, DEFAULT_NAME]) {
      assert.ok(!n.endsWith('치'), n);
      assert.ok(Array.from(n).length <= 6, n);
    }
  });

  test('stage order, skins, constants, postcards', () => {
    assert.deepEqual(STAGE_ORDER, ['egg', 'baby', 'child', 'teen', 'adult', 'special']);
    assert.deepEqual({ ...SKINS }, { ice: 4, lagoon: 7, sakura: 10 });
    assert.deepEqual({ ...GRACE }, { gentle: 300, classic: 180 });
    assert.equal(REPEAT_ZERO_MIN, 480);
    assert.equal(AWAY_CAP_MIN, 720);
    assert.deepEqual({ ...DIRTY_SICK_MIN }, { gentle: 480, classic: 180 });
    assert.equal(SPECIAL_CHECK_MIN, 2400);
    assert.equal(MATURE_MIN, 2880);
    assert.equal(SPECIAL_MATURE_MIN, 1440);
    assert.deepEqual(TANTRUM_CHANCE, [0.6, 0.45, 0.3, 0.15, 0]);
    for (const end of ['journey', 'star']) {
      for (const grade of ['A', 'B', 'C']) {
        const v = POSTCARDS[end][grade];
        assert.equal(v.length, 2);
        for (const text of v) assert.match(text, /[가-힣]/);
        assert.ok(v.includes(postcardText({ end, careGrade: grade, endedAt: BASE })));
      }
    }
    assert.equal(typeof postcardText(null), 'string');
  });

  test('our own files never contain the forbidden words (rule 0.1)', () => {
    // Built from pieces so this test file does not contain them either.
    const words = ['ta' + 'ma', 'got' + 'chi', '다마' + '고치', 'たま' + 'ご'];
    const re = new RegExp(words.join('|'), 'i');
    for (const f of ['../js/data.js', '../js/engine.js', '../js/storage.js', './engine.test.js']) {
      const text = readFileSync(new URL(f, import.meta.url), 'utf8');
      assert.doesNotMatch(text, re, f);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('new game and hatching', () => {
  test('newGame defaults and options', () => {
    const s = newGame(BASE);
    assert.equal(VERSION, 1);
    assert.equal(s.v, 1);
    assert.equal(s.rulesMode, 'gentle');
    assert.deepEqual(s.settings, { wakeMin: 480, bedMin: 1380, tzOffsetMin: 540 });
    assert.equal(s.lastTick, BASE);
    assert.equal(s.pet.stage, 'egg');
    assert.equal(s.pet.gen, 1);
    assert.deepEqual(s.album, []);
    assert.deepEqual(s.dex, {});
    const c = newGame(BASE, { rulesMode: 'classic', wakeMin: 600, bedMin: 120, tzOffsetMin: 0 });
    assert.equal(c.rulesMode, 'classic');
    assert.deepEqual(c.settings, { wakeMin: 600, bedMin: 120, tzOffsetMin: 0 });
    assert.deepEqual(clone(s), s, 'state is plain JSON');
  });

  test('hatch by taps: the 5th tap hatches', () => {
    const s = newGame(BASE);
    for (let i = 1; i <= 4; i++) {
      const r = act(s, 'tapEgg', null, BASE);
      assert.equal(r.ok, true);
      assert.equal(r.hatched, false);
      assert.equal(s.pet.stage, 'egg');
    }
    const r = act(s, 'tapEgg', null, BASE);
    assert.equal(r.ok, true);
    assert.equal(r.hatched, true);
    assert.deepEqual(types(r.events), ['hatch']);
    assert.equal(s.pet.stage, 'baby');
    assert.equal(s.pet.species, 'mongsil');
    assert.equal(s.pet.hunger, 1);
    assert.equal(s.pet.happy, 1);
    assert.equal(s.pet.weight, 5);
    assert.equal(s.dex.mongsil, BASE);
    assert.equal(act(s, 'tapEgg', null, BASE).reason, 'notEgg');
  });

  test('petting the egg counts as a tap', () => {
    const s = newGame(BASE);
    let r;
    for (let i = 0; i < 5; i++) r = act(s, 'pet', null, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'egg');
    assert.equal(r.hatched, true);
    assert.equal(s.pet.stage, 'baby');
  });

  test('hatch by time: after one minute', () => {
    const s = newGame(BASE);
    assert.deepEqual(advance(s, BASE + MIN - 1), []);
    assert.equal(s.pet.stage, 'egg');
    assert.deepEqual(types(advance(s, BASE + MIN)), ['hatch']);
    assert.equal(s.pet.stage, 'baby');
    assert.equal(s.pet.bornAt, BASE + MIN);
  });

  test('care actions on the egg are refused', () => {
    const s = newGame(BASE);
    for (const a of ['meal', 'snack', 'playStart', 'scold']) assert.equal(act(s, a, null, BASE).reason, 'egg', a);
    assert.equal(act(s, 'medicine', null, BASE).reason, 'notSick');
    assert.equal(act(s, 'clean', null, BASE).reason, 'nothing');
  });
});

// ---------------------------------------------------------------------------------------------

describe('time, sleep and decay', () => {
  for (const mode of ['gentle', 'classic']) {
    test(`decay only on awake minutes across a night (${mode})`, () => {
      const s = make('tongtong', { mode, now: at(22), lightsOn: false });
      let ev = advance(s, at(23));
      // 59 awake minutes (22:01–22:59), then the 23:00 minute is the first asleep one.
      assert.equal(s.pet.totalAwakeMin, 59);
      assert.equal(s.pet.hunger, 3);
      assert.equal(s.pet.hungerTimer, 31);
      assert.equal(s.pet.happy, 3);
      assert.equal(s.pet.happyTimer, 41);
      assert.equal(s.pet.asleep, true);
      assert.deepEqual(types(ev), ['heartLoss', 'heartLoss', 'sleep']);

      ev = advance(s, at(7, 59, 1));
      assert.deepEqual(ev, []);
      assert.equal(s.pet.totalAwakeMin, 59);
      assert.equal(s.pet.hunger, 3);
      assert.equal(s.pet.hungerTimer, 31);
      assert.equal(s.pet.happyTimer, 41);
      assert.equal(s.pet.ageDays, 0);
      assert.equal(view(s, at(7, 59, 1)).mood, 'asleep');

      ev = advance(s, at(8, 0, 1));
      assert.deepEqual(types(ev), ['wake']);
      assert.equal(s.pet.asleep, false);
      assert.equal(s.pet.lightsOn, true);
      assert.equal(s.pet.ageDays, 1);
      assert.equal(s.pet.totalAwakeMin, 60);

      advance(s, at(8, 29, 1));
      assert.equal(s.pet.hunger, 3);
      advance(s, at(8, 30, 1));
      assert.equal(s.pet.hunger, 2);
    });
  }

  test('egg and baby ignore the schedule', () => {
    const s = newGame(at(2));
    advance(s, at(2, 1));
    assert.equal(s.pet.stage, 'baby');
    const ev = advance(s, at(2, 40));
    assert.equal(s.pet.asleep, false);
    assert.equal(count(ev, 'sleep'), 0);
    assert.equal(s.pet.hunger, 0);
    assert.equal(s.pet.stageAwakeMin, 39);
  });

  test('a baby that grows up at night falls asleep and wakes one year old', () => {
    const s = make('mongsil', { now: at(2), stageAwakeMin: 44, lightsOn: false });
    let ev = advance(s, at(2, 1), { live: true });
    assert.deepEqual(types(ev), ['evolve']);
    ev = advance(s, at(2, 2), { live: true });
    assert.deepEqual(types(ev), ['sleep']);
    advance(s, at(8, 0));
    assert.equal(s.pet.ageDays, 1);
    assert.equal(s.pet.asleep, false);
  });

  test('sick pets lose happiness twice as fast', () => {
    const a = make('tongtong');
    const b = make('tongtong', { sick: { cause: 'dirty', doses: 2, awakeMin: 0, mistakes: 0 } });
    live(a, 25);
    live(b, 25);
    assert.equal(a.pet.happy, 4);
    assert.equal(b.pet.happy, 3);
    assert.equal(a.pet.hunger, b.pet.hunger);
  });

  test('wrapped schedule: bed after midnight', () => {
    const settings = { wakeMin: 600, bedMin: 120 };   // 10:00 – 02:00
    const asleepAt = (h, m) => {
      const s = make('tongtong', { now: at(h, m) - MIN, settings, lightsOn: false });
      advance(s, at(h, m), { live: true });
      return s.pet.asleep;
    };
    assert.equal(asleepAt(1, 0), false);
    assert.equal(asleepAt(1, 59), false);
    assert.equal(asleepAt(2, 0), true);
    assert.equal(asleepAt(3, 0), true);
    assert.equal(asleepAt(9, 59), true);
    assert.equal(asleepAt(10, 0), false);
    assert.equal(asleepAt(23, 30), false);

    // One continuous run across the wrap: awake until 02:00, asleep until 10:00.
    const s = make('tongtong', { mode: 'classic', now: at(1), settings, lightsOn: false });
    const ev = advance(s, at(10, 0));
    assert.equal(s.pet.totalAwakeMin, 59 + 1);
    assert.deepEqual(types(ev).filter((x) => x === 'sleep' || x === 'wake'), ['sleep', 'wake']);
    assert.equal(s.pet.ageDays, 1);
  });

  test('setSchedule and setTz', () => {
    const s = make('tongtong', { now: at(12) });
    assert.equal(act(s, 'setSchedule', { wakeMin: 600, bedMin: 120 }, at(12)).ok, true);
    assert.deepEqual(s.settings, { wakeMin: 600, bedMin: 120, tzOffsetMin: 540 });
    assert.equal(act(s, 'setSchedule', { wakeMin: 600, bedMin: 600 }, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setSchedule', { wakeMin: 'a', bedMin: 5 }, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setSchedule', {}, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setSchedule', { wakeMin: -50, bedMin: 99999 }, at(12)).ok, true);
    assert.deepEqual([s.settings.wakeMin, s.settings.bedMin], [0, 1439]);
    assert.equal(act(s, 'setTz', { tzOffsetMin: -300 }, at(12)).ok, true);
    assert.equal(s.settings.tzOffsetMin, -300);
    assert.equal(act(s, 'setTz', { tzOffsetMin: NaN }, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setTz', null, at(12)).reason, 'invalid');
  });

  test('setSchedule refuses a day shorter than MIN_AWAKE_MIN; a save that already has one keeps it', () => {
    assert.equal(MIN_AWAKE_MIN, 360);
    const s = make('tongtong', { now: at(12) });
    // 08:00 → 11:00 is the 오전 / 오후 slip on the time wheel: three awake hours.
    assert.equal(act(s, 'setSchedule', { wakeMin: 480, bedMin: 660 }, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setSchedule', { wakeMin: 480, bedMin: 839 }, at(12)).reason, 'invalid');
    assert.deepEqual([s.settings.wakeMin, s.settings.bedMin], [480, 1380], 'a refused schedule changes nothing');
    assert.equal(act(s, 'setSchedule', { wakeMin: 480, bedMin: 840 }, at(12)).ok, true, 'exactly six hours is a day');
    // across midnight: 22:00 → 03:00 is five hours, 22:00 → 04:00 is six
    assert.equal(act(s, 'setSchedule', { wakeMin: 1320, bedMin: 180 }, at(12)).reason, 'invalid');
    assert.equal(act(s, 'setSchedule', { wakeMin: 1320, bedMin: 240 }, at(12)).ok, true);

    // An older save with a short day is not rewritten by the range check.
    const old = make('tongtong', { now: at(12), settings: { wakeMin: 600, bedMin: 780 } });
    advance(old, at(12, 5), { live: true });
    assert.deepEqual([old.settings.wakeMin, old.settings.bedMin], [600, 780]);
  });

  test('the time zone decides the local hour', () => {
    // 09:00 KST is 00:00 UTC: with tzOffsetMin 0 the same instant is the middle of the night.
    const s = make('tongtong', { now: at(9), settings: { tzOffsetMin: 0 }, lightsOn: false });
    advance(s, at(9, 1), { live: true });
    assert.equal(s.pet.asleep, true);
  });

  test('changing the schedule back and forth does not age the pet', () => {
    const s = make('tongtong', { now: at(12), lightsOn: false });
    for (let i = 0; i < 4; i++) {
      const t = at(12, 10 * i + 1);
      act(s, 'setSchedule', { wakeMin: 1200, bedMin: 300 }, t);   // noon is now night
      advance(s, t + MIN, { live: true });
      assert.equal(s.pet.asleep, true);
      act(s, 'light', { on: false }, t + MIN);
      act(s, 'setSchedule', { wakeMin: 480, bedMin: 1380 }, t + 2 * MIN);
      advance(s, t + 3 * MIN, { live: true });
      assert.equal(s.pet.asleep, false);
    }
    assert.equal(s.pet.ageDays, 1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('calls and care mistakes', () => {
  test('classic: hunger call → 180 awake minutes of grace → one care mistake', () => {
    const s = make('tongtong', { mode: 'classic', now: at(10), hunger: 1, hungerTimer: 1 });
    let ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'heartLoss', meter: 'hunger' }, { type: 'callStart', reason: 'hunger' }]);
    assert.equal(s.pet.calls.hunger, 180);
    let v = view(s, s.lastTick);
    assert.equal(v.calling, true);
    assert.deepEqual(v.callReasons, ['hunger']);
    assert.equal(v.mood, 'sad');

    ev = live(s, 179);
    assert.equal(s.pet.calls.hunger, 1);
    assert.equal(s.pet.careMistakes, 0);
    assert.equal(count(ev, 'careMistake'), 0);

    ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'callExpire', reason: 'hunger' }, { type: 'careMistake' }]);
    assert.equal(s.pet.calls.hunger, 0);
    assert.equal(s.pet.careMistakes, 1);
    v = view(s, s.lastTick);
    assert.equal(v.calling, false);
    assert.deepEqual(v.callReasons, []);

    // Expired and still empty: no second call, no second mistake.
    s.pet.happy = 4;   // the other meter would start its own call at minute 200
    ev = live(s, 55);
    assert.equal(s.pet.careMistakes, 1);
    assert.equal(count(ev, 'callStart'), 0);

    // Above zero again clears it, and the next empty meter calls again.
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: never }).ok, true);
    assert.equal(s.pet.calls.hunger, null);
    s.pet.hungerTimer = 1;
    ev = live(s, 1);
    assert.deepEqual(types(ev), ['heartLoss', 'callStart']);
    assert.equal(s.pet.calls.hunger, 180);
  });

  test('gentle: the same call has 300 awake minutes of grace', () => {
    const s = make('tongtong', { now: at(9), hunger: 1, hungerTimer: 1 });
    live(s, 1);
    assert.equal(s.pet.calls.hunger, 300);
    const ev = live(s, 299);
    assert.equal(s.pet.careMistakes, 0);
    assert.equal(count(ev, 'careMistake'), 0);
    assert.deepEqual(live(s, 1).filter((e) => e.type === 'careMistake' || e.type === 'callExpire'),
      [{ type: 'callExpire', reason: 'hunger' }, { type: 'careMistake' }]);
    assert.equal(s.pet.careMistakes, 1);
    assert.equal(s.pet.adultMistakes, 0);
  });

  test('happy call works the same way and feeding in time avoids the mistake', () => {
    const s = make('tongtong', { mode: 'classic', now: at(10), happy: 1, happyTimer: 1 });
    live(s, 1);
    assert.equal(s.pet.calls.happy, 180);
    live(s, 40);
    assert.equal(act(s, 'snack', null, s.lastTick).ok, true);
    assert.equal(s.pet.calls.happy, null);
    live(s, 160);   // well past minute 181, where the first call would have run out
    assert.equal(s.pet.careMistakes, 0);
  });

  test('grace runs on awake minutes only', () => {
    const s = make('tongtong', { now: at(22, 50), hunger: 1, hungerTimer: 1, lightsOn: false });
    advance(s, at(22, 51));
    assert.equal(s.pet.calls.hunger, 300);
    advance(s, at(8, 0, 1) - MIN);
    assert.equal(s.pet.calls.hunger, 300 - 8);   // 22:52–22:59
    assert.equal(s.pet.careMistakes, 0);
  });

  test('baby mistakes are ignored; adult mistakes go to adultMistakes', () => {
    for (const mode of ['gentle', 'classic']) {
      // No baby call runs out on its own (45 baby minutes, grace 300 / 180), so this one is nearly spent.
      const baby = make('mongsil', { mode, hunger: 0, calls: { hunger: 3, happy: null, lights: null, tantrum: null } });
      const ev = live(baby, 5);
      assert.deepEqual(ev.filter((e) => e.type === 'callExpire'), [{ type: 'callExpire', reason: 'hunger' }], mode);
      assert.equal(count(ev, 'careMistake'), 0, mode);
      assert.equal(baby.pet.careMistakes, 0, mode);
      assert.equal(baby.pet.adultMistakes, 0, mode);
    }

    const adult = make('banjjak', { mode: 'classic', hunger: 1, hungerTimer: 1 });
    live(adult, 181);
    assert.equal(adult.pet.adultMistakes, 1);
    assert.equal(adult.pet.careMistakes, 0);
  });

  test('a call the baby started is never held against the child, in either mode', () => {
    const grown = (mode) => {
      const s = make('mongsil', { mode, hunger: 0, happy: 0, calls: { hunger: 3, happy: 50, lights: null, tantrum: null }, stageAwakeMin: 44 });
      live(s, 1);
      assert.equal(s.pet.stage, 'child', mode);
      assert.deepEqual([s.pet.calls.hunger, s.pet.calls.happy], [0, 0], mode);
      return s;
    };
    // 매운맛: the expired calls cost nothing however long they stay (starvation is its own clock).
    const c = grown('classic');
    assert.equal(count(live(c, 170), 'careMistake'), 0);
    assert.equal(c.pet.careMistakes, 0);
    assert.equal(c.pet.zeroHungerMin, 170);

    // 순한맛: free for a whole REPEAT_ZERO_MIN of childhood, then staying empty is the child's own doing.
    const s = grown('gentle');
    let ev = live(s, REPEAT_ZERO_MIN - 1);
    assert.equal(count(ev, 'careMistake'), 0);
    assert.equal(s.pet.careMistakes, 0);
    ev = live(s, 1);
    assert.deepEqual(ev.filter((e) => e.type !== 'heartLoss'), [{ type: 'careMistake' }, { type: 'careMistake' }], 'one per empty meter');
    assert.equal(s.pet.careMistakes, 2);
    // Once fed, the child is on its own clock.
    s.pet.poop = [];
    assert.equal(s.pet.sick, null);
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: never }).ok, true);
    assert.equal(s.pet.calls.hunger, null);
    const ev2 = live(s, 45 + GRACE.gentle);
    assert.deepEqual(ev2.filter((e) => e.type === 'careMistake' || e.type === 'callExpire'),
      [{ type: 'callExpire', reason: 'hunger' }, { type: 'careMistake' }]);
  });

  test('the first absence right after hatching costs no meter mistake in either mode', () => {
    for (const mode of ['gentle', 'classic']) {
      const s = newGame(at(9), { rulesMode: mode });
      for (let i = 0; i < 5; i++) act(s, 'tapEgg', null, at(9));
      const ev = advance(s, at(14));
      assert.equal(s.pet.stage, 'child', mode);
      assert.equal(count(ev, 'careMistake'), 0, mode);
      assert.equal(s.pet.careMistakes, 0, mode);
    }
  });

  test('gentle: a meter left empty costs another mistake every 480 awake minutes after its call ran out', () => {
    // 00:00–23:59 awake, so the whole run is awake minutes. Only hunger is neglected.
    const s = make('saessak', { now: at(0), settings: { wakeMin: 0, bedMin: 1439 }, hunger: 1, hungerTimer: 1 });
    const stamps = [];
    const all = [];
    for (let m = 1; m <= 1300; m++) {
      s.pet.happy = 4;
      s.pet.calls.happy = null;
      s.pet.poop = [];
      const ev = advance(s, at(0) + m * MIN, { live: true });
      all.push(...ev);
      for (let i = count(ev, 'careMistake'); i > 0; i--) stamps.push(m);
    }
    assert.deepEqual(stamps, [301, 301 + REPEAT_ZERO_MIN, 301 + 2 * REPEAT_ZERO_MIN]);
    assert.equal(s.pet.careMistakes, 3);
    assert.equal(s.pet.adultMistakes, 0);
    // The call itself ran out once: the repeat is silent bookkeeping, not a new call.
    assert.equal(all.filter((e) => e.reason === 'hunger').length, 2, 'one callStart, one callExpire');
    assert.equal(s.pet.calls.hunger, 0);
    assert.equal(view(s, s.lastTick).calling, false);
    assert.equal(s.pet.zeroRepeat.hunger, 1300 - 1261);

    // A meal ends it: the counter starts over and the next empty meter gets a fresh call.
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: never }).ok, true);
    assert.deepEqual(s.pet.zeroRepeat, { hunger: 0, happy: 0 });
    assert.equal(s.pet.calls.hunger, null);
    s.pet.hungerTimer = 1;
    assert.deepEqual(types(live(s, 1)).filter((x) => x === 'callStart'), ['callStart']);
    assert.equal(s.pet.calls.hunger, GRACE.gentle);
  });

  test('the repeat charge: adults pay in adultMistakes, asleep minutes are free, 매운맛 and babies never pay', () => {
    // One awake minute short of the next charge.
    const due = () => ({ hunger: 0, calls: { hunger: 0, happy: null, lights: null, tantrum: null }, zeroRepeat: { hunger: REPEAT_ZERO_MIN - 1, happy: 0 } });
    const adult = make('narae', due());
    assert.deepEqual(live(adult, 1), [{ type: 'careMistake' }]);
    assert.deepEqual([adult.pet.adultMistakes, adult.pet.careMistakes, adult.pet.zeroRepeat.hunger], [1, 0, 0]);

    const night = make('tongtong', { ...due(), now: at(1), asleep: true, lightsOn: false });
    assert.deepEqual(advance(night, at(7, 59), { live: true }), []);
    assert.equal(night.pet.zeroRepeat.hunger, REPEAT_ZERO_MIN - 1);
    assert.equal(count(advance(night, at(8, 0), { live: true }), 'careMistake'), 1);

    const classic = make('saessak', { ...due(), mode: 'classic', now: at(6), settings: { wakeMin: 360, bedMin: 1380 } });
    let ev = [];
    for (let m = 1; m <= 600; m++) {
      classic.pet.happy = 4;
      classic.pet.calls.happy = null;
      classic.pet.poop = [];
      ev = ev.concat(advance(classic, at(6) + m * MIN, { live: true }));
    }
    assert.equal(count(ev, 'careMistake'), 0);
    assert.deepEqual(classic.pet.zeroRepeat, { hunger: 0, happy: 0 });
    assert.equal(classic.pet.zeroHungerMin, 600, 'classic counts towards starvation instead');

    const baby = make('mongsil', { ...due(), stageAwakeMin: 5 });
    assert.equal(count(live(baby, 30), 'careMistake'), 0);
    assert.equal(baby.pet.zeroRepeat.hunger, 0);
  });

  test('a sleeping or paused pet does not call for something the player cannot do', () => {
    const s = make('tongtong', { now: at(22, 50), hunger: 1, hungerTimer: 1, lightsOn: false });
    advance(s, at(22, 51), { live: true });
    assert.deepEqual(view(s, s.lastTick).callReasons, ['hunger']);
    for (const t of [at(23, 30), at(3, 0, 1), at(7, 54, 1)]) {
      advance(s, t, { live: true });
      const v = view(s, t);
      assert.deepEqual([v.asleep, v.calling, v.callReasons], [true, false, []]);
      assert.equal(act(s, 'meal', null, t, { rng: never }).reason, 'asleep');
      assert.equal(s.pet.calls.hunger, GRACE.gentle - 8, 'the stored call is frozen, not dropped');
    }
    // It is back the minute the pet wakes up and can be fed.
    advance(s, at(8, 0, 1), { live: true });
    const awake = view(s, s.lastTick);
    assert.deepEqual([awake.asleep, awake.calling, awake.callReasons], [false, true, ['hunger']]);
    assert.equal(s.pet.calls.hunger, GRACE.gentle - 9);

    // The light is the one thing a sleeper can ask for, and a tantrum cannot be scolded asleep.
    const l = make('tongtong', { now: at(22, 59), hunger: 0, calls: { hunger: 100, happy: null, lights: null, tantrum: 10 } });
    live(l, 1);
    const lv = view(l, l.lastTick);
    assert.deepEqual([lv.asleep, lv.callReasons, lv.tantrum, lv.mood], [true, ['lights'], false, 'asleep']);

    // 돌보미: every action is refused, so nothing is reported until it is switched off.
    const p = make('tongtong', { now: at(12), hunger: 0, calls: { hunger: 50, happy: null, lights: null, tantrum: 10 } });
    assert.deepEqual(view(p, at(12)).callReasons, ['hunger', 'tantrum']);
    act(p, 'pause', { on: true }, at(12));
    const pv = view(p, at(12));
    assert.deepEqual([pv.paused, pv.calling, pv.callReasons, pv.tantrum], [true, false, [], false]);
    assert.equal(act(p, 'meal', null, at(12)).reason, 'paused');
    act(p, 'pause', { on: false }, at(12));
    assert.deepEqual(view(p, at(12)).callReasons, ['hunger', 'tantrum']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('absence', () => {
  test('gentle: two days away cost exactly 720 awake minutes and nobody dies', () => {
    const s = make('tongtong', { now: at(9) });
    const now = at(9, 0, 2);
    const ev = advance(s, now);
    const skip = ev.find((e) => e.type === 'awaySkip');
    assert.ok(skip);
    assert.equal(skip.minutes, 2 * 1440 - 720);
    assert.equal(ev[ev.length - 1], skip);
    assert.equal(s.pet.totalAwakeMin, 720);
    assert.equal(s.pet.alive, true);
    assert.equal(s.lastTick, now);
    assert.equal(s.pet.ageDays, 0, 'no age gain for the skipped mornings');
    assert.equal(s.pet.asleep, false);
    assert.equal(s.pet.lightsOn, true);
    // The consequences of one long day alone: both meters empty, a full floor, one sickness.
    assert.equal(s.pet.hunger, 0);
    assert.equal(s.pet.happy, 0);
    assert.equal(s.pet.poop.length, 4);
    assert.equal(s.pet.sick.cause, 'dirty');
    // Hunger call (minute 480) and happy call (500), and nothing more: the sickness (from
    // minute 631) has not been left for 240 minutes yet, and neither meter has been empty a
    // whole REPEAT_ZERO_MIN past its call. One long day alone is one bad day.
    assert.equal(s.pet.careMistakes, 2);
    assert.equal(count(ev, 'careMistake'), 2);
    assert.equal(count(ev, 'death'), 0);
    assert.deepEqual(s.album, []);

    // A second long absence: both sickness mistakes (871 and 1111), and the empty meters
    // keep costing - hunger at 960 and 1440, happy at 980.
    const ev2 = advance(s, at(9, 0, 6));
    assert.equal(count(ev2, 'awaySkip'), 1);
    assert.equal(s.pet.totalAwakeMin, 1440);
    assert.equal(s.pet.careMistakes, 7);
    assert.equal(s.pet.alive, true);
  });

  test('gentle: returning at night finds the pet asleep with the light off', () => {
    const s = make('tongtong', { now: at(9) });
    const now = at(3, 0, 2);
    const ev = advance(s, now);
    assert.equal(count(ev, 'awaySkip'), 1);
    assert.equal(s.pet.asleep, true);
    assert.equal(s.pet.lightsOn, false);
    assert.equal(s.pet.calls.lights, null);
    assert.equal(view(s, now).calling, false);
    // The next morning it wakes normally and has its birthday.
    const ev2 = advance(s, at(8, 0, 2));
    assert.deepEqual(types(ev2), ['wake']);
    assert.equal(s.pet.ageDays, 1);
  });

  test('gentle: a short absence is simulated in full, with no skip', () => {
    const s = make('tongtong', { now: at(9) });
    const ev = advance(s, at(21));
    assert.equal(count(ev, 'awaySkip'), 0);
    assert.equal(s.pet.totalAwakeMin, 720);
    const s2 = make('tongtong', { now: at(9) });
    assert.equal(advance(s2, at(21, 1)).filter((e) => e.type === 'awaySkip')[0].minutes, 1);
  });

  test('gentle: live play is never capped', () => {
    const s = make('banjjak', { now: at(9) });
    const ev = advance(s, at(22, 59), { live: true });
    assert.equal(count(ev, 'awaySkip'), 0);
    assert.equal(s.pet.totalAwakeMin, 839);
  });

  test('classic: no cap — the same absence keeps counting and ends the pet', () => {
    const s = make('banjjak', { mode: 'classic', now: at(9) });
    let ev = advance(s, at(22, 20));
    assert.equal(count(ev, 'awaySkip'), 0);
    assert.equal(s.pet.totalAwakeMin, 800);
    assert.equal(s.pet.alive, true);

    ev = advance(s, at(9, 0, 2));
    assert.equal(count(ev, 'awaySkip'), 0);
    assert.deepEqual(ev.filter((e) => e.type === 'death'), [{ type: 'death', cause: 'sick' }]);
    assert.equal(s.pet.alive, false);
    assert.equal(s.pet.totalAwakeMin, 841);   // dirty at 361, 480 awake minutes untreated
    assert.equal(s.lastTick, at(9, 0, 2));
    assert.equal(s.album.length, 1);
  });

  test('a 30-day jump (and far more) is survivable, fast and clamped', () => {
    const g = make('tongtong', { now: at(9) });
    let ev = advance(g, at(9, 0, 30));
    assert.equal(count(ev, 'awaySkip'), 1);
    assert.equal(g.pet.alive, true);
    assert.equal(g.pet.totalAwakeMin, 720);
    assert.equal(g.lastTick, at(9, 0, 30));

    const egg = newGame(at(9));
    advance(egg, at(9, 0, 30));
    assert.equal(egg.pet.alive, true);
    assert.equal(egg.pet.stage, 'child');
    assert.equal(egg.lastTick, at(9, 0, 30));

    const c = make('tongtong', { mode: 'classic', now: at(9) });
    ev = advance(c, at(9, 0, 30));
    assert.equal(c.pet.alive, false);
    assert.equal(count(ev, 'death'), 1);
    assert.equal(c.lastTick, at(9, 0, 30));

    // The full 43,200-step loop with nothing to stop it early: gentle + live.
    const full = make('banjjak', { now: at(9) });
    const started = process.hrtime.bigint();
    ev = advance(full, at(9, 0, 30), { live: true });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(full.pet.alive, true);
    assert.equal(full.pet.ageDays, 30);
    assert.equal(full.pet.totalAwakeMin, 839 + 29 * 900 + 61);
    assert.equal(full.lastTick, at(9, 0, 30));
    assert.ok(ms < 2000, `30-day catch-up took ${ms.toFixed(1)} ms`);

    // Ten years: only the last 30 days are simulated.
    const old = make('banjjak', { now: at(9) });
    advance(old, at(9, 0, 3650), { live: true });
    assert.equal(old.pet.ageDays, 30);
    assert.equal(old.lastTick, at(9, 0, 3650));
  });

  test('pause (돌보미): time passes, nothing happens', () => {
    const s = make('tongtong', { now: at(9) });
    assert.deepEqual(act(s, 'pause', { on: true }, at(9, 10)).paused, true);
    const before = clone(s.pet);
    const ev = advance(s, at(9, 10, 5));
    assert.deepEqual(ev, []);
    assert.deepEqual(s.pet, before);
    assert.equal(s.lastTick, at(9, 10, 5));
    assert.equal(view(s, s.lastTick).paused, true);
    for (const a of ['meal', 'snack', 'playStart', 'clean', 'medicine', 'scold', 'light', 'pet', 'depart']) {
      assert.equal(act(s, a, null, at(9, 10, 5)).reason, 'paused', a);
    }
    assert.deepEqual(s.pet, before);

    assert.equal(act(s, 'pause', { on: false }, at(9, 30, 5)).paused, false);
    assert.equal(s.lastTick, at(9, 30, 5));
    advance(s, at(10, 5, 5), { live: true });
    assert.equal(s.pet.hunger, 3);   // 10 minutes before the pause + 35 after = 45
    assert.equal(s.pet.totalAwakeMin, 45);
  });

  test('clock moved backwards: nothing is simulated, then time carries on from there', () => {
    const s = make('tongtong', { now: at(12) });
    live(s, 20);
    const before = clone(s.pet);
    const back = at(12) - DAY;
    assert.deepEqual(advance(s, back), []);
    assert.deepEqual(s.pet, before);
    assert.equal(s.lastTick, back);
    assert.deepEqual(advance(s, back), [], 'zero elapsed time does nothing');
    assert.deepEqual(s.pet, before);
    advance(s, back + 25 * MIN, { live: true });
    assert.equal(s.pet.totalAwakeMin, 45);
    assert.equal(s.pet.hunger, 3);
    // An action with a clock from the past still works and does not throw.
    assert.equal(act(s, 'snack', null, back - DAY).ok, true);
  });

  test('clock set back and then corrected: the days in between are not lived twice', () => {
    for (const mode of ['gentle', 'classic']) {
      const t0 = at(12);
      const s = make('kkabul', { mode, now: t0 });
      // The date goes back two days and the app is opened once.
      assert.deepEqual(advance(s, t0 - 2 * DAY, { live: true }), [], mode);
      assert.deepEqual([s.lastTick, s.hiTick], [t0 - 2 * DAY, t0], mode);
      // Five real minutes later the date is right again and the app sees a two-day gap.
      const ev = advance(s, t0 + 5 * MIN);
      assert.deepEqual(ev, [], mode);
      assert.deepEqual([s.pet.alive, s.pet.totalAwakeMin, s.pet.careMistakes, s.pet.ageDays, s.pet.sick],
        [true, 5, 0, 0, null], mode);
      assert.equal(s.lastTick, t0 + 5 * MIN, mode);
      // From here on an absence is an absence again.
      advance(s, t0 + 65 * MIN);
      assert.equal(s.pet.totalAwakeMin, 65, mode);
    }

    // A return that is still short of the mark costs nothing and keeps the mark.
    const early = make('tongtong', { mode: 'classic', now: at(12) });
    advance(early, at(12) - 2 * DAY, { live: true });
    assert.deepEqual(advance(early, at(12) - DAY), []);
    assert.deepEqual([early.pet.totalAwakeMin, early.lastTick, early.hiTick], [0, at(12) - DAY, at(12)]);

    // A mark more than 30 days ahead was never a clock the pet lived by: it is dropped, so
    // a wrong date or a forged save cannot make absences free for that long.
    const forged = make('tongtong', { now: at(12) });
    forged.hiTick = at(12) + 400 * DAY;
    advance(forged, at(12, 0, 1));
    assert.equal(forged.pet.totalAwakeMin, AWAY_CAP_MIN);
    assert.equal(forged.hiTick, null);
    const future = make('tongtong', { now: at(12) + 400 * DAY });   // the whole save is from the future
    advance(future, at(12));
    assert.deepEqual([future.lastTick, future.hiTick], [at(12), null]);
    advance(future, at(13));
    assert.equal(future.pet.totalAwakeMin, 60);

    // No mark unless the clock really went back: ordinary play never sets one, a save from
    // before the field existed has none, and junk in it is no mark either.
    const plain = make('tongtong', { now: at(12) });
    assert.equal(plain.hiTick, null);
    live(plain, 30);
    advance(plain, plain.lastTick);   // zero elapsed time is not a step back
    act(plain, 'pause', { on: true }, at(13));
    advance(plain, at(13, 0, 2));
    assert.equal(plain.hiTick, null);
    for (const junk of [undefined, 'soon', NaN, 1e300, {}]) {
      const old = make('tongtong', { now: at(12) });
      if (junk === undefined) delete old.hiTick; else old.hiTick = junk;
      advance(old, at(13));
      assert.deepEqual([old.pet.totalAwakeMin, old.hiTick], [60, null], String(junk));
    }
    // A fixture or tool that rewinds lastTick by hand still gets its absence simulated.
    const rewound = make('tongtong', { mode: 'classic', now: at(12) });
    rewound.lastTick = at(12) - 3 * DAY;
    advance(rewound, at(12));
    assert.equal(rewound.pet.alive, false);
  });

  test('less than a whole minute is carried, not lost', () => {
    const s = make('tongtong', { now: at(9) });
    for (let i = 1; i <= 90; i++) advance(s, at(9) + i * 1000, { live: true });
    assert.equal(s.pet.totalAwakeMin, 1);
    assert.equal(s.lastTick, at(9, 1));
  });
});

// ---------------------------------------------------------------------------------------------

describe('lights', () => {
  test('live: falling asleep with the light on calls; ignoring it for 15 minutes is a mistake', () => {
    for (const mode of ['gentle', 'classic']) {
      const s = make('tongtong', { mode, now: at(22, 59) });
      let ev = live(s, 1);
      assert.deepEqual(ev, [{ type: 'sleep' }, { type: 'callStart', reason: 'lights' }], mode);
      assert.equal(s.pet.calls.lights, 15);
      assert.deepEqual(view(s, s.lastTick).callReasons, ['lights']);
      ev = live(s, 14);
      assert.deepEqual(ev, []);
      assert.equal(s.pet.lightsOn, true);
      ev = live(s, 1);
      assert.deepEqual(ev, [{ type: 'callExpire', reason: 'lights' }, { type: 'careMistake' }], mode);
      assert.equal(s.pet.careMistakes, 1, mode);
      assert.equal(s.pet.lightsOn, false);
      assert.equal(s.pet.calls.lights, null);
      assert.deepEqual(live(s, 60), []);
      assert.equal(s.pet.careMistakes, 1);
    }
  });

  test('live: switching the light off in time clears the call', () => {
    const s = make('tongtong', { now: at(22, 59) });
    live(s, 6);
    const r = act(s, 'light', { on: false }, s.lastTick);
    assert.equal(r.ok, true);
    assert.equal(r.on, false);
    assert.equal(s.pet.calls.lights, null);
    assert.equal(view(s, s.lastTick).calling, false);
    live(s, 30);
    assert.equal(s.pet.careMistakes, 0);
  });

  test('light already off at bedtime: no call', () => {
    const s = make('tongtong', { now: at(22, 30) });
    assert.equal(act(s, 'light', { on: false }, at(22, 30)).ok, true);
    const ev = live(s, 60);
    assert.equal(count(ev, 'callStart'), 0);
    assert.equal(s.pet.careMistakes, 0);
    assert.equal(s.pet.asleep, true);
  });

  test('away, gentle: the pet switches the light off itself, no mistake', () => {
    const s = make('tongtong', { now: at(22, 59) });
    const ev = advance(s, at(23, 30));
    assert.deepEqual(types(ev), ['sleep', 'callStart', 'lightsAuto']);
    assert.equal(s.pet.careMistakes, 0);
    assert.equal(s.pet.lightsOn, false);
  });

  test('away, classic: the same — a closed app is never charged for the light', () => {
    const s = make('tongtong', { mode: 'classic', now: at(22, 59) });
    const ev = advance(s, at(23, 30));
    assert.deepEqual(types(ev), ['sleep', 'callStart', 'lightsAuto']);
    assert.equal(s.pet.careMistakes, 0);
    assert.equal(s.pet.lightsOn, false);

    // So a night away cannot be the fifth mistake that ends an adult; the same night with
    // the app open for the whole grace can.
    const away = make('banjjak', { mode: 'classic', now: at(22, 59), adultMistakes: 4 });
    assert.equal(count(advance(away, at(23, 30)), 'death'), 0);
    assert.deepEqual([away.pet.alive, away.pet.adultMistakes], [true, 4]);
    const there = make('banjjak', { mode: 'classic', now: at(22, 59), adultMistakes: 4 });
    assert.deepEqual(live(there, 16).filter((e) => e.type === 'death'), [{ type: 'death', cause: 'neglect' }]);
  });

  test('the light switch works at any time, and waking turns it back on', () => {
    const s = make('tongtong', { now: at(12) });
    assert.equal(act(s, 'light', { on: false }, at(12)).ok, true);
    assert.equal(view(s, at(12)).lightsOn, false);
    assert.equal(act(s, 'light', null, at(12)).on, true, 'no payload toggles');
    act(s, 'light', { on: false }, at(12));
    advance(s, at(8, 0, 1), { live: true });
    assert.equal(s.pet.lightsOn, true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('mess, sickness, medicine', () => {
  test('baby poop is scripted at stage minutes 12 and 30', () => {
    const s = newGame(BASE);
    advance(s, BASE + MIN);                       // hatch; stage minute 0
    let ev = advance(s, BASE + 12 * MIN, { live: true });
    assert.equal(count(ev, 'poop'), 0);
    ev = advance(s, BASE + 13 * MIN, { live: true });
    assert.equal(count(ev, 'poop'), 1);
    assert.equal(s.pet.stageAwakeMin, 12);
    ev = advance(s, BASE + 30 * MIN, { live: true });
    assert.equal(count(ev, 'poop'), 0);
    ev = advance(s, BASE + 31 * MIN, { live: true });
    assert.equal(count(ev, 'poop'), 1);
    ev = advance(s, BASE + 45 * MIN, { live: true });
    assert.equal(count(ev, 'poop'), 0);
    assert.equal(s.pet.poop.length, 2);
    assert.equal(view(s, s.lastTick).poop, 2);
  });

  test('child poop cadence: every 150 awake minutes, at most 4', () => {
    const s = make('tongtong', { now: at(9) });
    assert.equal(count(advance(s, at(9) + 149 * MIN, { live: true }), 'poop'), 0);
    assert.equal(count(advance(s, at(9) + 150 * MIN, { live: true }), 'poop'), 1);
    assert.equal(count(advance(s, at(9) + 299 * MIN, { live: true }), 'poop'), 0);
    assert.equal(count(advance(s, at(9) + 300 * MIN, { live: true }), 'poop'), 1);
    assert.equal(count(advance(s, at(9) + 600 * MIN, { live: true }), 'poop'), 2);
    assert.equal(count(advance(s, at(9) + 800 * MIN, { live: true }), 'poop'), 0);
    assert.equal(s.pet.poop.length, 4);
    assert.equal(s.pet.poopTimer, 100, 'the timer keeps reloading while the floor is full');
  });

  test('no poop while asleep', () => {
    const s = make('tongtong', { now: at(22, 58), poopTimer: 5, lightsOn: false });
    advance(s, at(7, 59, 1), { live: true });
    assert.equal(s.pet.poop.length, 0);
    assert.equal(s.pet.poopTimer, 4);
  });

  test('a mess older than 480 (순한맛) / 180 (매운맛) awake minutes makes the pet sick', () => {
    const c = make('tongtong', { mode: 'classic', poop: [179] });
    assert.deepEqual(live(c, 1), []);
    assert.deepEqual(live(c, 1), [{ type: 'sick', cause: 'dirty' }]);

    const s = make('tongtong', { poop: [361] });
    assert.equal(count(live(s, 119), 'sick'), 0, 'the classic limit means nothing here');
    assert.equal(s.pet.sick, null);
    const ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'sick', cause: 'dirty' }]);
    assert.deepEqual(s.pet.sick, { cause: 'dirty', doses: 2, awakeMin: 0, mistakes: 0 });
    const v = view(s, s.lastTick);
    assert.equal(v.sick, true);
    assert.equal(v.dosesLeft, 2);
    assert.equal(v.mood, 'sick');
    for (const a of ['meal', 'snack', 'playStart']) {
      s.pet.hunger = 2;
      assert.equal(act(s, a, null, s.lastTick, { rng: always }).reason, 'sick', a);
    }
    assert.equal(act(s, 'clean', null, s.lastTick).cleaned, 1);
    assert.equal(act(s, 'clean', null, s.lastTick).reason, 'nothing');
    assert.equal(s.pet.sick.cause, 'dirty', 'cleaning does not cure');
  });

  test('medicine: doses by species, cure, and refusal when healthy', () => {
    for (const [id, doses] of [['tongtong', 2], ['banjjak', 1], ['podong', 3]]) {
      const s = make(id, { poop: [DIRTY_SICK_MIN.gentle] });
      live(s, 1);
      assert.equal(s.pet.sick.doses, doses, id);
      for (let d = doses; d > 1; d--) {
        const r = act(s, 'medicine', null, s.lastTick);
        assert.deepEqual([r.ok, r.cured, r.dosesLeft], [true, false, d - 1], id);
        assert.equal(count(r.events, 'cured'), 0);
      }
      const r = act(s, 'medicine', null, s.lastTick);
      assert.deepEqual([r.ok, r.cured, r.dosesLeft], [true, true, 0], id);
      assert.deepEqual(r.events, [{ type: 'cured' }]);
      assert.equal(s.pet.sick, null);
      assert.equal(s.pet.sickCount, 1);
      const again = act(s, 'medicine', null, s.lastTick);
      assert.deepEqual([again.ok, again.reason], [false, 'notSick']);
    }
  });

  test('after a cure: gentle restarts the grace of an old mess, classic does not', () => {
    const g = make('tongtong', { poop: [400, 20], sick: { cause: 'dirty', doses: 1, awakeMin: 5, mistakes: 0 } });
    act(g, 'medicine', null, g.lastTick);
    assert.deepEqual(g.pet.poop, [0, 0]);
    live(g, 5);
    assert.equal(g.pet.sick, null);

    const c = make('tongtong', { mode: 'classic', poop: [300, 20], sick: { cause: 'dirty', doses: 1, awakeMin: 5, mistakes: 0 } });
    act(c, 'medicine', null, c.lastTick);
    assert.deepEqual(c.pet.poop, [300, 20]);
    live(c, 1);
    assert.equal(c.pet.sick.cause, 'dirty');
    assert.equal(c.pet.sickCount, 1);
  });

  test('4 snacks within 30 awake minutes make it sick; the baby is exempt', () => {
    const s = make('tongtong', { happy: 0 });
    for (let i = 0; i < 3; i++) {
      const r = act(s, 'snack', null, s.lastTick);
      assert.equal(r.ok, true);
      assert.equal(count(r.events, 'sick'), 0);
      live(s, 10);
    }
    const r = act(s, 'snack', null, s.lastTick);   // awake minutes 0, 10, 20, 30
    assert.equal(r.ok, true);
    assert.deepEqual(r.events, [{ type: 'sick', cause: 'sweets' }]);
    assert.equal(s.pet.sick.cause, 'sweets');
    assert.equal(s.pet.weight, 18);
    assert.equal(s.pet.happy, 4);
    assert.equal(act(s, 'snack', null, s.lastTick).reason, 'sick');

    const slow = make('tongtong');
    for (let i = 0; i < 3; i++) act(slow, 'snack', null, slow.lastTick);
    live(slow, 31);
    assert.equal(act(slow, 'snack', null, slow.lastTick).ok, true);
    assert.equal(slow.pet.sick, null);

    const baby = make('mongsil');
    for (let i = 0; i < 6; i++) assert.equal(act(baby, 'snack', null, baby.lastTick).ok, true);
    assert.equal(baby.pet.sick, null);
    assert.equal(baby.pet.babySnacks, 6);
  });

  test('gentle: untreated sickness costs one mistake per 240 awake minutes, at most 2', () => {
    const s = make('saessak', { now: at(9), sick: { cause: 'dirty', doses: 2, awakeMin: 0, mistakes: 0 }, hungerTimer: 60 });
    const feed = () => { s.pet.hunger = 4; s.pet.happy = 4; s.pet.calls.hunger = null; s.pet.calls.happy = null; s.pet.poop = []; };
    let mistakes = 0;
    for (let m = 1; m <= 800; m++) {
      feed();   // keep everything else perfect so only the sickness can cost anything
      mistakes += count(advance(s, at(9) + m * MIN, { live: true }), 'careMistake');
      if (m === 239) assert.equal(mistakes, 0);
      if (m === 240) assert.equal(mistakes, 1);
      if (m === 479) assert.equal(mistakes, 1);
      if (m === 480) assert.equal(mistakes, 2);
    }
    assert.equal(mistakes, 2);
    assert.equal(s.pet.careMistakes, 2);
    assert.equal(s.pet.alive, true);
    assert.equal(s.pet.stage, 'teen');
  });

  test('medicine, meals and scolding are refused while asleep; cleaning works', () => {
    const s = make('tongtong', { now: at(1), asleep: true, lightsOn: false, poop: [5], hunger: 2,
      sick: { cause: 'dirty', doses: 2, awakeMin: 0, mistakes: 0 } });
    for (const a of ['meal', 'snack', 'playStart', 'medicine', 'scold', 'pet']) {
      assert.equal(act(s, a, null, at(1), { rng: always }).reason, 'asleep', a);
    }
    assert.equal(act(s, 'clean', null, at(1)).ok, true);
    assert.equal(act(s, 'light', { on: true }, at(1)).ok, true);
    assert.equal(s.pet.calls.lights, null, 'switching the light on mid-sleep starts no call');
  });
});

// ---------------------------------------------------------------------------------------------

describe('tantrums and discipline', () => {
  test('start: a meal while hungry can trigger one; the action fails', () => {
    const s = make('tongtong', { hunger: 2 });
    const r = act(s, 'meal', null, s.lastTick, { rng: always });
    assert.deepEqual([r.ok, r.reason], [false, 'tantrum']);
    assert.deepEqual(r.events, [{ type: 'callStart', reason: 'tantrum' }]);
    assert.equal(s.pet.calls.tantrum, 15);
    assert.equal(s.pet.tantrumCooldown, 90);
    assert.equal(s.pet.hunger, 2);
    const v = view(s, s.lastTick);
    assert.equal(v.tantrum, true);
    assert.equal(v.calling, true);
    assert.equal(v.mood, 'upset');
    assert.deepEqual(v.callReasons, ['tantrum']);
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: never }).reason, 'refuse');
    assert.equal(act(s, 'playStart', null, s.lastTick, { rng: never }).reason, 'refuse');
  });

  test('a game can trigger one too, whatever the hunger', () => {
    const s = make('kkabul');
    assert.equal(act(s, 'playStart', null, s.lastTick, { rng: always }).reason, 'tantrum');
    const calm = make('kkabul');
    assert.equal(act(calm, 'playStart', null, calm.lastTick, { rng: never }).ok, true);
    assert.equal(calm.pet.tantrumCooldown, 90);
  });

  test('scold during a tantrum: discipline +1 and it ends', () => {
    const s = make('tongtong', { hunger: 2 });
    act(s, 'meal', null, s.lastTick, { rng: always });
    const r = act(s, 'scold', null, s.lastTick);
    assert.equal(r.ok, true);
    assert.equal(s.pet.discipline, 1);
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(s.pet.missedScolds, 0);
    assert.equal(view(s, s.lastTick).tantrum, false);
    // Cooldown: no new roll for 90 awake minutes, so the meal goes through even with a hostile rng.
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: always }).ok, true);
    assert.equal(s.pet.hunger, 3);
    live(s, 89);
    s.pet.hunger = 2;
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: always }).ok, true);
    live(s, 1);
    s.pet.hunger = 2;
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: always }).reason, 'tantrum');
  });

  test('discipline caps at 4 and then tantrums stop', () => {
    const s = make('tongtong', { hunger: 2, discipline: 3 });
    act(s, 'meal', null, s.lastTick, { rng: always });
    act(s, 'scold', null, s.lastTick);
    assert.equal(s.pet.discipline, 4);
    s.pet.tantrumCooldown = 0;
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: always }).ok, true);
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(view(s, s.lastTick).discipline, 4);
  });

  test('give in: a snack ends the tantrum and is remembered', () => {
    const s = make('tongtong', { hunger: 2, happy: 2 });
    act(s, 'meal', null, s.lastTick, { rng: always });
    const r = act(s, 'snack', null, s.lastTick);
    assert.equal(r.ok, true);
    assert.equal(r.gaveIn, true);
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(s.pet.missedScolds, 1);
    assert.equal(s.pet.discipline, 0);
    assert.equal(s.pet.happy, 3);
  });

  test('expire: 15 real minutes unanswered', () => {
    const s = make('tongtong', { hunger: 2 });
    act(s, 'meal', null, s.lastTick, { rng: always });
    let ev = live(s, 14);
    assert.equal(s.pet.calls.tantrum, 1);
    assert.equal(count(ev, 'callExpire'), 0);
    ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'callExpire', reason: 'tantrum' }]);
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(s.pet.missedScolds, 1);
    assert.equal(s.pet.careMistakes, 0, 'a missed scolding is not a care mistake');
  });

  test('tantrum grace is real time: it runs out during sleep and away', () => {
    const s = make('tongtong', { now: at(22, 55), hunger: 2, lightsOn: false });
    act(s, 'meal', null, at(22, 55), { rng: always });
    advance(s, at(23, 30));
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(s.pet.missedScolds, 1);
  });

  test('unfair scold: happy −1, never below 0', () => {
    const s = make('tongtong', { happy: 1 });
    let r = act(s, 'scold', null, s.lastTick);
    assert.deepEqual([r.ok, r.reason], [false, 'unfair']);
    assert.equal(s.pet.happy, 0);
    assert.deepEqual(r.events, [{ type: 'heartLoss', meter: 'happy' }, { type: 'callStart', reason: 'happy' }]);
    r = act(s, 'scold', null, s.lastTick);
    assert.equal(r.reason, 'unfair');
    assert.equal(s.pet.happy, 0);
    assert.equal(s.pet.discipline, 0);
  });

  test('a full pet refusing a meal is not a tantrum and does not roll', () => {
    const s = make('tongtong');
    let calls = 0;
    const r = act(s, 'meal', null, s.lastTick, { rng: () => { calls++; return 0; } });
    assert.deepEqual([r.ok, r.reason], [false, 'full']);
    assert.equal(calls, 0);
    assert.equal(s.pet.tantrumCooldown, 0);
    assert.equal(s.pet.calls.tantrum, null);
    assert.equal(act(s, 'scold', null, s.lastTick).reason, 'unfair');
  });

  test('babies and sick pets never throw tantrums; catch-up never starts one', () => {
    const baby = make('mongsil', { hunger: 1 });
    let rolls = 0;
    const rng = () => { rolls++; return 0; };
    assert.equal(act(baby, 'meal', null, baby.lastTick, { rng }).ok, true);
    assert.equal(act(baby, 'playStart', null, baby.lastTick, { rng }).ok, true);
    assert.equal(rolls, 0);

    const s = make('tongtong', { hunger: 2 });
    const ev = advance(s, at(21), { rng: always });
    assert.equal(ev.filter((e) => e.reason === 'tantrum').length, 0);
    assert.equal(s.pet.calls.tantrum, null);
  });

  test('seeded rng: the roll follows the chance for each discipline level', () => {
    let seen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let d = 0; d <= 4; d++) {
        const expected = seeded(seed)() < TANTRUM_CHANCE[d];
        const s = make('kkabul', { hunger: 1, discipline: d });
        const r = act(s, 'meal', null, s.lastTick, { rng: seeded(seed) });
        assert.equal(r.reason === 'tantrum', expected, `seed ${seed} discipline ${d}`);
        assert.equal(r.ok, !expected);
        if (expected) seen++;
      }
    }
    assert.ok(seen > 40 && seen < 140, `tantrums seen: ${seen}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe('evolution', () => {
  // One awake minute short of the stage end, then one live minute.
  function grow(id, patch) {
    const sp = SPECIES[id];
    const min = sp.stageMin ?? SPECIAL_CHECK_MIN;
    const s = make(id, { stageAwakeMin: min - 1, ...patch });
    const ev = live(s, 1);
    return { s, ev };
  }

  test('baby → child: plays vs snacks', () => {
    let r = grow('mongsil', { babyPlays: 2, babySnacks: 2 });
    assert.equal(r.s.pet.species, 'tongtong');
    assert.deepEqual(r.ev.filter((e) => e.type === 'evolve'), [{ type: 'evolve', from: 'mongsil', to: 'tongtong' }]);
    assert.equal(r.s.pet.stage, 'child');
    assert.equal(r.s.pet.stageAwakeMin, 0);
    assert.equal(r.s.pet.weight, 10);
    assert.equal(r.s.pet.hungerTimer, 45);
    assert.equal(r.s.pet.happyTimer, 50);
    assert.equal(r.s.pet.poopTimer, 150);
    assert.equal(r.s.dex.tongtong, r.s.lastTick);

    r = grow('mongsil', { babyPlays: 2, babySnacks: 3 });
    assert.equal(r.s.pet.species, 'mallang');
    r = grow('mongsil', {});
    assert.equal(r.s.pet.species, 'tongtong');
    r = grow('mongsil', { stageAwakeMin: 43 });
    assert.equal(r.s.pet.species, 'mongsil', 'not before 45 minutes');
  });

  test('baby counters come from real play: pettings and finished games vs snacks', () => {
    const s = make('mongsil', { hunger: 2 });
    act(s, 'pet', null, s.lastTick);
    act(s, 'playEnd', { completed: true, won: false }, s.lastTick);
    act(s, 'playEnd', { completed: false, won: false }, s.lastTick);
    assert.equal(s.pet.babyPlays, 2);
    for (let i = 0; i < 3; i++) act(s, 'snack', null, s.lastTick);
    act(s, 'meal', null, s.lastTick);
    assert.equal(s.pet.babySnacks, 3);
    live(s, 45);
    assert.equal(s.pet.species, 'mallang');
    // Counters only move in the baby stage.
    act(s, 'pet', null, s.lastTick);
    act(s, 'snack', null, s.lastTick);
    assert.deepEqual([s.pet.babyPlays, s.pet.babySnacks], [2, 3]);
  });

  test('child → teen: three branches, discipline halves', () => {
    const cases = [
      [{ careMistakes: 0, discipline: 2 }, 'saessak', 1],
      [{ careMistakes: 1, discipline: 3 }, 'saessak', 1],
      [{ careMistakes: 1, discipline: 4 }, 'saessak', 2],
      [{ careMistakes: 0, discipline: 0 }, 'kkabul', 0],
      [{ careMistakes: 1, discipline: 1 }, 'kkabul', 0],
      [{ careMistakes: 2, discipline: 4 }, 'ppittak', 2],
      [{ careMistakes: 2, discipline: 0 }, 'ppittak', 0],
      [{ careMistakes: 4, discipline: 4 }, 'ppittak', 2],
      [{ careMistakes: 9, discipline: 1 }, 'ppittak', 0],
    ];
    for (const from of ['tongtong', 'mallang']) {
      for (const [patch, to, discipline] of cases) {
        const { s, ev } = grow(from, patch);
        assert.equal(s.pet.species, to, JSON.stringify(patch));
        assert.equal(s.pet.stage, 'teen');
        assert.equal(s.pet.discipline, discipline, JSON.stringify(patch));
        assert.equal(s.pet.weight, 20);
        assert.equal(s.pet.careMistakes, patch.careMistakes, 'mistakes carry over');
        assert.deepEqual(ev.filter((e) => e.type === 'evolve'), [{ type: 'evolve', from, to }]);
      }
    }
  });

  test('teen → adult: six branches, discipline unchanged, weight raised to the new base', () => {
    const cases = [
      [{ careMistakes: 0, discipline: 4 }, 'banjjak', 30],
      [{ careMistakes: 2, discipline: 3 }, 'banjjak', 30],
      [{ careMistakes: 2, discipline: 2 }, 'narae', 25],
      [{ careMistakes: 0, discipline: 0 }, 'narae', 25],
      [{ careMistakes: 3, discipline: 4, weight: 30 }, 'podong', 40],
      [{ careMistakes: 5, discipline: 0, weight: 55 }, 'podong', 55],
      [{ careMistakes: 3, discipline: 4, weight: 29 }, 'dokkae', 30],
      [{ careMistakes: 5, discipline: 0 }, 'dokkae', 30],
      [{ careMistakes: 6, discipline: 2, weight: 60 }, 'gureum', 60],
      [{ careMistakes: 6, discipline: 4 }, 'gureum', 30],
      [{ careMistakes: 6, discipline: 1 }, 'dwinggul', 30],
      [{ careMistakes: 20, discipline: 0 }, 'dwinggul', 30],
    ];
    for (const from of ['saessak', 'kkabul', 'ppittak']) {
      for (const [patch, to, weight] of cases) {
        const { s } = grow(from, patch);
        assert.equal(s.pet.species, to, `${from} ${JSON.stringify(patch)}`);
        assert.equal(s.pet.stage, 'adult');
        assert.equal(s.pet.discipline, patch.discipline);
        assert.equal(s.pet.weight, weight, `${from} ${JSON.stringify(patch)}`);
        assert.equal(s.pet.adultAwakeMin, 0);
        assert.equal(s.pet.adultMistakes, 0);
      }
    }
  });

  test('adult → special: 별빛 from 나래, 햇살 from 뒹굴, checked once', () => {
    let r = grow('narae', { bond: 60 });
    assert.equal(r.s.pet.species, 'byeolbit');
    assert.equal(r.s.pet.stage, 'special');
    assert.equal(r.s.pet.stageAwakeMin, 0);
    assert.equal(r.s.pet.adultAwakeMin, 2400);
    assert.deepEqual(r.ev.filter((e) => e.type === 'evolve'), [{ type: 'evolve', from: 'narae', to: 'byeolbit' }]);
    assert.equal(r.s.dex.byeolbit, r.s.lastTick);

    r = grow('narae', { bond: 59 });
    assert.equal(r.s.pet.species, 'narae');
    assert.equal(r.s.pet.specialChecked, true);
    r.s.pet.bond = 200;
    live(r.s, 30);
    assert.equal(r.s.pet.species, 'narae', 'the check runs once');

    r = grow('narae', { bond: 100, adultMistakes: 1 });
    assert.equal(r.s.pet.species, 'narae');
    r = grow('narae', { bond: 100, stageAwakeMin: 2398 });
    assert.equal(r.s.pet.species, 'narae', 'not before 2400 adult minutes');

    r = grow('dwinggul', { discipline: 4 });
    assert.equal(r.s.pet.species, 'haessal');
    assert.equal(r.s.pet.weight, 30);
    r = grow('dwinggul', { discipline: 3 });
    assert.equal(r.s.pet.species, 'dwinggul');
    r = grow('dwinggul', { discipline: 4, adultMistakes: 2 });
    assert.equal(r.s.pet.species, 'dwinggul');

    for (const id of ['banjjak', 'podong', 'dokkae', 'gureum']) {
      r = grow(id, { bond: 999, discipline: 4 });
      assert.equal(r.s.pet.species, id);
    }
  });

  test('evolution waits while sick, then happens once cured', () => {
    const s = make('tongtong', { stageAwakeMin: 899, sick: { cause: 'dirty', doses: 2, awakeMin: 0, mistakes: 0 } });
    live(s, 10);
    assert.equal(s.pet.species, 'tongtong');
    act(s, 'medicine', null, s.lastTick);
    act(s, 'medicine', null, s.lastTick);
    const ev = live(s, 1);
    assert.equal(count(ev, 'evolve'), 1);
    assert.equal(s.pet.stage, 'teen');

    const n = make('narae', { stageAwakeMin: 2399, bond: 60, sick: { cause: 'dirty', doses: 1, awakeMin: 0, mistakes: 0 } });
    live(n, 10);
    assert.equal(n.pet.species, 'narae');
    assert.equal(n.pet.specialChecked, false);
    act(n, 'medicine', null, n.lastTick);
    live(n, 1);
    assert.equal(n.pet.species, 'byeolbit');
  });

  test('evolution waits while asleep', () => {
    const s = make('tongtong', { now: at(22, 59), stageAwakeMin: 899, lightsOn: false });
    let ev = advance(s, at(7, 59, 1), { live: true });
    assert.equal(count(ev, 'evolve'), 0);
    assert.equal(s.pet.species, 'tongtong');
    ev = advance(s, at(8, 0, 1), { live: true });
    assert.deepEqual(types(ev), ['wake', 'evolve']);
    assert.equal(s.pet.stage, 'teen');
  });

  test('the 도감 keeps the first-seen time of every species ever owned', () => {
    const s = newGame(BASE);
    advance(s, BASE + MIN);
    advance(s, BASE + 46 * MIN, { live: true });
    assert.deepEqual(Object.keys(s.dex), ['mongsil', 'tongtong']);
    assert.equal(s.dex.mongsil, BASE + MIN);
    assert.equal(s.dex.tongtong, BASE + 46 * MIN);
    // A later pet of the same species does not overwrite the stamp.
    const again = make('mongsil', { now: BASE + DAY, stageAwakeMin: 44 });
    again.dex = { ...s.dex };
    live(again, 1);
    assert.equal(again.dex.tongtong, BASE + 46 * MIN);
  });

  test('a whole childhood, cared for well, becomes 새싹', () => {
    const s = make('tongtong', { now: at(8, 30) });
    let t = at(8, 30);
    const rng = seeded(7);
    while (s.pet.stage === 'child' && t < at(8, 30, 5)) {
      t += 30 * MIN;
      advance(s, t, { live: true });
      if (s.pet.asleep) { act(s, 'light', { on: false }, t); continue; }
      while (s.pet.hunger < 4) {
        const r = act(s, 'meal', null, t, { rng });
        if (r.reason === 'tantrum') act(s, 'scold', null, t);
        else if (!r.ok) break;
      }
      while (s.pet.happy < 4 && act(s, 'snack', null, t).ok && s.pet.snackLog.length < 2) { /* top up */ }
      if (s.pet.poop.length) act(s, 'clean', null, t);
      if (s.pet.sick) act(s, 'medicine', null, t);
    }
    assert.equal(s.pet.stage, 'teen');
    assert.equal(s.pet.careMistakes, 0);
    assert.ok(['saessak', 'kkabul'].includes(s.pet.species));
    assert.equal(s.pet.species, s.pet.discipline >= 1 ? 'saessak' : 'kkabul');
  });
});

// ---------------------------------------------------------------------------------------------

describe('meters, weight, bond', () => {
  test('meal and snack: effects and weight clamp at 99', () => {
    const s = make('tongtong', { hunger: 1, happy: 1 });
    assert.equal(act(s, 'meal', null, s.lastTick, { rng: never }).ok, true);
    assert.deepEqual([s.pet.hunger, s.pet.weight], [2, 11]);
    assert.equal(act(s, 'snack', null, s.lastTick).ok, true);
    assert.deepEqual([s.pet.happy, s.pet.weight], [2, 13]);

    const heavy = make('tongtong', { hunger: 0, happy: 0, weight: 98 });
    act(heavy, 'snack', null, heavy.lastTick);
    assert.equal(heavy.pet.weight, 99);
    act(heavy, 'meal', null, heavy.lastTick, { rng: never });
    assert.equal(heavy.pet.weight, 99);
    assert.equal(view(heavy, heavy.lastTick).weight, 99);

    const full = make('tongtong');
    act(full, 'snack', null, full.lastTick);
    assert.equal(full.pet.happy, 4, 'meters never go above 4');
  });

  test('games: weight never below the species base; quitting has no effect', () => {
    const s = make('tongtong', { weight: 12, happy: 2 });
    assert.equal(act(s, 'playStart', null, s.lastTick, { rng: never }).ok, true);
    let r = act(s, 'playEnd', { completed: true, won: true }, s.lastTick);
    assert.deepEqual([r.ok, r.completed, r.won], [true, true, true]);
    assert.deepEqual([s.pet.weight, s.pet.happy, s.pet.bond], [11, 3, 2]);
    act(s, 'playEnd', { completed: true, won: false }, s.lastTick);
    assert.deepEqual([s.pet.weight, s.pet.happy, s.pet.bond], [10, 3, 3]);
    act(s, 'playEnd', { completed: true, won: false }, s.lastTick);
    assert.equal(s.pet.weight, 10, 'clamped at baseWeight');
    r = act(s, 'playEnd', { completed: false, won: true }, s.lastTick);
    assert.deepEqual([r.completed, r.won], [false, false]);
    assert.deepEqual([s.pet.weight, s.pet.happy, s.pet.bond], [10, 3, 4]);
    r = act(s, 'playEnd', null, s.lastTick);
    assert.equal(r.ok, true);
    assert.deepEqual([s.pet.weight, s.pet.happy, s.pet.bond], [10, 3, 4]);

    const adult = make('podong', { weight: 40 });
    act(adult, 'playEnd', { completed: true, won: true }, adult.lastTick);
    assert.equal(adult.pet.weight, 40);
  });

  test('petting: 5 effective per rolling real hour, refused asleep', () => {
    const s = make('tongtong', { now: at(12) });
    for (let i = 0; i < 5; i++) {
      const r = act(s, 'pet', null, at(12, i));
      assert.deepEqual([r.ok, r.effective], [true, true]);
    }
    assert.equal(s.pet.bond, 5);
    let r = act(s, 'pet', null, at(12, 30));
    assert.deepEqual([r.ok, r.effective, r.reason], [true, false, 'tired']);
    assert.equal(s.pet.bond, 5);
    r = act(s, 'pet', null, at(12, 59));
    assert.equal(r.effective, false);
    r = act(s, 'pet', null, at(13, 0));          // the 12:00 petting has left the window
    assert.equal(r.effective, true);
    assert.equal(s.pet.bond, 6);
    r = act(s, 'pet', null, at(13, 0));
    assert.equal(r.effective, false);

    const night = make('tongtong', { now: at(1), asleep: true, lightsOn: false });
    r = act(night, 'pet', null, at(1));
    assert.deepEqual([r.ok, r.reason], [false, 'asleep']);
    assert.equal(night.pet.bond, 0);
  });

  test('bond stars: floor(bond / 12), at most 5', () => {
    const stars = (bond) => view(make('narae', { bond }), at(9)).bondStars;
    assert.deepEqual([0, 11, 12, 35, 36, 59, 60, 5000].map(stars), [0, 0, 1, 2, 3, 4, 5, 5]);
  });

  test('name: trimmed, at most 6 characters, empty keeps the old one', () => {
    const s = make('tongtong');
    assert.equal(act(s, 'name', { name: '  콩이  ' }, s.lastTick).name, '콩이');
    assert.equal(s.pet.name, '콩이');
    assert.equal(act(s, 'name', { name: '가나다라마바사아' }, s.lastTick).name, '가나다라마바');
    assert.equal(act(s, 'name', { name: '   ' }, s.lastTick).name, '가나다라마바');
    assert.equal(act(s, 'name', { name: '' }, s.lastTick).ok, true);
    assert.equal(act(s, 'name', null, s.lastTick).name, '가나다라마바');
    assert.equal(act(s, 'name', { name: 12345 }, s.lastTick).name, '가나다라마바');
    // Decomposed Hangul (as macOS file names and some keyboards produce) counts per syllable.
    assert.equal(act(s, 'name', { name: '몽실이'.normalize('NFD') }, s.lastTick).name, '몽실이');
    assert.equal(act(s, 'name', { name: 'a\nb\tc' }, s.lastTick).name, 'a b c');
    assert.equal(view(s, s.lastTick).name, 'a b c');
  });

  test('view: the summary the UI reads', () => {
    const s = make('tongtong', { now: at(12), hunger: 3, happy: 3, bond: 25, discipline: 2, ageDays: 3, weight: 14 });
    assert.deepEqual(view(s, at(12)), {
      stage: 'child', species: 'tongtong', name: DEFAULT_NAME, gen: 1, alive: true, paused: false, mode: 'gentle',
      asleep: false, lightsOn: true, sick: false, dosesLeft: 0, poop: 0,
      hunger: 3, happy: 3, discipline: 2, weight: 14, ageDays: 3, bondStars: 2,
      calling: false, callReasons: [], tantrum: false,
      departReady: false, leftEgg: false, endCause: null, mood: 'happy',
    });
    const before = clone(s);
    view(s, at(12));
    assert.deepEqual(s, before, 'view never mutates');
    s.pet.poop = [3];
    assert.equal(view(s, at(12)).mood, 'ok', 'a mess spoils the happy mood');
    s.pet.poop = [];
    s.pet.hunger = 2;
    assert.equal(view(s, at(12)).mood, 'ok');
    s.pet.hunger = 0;
    assert.equal(view(s, at(12)).mood, 'sad');
    assert.equal(view(newGame(BASE), BASE).mood, 'ok');
    assert.equal(view(newGame(BASE), BASE).species, 'egg');
  });
});

// ---------------------------------------------------------------------------------------------

describe('growing up and leaving (gentle)', () => {
  test('mature → depart → album entry → new egg', () => {
    const s = make('narae', { now: at(9), stageAwakeMin: MATURE_MIN - 2, specialChecked: true, ageDays: 9, name: '보리' });
    s.dex.mongsil = 1;
    assert.equal(act(s, 'depart', null, at(9)).reason, 'notReady');
    let ev = live(s, 1);
    assert.equal(count(ev, 'mature'), 0);
    assert.equal(view(s, s.lastTick).departReady, false);
    ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'mature' }]);
    assert.equal(view(s, s.lastTick).departReady, true);
    ev = live(s, 120);
    assert.equal(count(ev, 'mature'), 0, 'announced once');
    assert.equal(s.pet.alive, true, 'the owner may keep the pet as long as they like');

    const t = s.lastTick;
    const r = act(s, 'depart', null, t);
    assert.equal(r.ok, true);
    const entry = {
      name: '보리', species: 'narae', gen: 1, ageDays: 9, bornAt: at(9), endedAt: t,
      end: 'journey', mode: 'gentle', careGrade: 'A',
    };
    assert.deepEqual(r.entry, entry);
    assert.deepEqual(s.album, [entry]);
    assert.equal(s.pet.stage, 'egg');
    assert.equal(s.pet.gen, 2);
    assert.equal(s.pet.name, DEFAULT_NAME);
    assert.equal(s.pet.departReady, false);
    assert.deepEqual(Object.keys(s.dex).sort(), ['mongsil', 'narae']);
    assert.equal(act(s, 'depart', null, t).reason, 'notReady');
    // The new egg lives on.
    advance(s, t + MIN, { live: true });
    assert.equal(s.pet.stage, 'baby');
  });

  test('a special matures 1440 awake minutes after becoming special', () => {
    const s = make('byeolbit', { stageAwakeMin: SPECIAL_MATURE_MIN - 2, adultAwakeMin: 3838 });
    assert.equal(count(live(s, 1), 'mature'), 0);
    assert.equal(count(live(s, 1), 'mature'), 1);
    assert.equal(s.pet.departReady, true);
    const r = act(s, 'depart', null, s.lastTick);
    assert.equal(r.entry.species, 'byeolbit');
  });

  test('care grade: A, B, C', () => {
    const grade = (careMistakes, adultMistakes) => {
      const s = make('dokkae', { stageAwakeMin: MATURE_MIN, careMistakes, adultMistakes, specialChecked: true });
      live(s, 1);
      return act(s, 'depart', null, s.lastTick).entry.careGrade;
    };
    assert.equal(grade(0, 0), 'A');
    assert.equal(grade(2, 0), 'A');
    assert.equal(grade(3, 0), 'B');
    assert.equal(grade(0, 1), 'B');
    assert.equal(grade(5, 3), 'B');
    assert.equal(grade(6, 0), 'C');
    assert.equal(grade(0, 4), 'C');
  });

  test('gentle: the setups that end a pet in classic end nobody here', () => {
    const cases = [
      make('dwinggul', { stageAwakeMin: 4999, adultAwakeMin: 4999, specialChecked: true }),
      make('banjjak', { adultMistakes: 4, hunger: 0, calls: { hunger: 1, happy: null, lights: null, tantrum: null } }),
      make('tongtong', { hunger: 0, calls: { hunger: 0, happy: null, lights: null, tantrum: null }, zeroHungerMin: 719 }),
      make('tongtong', { sick: { cause: 'dirty', doses: 2, awakeMin: 479, mistakes: 2 } }),
    ];
    for (const s of cases) {
      const ev = live(s, 600);
      assert.equal(count(ev, 'death'), 0);
      assert.equal(s.pet.alive, true);
      assert.deepEqual(s.album, []);
      assert.equal(act(s, 'newEgg', null, s.lastTick).reason, 'alive');
    }
    // No old-age speed-up and no old-age sickness either.
    const old = make('dwinggul', { now: at(7, 59), asleep: true, lightsOn: false, stageAwakeMin: 4000, adultAwakeMin: 4000, specialChecked: true });
    const ev = live(old, 5);
    assert.equal(count(ev, 'sick'), 0);
    assert.equal(old.pet.hungerMul, 1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('classic endings', () => {
  test('old age: the pet becomes a star and may leave an egg', () => {
    const s = make('dwinggul', { mode: 'classic', stageAwakeMin: 4999, adultAwakeMin: 4999, oldAgeSick: 2, specialChecked: true, ageDays: 8, name: '두부' });
    const ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'death', cause: 'oldage' }]);
    const t = s.lastTick;
    assert.equal(s.pet.alive, false);
    assert.equal(s.pet.endCause, 'oldage');
    assert.equal(s.pet.leftEgg, true);
    assert.deepEqual(s.album, [{
      name: '두부', species: 'dwinggul', gen: 1, ageDays: 8, bornAt: at(9), endedAt: t,
      end: 'star', cause: 'oldage', mode: 'classic', careGrade: 'A', leftEgg: true,
    }]);
    const v = view(s, t);
    assert.deepEqual([v.alive, v.endCause, v.leftEgg, v.calling, v.departReady], [false, 'oldage', true, false, false]);

    // Nothing else happens until newEgg.
    const frozen = clone(s.pet);
    assert.deepEqual(advance(s, t + 3 * DAY), []);
    assert.deepEqual(s.pet, frozen);
    assert.equal(s.lastTick, t + 3 * DAY);
    for (const a of ['meal', 'snack', 'playStart', 'playEnd', 'clean', 'medicine', 'scold', 'light', 'pet', 'tapEgg', 'depart']) {
      assert.equal(act(s, a, null, s.lastTick).reason, 'dead', a);
    }
    assert.deepEqual(s.pet, frozen);

    const r = act(s, 'newEgg', null, s.lastTick);
    assert.equal(r.ok, true);
    assert.equal(s.pet.stage, 'egg');
    assert.equal(s.pet.alive, true);
    assert.equal(s.pet.gen, 2, 'the egg it left continues the family');
    assert.equal(s.album.length, 1);
  });

  test('old age without an egg: more than 2 adult mistakes', () => {
    const s = make('dwinggul', { mode: 'classic', stageAwakeMin: 4999, adultAwakeMin: 4999, oldAgeSick: 2, specialChecked: true, adultMistakes: 3, gen: 4 });
    live(s, 1);
    assert.equal(s.pet.endCause, 'oldage');
    assert.equal(s.pet.leftEgg, false);
    assert.equal(s.album[0].careGrade, 'B');
    act(s, 'newEgg', null, s.lastTick);
    assert.equal(s.pet.gen, 1, 'no egg left: a new family starts');
  });

  test('a special counts its lifespan from becoming an adult', () => {
    const s = make('byeolbit', { mode: 'classic', stageAwakeMin: 11599, adultAwakeMin: 13999, oldAgeSick: 2 });
    assert.deepEqual(live(s, 1), [{ type: 'death', cause: 'oldage' }]);
  });

  test('neglect: the fifth adult care mistake', () => {
    const s = make('banjjak', { mode: 'classic', adultMistakes: 4, hunger: 0, calls: { hunger: 1, happy: null, lights: null, tantrum: null } });
    const ev = live(s, 1);
    assert.deepEqual(types(ev), ['callExpire', 'careMistake', 'death']);
    assert.equal(s.pet.endCause, 'neglect');
    assert.equal(s.pet.leftEgg, false);
    assert.equal(s.album[0].cause, 'neglect');
    assert.equal(s.album[0].careGrade, 'C');

    // The fifth mistake can also be the bedtime light.
    const n = make('banjjak', { mode: 'classic', now: at(22, 59), adultMistakes: 4 });
    const ev2 = live(n, 16);
    assert.deepEqual(types(ev2), ['sleep', 'callStart', 'callExpire', 'careMistake', 'death']);
    assert.equal(n.pet.endCause, 'neglect');

    // Children and teens do not die of mistakes.
    const kid = make('tongtong', { mode: 'classic', careMistakes: 9, hunger: 0, calls: { hunger: 1, happy: null, lights: null, tantrum: null } });
    live(kid, 5);
    assert.equal(kid.pet.alive, true);
    assert.equal(kid.pet.careMistakes, 10);
  });

  test('starvation: hunger at 0 for 720 awake minutes', () => {
    const s = make('tongtong', { mode: 'classic', hunger: 0, calls: { hunger: 0, happy: null, lights: null, tantrum: null }, zeroHungerMin: 718 });
    assert.equal(count(live(s, 1), 'death'), 0);
    assert.deepEqual(live(s, 1), [{ type: 'death', cause: 'starve' }]);
    assert.equal(s.pet.endCause, 'starve');
    assert.equal(s.pet.leftEgg, false);

    // Counted from an empty meter, on awake minutes, and reset by a meal.
    const c = make('saessak', { mode: 'classic', now: at(9), hunger: 1, hungerTimer: 1 });
    live(c, 400);
    assert.equal(c.pet.zeroHungerMin, 400);
    c.pet.sick = null;   // the mess of 400 unattended minutes made it sick; that is another test
    c.pet.poop = [];
    assert.equal(act(c, 'meal', null, c.lastTick, { rng: never }).ok, true);
    assert.equal(c.pet.zeroHungerMin, 0);
    live(c, 1);
    assert.equal(c.pet.zeroHungerMin, 0);
  });

  test('untreated sickness: 480 awake minutes; the baby cannot die', () => {
    const s = make('tongtong', { mode: 'classic', sick: { cause: 'dirty', doses: 2, awakeMin: 478, mistakes: 0 } });
    assert.equal(count(live(s, 1), 'death'), 0);
    assert.deepEqual(live(s, 1), [{ type: 'death', cause: 'sick' }]);
    assert.equal(s.album[0].cause, 'sick');
    assert.equal(s.pet.careMistakes, 0, 'classic sickness costs no care mistakes on the way');

    const baby = make('mongsil', { mode: 'classic', hunger: 0, sick: { cause: 'dirty', doses: 2, awakeMin: 470, mistakes: 0 } });
    const ev = advance(baby, at(9, 0, 3));
    assert.equal(count(ev, 'death'), 0);
    assert.equal(baby.pet.alive, true);
    assert.equal(baby.pet.stage, 'baby', 'and it does not grow up while sick');
  });

  test('old age: decay speeds up at every wake-up and brings two sicknesses', () => {
    const s = make('banjjak', { mode: 'classic', now: at(7, 59), asleep: true, lightsOn: false, stageAwakeMin: 7198, adultAwakeMin: 7198, specialChecked: true });
    let ev = live(s, 1);
    assert.deepEqual(types(ev), ['wake'], 'one minute short of 60%: an ordinary morning');
    assert.equal(s.pet.hungerMul, 1);
    ev = live(s, 1);
    assert.deepEqual(ev, [{ type: 'sick', cause: 'age' }]);
    assert.equal(s.pet.oldAgeSick, 1);
    assert.equal(act(s, 'medicine', null, s.lastTick).cured, true);
    assert.equal(count(live(s, 60), 'sick'), 0, 'only one sickness at 60%');

    // Every morning past 60%: both intervals shrink by 0.85.
    const m = make('banjjak', { mode: 'classic', now: at(7, 59), asleep: true, lightsOn: false, stageAwakeMin: 8000, adultAwakeMin: 8000, oldAgeSick: 1, specialChecked: true });
    live(m, 1);
    assert.ok(Math.abs(m.pet.hungerMul - 0.85) < 1e-9);
    assert.ok(Math.abs(m.pet.happyMul - 0.85) < 1e-9);
    assert.ok(m.pet.hungerTimer <= 77 && m.pet.happyTimer <= 81);
    assert.equal(m.pet.ageDays, 1);
    // The same pet one night later.
    Object.assign(m.pet, { asleep: true, lightsOn: false });
    m.lastTick = at(7, 59, 1);
    live(m, 1);
    assert.ok(Math.abs(m.pet.hungerMul - 0.85 * 0.85) < 1e-9);
    assert.equal(m.pet.ageDays, 2);

    // Second sickness at 85%.
    const late = make('banjjak', { mode: 'classic', stageAwakeMin: 10198, adultAwakeMin: 10198, oldAgeSick: 1, specialChecked: true });
    assert.equal(count(live(late, 1), 'sick'), 0);
    assert.deepEqual(live(late, 1), [{ type: 'sick', cause: 'age' }]);
    assert.equal(late.pet.oldAgeSick, 2);
    act(late, 'medicine', null, late.lastTick);
    late.pet.poop = [];
    assert.equal(count(live(late, 30), 'sick'), 0);

    // The interval never drops below 10 minutes.
    const ancient = make('banjjak', { mode: 'classic', hungerMul: 0.02, happyMul: 0.02, hungerTimer: 1, happyTimer: 1, oldAgeSick: 2, specialChecked: true });
    live(ancient, 1);
    assert.equal(ancient.pet.hungerTimer, 10);
    assert.equal(ancient.pet.happyTimer, 10);
  });

  test('classic has no departure', () => {
    const s = make('narae', { mode: 'classic', stageAwakeMin: MATURE_MIN + 50, adultAwakeMin: MATURE_MIN + 50, specialChecked: true });
    const ev = live(s, 5);
    assert.equal(count(ev, 'mature'), 0);
    assert.equal(view(s, s.lastTick).departReady, false);
    assert.equal(act(s, 'depart', null, s.lastTick).reason, 'notReady');
  });
});

// ---------------------------------------------------------------------------------------------

describe('switching rules', () => {
  test('classic → gentle recomputes departReady at once', () => {
    const s = make('narae', { mode: 'classic', stageAwakeMin: MATURE_MIN + 50, adultAwakeMin: MATURE_MIN + 50, specialChecked: true });
    live(s, 1);
    const r = act(s, 'setMode', { mode: 'gentle' }, s.lastTick);
    assert.equal(r.ok, true);
    assert.deepEqual(r.events, [{ type: 'mature' }]);
    assert.equal(s.rulesMode, 'gentle');
    assert.equal(view(s, s.lastTick).mode, 'gentle');
    assert.equal(s.pet.departReady, true);
    assert.equal(act(s, 'depart', null, s.lastTick).ok, true);
  });

  test('gentle → classic takes effect at once: no departure, short grace', () => {
    const s = make('narae', { stageAwakeMin: MATURE_MIN, specialChecked: true, hunger: 0, calls: { hunger: 250, happy: null, lights: null, tantrum: null } });
    live(s, 1);
    assert.equal(s.pet.departReady, true);
    const r = act(s, 'setMode', { mode: 'classic' }, s.lastTick);
    assert.equal(r.ok, true);
    assert.equal(s.pet.departReady, false);
    assert.equal(s.pet.calls.hunger, 180);
    live(s, 180);
    assert.equal(s.pet.adultMistakes, 1);
    // And back: the remaining grace is stretched again, the old mistake stays.
    s.pet.happy = 0;
    s.pet.calls.happy = 5;
    act(s, 'setMode', { mode: 'gentle' }, s.lastTick);
    assert.equal(s.pet.calls.happy, 125);
    assert.equal(s.pet.adultMistakes, 1);
    assert.equal(s.pet.departReady, true);
  });

  test('switching to classic does not end the pet on the spot for time already served', () => {
    const s = make('tongtong', { hunger: 0, calls: { hunger: 0, happy: null, lights: null, tantrum: null },
      sick: { cause: 'dirty', doses: 2, awakeMin: 900, mistakes: 2 } });
    live(s, 800);
    assert.equal(s.pet.zeroHungerMin, 0, 'gentle never counts towards starvation');
    act(s, 'setMode', { mode: 'classic' }, s.lastTick);
    assert.equal(count(live(s, 5), 'death'), 0);
    assert.equal(s.pet.alive, true);
    assert.equal(s.pet.sick.awakeMin, 5);
  });

  test('switching to classic does not end a long-kept gentle adult of old age', () => {
    // Kept "as long as they like" in 순한맛, far past the 매운맛 lifespan, in perfect health.
    const cases = [
      ['dwinggul', { stageAwakeMin: 5100 }],
      ['gureum', { stageAwakeMin: 6100 }],
      ['banjjak', { stageAwakeMin: 12100 }],
      ['byeolbit', { stageAwakeMin: 12000, adultAwakeMin: 15000 }],
    ];
    for (const [id, patch] of cases) {
      const s = make(id, { ...patch, specialChecked: true });
      live(s, 1);
      assert.equal(s.pet.departReady, true, id);
      assert.equal(act(s, 'setMode', { mode: 'classic' }, s.lastTick).ok, true);
      const cap = Math.floor(0.6 * SPECIES[id].lifespanMin) - 1;
      assert.deepEqual([s.pet.adultAwakeMin, s.pet.stageAwakeMin], [cap, cap], id);
      const ev = live(s, 5);
      assert.equal(count(ev, 'death'), 0, id);
      assert.equal(s.pet.alive, true, id);
      // It re-enters classic on the doorstep of old age: the first old-age sickness, not the end.
      assert.deepEqual(ev.filter((e) => e.type === 'sick'), [{ type: 'sick', cause: 'age' }], id);
      assert.equal(s.pet.adultAwakeMin, cap + 5, id);
      // And it can still leave on its journey if the owner switches back.
      act(s, 'setMode', { mode: 'gentle' }, s.lastTick);
      assert.equal(s.pet.departReady, true, id);
    }

    // A pet that is not past the mark keeps its age, and so does everything before adulthood.
    const young = make('narae', { stageAwakeMin: 3000, specialChecked: true });
    live(young, 1);
    act(young, 'setMode', { mode: 'classic' }, young.lastTick);
    assert.deepEqual([young.pet.adultAwakeMin, young.pet.stageAwakeMin], [3001, 3001]);
    const teen = make('kkabul', { stageAwakeMin: 1300 });
    act(teen, 'setMode', { mode: 'classic' }, teen.lastTick);
    assert.equal(teen.pet.stageAwakeMin, 1300);

    // Care mistakes are not forgiven: the confirm sheet warns about exactly this.
    const careless = make('podong', { stageAwakeMin: 3000, adultMistakes: 7, specialChecked: true });
    act(careless, 'setMode', { mode: 'classic' }, careless.lastTick);
    assert.deepEqual(live(careless, 1).filter((e) => e.type === 'death'), [{ type: 'death', cause: 'neglect' }]);
  });

  test('invalid modes are refused', () => {
    const s = make('tongtong');
    assert.equal(act(s, 'setMode', { mode: 'hard' }, s.lastTick).reason, 'invalid');
    assert.equal(act(s, 'setMode', null, s.lastTick).reason, 'invalid');
    assert.equal(act(s, 'setMode', { mode: 'gentle' }, s.lastTick).ok, true);
    assert.equal(s.rulesMode, 'gentle');
  });
});

// ---------------------------------------------------------------------------------------------

describe('whole lives', () => {
  // A player who opens the app at fixed local hours and does the same things every time.
  // `honest`: cure, clean, meals to full, two games, snacks to top up, five pettings.
  // Otherwise: medicine, cleaning and petting only. Nobody is there at bedtime, so the light
  // is never switched off by hand: a closed app is not charged for it in either mode.
  function raise({ mode = 'gentle', hours, days = 9, seed = 1, honest = true }) {
    const rng = seeded(seed);
    const stamp = (d, h) => at(0, Math.round(h * 60), d);
    let now = stamp(0, hours[0]);
    const s = newGame(now, { rulesMode: mode });
    for (let i = 0; i < 5; i++) act(s, 'tapEgg', null, now, { rng });
    const out = { s, visits: 0, sickArrivals: 0, adult: null, mistakesAtAdult: null, path: ['mongsil'] };
    const visit = (t) => {
      now = t;
      for (const e of advance(s, now)) if (e.type === 'evolve') out.path.push(e.to);
      const pet = s.pet;
      if (!pet.alive) return;
      if (pet.stage !== 'baby') { out.visits++; if (pet.sick) out.sickArrivals++; }
      for (let g = 0; s.pet.sick && g < 10; g++) act(s, 'medicine', null, now, { rng });
      act(s, 'clean', null, now, { rng });
      if (honest) {
        for (let g = 0; pet.hunger < 4 && g < 12; g++) {
          const r = act(s, 'meal', null, now, { rng });
          if (r.reason === 'tantrum') act(s, 'scold', null, now, { rng });
          else if (!r.ok) break;
        }
        for (let k = 0, g = 0; k < 2 && g < 6; g++) {
          const r = act(s, 'playStart', null, now, { rng });
          if (r.reason === 'tantrum') { act(s, 'scold', null, now, { rng }); continue; }
          if (!r.ok) break;
          now += 45000;
          act(s, 'playEnd', { completed: true, won: rng() < 0.6 }, now, { rng });
          k++;
        }
        for (let g = 0; pet.happy < 4 && g < 3; g++) act(s, 'snack', null, now, { rng });
      }
      for (let i = 0; i < 5; i++) act(s, 'pet', null, now, { rng });
    };
    for (let d = 0; d < days && s.pet.alive; d++) {
      hours.forEach((h) => {
        const t = stamp(d, h);
        if (t > now && s.pet.alive) visit(t);
      });
      if (!out.adult && (s.pet.stage === 'adult' || s.pet.stage === 'special')) {
        out.adult = s.pet.species;
        out.mistakesAtAdult = s.pet.careMistakes;
      }
    }
    return out;
  }

  test('순한맛: three honest check-ins a day raise a good adult and rarely find it sick', () => {
    // The second pattern is morning / lunch / after work: a 7.5 hour evening gap, which is
    // what GRACE.gentle and DIRTY_SICK_MIN.gentle are sized for (SPEC 5.3, 5.4).
    for (const hours of [[8.5, 13, 18.5], [8, 12.5, 20]]) {
      let visits = 0;
      let sick = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const r = raise({ hours, seed });
        assert.ok(['narae', 'banjjak'].includes(r.adult), `${hours} seed ${seed}: ${r.path.join(' > ')}`);
        assert.ok(r.mistakesAtAdult <= 2, `${hours} seed ${seed}: ${r.mistakesAtAdult} mistakes`);
        visits += r.visits;
        sick += r.sickArrivals;
      }
      // With the dirty limit at the classic 180 the pet was sick at about three visits in four.
      assert.ok(sick / visits < 0.3, `${hours}: sick on arrival at ${sick} of ${visits} visits`);
    }
  });

  test('순한맛: a pet that is never fed or played with cannot grow into a good adult', () => {
    for (const hours of [[8.5, 13, 18.5], [8, 12.5, 20]]) {
      const r = raise({ hours, honest: false });
      const pet = r.s.pet;
      // Two child mistakes (one per empty meter), six more as a teen: 삐딱, then the low tier.
      assert.deepEqual(r.path, ['mongsil', 'tongtong', 'ppittak', 'dwinggul'], String(hours));
      assert.deepEqual([pet.hunger, pet.happy], [0, 0]);
      assert.ok(r.mistakesAtAdult > 5, `pre-adult mistakes: ${r.mistakesAtAdult}`);
      assert.ok(pet.adultMistakes > 3, `adult mistakes: ${pet.adultMistakes}`);
      assert.equal(pet.departReady, true);
      assert.equal(act(r.s, 'depart', null, r.s.lastTick).entry.careGrade, 'C');
    }
  });

  test('매운맛: four check-ins a day are not the end of the pet, even or uneven', () => {
    // The second pattern has a 5.5 hour afternoon gap: what GRACE.classic is sized for.
    for (const hours of [[8, 12, 16, 20], [8.5, 13, 18.5, 22]]) {
      for (let seed = 1; seed <= 12; seed++) {
        const r = raise({ mode: 'classic', hours, seed });
        const pet = r.s.pet;
        assert.ok(r.adult, `${hours} seed ${seed}: grew up (${r.path.join(' > ')})`);
        // Nine days is past the shortest lifespan, so old age is a fair end; neglect is not.
        assert.ok(pet.alive || pet.endCause === 'oldage', `${hours} seed ${seed}: ${pet.endCause}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('determinism', () => {
  // A fixed script of a day and a half of play.
  function script(mode, seed) {
    const s = newGame(at(9), { rulesMode: mode });
    const rng = seeded(seed);
    const log = [];
    const order = ['tapEgg', 'meal', 'snack', 'pet', 'playStart', 'playEnd', 'clean', 'scold', 'medicine', 'light', 'meal'];
    let t = at(9);
    for (let i = 0; i < 400; i++) {
      t += (1 + (i * 7) % 23) * MIN + (i * 977) % 60000;
      const a = order[i % order.length];
      const payload = a === 'playEnd' ? { completed: i % 3 !== 0, won: i % 2 === 0 } : a === 'light' ? { on: i % 4 === 0 } : null;
      const r = act(s, a, payload, t, { rng });
      log.push([a, r.ok, r.reason ?? null, types(r.events).join(',')]);
    }
    return { s, log };
  }

  test('same inputs → same state and same results', () => {
    for (const mode of ['gentle', 'classic']) {
      const a = script(mode, 11);
      const b = script(mode, 11);
      assert.deepEqual(a.s, b.s);
      assert.deepEqual(a.log, b.log);
      assert.deepEqual(clone(a.s), a.s, 'still plain JSON after a long session');
      const c = script(mode, 12);
      assert.notDeepEqual(a.log, c.log, 'a different seed plays out differently');
    }
  });

  test('one long advance equals the same time in small steps', () => {
    for (const [mode, id] of [['classic', 'tongtong'], ['classic', 'banjjak'], ['gentle', 'kkabul']]) {
      const big = make(id, { mode, now: at(9) });
      const small = make(id, { mode, now: at(9) });
      const end = at(9) + 1700 * MIN + 12345;
      const evBig = advance(big, end, { live: true });
      const evSmall = [];
      for (let t = at(9) + 7 * MIN; t < end; t += 7 * MIN) evSmall.push(...advance(small, t, { live: true }));
      evSmall.push(...advance(small, end, { live: true }));
      assert.deepEqual(small, big, `${mode} ${id}`);
      assert.deepEqual(evSmall, evBig, `${mode} ${id}`);
    }
  });

  test('advance never calls the rng', () => {
    const s = make('tongtong', { mode: 'classic' });
    advance(s, at(9, 0, 3), { rng: () => { throw new Error('rng used in advance'); } });
    assert.equal(s.pet.alive, false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('hostile input', () => {
  test('unknown actions are refused, including prototype names', () => {
    const s = make('tongtong');
    const before = clone(s);
    for (const a of ['fly', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 42, null, undefined, {}, ['meal']]) {
      const r = act(s, a, null, s.lastTick);
      assert.deepEqual(r, { ok: false, reason: 'unknown', events: [] }, String(a));
    }
    assert.deepEqual(s, before);
  });

  test('corrupt numbers are clamped or replaced, never trusted', () => {
    const s = make('tongtong', { now: at(12) });
    Object.assign(s.pet, {
      hunger: 99, happy: -5, weight: NaN, discipline: '3', bond: -1, ageDays: Infinity,
      hungerTimer: 1e9, happyTimer: -3, hungerMul: 0, happyMul: 'fast',
      poop: 'x', snackLog: [1, 'a', null, 2], petLog: { length: 3 }, calls: null, sick: 'yes',
      careMistakes: -2, adultMistakes: 1.6, eggTaps: 77, tantrumCooldown: 5000,
      stageAwakeMin: -10, totalAwakeMin: 'many', gen: 0, name: '', lightsOn: 'no', alive: 1,
    });
    s.album = 5;
    s.dex = null;
    assert.doesNotThrow(() => advance(s, at(12, 1), { live: true }));
    const p = s.pet;
    assert.equal(p.hunger, 4);
    assert.equal(p.happy, 0);
    assert.equal(p.weight, 10);
    assert.equal(p.discipline, 0);
    assert.equal(p.bond, 0);
    assert.equal(p.ageDays, 0);
    assert.ok(p.hungerTimer >= 1 && p.hungerTimer <= 45);
    assert.ok(p.happyTimer >= 1 && p.happyTimer <= 50);
    assert.equal(p.hungerMul, 1);
    assert.equal(p.happyMul, 1);
    assert.deepEqual(p.poop, []);
    assert.deepEqual(p.snackLog, [1, 2]);
    assert.deepEqual(p.petLog, []);
    assert.deepEqual(p.calls, { hunger: null, happy: GRACE.gentle, lights: null, tantrum: null });
    assert.equal(p.sick, null);
    assert.equal(p.careMistakes, 0);
    assert.equal(p.adultMistakes, 2);
    assert.equal(p.tantrumCooldown, 89);
    assert.equal(p.stageAwakeMin, 1);
    assert.equal(p.totalAwakeMin, 1);
    assert.equal(p.gen, 1);
    assert.equal(p.name, DEFAULT_NAME);
    assert.equal(p.lightsOn, true);
    assert.equal(p.alive, true);
    assert.deepEqual(s.album, []);
    assert.deepEqual(s.dex, {});
    assert.deepEqual(clone(s), s);
  });

  test('corrupt structure: settings, timestamps, species, the whole pet', () => {
    const s = make('tongtong', { now: at(12) });
    s.settings = null;
    s.lastTick = NaN;
    s.rulesMode = 'nightmare';
    s.paused = 'yes';
    advance(s, at(12, 5));
    assert.deepEqual(s.settings, { wakeMin: 480, bedMin: 1380, tzOffsetMin: 540 });
    assert.equal(s.lastTick, at(12, 5));
    assert.equal(s.rulesMode, 'gentle');
    assert.equal(s.paused, false);

    s.settings = { wakeMin: 700, bedMin: 700, tzOffsetMin: 1e9 };
    advance(s, at(12, 6));
    assert.deepEqual(s.settings, { wakeMin: 480, bedMin: 1380, tzOffsetMin: 840 });

    s.pet.species = 'dragon';
    s.pet.stage = 'teen';
    advance(s, at(12, 7));
    assert.equal(s.pet.species, 'kkabul');
    s.pet.species = 'narae';
    s.pet.stage = 'baby';
    advance(s, at(12, 8));
    assert.equal(s.pet.stage, 'adult', 'the species decides the stage');
    s.pet.species = { evil: true };
    s.pet.stage = 7;
    advance(s, at(12, 8));   // no time passes: only the repair runs
    assert.deepEqual([s.pet.stage, s.pet.species], ['egg', 'egg']);

    s.pet = null;
    assert.doesNotThrow(() => advance(s, at(12, 8)));
    assert.equal(s.pet.stage, 'egg');
    assert.equal(s.pet.alive, true);
    s.pet = [1, 2, 3];
    assert.equal(act(s, 'tapEgg', null, at(12, 8)).ok, true);
    assert.equal(s.pet.eggTaps, 1);

    s.lastTick = at(12, 10) + 400 * DAY;   // a save from the future
    assert.deepEqual(advance(s, at(12, 11)), []);
    assert.equal(s.lastTick, at(12, 11));
  });

  test('an imported album, 도감 and unknown keys are bounded and repaired', () => {
    const entry = (gen) => ({ name: '보리', species: 'narae', gen, ageDays: 9, bornAt: at(9), endedAt: at(12), end: 'journey', mode: 'gentle', careGrade: 'A' });
    const star = { name: '두부', species: 'gureum', gen: 3, ageDays: 6, bornAt: at(9), endedAt: at(12), end: 'star', cause: 'neglect', mode: 'classic', careGrade: 'C', leftEgg: false };

    // A healthy album is left exactly as it is (same array, same entries).
    const ok = make('tongtong', { now: at(12) });
    ok.album = [entry(1), star, { ...entry(2), species: 'someday', note: 'from a newer build' }];
    const before = clone(ok.album);
    const sameArray = ok.album;
    advance(ok, at(12, 1), { live: true });
    assert.equal(ok.album, sameArray);
    assert.deepEqual(ok.album, before, 'unknown species and unknown fields survive');

    // Too long: the newest 300 entries that are entries at all.
    const long = make('tongtong', { now: at(12) });
    long.album = Array.from({ length: 1000 }, (_, i) => (i % 2 ? i : entry(i)));
    advance(long, at(12, 1), { live: true });
    assert.equal(long.album.length, 300);
    assert.deepEqual([long.album[0].gen, long.album[299].gen], [400, 998]);
    const zeros = make('tongtong', { now: at(12) });
    zeros.album = new Array(600000).fill(0);
    advance(zeros, at(12, 1), { live: true });
    assert.deepEqual(zeros.album, []);

    // Junk entries are repaired field by field, through the same path an import takes.
    const s = make('tongtong', { now: at(12) });
    s.album = [null, 42, 'str', [entry(1)], {}, {
      name: '<img src=x onerror=alert(1)>', species: '__proto__', gen: -5, ageDays: 1e9, bornAt: 'yesterday', endedAt: 1e300,
      end: 'boom', cause: 'bored', mode: 7, careGrade: 'S', leftEgg: 'yes', extra: 'kept',
    }, { ...star, species: 'constructor', cause: 'oldage', leftEgg: true }];
    s.dex = JSON.parse(`{"__proto__":{"polluted":true},"mongsil":"yesterday","banjjak":{},"byeolbit":1e308,"saessak":null,"narae":${at(9)},"someday":${at(10)}}`);
    s.junk = 'x'.repeat(5000);
    s['__proto__x'] = { a: 1 };
    const back = importCode(exportCode(s));
    assert.equal(back.junk.length, 5000, 'storage hands the object over verbatim');
    advance(back, at(12, 1), { live: true });
    assert.deepEqual(back.album, [
      { name: DEFAULT_NAME, species: '', gen: 1, ageDays: 0, bornAt: null, endedAt: null, end: 'journey', mode: 'gentle', careGrade: 'C' },
      { name: '<img s', species: '', gen: 1, ageDays: 99999, bornAt: null, endedAt: null, end: 'journey', mode: 'gentle', careGrade: 'C', leftEgg: false, extra: 'kept' },
      { ...star, species: '', cause: 'oldage', leftEgg: true },
    ]);
    assert.deepEqual(back.dex, { narae: at(9), someday: at(10) });
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(back).sort(),
      ['album', 'createdAt', 'dex', 'hiTick', 'lastTick', 'paused', 'pet', 'rulesMode', 'settings', 'v']);
    assert.deepEqual(clone(back), back);
    // Hatching still stamps a species whose slot held junk.
    const egg = newGame(BASE);
    egg.dex = { mongsil: 'yesterday' };
    advance(egg, BASE + MIN);
    assert.equal(egg.dex.mongsil, BASE + MIN);

    // A 도감 stuffed with made-up ids keeps the real ones only.
    const stuffed = make('tongtong', { now: at(12) });
    for (let i = 0; i < 500; i++) stuffed.dex[`fake${i}`] = at(9);
    stuffed.dex.narae = at(9);
    advance(stuffed, at(12, 1), { live: true });
    assert.deepEqual(Object.keys(stuffed.dex).sort(), ['narae', 'tongtong']);
  });

  test('advance and act never throw on garbage', () => {
    const good = () => make('tongtong');
    for (const bad of [null, undefined, 42, 'state', [], true]) {
      assert.deepEqual(advance(bad, BASE), []);
      const r = act(bad, 'meal', null, BASE);
      assert.equal(r.ok, false);
      assert.deepEqual(r.events, []);
      assert.doesNotThrow(() => view(bad, BASE));
      assert.equal(view(bad, BASE).stage, 'egg');
    }
    for (const now of [NaN, Infinity, -Infinity, '5', null, undefined, {}, 1e300]) {
      const s = good();
      const before = clone(s);
      assert.deepEqual(advance(s, now), []);
      assert.deepEqual(s, before, String(now));
      assert.doesNotThrow(() => act(s, 'snack', null, now));
      assert.equal(s.lastTick, before.lastTick);
    }
    for (const opts of [null, 5, 'x', { rng: 5 }, { live: 'yes' }]) {
      const s = good();
      assert.doesNotThrow(() => advance(s, at(10), opts));
      assert.doesNotThrow(() => act(s, 'meal', null, at(10), opts));
    }
    for (const payload of [null, undefined, 5, 'x', [], { on: 'maybe' }, { name: {} }, { mode: 5 }, { won: 'yes', completed: 1 }]) {
      const s = good();
      for (const a of ['meal', 'snack', 'playStart', 'playEnd', 'clean', 'medicine', 'scold', 'light', 'pet', 'name',
        'depart', 'newEgg', 'pause', 'setSchedule', 'setMode', 'setTz', 'tapEgg']) {
        assert.doesNotThrow(() => act(s, a, payload, at(10)), `${a} ${JSON.stringify(payload)}`);
      }
      assert.deepEqual(clone(s), s);
    }
    const frozen = Object.freeze(good());
    assert.doesNotThrow(() => advance(frozen, at(10)));
    assert.equal(act(frozen, 'meal', null, at(10)).ok, false);
  });

  test('a misbehaving rng cannot break an action or force a tantrum', () => {
    for (const rng of [() => NaN, () => 'x', () => { throw new Error('boom'); }, () => undefined]) {
      const s = make('tongtong', { hunger: 2 });
      const r = act(s, 'meal', null, s.lastTick, { rng });
      assert.equal(r.ok, true);
      assert.equal(s.pet.hunger, 3);
      assert.equal(s.pet.calls.tantrum, null);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('storage', () => {
  function fakeStorage() {
    const map = new Map();
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    };
  }
  function install(storage) {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  }

  // A state with some history in it.
  function played() {
    const s = newGame(at(9), { rulesMode: 'classic' });
    const rng = seeded(3);
    for (let i = 0; i < 5; i++) act(s, 'tapEgg', null, at(9));
    act(s, 'name', { name: '호두' }, at(9));
    let t = at(9);
    for (let i = 0; i < 60; i++) {
      t += 9 * MIN;
      act(s, ['meal', 'snack', 'pet', 'clean'][i % 4], null, t, { rng });
    }
    return s;
  }

  test('export → import round-trips the state exactly', () => {
    const s = played();
    assert.equal(s.pet.name, '호두');
    assert.equal(s.pet.stage, 'child');
    const code = exportCode(s);
    assert.match(code, /^PUMAL1\.[A-Za-z0-9_-]+$/);
    const back = importCode(code);
    assert.deepEqual(back, s);
    assert.notEqual(back, s);
    assert.deepEqual(importCode(`  ${code.slice(0, 40)}\n ${code.slice(40)}  `), s, 'whitespace from chat apps is ignored');

    // Both copies keep living identically.
    const end = s.lastTick + 3 * DAY;
    assert.deepEqual(advance(back, end), advance(s, end));
    assert.deepEqual(back, s);
    assert.deepEqual(importCode(exportCode(s)), s, 'a finished pet with an album round-trips too');
    assert.equal(s.album.length, 1);
  });

  test('importCode rejects everything that is not a save code', () => {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const bad = [
      '', '   ', 'hello', 'PUMAL1.', 'PUMAL1.!!!!', 'PUMAL2.' + b64(newGame(BASE)), 'pumal1.' + b64(newGame(BASE)),
      'PUMAL1.' + b64({ v: 2 }), 'PUMAL1.' + b64({ ...newGame(BASE), v: 2 }), 'PUMAL1.' + b64([1, 2, 3]), 'PUMAL1.' + b64('text'),
      'PUMAL1.' + b64({ ...newGame(BASE), pet: null }), 'PUMAL1.' + b64({ ...newGame(BASE), lastTick: 'x' }),
      'PUMAL1.' + b64({ ...newGame(BASE), album: {} }), 'PUMAL1.' + Buffer.from('{not json').toString('base64url'),
      'PUMAL1.' + Buffer.from([0xff, 0xfe, 0x80]).toString('base64url'),
      exportCode(newGame(BASE)).slice(0, -9),
      null, undefined, 42, {},
    ];
    for (const text of bad) {
      assert.throws(() => importCode(text), { name: 'Error', message: '코드가 올바르지 않아요' }, String(text).slice(0, 30));
    }
    assert.doesNotThrow(() => importCode(exportCode(newGame(BASE))));
  });

  test('an imported save with corrupt numbers is repaired by the engine, not trusted', () => {
    const s = played();
    s.pet.hunger = 1e9;
    s.pet.weight = -40;
    const back = importCode(exportCode(s));
    assert.doesNotThrow(() => advance(back, back.lastTick + MIN));
    assert.equal(back.pet.hunger, 4);
    assert.equal(back.pet.weight, 10);
  });

  test('save and load', () => {
    const ls = fakeStorage();
    install(ls);
    assert.equal(loadGame(), null);
    const s = played();
    assert.equal(saveGame(s, 1000000), true);
    assert.deepEqual(loadGame(), s);
    assert.equal(ls.map.get('pumal.save.v1'), JSON.stringify(s));
    assert.equal(ls.map.get('pumal.save.v1.bak'), JSON.stringify(s));
    clearGame();
    assert.equal(loadGame(), null);
    assert.equal(ls.map.size, 0);
    assert.equal(saveGame({ not: 'a save' }, 1000000), false);
    assert.equal(saveGame(null, 1000000), false);
    assert.equal(ls.map.size, 0);
  });

  test('the backup is written at most once per 10 minutes and rescues a corrupt save', () => {
    const ls = fakeStorage();
    install(ls);
    const s = played();
    const t0 = 5000000;
    saveGame(s, t0);
    const first = JSON.stringify(s);
    act(s, 'name', { name: '보리' }, s.lastTick);
    saveGame(s, t0 + 5 * MIN);
    assert.equal(ls.map.get('pumal.save.v1'), JSON.stringify(s));
    assert.equal(ls.map.get('pumal.save.v1.bak'), first, 'backup not rewritten after 5 minutes');
    saveGame(s, t0 + 10 * MIN - 1);
    assert.equal(ls.map.get('pumal.save.v1.bak'), first);

    ls.map.set('pumal.save.v1', '{"v":1,"pet":{"stage":"chi');   // half-written
    assert.equal(loadGame().pet.name, '호두', 'falls back to the backup');
    ls.map.set('pumal.save.v1', JSON.stringify({ v: 1 }));          // valid JSON, not a save
    assert.equal(loadGame().pet.name, '호두');

    saveGame(s, t0 + 10 * MIN);
    assert.equal(ls.map.get('pumal.save.v1.bak'), JSON.stringify(s), 'rewritten after 10 minutes');
    assert.equal(loadGame().pet.name, '보리');

    ls.map.set('pumal.save.v1', 'garbage');
    ls.map.set('pumal.save.v1.bak', '[]');
    assert.equal(loadGame(), null);
  });

  test('a stale second instance cannot overwrite newer progress', async () => {
    const ls = fakeStorage();
    install(ls);
    // Two tabs: each module instance keeps its own memory of what it last read or wrote.
    const instance = (tag) => import(`${new URL('../js/storage.js', import.meta.url).href}?instance=${tag}`);
    const A = await instance('a');
    const B = await instance('b');
    const inA = played();
    assert.equal(A.saveGame(inA, 1000), true);
    assert.equal(A.changedElsewhere(), false);

    const inB = B.loadGame();                    // the link is opened again in another tab
    assert.equal(B.changedElsewhere(), false);
    act(inB, 'name', { name: '보리' }, inB.lastTick);
    assert.equal(B.saveGame(inB, 2000), true);
    const newer = ls.map.get('pumal.save.v1');

    // Tab A comes back with its old game in memory: its save is refused, nothing is touched.
    assert.equal(A.changedElsewhere(), true);
    assert.equal(A.saveGame(inA, 3000), false);
    assert.equal(ls.map.get('pumal.save.v1'), newer);
    assert.equal(ls.map.get('pumal.save.v1.bak'), JSON.stringify(inA), 'the 10-minute backup is not touched either');
    // It adopts the stored game instead and carries on from there.
    const adopted = A.loadGame();
    assert.equal(adopted.pet.name, '보리');
    assert.equal(A.changedElsewhere(), false);
    act(adopted, 'name', { name: '두부' }, adopted.lastTick);
    assert.equal(A.saveGame(adopted, 4000), true);
    // Now B is the stale one - unless the player explicitly replaces the game (import).
    assert.equal(B.changedElsewhere(), true);
    assert.equal(B.saveGame(inB, 5000), false);
    assert.equal(B.saveGame(inB, 5000, true), true);
    assert.equal(loadGame().pet.name, '보리');
    assert.equal(B.changedElsewhere(), false);
  });

  test('only a different, valid stored save counts as changed elsewhere', () => {
    const ls = fakeStorage();
    install(ls);
    const s = played();
    assert.equal(changedElsewhere(), false, 'nothing stored');
    assert.equal(saveGame(s, 1000), true);
    assert.equal(changedElsewhere(), false, 'our own write');

    // Cleared site data, a half-written main key, something that is not a save: all writable.
    for (const raw of [null, '', '{"v":1,"pet":{"stage":"chi', 'garbage', JSON.stringify({ v: 1 }), '[]']) {
      if (raw === null) ls.map.delete('pumal.save.v1'); else ls.map.set('pumal.save.v1', raw);
      assert.equal(changedElsewhere(), false, String(raw));
      assert.equal(saveGame(s, 2000), true, String(raw));
      assert.equal(ls.map.get('pumal.save.v1'), JSON.stringify(s));
    }

    // Loading from the backup (main unreadable) leaves the main key writable.
    ls.map.set('pumal.save.v1', 'garbage');
    assert.equal(loadGame().pet.name, '호두');
    assert.equal(saveGame(s, 3000), true);

    // A reset wins over whatever another instance stored meanwhile.
    const other = clone(s);
    other.pet.name = '보리';
    ls.map.set('pumal.save.v1', JSON.stringify(other));
    assert.equal(changedElsewhere(), true);
    assert.equal(saveGame(s, 4000), false);
    clearGame();
    assert.equal(changedElsewhere(), false);
    assert.equal(saveGame(newGame(BASE), 5000), true);
    assert.equal(loadGame().pet.stage, 'egg');

    // Storage that cannot be read is never a conflict (the app keeps playing unsaved).
    const boom = () => { throw new Error('SecurityError'); };
    install({ getItem: boom, setItem: boom, removeItem: boom });
    assert.equal(changedElsewhere(), false);
  });

  test('prefs: defaults, merge, bad values', () => {
    const ls = fakeStorage();
    install(ls);
    assert.deepEqual({ ...DEFAULT_PREFS }, { sound: true, haptics: true, skin: 'milk', tint: 'pea', solid: false, trial: false, seenGuide: false });
    const p = loadPrefs();
    assert.deepEqual(p, { ...DEFAULT_PREFS });
    assert.notEqual(p, DEFAULT_PREFS);
    p.skin = 'grape';
    p.sound = false;
    assert.equal(savePrefs(p), true);
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS, skin: 'grape', sound: false });
    assert.equal(DEFAULT_PREFS.skin, 'milk');

    savePrefs({ tint: 'amber' });
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS, tint: 'amber' }, 'missing keys come from the defaults');
    ls.map.set('pumal.prefs.v1', JSON.stringify({ sound: 'loud', skin: 7, tint: 'warm', extra: 1, __proto__: { hacked: true } }));
    const q = loadPrefs();
    assert.deepEqual(q, { ...DEFAULT_PREFS, tint: 'warm', extra: 1 });
    assert.equal(q.hacked, undefined);
    ls.map.set('pumal.prefs.v1', 'not json');
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS });
    ls.map.set('pumal.prefs.v1', '[1,2]');
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS });
    clearGame();
    assert.ok(ls.map.has('pumal.prefs.v1'), 'clearing the game keeps the prefs');
  });

  test('a storage that throws (private mode) or is missing never throws through', () => {
    const boom = () => { throw new Error('SecurityError'); };
    install({ getItem: boom, setItem: boom, removeItem: boom });
    const s = played();
    assert.equal(loadGame(), null);
    assert.equal(saveGame(s), false);
    assert.doesNotThrow(() => clearGame());
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS });
    assert.equal(savePrefs({ sound: false }), false);

    Object.defineProperty(globalThis, 'localStorage', { get: boom, configurable: true });
    assert.equal(loadGame(), null);
    assert.equal(saveGame(s), false);
    assert.doesNotThrow(() => clearGame());
    assert.deepEqual(loadPrefs(), { ...DEFAULT_PREFS });

    install(undefined);
    assert.equal(loadGame(), null);
    assert.equal(saveGame(s), false);
    assert.equal(savePrefs({}), false);

    // Quota exceeded on write only: loading still works.
    const ls = fakeStorage();
    install(ls);
    saveGame(s, 1);
    ls.setItem = boom;
    assert.equal(saveGame(s, 2), false);
    assert.deepEqual(loadGame(), s);
  });
});
