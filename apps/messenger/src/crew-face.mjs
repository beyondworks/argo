// 에이전트 얼굴 — 평면 단색 도형 + 작은 눈(유건 확정 2026-09-24, 입 없음, Argo 네이비·골드 미사용).
// 모양·색은 크루 id에서 무작위로 정해지고 유지된다(id만 입력 — 보는 사람·크루 목록·해고와 무관하게 늘 같은 얼굴. 같은 조직에서 색이 겹칠 수 있다).
// 유건 확정(2026-09-24, 살아 있는 얼굴): 대기 중엔 깜빡임·두리번·고개 갸웃·가끔 하품을 크루마다 다른 박자로(CSS만, JS 타이머 없음),
// 졸 때는 숨쉬기+"z", 멘션·수신 시 1초 놀람. 소유자는 모양·색·눈을 골라 msgr_crews.face에 저장하면 조직 전원이 같은 얼굴을 본다.

export const FACE_COLORS = ['#0E9A55', '#F4A3C4', '#F45A1B', '#F6C443', '#0B6FB8', '#46C7F4', '#7B5CFA', '#14C4CC', '#FFA412', '#FF5E9C'];
/** 100×100 안의 도형. dyMax: 얼굴이 내려갈 수 있는 한도(알약·말풍선은 낮다) */
export const FACE_SHAPES = [
  { d: 'M50 10a42 42 0 1 1 0 84a42 42 0 1 1 0-84Z' },                                       // 동그라미
  { d: 'M50 6a28 28 0 0 1 28 28v32a28 28 0 0 1-56 0V34A28 28 0 0 1 50 6Z', dxMax: 10 },       // 캡슐
  { d: 'M12 94V50a38 38 0 0 1 76 0v44Z' },                                                   // 아치
  { d: 'M32 30h36a28 28 0 0 1 0 56H32a28 28 0 0 1 0-56Z', dyMin: 0, dyMax: 12 },               // 알약
  { d: 'M34 14h32a24 24 0 0 1 24 24v32a24 24 0 0 1-24 24H34a24 24 0 0 1-24-24V38a24 24 0 0 1 24-24Z' }, // 네모
  { d: 'M24 12h52a20 20 0 0 1 20 20v30a20 20 0 0 1-20 20H44L30 96l2-14h-8A20 20 0 0 1 4 62V32a20 20 0 0 1 20-20Z', dyMax: 2 }, // 말풍선
];
export const FACE_EYES = ['dot', 'stroke', 'bean'];
const SPOTS = [[0, 0], [16, -14], [-16, -8], [14, 16], [-14, 18], [0, -20]];
export const DONE_MS = 2000;
export const SURPRISE_MS = 1000;
const AWAY_MS = 90_000; // App.jsx AWAY_MS와 같은 부재 판정
const IDLE_VARIANTS = ['a', 'b', 'c'];

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); return (h ^ h >>> 16) >>> 0; };
const inRange = (n, max) => Number.isInteger(n) && n >= 0 && n < max;

/** 크루 id → 얼굴(색·도형·눈·얼굴 자리). 검수 #698 H-1: 조직 목록으로 겹침을 피하면 목록이 사람·상태마다 달라 기존 얼굴이 바뀌었다 → id만 쓴다.
 *  override는 소유자가 msgr_crews.face에 저장한 값({shape, color, eyes} 정수 인덱스) — 범위 밖·모양 불일치면 무시하고 무작위 고정값을 쓴다.
 *  얼굴 자리(spot)는 저장값이 있어도 계속 id로 정한다(위치까지 고르게 하면 선택지가 너무 늘어난다). */
export function faceOf(id, override = null) {
  const h = (k) => hash(`${id}|${k}`);
  const base = { color: h('color') % FACE_COLORS.length, shape: h('shape') % FACE_SHAPES.length, eyes: h('eyes') % FACE_EYES.length, spot: h('spot') % SPOTS.length };
  if (override && inRange(override.shape, FACE_SHAPES.length) && inRange(override.color, FACE_COLORS.length) && inRange(override.eyes, FACE_EYES.length)) {
    return { ...base, shape: override.shape, color: override.color, eyes: override.eyes };
  }
  return base;
}

