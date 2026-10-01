// 에이전트 얼굴 v2 — 유건 확정 시안(2026-10-01, 감정 체크인 레퍼런스 룩): 도형 12종 · 색 12색 · 표정(입 있음) ·
// 상태 6종(쉼·답변 준비 중·결재 대기·완료·오류·오프라인) + 놀람(멘션·수신 1초). 쉼에는 몸짓 8종(face-gestures.mjs가 2~5초 간격으로 붙인다).
// 모양·색은 크루 id에서 무작위로 정해지고 유지된다(id만 입력 — 보는 사람·크루 목록·해고와 무관하게 늘 같은 얼굴).
// 소유자가 고르면 msgr_crews.face에 {v:2, shape, color}로 저장돼 조직 전원이 같은 얼굴을 본다.
// 옛 저장값({shape 0~5, color 0~9, eyes 0~2}, 키 v 없음)은 운영 행을 고쳐 쓰지 않고 그릴 때 대응표(LEGACY_*)로 바꾼다 — 옛 눈은 버리고 새 도형의 기본 표정.
// 그림은 SVG 문자열 — 메신저(faceInner: 상태·몸짓)와 오피스(faceStill: 정지 얼굴)가 같은 그리기 함수를 쓴다. 색·선 굵기는 속성으로 넣어 CSS 없이도 같은 얼굴이 나오고,
// 메신저 styles.css는 움직임(transform·opacity 애니메이션)과 오프라인 채도만 더한다.

/** 색 12종 — 레퍼런스 이미지 도형 안쪽 픽셀(시안 6절). 오피스 달력(calendar/shared.js)도 이 배열로 색을 고른다 */
export const FACE_COLORS = ['#FEA1CD', '#FE76B8', '#9F66C7', '#AE85D3', '#02A3FE', '#0061F0', '#02883F', '#02A552', '#FB5501', '#FD7400', '#FF9A00', '#FDB602'];
const FEAT = '#141414';     // 눈·입
const SWIRL_C = '#FF6A13';  // 결재 대기 소용돌이

