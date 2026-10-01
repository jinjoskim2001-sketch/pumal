// Bootstrap and wiring (SPEC 11.6): prefs, gate, game state, live loop, save, keys.
//
// Constraints that shape this file:
// - iOS suspends JS seconds after the app is hidden and may never run it again, so the game
//   is saved synchronously after every change and on hidden / pagehide, and time is always
//   replayed from the saved timestamp.
// - An absence must be replayed with advance(live: false) BEFORE anything else touches the
//   state. engine.act() advances live first, and a live advance has no away cap and counts
//   the lights call as a mistake. sync() is therefore the only door to the engine: it looks
//   at the gap since the last tick and decides between "away" and "live" by itself, so the
//   order of timers, key presses and visibility events after a resume does not matter.
// - Keys act on pointerdown. The click that follows a tap (and the one the haptic label
//   forwards) is ignored; a click with no pointer before it is assistive tech and is honoured.
// - The sheets (js/ui.js) are loaded separately and are optional at run time: if that module
//   fails, the toy itself must still start, and the next tap that needs a sheet tries again.
// - The same save can be open in two places (two tabs; a tab and the installed app on
//   Android). js/storage.js refuses to overwrite a save another instance has written since;
//   this file then adopts that newer save instead of fighting it (adoptStored).

import * as engine from './engine.js';
import {
  loadGame, saveGame, clearGame, changedElsewhere, exportCode, importCode, loadPrefs, savePrefs, DEFAULT_PREFS,
} from './storage.js';
import { createLCD } from './lcd.js';
import { ICONS } from './sprites.js';
import { audio } from './audio.js';
import { attachHaptic, setHapticsEnabled } from './haptics.js';
import {
  detectEnv, gateMode, mountGate, shareApp, registerSW, mountInstallPill, applyPendingUpdate, isUpdatePending,
} from './install.js';
import { createScenes } from './scenes.js';

const VERSION = 'pumal-v1';       // shown in 설정 → 정보; keep equal to VERSION in sw.js
const AWAY_MS = 120000;           // a gap this long since the last tick is an absence
const LIVE_MS = 1000;
const LONG_PRESS_MS = 800;
const TOAST_MS = 2200;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const forcePlay = params.get('play') === '1';

// The game clock. Debug hooks may shift it (skip) or pin it (?shot=).
const clock = {
  offset: 0,
  fixed: null,
  now() { return this.fixed !== null ? this.fixed : Date.now() + this.offset; },
};

let prefs = { ...DEFAULT_PREFS };
let state = null;
let env = null;
let lcd = null;
let scenes = null;
let persist = true;               // false in ?shot= mode: a screenshot must never touch the save
let frozen = false;
let rng = Math.random;
let liveTimer = 0;
let saveWarned = false;
let captionText = null;
let shakeTimer = 0;
let ui = fallbackUI();
let uiReady = false;              // js/ui.js has loaded and built the sheets
let uiLoading = null;
let uiTries = 0;

const tzOffset = () => -new Date().getTimezoneOffset();

function isDevHost() {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

// ---- small DOM services ------------------------------------------------------------------

function toast(text) {
  const root = $('toastRoot');
  if (!root || !text) return;
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.textContent = String(text);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  }, TOAST_MS);
}

// Used until js/ui.js has loaded, and for good if it cannot be loaded.
function fallbackUI() {
  return { open() {}, close() {}, isOpen: () => false, toast };
}

function setCaption(text) {
  const next = text || '';
  if (next === captionText) return;
  captionText = next;
  const cap = $('caption');
  if (cap) cap.textContent = next;
  const canvas = $('lcd');
  if (canvas) canvas.setAttribute('aria-label', next ? `품알 화면: ${next}` : '품알 화면');
}

function shake() {
  const device = $('device');
  if (!device) return;
  device.classList.remove('shake');
  void device.offsetWidth;          // restart the CSS animation when two refusals come close together
  device.classList.add('shake');
  clearTimeout(shakeTimer);
  shakeTimer = setTimeout(() => device.classList.remove('shake'), 300);
}

