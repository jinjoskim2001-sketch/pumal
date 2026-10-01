// Tests for js/audio.js and js/haptics.js with a minimal fake Web Audio / DOM.
// They check scheduling and the recovery ladder; nobody can hear anything here.
import test from 'node:test';
import assert from 'node:assert/strict';

const SPEC_NAMES = [
  'key', 'select', 'confirm', 'cancel', 'deny', 'eat', 'snack', 'happy', 'sad', 'call',
  'tantrum', 'scold', 'clean', 'medicine', 'cured', 'hatch', 'evolve', 'sleep', 'wake',
  'light', 'win', 'lose', 'point', 'miss', 'countdown', 'rps', 'pet', 'mature', 'depart',
  'death', 'newEgg', 'toast',
];

// ---------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------

class FakeParam {
  constructor(value) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.events.push({ kind: 'set', v, t }); return this; }
  linearRampToValueAtTime(v, t) { this.events.push({ kind: 'lin', v, t }); return this; }
  setTargetAtTime(v, t, tc) { this.events.push({ kind: 'target', v, t, tc }); return this; }
  cancelScheduledValues(t) { this.events.push({ kind: 'cancel', t }); return this; }
  exponentialRampToValueAtTime() { throw new Error('exponential ramps are banned by the spec'); }
}

class FakeNode {
  constructor(kind) { this.kind = kind; this.outputs = []; }
  connect(dest) { this.outputs.push(dest); return dest; }
  disconnect() { this.outputs = []; }
}

function makeFakeAudioContext(behavior) {
  return class FakeAudioContext {
    static instances = [];
    constructor(opts) {
      this.opts = opts;
      this.state = behavior.startState;
      this.destination = new FakeNode('destination');
      this.oscillators = [];
      this.gains = [];
      this.calls = { resume: 0, suspend: 0, close: 0 };
      this.onstatechange = null;
      this._t = 0;
      this._since = Date.now();
      FakeAudioContext.instances.push(this);
    }
    get currentTime() {
      const moving = this.state === 'running' && behavior.clockRuns;
      return this._t + (moving ? (Date.now() - this._since) / 1000 : 0);
    }
    _freeze() { this._t = this.currentTime; this._since = Date.now(); }
    createOscillator() {
      const o = new FakeNode('osc');
      o.type = 'sine';
      o.frequency = new FakeParam(440);
      o.started = null; o.stopped = [];
      o.start = (t) => { assert.equal(o.started, null, 'start() twice'); o.started = t; };
      o.stop = (t) => { assert.notEqual(o.started, null, 'stop() before start()'); o.stopped.push(t); };
      this.oscillators.push(o);
      return o;
    }
    createGain() {
      const n = new FakeNode('gain');
      n.gain = new FakeParam(1);
      this.gains.push(n);
      return n;
    }
    createBiquadFilter() {
      const n = new FakeNode('filter');
      n.type = 'lowpass';
      n.frequency = new FakeParam(350);
      this.filter = n;
      return n;
    }
    resume() {
      this.calls.resume += 1;
      if (behavior.resumeWorks && this.state !== 'closed') { this._freeze(); this.state = 'running'; }
      return Promise.resolve();
    }
    suspend() {
      this.calls.suspend += 1;
      if (this.state === 'running') { this._freeze(); this.state = 'suspended'; }
      return Promise.resolve();
    }
    close() { this.calls.close += 1; this._freeze(); this.state = 'closed'; return Promise.resolve(); }
  };
}

function fakeDocument() {
  const listeners = {};
  return {
    hidden: false,
    visibilityState: 'visible',
    listeners,
    addEventListener(type, fn, opt) { (listeners[type] ||= []).push({ fn, opt }); },
    fire(type) { for (const l of listeners[type] || []) l.fn({ type }); },
    setHidden(h) {
      this.hidden = h;
      this.visibilityState = h ? 'hidden' : 'visible';
      this.fire('visibilitychange');
    },
  };
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let importCount = 0;

// Installs fakes on globalThis, imports a fresh copy of the module, and returns handles.
async function setup(t, opts = {}) {
  const behavior = { startState: 'suspended', resumeWorks: true, clockRuns: true, ...opts.behavior };
  const doc = opts.document === false ? undefined : fakeDocument();
  const AC = opts.audio === false ? undefined : makeFakeAudioContext(behavior);
  const nav = { userAgent: 'node-test', ...opts.navigator };
  if (doc) globalThis.document = doc;
  if (AC) globalThis.AudioContext = AC;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  t.after(() => {
    delete globalThis.document;
    delete globalThis.AudioContext;
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete globalThis.navigator;
  });
  const mod = await import(new URL(`../js/audio.js?case=${++importCount}`, import.meta.url).href);
  return { ...mod, doc, AC, nav, behavior };
}

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function reachesDestination(node, ctx, seen = new Set()) {
  if (node === ctx.destination) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.outputs.some((n) => reachesDestination(n, ctx, seen));
}

// A context that is created, unlocked by a tap and proven healthy.
async function unlocked(t, opts) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = await setup(t, opts);
  env.audio.init();
  env.doc.fire('touchend');
  await settle();
  t.mock.timers.tick(450);
  env.ctx = env.AC.instances[0];
  return env;
}