/** 100×100 안의 실루엣 10가지 — 동그라미는 세 캐릭터가 같이 쓰고 얼굴 자리만 다르다 */
const SIL = {
  circle: 'M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88Z',
  flower: 'M50 16.73A24 24 0 1 1 83.27 50A24 24 0 1 1 50 83.27A24 24 0 1 1 16.73 50A24 24 0 1 1 50 16.73Z',
  peanut: 'M29 8H71A21 21 0 0 1 92 29V31A21 21 0 0 1 79.94 50A21 21 0 0 1 92 69V71A21 21 0 0 1 71 92H29A21 21 0 0 1 8 71V69A21 21 0 0 1 20.06 50A21 21 0 0 1 8 31V29A21 21 0 0 1 29 8Z',
  wavy: 'M7 24A15 15 0 0 1 36 18.61A15 15 0 0 1 64 18.61A15 15 0 0 1 93 24V71A22 22 0 0 1 71 93H29A22 22 0 0 1 7 71Z',
  arch: 'M8 50A42 42 0 0 1 92 50V80A12 12 0 0 1 80 92H20A12 12 0 0 1 8 80Z',
  hexagon: 'M36 12H64Q72 12 76 18.9L90 43.1Q94 50 90 56.9L76 81.1Q72 88 64 88H36Q28 88 24 81.1L10 56.9Q6 50 10 43.1L24 18.9Q28 12 36 12Z',
  triangle: 'M45.3 16.8Q50 8 54.7 16.8L89.7 82.1Q94 90 85 90H15Q6 90 10.3 82.1Z',
  square: 'M22 8H78A14 14 0 0 1 92 22V78A14 14 0 0 1 78 92H22A14 14 0 0 1 8 78V22A14 14 0 0 1 22 8Z',
  tier3: 'M24 8H76A16 16 0 0 1 85.33 37A16 16 0 0 1 85.33 63A16 16 0 0 1 76 92H24A16 16 0 0 1 14.67 63A16 16 0 0 1 14.67 37A16 16 0 0 1 24 8Z',
  quarter: 'M92 14V86Q92 92 86 92H14Q8 92 8.2 86A84 84 0 0 1 86 8.2Q92 8 92 14Z',
};
/** 캐릭터 12종(번호 = 저장하는 shape 값) — 실루엣 d + 기본 색 + 쉼 표정 + 얼굴 자리(cx, cy, 배율 s) */
export const FACE_SHAPES = [
  { k: 'excited', d: SIL.circle, color: 0, expr: 'smile', cx: 50, cy: 42, s: 1 },
  { k: 'joyful', d: SIL.flower, color: 1, expr: 'grin', cx: 50, cy: 50, s: 1 },
  { k: 'grateful', d: SIL.peanut, color: 2, expr: 'soft', cx: 50, cy: 46, s: 1 },
  { k: 'energized', d: SIL.wavy, color: 3, expr: 'calm', cx: 50, cy: 52, s: 1 },
  { k: 'sensitive', d: SIL.arch, color: 4, expr: 'calm', cx: 50, cy: 58, s: 1 },
  { k: 'confused', d: SIL.hexagon, color: 5, expr: 'front', cx: 50, cy: 50, s: 1 },
  { k: 'bored', d: SIL.circle, color: 6, expr: 'up', cx: 50, cy: 44, s: 1 },
  { k: 'stressed', d: SIL.triangle, color: 7, expr: 'happy', cx: 50, cy: 63, s: 0.9 },
  { k: 'angry', d: SIL.square, color: 8, expr: 'half', cx: 50, cy: 46, s: 1 },
  { k: 'insecure', d: SIL.circle, color: 9, expr: 'peek', cx: 46, cy: 50, s: 1 },
  { k: 'hurt', d: SIL.tier3, color: 10, expr: 'rest', cx: 50, cy: 50, s: 1 },
  { k: 'guilty', d: SIL.quarter, color: 11, expr: 'side', cx: 58, cy: 61, s: 0.95 },
];
export const FACE_VERSION = 2;
/** 옛 저장값 → 새 번호(시안 5절). 옛 shape 0 동그라미·1 캡슐·2 아치·3 알약·4 네모·5 말풍선 → 동그라미·땅콩·아치·3단 알약·둥근 네모·물결머리 */
export const LEGACY_SHAPE = [0, 2, 4, 10, 8, 3];
/** 옛 color 0~9 → Lab 거리로 가장 가까운 새 색(파랑·보라는 이름이 같은 쪽, 청록은 하늘) */
export const LEGACY_COLOR = [6, 0, 8, 11, 5, 4, 2, 4, 10, 1];

export const DONE_MS = 2000;
export const SURPRISE_MS = 1000;
export const ERROR_MS = 8000; // 오류 얼굴 — 흔들림(2.2초 주기)이 서너 번 보일 만큼. 그 사이 다시 일을 시작하면 '준비 중'이 앞선다
const AWAY_MS = 90_000; // App.jsx AWAY_MS와 같은 부재 판정

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); return (h ^ h >>> 16) >>> 0; };
const inRange = (n, max) => Number.isInteger(n) && n >= 0 && n < max;

/** 저장값(msgr_crews.face) → {shape, color}. v2는 그대로, 옛 형태(키 v 없음)는 대응표로 바꾼다. 알 수 없는 모양·범위 밖이면 null(무작위 고정값을 쓴다) */
export function faceFromStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if ('v' in raw) return raw.v === FACE_VERSION && inRange(raw.shape, FACE_SHAPES.length) && inRange(raw.color, FACE_COLORS.length) ? { shape: raw.shape, color: raw.color } : null;
  return inRange(raw.shape, LEGACY_SHAPE.length) && inRange(raw.color, LEGACY_COLOR.length) ? { shape: LEGACY_SHAPE[raw.shape], color: LEGACY_COLOR[raw.color] } : null;
}

