// Dot-matrix LCD renderer — the "1996 layer".
//
// A 48x32 one-bit matrix with a strip of four segment icons above and below it, drawn on one
// canvas at device resolution. This module knows nothing about the game: bitmaps, fonts and
// icons are passed in, and it imports no other project module.
//
// Canvas layout in dot units (one dot = `pitch` CSS px, always an integer):
//
//   1 margin | 48 columns | 1 margin                       -> 50 wide
//   1 margin | 8 icon strip | 32 rows | 8 icon strip | 1   -> 50 tall
//
// The square 50x50 footprint is what the shell sizes its window around.

export const COLS = 48, ROWS = 32;

const STRIP = 8;                      // icon strip height, in dots
const MARGIN = 1;                     // bare backing around everything, in dots
const SPAN_X = COLS + MARGIN * 2;
const SPAN_Y = ROWS + STRIP * 2 + MARGIN * 2;
const ICON_CELL = COLS / 4;           // each icon owns a 12-dot wide cell

// The spec asks for 4-8. Below 4 the grid stops reading as dots, but a clipped screen is worse
// than a fine one, so very small containers (phone landscape, tiny previews) may go down to 2.
const MIN_PITCH = 2, MAX_PITCH = 8, DEFAULT_PITCH = 6;

const GAP_RATIO = 0.11;               // inter-dot gap as a share of the pitch
const SHADOW_RATIO = 0.12;            // lit dots cast a shadow this far down-right
const GHOST_ALPHA = 0.09;             // every dot is always faintly there
const LIT_ALPHA = 0.92;
const SHADOW_ALPHA = 0.22;
const ICON_GHOST_ALPHA = 0.12;
const BACKDROP_ALPHA = 0.14;
const GRAIN = 0.04;                   // reflector grain, +/- share of the backing colour
const TAU_RISE = 90, TAU_FALL = 150;  // ms, liquid-crystal response time
const EPSILON = 0.02;                 // closer than this to the target counts as settled

const TINTS = {
  pea:   { bg: [197, 207, 164], ink: [30, 42, 28],    glow: false },
  warm:  { bg: [201, 203, 190], ink: [34, 37, 46],    glow: false },
  amber: { bg: [242, 184, 75],  ink: [42, 30, 8],     glow: false },
  glow:  { bg: [26, 33, 27],    ink: [214, 245, 200], glow: true },
};

const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Fixed-seed PRNG: the grain must look the same on every launch and after every resize.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// Rounded rectangle with one radius per corner, written out by hand because
// CanvasRenderingContext2D.roundRect is missing on older iOS.
function roundedPath(g, x, y, w, h, tl, tr, br, bl) {
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  if (tr) g.arcTo(x + w, y, x + w, y + tr, tr);
  g.lineTo(x + w, y + h - br);
  if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br);
  g.lineTo(x + bl, y + h);
  if (bl) g.arcTo(x, y + h, x, y + h - bl, bl);
  g.lineTo(x, y + tl);
  if (tl) g.arcTo(x, y, x + tl, y, tl);
  g.closePath();
}

const isBitmap = (b) => Array.isArray(b) && b.length > 0 && typeof b[0] === 'string';

// ---- printed backdrop art -------------------------------------------------------------------
// Drawn in dot units (48x32) with real curves: it is "printed" on the reflector behind the
// liquid crystal, so unlike everything else on the screen it is smooth, not dotted.

function strokeHills(g) {
  g.beginPath();
  g.moveTo(-1, 24.5);
  g.bezierCurveTo(5, 17.5, 13, 16.5, 20, 21);
  g.bezierCurveTo(23, 23, 26, 24.6, 30, 25);
  g.stroke();
  g.beginPath();
  g.moveTo(17.5, 22.4);
  g.bezierCurveTo(26, 15, 37, 14.5, 49, 20.5);
  g.stroke();
  // three grass ticks so the ground does not read as empty
  for (const [x, y] of [[6.5, 28.2], [26, 29], [41.5, 27.6]]) {
    g.beginPath();
    g.moveTo(x - 0.9, y); g.lineTo(x - 0.3, y - 1.5);
    g.moveTo(x, y); g.lineTo(x + 0.2, y - 2);
    g.moveTo(x + 0.9, y); g.lineTo(x + 0.7, y - 1.4);
    g.stroke();
  }
}