function applyPrefs() {
  const device = $('device');
  if (device) {
    device.dataset.skin = prefs.skin || 'milk';
    device.dataset.solid = prefs.solid ? 'true' : 'false';
  }
  audio.setEnabled(prefs.sound !== false);
  setHapticsEnabled(prefs.haptics !== false);
}

// ---- saving and time ------------------------------------------------------------------------

function save() {
  if (!persist || !state) return;
  // No recursion: loadGame() inside adoptStored clears the conflict before catchUp saves.
  if (adoptStored()) return;
  if (saveGame(state) || saveWarned) return;
  saveWarned = true;                // private mode or a full disk: say so once, keep playing
  ui.toast('이 브라우저에서는 저장이 안 돼요');
}

function catchUp(now) {
  // A clock that was set back and later corrected leaves a mark (hiTick) up to which the pet
  // has already lived; the engine skips that stretch, so it is not part of the absence either.
  const lived = Number.isFinite(state.hiTick) && state.hiTick > state.lastTick ? Math.min(now, state.hiTick) : state.lastTick;
  const gapMin = Math.max(0, Math.floor((now - lived) / 60000));
  // Time zone first, at the old timestamp, so setting it cannot consume the absence as live time.
  engine.act(state, 'setTz', { tzOffsetMin: tzOffset() }, state.lastTick, { rng });
  const events = engine.advance(state, now, { live: false, rng });
  save();
  return { events, gapMin };
}

// Another instance (a second tab, the installed app next to a tab) has stored a save since
// this one last read or wrote: that one is the game now. Without this the stale instance
// could never save again and would keep showing a pet that no longer exists. The newer save
// is loaded, caught up to now and shown like any other return from an absence.
// Never call loadGame() unconditionally on resume: it would reset the scenes on every return.
function adoptStored() {
  if (!persist || frozen || !changedElsewhere()) return false;
  const next = loadGame();
  if (!next) return false;
  state = next;
  const away = catchUp(clock.now());
  if (scenes) {
    scenes.reset();
    scenes.onEvents(away.events, { away: true, gapMin: away.gapMin });
  }
  return true;
}

// The only way time moves. Returns 'away' when it replayed an absence.
function sync() {
  if (!state) return 'idle';
  if (adoptStored()) return 'away';
  const now = clock.now();
  if (now - state.lastTick >= AWAY_MS) {
    const { events, gapMin } = catchUp(now);
    if (scenes) scenes.onEvents(events, { away: true, gapMin });
    return 'away';
  }
  const before = state.lastTick;
  const events = engine.advance(state, now, { live: true, rng });
  if (events.length || state.lastTick !== before) save();
  if (events.length && scenes) scenes.onEvents(events, { away: false });
  return 'live';
}

function startLive() {
  if (liveTimer || frozen) return;
  liveTimer = setInterval(sync, LIVE_MS);
}

function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
}

// ---- the app object handed to js/ui.js (SPEC 11.5) ---------------------------------------------