/** 크루 id → 얼굴 {shape, color}. 검수 #698 H-1: 조직 목록으로 겹침을 피하면 목록이 사람·상태마다 달라 기존 얼굴이 바뀌었다 → id만 쓴다.
 *  override는 소유자가 저장한 값(faceFromStored가 읽는다) — 못 읽으면 무시하고 무작위 고정값을 쓴다. 모양과 색은 따로 뽑는다(같은 조직에서 겹칠 수 있다). */
export function faceOf(id, override = null) {
  return faceFromStored(override) ?? { shape: hash(`${id}|shape`) % FACE_SHAPES.length, color: hash(`${id}|color`) % FACE_COLORS.length };
}

/** 저장할 모양 — 서버 check(20261001130000)가 허용하는 v2 형태 세 키만 */
export const faceToStore = (f) => ({ v: FACE_VERSION, shape: f.shape, color: f.color });

/** '완료' 표시가 가장 먼저 끝나는 때까지 남은 ms(없으면 null) — 크루마다 정확히 DONE_MS만 보이게(검수 L-2) */
function nextExpiryIn(atMap, ms, now) {
  const left = Object.values(atMap ?? {}).map((at) => at + ms - now).filter((left) => left > 0);
  return left.length ? Math.min(...left) : null;
}
export function nextDoneIn(doneAt, now = Date.now()) { return nextExpiryIn(doneAt, DONE_MS, now); }
/** '놀람' 표시가 가장 먼저 끝나는 때까지 남은 ms — doneAt과 같은 모양(크루 id → 시각), 타이머 로직도 같다(App.jsx effect 재사용). */
export function nextSurpriseIn(surprisedAt, now = Date.now()) { return nextExpiryIn(surprisedAt, SURPRISE_MS, now); }
/** '오류' 표시가 가장 먼저 끝나는 때까지 남은 ms — 같은 모양·같은 만료 로직 */
export function nextErrorIn(erroredAt, now = Date.now()) { return nextExpiryIn(erroredAt, ERROR_MS, now); }

/** 대화창이 새로 읽은 글이 크루의 실패한 답(게이트웨이가 meta.failed=true로 남긴다 — 사람이 누른 중단은 stopped라 아님)이면 그 크루 id.
 *  방송 payload에는 meta가 없어 대화창 조회 결과로 판정한다. 1분 넘게 묵은 글(재개·폴로 늦게 읽힘)은 지금 일이 아니라 제외 — 기기 시계 차이를 넉넉히 둔다 */
export const FAILED_FRESH_MS = 60_000;
export function failedReplyCrew(row, now = Date.now()) {
  if (!row || row.author_kind !== 'crew' || !row.crew_id || row.meta?.failed !== true) return null;
  const at = Date.parse(row.created_at);
  return Number.isFinite(at) && now - at < FAILED_FRESH_MS ? row.crew_id : null;
}

/** 얼굴 상태 — 준비 중 > 결재 대기 > 놀람(멘션·수신 1초) > 오류(실패한 답 뒤 8초) > 완료(답 뒤 2초) > 오프라인 > 쉼 */
export function crewFaceState({ crew, working = false, asking = false, surprisedAt = 0, erroredAt = 0, doneAt = 0, now = Date.now() }) {
  if (working) return 'work';
  if (asking) return 'ask';
  if (surprisedAt && now - surprisedAt < SURPRISE_MS) return 'surprise';
  if (erroredAt && now - erroredAt < ERROR_MS) return 'error';
  if (doneAt && now - doneAt < DONE_MS) return 'done';
  if (crew && (!crew.last_seen_at || now - Date.parse(crew.last_seen_at) >= AWAY_MS)) return 'off';
  return 'idle';
}