// Outline of a union of circles: fill the union, then knock out the same shapes shrunk by the
// line width. Must run before anything else is drawn in that area.
function outlineBlob(g, circles, line) {
  g.beginPath();
  for (const [x, y, r] of circles) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
  g.fill();
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  for (const [x, y, r] of circles) {
    const rr = Math.max(0.01, r - line);
    g.moveTo(x + rr, y); g.arc(x, y, rr, 0, Math.PI * 2);
  }
  g.fill();
  g.restore();
}

function drawBackdrop(g, name) {
  const line = 0.62;
  g.lineWidth = line;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  if (name === 'day') {
    outlineBlob(g, [[8.2, 8.6, 1.9], [10.8, 7.2, 2.7], [13.8, 8.4, 2.1], [11, 9.3, 1.6]], line);
    strokeHills(g);
    const sx = 38.5, sy = 7.6;
    g.beginPath(); g.arc(sx, sy, 3.3, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + 0.2;
      g.moveTo(sx + Math.cos(a) * 4.9, sy + Math.sin(a) * 4.9);
      g.lineTo(sx + Math.cos(a) * 6.3, sy + Math.sin(a) * 6.3);
    }
    g.stroke();
  } else if (name === 'dusk') {
    strokeHills(g);
    // a low sun sitting on a long horizon stroke, with streaks of evening sky
    const sx = 12.5, sy = 12.5;
    g.beginPath(); g.arc(sx, sy, 3.6, Math.PI, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(6, sy); g.lineTo(19, sy);
    g.moveTo(8.5, sy + 1.8); g.lineTo(16.5, sy + 1.8);
    g.moveTo(10.8, sy + 3.6); g.lineTo(14.2, sy + 3.6);
    g.stroke();
    // two birds heading home
    for (const [x, y, s] of [[33, 7.5, 1.5], [38.5, 5.2, 1.1]]) {
      g.beginPath();
      g.moveTo(x - s * 1.5, y - s * 0.2);
      g.quadraticCurveTo(x - s * 0.7, y - s * 1.1, x, y);
      g.quadraticCurveTo(x + s * 0.7, y - s * 1.1, x + s * 1.5, y - s * 0.2);
      g.stroke();
    }
  } else if (name === 'night') {
    // crescent first: its knock-out must not eat the hills
    g.beginPath(); g.arc(37.5, 8, 4, 0, Math.PI * 2); g.fill();
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(39.6, 6.9, 3.5, 0, Math.PI * 2); g.fill();
    g.restore();
    strokeHills(g);
    g.beginPath();
    for (const [x, y, s] of [[8, 6.5, 1.3], [19.5, 10.5, 0.9], [27, 4.5, 1.1], [45, 14, 0.8], [13.5, 13, 0.7]]) {
      g.moveTo(x - s, y); g.lineTo(x + s, y);
      g.moveTo(x, y - s); g.lineTo(x, y + s);
    }
    g.stroke();
    for (const [x, y] of [[23.5, 8], [4.5, 12], [31.5, 11.5]]) {
      g.beginPath(); g.arc(x, y, 0.36, 0, Math.PI * 2); g.fill();
    }
  }
}

// ---------------------------------------------------------------------------------------------

export function createLCD(canvas) {
  // Opaque backing store: the LCD always paints every pixel, and an opaque canvas composites
  // cheaper under the glass layers.
  const ctx = canvas.getContext('2d', { alpha: false });
  const base = makeCanvas(1, 1);            // everything static: backing, grain, art, ghosts
  const bctx = base.getContext('2d');

  const N = COLS * ROWS;
  const draft = new Uint8Array(N);          // what the scene is drawing right now
  const target = new Uint8Array(N);         // what was last committed with present()/snap()
  const cur = new Float32Array(N);          // what the crystal is actually showing

  const iconTarget = new Uint8Array(8), iconCur = new Float32Array(8);
  const markTarget = new Uint8Array(8), markCur = new Float32Array(8);   // selection underline
  let iconBitmaps = [null, null, null, null, null, null, null, null];
  let iconSprites = new Array(8).fill(null);
  let selected = -1;
  let litSet = new Set();

  let tintName = 'pea', tint = TINTS.pea;
  let backdrop = null;

  // Geometry in device px. All of it is integer so every dot is the same size.
  let pitch = 0;        // CSS px per dot
  let P = 0;            // device px per dot
  let W = 0, H = 0;     // backing store size
  let gap = 1, dot = 1, shadowOff = 1, shadowPad = 1;
  let ox = 0, oy = 0;   // origin of dot (0,0)
  let iu = 1;           // device px per icon cell
  let dotSprite = null, shadowSprite = null, bloomSprite = null;

  let raf = 0, lastT = 0, watchdog = 0;
  let destroyed = false;

  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motion && motion.matches);

  // ---- measuring ----------------------------------------------------------------------------

  // The canvas sizes itself, so it cannot be measured to learn how much room there is. The
  // room comes from the nearest ancestor marked [data-lcd-fit] (a box whose width does not
  // depend on the canvas), or from the parent element when nothing is marked.
  function fitHost() {
    return canvas.closest('[data-lcd-fit]') || canvas.parentElement;
  }

  function measurePitch() {
    const host = fitHost();
    if (!host) return pitch || DEFAULT_PITCH;
    // clientWidth, not getBoundingClientRect: the layout box must not change when the shell
    // is transformed (a shake, a scale-in), or the pitch would flicker mid-animation.
    const cs = getComputedStyle(host);
    const w = host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!(w > 0)) return pitch || DEFAULT_PITCH;      // hidden or not laid out yet
    let p = Math.floor(w / SPAN_X);
    if (host.getAttribute('data-lcd-fit') === 'contain') {
      const h = host.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      if (h > 0) p = Math.min(p, Math.floor(h / SPAN_Y));
    }
    return clamp(p, MIN_PITCH, MAX_PITCH);
  }

  function currentDpr() {
    return Math.min(window.devicePixelRatio || 1, 3);
  }

  // ---- pre-rendered pieces --------------------------------------------------------------------

  function buildSprites() {
    const ink = tint.ink;
    const r = Math.max(0.5, dot * 0.12);

    dotSprite = makeCanvas(dot, dot);
    let g = dotSprite.getContext('2d');
    g.fillStyle = rgb(ink);
    g.beginPath();
    roundedPath(g, 0, 0, dot, dot, r, r, r, r);
    g.fill();

    // Soft shadow: the same dot smeared over five sub-pixel offsets. Cheaper and more
    // portable than ctx.filter, which older iOS canvases ignore.
    shadowPad = Math.max(1, Math.round(P * 0.06));
    const size = dot + shadowPad * 2;
    shadowSprite = makeCanvas(size, size);
    g = shadowSprite.getContext('2d');
    g.fillStyle = rgb(ink);
    g.globalAlpha = 0.2;
    const b = shadowPad * 0.75;
    for (const [dx, dy] of [[0, 0], [b, 0], [-b, 0], [0, b], [0, -b]]) {
      g.beginPath();
      roundedPath(g, shadowPad + dx, shadowPad + dy, dot, dot, r, r, r, r);
      g.fill();
    }

    // Night light: lit dots are emissive, so they bloom instead of casting a shadow.
    bloomSprite = makeCanvas(P * 2, P * 2);
    g = bloomSprite.getContext('2d');
    const grad = g.createRadialGradient(P, P, dot * 0.2, P, P, P);
    grad.addColorStop(0, rgb(ink, 0.34));
    grad.addColorStop(0.55, rgb(ink, 0.1));
    grad.addColorStop(1, rgb(ink, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, P * 2, P * 2);
  }

  // Icons are "segments": solid printed shapes with no dot gaps. Each bitmap cell becomes a
  // square of `iu` device px and convex outer corners are rounded, so the glyph reads as one
  // continuous piece of liquid crystal rather than a low-resolution dot picture.
  function buildIconSprite(bmp) {
    if (!isBitmap(bmp)) return null;
    const rows = bmp.length, cols = bmp[0].length;
    const c = makeCanvas(cols * iu, rows * iu);
    const g = c.getContext('2d');
    g.fillStyle = rgb(tint.ink);
    const on = (x, y) => y >= 0 && y < rows && x >= 0 && x < cols && bmp[y][x] === '#';
    const r = iu * 0.42;
    g.beginPath();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!on(x, y)) continue;
        const up = on(x, y - 1), dn = on(x, y + 1), lf = on(x - 1, y), rt = on(x + 1, y);
        // A corner is rounded only when it is truly exposed; a diagonal neighbour keeps it
        // square so staircases stay joined.
        roundedPath(
          g, x * iu, y * iu, iu, iu,
          !up && !lf && !on(x - 1, y - 1) ? r : 0,
          !up && !rt && !on(x + 1, y - 1) ? r : 0,
          !dn && !rt && !on(x + 1, y + 1) ? r : 0,
          !dn && !lf && !on(x - 1, y + 1) ? r : 0,
        );
      }
    }
    g.fill();
    return { canvas: c, w: cols * iu, h: rows * iu };
  }

  function buildIcons() {
    iconSprites = iconBitmaps.map(buildIconSprite);
  }

  // Where icon k sits, in device px. The zone below the glyph is kept free for the underline.
  function iconBox(k) {
    const sp = iconSprites[k];
    const w = sp ? sp.w : 12 * iu, h = sp ? sp.h : 10 * iu;
    const col = k % 4, bottom = k >= 4;
    const cellX = MARGIN * P + col * ICON_CELL * P;
    const stripY = bottom ? (MARGIN + STRIP + ROWS) * P : MARGIN * P;
    const zone = h + iu * 2;
    const x = cellX + Math.round((ICON_CELL * P - w) / 2);
    const y = stripY + Math.round((STRIP * P - zone) / 2);
    const markW = Math.min(w, iu * 6);
    return { x, y, w, h, markX: cellX + Math.round((ICON_CELL * P - markW) / 2), markY: y + h + iu, markW, markH: iu };
  }

  function buildBase() {
    if (base.width !== W || base.height !== H) { base.width = W; base.height = H; }
    const g = bctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // Backing with reflector grain. The grain is reflectance variation, so it is baked into
    // the backing colour (a multiply) and vanishes under dark ink by itself. One low-res
    // noise field stretched over the whole panel: grains of 0.3-0.5 dot, no tile seams.
    const grainPx = Math.max(2, Math.round(P * 0.4));
    const gw = Math.ceil(W / grainPx) + 1, gh = Math.ceil(H / grainPx) + 1;
    const noise = makeCanvas(gw, gh);
    const ng = noise.getContext('2d');
    const img = ng.createImageData(gw, gh);
    const rand = mulberry32(0x50754D41);
    for (let i = 0; i < gw * gh; i++) {
      const k = 1 + (rand() * 2 - 1) * GRAIN;
      img.data[i * 4] = clamp(Math.round(tint.bg[0] * k), 0, 255);
      img.data[i * 4 + 1] = clamp(Math.round(tint.bg[1] * k), 0, 255);
      img.data[i * 4 + 2] = clamp(Math.round(tint.bg[2] * k), 0, 255);
      img.data[i * 4 + 3] = 255;
    }
    ng.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(noise, 0, 0, gw * grainPx, gh * grainPx);

    if (tint.glow) {
      // an edge-lit panel is never even: brighter towards the lamp, here the lower middle
      const lamp = g.createRadialGradient(W * 0.5, H * 0.62, 0, W * 0.5, H * 0.62, W * 0.75);
      lamp.addColorStop(0, rgb(tint.ink, 0.085));
      lamp.addColorStop(1, rgb(tint.ink, 0));
      g.fillStyle = lamp;
      g.fillRect(0, 0, W, H);
    }

    if (backdrop) {
      // Drawn opaque on its own layer and composited once, so crossing strokes do not
      // double up their alpha.
      const art = makeCanvas(COLS * P, ROWS * P);
      const ag = art.getContext('2d');
      ag.scale(P, P);
      ag.fillStyle = rgb(tint.ink);
      ag.strokeStyle = rgb(tint.ink);
      drawBackdrop(ag, backdrop);
      g.globalAlpha = tint.glow ? BACKDROP_ALPHA * 0.6 : BACKDROP_ALPHA;
      g.drawImage(art, MARGIN * P, (MARGIN + STRIP) * P);
    }

    g.globalAlpha = tint.glow ? GHOST_ALPHA * 0.7 : GHOST_ALPHA;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) g.drawImage(dotSprite, ox + x * P, oy + y * P);
    }

    g.globalAlpha = tint.glow ? ICON_GHOST_ALPHA * 0.8 : ICON_GHOST_ALPHA;
    for (let k = 0; k < 8; k++) {
      const sp = iconSprites[k];
      if (!sp) continue;
      const box = iconBox(k);
      g.drawImage(sp.canvas, box.x, box.y);
    }
    g.globalAlpha = 1;
  }

  // ---- painting -------------------------------------------------------------------------------

  function paint() {
    if (!W) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);

    // Under-layer first (shadow, or bloom for the night light) so lit neighbours cover it.
    if (tint.glow) {
      const off = Math.round((P * 2 - dot) / 2);
      for (let i = 0; i < N; i++) {
        const a = cur[i];
        if (a < 0.004) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(bloomSprite, ox + (i % COLS) * P - off, oy + ((i / COLS) | 0) * P - off);
      }
    } else {
      const off = shadowOff - shadowPad;
      for (let i = 0; i < N; i++) {
        const a = cur[i];
        if (a < 0.004) continue;
        ctx.globalAlpha = a * SHADOW_ALPHA;
        ctx.drawImage(shadowSprite, ox + (i % COLS) * P + off, oy + ((i / COLS) | 0) * P + off);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = cur[i];
      if (a < 0.004) continue;
      ctx.globalAlpha = a * LIT_ALPHA;
      ctx.drawImage(dotSprite, ox + (i % COLS) * P, oy + ((i / COLS) | 0) * P);
    }

    for (let k = 0; k < 8; k++) {
      const sp = iconSprites[k];
      const a = iconCur[k], m = markCur[k];
      if (a < 0.004 && m < 0.004) continue;
      const box = iconBox(k);
      if (sp && a >= 0.004) {
        if (!tint.glow) {
          ctx.globalAlpha = a * SHADOW_ALPHA;
          ctx.drawImage(sp.canvas, box.x + shadowOff, box.y + shadowOff);
        }
        ctx.globalAlpha = a * LIT_ALPHA;
        ctx.drawImage(sp.canvas, box.x, box.y);
      }
      if (m >= 0.004) {
        ctx.fillStyle = rgb(tint.ink);
        if (!tint.glow) {
          ctx.globalAlpha = m * SHADOW_ALPHA;
          ctx.fillRect(box.markX + shadowOff, box.markY + shadowOff, box.markW, box.markH);
        }
        ctx.globalAlpha = m * LIT_ALPHA;
        ctx.fillRect(box.markX, box.markY, box.markW, box.markH);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- response-time ghosting -------------------------------------------------------------------

  function easeArray(tg, cu, n, rise, fall) {
    let moving = false;
    for (let i = 0; i < n; i++) {
      const t = tg[i], c = cu[i];
      if (c === t) continue;
      const d = t - c;
      const next = c + d * (d > 0 ? rise : fall);
      if (Math.abs(t - next) < EPSILON) cu[i] = t;
      else { cu[i] = next; moving = true; }
    }
    return moving;
  }

  function frame(now) {
    raf = 0;
    if (destroyed) return;
    // Use the real elapsed time with no upper clamp: when frames arrive rarely (throttled or
    // hidden page) the crystal has had that long to settle, and clamping would leave a stale
    // half-faded mix of old and new pictures on the glass.
    const dt = Math.max(8, now - lastT);
    lastT = now;
    const rise = 1 - Math.exp(-dt / TAU_RISE);
    const fall = 1 - Math.exp(-dt / TAU_FALL);
    let moving = easeArray(target, cur, N, rise, fall);
    moving = easeArray(iconTarget, iconCur, 8, rise, fall) || moving;
    moving = easeArray(markTarget, markCur, 8, rise, fall) || moving;
    paint();
    if (moving) raf = requestAnimationFrame(frame);
  }

  function unsettled() {
    for (let i = 0; i < N; i++) if (cur[i] !== target[i]) return true;
    for (let i = 0; i < 8; i++) if (iconCur[i] !== iconTarget[i] || markCur[i] !== markTarget[i]) return true;
    return false;
  }

  function animate() {
    if (raf || destroyed) return;
    if (!unsettled()) return;                 // nothing to do: stay idle at 0 fps
    lastT = performance.now() - 16;
    raf = requestAnimationFrame(frame);
    armWatchdog();
  }

  // rAF is starved while the page is hidden, throttled or in Low Power Mode pauses. The game
  // keeps committing frames on timers, so without this the glass would show a stale mix of
  // old and new pictures until the next real frame.
  function armWatchdog() {
    if (watchdog || destroyed) return;
    watchdog = setTimeout(() => {
      watchdog = 0;
      if (!raf || destroyed) return;
      if (performance.now() - lastT > 400) settleNow();
      else armWatchdog();
    }, 500);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
  }

  function settleNow() {
    stop();
    for (let i = 0; i < N; i++) cur[i] = target[i];
    for (let i = 0; i < 8; i++) { iconCur[i] = iconTarget[i]; markCur[i] = markTarget[i]; }
    paint();
  }

  function refreshIconTargets() {
    for (let k = 0; k < 8; k++) {
      iconTarget[k] = k === selected || litSet.has(k) ? 1 : 0;
      markTarget[k] = k === selected ? 1 : 0;
    }
  }

  // ---- geometry ---------------------------------------------------------------------------------

  // Repaint the current picture after a static change, without touching a running settle.
  function redrawStatic() {
    buildBase();
    paint();
  }

  function layout(force) {
    const nextPitch = measurePitch();
    const nextP = Math.max(1, Math.round(nextPitch * currentDpr()));
    if (!force && nextPitch === pitch && nextP === P) return false;
    pitch = nextPitch;
    P = nextP;
    W = SPAN_X * P;
    H = SPAN_Y * P;
    gap = Math.max(1, Math.round(P * GAP_RATIO));
    dot = Math.max(1, P - gap);
    // Never further than the gap: a dot's shadow then stays inside its own cell and the
    // neighbour's ghost dot is not dirtied.
    shadowOff = Math.min(gap, Math.max(1, Math.round(P * SHADOW_RATIO)));
    ox = MARGIN * P + (gap >> 1);
    oy = (MARGIN + STRIP) * P + (gap >> 1);
    iu = Math.max(1, Math.floor(P * 0.6));

    // This is the only place the canvas is resized, and only when the pitch (or the screen
    // density) really changed.
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${SPAN_X * pitch}px`;
    canvas.style.height = `${SPAN_Y * pitch}px`;

    buildSprites();
    buildIcons();
    buildBase();
    paint();
    return true;
  }

  // ---- drawing into the draft -------------------------------------------------------------------

  function put(x, y, on) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    draft[y * COLS + x] = on ? 1 : 0;
  }

  function glyphFor(font, ch) {
    if (!font) return null;
    return font[ch] || font[ch.toLowerCase()] || font[ch.toUpperCase()] || null;
  }

  function blankWidth(font) {
    const sp = font && font[' '];
    return isBitmap(sp) ? sp[0].length : 3;
  }

  const lcd = {
    get pitch() { return pitch; },
    get canvas() { return canvas; },

    resize() {
      if (!layout(false)) paint();
    },

    setTint(name) {
      const next = TINTS[name] ? name : 'pea';
      canvas.dataset.tint = next;             // lets the shell restyle the glass for the night light
      if (next === tintName && dotSprite) return;
      tintName = next;
      tint = TINTS[next];
      if (!W) return;
      buildSprites();
      buildIcons();
      redrawStatic();
    },

    setBackdrop(name) {
      const next = name === 'day' || name === 'dusk' || name === 'night' ? name : null;
      if (next === backdrop) return;
      backdrop = next;
      if (W) redrawStatic();
    },

    setIcons(top, bottom) {
      const t = Array.isArray(top) ? top : [], b = Array.isArray(bottom) ? bottom : [];
      iconBitmaps = [0, 1, 2, 3].map((i) => t[i] || null).concat([0, 1, 2, 3].map((i) => b[i] || null));
      if (!W) return;
      buildIcons();
      redrawStatic();
    },

    // Takes effect at once (no present() needed) because scenes blink the call icon on their
    // own clock. Omitted fields keep their previous value.
    setIconState(state = {}) {
      if ('selected' in state) {
        const s = state.selected;
        selected = Number.isInteger(s) && s >= 0 && s < 8 ? s : -1;
      }
      if ('lit' in state) litSet = new Set(Array.isArray(state.lit) ? state.lit : []);
      refreshIconTargets();
      if (reduced()) settleNow(); else animate();
    },

    clear() {
      draft.fill(0);
    },

    // Reads back what has been drawn since the last clear() (not what the crystal shows).
    // For tests and debug hooks; scenes never need it.
    peek(x, y) {
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
      return draft[y * COLS + x] === 1;
    },

    dot(x, y, on = true) {
      put(Math.round(x), Math.round(y), on);
    },

    sprite(bitmap, x, y, opts = {}) {
      if (!isBitmap(bitmap)) return;
      const { flipX = false, invert = false, clear = false } = opts;
      const bx = Math.round(x), by = Math.round(y);
      const h = bitmap.length;
      for (let r = 0; r < h; r++) {
        const row = bitmap[r], w = row.length;
        for (let c = 0; c < w; c++) {
          const ink = row[flipX ? w - 1 - c : c] === '#';
          if (invert) put(bx + c, by + r, !ink);        // negative: the box lights up, the art goes dark
          else if (ink) put(bx + c, by + r, true);
          else if (clear) put(bx + c, by + r, false);
        }
      }
    },

    rect(x, y, w, h, on = true) {
      const x0 = Math.round(x), y0 = Math.round(y);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) put(x0 + c, y0 + r, on);
    },

    frame(x, y, w, h) {
      const x0 = Math.round(x), y0 = Math.round(y);
      if (w <= 0 || h <= 0) return;
      for (let c = 0; c < w; c++) { put(x0 + c, y0, true); put(x0 + c, y0 + h - 1, true); }
      for (let r = 0; r < h; r++) { put(x0, y0 + r, true); put(x0 + w - 1, y0 + r, true); }
    },

    // Returns the x just past the last glyph (no trailing spacing), i.e. x + textWidth(str).
    // Characters the font does not have advance like a space.
    text(str, x, y, font) {
      let cx = Math.round(x);
      const cy = Math.round(y);
      const s = String(str);
      for (let i = 0; i < s.length; i++) {
        const g = glyphFor(font, s[i]);
        if (i > 0) cx += 1;
        if (isBitmap(g)) {
          lcd.sprite(g, cx, cy);
          cx += g[0].length;
        } else {
          cx += blankWidth(font);
        }
      }
      return cx;
    },

    textWidth(str, font) {
      const s = String(str);
      let w = 0;
      for (let i = 0; i < s.length; i++) {
        const g = glyphFor(font, s[i]);
        if (i > 0) w += 1;
        w += isBitmap(g) ? g[0].length : blankWidth(font);
      }
      return w;
    },

    present() {
      target.set(draft);
      if (reduced()) settleNow(); else animate();
    },

    snap() {
      target.set(draft);
      settleNow();
    },

    // Reads the canvas box at call time, so it stays right after a resize, a rotation, or any
    // transform the shell applies to the device. Anywhere inside the canvas resolves to a
    // zone (the 1-dot margin belongs to its nearest neighbour); outside returns null.
    hitTest(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      const u = ((clientX - r.left) / r.width) * SPAN_X - MARGIN;
      const v = ((clientY - r.top) / r.height) * SPAN_Y - MARGIN;
      if (u < -MARGIN || v < -MARGIN || u >= COLS + MARGIN || v >= SPAN_Y - MARGIN) return null;
      const col = clamp(Math.floor(u), 0, COLS - 1);
      if (v < STRIP) return { zone: 'icon', index: clamp(Math.floor(col / ICON_CELL), 0, 3) };
      if (v >= STRIP + ROWS) return { zone: 'icon', index: 4 + clamp(Math.floor(col / ICON_CELL), 0, 3) };
      return { zone: 'matrix', x: col, y: clamp(Math.floor(v - STRIP), 0, ROWS - 1) };
    },

    destroy() {
      destroyed = true;
      stop();
      if (observer) observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (motion && motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
    },
  };

  // ---- self-maintenance -------------------------------------------------------------------------

  // The host may call lcd.resize() itself; these only make sure a rotation, a late safe-area
  // correction on iOS cold start, or a zoom change can never leave the pitch stale.
  const onWindowResize = () => layout(false);
  const onMotionChange = () => { if (reduced()) settleNow(); };
  window.addEventListener('resize', onWindowResize);
  if (motion && motion.addEventListener) motion.addEventListener('change', onMotionChange);
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    const host = fitHost();
    if (host) {
      observer = new ResizeObserver(() => layout(false));
      observer.observe(host);
    }
  }

  canvas.dataset.tint = tintName;
  layout(true);
  return lcd;
}
