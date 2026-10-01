// Environment detection, the two gate screens (install guide / in-app escape), sharing and
// service-worker registration.
//
// Nothing here touches the DOM at module top level (only typeof-guarded listeners), so the
// pure parts (detectEnv, gateMode, escapeLink) import cleanly in node for tests.

export const CANONICAL_URL = 'https://jinjoskim2001-sketch.github.io/pumal/';

const SHARE_TITLE = '품알';
const SHARE_TEXT = '품에 안고 키우는 포켓 펫, 품알! 링크를 열고 홈 화면에 추가하면 끝이에요.';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Order matters: Threads identifies as "Barcelona" and must win over the Meta catch-alls.
const IN_APP_RULES = [
  ['kakaotalk', /kakaotalk/i],
  ['line', /\bLine\//i],
  ['threads', /\bBarcelona/i],
  ['instagram', /\bInstagram/i],
  ['facebook', /\bFB[\w_]+\/|FBAN|FBAV|FB_IAB/i],
  ['naver', /NAVER\(inapp/i],
  ['daum', /DaumApps/i],
  // No dedicated escape exists for these; they share the generic instructions.
  ['other', /musical_ly|Bytedance|\bTwitter|MicroMessenger\/|\bGSA\//i],
];

// Real browsers on iOS that carry "Safari/" in the UA but are not Safari.
const NOT_SAFARI = /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPiOS|OPR\/|OPT\/|Android|DuckDuckGo|Whale|SamsungBrowser|YaBrowser/i;

function defaultUA() {
  return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
}

function isStandaloneDisplay() {
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  if (typeof matchMedia === 'function') {
    try {
      return matchMedia('(display-mode: standalone)').matches;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * @param {string} [ua]
 * @param {{ platform?: string, maxTouchPoints?: number, standalone?: boolean }} [ctx]
 *   Overrides for the non-UA signals. Only tests pass this; the app calls detectEnv().
 * @returns {{ standalone: boolean, ios: boolean, android: boolean, safari: boolean,
 *   inApp: null | 'kakaotalk' | 'line' | 'instagram' | 'threads' | 'facebook' | 'naver' | 'daum' | 'other' }}
 */
export function detectEnv(ua = defaultUA(), ctx = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const platform = ctx.platform ?? nav.platform ?? '';
  const touchPoints = ctx.maxTouchPoints ?? nav.maxTouchPoints ?? 0;
  const standalone = ctx.standalone ?? isStandaloneDisplay();

  const iDevice = /iPhone|iPad|iPod/.test(ua);
  // iPadOS asks for desktop sites by default and then claims to be a Mac; the touch points
  // are the only tell.
  const iPadAsMac = !iDevice && /Macintosh/.test(ua) && platform === 'MacIntel' && touchPoints > 1;
  const ios = iDevice || iPadAsMac;
  const android = /Android/i.test(ua);

  let inApp = null;
  // Standalone goes first: an installed iOS web app has no "Safari/" token either, and it
  // must never be mistaken for a webview.
  if (!standalone) {
    for (const [name, re] of IN_APP_RULES) {
      if (re.test(ua)) {
        inApp = name;
        break;
      }
    }
    if (!inApp && ios && !/Safari\//.test(ua)) inApp = 'other';
  }

  const safari = !standalone && !inApp && /Safari\//.test(ua) && !NOT_SAFARI.test(ua);

  return { standalone, ios, android, safari, inApp };
}

// Safari's own major version ("Version/27.0"). The OS token in an iPhone user agent is
// frozen, so this is the only signal for where Safari keeps its Share button. null when the
// user agent does not say (other browsers, webviews, the installed app).
function safariMajor(ua) {
  const m = /\bVersion\/(\d+)/.exec(ua || '');
  return m ? Number(m[1]) : null;
}

/**
 * @returns {'game' | 'install' | 'escape'}
 */
export function gateMode(env, { forcePlay = false, trial = false } = {}) {
  if (forcePlay || env.standalone) return 'game';
  if (!env.ios) return 'game';
  if (trial) return 'game';
  return env.inApp ? 'escape' : 'install';
}

// ---------------------------------------------------------------------------
// Escape links (pure)
// ---------------------------------------------------------------------------

function withParam(url, key, value) {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}${key}=${value}${hash}`;
}

/**
 * The best "leave this in-app browser" link for an app.
 * `sync` means the scheme only works when set synchronously inside a real tap handler.
 * `href` is the current page URL; LINE needs it to know whether its official parameter
 * has already been tried.
 * @returns {{ href: string, target: string | null, sync: boolean }}
 */
export function escapeLink(inApp, { canonical = CANONICAL_URL, href = '' } = {}) {
  const enc = encodeURIComponent(canonical);
  switch (inApp) {
    case 'kakaotalk':
      return { href: `kakaotalk://web/openExternal?url=${enc}`, target: null, sync: true };
    case 'instagram':
      return { href: `instagram://extbrowser/?url=${enc}`, target: null, sync: true };
    case 'threads':
      return { href: `barcelona://extbrowser/?url=${enc}`, target: null, sync: true };
    case 'line':
      // openExternalBrowser=1 is LINE's documented switch. If it is already in the URL and
      // we are still inside LINE, it did not work, so fall through to the Safari scheme.
      if (!/[?&]openExternalBrowser=1\b/.test(href)) {
        return { href: withParam(canonical, 'openExternalBrowser', '1'), target: null, sync: false };
      }
      break;
    default:
      break;
  }
  return { href: canonical.replace(/^https:\/\//, 'x-safari-https://'), target: '_blank', sync: false };
}

// ---------------------------------------------------------------------------
// Small DOM helpers (only called from functions)
// ---------------------------------------------------------------------------

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private mode: the guard is lost, the worst case is one extra redirect attempt.
  }
}

async function copyText(text, input) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // Raced against a short timer: some embedded browsers leave this promise pending
      // forever, and the selection path below only works while the tap is still fresh.
      const done = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 700)),
      ]);
      if (done) return true;
    }
  } catch {
    // Webviews often deny the async clipboard; fall through to the selection path.
  }
  let field = input;
  let temp = null;
  try {
    if (!field) {
      temp = document.createElement('input');
      temp.value = text;
      temp.readOnly = true;
      temp.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px;';
      document.body.appendChild(temp);
      field = temp;
    }
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (temp) temp.remove();
  }
}