const app = {
  get state() { return state; },
  get prefs() { return prefs; },
  get env() { return env; },
  version: VERSION,

  view() { return engine.view(state, clock.now()); },

  act(action, payload) {
    sync();
    const result = engine.act(state, action, payload, clock.now(), { rng });
    save();
    if (scenes) {
      scenes.onEvents(result.events, { away: false });
      scenes.refresh();
    }
    return result;
  },

  setPrefs(patch) {
    if (patch && typeof patch === 'object') Object.assign(prefs, patch);
    if (persist) savePrefs(prefs);
    applyPrefs();
    if (scenes) scenes.refresh();
    return prefs;
  },

  exportCode() { return exportCode(state); },

  // The caller has already asked the player to confirm: this replaces the game.
  importCode(text) {
    let next;
    try {
      next = importCode(text);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '코드가 올바르지 않아요' };
    }
    state = next;
    // The player's own decision to replace the game: it wins over whatever another instance
    // has stored meanwhile (without the force flag adoptStored would throw the import away).
    if (persist) saveGame(state, Date.now(), true);
    // A code carries the moment it was exported, which says nothing about how the pet was
    // looked after since (a backup made on Monday, restored on Saturday). Replaying that gap
    // as an absence would only punish an honest restore, so the pet arrives exactly as it
    // was saved. The engine owns lastTick, so the gap is skipped through its own door: a
    // sitter (pause) from the save's timestamp until now. setTz comes first, at the old
    // timestamp: it range-checks the imported numbers without consuming any time.
    const savedAt = state.lastTick;
    engine.act(state, 'setTz', { tzOffsetMin: tzOffset() }, savedAt, { rng });
    const wasPaused = state.paused === true;
    engine.act(state, 'pause', { on: true }, savedAt, { rng });
    engine.act(state, 'pause', { on: wasPaused }, clock.now(), { rng });
    save();
    // Whoever brings a hatched pet along has learned the keys already (prefs do not travel in
    // a code, so a fresh install would start the first-run guide): its "feed me" prompt would
    // sit over a pet that may not even be hungry, and only a meal can dismiss it.
    if (state.pet.stage !== 'egg' && prefs.seenGuide !== true) app.setPrefs({ seenGuide: true });
    if (scenes) scenes.reset();
    return { ok: true };
  },

  // Wipes what the confirm says it wipes: the pet, the 도감 and the album. How the owner set
  // the game up (the pet's hours, 순한맛 / 매운맛) is not part of that and stays.
  resetGame() {
    const old = state;
    const keep = old && old.settings
      ? { wakeMin: old.settings.wakeMin, bedMin: old.settings.bedMin, rulesMode: old.rulesMode }
      : {};
    if (persist) clearGame();
    state = engine.newGame(clock.now(), { ...keep, tzOffsetMin: tzOffset() });
    save();
    if (scenes) scenes.reset();
  },

  share() { return shareApp(); },

  // A trial player never meets the gate again (prefs.trial), so 설정 offers the way back to
  // it. The game keeps running underneath; keys are blocked while the gate is mounted, and
  // its quiet "play here" link simply closes it.
  showInstallGuide() {
    const root = $('gateRoot');
    if (!root || root.childElementCount > 0) return;
    releaseAllKeys();
    mountGate(root, env && env.inApp ? 'escape' : 'install', env, {
      auto: false,
      inGame: true,               // "close and keep playing" + the save-code note instead of the trial warning
      onPlayHere() { if (scenes) scenes.refresh(); },
    });
  },
};

// Resolves to true once the sheets are there. A failed load (a network blip on the very first
// run, before the service worker has the file) is not final: every later call tries again.
// WebKit can keep the failed entry in its module map for the identical URL, so a retry asks
// with a changed query; sw.js matches with ignoreSearch, so it still hits the precache.
function loadUI() {
  if (uiReady) return Promise.resolve(true);
  if (uiLoading) return uiLoading;
  const attempt = uiTries++;
  const load = attempt === 0 ? import('./ui.js') : import(`./ui.js?r=${attempt}`);
  uiLoading = load.then((mod) => {
    const made = mod.initUI(app);
    if (!made || typeof made.open !== 'function') return false;
    ui = {
      open(name, opts) { try { return made.open(name, opts); } catch (err) { return undefined; } },
      close() { try { made.close(); } catch (err) { /* nothing open */ } },
      isOpen() { try { return made.isOpen() === true; } catch (err) { return false; } },
      toast(text) { try { made.toast(text); } catch (err) { toast(text); } },
    };
    uiReady = true;
    return true;
  }).catch((err) => {
    console.warn('[pumal] sheets unavailable:', err);
    return false;
  }).then((ok) => {
    uiLoading = null;
    return ok;
  });
  return uiLoading;
}

