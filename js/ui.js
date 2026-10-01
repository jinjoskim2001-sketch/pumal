// Everything outside the glass that is not the device itself: bottom sheets and toasts
// (SPEC 11.5). The only runtime dependency is the `app` object built in js/main.js; species
// copy, unlock rules, tuning numbers, the save-code decoder and pixel art are read-only imports.
//
// Constraints that shape this file:
// - Sheets live in #sheetRoot, which is empty (display: none) whenever nothing is open, so a
//   closed UI adds no fixed or transparent layer over the page.
// - Only `transform` and `opacity` are ever animated. Open/close are CSS transitions (they can
//   be interrupted and retargeted); while a finger drags a sheet the transform is written
//   directly and the transition is off.
// - User text (pet names, save codes) only ever reaches the DOM through textContent / value.
// - `app.state` may be replaced wholesale (import, reset), so it is re-read on every render and
//   never cached.

import {
  SPECIES, SPECIES_IDS, STAGE_ORDER, SKINS, DEFAULT_NAMES, DEFAULT_NAME, NAME_MAX, postcardText,
  NEGLECT_MISTAKES, OLD_AGE_START, MIN_AWAKE_MIN,
} from './data.js';
import { SPECIES_ART, ITEMS } from './sprites.js';
// Only the decoder: a save code is read here to tell the player what importing it will do.
import { importCode as decodeCode } from './storage.js';

// ---- look-up tables ---------------------------------------------------------------------

// Same numbers as js/lcd.js (SPEC 6); repeated because the portraits are separate canvases.
const TINTS = {
  pea: { bg: '#C5CFA4', ink: '#1E2A1C', label: '완두' },
  warm: { bg: '#C9CBBE', ink: '#22252E', label: '회색' },
  amber: { bg: '#F2B84B', ink: '#2A1E08', label: '호박' },
};

// Swatch paint only. The real colourways are the #device[data-skin] blocks in css/app.css.
const SKIN_LIST = [
  { id: 'milk', label: '밀크', shell: '#F3EFE4', shade: '#CFC8B6', key: '#FFC83D', accent: '#D93F1C' },
  { id: 'grape', label: '포도', shell: '#6A48F0', shade: '#3F27B8', key: '#FFD23F', accent: '#FF7AB8' },
  { id: 'graphite', label: '그래파이트', shell: '#2A2C31', shade: '#0B0C0E', key: '#E9E9EC', accent: '#FF4B3A' },
  { id: 'ice', label: '아이스', shell: '#B4C2CF', shade: '#55616C', key: '#F5F5F7', accent: '#FF8A3D' },
  { id: 'lagoon', label: '라군', shell: '#0B7F86', shade: '#075A60', key: '#FFE9A8', accent: '#FF7A59' },
  { id: 'sakura', label: '벚꽃', shell: '#E8588A', shade: '#B43863', key: '#FFF4C2', accent: '#8E2450' },
];

const STAGE_LABEL = { baby: '아기', child: '어린이', teen: '청소년', adult: '어른', special: '특별한 모습' };

// 매운맛 has to say the two things that cost a pet: hours alone end in a star, and a web app
// that is closed cannot call its owner. No minutes here: the grace periods are tuning numbers
// in js/data.js and this line must stay true when they change.
const MODE_COPY = {
  gentle: '오래 비워도 괜찮아요. 아무도 별이 되지 않아요.',
  classic: '시간이 멈추지 않아요. 여러 시간 혼자 두면 별이 될 수 있고, 앱은 알림을 보내지 못해요.',
};

// Pixel glyphs for the sheet chrome, authored like the LCD art and drawn as crisp SVG rects.
const GLYPHS = {
  chevron: ['#...', '##..', '.##.', '..##', '.##.', '##..', '#...'],
  check: ['......##', '.....##.', '....##..', '##.##...', '.###....', '..#.....'],
  lock: ['..###..', '.#...#.', '.#...#.', '#######', '#######', '###.###', '###.###', '#######'],
  share: ['....#....', '...###...', '..#.#.#..', '....#....', '##..#..##', '#...#...#', '#.......#', '#.......#', '#########'],
  copy: ['..######', '..#....#', '###....#', '#.#....#', '#.#....#', '#.######', '#....#..', '######..'],
  paste: ['..####..', '###..###', '#......#', '#.####.#', '#......#', '#.####.#', '#......#', '########'],
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
};

// A day shorter than MIN_AWAKE_MIN (js/data.js; the engine refuses it too) is turned down in
// 설정 with a reason. Wake == bed leaves the pet no day at all.
// A tap on the dim closes a sheet only once the sheet has been up this long.
const BACKDROP_ARM_MS = 350;

const TOAST_MS = 2200;
const TOAST_LEAVE_MS = 140;      // css/app.css: add .is-leaving this long before removing
const FLIP_MS = 500;             // the same 2 fps idle flip as inside the glass

// ---- small DOM helpers ------------------------------------------------------------------

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (val == null || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = val;
      else if (key === 'on') for (const type of Object.keys(val)) node.addEventListener(type, val[type]);
      else if (key === 'style') node.style.cssText = val;
      else node.setAttribute(key, val === true ? '' : String(val));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid);
  }
  return node;
}

function glyph(name, scale = 2) {
  const rows = GLYPHS[name];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const w = rows[0].length, h = rows.length;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w * scale));
  svg.setAttribute('height', String(h * scale));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `glyph glyph-${name}`);
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      if (row[x] !== '#') continue;
      let run = 1;
      while (row[x + run] === '#') run++;
      d += `M${x} ${y}h${run}v1h${-run}z`;
      x += run - 1;
    }
  });
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

function minToTime(min) {
  const m = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function timeToMin(text) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(text));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
}

const clipName = (text) => Array.from(String(text).normalize('NFC')).slice(0, NAME_MAX).join('');

// → null when the two times make a day the pet can live in, otherwise why they do not.
function scheduleProblem(wakeMin, bedMin) {
  if (!Number.isFinite(wakeMin) || !Number.isFinite(bedMin)) return 'unset';
  if (wakeMin === bedMin) return 'same';
  return (bedMin - wakeMin + 1440) % 1440 < MIN_AWAKE_MIN ? 'short' : null;   // bed may be after midnight
}

const SCHEDULE_TOAST = {
  same: '기상과 취침 시간은 달라야 해요',
  short: `깨어 있는 시간이 ${MIN_AWAKE_MIN / 60}시간은 되어야 해요`,
  refused: '시간을 바꾸지 못했어요',
};

// The audio session is pinned to ambient (js/audio.js), so on an iPhone the ring/silent switch
// mutes every beep while this switch still reads "on".
const soundHint = (env) => (env && env.ios ? '무음 모드에서는 소리가 나지 않아요' : null);

// The pet's name is typed by the owner, so the particle after it is chosen at run time.
function endsInConsonant(word) {
  const text = String(word || '');
  const code = text.charCodeAt(text.length - 1) - 0xAC00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;    // not Hangul: treat as an open syllable
}
const withEunNeun = (word) => word + (endsInConsonant(word) ? '은' : '는');
const withIGa = (word) => word + (endsInConsonant(word) ? '이' : '가');

const petName = (state) => {
  const name = state && state.pet && state.pet.name;
  return typeof name === 'string' && name ? name : DEFAULT_NAME;
};

