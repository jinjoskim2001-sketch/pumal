// Save, load, export and import for 품알 (SPEC 5.9).
//
// Constraints that shape this file:
// - Saving must be synchronous: iOS gives no time for async work on `pagehide`.
// - Every localStorage access can throw (private mode, storage disabled, quota), so each one
//   sits in try/catch and failure degrades to "no save" instead of an exception.
// - The state is persisted verbatim. Range-checking the numbers is the engine's job (it
//   sanitises on every advance/act); this file only refuses things that are not a save at all.
// - The same save can be open twice (two tabs, a tab and the installed app on Android). Each
//   instance remembers the exact text it last read or wrote, and a save is refused while a
//   different valid one is stored, so a stale instance cannot overwrite newer progress.

const SAVE_KEY = 'pumal.save.v1';
const BACKUP_KEY = 'pumal.save.v1.bak';
const BACKUP_AT_KEY = 'pumal.save.v1.bak.at';
const PREFS_KEY = 'pumal.prefs.v1';

const SAVE_VERSION = 1;
const BACKUP_EVERY_MS = 10 * 60 * 1000;
const CODE_PREFIX = 'PUMAL1.';
const CODE_MAX_CHARS = 2000000;
const BAD_CODE = '코드가 올바르지 않아요';

export const DEFAULT_PREFS = Object.freeze({
  sound: true, haptics: true, skin: 'milk', tint: 'pea', solid: false, trial: false, seenGuide: false,
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function store() {
  // Reading the global can itself throw (Safari with storage blocked, sandboxed frames).
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch (err) {
    return null;
  }
}

function read(key) {
  try {
    const s = store();
    return s ? s.getItem(key) : null;
  } catch (err) {
    return null;
  }
}

function write(key, value) {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

function remove(key) {
  try {
    const s = store();
    if (s) s.removeItem(key);
  } catch (err) { /* nothing to remove from */ }
}

// The minimum that makes an object a save file of this version.
function isSave(x) {
  return isObj(x) && x.v === SAVE_VERSION && isObj(x.pet) && typeof x.pet.stage === 'string' &&
    isObj(x.settings) && typeof x.lastTick === 'number' && Number.isFinite(x.lastTick) &&
    Array.isArray(x.album) && isObj(x.dex);
}

function parseSave(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const obj = JSON.parse(raw);
    return isSave(obj) ? obj : null;
  } catch (err) {
    return null;
  }
}

// The main-key text this instance last read or wrote; null when it has none of its own.
let seen = null;

export function loadGame() {
  const raw = read(SAVE_KEY);
  const main = parseSave(raw);
  seen = main ? raw : null;
  return main || parseSave(read(BACKUP_KEY));
}

// True when another instance has stored a different, valid save since this one last read or
// wrote. An empty or unreadable main key is never a conflict: cleared site data, the first
// save after clearGame and a half-written main key must all stay writable.
export function changedElsewhere() {
  const raw = read(SAVE_KEY);
  return raw !== seen && parseSave(raw) !== null;
}

// Returns false when nothing was written: storage unavailable or full, or - unless `force` -
// another instance's save is stored (see changedElsewhere; the caller should load that one
// instead of warning). `force` is for the player's own decision to replace the game (import).
// `nowMs` exists for tests; the app calls saveGame(state).
export function saveGame(state, nowMs = Date.now(), force = false) {
  let json;
  try {
    json = JSON.stringify(state);
  } catch (err) {
    return false;
  }
  if (typeof json !== 'string' || !isSave(state)) return false;   // never overwrite a save with a non-save
  if (force !== true && changedElsewhere()) return false;
  const ok = write(SAVE_KEY, json);
  if (ok) {
    seen = json;
    // The backup is a second, slightly older copy: if the main key is ever unreadable the
    // player loses at most ten minutes instead of the pet.
    const last = Number(read(BACKUP_AT_KEY));
    if (!Number.isFinite(last) || last <= 0 || nowMs - last >= BACKUP_EVERY_MS || nowMs < last) {
      if (write(BACKUP_KEY, json)) write(BACKUP_AT_KEY, String(nowMs));
    }
  }
  return ok;
}

export function clearGame() {
  seen = null;
  remove(SAVE_KEY);
  remove(BACKUP_KEY);
  remove(BACKUP_AT_KEY);
}

// ---- save codes -----------------------------------------------------------------------

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function exportCode(state) {
  return CODE_PREFIX + toBase64Url(JSON.stringify(state));
}

export function importCode(text) {
  let state = null;
  try {
    // Codes travel through chat apps, which like to add spaces and line breaks.
    const code = String(text).replace(/\s+/g, '');
    if (code.length <= CODE_MAX_CHARS && code.startsWith(CODE_PREFIX)) {
      const body = code.slice(CODE_PREFIX.length);
      if (/^[A-Za-z0-9_-]+$/.test(body)) {
        const obj = JSON.parse(fromBase64Url(body));
        if (isSave(obj)) state = obj;
      }
    }
  } catch (err) {
    state = null;
  }
  if (!state) throw new Error(BAD_CODE);
  return state;
}

// ---- prefs ----------------------------------------------------------------------------

export function loadPrefs() {
  const prefs = { ...DEFAULT_PREFS };
  try {
    const obj = JSON.parse(read(PREFS_KEY));
    if (isObj(obj)) {
      for (const key of Object.keys(obj)) {
        if (key === '__proto__') continue;
        // Known keys must keep their type; keys other modules add later pass through.
        const known = Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, key);
        if (!known || typeof obj[key] === typeof DEFAULT_PREFS[key]) prefs[key] = obj[key];
      }
    }
  } catch (err) { /* unreadable prefs fall back to the defaults */ }
  return prefs;
}

export function savePrefs(prefs) {
  try {
    return write(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, ...(isObj(prefs) ? prefs : {}) }));
  } catch (err) {
    return false;
  }
}