/* ───────── 표정 부품 — 좌표는 얼굴 중심(0,0) 기준. 색은 속성으로(CSS 없이도 같은 얼굴) ───────── */
const f2 = (n) => +n.toFixed(2);
const arcD = (x1, y1, x2, y2, sag, down = true) => { const w = Math.hypot(x2 - x1, y2 - y1) / 2; const r = f2((w * w + sag * sag) / (2 * sag)); return `M${x1} ${y1}A${r} ${r} 0 0 ${down ? 0 : 1} ${x2} ${y2}`; };
const INK = `fill="${FEAT}" stroke="none"`;
const WHITE = 'fill="#fff" stroke="none"';
const P = (d) => `<path d="${d}"/>`;
const closedEye = (x, y, w = 11, sag = 3.8) => `<g class="eye">${P(arcD(x - w / 2, y, x + w / 2, y, sag, true))}</g>`; // ‿ 감은 눈(웃음)
const happyEye = (x, y, w = 11, sag = 4.2) => `<g class="eye">${P(arcD(x - w / 2, y, x + w / 2, y, sag, false))}</g>`; // ︵ 웃는 실눈
const whiteEye = (x, y, r, px, py, pr, ry) => `<g class="eye">${ry ? `<ellipse class="w" ${WHITE} cx="${x}" cy="${y}" rx="${r}" ry="${ry}"/>` : `<circle class="w" ${WHITE} cx="${x}" cy="${y}" r="${r}"/>`}<circle class="pupil" ${INK} cx="${f2(x + px)}" cy="${f2(y + py)}" r="${pr}"/></g>`;
const halfEye = (x) => `<g class="eye"><path class="w" ${WHITE} d="M${x - 11} -4H${x + 11}A11 8.5 0 0 1 ${x - 11} -4Z"/><path class="pupil" ${INK} d="M${f2(x - 3.6)} -4A4.6 4.6 0 0 0 ${f2(x + 5.6)} -4Z"/></g>`;
const peekEye = () => `<g class="eye"><rect class="w" ${WHITE} x="1" y="-6" width="22" height="12" rx="1"/><path class="pupil" ${INK} d="M1 -6A6 6 0 0 1 1 6Z"/></g>`;
const openMouth = (w, y, h) => `<path ${INK} d="M${-w} ${y}H${w}A${w} ${h} 0 0 1 ${-w} ${y}Z"/>`;
const label = (cls, x, y, ch, small) => `<text class="${cls}" x="${x}" y="${y}" ${INK}${cls === 'zzz' ? ' opacity="0"' : ''} font-size="${small ? 20 : 15}" font-weight="800" font-family="-apple-system, system-ui, sans-serif">${ch}</text>`;
const SWIRL = 'M0 0A1.2 1.2 0 0 1 2.4 0A2.4 2.4 0 0 1 -2.4 0A3.6 3.6 0 0 1 4.8 0A4.8 4.8 0 0 1 -4.8 0A6 6 0 0 1 7.2 0';

