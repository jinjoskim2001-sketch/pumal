// js/lcd.js against a minimal fake DOM: pitch choice, hit testing, and the draw primitives.
// Nothing here looks at pixels; the look is checked by eye with tools/demo-shell.html.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeContext() {
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
}

function fakeCanvas() {
  return { width: 0, height: 0, style: {}, dataset: {}, getContext: () => fakeContext() };
}

function install({ hostWidth = 300, dpr = 3, reduced = true } = {}) {
  const listeners = {};
  const host = { clientWidth: hostWidth, clientHeight: 0, getAttribute: () => '' };
  const canvas = fakeCanvas();
  canvas.parentElement = host;
  canvas.closest = () => host;
  canvas.box = { left: 0, top: 0 };
  canvas.getBoundingClientRect = () => {
    const w = parseFloat(canvas.style.width), h = parseFloat(canvas.style.height);
    return { left: canvas.box.left, top: canvas.box.top, width: w, height: h };
  };
  globalThis.document = { createElement: () => fakeCanvas() };
  globalThis.window = {
    devicePixelRatio: dpr,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: () => {},
  };
  globalThis.getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' });
  globalThis.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  delete globalThis.ResizeObserver;
  return { canvas, host, listeners };
}

const { createLCD, COLS, ROWS } = await import('../js/lcd.js');

const FONT = {
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  ':': ['.', '#', '.', '#', '.'],
  ' ': ['...', '...', '...', '...', '...'],
};

test('matrix size is the one the spec fixes', () => {
  assert.equal(COLS, 48);
  assert.equal(ROWS, 32);
});

test('pitch is the largest integer that fits 50 dots, clamped', () => {
  for (const [width, pitch] of [[300, 6], [299, 5], [301, 6], [250, 5], [351, 7], [200, 4], [1000, 8], [120, 2], [60, 2]]) {
    const { canvas } = install({ hostWidth: width });
    const lcd = createLCD(canvas);
    assert.equal(lcd.pitch, pitch, `host ${width}`);
    assert.equal(canvas.style.width, `${pitch * 50}px`);
    assert.equal(canvas.style.height, `${pitch * 50}px`);
    assert.equal(canvas.width, pitch * 50 * 3);
    lcd.destroy();
  }
});

test('backing store follows devicePixelRatio but never above 3', () => {
  for (const [dpr, store] of [[1, 300], [2, 600], [3, 900], [4, 900]]) {
    const { canvas } = install({ hostWidth: 300, dpr });
    const lcd = createLCD(canvas);
    assert.equal(canvas.width, store);
    lcd.destroy();
  }
});

test('an unlaid-out host keeps a usable default instead of collapsing', () => {
  const { canvas } = install({ hostWidth: 0 });
  const lcd = createLCD(canvas);
  assert.equal(lcd.pitch, 6);
  lcd.destroy();
});

test('hitTest maps icons, matrix and outside', () => {
  const { canvas } = install({ hostWidth: 300 });
  const lcd = createLCD(canvas);
  canvas.box = { left: 40, top: 100 };
  const at = (u, v) => lcd.hitTest(40 + u * 6, 100 + v * 6);
  assert.deepEqual(at(2, 3), { zone: 'icon', index: 0 });
  assert.deepEqual(at(20, 5), { zone: 'icon', index: 1 });
  assert.deepEqual(at(48, 5), { zone: 'icon', index: 3 });
  assert.deepEqual(at(7, 45), { zone: 'icon', index: 4 });
  assert.deepEqual(at(44, 46), { zone: 'icon', index: 7 });
  assert.deepEqual(at(1.5, 9.5), { zone: 'matrix', x: 0, y: 0 });
  assert.deepEqual(at(48.5, 40.5), { zone: 'matrix', x: 47, y: 31 });
  assert.deepEqual(at(11.5, 14.5), { zone: 'matrix', x: 10, y: 5 });
  // the 1-dot margin belongs to the nearest zone
  assert.deepEqual(at(0.2, 20), { zone: 'matrix', x: 0, y: 11 });
  assert.deepEqual(at(49.8, 0.2), { zone: 'icon', index: 3 });
  assert.equal(at(-0.5, 20), null);
  assert.equal(at(20, 50.5), null);
  lcd.destroy();
});

test('hitTest stays right after the container changes size', () => {
  const { canvas, host, listeners } = install({ hostWidth: 300 });
  const lcd = createLCD(canvas);
  host.clientWidth = 210;
  listeners.resize();                       // the module listens for window resize itself
  assert.equal(lcd.pitch, 4);
  canvas.box = { left: 10, top: 10 };
  assert.deepEqual(lcd.hitTest(10 + 11.5 * 4, 10 + 14.5 * 4), { zone: 'matrix', x: 10, y: 5 });
  host.clientWidth = 400;
  lcd.resize();
  assert.equal(lcd.pitch, 8);
  assert.deepEqual(lcd.hitTest(10 + 11.5 * 8, 10 + 14.5 * 8), { zone: 'matrix', x: 10, y: 5 });
  // a transformed (scaled) device still resolves, because the live box is used
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  assert.deepEqual(lcd.hitTest(11.5 * 4, 14.5 * 4), { zone: 'matrix', x: 10, y: 5 });
  lcd.destroy();
});