// Opens a sheet, or - while the sheets module is missing - starts another attempt to load it.
// With an update waiting the old cache is already gone, so a retry would fetch the new
// version's module into the old page: reload into the update instead.
function openSheet(name, opts, quiet) {
  if (uiReady) return ui.open(name, opts);
  if (isUpdatePending() && applyPendingUpdate()) return undefined;
  if (!isUpdatePending()) loadUI();
  if (!quiet) toast('잠시 후 다시 눌러 주세요');
  return undefined;
}

// ---- input -----------------------------------------------------------------------------------------

const held = new Set();
const keyState = {};

const gateUp = () => { const g = $('gateRoot'); return Boolean(g) && g.childElementCount > 0; };
const inputBlocked = () => !scenes || ui.isOpen() || gateUp();

function press(k) {
  if (inputBlocked()) return;
  audio.unlock();
  // A press that arrives before the resume handler still replays the absence first; the
  // recap it starts is the answer to that press.
  if (sync() === 'away') { audio.play('key'); return; }
  scenes.key(k, held);
}

function releaseKey(k) {
  const s = keyState[k];
  if (!s) return;
  s.pid = null;
  held.delete(k);
  clearTimeout(s.longTimer);
}

function armLongPress(k) {
  const s = keyState[k];
  clearTimeout(s.longTimer);
  s.longTimer = setTimeout(() => {
    if (held.has(k) && scenes && !inputBlocked()) scenes.longPress(k);
  }, LONG_PRESS_MS);
}

function wireKeys() {
  for (const k of ['A', 'B', 'C']) {
    const el = $(`key${k}`);
    const s = keyState[k] = { el, pid: null, sawPointer: false, longTimer: 0, clearTimer: 0 };
    attachHaptic(el);

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (s.pid !== null) return;             // a second finger on the same key is not a second press
      s.pid = e.pointerId;
      s.sawPointer = true;
      clearTimeout(s.clearTimer);
      held.add(k);
      armLongPress(k);
      press(k);
    });

    el.addEventListener('click', () => {
      // After a real tap this is the trailing click (ours or the haptic label's): ignore it.
      if (s.sawPointer) { s.sawPointer = false; return; }
      press(k);
    });
  }

  const onUp = (e) => {
    for (const k of ['A', 'B', 'C']) {
      const s = keyState[k];
      if (s.pid !== e.pointerId) continue;
      releaseKey(k);
      // If no click follows (the finger slid off), forget the pointer after a moment.
      s.clearTimer = setTimeout(() => { s.sawPointer = false; }, 700);
    }
  };
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', releaseAllKeys);

  // Which device key a keyboard key means. A device key that was reached with the keyboard
  // (focus-visible) answers Enter / Space as itself; one that only has focus because it was
  // clicked does not, so Enter stays B on a desktop. Inside a form control the keyboard
  // belongs to that control. A focused button or link keeps only the two keys that activate
  // it: closing a sheet puts the focus back on the chip that opened it, and the game keys
  // must not go dead there.
  const fromEvent = (e) => {
    const t = e.target;
    const activates = e.key === 'Enter' || e.key === ' ';
    const onKey = t && t.closest ? t.closest('.key') : null;
    if (onKey && activates && onKey.matches(':focus-visible')) return onKey.id.slice(-1);
    if (t && t.closest) {
      if (t.closest('input, textarea, select, [contenteditable]')) return null;
      if (activates && t.closest('button, a')) return null;
    }
    if (e.code === 'KeyA' || e.key === 'ArrowLeft') return 'A';
    if (e.code === 'KeyS' || e.key === 'Enter' || e.key === ' ') return 'B';
    if (e.code === 'KeyD' || e.key === 'Escape' || e.key === 'ArrowRight') return 'C';
    return null;
  };
  // Remembered per physical key, so the release always finds the key it pressed even if
  // focus moved in between (a stuck "held" key would swallow every later press).
  const downBy = new Map();

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || inputBlocked()) return;
    const k = fromEvent(e);
    if (!k) return;
    e.preventDefault();
    if (e.repeat || held.has(k)) return;
    downBy.set(e.code || e.key, k);
    held.add(k);
    keyState[k].el.classList.add('is-pressed');
    armLongPress(k);
    press(k);
  });

  window.addEventListener('keyup', (e) => {
    const id = e.code || e.key;
    const k = downBy.get(id);
    if (!k) return;
    downBy.delete(id);
    keyState[k].el.classList.remove('is-pressed');
    if (keyState[k].pid === null) releaseKey(k);
  });

  // An open sheet swallows keyup (js/ui.js stops it in a capture listener), so the release
  // of a key that was down when a sheet opened never arrives here. Let go of everything at
  // that moment, or the key stays "held" and swallows its next press.
  window.addEventListener('pumal:sheet', (e) => {
    if (!e.detail || e.detail.open !== true) return;
    releaseAllKeys();
    downBy.clear();
  });
}

