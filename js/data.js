// Species table, tuning constants and the Korean copy that belongs to the creatures.
// This file is data only: no logic that depends on time or randomness lives here, so
// the engine stays the single place where rules are applied.
//
// All durations are AWAKE minutes unless a name ends in REAL (SPEC 5.1).

export const STAGE_ORDER = ['egg', 'baby', 'child', 'teen', 'adult', 'special'];

// ---- tuning -----------------------------------------------------------------------

export const EGG_HATCH_MIN = 1;            // egg hatches after this long, or after EGG_TAPS taps
export const EGG_TAPS = 5;
export const HATCH_HUNGER = 1;             // the baby wants you at once, but is not at zero
export const HATCH_HAPPY = 1;
export const BABY_POOP_AT = [12, 30];      // scripted: stage minutes of the two baby messes

export const SPECIAL_CHECK_MIN = 2400;     // adult minutes at which the one special check runs
export const MATURE_MIN = 2880;            // adult minutes until an adult may leave (gentle)
export const SPECIAL_MATURE_MIN = 1440;    // minutes after becoming special until it may leave

// The shortest day the owner may set (bed - wake, wrapping past midnight). One slip of
// 오전 / 오후 on the time wheel would otherwise leave a pet that sleeps 21 hours for no visible
// reason. Only new settings are checked: a save that already holds a shorter day keeps it.
export const MIN_AWAKE_MIN = 360;

export const AWAY_CAP_MIN = 720;           // gentle: most awake minutes one absence can cost
export const MAX_CATCHUP_MIN = 43200;      // 30 days; anything older is dropped, not simulated

// Hunger / happy call grace. The pet cannot call a closed app, so both windows are sized for
// the check-in pattern each mode promises rather than for 1996's 15 minutes.
// Gentle is five hours: morning / lunch / after work (08:00, 12:30, 20:00) leaves a 7.5 hour
// evening gap, and a meter filled at lunch must not have cost a mistake by the evening visit.
// Classic is three hours: survivable with about four check-ins a day even when they are
// uneven (08:30, 13:00, 18:30, 22:00 has a 5.5 hour gap; with two hours that gap cost a
// mistake nearly every day and ended the adult by neglect).
export const GRACE = Object.freeze({ gentle: 300, classic: 180 });
// Gentle only: once a call has expired, every further stretch this long with the meter still
// empty is another care mistake (classic has starvation instead). Eight hours, so that one
// fully missed day reads as one bad day and not as a week's worth of mistakes.
export const REPEAT_ZERO_MIN = 480;
export const LIGHTS_GRACE_REAL_MIN = 15;
export const TANTRUM_GRACE_REAL_MIN = 15;
export const TANTRUM_COOLDOWN_MIN = 90;    // reloaded after every roll, hit or miss
export const TANTRUM_CHANCE = [0.6, 0.45, 0.3, 0.15, 0];   // indexed by discipline 0..4

export const METER_MAX = 4;
export const DISCIPLINE_MAX = 4;
export const WEIGHT_MAX = 99;
export const MEAL_WEIGHT = 1;
export const SNACK_WEIGHT = 2;
export const GAME_WEIGHT = 1;              // lost by a finished mini-game, win or lose

export const BOND_PER_PET = 1;
export const BOND_PER_WIN = 2;
export const BOND_PER_LOSS = 1;
export const BOND_PER_STAR = 12;           // bondStars = min(5, floor(bond / 12))
export const PET_CAP = 5;                  // effective pettings ...
export const PET_WINDOW_REAL_MIN = 60;     // ... per rolling real hour

export const POOP_MAX = 4;
// A mess older than this makes the pet sick. Gentle is eight hours: a mess that appears right
// after the lunch visit is not yet a sickness at the after-work visit 7.5 awake hours later
// (with 300 the pet was sick on most evening arrivals).
export const DIRTY_SICK_MIN = Object.freeze({ gentle: 480, classic: 180 });
export const SWEETS_COUNT = 4;             // this many snacks ...
export const SWEETS_WINDOW_MIN = 30;       // ... within this window makes the pet sick