/** '완료' 표시가 가장 먼저 끝나는 때까지 남은 ms(없으면 null) — 크루마다 정확히 DONE_MS만 보이게(검수 L-2) */
function nextExpiryIn(atMap, ms, now) {
  const left = Object.values(atMap ?? {}).map((at) => at + ms - now).filter((left) => left > 0);
  return left.length ? Math.min(...left) : null;
}
export function nextDoneIn(doneAt, now = Date.now()) { return nextExpiryIn(doneAt, DONE_MS, now); }
/** '놀람' 표시가 가장 먼저 끝나는 때까지 남은 ms — doneAt과 같은 모양(크루 id → 시각), 타이머 로직도 같다(App.jsx effect 재사용). */
export function nextSurpriseIn(surprisedAt, now = Date.now()) { return nextExpiryIn(surprisedAt, SURPRISE_MS, now); }

/** 얼굴 상태 — 준비 중 > 결재 대기 > 놀람(멘션·수신 1초) > 완료(답 뒤 2초) > 오프라인 > 쉼 */
export function crewFaceState({ crew, working = false, asking = false, surprisedAt = 0, doneAt = 0, now = Date.now() }) {
  if (working) return 'work';
  if (asking) return 'ask';
  if (surprisedAt && now - surprisedAt < SURPRISE_MS) return 'surprise';
  if (doneAt && now - doneAt < DONE_MS) return 'done';
  if (crew && (!crew.last_seen_at || now - Date.parse(crew.last_seen_at) >= AWAY_MS)) return 'off';
  return 'idle';
}

/** 그릴 좌표 — 얼굴 중심과 두 눈 x */
export function faceGeometry(face) {
  const s = FACE_SHAPES[face.shape];
  let [dx, dy] = SPOTS[face.spot];
  if (s.dxMax != null) dx = Math.max(-s.dxMax, Math.min(dx, s.dxMax));
  if (s.dyMax != null) dy = Math.max(s.dyMin ?? -20, Math.min(dy, s.dyMax));
  if (s.dyMin != null) dy = Math.max(s.dyMin, dy);
  const cx = 50 + dx, cy = 52 + dy;
  return { cx, cy, L: cx - 8, R: cx + 8, d: s.d, color: FACE_COLORS[face.color], eyes: FACE_EYES[face.eyes] };
}

/** 대기 애니메이션 변수 — 깜빡임·두리번·고개 갸웃·하품을 섞은 keyframes 세 벌(idle-a/b/c) 중 하나를 id로 고르고,
 *  한 바퀴 길이(4~12초)와 시작 위치(음수 delay)도 id로 정해 크루마다 다른 박자로 움직인다(JS 타이머 없음, CSS만). */
export function faceMotion(id) {
  const h = (k) => hash(`${id}|motion|${k}`);
  const duration = 4 + (h('dur') % 801) / 100; // 4.00~12.00s
  const delay = -((h('delay') % 10000) / 10000) * duration; // -duration~0s(음수) — 크루마다 다른 위상에서 시작
  return { variant: IDLE_VARIANTS[h('variant') % IDLE_VARIANTS.length], duration: `${duration.toFixed(2)}s`, delay: `${delay.toFixed(2)}s` };
}

/** 저장할 모양(msgr_crews.face) — 서버 check 제약이 허용하는 세 키만. 얼굴 자리(spot)는 id로 정해지고 저장하지 않는다
 *  (고르기 초안이 faceOf 결과를 그대로 들고 있어 spot까지 보내면 라이브 DB가 check 위반으로 거절한다 — 화면 확인 중 발견 2026-09-24). */
export const faceToStore = (f) => ({ shape: f.shape, color: f.color, eyes: f.eyes });
