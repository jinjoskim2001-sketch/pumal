// js/ui.js is almost all DOM, which node does not have. These tests cover what can be checked
// without one: the module loads with no DOM access at import time, its look-up tables agree
// with js/data.js and the art, and the pure helpers behave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initUI, _test } from '../js/ui.js';
import {
  SPECIES, SPECIES_IDS, SKINS, DEFAULT_NAMES, DEFAULT_NAME, NAME_MAX, POSTCARDS, NEGLECT_MISTAKES, OLD_AGE_START,
} from '../js/data.js';
import { SPECIES_ART, ITEMS } from '../js/sprites.js';
import { DEFAULT_PREFS, exportCode } from '../js/storage.js';
import { newGame, act, advance } from '../js/engine.js';

const {
  solidMask, minToTime, timeToMin, clipName, fmtDate, SKIN_LIST, TINTS, GLYPHS,
  MODE_COPY, MIN_AWAKE_MIN, BACKDROP_ARM_MS, scheduleProblem, soundHint, withEunNeun, withIGa,
  classicSwitchRisk, classicSwitchNote, peekCode, importNote, importToast, backdropGuard,
} = _test;

test('the module imports without a DOM and exports initUI', () => {
  assert.equal(typeof initUI, 'function');
});

test('every species has the idle frames the 도감 portraits draw', () => {
  for (const id of [...SPECIES_IDS, 'egg']) {
    const art = SPECIES_ART[id];
    assert.ok(art && Array.isArray(art.idle) && art.idle.length >= 1, `${id} has idle art`);
    for (const bmp of art.idle.slice(0, 2)) {
      assert.equal(bmp.length, 16, `${id} idle is 16 rows`);
      assert.ok(bmp.every((row) => row.length === 16 && /^[#.]+$/.test(row)), `${id} idle rows are 16 wide`);
    }
  }
});

test('every species has the copy a 도감 card shows', () => {
  for (const id of SPECIES_IDS) {
    assert.ok(SPECIES[id].name && SPECIES[id].blurb && SPECIES[id].hint, id);
  }
});

test('skin and tint tables match the unlock rules and the default prefs', () => {
  const ids = SKIN_LIST.map((s) => s.id);
  assert.deepEqual(ids, ['milk', 'grape', 'graphite', 'ice', 'lagoon', 'sakura']);
  for (const locked of Object.keys(SKINS)) assert.ok(ids.includes(locked), locked);
  assert.ok(ids.includes(DEFAULT_PREFS.skin));
  assert.deepEqual(Object.keys(TINTS), ['pea', 'warm', 'amber']);
  assert.ok(TINTS[DEFAULT_PREFS.tint]);
});

test('name suggestions and the default name fit the name field', () => {
  assert.ok(DEFAULT_NAMES.length >= 3);
  for (const name of [...DEFAULT_NAMES, DEFAULT_NAME]) assert.ok(Array.from(name).length <= NAME_MAX, name);
});

test('postcards exist for both endings and all three grades', () => {
  for (const end of ['journey', 'star']) for (const grade of ['A', 'B', 'C']) {
    assert.ok(POSTCARDS[end][grade].length >= 1, `${end} ${grade}`);
  }
});

test('glyph bitmaps and the tint swatch sprite are rectangular', () => {
  for (const [name, rows] of Object.entries({ ...GLYPHS, heartFull: ITEMS.heartFull })) {
    assert.ok(rows.every((row) => row.length === rows[0].length), name);
  }
});

test('clipName keeps at most NAME_MAX characters, counted as code points', () => {
  assert.equal(clipName('보리보리보리보'), '보리보리보리');
  assert.equal(clipName('콩이'), '콩이');
  assert.equal(Array.from(clipName('😀😀😀😀😀😀😀😀')).length, NAME_MAX);
  // decomposed Hangul (NFD) is composed first, so six syllables stay six
  assert.equal(clipName('보리보리보리'.normalize('NFD')), '보리보리보리');
});

test('time helpers round-trip minutes of the day', () => {
  assert.equal(minToTime(480), '08:00');
  assert.equal(minToTime(1380), '23:00');
  assert.equal(minToTime(60), '01:00');
  assert.equal(minToTime(1439), '23:59');
  assert.equal(timeToMin('08:00'), 480);
  assert.equal(timeToMin('23:59'), 1439);
  assert.equal(timeToMin('07:30:00'), 450);
  assert.equal(timeToMin(''), null);
  assert.equal(timeToMin('25:00'), null);
  for (const m of [0, 1, 59, 60, 719, 1439]) assert.equal(timeToMin(minToTime(m)), m);
});

test('fmtDate is year.month.day in local time and empty for junk', () => {
  assert.equal(fmtDate(new Date(2026, 8, 28, 12).getTime()), '2026.9.28');
  assert.equal(fmtDate(undefined), '');
  assert.equal(fmtDate(NaN), '');
});

test('solidMask fills a closed outline and nothing outside it', () => {
  const ring = [
    '.....',
    '.###.',
    '.#.#.',
    '.###.',
    '.....',
  ];
  const mask = solidMask(ring);
  assert.equal(mask[2][2], true, 'the hole is filled');
  assert.equal(mask[0][0], false, 'the outside stays empty');
  assert.equal(mask.flat().filter(Boolean).length, 9);
});

test('solidMask does not leak through a diagonal step in the outline', () => {
  const diamond = [
    '..#..',
    '.#.#.',
    '#...#',
    '.#.#.',
    '..#..',
  ];
  const mask = solidMask(diamond);
  assert.equal(mask[2][2], true);
  assert.equal(mask[1][2], true);
  assert.equal(mask[0][0], false);
});

test('solidMask gives every creature a silhouette bigger than its outline', () => {
  for (const id of SPECIES_IDS) {
    const bmp = SPECIES_ART[id].idle[0];
    const lit = bmp.join('').split('#').length - 1;
    const solid = solidMask(bmp).flat().filter(Boolean).length;
    assert.ok(solid > lit, `${id}: ${solid} > ${lit}`);
  }
});

// ---- copy and decisions that depend on the save ------------------------------------------------

const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 9, 1, 14, 0).getTime();

// A grown pet in a gentle game, built the way the debug hooks do it: fields written directly,
// then one engine call so the state is range-checked.
function grownGame(species, patch, mode = 'gentle') {
  const state = newGame(T0 - 10 * DAY, { rulesMode: mode, tzOffsetMin: 540 });
  state.lastTick = T0;
  Object.assign(state.pet, {
    species, stage: SPECIES[species].stage, name: '콩이', hunger: 4, happy: 4,
    stageAwakeMin: 300, adultAwakeMin: 300, adultMistakes: 0, specialChecked: true, eggTaps: 5,
  }, patch);
  advance(state, T0, { live: true });
  return state;
}

test('the 매운맛 line says a pet left alone becomes a star and that no alert can be sent', () => {
  assert.match(MODE_COPY.classic, /혼자 두면 별이 될 수 있/);
  assert.match(MODE_COPY.classic, /알림을 보내지 못해요/);
  // grace periods are tuning numbers that change; the copy must not quote one
  for (const line of Object.values(MODE_COPY)) assert.doesNotMatch(line, /\d/, line);
});

test('the 매운맛 confirm tells a pet that grew old in 순한맛 what will happen', () => {
  // the reported case: a perfectly kept 뒹굴 past its 5000 minutes
  const past = grownGame('dwinggul', { adultAwakeMin: 5200, stageAwakeMin: 5200 });
  assert.equal(classicSwitchRisk(past), 'old');
  assert.equal(classicSwitchNote(past), '콩이는 이미 나이가 많아서, 바꾸면 곧 아플 수 있어요.');
  past.pet.name = '호박';
  assert.match(classicSwitchNote(past), /^호박은 /);

  // old age starts at a share of the lifespan, not at its end
  const at = Math.ceil(SPECIES.banjjak.lifespanMin * OLD_AGE_START);
  assert.equal(classicSwitchRisk(grownGame('banjjak', { adultAwakeMin: at, stageAwakeMin: at })), 'old');
  assert.equal(classicSwitchRisk(grownGame('banjjak', { adultAwakeMin: at - 1, stageAwakeMin: at - 1 })), null);
  // a special pet carries its adult minutes with it
  assert.equal(classicSwitchRisk(grownGame('byeolbit', { adultAwakeMin: 9000, stageAwakeMin: 100 })), 'old');
});

test('the 매운맛 confirm is only as alarming as the pet in hand', () => {
  const young = grownGame('banjjak', {});
  assert.equal(classicSwitchRisk(young), null);
  assert.equal(classicSwitchNote(young), null, 'nothing to add to the general rule');

  const neglected = grownGame('banjjak', { adultMistakes: NEGLECT_MISTAKES });
  assert.equal(classicSwitchRisk(neglected), 'neglect');
  assert.equal(classicSwitchNote(neglected), '돌봄 실수가 많이 쌓여서, 바꾸면 콩이가 곧 별이 돼요.');
  assert.equal(classicSwitchRisk(grownGame('banjjak', { adultMistakes: NEGLECT_MISTAKES - 1 })), null);

  // age and mistakes only end adults
  assert.equal(classicSwitchRisk(grownGame('tongtong', { stageAwakeMin: 800, careMistakes: 9 })), null);
  assert.equal(classicSwitchRisk(newGame(T0)), null, 'an egg');
  assert.equal(classicSwitchRisk(grownGame('dwinggul', { adultAwakeMin: 9000, stageAwakeMin: 9000, alive: false, endCause: 'sick' })), null);
  for (const junk of [null, undefined, {}, { pet: null }, { pet: { species: 'nobody' } }]) assert.equal(classicSwitchRisk(junk), null);
  assert.equal(classicSwitchNote(null), null);
});

test('the confirm and the engine agree on the first minutes of 매운맛', () => {
  // The player was told what would happen and pressed 매운맛으로. A pet the confirm called
  // safe must be alive and well; "곧 아플 수 있어요" must mean sick, not a star; and only the
  // pet that was told "곧 별이 돼요" may end.
  const cases = [];
  for (const id of SPECIES_IDS.filter((x) => SPECIES[x].lifespanMin)) {
    const life = SPECIES[id].lifespanMin;
    for (const share of [0.1, OLD_AGE_START - 0.01, OLD_AGE_START, 0.99, 1, 1.3]) {
      const min = Math.round(life * share);
      cases.push([`${id} at ${share}`, grownGame(id, { adultAwakeMin: min, stageAwakeMin: SPECIES[id].stage === 'special' ? 100 : min })]);
    }
  }
  cases.push(['neglected', grownGame('banjjak', { adultMistakes: NEGLECT_MISTAKES })]);
  for (const [what, state] of cases) {
    const risk = classicSwitchRisk(state);
    assert.equal(act(state, 'setMode', { mode: 'classic' }, T0).ok, true);
    advance(state, T0 + 3 * 60000, { live: true });
    if (risk === null) {
      assert.equal(state.pet.alive, true, `${what}: called safe, must live`);
      assert.equal(state.pet.sick, null, `${what}: called safe, must stay well`);
    } else if (risk === 'old') {
      assert.equal(state.pet.alive, true, `${what}: warned of sickness only, must not end`);
      assert.equal(state.pet.sick && state.pet.sick.cause, 'age', `${what}: old-age sickness at once`);
    } else {
      assert.equal(state.pet.alive, false, `${what}: told it would end`);
      assert.equal(state.pet.endCause, 'neglect');
    }
  }
});

test('particles follow the last syllable of the name', () => {
  assert.equal(withEunNeun('콩이'), '콩이는');
  assert.equal(withEunNeun('호박'), '호박은');
  assert.equal(withIGa('콩이'), '콩이가');
  assert.equal(withIGa('구슬'), '구슬이');
  assert.equal(withIGa('Mo'), 'Mo가', 'not Hangul: treated as an open syllable');
  assert.equal(withEunNeun(''), '는');
});

test('a day needs at least six awake hours; an empty field is not a mistake', () => {
  assert.equal(MIN_AWAKE_MIN, 360);
  assert.equal(scheduleProblem(480, 1380), null, 'the default day');
  assert.equal(scheduleProblem(480, 480), 'same');
  assert.equal(scheduleProblem(480, 481), 'short', 'a one-minute day');
  assert.equal(scheduleProblem(480, 660), 'short', '취침 오전 11:00 instead of 오후');
  assert.equal(scheduleProblem(480, 839), 'short');
  assert.equal(scheduleProblem(480, 840), null, 'exactly six hours');
  assert.equal(scheduleProblem(1320, 240), null, 'a night owl: bed after midnight');
  assert.equal(scheduleProblem(1380, 90), 'short', 'wraps past midnight and is still too short');
  assert.equal(scheduleProblem(480, 479), null, 'awake all day but one minute');
  assert.equal(scheduleProblem(480, null), 'unset');
  assert.equal(scheduleProblem(null, 480), 'unset');
  assert.equal(scheduleProblem(480, timeToMin('')), 'unset', 'a cleared time input');
  // the spans the engine tests rely on stay legal
  for (const span of [540, 960, 1439]) assert.equal(scheduleProblem(0, span), null, String(span));
});

test('the 소리 row explains silent mode on an iPhone and nowhere else', () => {
  assert.match(soundHint({ ios: true, standalone: true }), /무음 모드/);
  assert.match(soundHint({ ios: true, standalone: false }), /소리가 나지 않아요/);
  assert.equal(soundHint({ ios: false, android: true }), null);
  assert.equal(soundHint(null), null);
  assert.equal(soundHint(undefined), null);
});

// ---- save codes --------------------------------------------------------------------------------

test('peekCode reads the age of a code and whether its pet is alive, without importing it', () => {
  const state = grownGame('dokkae', {}, 'classic');
  const before = JSON.stringify(state);
  const code = exportCode(state);
  assert.deepEqual(peekCode(code, T0 + 3 * DAY), { ageMin: 3 * 1440, alive: true });
  assert.deepEqual(peekCode(code, T0 + 59 * 1000), { ageMin: 0, alive: true });
  assert.equal(JSON.stringify(state), before);

  // chat apps add spaces and line breaks; a code from a clock that runs ahead is not "old"
  assert.equal(peekCode(` ${code.slice(0, 20)}\n${code.slice(20)} `, T0 + 5 * HOUR).ageMin, 300);
  assert.equal(peekCode(code, T0 - 10 * DAY).ageMin, 0);

  const star = grownGame('dokkae', { alive: false, endCause: 'sick' }, 'classic');
  assert.equal(peekCode(exportCode(star), T0).alive, false);

  for (const bad of ['', 'PUMAL1.', 'PUMAL1.!!!', 'hello', 'PUMAL1.e30', null]) assert.equal(peekCode(bad, T0), null, String(bad));
});

test('the import confirm says how old the code is before anything is overwritten', () => {
  assert.equal(importNote(null), null, 'an unreadable code: the import itself reports it');
  assert.equal(importNote({ ageMin: 59, alive: true }), null, 'a fresh code needs no date');
  assert.equal(importNote({ ageMin: 3 * 1440, alive: true }), '3일 전에 저장한 코드예요. 그 뒤에 있었던 일은 담겨 있지 않아요.');
  assert.match(importNote({ ageMin: 5 * 60 + 30, alive: true }), /^5시간 전에 저장한 코드예요/);
  assert.match(importNote({ ageMin: 47 * 60, alive: true }), /^47시간 전/);
  assert.match(importNote({ ageMin: 48 * 60, alive: false }), /^2일 전/);
});

test('the import toast is not cheerful about a pet that came back as a star', () => {
  assert.equal(importToast({ ageMin: 0, alive: true }, { alive: true }), '가져왔어요. 다시 만나 반가워요!');
  assert.equal(importToast(null, {}), '가져왔어요. 다시 만나 반가워요!');
  // the code held a living pet and the game shows a star: say so
  assert.equal(importToast({ ageMin: 4320, alive: true }, { alive: false, endCause: 'sick' }), '가져왔어요. 그사이 펫이 별이 되었어요');
  // the code already held a star: nothing happened "in the meantime", and nothing to cheer
  assert.equal(importToast({ ageMin: 4320, alive: false }, { alive: false }), '가져왔어요');
  assert.equal(importToast(null, { alive: false }), '가져왔어요');
  for (const peek of [null, { alive: true }, { alive: false }]) assert.doesNotMatch(importToast(peek, { alive: false }), /반가워요/);
});

// ---- the dim behind a sheet --------------------------------------------------------------------

test('a tap on the dim closes a sheet only when the press began on the dim', () => {
  let now = 1000;
  const layer = { openedAt: 1000, modal: false };
  const guard = backdropGuard(layer, () => now);

  // The sheet was opened by a pointerdown on the LCD; the click of that same touch lands on
  // the dim when the finger lifts, 80 ms or 700 ms later. Neither may close the sheet.
  for (const held of [80, 250, 450, 700, 5000]) {
    now = 1000 + held;
    assert.equal(guard.click(), false, `release after ${held} ms`);
  }

  // a second tap that was already on its way when the sheet appeared
  now = 1000 + BACKDROP_ARM_MS - 50;
  guard.down();
  assert.equal(guard.click(), false);

  // a deliberate tap on the dim
  now = 1000 + BACKDROP_ARM_MS + 1;
  guard.down();
  assert.equal(guard.click(), true);
  assert.equal(guard.click(), false, 'one press, one close');
});

test('the first naming sheet is modal: no tap on the dim dismisses it', () => {
  let now = 0;
  const layer = { openedAt: 0, modal: true };
  const guard = backdropGuard(layer, () => now);
  for (const t of [100, 400, 2000, 60000]) {
    now = t;
    guard.down();
    assert.equal(guard.click(), false, `tap at ${t} ms`);
  }
  // the same sheet opened from 설정 (이름 바꾸기) is not modal
  layer.modal = false;
  guard.down();
  assert.equal(guard.click(), true);
});

test('ui.js wires the guard to the dim and marks only the first naming sheet modal', () => {
  const src = fs.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.match(src, /layer\.dim\.addEventListener\('pointerdown', guard\.down\)/);
  assert.match(src, /layer\.dim\.addEventListener\('click', \(\) => \{ if \(guard\.click\(\)\) closeLayer\(layer, 'backdrop'\); \}\)/);
  assert.match(src, /layer\.modal = first;/);
  assert.equal(src.match(/layer\.modal = /g).length, 1);
  // the confirms pass the pet-specific line, and the confirm sheet shows it
  assert.match(src, /note: classicSwitchNote\(state\(\)\)/);
  assert.match(src, /note: importNote\(peek\)/);
  assert.match(src, /toast\(importToast\(peek, viewNow\(\)\)\)/);
  assert.match(src, /if \(opts\.note\) layer\.body\.append/);
});

// ---- css/sheets.css ----------------------------------------------------------------------------

test('landscape with the keyboard up keeps the name field and 확인 inside what is visible', () => {
  const css = fs.readFileSync(new URL('../css/sheets.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (orientation: landscape) and (max-height: 520px)');
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf('@media (prefers-reduced-motion: reduce)', start));
  const px = (selector, prop) => {
    const rule = new RegExp(`${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(block);
    assert.ok(rule, `${selector} has a landscape keyboard rule`);
    const decl = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(rule[1]);
    assert.ok(decl, `${selector} sets ${prop}`);
    return decl[1].trim().split(/\s+/).map((v) => parseFloat(v));
  };
  const headPad = px('#sheetRoot.has-kb .sheet-head', 'padding-top')[0];
  const bar = px('#sheetRoot.has-kb .sheet-bar', 'min-height')[0];
  const input = px('#sheetRoot.has-kb .name-input', 'height')[0];
  const foot = px('#sheetRoot.has-kb .sheet-foot', 'padding');
  assert.ok(px('#sheetRoot.has-kb .name-input', 'font-size')[0] >= 16, 'below 16 px iOS zooms the page on focus');
  assert.match(block, /#sheetRoot\.has-kb \.chips\s*\{\s*display: none;/);
  assert.doesNotMatch(block, /\.sheet-foot[^{]*\{[^}]*display:\s*none/, '확인 stays: Enter is ignored while composing Hangul');

  // head + body (4 px top, 8 px bottom padding around the field) + foot (52 px button)
  const sheet = headPad + bar + 4 + input + 8 + foot[0] + 52 + foot[2];
  // 667x375 with a 200 px keyboard leaves 175 px, and the sheet may use all but 4 of them
  assert.ok(sheet <= 175 - 4, `the name sheet is ${sheet} px tall`);
});

test('sheet heights are measured from the visible page, not from 100vh', () => {
  const css = fs.readFileSync(new URL('../css/sheets.css', import.meta.url), 'utf8');
  // In a browser tab 100vh is the tall viewport (Safari's bars retracted); css/app.css carries
  // the visible height in --vh, and ui.js writes --vvh while the keyboard is up.
  const uses = css.match(/var\(--vvh[^;]*;/g) || [];
  assert.equal(uses.length, 5, 'max-height / height of the sheet, portrait and landscape');
  for (const u of uses) assert.match(u, /^var\(--vvh, var\(--vh, 100vh\)\)/);
});