export const SICK_MISTAKE_EVERY_MIN = 240; // gentle: untreated sickness costs a care mistake
export const SICK_MISTAKE_MAX = 2;         // ... at most this many per sickness
export const SICK_DEATH_MIN = 480;         // classic: untreated sickness ends the pet
export const STARVE_MIN = 720;             // classic: hunger at 0 this long ends the pet
export const NEGLECT_MISTAKES = 5;         // classic: adult care mistakes that end the pet

export const OLD_AGE_START = 0.6;          // classic: share of lifespanMin where old age begins
export const OLD_AGE_SECOND = 0.85;        // classic: second old-age sickness
export const OLD_AGE_DECAY_MUL = 0.85;     // applied to both decay intervals at every wake-up
export const OLD_AGE_DECAY_FLOOR_MIN = 10;

export const NAME_MAX = 6;                 // characters (code points after NFC)
export const DEFAULT_NAME = '몽실이';

// ---- species ----------------------------------------------------------------------

function sp(id, name, stage, n, blurb, hint) {
  return Object.freeze({
    id, name, stage, blurb, hint,
    hungerEvery: n[0], happyEvery: n[1], baseWeight: n[2], doses: n[3],
    poopEvery: n[4],      // null = scripted (baby)
    stageMin: n[5],       // null = the stage has no timed end (adult, special)
    lifespanMin: n[6],    // null = cannot die of old age (everything before adult)
  });
}

// blurb: one-line character for a discovered 도감 card.
// hint: shown under the silhouette of an undiscovered one — nudges without numbers.
export const SPECIES = Object.freeze({
  mongsil: sp('mongsil', '몽실', 'baby', [4, 5, 5, 2, null, 45, null],
    '머리에 새싹이 돋은 조그만 동글이예요.',
    '알을 품에 안고 기다리면 만나요.'),

  tongtong: sp('tongtong', '통통', 'child', [45, 50, 10, 2, 150, 900, null],
    '통통 튀어 다니는 씩씩한 장난꾸러기예요.',
    '아기 때 많이 놀아 주면…'),
  mallang: sp('mallang', '말랑', 'child', [50, 45, 10, 2, 150, 900, null],
    '졸린 눈을 한 말랑말랑 느긋한 만두예요.',
    '아기 때 간식을 듬뿍 주면…'),

  saessak: sp('saessak', '새싹', 'teen', [60, 65, 20, 2, 180, 1320, null],
    '잎사귀 두 장을 단정히 세운 모범생이에요.',
    '어릴 때 곁에서 잘 돌보고, 떼쓸 땐 따끔하게…'),
  kkabul: sp('kkabul', '까불', 'teen', [55, 55, 20, 2, 180, 1320, null],
    '혀를 쏙 내밀고 폴짝거리는 까불이예요.',
    '어릴 때 잘 돌보되, 떼써도 혼내지 않으면…'),
  ppittak: sp('ppittak', '삐딱', 'teen', [50, 45, 20, 2, 180, 1320, null],
    '삐죽 머리에 곁눈질, 살짝 삐뚤어졌어요.',
    '어릴 때 너무 오래 혼자 두면…'),

  banjjak: sp('banjjak', '반짝', 'adult', [90, 95, 30, 1, 180, null, 12000],
    '별 모양 머리를 세운 당당한 우등생이에요.',
    '끝까지 정성껏 돌보고 버릇도 잘 들이면…'),
  narae: sp('narae', '나래', 'adult', [85, 80, 25, 1, 180, null, 10000],
    '작은 날개로 하늘을 올려다보는 자유로운 영혼이에요.',
    '정성껏 돌보되 버릇은 자유롭게 두면…'),
  podong: sp('podong', '포동', 'adult', [60, 85, 40, 3, 120, null, 7000],
    '볼록한 배와 통통한 볼이 매력이에요.',
    '적당히 돌보면서 배불리 먹이면…'),
  dokkae: sp('dokkae', '도깨', 'adult', [75, 60, 30, 2, 180, null, 8000],
    '작은 뿔에 장난스러운 웃음, 못 말리는 개구쟁이예요.',
    '적당히 돌보면서 몸을 가볍게 지키면…'),
  gureum: sp('gureum', '구름', 'adult', [80, 90, 30, 2, 180, null, 6000],
    '멍한 눈으로 둥실둥실 떠다녀요.',
    '자주 혼자 뒀어도 버릇을 조금 들였다면…'),
  dwinggul: sp('dwinggul', '뒹굴', 'adult', [70, 70, 30, 2, 180, null, 5000],
    '바닥에 납작 붙어 한쪽 눈만 뜨고 있어요.',
    '자주 혼자 두고 버릇도 내버려 두면…'),

  byeolbit: sp('byeolbit', '별빛', 'special', [100, 100, 30, 1, 180, null, 14000],
    '빛을 품은 나래예요. 머리 위에 별이 떠 있어요.',
    '나래와 깊이 교감하며 실수 없이 지내면…'),
  haessal: sp('haessal', '햇살', 'special', [95, 100, 30, 1, 180, null, 14000],
    '뒹굴이 마음을 고쳐먹고 햇살처럼 일어섰어요.',
    '뒹굴도 늦지 않았어요. 빈틈없이 돌보며 버릇을 끝까지 들이면…'),
});