function releaseAllKeys() {
  for (const k of Object.keys(keyState)) {
    releaseKey(k);
    keyState[k].el.classList.remove('is-pressed');
  }
}

function wireTouch() {
  // On the bezel, not the canvas: the glass layer sits above the canvas.
  $('bezel').addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (inputBlocked()) return;
    // A second finger is ignored (a resting palm must not confirm an icon), except in the
    // mini-games, where the matrix is a three-zone controller played with two thumbs.
    if (e.isPrimary === false && scenes.name !== 'game') return;
    const hit = lcd.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    audio.unlock();
    if (sync() === 'away') return;
    scenes.tap(hit);
  });
}

function wireChrome() {
  const open = (name) => () => {
    audio.play('select');
    openSheet(name);
  };
  const dex = $('btnDex'), settings = $('btnSettings');
  dex.addEventListener('click', open('dex'));
  settings.addEventListener('click', open('settings'));
  attachHaptic(dex);
  attachHaptic(settings);
}

function wireLifecycle() {
  const onHide = () => {
    if (!frozen) sync();
    save();
    stopLive();
    scenes.pause();
    releaseAllKeys();
  };
  const onShow = () => {
    if (frozen) return;
    // An update that arrived while the page was away: reload into it before the absence is
    // replayed, so the new version shows the recap. (install.js does the same for
    // visibilitychange in a capture listener; this covers pageshow from the bfcache.)
    if (applyPendingUpdate()) return;
    sync();                       // catch-up + recap when it was an absence
    startLive();
    scenes.resume();
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? onHide() : onShow()));
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', (e) => { if (e.persisted && !document.hidden) onShow(); });

  // iOS can scroll even a fixed page when an input takes focus or the keyboard closes, and
  // then leave it there. The toy never scrolls, so any offset is a mistake: snap it back.
  const unscroll = () => {
    const b = document.body;
    if (b.scrollTop || b.scrollLeft) { b.scrollTop = 0; b.scrollLeft = 0; }
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  window.addEventListener('scroll', unscroll, { passive: true });
  document.body.addEventListener('scroll', unscroll, { passive: true });
  document.addEventListener('focusout', () => setTimeout(unscroll, 60));
}

// ---- boot ----------------------------------------------------------------------------------------

// May the page reload into a new version right now? (js/install.js asks; a sheet that is open
// is checked there as well.) 'now' = the update just arrived on a visible, untouched page;
// 'show' = the page came back to the foreground with an update waiting.
function canReload(when) {
  if (gateUp() || ui.isOpen() || !scenes || !state) return false;
  // Back from a real absence the reloaded page replays it and shows the recap itself. After a
  // short look away the screen must be at rest: a reload would drop a game or a menu.
  if (when === 'show' && clock.now() - state.lastTick >= AWAY_MS) return true;
  return scenes.quiet === true;
}