// ---------------------------------------------------------------------------------------
// audio.js
// ---------------------------------------------------------------------------------------

test('no AudioContext and no document: every call is a silent no-op', async (t) => {
  const { audio } = await setup(t, { audio: false, document: false });
  assert.doesNotThrow(() => {
    audio.init();
    audio.unlock();
    for (const name of SPEC_NAMES) audio.play(name);
    audio.play('no-such-sound');
    audio.setEnabled(false);
    audio.setEnabled(true);
    audio.unlock();
    audio.play('key');
  });
  assert.equal(audio.isEnabled(), true);
});

test('no AudioContext but a document: init and taps do not throw', async (t) => {
  const { audio, doc } = await setup(t, { audio: false });
  assert.doesNotThrow(() => {
    audio.init();
    doc.fire('touchend'); doc.fire('click'); doc.fire('keydown');
    doc.setHidden(true); doc.setHidden(false);
    for (const name of SPEC_NAMES) audio.play(name);
  });
});

test('a constructor that throws is survived', async (t) => {
  const { audio, doc } = await setup(t);
  globalThis.AudioContext = class { constructor() { throw new Error('no audio hardware'); } };
  audio.init();
  assert.doesNotThrow(() => { doc.fire('click'); audio.play('key'); });
});

test('the table holds exactly the names in the spec', async (t) => {
  const { SOUNDS } = await setup(t);
  assert.deepEqual(Object.keys(SOUNDS).sort(), [...SPEC_NAMES].sort());
});

test('pitch palette stays in the 1.1-4.1 kHz piezo band', async (t) => {
  const { PITCH } = await setup(t);
  for (const [name, hz] of Object.entries(PITCH)) {
    assert.ok(hz >= 1100 && hz <= 4100, `${name} = ${hz}`);
  }
});

test('every pattern token is well formed', async (t) => {
  const { SOUNDS, PITCH } = await setup(t);
  for (const [name, [gain, pattern]] of Object.entries(SOUNDS)) {
    assert.ok(gain >= 0.05 && gain <= 0.10, `${name} gain ${gain}`);
    let total = 0;
    for (const tok of pattern.split(/\s+/)) {
      const m = /^([a-z0-9]+|-):(\d+)$/.exec(tok);
      assert.ok(m, `${name}: bad token "${tok}"`);
      if (m[1] !== '-') assert.ok(PITCH[m[1]] > 0, `${name}: unknown pitch "${m[1]}"`);
      assert.ok(Number(m[2]) > 0, `${name}: zero-length "${tok}"`);
      total += Number(m[2]);
    }
    assert.ok(total <= 1600, `${name} lasts ${total} ms`);
  }
});