// 도감 order: by stage, then as listed in the spec.
export const SPECIES_IDS = Object.freeze(Object.keys(SPECIES));

// ---- unlocks, names, farewell copy ---------------------------------------------------

// Device colourways that unlock with the number of species in the 도감.
export const SKINS = Object.freeze({ ice: 4, lagoon: 7, sakura: 10 });

// Suggestion chips for the name sheet (each fits NAME_MAX).
export const DEFAULT_NAMES = Object.freeze(['콩이', '보리', '두부', '호두', '솜이', '단추', '구슬', '꼬미']);

// Farewell postcards, written in the pet's voice. Keyed by ending, then by careGrade.
// Even grade C stays warm: the album is a keepsake, not a report card.
export const POSTCARDS = Object.freeze({
  journey: Object.freeze({
    A: Object.freeze([
      '매일 따뜻하게 돌봐 줘서 고마워요. 넓은 세상을 보고 올게요. 남겨 둔 알도 잘 부탁해요!',
      '곁에 있는 동안 정말 행복했어요. 받은 사랑을 꼭 안고 씩씩하게 다녀올게요.',
    ]),
    B: Object.freeze([
      '가끔 심심한 날도 있었지만 함께라서 즐거웠어요. 잘 다녀올게요!',
      '웃은 날이 훨씬 많았어요. 여행길에서도 종종 떠올릴게요.',
    ]),
    C: Object.freeze([
      '혼자인 날도 있었지만, 와 줄 때마다 참 반가웠어요. 다녀올게요.',
      '조금 외로웠어도 좋아했어요. 새 알은 더 자주 안아 주세요.',
    ]),
  }),
  star: Object.freeze({
    A: Object.freeze([
      '마지막 날까지 곁에 있어 줘서 고마워요. 이제 밤하늘에서 반짝일게요.',
      '참 좋은 날들이었어요. 별이 되어 오래오래 지켜볼게요.',
    ]),
    B: Object.freeze([
      '함께한 시간을 잊지 않을게요. 하늘에서 가끔 손 흔들게요.',
      '서툴러도 괜찮았어요. 같이 지낸 날들이 좋았어요.',
    ]),
    C: Object.freeze([
      '조금 더 같이 있고 싶었어요. 그래도 고마웠어요.',
      '별이 되어서도 기다릴게요. 새 알은 자주 들여다봐 주세요.',
    ]),
  }),
});

// Picks the same variant every time a given album entry is opened.
export function postcardText(entry) {
  const end = entry && entry.end === 'star' ? 'star' : 'journey';
  const grade = entry && (entry.careGrade === 'A' || entry.careGrade === 'B') ? entry.careGrade : 'C';
  const variants = POSTCARDS[end][grade];
  const seed = entry && Number.isFinite(entry.endedAt) ? Math.abs(Math.floor(entry.endedAt / 1000)) : 0;
  return variants[seed % variants.length];
}
