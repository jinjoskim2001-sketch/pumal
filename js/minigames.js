// The two mini-games (SPEC 11.4). Each game is a small state machine that scenes.js drives:
// tick(dt) on the 250 ms logic clock, key(k) on a key press, draw(lcd) into the matrix.
//
// Constraints that shape this file:
// - Everything inside the glass is discrete: positions are whole dots and time is whole
//   250 ms steps. Nothing here interpolates.
// - All three keys are game keys in both games, so a plain C cannot also mean "quit".
//   quit() is called by scenes.js on a long press of C; it ends the game as not completed,
//   unless every round has already been played (the final score is on screen): a finished
//   game stays finished.
// - A game never waits for ever: it holds the screen wake lock, so 가위바위보 left on its
//   "choose" screen gives up by itself (not completed) instead of keeping the display on.
// - rng is injected so a test (or a ?shot= state) can replay a game exactly.
// - No DOM and no engine calls: the host turns `result` into act('playEnd').

import { ITEMS, FONT_SMALL, FONT_BIG } from './sprites.js';
import { COLS, ROWS } from './lcd.js';

const STEP_MS = 250;
const EMPTY = ['.'];

const boxCache = new WeakMap();

// Bounding box of the lit dots of a bitmap. Creatures differ a lot in height (a lying-flat
// adult is 7 rows, a standing one 16), so anything placed "at the head" must ask for this.
export function inkBox(bmp) {
  if (!Array.isArray(bmp) || !bmp.length) return { top: 0, bottom: 0, left: 0, right: 0 };
  let box = boxCache.get(bmp);
  if (box) return box;
  let top = bmp.length, bottom = -1, left = bmp[0].length, right = -1;
  for (let y = 0; y < bmp.length; y++) {
    const row = bmp[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  box = bottom < 0 ? { top: 0, bottom: bmp.length - 1, left: 0, right: bmp[0].length - 1 } : { top, bottom, left, right };
  boxCache.set(bmp, box);
  return box;
}

function frames(art) {
  const a = art && typeof art === 'object' ? art : {};
  const idle = Array.isArray(a.idle) && a.idle.length ? a.idle : [EMPTY, EMPTY];
  return {
    idle: [idle[0], idle[1] || idle[0]],
    happy: a.happy || idle[0],
    upset: a.upset || idle[0],
  };
}

function context(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const rng = typeof c.rng === 'function' ? c.rng : Math.random;
  return {
    art: frames(c.art),
    stage: typeof c.stage === 'string' ? c.stage : 'child',
    sound: typeof c.sound === 'function' ? c.sound : () => {},
    // A broken rng must not be able to pick a lane or a hand that does not exist.
    pick(n) {
      let r = 0;
      try { r = Number(rng()); } catch (err) { r = 0; }
      if (!(r >= 0 && r < 1)) r = 0;
      return Math.min(n - 1, Math.floor(r * n));
    },
  };
}

// Shared shell: accumulates real time into whole steps and holds the public fields.
function shell(step) {
  let acc = 0;
  const game = {
    done: false,
    result: null,
    caption: '',
    tick(dt) {
      acc += dt > 0 ? dt : STEP_MS;
      // A long stall (tab was hidden) must not replay as a burst of steps.
      if (acc > STEP_MS * 4) acc = STEP_MS * 4;
      while (acc >= STEP_MS && !game.done) {
        acc -= STEP_MS;
        step();
      }
    },
  };
  return game;
}

function centerText(lcd, str, y, font) {
  const w = lcd.textWidth(str, font);
  lcd.text(str, (COLS - w) >> 1, y, font);
}

// ---- 가위바위보 --------------------------------------------------------------------------

const RPS_ROUNDS = 5;
const RPS_WIN = 3;
const RPS_REPLAYS = 2;
const RPS_IDLE_STEPS = 80;        // 20 s on the choose screen with no key: the player has left
const RPS_LEGEND = 'A 가위 · B 바위 · C 보';

function createRps(c) {
  // Key order on the device, left to right: A scissors, B rock, C paper.
  const HANDS = [ITEMS.scissors, ITEMS.rock, ITEMS.paper];
  const NAMES = ['가위', '바위', '보'];
  const SLOT_X = [0, 18, 36];
  const KEY_HAND = { A: 0, B: 1, C: 2 };

  let round = 0, wins = 0, losses = 0, replays = 0;
  let phase = 'choose';   // choose -> think -> show -> (choose | final)
  let pt = 0, beat = 0;
  let mine = -1, theirs = -1, outcome = '';
  const marks = [];       // one per finished round: true = the player took it

  const game = shell(step);
  game.caption = RPS_LEGEND;

  function finish(completed) {
    if (game.done) return;
    game.result = { completed, won: completed && wins >= RPS_WIN };
    game.done = true;
  }

  function reveal() {
    theirs = c.pick(3);
    const d = (mine - theirs + 3) % 3;
    if (d === 1) outcome = 'win';
    else if (d === 2) outcome = 'loss';
    else outcome = replays >= RPS_REPLAYS ? 'tie-loss' : 'draw';
    phase = 'show';
    pt = 0;
    if (outcome === 'win') {
      c.sound('point');
      game.caption = `${NAMES[mine]} 승! 이겼어요`;
    } else if (outcome === 'draw') {
      c.sound('select');
      game.caption = '비겼어요! 한 번 더';
    } else {
      c.sound('miss');
      game.caption = outcome === 'loss' ? '앗, 졌어요…' : '또 비겨서 졌어요…';
    }
  }

  function next() {
    if (outcome === 'draw') {
      replays++;
    } else {
      const won = outcome === 'win';
      marks.push(won);
      if (won) wins++; else losses++;
      round++;
      replays = 0;
    }
    mine = -1;
    theirs = -1;
    pt = 0;
    if (round >= RPS_ROUNDS) {
      phase = 'final';
      const won = wins >= RPS_WIN;
      c.sound(won ? 'win' : 'lose');
      game.caption = won ? `${wins}승 ${losses}패! 이겼어요` : `${wins}승 ${losses}패… 아쉬워요`;
    } else {
      phase = 'choose';
      game.caption = RPS_LEGEND;
    }
  }

  function step() {
    beat++;
    pt++;
    if (phase === 'choose' && pt >= RPS_IDLE_STEPS) finish(false);
    else if (phase === 'think' && pt >= 3) reveal();
    else if (phase === 'show' && pt >= 6) next();
    else if (phase === 'final' && pt >= 12) finish(true);
  }

  game.key = (k) => {
    if (game.done) return;
    if (phase === 'choose') {
      if (!(k in KEY_HAND)) return;
      mine = KEY_HAND[k];
      phase = 'think';
      pt = 0;
      c.sound('rps');
      game.caption = `${NAMES[mine]}! 가위, 바위…`;
    } else if (phase === 'show') {
      next();                     // an impatient press moves on instead of being swallowed
    } else if (phase === 'final' && pt >= 2) {
      finish(true);
    }
  };

  game.quit = () => finish(phase === 'final');

  game.draw = (lcd) => {
    const a = c.art;
    const flip = (beat >> 1) & 1;

    if (phase === 'final') {
      const won = wins >= RPS_WIN;
      centerText(lcd, `${wins}:${losses}`, 1, FONT_BIG);
      const hop = won && pt % 4 < 2 ? -2 : 0;
      lcd.sprite(won ? a.happy : a.idle[flip], 16, 16 + hop);
      if (won) {
        lcd.sprite(ITEMS.sparkle[flip], 4, 15);
        lcd.sprite(ITEMS.sparkle[1 - flip], 37, 13);
      } else {
        lcd.sprite(ITEMS.sweat, 35, 15);
      }
      return;
    }

    // round pips, top right: taken = solid, lost = hollow, to come = a single dot
    for (let i = 0; i < RPS_ROUNDS; i++) {
      const x = 28 + i * 4;
      if (i < marks.length) {
        if (marks[i]) lcd.rect(x, 0, 3, 3, true); else lcd.frame(x, 0, 3, 3);
      } else if (i !== round || flip === 0 || phase !== 'choose') {
        lcd.dot(x + 1, 1);
      }
    }

    let frame = a.idle[flip];
    if (phase === 'show') frame = outcome === 'win' ? a.upset : outcome === 'draw' ? a.idle[0] : a.happy;
    lcd.sprite(frame, 2, 1);

    // the creature's hand: three quick frames of "thinking", then the real one
    if (phase === 'think') lcd.sprite(HANDS[pt % 3], 26, 5, { flipX: true });
    else if (phase === 'show') lcd.sprite(HANDS[theirs], 26, 5, { flipX: true });
    else lcd.text('?', 30, 8, FONT_SMALL);

    for (let x = 1; x < COLS; x += 2) lcd.dot(x, 18);

    if (phase === 'choose') {
      for (let i = 0; i < 3; i++) lcd.sprite(HANDS[i], SLOT_X[i], 20);
    } else if (mine >= 0) {
      lcd.sprite(HANDS[mine], SLOT_X[mine], 20);
      if (phase === 'show' && outcome === 'win') {
        const sx = mine === 2 ? SLOT_X[mine] - 9 : SLOT_X[mine] + 14;
        lcd.sprite(ITEMS.sparkle[flip], sx, 22);
      }
    }
  };

  return game;
}

// ---- 별 받기 -------------------------------------------------------------------------------

const CATCH_STARS = 10;
const CATCH_WIN = 6;
const CATCH_DROPS = 3;
const CATCH_LEGEND = 'A 왼쪽 · B 폴짝 · C 오른쪽';
const LANE_X = [0, 16, 32];
const PET_Y = ROWS - 16;          // the creature stands on the very last row here: more sky

function createCatch(c) {
  const withDrops = c.stage === 'teen' || c.stage === 'adult' || c.stage === 'special';

  // What falls, in order. Always ten stars; older creatures get rain mixed in after the
  // first two stars, and never two drops in a row.
  const queue = [];
  for (let i = 0; i < CATCH_STARS; i++) queue.push('star');
  if (withDrops) {
    for (let n = 0; n < CATCH_DROPS; n++) {
      for (let tries = 0; tries < 8; tries++) {
        const at = 2 + c.pick(queue.length - 2);
        if (queue[at] === 'drop' || queue[at - 1] === 'drop') continue;
        queue.splice(at, 0, 'drop');
        break;
      }
    }
  }

  let lane = 1;
  let item = null;          // { kind, lane, y }
  let qi = 0, starsOut = 0, caught = 0;
  let gap = 3;              // steps until the next item appears
  let hop = 0, mood = 0;    // mood > 0 happy steps left, < 0 upset steps left
  let phase = 'play', pt = 0, beat = 0;
  let touched = false;

  const game = shell(step);
  game.caption = CATCH_LEGEND;

  const headRow = () => PET_Y + inkBox(c.art.idle[0]).top - (hop > 0 ? 3 : 0);

  function status() {
    game.caption = `별 ${caught}개 · 남은 별 ${CATCH_STARS - starsOut}`;
  }

  function finish(completed) {
    if (game.done) return;
    game.result = { completed, won: completed && caught >= CATCH_WIN };
    game.done = true;
  }

  function settle() {
    if (!item) return;
    const bottom = item.y + 5;
    if (item.lane === lane && bottom >= headRow()) {
      if (item.kind === 'star') {
        caught++;
        mood = 2;
        c.sound('point');
      } else {
        caught = Math.max(0, caught - 1);
        mood = -3;
        c.sound('miss');
      }
    } else if (bottom >= ROWS - 1) {
      if (item.kind === 'star') {
        mood = -2;
        c.sound('miss');
      }
    } else {
      return;
    }
    item = null;
    gap = 2;
    if (touched || qi > 1) status();
  }

  function step() {
    beat++;
    if (phase === 'final') {
      if (++pt >= 12) finish(true);
      return;
    }
    if (hop > 0) hop--;
    if (mood > 0) mood--; else if (mood < 0) mood++;
    if (!item) {
      if (--gap > 0) return;
      if (qi >= queue.length) {
        phase = 'final';
        pt = 0;
        const won = caught >= CATCH_WIN;
        c.sound(won ? 'win' : 'lose');
        game.caption = won ? `별 ${caught}개! 이겼어요` : `별 ${caught}개… 아쉬워요`;
        return;
      }
      const kind = queue[qi++];
      if (kind === 'star') starsOut++;
      item = { kind, lane: c.pick(3), y: -5 };
      return;
    }
    // speeds up: 3 dots a step for the first stars, 6 for the last
    item.y += 3 + Math.min(3, Math.floor((starsOut - 1) / 3));
    settle();
  }

  game.key = (k) => {
    if (game.done) return;
    if (phase === 'final') {
      if (pt >= 2) finish(true);
      return;
    }
    touched = true;
    if (k === 'A') lane = Math.max(0, lane - 1);
    else if (k === 'C') lane = Math.min(2, lane + 1);
    else if (k === 'B') hop = 2;
    c.sound('select');
    settle();                 // moving under a star catches it at once, not a step later
    if (game.caption === CATCH_LEGEND) status();
  };

  game.quit = () => finish(phase === 'final');

  game.draw = (lcd) => {
    const a = c.art;
    const flip = (beat >> 1) & 1;

    if (phase === 'final') {
      const won = caught >= CATCH_WIN;
      const s = String(caught);
      const w = 7 + 3 + lcd.textWidth(s, FONT_BIG);
      const x = (COLS - w) >> 1;
      lcd.sprite(ITEMS.starFull, x, 2);
      lcd.text(s, x + 10, 1, FONT_BIG);
      const up = won && pt % 4 < 2 ? -2 : 0;
      lcd.sprite(won ? a.happy : a.idle[flip], 16, PET_Y + up);
      if (won) {
        lcd.sprite(ITEMS.sparkle[flip], 4, 15);
        lcd.sprite(ITEMS.sparkle[1 - flip], 37, 13);
      } else {
        lcd.sprite(ITEMS.sweat, 35, 15);
      }
      return;
    }

    const frame = mood > 0 ? a.happy : mood < 0 ? a.upset : a.idle[flip];
    lcd.sprite(frame, LANE_X[lane], PET_Y - (hop > 0 ? 3 : 0));
    if (item) lcd.sprite(item.kind === 'star' ? ITEMS.star : ITEMS.drop, LANE_X[item.lane] + 5, item.y);

    // score, top right, drawn last so a falling item never hides it
    const s = String(caught);
    const sw = lcd.textWidth(s, FONT_SMALL);
    lcd.rect(COLS - sw - 2, 0, sw + 2, 7, false);
    lcd.text(s, COLS - sw - 1, 1, FONT_SMALL);
  };

  return game;
}

// kind: 'rps' | 'catch'. ctx: { rng, art, stage, sound }.
// Returns { tick(dt), key(k), draw(lcd), quit(), done, result, caption }.
export function createGame(kind, ctx) {
  const c = context(ctx);
  return kind === 'catch' ? createCatch(c) : createRps(c);
}
