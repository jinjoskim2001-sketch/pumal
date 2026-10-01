// Chiptune beeps for the device (SPEC section 8).
//
// Web Audio only. An <audio> element anywhere in the app would switch iOS to the
// media-playback session, which ignores the silent switch and pauses the owner's music;
// the "ambient" session keeps the pet as polite as a native game.
//
// Everything here is progressive enhancement: with no AudioContext, no document, or a
// context iOS refuses to start, every call is a silent no-op and the game must still read
// correctly from the screen alone.

const g = globalThis;

// ---------------------------------------------------------------------------------------
// Pitch palette
//
// Our own tuning: a 32768 Hz reference divided by whole numbers 8..29, the way a one-chip
// piezo buzzer makes tones. It lands in the 1.1-4.1 kHz buzzer band and gives a slightly
// "off" just-intonation scale, so every jingle below is written for this scale.
// Home key is do1 (divider 24, 1365 Hz); do-mi-sol-do is nearly pure, re/la/ti are a touch
// sour, and there is no mi above do2 (the top notes are me2, fa2, sol2).
// ---------------------------------------------------------------------------------------

const CLOCK_HZ = 32768;

const DIVIDER = {
  la0: 29, te0: 27,                                             // below the home note
  do1: 24, re1: 21, me1: 20, mi1: 19, fa1: 18, fi1: 17,         // me = flat mi, fi = sharp fa
  sol1: 16, le1: 15, la1: 14, ti1: 13,                          // le = flat la
  do2: 12, re2: 11, me2: 10, fa2: 9, sol2: 8,
  zz1: 28, zz2: 26, zz3: 25, zz4: 23, zz5: 22,                  // between-the-keys tones for grumpy sounds
};

export const PITCH = Object.fromEntries(
  Object.entries(DIVIDER).map(([name, n]) => [name, CLOCK_HZ / n]),
);

// ---------------------------------------------------------------------------------------
// The one table to tweak: name -> [gain, pattern]
//
// pattern = space-separated "pitch:milliseconds"; "-" is a rest. A pitch is a PITCH name or
// a plain number in Hz. Gain stays within 0.05-0.10 (square waves are loud). A whole sound
// stays under 1.6 s. Sounds of 100 ms or less are "ticks" and layer over a running jingle;
// anything longer takes over the single melody voice, like a real one-buzzer toy.
// All patterns are composed for this project.
// ---------------------------------------------------------------------------------------

export const SOUNDS = {
  // keys and menus
  key:       [0.05, 'do2:24'],
  select:    [0.05, 'sol1:36'],
  confirm:   [0.06, 'do1:45 sol1:45 do2:90'],
  cancel:    [0.06, 'sol1:50 do1:90'],
  deny:      [0.08, 'zz2:80 -:40 zz1:140'],
  toast:     [0.05, 'la1:45 -:35 la1:70'],
  light:     [0.05, 'do2:18 -:45 sol1:28'],

  // care
  eat:       [0.07, 'fa1:40 -:25 do1:55 -:110 fa1:40 -:25 do1:55'],
  snack:     [0.06, 'sol1:35 -:20 do2:45 -:100 sol1:35 -:20 do2:45'],
  clean:     [0.06, 'do1:22 re1:22 mi1:22 fa1:22 sol1:22 la1:22 ti1:22 do2:22 -:60 sol2:45 -:45 sol2:80'],
  medicine:  [0.06, 'do2:40 -:60 do2:40 -:60 la1:40 sol1:120'],
  cured:     [0.07, 'do1:60 re1:60 mi1:60 sol1:60 la1:60 do2:220'],
  pet:       [0.05, 'sol1:30 la1:30 sol1:30 la1:30 do2:80'],
  scold:     [0.08, 'fa1:90 -:30 re1:90 -:30 fa1:90 -:30 re1:170'],

  // moods
  happy:     [0.06, 'do1:45 sol1:45 -:45 mi1:45 do2:45 -:45 sol1:45 sol2:140'],
  sad:       [0.06, 'sol1:150 me1:150 do1:280'],
  call:      [0.07, 're1:18 mi1:60 -:50 fi1:18 sol1:120'],
  tantrum:   [0.09, 'zz5:50 zz4:50 zz5:50 zz4:50 zz5:50 zz4:50 -:40 zz2:60 -:30 zz2:160'],
  sleep:     [0.05, 'do2:140 -:40 sol1:140 -:40 mi1:140 -:40 do1:320'],
  wake:      [0.06, 'mi1:70 sol1:70 -:50 mi1:70 sol1:70 -:50 do2:220'],

  // mini-games
  countdown: [0.06, 'fa1:80'],
  rps:       [0.06, 'do1:40 -:50 mi1:40 -:50 sol1:40 -:50 do2:110'],
  point:     [0.06, 'do2:40 sol2:80'],
  miss:      [0.06, 'me1:50 do1:110'],
  win:       [0.08, 'mi1:70 sol1:70 do2:70 sol1:70 do2:70 sol2:240'],
  lose:      [0.07, 'me1:110 do1:110 -:60 me1:110 do1:110 -:60 te0:320'],

  // life events
  hatch:     [0.08, 'do1:22 -:70 do1:22 -:50 do1:22 -:90 do1:70 mi1:70 sol1:70 -:30 sol1:55 do2:230'],
  evolve:    [0.08, 'do1:80 mi1:80 sol1:150 -:40 mi1:80 sol1:80 do2:150 -:40 sol1:70 do2:70 sol2:260'],
  mature:    [0.07, 'do1:140 sol1:140 mi1:140 do2:320'],
  depart:    [0.06, 'do2:110 sol1:110 -:70 do2:110 sol1:110 -:70 la1:110 sol1:110 mi1:110 do1:320'],
  death:     [0.06, 'sol1:200 fa1:200 me1:200 do1:200 te0:200 la0:460'],
  newEgg:    [0.06, 'do1:45 me1:45 sol1:45 do2:45 me2:45 sol2:140'],
};