// What 매운맛 would do to this pet in its first minute. 순한맛 never ends a pet for its adult
// care mistakes and never looks at its age; 매운맛 does both, so a pet can already be past
// either line when its owner flips the switch. The engine lets a pet that outlived its
// lifespan re-enter 매운맛 on the edge of old age (setMode), which still means the first
// old-age sickness in the next waking minute. → 'neglect' | 'old' | null
function classicSwitchRisk(state) {
  const pet = state && state.pet;
  if (!pet || pet.alive === false) return null;
  const sp = Object.prototype.hasOwnProperty.call(SPECIES, pet.species) ? SPECIES[pet.species] : null;
  if (!sp || (sp.stage !== 'adult' && sp.stage !== 'special')) return null;
  if (Number(pet.adultMistakes) >= NEGLECT_MISTAKES) return 'neglect';
  return sp.lifespanMin && Number(pet.adultAwakeMin) / sp.lifespanMin >= OLD_AGE_START ? 'old' : null;
}

// Second line of the confirm before a switch to 매운맛: what the rule means for this pet.
function classicSwitchNote(state) {
  const name = petName(state);
  const risk = classicSwitchRisk(state);
  if (risk === 'neglect') return `돌봄 실수가 많이 쌓여서, 바꾸면 ${withIGa(name)} 곧 별이 돼요.`;
  if (risk === 'old') return `${withEunNeun(name)} 이미 나이가 많아서, 바꾸면 곧 아플 수 있어요.`;
  return null;
}

// Reads a save code without importing it: how long ago it was saved and whether its pet is
// still alive. → null when the text is not a code.
function peekCode(text, nowMs) {
  let save;
  try { save = decodeCode(text); } catch (err) { return null; }
  return {
    ageMin: Math.max(0, Math.floor((nowMs - save.lastTick) / 60000)) || 0,
    alive: !save.pet || save.pet.alive !== false,
  };
}

// Second line of the import confirm. A code is a snapshot: an old one takes the pet, the 도감
// and the album back to that day, so its age is said before anything is overwritten.
function importNote(peek) {
  if (!peek || peek.ageMin < 60) return null;
  const hours = Math.floor(peek.ageMin / 60);
  const ago = hours >= 48 ? `${Math.floor(hours / 24)}일` : `${hours}시간`;
  return `${ago} 전에 저장한 코드예요. 그 뒤에 있었던 일은 담겨 있지 않아요.`;
}

// `peek` is what the code held, `view` is the pet the import actually left on the screen.
// The toast follows the outcome, never the hope: no "반가워요" over a pet that is a star.
function importToast(peek, view) {
  if (!view || view.alive !== false) return '가져왔어요. 다시 만나 반가워요!';
  return peek && peek.alive ? '가져왔어요. 그사이 펫이 별이 되었어요' : '가져왔어요';
}

// Whether a click on the dim may close its sheet. Sheets are opened on pointerdown (a key, the
// LCD), so the click of that same touch arrives when the finger lifts and lands on the dim
// that has just appeared under it, however long the press lasted. Only a press that also
// started on the dim counts, and not during the first moment, when a tap aimed at whatever
// was there before the sheet is still on its way. A modal sheet never closes this way.
function backdropGuard(layer, now) {
  let armed = false;
  return {
    down() { armed = !layer.modal && now() - layer.openedAt > BACKDROP_ARM_MS; },
    click() {
      const ok = armed;
      armed = false;
      return ok;
    },
  };
}

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { return false; }
};

// ---- pixel portraits --------------------------------------------------------------------

// Hollow outline sprites would give outline "silhouettes". Flood the outside from the canvas
// edge (4-connected, so a diagonal outline step does not leak) and fill everything else.
function solidMask(bitmap) {
  const rows = bitmap.length, cols = bitmap[0].length;
  const lit = bitmap.map((row) => Array.from(row, (c) => c === '#'));
  const outside = bitmap.map(() => new Array(cols).fill(false));
  const stack = [];
  const visit = (x, y) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows || outside[y][x] || lit[y][x]) return;
    outside[y][x] = true;
    stack.push(x, y);
  };
  for (let x = 0; x < cols; x++) { visit(x, 0); visit(x, rows - 1); }
  for (let y = 0; y < rows; y++) { visit(0, y); visit(cols - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
  }
  return outside.map((row) => row.map((out) => !out));
}

