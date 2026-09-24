// 에이전트 얼굴 — 평면 단색 도형 + 작은 눈(유건 확정 2026-09-24, 입 없음, Argo 네이비·골드 미사용).
// 모양·색은 크루 id에서 무작위로 한 번 정해지고 유지된다. 같은 조직 안에서는 먼저 만든 크루부터 안 쓴 색·도형을 받는다.

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

/** 목록 밖 크루(비활성·다른 조직)도 id만으로 같은 얼굴 */
export function faceOf(id, faces) {
  if (faces?.[id]) return faces[id];
  const h = (k) => hash(`${id}|${k}`);
  return { color: h('color') % FACE_COLORS.length, shape: h('shape') % FACE_SHAPES.length, eyes: h('eyes') % FACE_EYES.length, spot: h('spot') % SPOTS.length };
}

/** 조직 크루 전체 → id별 얼굴. 생성 순서대로 배정해 새 크루가 기존 크루 얼굴을 바꾸지 않는다. */
export function assignFaces(crews) {
  const list = [...new Map((crews ?? []).filter((c) => c?.id).map((c) => [c.id, c])).values()]
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id)));
  const used = { color: new Set(), shape: new Set() }, out = {};
  const take = (key, start, len) => { const u = used[key]; if (u.size >= len) u.clear(); let i = start; while (u.has(i)) i = (i + 1) % len; u.add(i); return i; };
  for (const c of list) {
    const base = faceOf(c.id, null);
    out[c.id] = { ...base, color: take('color', base.color, FACE_COLORS.length), shape: take('shape', base.shape, FACE_SHAPES.length) };
  }
  return out;
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