// ---------------------------------------------------------------------------
// Mascot on the LCD plate
// ---------------------------------------------------------------------------

// Stand-in used until js/sprites.js can be loaded (and in case it fails): the style-anchor
// sprout blob, which is what the baby is drawn from.
const FALLBACK_MASCOT = [
  [
    '................',
    '................',
    '................',
    '................',
    '................',
    '........#.......',
    '.......##.......',
    '.....######.....',
    '....#......#....',
    '...#........#...',
    '...#..#..#..#...',
    '...#........#...',
    '...#...##...#...',
    '...#........#...',
    '....#......#....',
    '.....######.....',
  ],
  [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......#........',
    '......##........',
    '....########....',
    '...#........#...',
    '..#..........#..',
    '..#..#....#..#..',
    '..#..........#..',
    '..#....##....#..',
    '...#........#...',
    '....########....',
  ],
];

function isBitmap(v) {
  return Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string' && r.length === v[0].length);
}

// Square dot window around the sprite: 1 empty dot on the sides, bottom row = the ground.
function mascotWindow(frames) {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (const bmp of frames) {
    bmp.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] !== '#') continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    });
  }
  if (maxX < 0) return { size: 12, ox: 0, oy: 0 };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const size = Math.max(w + 2, h + 3, 12);
  const ox = minX - Math.floor((size - w) / 2);
  const oy = maxY + 2 - size; // one dot of ground under the feet
  return { size, ox, oy };
}

function dotsPath(bmp, win, shift) {
  const dot = 0.88;
  const pad = (1 - dot) / 2 + shift;
  let d = '';
  for (let y = 0; y < win.size; y += 1) {
    const row = bmp[y + win.oy];
    if (!row) continue;
    for (let x = 0; x < win.size; x += 1) {
      if (row[x + win.ox] === '#') d += `M${x + pad} ${y + pad}h${dot}v${dot}h-${dot}z`;
    }
  }
  return d;
}