// One sprite on a pea panel with the LCD look: faint ghost dots everywhere, ink dots with a
// gap between them and a soft shadow down-right. Integer device px per dot, like lcd.js.
function drawPortrait(canvas, bitmap, opts) {
  const { pitch = 4, tint = 'pea', silhouette = false, margin = 1 } = opts || {};
  const marginX = opts && opts.marginX != null ? opts.marginX : margin;
  const marginY = opts && opts.marginY != null ? opts.marginY : margin;
  const rows = bitmap.length, cols = bitmap[0].length;
  const W = cols + marginX * 2, H = rows + marginY * 2;
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const cell = Math.max(2, Math.round(pitch * dpr));
  const gap = Math.max(1, Math.round(cell * 0.11));
  const dot = cell - gap;
  const off = Math.max(1, Math.min(gap, Math.round(cell * 0.12)));
  const colours = TINTS[tint] || TINTS.pea;

  canvas.width = W * cell;
  canvas.height = H * cell;
  canvas.style.width = `${W * pitch}px`;
  canvas.style.height = `${H * pitch}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = colours.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const mask = silhouette ? solidMask(bitmap) : bitmap.map((row) => Array.from(row, (c) => c === '#'));
  const o = Math.floor(gap / 2);
  const each = (fn) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - marginX, sy = y - marginY;
      fn(x * cell + o, y * cell + o, sx >= 0 && sy >= 0 && sx < cols && sy < rows && mask[sy][sx]);
    }
  };

  ctx.fillStyle = colours.ink;
  ctx.globalAlpha = 0.09;
  each((px, py) => ctx.fillRect(px, py, dot, dot));
  ctx.globalAlpha = 0.22;
  each((px, py, on) => { if (on) ctx.fillRect(px + off, py + off, dot, dot); });
  // an unknown creature is printed a little weaker, like a segment that is not driven
  ctx.globalAlpha = silhouette ? 0.74 : 0.92;
  each((px, py, on) => { if (on) ctx.fillRect(px, py, dot, dot); });
  ctx.globalAlpha = 1;
}

function artFor(id) {
  const art = SPECIES_ART && (SPECIES_ART[id] || SPECIES_ART.egg);
  const frames = art && Array.isArray(art.idle) ? art.idle.filter(Array.isArray) : [];
  return frames.length ? frames : null;
}

// → <span class="pt"> holding one or two stacked canvases (idle frames) and a glass overlay.
function portrait(id, opts) {
  const { pitch = 4, tint = 'pea', silhouette = false, live = false } = opts || {};
  const frames = artFor(id);
  const box = el('span', { class: `pt${live && !silhouette ? ' pt-live' : ''}${silhouette ? ' pt-unknown' : ''}`, 'aria-hidden': 'true' });
  box.style.setProperty('--pt', `${18 * pitch}px`);
  if (frames) {
    const use = live && !silhouette && frames.length > 1 ? frames.slice(0, 2) : frames.slice(0, 1);
    use.forEach((bmp, i) => {
      const canvas = el('canvas', { class: `pt-f pt-f${i}` });
      try { drawPortrait(canvas, bmp, { pitch, tint, silhouette }); } catch (err) { /* a blank tile is fine */ }
      box.append(canvas);
    });
  }
  box.append(el('i', { class: 'pt-glass' }));
  return box;
}

// Pure helpers, exposed for tests/ui.test.js only.
export const _test = {
  solidMask, minToTime, timeToMin, clipName, fmtDate, SKIN_LIST, TINTS, GLYPHS,
  MODE_COPY, MIN_AWAKE_MIN, BACKDROP_ARM_MS, scheduleProblem, soundHint, withEunNeun, withIGa,
  classicSwitchRisk, classicSwitchNote, peekCode, importNote, importToast, backdropGuard,
};

// ---- the UI -----------------------------------------------------------------------------

export function initUI(app) {
  let root = document.getElementById('sheetRoot');
  if (!root) {
    root = el('div', { id: 'sheetRoot' });
    document.body.append(root);
  }
  const layers = [];               // bottom → top; public open() always starts a fresh stack
  let returnFocus = null;
  let flipTimer = 0;
  let uid = 0;

  const prefs = () => app.prefs || {};
  const state = () => app.state || {};
  const viewNow = () => {
    try { return app.view() || {}; } catch (err) { return {}; }
  };
  const tintNow = () => (TINTS[prefs().tint] ? prefs().tint : 'pea');
  const dexCount = () => {
    const dex = state().dex || {};
    return SPECIES_IDS.filter((id) => dex[id] != null).length;
  };
  const skinUnlocked = (id) => !(id in SKINS) || dexCount() >= SKINS[id];

  function applyAccent() {
    root.dataset.skin = SKIN_LIST.some((s) => s.id === prefs().skin) ? prefs().skin : 'milk';
  }

  // ---- toasts ---------------------------------------------------------------------------

  function toast(text) {
    const host = document.getElementById('toastRoot');
    if (!host || text == null || text === '') return;
    // one line at a time: a newer message replaces the one on screen
    for (const old of Array.from(host.children)) leaveToast(old);
    const node = el('div', { text: String(text), role: 'status' });
    host.append(node);
    node._timer = setTimeout(() => leaveToast(node), TOAST_MS - TOAST_LEAVE_MS);
  }

  function leaveToast(node) {
    if (node._leaving) return;
    node._leaving = true;
    clearTimeout(node._timer);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), TOAST_LEAVE_MS);
  }

  // ---- layer plumbing -------------------------------------------------------------------

  function announce() {
    const top = layers[layers.length - 1];
    try {
      window.dispatchEvent(new CustomEvent('pumal:sheet', { detail: { open: layers.length > 0, name: top ? top.name : null } }));
    } catch (err) { /* CustomEvent missing: nobody is listening anyway */ }
  }

  function setBackgroundInert(on) {
    const stage = document.getElementById('stage');
    if (!stage) return;
    stage.inert = on;
    if (on) stage.setAttribute('aria-hidden', 'true'); else stage.removeAttribute('aria-hidden');
  }

  function syncStack() {
    layers.forEach((layer, i) => {
      const under = i < layers.length - 1;
      layer.el.classList.toggle('is-under', under);
      layer.el.inert = under;
    });
    root.dataset.depth = String(layers.length);
  }

  function syncFlip() {
    const need = layers.length > 0 && root.querySelector('.pt-live') != null;
    if (need && !flipTimer) {
      flipTimer = setInterval(() => {
        if (document.hidden) return;
        root.dataset.flip = root.dataset.flip === '1' ? '0' : '1';
      }, FLIP_MS);
    } else if (!need && flipTimer) {
      clearInterval(flipTimer);
      flipTimer = 0;
      root.dataset.flip = '0';
    }
  }

  // Two things can hide the bottom of the page without resizing it: the on-screen keyboard
  // (it overlays the page on iOS) and Safari's toolbar in a tab, where 100vh is taller than
  // what is visible. Lift the sheets by the hidden strip instead of letting them sit under it.
  function syncKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const hidden = Math.max(0, root.getBoundingClientRect().bottom - (vv.offsetTop + vv.height));
    const lifted = hidden > 1;
    root.style.setProperty('--kb', lifted ? `${Math.round(hidden)}px` : '0px');
    if (lifted) root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    else root.style.removeProperty('--vvh');
    root.classList.toggle('has-kb', hidden > 120);     // tall enough to be a keyboard
  }

  function focusables(layer) {
    return Array.from(layer.sheet.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
      .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
  }

  // Capture on window and stop the event there: the device keys (a / s / d, arrows, Enter,
  // Space) are wired by scenes on document or window, and typing a name must not feed the pet.
  // Default actions (typing, button activation) are untouched by stopPropagation.
  function onKeyDown(e) {
    const top = layers[layers.length - 1];
    if (!top) return;
    e.stopPropagation();
    const composing = e.isComposing || e.keyCode === 229;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLayer(top, 'escape');
    } else if (e.key === 'Tab') {
      const items = focusables(top);
      if (!items.length) { e.preventDefault(); top.sheet.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!top.sheet.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (active === first || active === top.sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Enter' && !composing && top.onEnter && e.target instanceof HTMLInputElement && e.target.type === 'text') {
      e.preventDefault();
      top.onEnter();
    }
  }

  function onKeyOther(e) {
    if (layers.length) e.stopPropagation();
  }

  function listen(on) {
    const fn = on ? 'addEventListener' : 'removeEventListener';
    window[fn]('keydown', onKeyDown, true);
    window[fn]('keyup', onKeyOther, true);
    window[fn]('keypress', onKeyOther, true);
    if (window.visualViewport) {
      window.visualViewport[fn]('resize', syncKeyboard);
      window.visualViewport[fn]('scroll', syncKeyboard);
    }
  }

  // ---- building a layer -----------------------------------------------------------------

  function pushLayer(name, opts) {
    const build = BUILDERS[name];
    if (!build) return null;
    const first = layers.length === 0;
    if (first) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      applyAccent();
    }

    const id = `sheet${++uid}`;
    const layer = { name, id, opts: opts || {}, closed: false, modal: false, openedAt: performance.now(), onEnter: null, onClosed: null, focus: null };
    layer.dim = el('div', { class: 'sheet-dim' });
    layer.title = el('h2', { class: 'sheet-title', id: `${id}-title` });
    layer.closeBtn = el('button', { class: 'sheet-close', type: 'button', text: '닫기', on: { click: () => closeLayer(layer, 'close') } });
    layer.bar = el('div', { class: 'sheet-bar' }, layer.title, layer.closeBtn);
    layer.head = el('header', { class: 'sheet-head' }, el('span', { class: 'sheet-grab', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'), el('i')), layer.bar);
    layer.body = el('div', { class: 'sheet-body' });
    layer.foot = el('footer', { class: 'sheet-foot', hidden: true });
    layer.sheet = el('section', {
      class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, tabindex: '-1',
    }, layer.head, layer.body, layer.foot);
    layer.el = el('div', { class: 'sheet-layer', 'data-sheet': name }, layer.dim, layer.sheet);

    build(layer, layer.opts);

    const guard = backdropGuard(layer, () => performance.now());
    layer.dim.addEventListener('pointerdown', guard.down);
    layer.dim.addEventListener('click', () => { if (guard.click()) closeLayer(layer, 'backdrop'); });
    layer.body.addEventListener('scroll', () => {
      layer.sheet.classList.toggle('is-scrolled', layer.body.scrollTop > 2);
    }, { passive: true });
    attachDrag(layer);

    layers.push(layer);
    root.append(layer.el);
    if (first) {
      setBackgroundInert(true);
      listen(true);
      syncKeyboard();
    }
    syncStack();
    syncFlip();

    // Two-step so the transition has a start state to run from.
    void layer.el.offsetHeight;
    layer.el.classList.add('is-open');

    const target = layer.focus && window.matchMedia('(hover: hover) and (pointer: fine)').matches ? layer.focus : layer.sheet;
    try { target.focus({ preventScroll: true }); } catch (err) { /* focus is a nicety */ }
    announce();
    return layer;
  }

  // Takes one layer off the screen: thrown (finishing a drag), instantly, or by the CSS transition.
  function retire(layer, motion) {
    const gone = () => {
      layer.el.remove();
      syncFlip();
      if (!layers.length) {
        root.style.removeProperty('--kb');
        root.style.removeProperty('--vvh');
        root.classList.remove('has-kb');
      }
    };
    layer.closed = true;
    layer.el.inert = true;
    layer.el.classList.add('is-closing');
    if (motion && motion.instant) {
      gone();
    } else if (motion && motion.dragged && !reducedMotion()) {
      // Finish the throw at the speed the finger left it.
      const h = layer.sheet.offsetHeight;
      const rest = Math.max(0, h - motion.offset);
      const ms = Math.round(Math.min(320, Math.max(140, rest / Math.max(motion.velocity, 0.9))));
      layer.sheet.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.6, 0.35, 1)`;
      layer.dim.style.transition = `opacity ${ms}ms linear`;
      layer.sheet.style.transform = `translate3d(0, ${h + 60}px, 0)`;
      layer.dim.style.opacity = '0';
      setTimeout(gone, ms + 30);
    } else {
      layer.dim.style.opacity = '';
      layer.el.classList.remove('is-open');
      setTimeout(gone, reducedMotion() ? 160 : 300);
    }
  }

  // reason: 'close' | 'backdrop' | 'escape' | 'drag' | 'api' | 'done'
  function closeLayer(layer, reason, motion) {
    if (!layer || layer.closed) return;
    const index = layers.indexOf(layer);
    // this layer and anything stacked on it leave together
    const going = index >= 0 ? layers.splice(index) : [layer];
    for (const item of going) retire(item, item === layer || (motion && motion.instant) ? motion : null);

    syncStack();
    if (!layers.length) {
      setBackgroundInert(false);
      listen(false);
      if (returnFocus && document.contains(returnFocus)) {
        try { returnFocus.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      }
      returnFocus = null;
    } else {
      const top = layers[layers.length - 1];
      try { top.sheet.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      if (top.onReturn) top.onReturn();
    }
    for (const item of going.reverse()) {
      if (!item.onClosed) continue;
      try { item.onClosed(item === layer ? reason : 'api'); } catch (err) { console.error(err); }
    }
    announce();
  }

  function closeAll(motion) {
    if (layers.length) closeLayer(layers[0], 'api', motion);
  }

  // ---- drag to dismiss ------------------------------------------------------------------

  // Resistance when a sheet is pulled above its resting place: the further, the less it gives.
  const rubber = (d) => (1 - 1 / (d * 0.55 / 90 + 1)) * 90;

  function attachDrag(layer) {
    const { sheet, head, body, dim } = layer;
    const INTERACTIVE = 'button, a, input, textarea, select, label';
    let drag = null;
    let suppressClick = 0;

    const start = (x, y) => { drag = { x0: x, y0: y, off: 0, far: 0, active: false, h: sheet.offsetHeight, trail: [] }; };

    const activate = (y) => {
      drag.active = true;
      drag.y0 = y;                                   // re-base so the sheet does not jump the slop
      sheet.classList.add('is-dragging');
      layer.el.classList.add('is-dragging');
    };

    const track = (y, t) => {
      const dy = y - drag.y0;
      drag.off = dy >= 0 ? dy : -rubber(-dy);
      drag.far = Math.max(drag.far, Math.abs(dy));
      sheet.style.transform = `translate3d(0, ${drag.off.toFixed(1)}px, 0)`;
      dim.style.opacity = String(1 - Math.min(1, Math.max(0, drag.off / drag.h)) * 0.8);
      drag.trail.push({ y, t });
      while (drag.trail.length > 2 && t - drag.trail[0].t > 100) drag.trail.shift();
    };

    const settle = () => {
      sheet.classList.remove('is-dragging');
      layer.el.classList.remove('is-dragging');
      sheet.style.transform = '';
      dim.style.opacity = '';
    };

    const finish = (cancelled) => {
      const d = drag;
      drag = null;
      if (!d || !d.active) return;
      if (d.far > 6) suppressClick = performance.now();
      const a = d.trail[0], b = d.trail[d.trail.length - 1];
      const v = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;      // px per ms, + is down
      // A flick down dismisses from anywhere; a slow drag has to pass a third of the sheet and
      // must not be on its way back up.
      const dismiss = !cancelled && d.off > 8 && (v > 0.5 || (d.off > d.h * 0.33 && v > -0.15));
      if (dismiss) {
        sheet.classList.remove('is-dragging');
        layer.el.classList.remove('is-dragging');
        closeLayer(layer, 'drag', { dragged: true, offset: d.off, velocity: v });
      } else {
        settle();
      }
    };

    // The click that ends a drag started on a row must not activate that row.
    sheet.addEventListener('click', (e) => {
      if (performance.now() - suppressClick < 350) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // Header: pointer events with capture (touch-action: none in CSS), works for mouse too.
    head.addEventListener('pointerdown', (e) => {
      if (drag || layer.closed || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.target.closest(INTERACTIVE)) return;
      start(e.clientX, e.clientY);
      drag.pid = e.pointerId;
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag || drag.pid !== e.pointerId) return;
      if (!drag.active) {
        if (Math.abs(e.clientY - drag.y0) < 4) return;
        activate(e.clientY);
      }
      track(e.clientY, e.timeStamp);
    });
    const pointerEnd = (cancelled) => (e) => {
      if (!drag || drag.pid !== e.pointerId) return;
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      finish(cancelled);
    };
    head.addEventListener('pointerup', pointerEnd(false));
    head.addEventListener('pointercancel', pointerEnd(true));
    head.addEventListener('lostpointercapture', pointerEnd(true));

    // Body: it scrolls natively (touch-action: pan-y), so pointer events are cancelled as soon
    // as a pan starts. A pull down while already at the top is claimed with touch events
    // before the browser turns it into an overscroll.
    body.addEventListener('touchstart', (e) => {
      if (drag || layer.closed || e.touches.length !== 1) return;
      if (e.target.closest('textarea, input, select')) return;
      if (body.scrollTop > 0) return;
      start(e.touches[0].clientX, e.touches[0].clientY);
      drag.touch = e.touches[0].identifier;
    }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (!drag || drag.touch == null) return;
      const t = Array.from(e.touches).find((p) => p.identifier === drag.touch);
      if (!t) return;
      if (!drag.active) {
        // Decide on the first move: once one touchmove goes by unclaimed, the browser owns the
        // gesture. At the top of the scroller a downward pull can only be an overscroll, so it
        // is ours; anything else (up, sideways, already scrolling) is left alone.
        const dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
        if (dy <= 0 || Math.abs(dx) > dy || !e.cancelable || body.scrollTop > 0) { drag = null; return; }
        activate(t.clientY);
      }
      if (e.cancelable) e.preventDefault();
      track(t.clientY, e.timeStamp);
    }, { passive: false });
    const touchEnd = (cancelled) => (e) => {
      if (!drag || drag.touch == null) return;
      if (Array.from(e.touches).some((p) => p.identifier === drag.touch)) return;    // another finger lifted
      finish(cancelled);
    };
    body.addEventListener('touchend', touchEnd(false));
    body.addEventListener('touchcancel', touchEnd(true));
  }

  // ---- shared pieces --------------------------------------------------------------------

  function button(label, kind, onTap, extra) {
    return el('button', { class: `btn btn-${kind}`, type: 'button', on: { click: onTap }, ...(extra || {}) }, el('span', { text: label }));
  }

  // Segmented control with a thumb that slides by transform. options: [{ id, label }]
  function segmented(label, options, current, onPick) {
    const thumb = el('i', { class: 'seg-thumb', 'aria-hidden': 'true' });
    const box = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, thumb);
    box.style.setProperty('--seg-n', String(options.length));
    const buttons = options.map((opt) => el('button', {
      class: 'seg-btn', type: 'button', role: 'radio', 'data-id': opt.id, text: opt.label,
      on: { click: () => onPick(opt.id) },
    }));
    box.append(...buttons);
    const set = (id) => {
      const i = Math.max(0, options.findIndex((o) => o.id === id));
      box.style.setProperty('--seg-i', String(i));
      buttons.forEach((b, n) => b.setAttribute('aria-checked', String(n === i)));
    };
    set(current);
    return { el: box, set };
  }

  // Opens a confirm sheet on top of whatever is showing and resolves to true / false.
  function ask(opts) {
    return new Promise((resolve) => {
      pushLayer('confirm', { ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
  }

  // ---- 확인 ------------------------------------------------------------------------------

  function buildConfirm(layer, opts) {
    let decided = false;
    layer.el.classList.add('is-fit');
    layer.sheet.setAttribute('role', 'alertdialog');
    layer.title.textContent = opts.title || '확인할게요';
    layer.closeBtn.hidden = true;
    if (opts.body) {
      layer.body.append(el('p', { class: 'confirm-text', id: `${layer.id}-desc`, text: opts.body }));
      // what the general rule means for this pet or this code, set apart so it is not skimmed
      if (opts.note) layer.body.append(el('p', { class: 'confirm-text confirm-note', id: `${layer.id}-note`, text: opts.note }));
      layer.sheet.setAttribute('aria-describedby', opts.note ? `${layer.id}-desc ${layer.id}-note` : `${layer.id}-desc`);
    }
    const cancel = button(opts.cancelLabel || '취소', 'quiet', () => closeLayer(layer, 'close'));
    const ok = button(opts.confirmLabel || '확인', opts.danger ? 'danger' : 'primary', () => {
      decided = true;
      closeLayer(layer, 'done');
      if (opts.onConfirm) opts.onConfirm();
    });
    layer.foot.hidden = false;
    layer.foot.append(cancel, ok);
    // the safe choice gets the focus, so a stray Enter never destroys anything
    layer.focus = opts.danger ? cancel : ok;
    layer.onClosed = () => { if (!decided && opts.onCancel) opts.onCancel(); };
  }

  // ---- 이름 ------------------------------------------------------------------------------

  function buildName(layer, opts) {
    const v = viewNow();
    const first = opts.first === true;
    let done = false;
    layer.el.classList.add('is-fit');
    // The naming sheet comes up once, right after the game asked for taps on the egg, and at
    // phone height the LCD stays in view above it: one tap too many must not dismiss it.
    // 건너뛰기, 확인, Escape and a drag down are still ways out.
    layer.modal = first;
    layer.title.textContent = first ? '이름 지어 주기' : '이름 바꾸기';
    layer.closeBtn.textContent = first ? '건너뛰기' : '닫기';

    const counter = el('span', { class: 'name-count', 'aria-hidden': 'true' });
    const input = el('input', {
      class: 'name-input', type: 'text', id: `${layer.id}-name`, placeholder: first ? DEFAULT_NAME : (v.name || DEFAULT_NAME),
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done',
      'aria-label': `이름 (${NAME_MAX}글자까지)`,
    });
    if (!first && v.name) input.value = clipName(v.name);
    let composing = false;
    const refresh = () => { counter.textContent = `${Array.from(input.value).length}/${NAME_MAX}`; };
    // maxlength fights the Hangul IME (it cuts a syllable while it is still being composed),
    // so the limit is applied by hand once composition has ended.
    const limit = () => {
      if (!composing && Array.from(input.value).length > NAME_MAX) input.value = clipName(input.value);
      refresh();
    };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; limit(); });
    input.addEventListener('input', limit);
    refresh();

    // three suggestions, a different trio for each generation
    const gen = Number(v.gen) || 1;
    const picks = [0, 1, 2].map((i) => DEFAULT_NAMES[((gen - 1) * 3 + i) % DEFAULT_NAMES.length]);
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': '추천 이름' }, picks.map((name) => el('button', {
      class: 'chip-btn', type: 'button', text: name,
      on: { click: () => { input.value = name; refresh(); } },
    })));

    const species = SPECIES[v.species] ? v.species : 'egg';
    layer.body.append(
      el('div', { class: 'name-hero' },
        portrait(species, { pitch: 5, tint: tintNow(), live: true }),
        el('p', { class: 'lead', text: first ? '알에서 깨어났어요!\n뭐라고 부를까요?' : '새 이름은 뭐가 좋을까요?' })),
      el('label', { class: 'field', for: `${layer.id}-name` }, input, counter),
      chips,
    );

    const submit = () => {
      const name = clipName(input.value.trim());
      done = true;
      let result = null;
      if (name) result = app.act('name', { name });
      closeLayer(layer, 'done');
      if (name && !first) toast(result && result.ok === false ? '이름을 바꾸지 못했어요' : '이름을 바꿨어요');
      if (opts.onDone) opts.onDone(name || null);
    };
    layer.foot.hidden = false;
    layer.foot.append(button('확인', 'primary', submit));
    layer.onEnter = submit;
    layer.focus = input;
    layer.onClosed = () => { if (!done && opts.onDone) opts.onDone(null); };
  }

  // ---- 도감 / 앨범 -------------------------------------------------------------------------

  function buildDex(layer, opts) {
    let tab = opts.tab === 'album' ? 'album' : 'dex';
    layer.el.classList.add('is-tall');
    layer.title.textContent = '도감';
    layer.title.classList.add('sr-only');
    const seg = segmented('도감과 앨범', [{ id: 'dex', label: '도감' }, { id: 'album', label: '앨범' }], tab, (id) => {
      if (id === tab) return;
      tab = id;
      seg.set(id);
      render();
    });
    layer.bar.insertBefore(seg.el, layer.closeBtn);
    layer.bar.classList.add('has-seg');

    function render() {
      layer.body.replaceChildren(tab === 'album' ? albumView() : dexView());
      layer.body.scrollTop = 0;
      layer.sheet.classList.remove('is-scrolled');
      // restart the fade-in for the new page
      layer.body.classList.remove('is-swapped');
      void layer.body.offsetHeight;
      layer.body.classList.add('is-swapped');
      syncFlip();
    }

    function dexView() {
      const dex = state().dex || {};
      const v = viewNow();
      const tint = tintNow();
      const seen = dexCount();
      const total = SPECIES_IDS.length;

      const cells = el('div', { class: 'dex-cells', 'aria-hidden': 'true' },
        SPECIES_IDS.map((id) => el('i', { class: dex[id] != null ? 'on' : '' })));
      const next = Object.keys(SKINS).filter((id) => seen < SKINS[id]).sort((a, b) => SKINS[a] - SKINS[b])[0];
      const nextSkin = SKIN_LIST.find((s) => s.id === next);
      const note = nextSkin
        ? `${SKINS[next] - seen}종 더 만나면 '${nextSkin.label}' 색이 열려요.`
        : (seen >= total ? '모두 만났어요. 대단해요!' : '기기 색을 모두 열었어요.');
      const page = el('div', { class: 'dex-page' },
        el('div', { class: 'dex-progress' },
          el('p', { class: 'dex-count', 'aria-label': `${total}종 가운데 ${seen}종을 만났어요` },
            el('b', { text: String(seen) }), el('span', { text: `/${total}` })),
          el('div', { class: 'dex-progress-side' }, cells, el('p', { class: 'note', text: note }))));

      for (const stage of STAGE_ORDER) {
        const ids = SPECIES_IDS.filter((id) => SPECIES[id].stage === stage);
        if (!ids.length) continue;
        const list = el('ul', { class: 'cards' });
        for (const id of ids) {
          const sp = SPECIES[id];
          const known = dex[id] != null;
          const current = known && v.species === id && v.alive !== false;
          list.append(el('li', { class: `card dex-card${known ? '' : ' is-unknown'}` },
            portrait(id, { pitch: 4, tint, silhouette: !known, live: known }),
            el('div', { class: 'card-text' },
              el('p', { class: 'card-name' }, el('span', { text: known ? sp.name : '???' }), current ? el('span', { class: 'tag', text: '지금' }) : null),
              el('p', { class: 'card-line', text: known ? sp.blurb : sp.hint }),
              known ? el('p', { class: 'card-meta', text: `${fmtDate(dex[id])} 처음 만남` }) : null)));
        }
        page.append(el('section', { class: 'dex-group' },
          el('h3', { class: 'group-title' }, el('span', { text: STAGE_LABEL[stage] || stage }),
            el('span', { class: 'group-count', text: `${ids.filter((id) => dex[id] != null).length}/${ids.length}` })),
          list));
      }
      return page;
    }

    function albumView() {
      const album = Array.isArray(state().album) ? state().album : [];
      const tint = tintNow();
      const page = el('div', { class: 'dex-page' });
      if (!album.length) {
        page.append(el('div', { class: 'empty' },
          portrait('egg', { pitch: 5, tint, live: true }),
          el('p', { class: 'lead', text: '아직 앨범이 비어 있어요.' }),
          el('p', { class: 'note', text: '함께 지낸 펫이 떠나면 여기에 엽서가 남아요.' })));
        return page;
      }
      const list = el('ul', { class: 'cards' });
      // newest first
      for (let i = album.length - 1; i >= 0; i--) {
        const entry = album[i] || {};
        const sp = SPECIES[entry.species];
        const star = entry.end === 'star';
        const name = typeof entry.name === 'string' && entry.name ? entry.name : DEFAULT_NAME;
        list.append(el('li', {},
          el('button', {
            class: 'card album-card', type: 'button',
            'aria-label': `${name}, ${Number(entry.gen) || 1}대, ${star ? '별이 되었어요' : '여행을 떠났어요'}. 엽서 보기`,
            on: { click: () => pushLayer('postcard', { entry }) },
          },
          portrait(sp ? entry.species : 'egg', { pitch: 4, tint }),
          el('span', { class: 'card-text' },
            el('span', { class: 'card-name' }, el('span', { text: name }), el('span', { class: 'tag tag-quiet', text: `${Number(entry.gen) || 1}대` })),
            el('span', { class: 'card-line', text: `${sp ? sp.name : '???'} · ${Number(entry.ageDays) || 0}살` }),
            el('span', { class: `card-meta${star ? ' is-star' : ''}`, text: `${star ? '별이 되었어요' : '여행을 떠났어요'} · ${fmtDate(entry.endedAt)}` })),
          glyph('chevron'))));
      }
      page.append(el('p', { class: 'note album-note', text: `함께한 펫 ${album.length}마리` }), list);
      return page;
    }

    render();
  }

  // ---- 엽서 ------------------------------------------------------------------------------

  function buildPostcard(layer, opts) {
    const album = Array.isArray(state().album) ? state().album : [];
    const entry = opts.entry || (Number.isInteger(opts.index) ? album[opts.index] : null) || album[album.length - 1] || null;
    layer.el.classList.add('is-fit');

    if (!entry) {
      layer.title.textContent = '엽서';
      layer.body.append(el('div', { class: 'empty' },
        portrait('egg', { pitch: 5, tint: tintNow(), live: true }),
        el('p', { class: 'lead', text: '아직 받은 엽서가 없어요.' })));
      return;
    }

    const star = entry.end === 'star';
    const sp = SPECIES[entry.species];
    const name = typeof entry.name === 'string' && entry.name ? entry.name : DEFAULT_NAME;
    const ended = Number.isFinite(entry.endedAt) ? new Date(entry.endedAt) : null;
    layer.title.textContent = star ? '별에서 온 엽서' : '여행길에서 온 엽서';

    const facts = [sp ? sp.name : null, `${Number(entry.gen) || 1}대`, `${Number(entry.ageDays) || 0}살`].filter(Boolean).join(' · ');
    const span = Number.isFinite(entry.bornAt) && ended ? `${fmtDate(entry.bornAt)} – ${fmtDate(entry.endedAt)}` : fmtDate(entry.endedAt);

    layer.body.append(
      el('article', { class: `postcard${star ? ' is-star' : ''}` },
        el('div', { class: 'postcard-top' },
          el('div', { class: 'postmark', 'aria-hidden': 'true' },
            el('span', { class: 'postmark-ring' }, el('b', { text: ended ? `${ended.getMonth() + 1}.${ended.getDate()}` : '' }), el('small', { text: ended ? String(ended.getFullYear()) : '' })),
            el('i', { class: 'postmark-waves' })),
          el('div', { class: 'stamp', 'aria-hidden': 'true' }, portrait(sp ? entry.species : 'egg', { pitch: 4, tint: tintNow() }))),
        el('p', { class: 'postcard-text', text: postcardText(entry) }),
        el('p', { class: 'postcard-sign', text: `${name} 올림` }),
        el('p', { class: 'postcard-facts' }, el('span', { text: facts }), el('span', { text: span }))),
    );
    if (star && entry.leftEgg) layer.body.append(el('p', { class: 'note center', text: '떠나면서 알을 하나 남겼어요.' }));

    if (opts.newEgg) {
      layer.foot.hidden = false;
      layer.foot.append(button('새 알 맞이하기', 'primary', () => {
        const res = app.act('newEgg');
        closeLayer(layer, 'done');
        if (opts.onDone) opts.onDone(res);
      }));
    }
  }

  // ---- 정보 ------------------------------------------------------------------------------

  function buildAbout(layer) {
    layer.el.classList.add('is-fit');
    layer.title.textContent = '정보';
    layer.body.append(
      el('div', { class: 'about' },
        portrait('mongsil', { pitch: 5, tint: tintNow(), live: true }),
        el('p', { class: 'about-word', text: '품알' }),
        el('p', { class: 'note', text: `버전 ${app.version || '-'}` }),
        el('p', { class: 'about-line', text: '개인이 만든 독립 가상 펫입니다. 특정 회사·제품과 관련이 없어요.' }),
        el('p', { class: 'note' }, el('span', { text: '글꼴 Neo둥근모 (NeoDunggeunmo)' }), el('br'), el('span', { text: '© Eunbin Jeong · SIL Open Font License 1.1' }))));
  }

  // ---- 설정 ------------------------------------------------------------------------------

  function buildSettings(layer) {
    layer.el.classList.add('is-tall');
    layer.title.textContent = '설정';
    const syncers = [];
    const sync = () => syncers.forEach((fn) => fn());
    layer.onReturn = sync;

    const group = (title, rows, foot) => el('section', { class: 'set-group' },
      title ? el('h3', { class: 'group-title', text: title }) : null,
      el('div', { class: 'rows' }, rows),
      foot ? el('p', { class: 'note', text: foot }) : null);

    const switchRow = (label, sub, get, set) => {
      const row = el('button', { class: 'row row-switch', type: 'button', role: 'switch', on: { click: () => { set(!get()); sync(); } } },
        el('span', { class: 'row-text' }, el('span', { class: 'row-label', text: label }), sub ? el('span', { class: 'row-sub', text: sub }) : null),
        el('span', { class: 'switch', 'aria-hidden': 'true' }, el('i', { class: 'switch-on' }), el('i', { class: 'switch-knob' })));
      syncers.push(() => row.setAttribute('aria-checked', String(Boolean(get()))));
      return row;
    };

    const navRow = (label, onTap, o) => {
      const value = el('span', { class: 'row-value' });
      const row = el('button', { class: `row row-nav${o && o.danger ? ' is-danger' : ''}`, type: 'button', on: { click: onTap } },
        el('span', { class: 'row-text' }, el('span', { class: 'row-label', text: label })),
        value, o && o.glyph === null ? null : glyph(o && o.glyph ? o.glyph : 'chevron'));
      if (o && o.value) syncers.push(() => { value.textContent = o.value(); });
      return row;
    };

    // -- 소리와 진동
    const sound = group('소리와 진동', [
      switchRow('소리', soundHint(app.env), () => prefs().sound !== false, (on) => app.setPrefs({ sound: on })),
      switchRow('진동', '키를 누를 때 톡 하고 울려요', () => prefs().haptics !== false, (on) => app.setPrefs({ haptics: on })),
    ]);

    // -- 꾸미기
    const skinGrid = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': '기기 색' });
    const skinButtons = SKIN_LIST.map((skin) => {
      const btn = el('button', {
        class: 'swatch skin', type: 'button', role: 'radio', 'data-skin': skin.id,
        style: `--c-shell:${skin.shell};--c-shade:${skin.shade};--c-key:${skin.key};--c-accent:${skin.accent}`,
        on: {
          click: () => {
            if (!skinUnlocked(skin.id)) { toast(`도감에서 ${SKINS[skin.id]}종을 만나면 열려요`); return; }
            app.setPrefs({ skin: skin.id });
            applyAccent();
            sync();
          },
        },
      },
      el('span', { class: 'toy-wrap', 'aria-hidden': 'true' }, el('span', { class: 'toy' }, el('i', { class: 'toy-lcd' }), el('i', { class: 'toy-keys' })), glyph('lock')),
      el('span', { class: 'swatch-name' }));
      skinGrid.append(btn);
      return btn;
    });
    syncers.push(() => {
      const current = SKIN_LIST.some((s) => s.id === prefs().skin) ? prefs().skin : 'milk';
      skinButtons.forEach((btn, i) => {
        const skin = SKIN_LIST[i];
        const open = skinUnlocked(skin.id);
        btn.classList.toggle('is-locked', !open);
        btn.setAttribute('aria-checked', String(skin.id === current));
        btn.setAttribute('aria-label', open ? skin.label : `${skin.label}, 잠김. 도감 ${SKINS[skin.id]}종에서 열려요`);
        btn.querySelector('.swatch-name').textContent = open ? skin.label : `도감 ${SKINS[skin.id]}종`;
      });
    });

    const tintGrid = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': '화면 색' });
    const tintButtons = Object.keys(TINTS).map((id) => {
      const canvas = el('canvas', { class: 'tint-lcd', 'aria-hidden': 'true' });
      try { drawPortrait(canvas, (ITEMS && ITEMS.heartFull) || GLYPHS.heart, { pitch: 4, tint: id, marginX: 13, marginY: 3 }); } catch (err) { /* plain tile */ }
      const btn = el('button', {
        class: 'swatch tint', type: 'button', role: 'radio', 'data-tint': id,
        on: { click: () => { app.setPrefs({ tint: id }); sync(); } },
      }, el('span', { class: 'tint-frame', 'aria-hidden': 'true', style: `background:${TINTS[id].bg}` }, canvas), el('span', { class: 'swatch-name', text: TINTS[id].label }));
      tintGrid.append(btn);
      return btn;
    });
    syncers.push(() => tintButtons.forEach((btn) => btn.setAttribute('aria-checked', String(btn.dataset.tint === tintNow()))));

    const looks = el('section', { class: 'set-group' },
      el('h3', { class: 'group-title', text: '기기 색' }), skinGrid,
      el('h3', { class: 'group-title', text: '화면 색' }), tintGrid,
      el('div', { class: 'rows' }, switchRow('투명 효과 줄이기', '비치는 기기를 불투명하게 보여 줘요', () => prefs().solid === true, (on) => app.setPrefs({ solid: on }))));

    // -- 펫 생활
    const timeRow = (label, key) => {
      const input = el('input', { class: 'time-input', type: 'time', 'aria-label': `${label} 시간` });
      const stored = () => (state().settings || {})[key];
      // → null when the schedule was saved, otherwise the reason it was not
      const commit = () => {
        const settings = state().settings || {};
        const next = { wakeMin: settings.wakeMin, bedMin: settings.bedMin, [key]: timeToMin(input.value) };
        const problem = scheduleProblem(next.wakeMin, next.bedMin);
        if (problem) return problem;
        const res = app.act('setSchedule', next);
        return res && res.ok === false ? 'refused' : null;
      };
      input.addEventListener('change', () => { commit(); });
      // The wheel picker fires change for every notch; only judge the value once it is closed.
      // An emptied field ('unset') is nothing to explain: the old time simply comes back.
      input.addEventListener('blur', () => {
        if (timeToMin(input.value) !== stored()) {
          const problem = commit();
          if (problem && SCHEDULE_TOAST[problem]) toast(SCHEDULE_TOAST[problem]);
        }
        sync();
      });
      syncers.push(() => { if (document.activeElement !== input) input.value = minToTime(stored()); });
      return el('label', { class: 'row row-field' }, el('span', { class: 'row-text' }, el('span', { class: 'row-label', text: label })), input);
    };

    const modeSeg = segmented('돌봄 방식', [{ id: 'gentle', label: '순한맛' }, { id: 'classic', label: '매운맛' }], viewNow().mode, async (mode) => {
      if (mode === viewNow().mode) return;
      if (mode === 'classic') {
        const yes = await ask({
          title: '매운맛으로 바꿀까요?',
          body: MODE_COPY.classic,
          note: classicSwitchNote(state()),
          confirmLabel: '매운맛으로', cancelLabel: '그대로 둘게요', danger: true,
        });
        if (!yes) { sync(); return; }
      }
      const res = app.act('setMode', { mode });
      sync();
      if (!res || res.ok !== false) toast(mode === 'classic' ? '매운맛으로 바꿨어요' : '순한맛으로 바꿨어요');
    });
    const modeLines = el('div', { class: 'mode-lines' },
      el('p', { class: 'mode-line', 'data-mode': 'gentle' }, el('b', { text: '순한맛' }), el('span', { text: MODE_COPY.gentle })),
      el('p', { class: 'mode-line', 'data-mode': 'classic' }, el('b', { text: '매운맛' }), el('span', { text: MODE_COPY.classic })));
    syncers.push(() => {
      const mode = viewNow().mode === 'classic' ? 'classic' : 'gentle';
      modeSeg.set(mode);
      modeLines.dataset.mode = mode;
    });

    const life = el('section', { class: 'set-group' },
      el('h3', { class: 'group-title', text: '펫 생활 시간' }),
      el('div', { class: 'rows' }, timeRow('기상', 'wakeMin'), timeRow('취침', 'bedMin')),
      el('p', { class: 'note', text: '내 하루에 맞춰 주세요. 이 시간 밖에서는 펫도 자요.' }),
      el('h3', { class: 'group-title', text: '돌봄 방식' }),
      el('div', { class: 'mode-box' }, modeSeg.el, modeLines),
      el('div', { class: 'rows' },
        switchRow('돌보미에게 맡기기', '켜 두면 펫의 시간이 멈춰요', () => viewNow().paused === true, (on) => {
          const res = app.act('pause', { on });
          if (!res || res.ok !== false) toast(on ? '돌보미가 왔어요' : '돌보미가 돌아갔어요');
        }),
        navRow('이름 바꾸기', () => pushLayer('name', {}), { value: () => viewNow().name || DEFAULT_NAME })));

    // -- 함께하기
    const together = group('함께하기', [
      navRow('친구에게 링크 보내기', async () => {
        let result = 'failed';
        try { result = await app.share(); } catch (err) { result = 'failed'; }
        if (result === 'copied') toast('링크 복사됨');
        // 'failed' also covers a share sheet the owner simply closed, so only speak up when
        // there was no share sheet to close.
        else if (result === 'failed' && typeof navigator.share !== 'function') toast('링크를 복사하지 못했어요');
      }, { glyph: 'share' }),
      typeof app.showInstallGuide === 'function' && app.env && app.env.ios && !app.env.standalone
        ? navRow('홈 화면에 설치하는 법', () => { closeAll(); app.showInstallGuide(); })
        : null,
    ]);

    // -- 저장 코드
    const exportBox = el('textarea', { class: 'code-box', readonly: true, rows: '3', spellcheck: 'false', 'aria-label': '저장 코드' });
    const copyCode = async () => {
      const code = exportBox.value;
      let ok = false;
      try { await navigator.clipboard.writeText(code); ok = true; } catch (err) { ok = false; }
      if (!ok) {
        // clipboard API refused (older webviews): select the field and use the old command
        try { exportBox.focus(); exportBox.select(); ok = document.execCommand('copy'); } catch (err) { ok = false; }
      }
      toast(ok ? '저장 코드 복사됨' : '길게 눌러 직접 복사해 주세요');
    };
    const exportPanel = el('div', { class: 'panel', hidden: true }, exportBox, button('코드 복사', 'primary', copyCode));

    const importBox = el('textarea', {
      class: 'code-box', rows: '3', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      placeholder: 'PUMAL1.로 시작하는 코드를 붙여 넣어요', 'aria-label': '가져올 저장 코드',
    });
    const importError = el('p', { class: 'field-error', role: 'alert', hidden: true });
    const fail = (text) => { importError.textContent = text; importError.hidden = false; };
    importBox.addEventListener('input', () => { importError.hidden = true; });
    const pasteCode = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { importBox.value = text.trim(); importError.hidden = true; return; }
      } catch (err) { /* no permission: fall through to the manual way */ }
      importBox.focus();
      toast('칸을 길게 눌러 붙여 넣어 주세요');
    };
    const runImport = async () => {
      const text = importBox.value.replace(/\s+/g, '');
      if (!text) { fail('코드를 먼저 붙여 넣어 주세요'); return; }
      if (!text.startsWith('PUMAL1.')) { fail('코드가 올바르지 않아요'); return; }
      // The live game is never more than a minute behind the game clock (the wall clock, unless
      // a debug hook moved it), which is close enough to tell hours and days.
      const peek = peekCode(text, Number.isFinite(state().lastTick) ? state().lastTick : Date.now());
      const yes = await ask({
        title: '이 코드로 바꿀까요?',
        body: '지금 키우는 펫과 도감, 앨범이 코드에 담긴 것으로 바뀌어요. 되돌릴 수 없어요.',
        note: importNote(peek),
        confirmLabel: '가져오기', danger: true,
      });
      if (!yes) return;
      let res;
      try { res = await app.importCode(text); } catch (err) { res = { ok: false, error: err && err.message }; }
      if (res && res.ok) {
        closeAll();
        toast(importToast(peek, viewNow()));
      } else {
        fail((res && res.error) || '코드가 올바르지 않아요');
      }
    };
    const importPanel = el('div', { class: 'panel', hidden: true }, importBox, importError,
      el('div', { class: 'panel-actions' }, button('붙여넣기', 'quiet', pasteCode), button('가져오기', 'primary', runImport)));

    const disclose = (label, panel, onOpen) => {
      const row = el('button', { class: 'row row-nav row-disclose', type: 'button', 'aria-expanded': 'false' },
        el('span', { class: 'row-text' }, el('span', { class: 'row-label', text: label })), glyph('chevron'));
      row.addEventListener('click', () => {
        const open = panel.hidden;
        panel.hidden = !open;
        row.setAttribute('aria-expanded', String(open));
        if (open) {
          if (onOpen) onOpen();
          // keep the freshly opened panel in view without animating layout
          const box = layer.body.getBoundingClientRect(), p = panel.getBoundingClientRect();
          if (p.bottom > box.bottom - 12) layer.body.scrollTop += p.bottom - box.bottom + 16;
        }
      });
      return [row, panel];
    };

    const save = group('저장 코드', [
      ...disclose('내보내기', exportPanel, () => {
        try { exportBox.value = app.exportCode() || ''; } catch (err) { exportBox.value = ''; }
      }),
      ...disclose('가져오기', importPanel),
    ], '펫을 다른 기기로 옮기거나 따로 보관할 때 써요.');

    // -- 처음부터 / 정보
    const reset = async () => {
      const once = await ask({
        title: '처음부터 다시 할까요?',
        body: '지금 키우는 펫과 도감, 앨범이 모두 지워져요.',
        confirmLabel: '계속', cancelLabel: '그만둘게요', danger: true,
      });
      if (!once) return;
      const twice = await ask({
        title: '정말 모두 지울까요?',
        body: '되돌릴 수 없어요. 남기고 싶다면 먼저 저장 코드를 내보내 주세요.',
        confirmLabel: '모두 지우기', cancelLabel: '그만둘게요', danger: true,
      });
      if (!twice) return;
      app.resetGame();
      closeAll();
      toast('새 알이 도착했어요');
    };

    const rest = group(null, [
      navRow('정보', () => pushLayer('about', {}), { value: () => (app.version ? String(app.version) : '') }),
      navRow('처음부터 다시', reset, { danger: true, glyph: null }),
    ]);

    layer.body.append(el('div', { class: 'set-page' }, sound, looks, life, together, save, rest));
    sync();
  }

  const BUILDERS = {
    dex: buildDex,
    settings: buildSettings,
    name: buildName,
    confirm: buildConfirm,
    postcard: buildPostcard,
    about: buildAbout,
  };

  // ---- public API -----------------------------------------------------------------------

  function open(name, opts) {
    if (!BUILDERS[name]) return;
    // one sheet at a time: whatever is showing goes away without ceremony
    closeAll({ instant: true });
    pushLayer(name, opts);
  }

  function close() {
    closeAll();
  }

  function isOpen() {
    return layers.length > 0;
  }

  return { open, close, isOpen, toast };
}
