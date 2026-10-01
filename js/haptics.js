// Key-click haptics (SPEC section 8). Progressive enhancement only: the game must feel
// complete with the visual press and the beep alone.
//
// iOS has no vibration API. The one thing that still ticks is the system haptic of
// <input type="checkbox" switch>, and since iOS 26.5 only for a trusted tap: a real finger
// landing on a <label> that wraps the switch. A scripted .click() is forwarded as untrusted
// and stays silent, so nothing in this file ever calls it. Consequences the rest of the app
// must live with: one tick per tap, at finger-up, and never for timers or events.

const g = globalThis;

let enabled = true;
const hosts = new WeakSet();
const labels = new Set();

function isIOS() {
  const n = g.navigator;
  if (!n) return false;
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(n.userAgent || '') ||
    (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
}

function attachSwitch(el, doc) {
  const label = doc.createElement('label');
  label.setAttribute('data-haptic-trigger', '');
  label.setAttribute('aria-hidden', 'true');
  const ls = label.style;
  ls.position = 'absolute';
  ls.inset = '0';
  ls.display = 'block';
  ls.margin = '0';
  ls.touchAction = 'manipulation';
  // A square label over a round key would make the corners tappable.
  ls.borderRadius = 'inherit';
  ls.setProperty('-webkit-tap-highlight-color', 'transparent');
  if (!enabled) ls.pointerEvents = 'none';

  // The switch itself must stay out from under the finger (WebKit treats a touch on it as
  // handled) and must keep its native appearance: no appearance reset, no display:none.
  // visibility:hidden keeps it alive for the label and out of hit-testing and tab order.
  const sw = doc.createElement('input');
  sw.type = 'checkbox';
  sw.setAttribute('switch', '');
  sw.tabIndex = -1;
  const ss = sw.style;
  ss.position = 'absolute';
  ss.width = '1px';
  ss.height = '1px';
  ss.margin = '0';
  ss.visibility = 'hidden';
  // The label's click is forwarded to the switch as a second click event. Stop that one
  // here so the host sees exactly one click per tap (the label's own, which bubbles).
  sw.addEventListener('click', (e) => e.stopPropagation());
  label.appendChild(sw);

  const view = doc.defaultView || g;
  try {
    if (typeof view.getComputedStyle === 'function' && view.getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
  } catch { /* detached element */ }
  el.appendChild(label);
  labels.add(label);

  // If the host's content is rewritten (textContent / innerHTML), the overlay goes with it.
  // Put it back, last, so it stays on top.
  const MO = view.MutationObserver || g.MutationObserver;
  if (typeof MO === 'function') {
    new MO(() => { if (label.parentNode !== el) el.appendChild(label); })
      .observe(el, { childList: true });
  }
}

/**
 * Give a tappable element a haptic tick. Safe to call more than once and on any platform.
 * The host keeps its own pointer / click handlers; they still fire once per tap.
 */
export function attachHaptic(el) {
  if (!el || hosts.has(el)) return;
  const doc = el.ownerDocument || g.document;
  if (!doc || typeof doc.createElement !== 'function') return;
  hosts.add(el);
  try {
    if (isIOS()) {
      attachSwitch(el, doc);
      return;
    }
    const n = g.navigator;
    if (n && typeof n.vibrate === 'function' && typeof el.addEventListener === 'function') {
      // Android. Chrome ignores vibrate() until the page has had one full tap; that first
      // silent press is acceptable.
      el.addEventListener('pointerdown', (e) => {
        if (!enabled || e.isPrimary === false) return;
        // Before the first full tap the call is refused anyway, and Chrome logs a warning
        // for every attempt; ask first where the browser can tell us.
        const ua = n.userActivation;
        if (ua && ua.hasBeenActive === false) return;
        try { n.vibrate(8); } catch { /* blocked */ }
      }, { passive: true });
    }
  } catch { /* haptics are optional */ }
}

export function setHapticsEnabled(on) {
  enabled = !!on;
  // With the label out of hit-testing the finger lands on the host directly: same handlers,
  // no switch toggle, no tick. '' rather than 'auto' so a host that disables its own
  // pointer events is not overridden.
  for (const label of labels) label.style.pointerEvents = enabled ? '' : 'none';
}

/** 'switch' (iOS label overlay) | 'vibrate' (Android) | 'none' — for a settings hint or a self-check. */
export function hapticsKind() {
  if (isIOS()) return 'switch';
  const n = g.navigator;
  return n && typeof n.vibrate === 'function' ? 'vibrate' : 'none';
}