test('every spec name schedules at least one square oscillator on the audio clock', async (t) => {
  const env = await unlocked(t);
  const { audio, ctx } = env;
  assert.equal(ctx.state, 'running');
  const realSetTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = (...a) => { timers += 1; return realSetTimeout(...a); };
  t.after(() => { globalThis.setTimeout = realSetTimeout; });

  for (const name of SPEC_NAMES) {
    const before = ctx.oscillators.length;
    const now = ctx.currentTime;
    audio.play(name);
    const oscs = ctx.oscillators.slice(before);
    assert.ok(oscs.length >= 1, `${name} scheduled no oscillator`);
    let prev = -Infinity;
    for (const o of oscs) {
      assert.equal(o.type, 'square', name);
      const f = o.frequency.events.at(-1).v;
      assert.ok(f >= 1100 && f <= 4100, `${name}: ${f} Hz`);
      assert.ok(o.started >= now, `${name}: started in the past`);
      assert.ok(o.started >= prev, `${name}: notes out of order`);
      prev = o.started;
      assert.equal(o.stopped.length, 1, `${name}: every note is stopped once`);
      assert.ok(o.stopped[0] > o.started);
      assert.ok(o.stopped[0] - now <= 1.7, `${name}: runs past 1.6 s`);
      assert.ok(reachesDestination(o, ctx), `${name}: note not routed to the destination`);

      // own gain envelope: 0 -> 4 ms linear attack -> setTargetAtTime release
      const env1 = o.outputs[0];
      assert.equal(env1.kind, 'gain');
      const [e0, e1, e2] = env1.gain.events;
      assert.deepEqual([e0.kind, e0.v, e0.t], ['set', 0, o.started]);
      assert.equal(e1.kind, 'lin');
      assert.ok(Math.abs(e1.t - o.started - 0.004) < 1e-9, `${name}: attack is not 4 ms`);
      assert.ok(e1.v >= 0.05 && e1.v <= 0.10, `${name}: gain ${e1.v}`);
      assert.deepEqual([e2.kind, e2.v], ['target', 0]);
      assert.ok(e2.t >= e1.t && e2.tc > 0);
      assert.equal(env1.gain.events.length, 3);
    }
  }
  assert.equal(timers, 0, 'play() must not use setTimeout');
  assert.equal(env.AC.instances.length, 1, 'one shared context');
});

test('key click is inaudible after 35 ms', async (t) => {
  const { audio, ctx } = await unlocked(t);
  audio.play('key');
  assert.equal(ctx.oscillators.length, 1);
  const o = ctx.oscillators[0];
  const rel = o.outputs[0].gain.events[2];
  // setTargetAtTime decays as exp(-dt / tc); -40 dB is ln(100) time constants.
  const silentAt = rel.t + rel.tc * Math.log(100) - o.started;
  assert.ok(silentAt <= 0.035, `key is audible for ${(silentAt * 1000).toFixed(1)} ms`);
});

test('play() is a no-op when disabled', async (t) => {
  const { audio, ctx } = await unlocked(t);
  audio.setEnabled(false);
  assert.equal(audio.isEnabled(), false);
  for (const name of SPEC_NAMES) audio.play(name);
  assert.equal(ctx.oscillators.length, 0);
  assert.equal(ctx.calls.resume, 1, 'no extra resume while disabled');
  audio.setEnabled(true);
  assert.equal(audio.isEnabled(), true);
  audio.play('confirm');
  assert.ok(ctx.oscillators.length > 0);
});

test('a disabled module does not even create a context on taps', async (t) => {
  const { audio, doc, AC } = await setup(t);
  audio.setEnabled(false);
  audio.init();
  doc.fire('touchend'); doc.fire('click');
  audio.unlock();
  assert.equal(AC.instances.length, 0);
});

test('play() is a no-op while document.hidden, and nothing is queued for later', async (t) => {
  const { audio, doc, ctx } = await unlocked(t);
  doc.setHidden(true);
  for (const name of SPEC_NAMES) audio.play(name);
  assert.equal(ctx.oscillators.length, 0);
  doc.setHidden(false);
  doc.fire('touchend');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(ctx.oscillators.length, 0, 'sounds requested while hidden must be dropped');
});

test('taps while hidden do not touch the context', async (t) => {
  const { audio, doc, AC } = await setup(t);
  audio.init();
  doc.hidden = true; doc.visibilityState = 'hidden';
  doc.fire('touchend');
  assert.equal(AC.instances.length, 0);
});

test('play() never creates a context by itself (locked = silent)', async (t) => {
  const { audio, AC } = await setup(t);
  audio.init();
  for (const name of SPEC_NAMES) audio.play(name);
  assert.equal(AC.instances.length, 0);
});

test('the tap that unlocks still clicks, but a stale request is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { audio, doc, AC } = await setup(t);
  audio.init();
  audio.play('key');                 // pointerdown: still locked
  t.mock.timers.tick(120);
  doc.fire('touchend');              // the gesture
  await settle();
  const ctx = AC.instances[0];
  assert.equal(ctx.oscillators.length, 1, 'recent request replays inside the gesture');

  // a new lock (interruption), a request, and a slow finger
  ctx.state = 'interrupted';
  FakeHelpers.blockResume(ctx);
  audio.play('confirm');
  t.mock.timers.tick(900);
  FakeHelpers.unblockResume(ctx);
  doc.fire('touchend');
  await settle();
  assert.equal(ctx.oscillators.length, 1, 'a request older than the replay window is dropped');
});