test('the canvas element is reused, never replaced', () => {
  const { canvas, host } = install({ hostWidth: 300 });
  let created = 0;
  const make = globalThis.document.createElement;
  const lcd = createLCD(canvas);
  globalThis.document.createElement = (tag) => { created += 1; return make(tag); };
  host.clientWidth = 260;
  lcd.resize();
  assert.equal(lcd.canvas, canvas);
  assert.equal(canvas.style.width, '250px');
  lcd.resize();                             // same pitch: nothing is rebuilt
  const afterFirst = created;
  lcd.resize();
  assert.equal(created, afterFirst);
  lcd.destroy();
});

test('dot, rect and frame clip silently at the edges', () => {
  const { canvas } = install();
  const lcd = createLCD(canvas);
  lcd.clear();
  lcd.dot(-1, 0); lcd.dot(48, 0); lcd.dot(0, 32); lcd.dot(47, 31);
  assert.equal(lcd.peek(47, 31), true);
  lcd.rect(46, 30, 10, 10);
  assert.equal(lcd.peek(46, 30), true);
  lcd.rect(46, 30, 1, 1, false);
  assert.equal(lcd.peek(46, 30), false);
  lcd.clear();
  lcd.frame(1, 1, 4, 3);
  assert.equal(lcd.peek(1, 1), true);
  assert.equal(lcd.peek(4, 3), true);
  assert.equal(lcd.peek(2, 2), false);
  lcd.destroy();
});

test('sprite: plain, flipX, clear and invert', () => {
  const { canvas } = install();
  const lcd = createLCD(canvas);
  const bmp = ['#..', '##.'];
  lcd.clear();
  lcd.sprite(bmp, 5, 5);
  assert.deepEqual([lcd.peek(5, 5), lcd.peek(6, 5), lcd.peek(7, 5)], [true, false, false]);
  assert.deepEqual([lcd.peek(5, 6), lcd.peek(6, 6), lcd.peek(7, 6)], [true, true, false]);

  lcd.clear();
  lcd.sprite(bmp, 5, 5, { flipX: true });
  assert.deepEqual([lcd.peek(5, 5), lcd.peek(6, 5), lcd.peek(7, 5)], [false, false, true]);
  assert.deepEqual([lcd.peek(5, 6), lcd.peek(6, 6), lcd.peek(7, 6)], [false, true, true]);

  lcd.clear();
  lcd.rect(5, 5, 3, 2);
  lcd.sprite(bmp, 5, 5);                    // '.' leaves what is there
  assert.equal(lcd.peek(7, 5), true);
  lcd.sprite(bmp, 5, 5, { clear: true });   // '.' wipes
  assert.equal(lcd.peek(7, 5), false);
  assert.equal(lcd.peek(5, 5), true);

  lcd.clear();
  lcd.sprite(bmp, 5, 5, { invert: true });
  assert.deepEqual([lcd.peek(5, 5), lcd.peek(6, 5), lcd.peek(7, 5)], [false, true, true]);
  lcd.destroy();
});

test('text: returns the x after the last glyph and matches textWidth', () => {
  const { canvas } = install();
  const lcd = createLCD(canvas);
  lcd.clear();
  assert.equal(lcd.textWidth('1:1', FONT), 3 + 1 + 1 + 1 + 3);
  const end = lcd.text('1:1', 10, 2, FONT);
  assert.equal(end, 10 + lcd.textWidth('1:1', FONT));
  assert.equal(lcd.peek(11, 2), true);       // top of the first '1'
  assert.equal(lcd.peek(14, 3), true);       // upper dot of ':'
  assert.equal(lcd.textWidth('', FONT), 0);
  assert.equal(lcd.text('', 7, 0, FONT), 7);
  // a character the font lacks advances like a space instead of throwing
  assert.equal(lcd.textWidth('1?1', FONT), 3 + 1 + 3 + 1 + 3);
  lcd.destroy();
});

test('state setters accept odd input', () => {
  const { canvas } = install();
  const lcd = createLCD(canvas);
  lcd.setTint('nope');
  assert.equal(canvas.dataset.tint, 'pea');
  lcd.setTint('glow');
  assert.equal(canvas.dataset.tint, 'glow');
  lcd.setBackdrop('night'); lcd.setBackdrop(null); lcd.setBackdrop('???');
  lcd.setIcons([['#']], undefined);
  lcd.setIconState({ selected: 9, lit: [0, 7] });
  lcd.setIconState({ selected: -1 });
  lcd.setIconState();
  lcd.present();
  lcd.snap();
  lcd.destroy();
});