function mascotSvg(frames, { animate = true } = {}) {
  const win = mascotWindow(frames);
  const dot = 0.88;
  const pad = (1 - dot) / 2;
  let ghost = '';
  for (let y = 0; y < win.size; y += 1) {
    for (let x = 0; x < win.size; x += 1) ghost += `M${x + pad} ${y + pad}h${dot}v${dot}h-${dot}z`;
  }
  const shown = animate ? frames.slice(0, 2) : frames.slice(0, 1);
  const groups = shown
    .map(
      (bmp, i) =>
        `<g class="gate-lcd__frame${shown.length > 1 ? ` gate-lcd__frame--${i}` : ''}">` +
        `<path class="gate-lcd__shadow" d="${dotsPath(bmp, win, 0.12)}"/>` +
        `<path class="gate-lcd__lit" d="${dotsPath(bmp, win, 0)}"/></g>`,
    )
    .join('');
  return (
    `<svg class="gate-lcd__svg" viewBox="0 0 ${win.size} ${win.size}" aria-hidden="true" focusable="false">` +
    `<path class="gate-lcd__ghost" d="${ghost}"/>${groups}</svg>`
  );
}

function appIconHtml(frames, extraClass = '', animate = true) {
  return (
    `<span class="gate-icon ${extraClass}" aria-hidden="true">` +
    `<span class="gate-icon__bezel"><span class="gate-lcd">${mascotSvg(frames, { animate })}</span></span>` +
    `</span>`
  );
}

// ---------------------------------------------------------------------------
// Illustration glyphs — generic line icons drawn here, no platform artwork.
// ---------------------------------------------------------------------------