const FakeHelpers = {
  blockResume(ctx) { ctx._resume = ctx.resume; ctx.resume = () => { ctx.calls.resume += 1; return Promise.resolve(); }; },
  unblockResume(ctx) { ctx.resume = ctx._resume; },
};

test('one shared interactive context and an ambient audio session', async (t) => {
  const session = { type: 'auto' };
  const { audio, doc, AC } = await setup(t, { navigator: { audioSession: session } });
  audio.init();
  assert.equal(session.type, 'ambient', 'pinned at init');
  assert.equal(AC.instances.length, 0, 'no context before a gesture');
  doc.fire('touchend'); doc.fire('click'); doc.fire('keydown');
  audio.unlock(); audio.unlock();
  assert.equal(AC.instances.length, 1);
  assert.deepEqual(AC.instances[0].opts, { latencyHint: 'interactive' });
  assert.equal(AC.instances[0].filter.type, 'highpass');
  assert.equal(AC.instances[0].filter.frequency.value, 800);
});

test('init() attaches permanent capture listeners once', async (t) => {
  const { audio, doc } = await setup(t);
  audio.init();
  audio.init();
  for (const type of ['touchend', 'click', 'keydown']) {
    assert.equal(doc.listeners[type].length, 1, type);
    assert.equal(doc.listeners[type][0].opt, true, `${type} must be a capture listener`);
  }
  assert.equal(doc.listeners.visibilitychange.length, 1);
  assert.equal(doc.listeners.touchstart, undefined, 'touchstart does not unlock audio on iOS');
});

test('unlock() outside a real gesture does not create or convict a context', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const activation = { isActive: false };
  const { audio, AC } = await setup(t, { navigator: { userActivation: activation } });
  audio.init();
  audio.unlock();                    // e.g. called from a finger's pointerdown
  assert.equal(AC.instances.length, 0);
  activation.isActive = true;
  audio.unlock();
  assert.equal(AC.instances.length, 1);
});

test('ladder rung 1: play() and a tap resume a context that is not running', async (t) => {
  const { audio, doc, ctx } = await unlocked(t);
  ctx._freeze(); ctx.state = 'interrupted';
  const before = ctx.calls.resume;
  audio.play('key');
  assert.equal(ctx.calls.resume, before + 1);
  await settle();
  ctx._freeze(); ctx.state = 'interrupted';
  doc.fire('touchend');
  assert.equal(ctx.calls.resume, before + 2);
});

test('ladder: a healthy clock is never suspended or closed', async (t) => {
  const { audio, doc, ctx, AC } = await unlocked(t);
  for (let i = 0; i < 20; i++) {
    doc.fire('touchend'); doc.fire('click');
    audio.play('key');
    t.mock.timers.tick(300);
    await settle();
  }
  doc.setHidden(true); doc.setHidden(false);
  doc.fire('touchend');
  t.mock.timers.tick(2000);
  assert.equal(ctx.calls.suspend, 0);
  assert.equal(ctx.calls.close, 0);
  assert.equal(AC.instances.length, 1);
  assert.equal(ctx.oscillators.length, 20);
});

test('ladder rungs 2 and 3: frozen clock -> suspend+resume -> close and recreate inside the next tap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { audio, doc, AC, behavior } = await setup(t, { behavior: { startState: 'suspended', clockRuns: false } });
  audio.init();
  doc.fire('touchend');              // gesture-time resume: state says running, clock is stuck
  await settle();
  const first = AC.instances[0];
  assert.equal(first.state, 'running');
  assert.equal(first.calls.resume, 1);

  t.mock.timers.tick(399);
  assert.equal(first.calls.suspend, 0, 'the clock gets ~400 ms to move');
  t.mock.timers.tick(1);
  assert.equal(first.calls.suspend, 1, 'rung 2 starts with suspend()');
  await settle();
  t.mock.timers.tick(200);
  assert.equal(first.calls.resume, 2, 'rung 2 ends with resume()');
  await settle();

  t.mock.timers.tick(400);
  assert.equal(first.calls.close, 0, 'recreating waits for a tap');
  assert.equal(AC.instances.length, 1);
  audio.play('key');
  assert.equal(first.oscillators.length, 0, 'nothing is scheduled on a context that is given up on');

  behavior.clockRuns = true;         // the replacement works
  t.mock.timers.tick(500);           // let that request go stale so it is not replayed
  doc.fire('touchend');
  await settle();
  assert.equal(first.calls.close, 1, 'old context closed');
  assert.equal(AC.instances.length, 2, 'new context created inside the tap');
  const second = AC.instances[1];
  t.mock.timers.tick(450);
  audio.play('key');
  assert.equal(second.oscillators.length, 1);
  assert.equal(second.calls.suspend, 0);
});

