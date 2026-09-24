// 에이전트 얼굴 — 평면 단색 도형 + 작은 눈(유건 확정 2026-09-24, 입 없음, Argo 네이비·골드 미사용).
// 모양·색은 크루 id에서 무작위로 정해지고 유지된다(id만 입력 — 보는 사람·크루 목록·해고와 무관하게 늘 같은 얼굴. 같은 조직에서 색이 겹칠 수 있다).

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
const AWAY_MS = 90_000; // App.jsx AWAY_MS와 같은 부재 판정

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); return (h ^ h >>> 16) >>> 0; };

/** 크루 id → 얼굴(색·도형·눈·얼굴 자리). 검수 #698 H-1: 조직 목록으로 겹침을 피하면 목록이 사람·상태마다 달라 기존 얼굴이 바뀌었다 → id만 쓴다. */
export function faceOf(id) {
  const h = (k) => hash(`${id}|${k}`);
  return { color: h('color') % FACE_COLORS.length, shape: h('shape') % FACE_SHAPES.length, eyes: h('eyes') % FACE_EYES.length, spot: h('spot') % SPOTS.length };
}

/** '완료' 표시가 가장 먼저 끝나는 때까지 남은 ms(없으면 null) — 크루마다 정확히 DONE_MS만 보이게(검수 L-2) */
export function nextDoneIn(doneAt, now = Date.now()) {
  const left = Object.values(doneAt ?? {}).map((at) => at + DONE_MS - now).filter((ms) => ms > 0);
  return left.length ? Math.min(...left) : null;
}

/** 얼굴 상태 — 준비 중 > 결재 대기 > 완료(답 뒤 2초) > 오프라인 > 쉼 */
export function crewFaceState({ crew, working = false, asking = false, doneAt = 0, now = Date.now() }) {
  if (working) return 'work';
  if (asking) return 'ask';
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