const G_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const GLYPH = {
  share: `<svg class="gate-g" ${G_ATTR}><path d="M12 14.5V3.5M7.8 7.2 12 3l4.2 4.2M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/></svg>`,
  dots: `<svg class="gate-g" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="19" cy="12" r="2.1"/></svg>`,
  plus: `<svg class="gate-g" ${G_ATTR}><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8.2v7.6M8.2 12h7.6"/></svg>`,
  back: `<svg class="gate-g" ${G_ATTR}><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  tabs: `<svg class="gate-g" ${G_ATTR}><rect x="8" y="8" width="12.5" height="12.5" rx="3"/><path d="M16 4.5H7.5a3 3 0 0 0-3 3V16"/></svg>`,
  out: `<svg class="gate-g" ${G_ATTR}><path d="M13 4.5h6.5V11M19 5 10.5 13.5M10 6.5H6.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V14"/></svg>`,
};

// Step ①: a compact browser toolbar and the Share row it leads to. What is lit depends on
// where that Safari keeps Share (docs/research/ios-pwa.md, install flow):
//   'dots' — Safari 26 and other browsers: the ··· button beside the address bar
//   'hold' — Safari 27+: that button became Tabs; press and hold the address bar instead
//   'both' — version unknown: light both ways in
function artShare(kind) {
  const hold = kind !== 'dots';
  const dots = kind !== 'hold';
  return (
    `<div class="gate-art gate-art--share${kind === 'hold' ? ' gate-art--hold' : ''}">` +
    `<div class="gate-art__pop"><span>공유</span>${GLYPH.share}</div>` +
    `<div class="gate-art__bar">` +
    `<span class="gate-art__btn">${GLYPH.back}</span>` +
    `<span class="gate-art__addr${hold ? ' gate-art__addr--hot' : ''}"><i></i></span>` +
    `<span class="gate-art__btn${dots ? ' gate-art__btn--hot' : ''}">${dots ? GLYPH.dots : GLYPH.tabs}</span>` +
    `</div></div>`
  );
}

// Step ②: the action list with the row to pick.
const ART_ADD =
  `<div class="gate-art gate-art--list">` +
  `<div class="gate-art__row"><i></i><b></b></div>` +
  `<div class="gate-art__row gate-art__row--hot"><span>홈 화면에 추가</span>${GLYPH.plus}</div>` +
  `<div class="gate-art__row"><i class="gate-art__short"></i><b></b></div>` +
  `</div>`;

// Step ③: the confirm sheet — switch left on, then the add button.
function artConfirm(frames) {
  return (
    `<div class="gate-art gate-art--confirm">` +
    `<div class="gate-art__top"><span class="gate-art__cancel"></span><span class="gate-art__add">추가</span></div>` +
    `<div class="gate-art__app">${appIconHtml(frames, 'gate-icon--tiny', false)}<span>품알</span></div>` +
    `<div class="gate-art__row gate-art__row--switch"><span>웹 앱으로 열기</span><span class="gate-art__switch"></span></div>` +
    `</div>`
  );
}

// Escape: where the button to tap sits in the in-app browser, and the row it leads to.
function artInApp({ corner, glyph, row }) {
  const bar =
    `<div class="gate-art__bar gate-art__bar--${corner}">` +
    `<span class="gate-art__btn">${GLYPH.back}</span>` +
    `<span class="gate-art__addr"><i></i></span>` +
    `<span class="gate-art__btn gate-art__btn--hot">${GLYPH[glyph]}</span>` +
    `</div>`;
  const pop = `<div class="gate-art__pop"><span>${row}</span>${GLYPH.out}</div>`;
  return (
    `<div class="gate-art gate-art--inapp gate-art--${corner}">` +
    (corner === 'top' ? bar + pop : pop + bar) +
    `</div>`
  );
}

// Manual route out of each in-app browser (iPhone). Sources: docs/research/inapp-haptics-audio.md A2, A4.
const IN_APP_INFO = {
  kakaotalk: {
    label: '카카오톡',
    where: '오른쪽 아래 <b>공유 버튼</b>',
    pick: 'Safari로 열기',
    art: { corner: 'bottom', glyph: 'share', row: 'Safari로 열기' },
  },
  line: {
    label: '라인',
    where: '오른쪽 아래 <b>공유 버튼</b>',
    pick: 'Safari로 열기',
    art: { corner: 'bottom', glyph: 'share', row: 'Safari로 열기' },
  },
  instagram: {
    label: '인스타그램',
    where: '오른쪽 위 <b>···</b> 버튼',
    pick: '외부 브라우저에서 열기',
    art: { corner: 'top', glyph: 'dots', row: '외부 브라우저' },
  },
  threads: {
    label: '스레드',
    where: '오른쪽 위 <b>···</b> 버튼',
    pick: '외부 브라우저에서 열기',
    art: { corner: 'top', glyph: 'dots', row: '외부 브라우저' },
  },
  facebook: {
    label: '페이스북',
    where: '오른쪽 위 <b>···</b> 버튼',
    pick: '외부 브라우저에서 열기',
    art: { corner: 'top', glyph: 'dots', row: '외부 브라우저' },
  },
  naver: {
    label: '네이버 앱',
    where: '오른쪽 아래 <b>···</b> 버튼',
    pick: '다른 브라우저로 열기',
    art: { corner: 'bottom', glyph: 'dots', row: '다른 브라우저' },
  },
  daum: {
    label: '다음 앱',
    where: '<b>···</b> 또는 <b>공유 버튼</b>',
    pick: 'Safari로 열기',
    art: { corner: 'bottom', glyph: 'dots', row: 'Safari로 열기' },
  },
  other: {
    label: '이 앱',
    where: '<b>···</b> 또는 <b>공유 버튼</b>',
    pick: 'Safari로 열기',
    art: { corner: 'bottom', glyph: 'dots', row: 'Safari로 열기' },
  },
};

// ---------------------------------------------------------------------------
// Gate markup
// ---------------------------------------------------------------------------

// First run: a tab is not the installed app. Storage is separate, and Safari deletes a
// site's storage after about a week of browser use without a visit (ITP); only the installed
// app is exempt.
const TRIAL_WARNING = '여기서 키운 펫은 설치한 앱으로 옮겨지지 않고,<br>일주일쯤 안 열면 사라질 수 있어요';
// Opened from 설정 by someone who already has a pet here: the same sentence would be wrong,
// because the save code does carry the pet over.
const IN_GAME_LABEL = '닫고 계속 키우기';
const IN_GAME_NOTE = '<b>설정 → 저장 코드 → 내보내기</b>로 코드를 복사해 두면<br>설치한 앱에서 이어서 키울 수 있어요';

function headHtml(frames) {
  return (
    `<header class="gate__head">` +
    `<div class="gate__plate">${appIconHtml(frames, 'gate-icon--hero')}</div>` +
    `<h1 class="gate__word" id="gateTitle">품알</h1>`
  );
}

function footHtml(label, inGame) {
  return (
    `<footer class="gate__foot">` +
    `<button type="button" class="gate__quiet" data-gate-act="play">${inGame ? IN_GAME_LABEL : label}</button>` +
    `<p class="gate__warn">${inGame ? IN_GAME_NOTE : TRIAL_WARNING}</p>` +
    `</footer>`
  );
}

function stepTitle(n, title) {
  return `<h2><span class="gate-step__num" aria-hidden="true">${n}</span>${title}</h2>`;
}

// Which way into Share to show first (see artShare).
function shareKind(env, ua) {
  if (!env || !env.safari) return 'dots';
  const major = safariMajor(ua);
  if (major === null) return 'both';
  return major >= 27 ? 'hold' : 'dots';
}

function shareStepHtml(env, kind) {
  // Non-Safari iOS browsers keep their share button in their own menu; the rest is the same sheet.
  if (env && env.ios && !env.safari) return `<p>브라우저 메뉴에서 <b>공유</b>를 눌러요</p>`;
  if (kind === 'hold') {
    return (
      `<p><b>주소창을 꾹</b> 누르고 → <b>공유</b></p>` +
      `<p class="gate-step__note">주소창 왼쪽 메뉴 버튼으로도 열려요<br>공유 버튼이 보이면 바로 눌러요</p>`
    );
  }
  if (kind === 'both') {
    return (
      `<p>주소창 옆 <b>···</b> → <b>공유</b></p>` +
      `<p>또는 <b>주소창을 꾹</b> → <b>공유</b></p>` +
      `<p class="gate-step__note">공유 버튼이 보이면 바로 눌러요</p>`
    );
  }
  return (
    `<p>주소창 옆 <b>···</b> → <b>공유</b></p>` +
    `<p class="gate-step__note">주소창을 꾹 눌러도 돼요<br>공유 버튼이 보이면 바로 눌러요</p>`
  );
}

function installScreenHtml(frames, env, { ua = '', inGame = false } = {}) {
  const kind = shareKind(env, ua);
  return (
    `<section class="gate gate--install" aria-labelledby="gateTitle"><div class="gate__inner">` +
    headHtml(frames) +
    `<p class="gate__lead">홈 화면에 추가하면 앱처럼<br>품에 안고 키울 수 있어요.</p>` +
    `</header>` +
    `<ol class="gate__steps">` +
    `<li class="gate-step"><div class="gate-step__text">${stepTitle(1, '공유 열기')}${shareStepHtml(env, kind)}</div>${artShare(kind)}</li>` +
    `<li class="gate-step"><div class="gate-step__text">${stepTitle(2, '홈 화면에 추가')}` +
    `<p>목록을 내려서 찾아 눌러요</p>` +
    `<p class="gate-step__note">안 보이면 맨 아래 <b>동작 편집</b></p></div>${ART_ADD}</li>` +
    `<li class="gate-step"><div class="gate-step__text">${stepTitle(3, '그대로 추가')}` +
    `<p><b>웹 앱으로 열기</b>는 켜 둔 채</p>` +
    `<p><b>추가</b>를 눌러요</p></div>${artConfirm(frames)}</li>` +
    `</ol>` +
    `<div class="gate__final"><p class="gate__final-line">${appIconHtml(frames, 'gate-icon--mini', false)}` +
    `<span>홈 화면의 품알 아이콘으로<br>다시 열어 주세요</span></p>` +
    // The icon was added with "Open as Web App" switched off: it opens this tab again.
    `<p class="gate__final-note">아이콘으로 열었는데도 이 화면이 보이면<br>` +
    `아이콘을 지우고 <b>웹 앱으로 열기</b>를 켠 채 다시 추가해 주세요</p></div>` +
    footHtml('설치 없이 해보기', inGame) +
    `</div></section>`
  );
}

function escapeScreenHtml(frames, env, link, { inGame = false } = {}) {
  const info = IN_APP_INFO[env && env.inApp] || IN_APP_INFO.other;
  const targetAttr = link.target ? ` target="${link.target}" rel="noopener"` : '';
  return (
    `<section class="gate gate--escape" aria-labelledby="gateHeadline"><div class="gate__inner">` +
    headHtml(frames) +
    `<p class="gate__headline" id="gateHeadline">Safari에서 열어야 <br>설치할 수 있어요</p>` +
    `<p class="gate__lead">${info.label} 안에서는<br>홈 화면에 추가할 수 없어요.</p>` +
    `</header>` +
    `<a class="gate-btn gate-btn--primary" data-gate-act="open" href="${link.href}"${targetAttr}><span>Safari로 열기</span>${GLYPH.out}</a>` +
    `<div class="gate-step gate-step--manual">` +
    `<div class="gate-step__text"><h2>안 열리면 직접 열어요</h2>` +
    `<p>${info.where}</p><p>→ <b>${info.pick}</b></p></div>` +
    artInApp(info.art) +
    `</div>` +
    `<div class="gate-copy">` +
    `<input class="gate-copy__url" type="text" readonly inputmode="none" aria-label="품알 주소" value="${CANONICAL_URL}">` +
    `<button type="button" class="gate-btn gate-btn--ghost" data-gate-act="copy">주소 복사</button>` +
    `</div>` +
    `<p class="gate-copy__hint" role="status" aria-live="polite"></p>` +
    footHtml('그냥 여기서 해보기', inGame) +
    `</div></section>`
  );
}

// ---------------------------------------------------------------------------
// mountGate
// ---------------------------------------------------------------------------

const KAKAO_GUARD = 'pumal.gate.kakao';
const LINE_GUARD = 'pumal.gate.line';

/**
 * Renders a gate into `root` (#gateRoot). Returns unmount().
 * @param {HTMLElement} root
 * @param {'install' | 'escape'} mode
 * @param {ReturnType<typeof detectEnv>} env
 * @param {{ onPlayHere?: () => void, auto?: boolean, inGame?: boolean, ua?: string }} [opts]
 *   auto=false disables the automatic KakaoTalk / LINE hand-off (demo harness, debug).
 *   inGame=true is the guide opened from 설정 over a running game: the quiet link closes it
 *   (so does Escape) and the footer explains the save code instead of the trial warning.
 *   ua overrides the user agent that picks the Share step (tests, demo harness).
 */
export function mountGate(root, mode, env, { onPlayHere, auto = true, inGame = false, ua = defaultUA() } = {}) {
  if (!root || (mode !== 'install' && mode !== 'escape')) return () => {};

  let frames = FALLBACK_MASCOT;
  let alive = true;
  let autoTimer = 0;
  let copyTimer = 0;
  const link = escapeLink(env && env.inApp, { href: typeof location !== 'undefined' ? location.href : '' });

  const render = () => {
    root.innerHTML = mode === 'install'
      ? installScreenHtml(frames, env, { ua, inGame })
      : escapeScreenHtml(frames, env, link, { inGame });
    root.dataset.gate = mode;
  };

  const unmount = () => {
    if (!alive) return;
    alive = false;
    clearTimeout(autoTimer);
    clearTimeout(copyTimer);
    root.removeEventListener('click', onClick);
    if (inGame && typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown);
    root.innerHTML = '';
    delete root.dataset.gate;
  };

  async function onCopy() {
    const input = root.querySelector('.gate-copy__url');
    const btn = root.querySelector('[data-gate-act="copy"]');
    const hint = root.querySelector('.gate-copy__hint');
    const ok = await copyText(CANONICAL_URL, input);
    if (!alive || !btn) return;
    if (ok) {
      btn.textContent = '복사했어요!';
      if (hint) hint.textContent = 'Safari 주소창에 붙여 넣어 주세요';
      if (input) input.blur();
    } else {
      // Leave the address selected so a long press can still copy it.
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      }
      if (hint) hint.textContent = '주소를 꾹 눌러 복사해 주세요';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (alive && btn.isConnected) btn.textContent = '주소 복사';
    }, 2200);
  }

  function playHere() {
    unmount();
    if (typeof onPlayHere === 'function') onPlayHere();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !alive) return;
    event.preventDefault();
    playHere();
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-gate-act]') : null;
    if (!target || !root.contains(target)) return;
    const act = target.getAttribute('data-gate-act');
    if (act === 'play') {
      playHere();
    } else if (act === 'copy') {
      onCopy();
    } else if (act === 'open' && link.sync) {
      // Meta's webviews only honour the scheme when it is set synchronously in the tap.
      event.preventDefault();
      location.href = link.href;
    }
  }

  render();
  root.addEventListener('click', onClick);
  if (inGame && typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);

  // Swap in the real baby sprite when the art module is there. The gate never waits for it.
  import('./sprites.js')
    .then((mod) => {
      const idle = mod && mod.SPECIES_ART && mod.SPECIES_ART.mongsil && mod.SPECIES_ART.mongsil.idle;
      if (!alive || !Array.isArray(idle) || !idle.every(isBitmap)) return;
      frames = idle.slice(0, 2);
      // Only the dots are replaced; a full re-render would replay the entrance and wipe
      // whatever the user has done on the screen in the meantime.
      root.querySelectorAll('.gate-icon').forEach((icon) => {
        const lcd = icon.querySelector('.gate-lcd');
        if (lcd) lcd.innerHTML = mascotSvg(frames, { animate: icon.classList.contains('gate-icon--hero') });
      });
    })
    .catch(() => {});

  if (mode === 'escape' && auto && env && env.ios) {
    if (env.inApp === 'kakaotalk' && !sessionGet(KAKAO_GUARD)) {
      sessionSet(KAKAO_GUARD, '1');
      // After a beat, so the manual instructions are on screen before the app switch.
      // The in-app browser is never closed from here: if the hand-off fails the user must
      // still have this page.
      autoTimer = setTimeout(() => {
        try {
          location.href = link.href;
        } catch {
          // An unhandled scheme must not take the gate down.
        }
      }, 350);
    } else if (env.inApp === 'line' && !sessionGet(LINE_GUARD) && !/[?&]openExternalBrowser=1\b/.test(location.href)) {
      sessionSet(LINE_GUARD, '1');
      location.replace(withParam(location.href, 'openExternalBrowser', '1'));
    }
  }

  return unmount;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<'shared' | 'copied' | 'failed'>}
 */
export async function shareApp() {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url: CANONICAL_URL });
      return 'shared';
    } catch (err) {
      // Closing the share sheet is not an error worth a clipboard write behind the user's back.
      if (err && err.name === 'AbortError') return 'failed';
    }
  }
  if (typeof document === 'undefined') return 'failed';
  return (await copyText(CANONICAL_URL)) ? 'copied' : 'failed';
}

// ---------------------------------------------------------------------------
// Android install prompt
// ---------------------------------------------------------------------------

let deferredPrompt = null;
const installListeners = new Set();

// The event fires once, early; it has to be caught as soon as this module evaluates.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installListeners.forEach((cb) => cb(true));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installListeners.forEach((cb) => cb(false));
  });
}

export function canPromptInstall() {
  return deferredPrompt !== null;
}

/**
 * Must be called from a tap. Resolves 'accepted' | 'dismissed' | 'unavailable'.
 */
export async function promptInstall() {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null; // a prompt event can be used only once
  installListeners.forEach((cb) => cb(false));
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}

/**
 * cb(available: boolean) is called now if a prompt is already waiting, and on every change.
 * Returns an unsubscribe function.
 */
export function onInstallAvailable(cb) {
  installListeners.add(cb);
  if (deferredPrompt) cb(true);
  return () => installListeners.delete(cb);
}

/**
 * Optional Android helper: a small "앱으로 설치" pill that shows itself only while an install
 * prompt is available. Returns unmount().
 */
export function mountInstallPill(root) {
  if (typeof document === 'undefined') return () => {};
  const host = root || document.body;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'gate-pill';
  pill.hidden = true;
  pill.textContent = '앱으로 설치';
  pill.addEventListener('click', () => {
    promptInstall();
  });
  host.appendChild(pill);
  const off = onInstallAvailable((available) => {
    pill.hidden = !available;
  });
  return () => {
    off();
    pill.remove();
  };
}

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------

const RELOAD_GUARD = 'pumal.sw.reloadAt';
const RELOAD_GUARD_MS = 30000;

// The update state of the registration made by registerSW(). One page registers once.
let swUpdate = null;

/** True while a new worker has taken over but this page still runs the previous version. */
export function isUpdatePending() {
  return Boolean(swUpdate && swUpdate.pending);
}

/**
 * Reloads into a pending update if there is one and nothing forbids it right now.
 * Call it on a return to visible (visibilitychange → visible, pageshow) BEFORE anything
 * replays the absence, and stop there when it returns true: the reloaded page then does the
 * catch-up itself and the player gets the recap from the new version.
 * @returns {boolean} true when a reload has been started
 */
export function applyPendingUpdate() {
  return swUpdate ? swUpdate.apply('show') : false;
}

// SPEC section 7: #sheetRoot is empty whenever no sheet is open. A reload would close the
// sheet and drop whatever was typed into it.
function sheetOpen() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return false;
  const root = document.getElementById('sheetRoot');
  return Boolean(root && root.childElementCount > 0);
}

/**
 * Registers sw.js and checks for an update on launch and on every return to visible (an
 * installed iOS web app is one long-lived page, so navigation-triggered checks never come).
 *
 * A new worker takes over as soon as it has installed (skipWaiting + clients.claim), which
 * is seconds into a session. Reloading right then would wipe what the player is looking at:
 * the "while you were away" recap, a hatch or evolution reveal, an open sheet, a game. Those
 * are played from memory once and cannot be replayed after a reload. So the update is only
 * remembered, and the page reloads at a moment that costs nothing:
 *   - at once, if the page is visible, has had no input yet and `canReload('now')` says the
 *     screen is idle (no canReload: never at once);
 *   - otherwise on the next return to visible, before the absence is replayed, unless a
 *     sheet is open or `canReload('show')` says no. Then it waits for the return after that.
 * If the page is closed first, the next launch is already served by the new worker.
 * `beforeReload` (saves the game) runs just before every reload. Two reloads are never
 * closer than 30 s.
 *
 * @param {{ beforeReload?: () => void, canReload?: (when: 'now' | 'show') => boolean }} [opts]
 * @returns {Promise<ServiceWorkerRegistration | null>}
 */
export function registerSW({ beforeReload, canReload } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  // Development: a cache-first worker on localhost hides every edit. Opt in with ?sw=1.
  if (isLocal && new URLSearchParams(location.search).get('sw') !== '1') return Promise.resolve(null);

  const sw = navigator.serviceWorker;
  const visible = () => document.visibilityState === 'visible';
  let sawInput = false;

  function reloadNow() {
    // Time-based instead of a permanent flag: it stops a reload loop but still lets a
    // second deploy reach a page that stays alive for days.
    const last = Number(sessionGet(RELOAD_GUARD)) || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionSet(RELOAD_GUARD, String(Date.now()));
    update.reloading = true;
    try {
      if (typeof beforeReload === 'function') beforeReload();
    } catch {
      // Saving failed; reloading anyway is still better than running two versions.
    }
    location.reload();
    return true;
  }

  const update = {
    pending: false,
    reloading: false,
    apply(when) {
      if (update.reloading) return true;
      if (!update.pending) return false;
      let ok = false;
      try {
        // Never while hidden: iOS can suspend a reload that starts in the background half-way.
        ok = visible() && !sheetOpen() &&
          (typeof canReload === 'function' ? canReload(when) === true : when === 'show');
      } catch {
        ok = false;
      }
      return ok ? reloadNow() : false;
    },
  };
  swUpdate = update;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const mark = () => {
      sawInput = true;
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
    };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
  }

  // The very first worker claiming an uncontrolled page serves the same files the page
  // already has; only a replacement of an existing controller means "new version".
  let hadController = Boolean(sw.controller);
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    update.pending = true;
    if (!sawInput) update.apply('now');
  });

  // Capture, and registered before anything else in the app listens: when the page comes
  // back with an update waiting, the reload must win over every other "visible" handler.
  // One of them replays the absence and saves the result, and the reloaded page would then
  // find nothing left to show. The app may also call applyPendingUpdate() itself first.
  // For the same reason the page that is on its way out is kept away from the save: its
  // "hidden" and "pagehide" handlers (both fire during the reload) would replay the absence
  // too. beforeReload has already saved.
  document.addEventListener('visibilitychange', (event) => {
    if (update.reloading || (visible() && update.apply('show'))) event.stopImmediatePropagation();
  }, true);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', (event) => {
      if (update.reloading) event.stopImmediatePropagation();
    }, true);
  }

  return sw
    .register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      const check = () => {
        reg.update().catch(() => {});
      };
      check();
      document.addEventListener('visibilitychange', () => {
        if (visible()) check();
      });
      return reg;
    })
    .catch(() => null);
}