test('ladder gives up recreating after a few failures until the app is shown again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { audio, doc, AC } = await setup(t, { behavior: { startState: 'suspended', clockRuns: false } });
  audio.init();
  for (let i = 0; i < 12; i++) {
    doc.fire('touchend');
    await settle();
    t.mock.timers.tick(400); await settle();
    t.mock.timers.tick(200); await settle();
    t.mock.timers.tick(400); await settle();
  }
  assert.equal(AC.instances.length, 4, 'first context + 3 rebuilds');
  assert.equal(AC.instances.filter((c) => c.state !== 'closed').length, 1, 'old contexts are closed');
});

test('a clock that stops while "running" drops sounds instead of piling them up', async (t) => {
  const { audio, ctx, behavior } = await unlocked(t);
  audio.play('key');
  assert.equal(ctx.oscillators.length, 1);
  ctx._freeze(); behavior.clockRuns = false;   // WebKit bug 263627
  audio.play('key');                           // same instant: cannot tell yet
  t.mock.timers.tick(300);
  audio.play('key');
  audio.play('evolve');
  assert.equal(ctx.oscillators.length, 2);
});

test('return to visible tries resume() and sound works again', async (t) => {
  const { audio, doc, ctx } = await unlocked(t);
  doc.setHidden(true);
  ctx._freeze(); ctx.state = 'interrupted';
  const before = ctx.calls.resume;
  doc.setHidden(false);
  assert.equal(ctx.calls.resume, before + 1);
  await settle();
  t.mock.timers.tick(50);
  audio.play('happy');
  assert.ok(ctx.oscillators.length > 0);
});

test('one melody voice: a new jingle cuts the old one, ticks layer on top', async (t) => {
  const { audio, ctx } = await unlocked(t);
  audio.play('evolve');
  const first = ctx.oscillators.slice();
  t.mock.timers.tick(100);
  audio.play('key');
  assert.ok(first.every((o) => o.stopped.length === 1), 'a key click does not cut the jingle');
  audio.play('happy');
  const cutAt = ctx.currentTime;
  for (const o of first) {
    assert.equal(o.stopped.length, 2);
    assert.ok(o.stopped[1] <= cutAt + 0.05, 'old notes are stopped right away');
  }
});

test('hiding the app cuts a running jingle', async (t) => {
  const { audio, doc, ctx } = await unlocked(t);
  audio.play('death');
  const notes = ctx.oscillators.slice();
  t.mock.timers.tick(100);
  doc.setHidden(true);
  assert.ok(notes.every((o) => o.stopped.length === 2));
});

test('turning sound off cuts a running jingle', async (t) => {
  const { audio, ctx } = await unlocked(t);
  audio.play('evolve');
  const notes = ctx.oscillators.slice();
  audio.setEnabled(false);
  assert.ok(notes.every((o) => o.stopped.length === 2));
});

// ---------------------------------------------------------------------------------------
// haptics.js
// ---------------------------------------------------------------------------------------

function fakeDom() {
  const makeStyle = () => ({ setProperty(k, v) { this[k] = v; } });
  const doc = {
    observers: [],
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), ownerDocument: doc, style: makeStyle(), attrs: {},
        children: [], parentNode: null, listeners: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) {
          if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
          c.parentNode = this; this.children.push(c); return c;
        },
        addEventListener(type, fn, opt) { (this.listeners[type] ||= []).push({ fn, opt }); },
        click() { throw new Error('scripted click() is forbidden (untrusted since iOS 26.5)'); },
      };
    },
    defaultView: {
      getComputedStyle: (el) => ({ position: el.style.position || 'static' }),
      MutationObserver: class {
        constructor(cb) { this.cb = cb; doc.observers.push(this); }
        observe(el, opts) { this.el = el; this.opts = opts; }
      },
    },
  };
  return doc;
}

async function setupHaptics(t, nav) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  t.after(() => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete globalThis.navigator;
  });
  return import(new URL(`../js/haptics.js?case=${++importCount}`, import.meta.url).href);
}

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', platform: 'iPhone', maxTouchPoints: 5 };