async function startGame(debug, shot) {
  lcd = createLCD($('lcd'));
  lcd.setIcons(
    [ICONS.food, ICONS.play, ICONS.clean, ICONS.light],
    [ICONS.medicine, ICONS.scold, ICONS.status, ICONS.call],
  );

  let away = null;
  if (shot) {
    const made = debug.shotState(shot, engine);
    state = made.state;
    clock.fixed = made.now;
    rng = made.rng;
    Object.assign(prefs, made.prefs);
    applyPrefs();
    frozen = true;
  } else {
    state = loadGame();
    if (state) away = catchUp(clock.now());
    else {
      state = engine.newGame(clock.now(), { tzOffsetMin: tzOffset() });
      save();
    }
  }

  scenes = createScenes({
    lcd,
    prefs,
    frozen,
    // Headless Chrome under a virtual-time budget starves requestAnimationFrame, so the LCD's
    // ghosting never settles there; &snap=1 (debug only) commits every frame at once.
    noGhost: Boolean(debug) && params.get('snap') === '1',
    ui: {                          // late-bound: the sheets module may still be loading
      open: (name, opts) => openSheet(name, opts, true),
      close: () => ui.close(),
      isOpen: () => ui.isOpen(),
      toast: (text) => ui.toast(text),
    },
    view: () => engine.view(state, clock.now()),
    state: () => state,
    act: (action, payload) => app.act(action, payload),
    setPrefs: (patch) => app.setPrefs(patch),
    sound: (name) => audio.play(name),
    now: () => clock.now(),
    rng: () => rng(),
    setCaption,
    shake,
    covered: gateUp,              // the install guide lies over the device like a sheet
  });

  wireKeys();
  wireTouch();
  wireChrome();
  wireLifecycle();

  scenes.start();
  if (away) scenes.onEvents(away.events, { away: true, gapMin: away.gapMin });
  if (!document.hidden) startLive(); else scenes.pause();

  const sheets = loadUI();

  if (env.standalone && navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  if (env.android && !env.standalone) {
    try { mountInstallPill(); } catch (err) { /* the pill is optional */ }
  }

  if (debug) {
    debug.install({ app, clock, sync });
    if (shot) {
      await sheets;
      debug.applyShot(shot, { app, scenes, ui });
    }
    // A key script plays on a throwaway state only: a ?shot=, or a local dev host. On the
    // real site it would replay input on the visitor's own save (a shared link could scold,
    // overfeed or send away somebody's pet).
    if (params.get('keys') && (shot || isDevHost())) {
      await sheets;
      debug.playKeys(params.get('keys'), { scenes, frozen });
    }
  }
}

async function boot() {
  const debug = forcePlay ? await import('./debug.js').catch(() => null) : null;
  const shot = debug ? debug.readShot(params) : null;
  const forcedGate = debug ? debug.readGate(params) : null;

  persist = !shot;
  if (persist) prefs = loadPrefs();
  applyPrefs();
  audio.init();

  env = detectEnv();
  // Before startGame: install.js must hear visibilitychange / pagehide ahead of wireLifecycle.
  registerSW({ beforeReload: save, canReload });

  const mode = forcedGate || gateMode(env, { forcePlay, trial: prefs.trial === true });
  if (mode === 'game') {
    await startGame(debug, shot);
    return;
  }
  // No save is created behind a gate: the game only starts if the player asks for a trial.
  // A forced gate (debug) is shown as its usual audience sees it: Safari for the install
  // guide, KakaoTalk for the escape screen.
  const gateEnv = !forcedGate ? env
    : forcedGate === 'escape' ? { ...env, ios: true, inApp: env.inApp || 'kakaotalk' }
      : { ...env, ios: true, safari: true, inApp: null };
  mountGate($('gateRoot'), mode, gateEnv, {
    auto: !forcedGate,
    onPlayHere() {
      app.setPrefs({ trial: true });
      startGame(debug, null).catch(bootFailed);
    },
  });
}

function bootFailed(err) {
  console.error('[pumal] boot failed:', err);
  // With ?play=1 the message itself is shown, so a headless screenshot reveals what broke.
  setCaption(forcePlay ? String(err && err.message ? err.message : err) : '문제가 생겼어요. 다시 열어 줘요');
}

boot().catch(bootFailed);