/** 쉼(idle) 기본 표정 11종 — grin = 웃음 짓기 몸짓 때 나오는 입, yawnY = 하품 입 자리. sm = 44px 이하 배치(감은 눈과 입 사이를 띄우고 부품을 키운다) */
const EXPR = {
  smile: { eyes: [closedEye(-8, -4, 10, 3.6), closedEye(8, -4, 10, 3.6)], mouth: P(arcD(-26, -5, 26, -5, 11)), grin: openMouth(13, 2, 11), yawnY: 6,
    sm: { eyes: [closedEye(-11, -6, 13, 4.6), closedEye(11, -6, 13, 4.6)], mouth: P(arcD(-17, 3, 17, 3, 8)), grin: openMouth(12, 3, 10), yawnY: 8 } },
  grin: { eyes: [closedEye(-8, -5, 10, 3.6), closedEye(8, -5, 10, 3.6)], mouth: P(arcD(-22, -6, 22, -6, 17)), grin: openMouth(15, 1, 13), yawnY: 6,
    sm: { eyes: [closedEye(-11, -8, 13, 4.6), closedEye(11, -8, 13, 4.6)], mouth: P(arcD(-15, 1, 15, 1, 12)), grin: openMouth(14, 1, 13), yawnY: 7 } },
  soft: { eyes: [closedEye(-8, -5, 11, 3.8), closedEye(8, -5, 11, 3.8)], mouth: P(arcD(-17, 4, 17, 4, 5.5)), grin: openMouth(11, 3, 9), yawnY: 7,
    sm: { eyes: [closedEye(-11, -7, 13, 4.6), closedEye(11, -7, 13, 4.6)], mouth: P(arcD(-16, 5, 16, 5, 6)), grin: openMouth(12, 4, 10), yawnY: 8 } },
  calm: { eyes: [closedEye(-11, -4, 13, 4.2), closedEye(11, -4, 13, 4.2)], mouth: P(arcD(-4.5, 5, 4.5, 5, 3.6)), grin: openMouth(7, 4, 6), yawnY: 7,
    sm: { eyes: [closedEye(-12, -6, 14, 5), closedEye(12, -6, 14, 5)], mouth: P(arcD(-5.5, 6, 5.5, 6, 4.6)), grin: openMouth(9, 5, 8), yawnY: 9 } },
  rest: { eyes: [closedEye(-9, -4, 11, 3.8), closedEye(9, -4, 11, 3.8)], mouth: P('M-4.5 7H4.5'), grin: P(arcD(-6, 6, 6, 6, 4)), yawnY: 8,
    sm: { eyes: [closedEye(-11, -6, 13, 4.6), closedEye(11, -6, 13, 4.6)], mouth: P('M-6 8H6'), grin: P(arcD(-8, 7, 8, 7, 5)), yawnY: 10 } },
  happy: { eyes: [happyEye(-10, -1, 11, 4.2), happyEye(10, -1, 11, 4.2)], mouth: P(arcD(-4, 7, 4, 7, 3)), grin: openMouth(7, 5, 6), yawnY: 8,
    sm: { eyes: [happyEye(-11, -3, 13, 5), happyEye(11, -3, 13, 5)], mouth: P(arcD(-5.5, 8, 5.5, 8, 4.6)), grin: openMouth(9, 6, 8), yawnY: 10 } },
  front: { eyes: [whiteEye(-11, 0, 10.5, 1.5, 0, 4.8), whiteEye(11, 0, 10.5, 1.5, 0, 4.8)], mouth: '', grin: P(arcD(-8, 15, 8, 15, 6)), yawnY: 17 },
  up: { eyes: [whiteEye(-13, 0, 13, -1, -6, 6.6), whiteEye(13, 0, 13, -1, -6, 6.6)], mouth: '', grin: P(arcD(-8, 18, 8, 18, 6)), yawnY: 19 },
  side: { eyes: [`<g transform="rotate(-12)">${whiteEye(-11, 0, 10.5, -3.6, -2.4, 5, 8.6)}${whiteEye(11, -1, 10.5, -3.6, -2.4, 5, 8.6)}</g>`], mouth: '', grin: P(arcD(-7, 13, 7, 13, 5.5)), yawnY: 15 },
  peek: { eyes: [whiteEye(-12, 0, 10, -4.6, 0, 5), peekEye()], mouth: '', grin: P(arcD(-8, 14, 8, 14, 6)), yawnY: 16 },
  half: { eyes: [halfEye(-12), halfEye(12)], mouth: P('M-11 11H11'), grin: P(arcD(-9, 10, 9, 10, 5)), yawnY: 12 },
};
/** 상태 표정 — 쉼(idle)은 크루의 기본 표정, 나머지는 모든 크루가 같은 얼굴. small = 44px 이하(소용돌이 선·글자를 키운다) */
const STATE_FACE = {
  work: () => ({ eyes: [whiteEye(-11, -1, 10.5, 0, 0, 4.8), whiteEye(11, -1, 10.5, 0, 0, 4.8)], mouth: P('M-3.5 14H3.5') }),
  ask: (small) => ({ eyes: [whiteEye(-11, 0, 10.5, 1.5, 0, 4.8), `<g class="eye"><circle class="w" ${WHITE} cx="11" cy="0" r="10.5"/><g transform="translate(11 0)"><g class="swirl"><circle r="7.2" fill="none" stroke="none"/><path d="${SWIRL}" stroke="${SWIRL_C}" stroke-width="${small ? 3.2 : 2.3}"/></g></g></g>`], mouth: '', extra: label('q', 18, -14, '?', small) }),
  // 놀람(멘션·수신 1초) — 시안 스타일의 놀란 흰 눈: 큰 흰자 + 가운데 작은 눈동자 + 작은 o 입
  surprise: () => ({ eyes: [whiteEye(-12, -2, 12, 0, 0, 4.2), whiteEye(12, -2, 12, 0, 0, 4.2)], mouth: `<ellipse ${INK} cx="0" cy="16" rx="3.8" ry="4.8"/>` }),
  done: () => ({ eyes: [happyEye(-10, -3, 12, 4.6), happyEye(10, -3, 12, 4.6)], mouth: openMouth(11, 4, 10) }),
  error: () => ({ eyes: [`<g class="eye">${P('M-15 -7L-6 -2L-15 3')}</g>`, `<g class="eye">${P('M15 -7L6 -2L15 3')}</g>`], mouth: P('M-6 10H6') }),
  off: (small) => ({ eyes: [closedEye(-10, 1, 11, 2.4), closedEye(10, 1, 11, 2.4)], mouth: P('M-3 10H3'), extra: label('zzz', 15, -12, 'z', small) }),
};
export const FACE_STATES = ['idle', 'work', 'ask', 'surprise', 'done', 'error', 'off']; // 글자 그대로 둔다 — Object.keys(STATE_FACE)로 만들면 쓰지 않는 오피스 묶음에도 상태 표정이 끌려 들어간다(첫 화면 150KB 상한)