// ---------------------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------------------

const ATTACK_S = 0.004;      // SPEC: 4 ms attack
const LEAD_S = 0.008;        // schedule a few render quanta ahead so the attack is never cut
const HIGHPASS_HZ = 800;     // tiny-buzzer character; also removes envelope thump
const MASTER_GAIN = 1;       // overall trim; per-note gains above already sit at 0.05-0.10
const TICK_MS = 100;         // sounds this short never interrupt a jingle
const WATCH_MS = 400;        // how long the audio clock gets to prove it is moving
const KICK_GAP_MS = 200;     // pause between suspend() and resume() on rung 2 (WebKit bug 281566)
const FROZEN_MS = 250;       // "running" but currentTime unchanged for this long = stuck clock
const MAX_REBUILDS = 3;      // stop recreating contexts when there is clearly no audio device
// A key's sound is requested on pointerdown, but a finger only grants audio activation on
// touchend. Keep the most recent locked-out request this long so the unlocking tap itself
// still clicks (it then lands together with the haptic tick). 0 = strict "drop when locked".
const REPLAY_MS = 300;

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

let ctx = null;
let bus = null;              // highpass -> master gain -> destination; every note feeds the highpass
let enabled = true;
let inited = false;
let verified = false;        // the clock was seen advancing since the last reason to doubt it
let rung = 0;                // 0 = plain resume, 1 = suspend+resume already tried
let needRebuild = false;     // rung 3 decided; carried out inside the next real tap
let rebuilds = 0;
let watchTimer = null;
let probe = null;            // { c, wall, t }: last time the audio clock was seen to move
let voice = null;            // { out, oscs, end }: the one melody voice
let pending = null;          // { name, at }: see REPLAY_MS
let parsed = null;

const noop = () => {};
const wallMs = () => Date.now();

function isHidden() {
  const d = g.document;
  return !!d && (d.hidden === true || d.visibilityState === 'hidden');
}

function sound(name) {
  if (!parsed) parsed = new Map();
  if (parsed.has(name)) return parsed.get(name);
  let out = null;
  const row = Object.prototype.hasOwnProperty.call(SOUNDS, name) ? SOUNDS[name] : null;
  if (row) {
    const gain = Math.min(0.10, Math.max(0.05, Number(row[0]) || 0.06));
    const notes = [];
    let total = 0;
    for (const tok of String(row[1]).trim().split(/\s+/)) {
      const [p, ms] = tok.split(':');
      const dur = Math.max(0, Number(ms) || 0) / 1000;
      // An unknown pitch name becomes a rest: a typo must not take the whole app down.
      const hz = p === '-' ? 0 : (PITCH[p] || Number(p) || 0);
      notes.push([hz, dur]);
      total += dur;
    }
    out = { gain, notes, total, tick: total * 1000 <= TICK_MS };
  }
  parsed.set(name, out);
  return out;
}