test('haptics: nothing throws without a DOM', async (t) => {
  const h = await setupHaptics(t, { userAgent: 'node' });
  assert.doesNotThrow(() => {
    h.attachHaptic(null);
    h.attachHaptic({});
    h.setHapticsEnabled(false);
    h.setHapticsEnabled(true);
  });
  assert.equal(h.hapticsKind(), 'none');
});

test('haptics: iOS gets a label overlay with a hidden native switch', async (t) => {
  const h = await setupHaptics(t, IPHONE);
  const doc = fakeDom();
  const key = doc.createElement('div');
  h.attachHaptic(key);
  h.attachHaptic(key);
  assert.equal(h.hapticsKind(), 'switch');
  assert.equal(key.children.length, 1, 'idempotent');
  assert.equal(key.style.position, 'relative', 'static host becomes the containing block');

  const label = key.children[0];
  assert.equal(label.tagName, 'LABEL');
  assert.equal(label.attrs['data-haptic-trigger'], '');
  assert.equal(label.attrs['aria-hidden'], 'true');
  assert.equal(label.style.position, 'absolute');
  assert.equal(label.style.inset, '0');
  assert.equal(label.style.touchAction, 'manipulation');

  const sw = label.children[0];
  assert.equal(sw.tagName, 'INPUT');
  assert.equal(sw.type, 'checkbox');
  assert.equal(sw.attrs.switch, '');
  assert.equal(sw.style.width, '1px');
  assert.equal(sw.style.height, '1px');
  assert.equal(sw.style.visibility, 'hidden');
  assert.equal(sw.style.display, undefined, 'display:none would kill the haptic');
  assert.equal(sw.style.appearance, undefined, 'the switch must keep its native appearance');

  let stopped = 0;
  sw.listeners.click[0].fn({ stopPropagation() { stopped += 1; } });
  assert.equal(stopped, 1, 'the forwarded click must not reach the host a second time');
  assert.equal(key.listeners.pointerdown, undefined, 'no vibrate listener on iOS');
});

test('haptics: disabling takes the labels out of hit-testing, enabling restores them', async (t) => {
  const h = await setupHaptics(t, IPHONE);
  const doc = fakeDom();
  const a = doc.createElement('div');
  const b = doc.createElement('div');
  h.attachHaptic(a);
  h.setHapticsEnabled(false);
  h.attachHaptic(b);                  // attached while disabled
  assert.equal(a.children[0].style.pointerEvents, 'none');
  assert.equal(b.children[0].style.pointerEvents, 'none');
  h.setHapticsEnabled(true);
  assert.equal(a.children[0].style.pointerEvents, '');
  assert.equal(b.children[0].style.pointerEvents, '');
});

test('haptics: the overlay is put back when the host content is rewritten', async (t) => {
  const h = await setupHaptics(t, IPHONE);
  const doc = fakeDom();
  const key = doc.createElement('div');
  h.attachHaptic(key);
  const label = key.children[0];
  key.children = []; label.parentNode = null;        // host.textContent = 'A'
  assert.deepEqual(doc.observers[0].opts, { childList: true });
  doc.observers[0].cb();
  assert.equal(key.children[0], label);
  doc.observers[0].cb();
  assert.equal(key.children.length, 1);
});

test('haptics: iPadOS reporting as a Mac is treated as iOS; a real Mac is not', async (t) => {
  const pad = await setupHaptics(t, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(pad.hapticsKind(), 'switch');
  const mac = await setupHaptics(t, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(mac.hapticsKind(), 'none');
  const doc = fakeDom();
  const key = doc.createElement('div');
  mac.attachHaptic(key);
  assert.equal(key.children.length, 0, 'no overlay off iOS');
});

test('haptics: Android vibrates 8 ms on pointerdown and respects the setting', async (t) => {
  const buzz = [];
  const h = await setupHaptics(t, { userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140 Mobile', vibrate: (ms) => { buzz.push(ms); return true; } });
  const doc = fakeDom();
  const key = doc.createElement('div');
  h.attachHaptic(key);
  h.attachHaptic(key);
  assert.equal(h.hapticsKind(), 'vibrate');
  assert.equal(key.children.length, 0);
  assert.equal(key.listeners.pointerdown.length, 1);
  const down = key.listeners.pointerdown[0].fn;
  down({ isPrimary: true });
  down({ isPrimary: false });          // second finger
  assert.deepEqual(buzz, [8]);
  h.setHapticsEnabled(false);
  down({ isPrimary: true });
  assert.deepEqual(buzz, [8]);
  h.setHapticsEnabled(true);
  down({ isPrimary: true });
  assert.deepEqual(buzz, [8, 8]);
});