/** 크기별 선 굵기·부품 배율 — 24~44px 목록에서도 표정이 읽히게(시안 '크기별 조정' 표) */
const SMALL_PX = 44; // 이하(메신저 목록·대화 20~44px, 오피스 12~32px)는 작은 배치
const sizeTune = (px) => px >= 64 ? { sw: 3.4, k: 1 } : px > SMALL_PX ? { sw: 4.4, k: 1.04 } : px > 28 ? { sw: 5, k: 1.1 } : { sw: 5.8, k: 1.12 };

const memo = /* @__PURE__ */ new Map(); // 모양 12 × 색 12 × 상태 7(+정지) × 크기 4단 — 목록이 다시 그려질 때마다 새로 만들지 않는다
/** 그리기 본체. stateFace = 상태 표정 표(메신저만 넘긴다 — 오피스는 faceStill로 넘기지 않아 상태 표정 코드가 오피스 첫 화면 묶음에서 빠진다).
 *  motion = 몸짓 부품(웃음 짓기·하품 입, 평소 투명)을 넣을지 — 정지 얼굴에는 필요 없다 */
function draw(face, st, px, stateFace, motion) {
  const shape = inRange(face?.shape, FACE_SHAPES.length) ? face.shape : 0;
  const c = FACE_SHAPES[shape];
  const color = inRange(face?.color, FACE_COLORS.length) ? face.color : c.color;
  const small = px <= SMALL_PX;
  const t = sizeTune(px);
  const key = `${shape}|${color}|${st}|${t.sw}|${motion ? 1 : 0}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const base = st === 'idle' ? EXPR[c.expr] : stateFace[st](small);
  const e = small && base.sm ? { ...base, ...base.sm } : base;
  const k = small && base.sm ? 1 : t.k; // 작은 배치가 있는 표정은 배치 자체가 이미 크다
  const idleParts = st === 'idle' && motion ? `<g class="grin" opacity="0">${e.grin}</g><ellipse class="yawn" ${INK} opacity="0" cx="0" cy="${e.yawnY}" rx="6" ry="8"/>` : '';
  const out = `<g class="rig"><path class="body" d="${c.d}" fill="${FACE_COLORS[color]}"/>`
    + `<g class="ft" transform="translate(${c.cx} ${c.cy}) scale(${f2(c.s * k)})" fill="none" stroke="${FEAT}" stroke-width="${t.sw}" stroke-linecap="round" stroke-linejoin="round"><g class="look">`
    + `<g class="eyes">${e.eyes.join('')}</g><g class="mouth">${e.mouth || ''}</g>${idleParts}${e.extra || ''}`
    + '</g></g></g>';
  memo.set(key, out);
  return out;
}
/** 얼굴 SVG의 안쪽(viewBox 0 0 100 100 기준, 메신저) — 상태 표정 + 몸짓 부품. 바깥 <svg>는 쓰는 쪽이 만든다.
 *  값은 전부 상수에서 오고 face는 정수 인덱스로만 읽는다(사용자 입력이 문자열에 들어가지 않는다) */
export function faceInner(face, { state = 'idle', px = 28 } = {}) {
  return draw(face, STATE_FACE[state] ? state : 'idle', px, STATE_FACE, true);
}
/** 정지 얼굴(오피스) — 쉼 표정 하나, 몸짓 부품 없음. faceInner와 같은 그림이다 */
export function faceStill(face, { px = 28 } = {}) {
  return draw(face, 'idle', px, null, false);
}

/* ───────── 쉼(idle) 몸짓 계획 — 크루 id 해시로 순서·간격·첫 시작이 정해져 크루마다 박자가 다르다 ───────── */
/** 몸짓 8종(길이 ms, 뽑힐 가중치). 이름은 styles.css의 .msgr-face[data-g="…"] 와 같다 */
export const GESTURES = [
  { k: 'blink', ms: 360, w: 3 },
  { k: 'look', ms: 1600, w: 2 },
  { k: 'tilt', ms: 1400, w: 1.2 },
  { k: 'bounce', ms: 900, w: 1.2 },
  { k: 'wiggle', ms: 900, w: 1 },
  { k: 'yawn', ms: 1900, w: 0.8 },
  { k: 'roll', ms: 1400, w: 1 },
  { k: 'smile', ms: 1600, w: 1.5 },
];
export const GESTURE_MS = /* @__PURE__ */ Object.fromEntries(GESTURES.map((g) => [g.k, g.ms])); // PURE 표시 = 쓰지 않는 묶음(오피스)에서 몸짓 정의를 걷어낼 수 있게
export const GESTURE_GAP = [2000, 5000]; // 다음 몸짓까지 간격(시작~시작) 하한·상한
const G_TOTAL = /* @__PURE__ */ GESTURES.reduce((a, g) => a + g.w, 0);
function pickGesture(h) { let r = (h % 10000) / 10000 * G_TOTAL; for (const g of GESTURES) { r -= g.w; if (r < 0) return g.k; } return GESTURES[0].k; }
/** n번째 몸짓과 다음 몸짓까지 간격(2~5초) — id·n·직전 몸짓만으로 정해진다. 직전과 같으면 다른 몸짓으로 바꾼다(같은 몸짓 연속 없음) */
export function gestureAt(id, n, prev = null) {
  let g = pickGesture(hash(`${id}|g|${n}`));
  if (g === prev) g = GESTURES[(GESTURES.findIndex((x) => x.k === g) + 1 + hash(`${id}|g2|${n}`) % (GESTURES.length - 1)) % GESTURES.length].k;
  return { g, gap: GESTURE_GAP[0] + hash(`${id}|gap|${n}`) % (GESTURE_GAP[1] - GESTURE_GAP[0] + 1) };
}
/** 첫 몸짓까지 기다림(0.4~3.4초) — 화면에 들어온 크루들이 같은 박자로 움직이지 않게 */
export const gesturePhase = (id) => 400 + hash(`${id}|phase`) % 3000;