// ---------------------------------------------------------------------------------------
// Context lifecycle
// ---------------------------------------------------------------------------------------

function pinSession() {
  // 'ambient' = respect the silent switch and mix with the owner's music. Web Audio alone
  // already resolves to it, but pinning protects us if another module ever adds a media
  // element. The API is Safari-only, so feature-detect.
  try {
    const s = g.navigator && g.navigator.audioSession;
    if (s && s.type !== 'ambient') s.type = 'ambient';
  } catch { /* read-only or unsupported */ }
}

function build() {
  const AC = g.AudioContext || g.webkitAudioContext;
  if (!AC) return;
  pinSession();
  let c = null;
  try { c = new AC({ latencyHint: 'interactive' }); } catch {
    try { c = new AC(); } catch { c = null; }
  }
  if (!c) return;
  try {
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = HIGHPASS_HZ;
    const m = c.createGain();
    m.gain.value = MASTER_GAIN;
    hp.connect(m);
    m.connect(c.destination);
    bus = hp;
  } catch {
    try { c.close(); } catch { /* ignore */ }
    return;
  }
  // iOS moves the context to 'interrupted' on backgrounding, calls and Siri without
  // always firing visibilitychange; any such change is a reason to re-check the clock.
  c.onstatechange = () => { if (c === ctx && c.state !== 'running') verified = false; };
  ctx = c;
  verified = false;
  rung = 0;
  probe = null;
  voice = null;
}

function teardown() {
  const c = ctx;
  ctx = null; bus = null; voice = null; probe = null;
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (!c) return;
  c.onstatechange = null;
  // Safari caps the number of live contexts, so the old one must be closed, not dropped.
  try { const p = c.close(); if (p && p.catch) p.catch(noop); } catch { /* already closed */ }
}

function resume(c) {
  try {
    const p = c.resume();
    if (p && p.then) p.then(() => { if (c === ctx) flushPending(); }, noop);
  } catch { /* closed */ }
}

// Rungs 2 and 3 of the recovery ladder. State alone cannot be trusted on iOS (WebKit bugs
// 263627 and 291892: 'running' with a frozen clock), so the test is that currentTime moves.
function armWatchdog() {
  if (watchTimer || !ctx) return;
  const c = ctx;
  const t0 = c.currentTime;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    if (c !== ctx) return;
    if (isHidden()) return;                       // the clock is allowed to stop while hidden
    if (c.state === 'running' && c.currentTime > t0) {
      verified = true; rung = 0; rebuilds = 0;
      probe = { c, wall: wallMs(), t: c.currentTime };
      return;
    }
    if (rung === 0) {
      rung = 1;
      try { const p = c.suspend(); if (p && p.catch) p.catch(noop); } catch { /* ignore */ }
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (c !== ctx) return;
        resume(c);
        armWatchdog();
      }, KICK_GAP_MS);
    } else if (rebuilds < MAX_REBUILDS) {
      needRebuild = true;                         // close + recreate must happen inside a tap
    }
  }, WATCH_MS);
}

function clockFrozen(c) {
  const wall = wallMs();
  const t = c.currentTime;
  if (!probe || probe.c !== c || t > probe.t) { probe = { c, wall, t }; return false; }
  return wall - probe.wall >= FROZEN_MS;
}

function gesture(trusted) {
  if (!enabled || isHidden()) return;
  if (trusted) {
    // Creating (and rung 3, recreating) only ever happens inside a real gesture, where iOS
    // lets a new context start running at once.
    if (needRebuild) {
      needRebuild = false;
      rebuilds += 1;
      teardown();
    }
    if (ctx && ctx.state === 'closed') teardown();
    if (!ctx) build();
  }
  if (!ctx || ctx.state === 'closed') return;
  if (ctx.state !== 'running') {
    verified = false;
    resume(ctx);
  } else {
    flushPending();
  }
  // Only a real gesture may start the clock, so only a real gesture may convict it.
  if (trusted && !verified) armWatchdog();
}

function onVisible() {
  if (isHidden()) return;
  verified = false;
  rebuilds = 0;
  // Usually enough on its own; when it is not, the next tap climbs the ladder.
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') resume(ctx);
}

function onHidden() {
  pending = null;
  // An interrupted context keeps its schedule and would finish the jingle on return.
  silence();
}

// ---------------------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------------------

function tone(c, out, hz, t, dur, vol, bag) {
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(hz, t);
  // Release by time constant, never an exponential ramp to 0 (that throws / clicks).
  const tc = Math.min(0.008, Math.max(0.003, dur / 10));
  const release = t + Math.max(ATTACK_S, dur - 3 * tc);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + ATTACK_S);
  env.gain.setTargetAtTime(0, release, tc);
  osc.connect(env);
  env.connect(out);
  osc.onended = () => { try { env.disconnect(); } catch { /* ignore */ } };
  osc.start(t);
  osc.stop(t + dur + 5 * tc);                     // 8 time constants after release: inaudible
  if (bag) bag.push(osc);
}

function silence() {
  const v = voice;
  voice = null;
  if (!v || !ctx) return;
  const now = ctx.currentTime;
  if (now > v.end) return;
  try {
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setTargetAtTime(0, now, 0.003);
  } catch { /* ignore */ }
  for (const o of v.oscs) { try { o.stop(now + 0.03); } catch { /* not started / ended */ } }
}

function schedule(s) {
  const c = ctx;
  let t = c.currentTime + LEAD_S;
  let out = bus;
  let bag = null;
  if (!s.tick) {
    silence();
    const vg = c.createGain();
    vg.gain.value = 1;
    vg.connect(bus);
    out = vg;
    bag = [];
    voice = { out: vg, oscs: bag, end: t + s.total + 0.05 };
  }
  for (const [hz, dur] of s.notes) {
    if (hz > 0 && dur > 0) tone(c, out, hz, t, dur, s.gain, bag);
    t += dur;
  }
  if (bag && bag.length) {
    const last = bag[bag.length - 1];
    const inner = last.onended;
    last.onended = () => { inner(); try { out.disconnect(); } catch { /* ignore */ } };
  }
}

function flushPending() {
  const p = pending;
  pending = null;
  if (!p || !enabled || isHidden() || needRebuild || !ctx || ctx.state !== 'running') return;
  if (wallMs() - p.at > REPLAY_MS) return;
  const s = sound(p.name);
  if (s) { try { schedule(s); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

function unlock() {
  // Callers may invoke this from pointerdown, which is not an activation event for a
  // finger. Where the browser can tell us, only treat it as a gesture when it really is.
  const ua = g.navigator && g.navigator.userActivation;
  gesture(ua ? ua.isActive === true : true);
}

function init() {
  if (inited) return;
  inited = true;
  pinSession();
  const d = g.document;
  if (!d || typeof d.addEventListener !== 'function') return;
  // touchend / click / keydown are the events that grant activation on iOS (not touchstart,
  // not a finger's pointerdown). They stay attached for good: the context has to be
  // re-resumed after every interruption, and a pet is opened many times a day.
  const onGesture = () => gesture(true);
  for (const type of ['touchend', 'click', 'keydown']) d.addEventListener(type, onGesture, true);
  d.addEventListener('visibilitychange', () => (isHidden() ? onHidden() : onVisible()));
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('pageshow', onVisible);
    g.addEventListener('focus', onVisible);
    g.addEventListener('pagehide', onHidden);
  }
}

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) {
    pending = null;
    silence();
    return;
  }
  // Turning sound on in settings is itself a tap; use it so the next beep is not lost.
  const ua = g.navigator && g.navigator.userActivation;
  if (ua && ua.isActive === true) gesture(true);
}

function isEnabled() {
  return enabled;
}

function play(name) {
  try {
    if (!enabled) return;
    const s = sound(name);
    if (!s) return;
    if (isHidden()) { pending = null; return; }   // dropped, never queued
    const remember = () => { pending = REPLAY_MS > 0 ? { name, at: wallMs() } : null; };
    if (!ctx || needRebuild || ctx.state === 'closed') { remember(); return; }
    if (ctx.state !== 'running') {                // rung 1
      verified = false;
      remember();
      resume(ctx);
      return;
    }
    if (clockFrozen(ctx)) {
      // Notes put on a stopped clock would all burst out later. Drop, and let the next
      // tap run the watchdog.
      verified = false;
      return;
    }
    schedule(s);
  } catch { /* sound must never break the game */ }
}

export const audio = { unlock, init, setEnabled, isEnabled, play };
