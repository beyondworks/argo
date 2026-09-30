// 크루(에이전트) 얼굴 — 메신저 앱 apps/messenger/src/crew-face.mjs의 도형·색·눈·박자 규칙을 그대로 옮긴 사본.
// 유건 확정(2026-09-24): 평면 단색 도형 + 작은 눈, 입 없음, 크루마다 다른 박자로 깜빡이고 두리번거린다(CSS만).
// ponytail: 랜딩은 별도 배포라 앱 모듈을 import하지 않고 필요한 세 함수만 복사했다 — 앱 규칙이 바뀌면 여기도 같이 고친다.
export const FACE_COLORS = ['#0E9A55', '#F4A3C4', '#F45A1B', '#F6C443', '#0B6FB8', '#46C7F4', '#7B5CFA', '#14C4CC', '#FFA412', '#FF5E9C'];
const FACE_SHAPES = [
  { d: 'M50 10a42 42 0 1 1 0 84a42 42 0 1 1 0-84Z' },
  { d: 'M50 6a28 28 0 0 1 28 28v32a28 28 0 0 1-56 0V34A28 28 0 0 1 50 6Z', dxMax: 10 },
  { d: 'M12 94V50a38 38 0 0 1 76 0v44Z' },
  { d: 'M32 30h36a28 28 0 0 1 0 56H32a28 28 0 0 1 0-56Z', dyMin: 0, dyMax: 12 },
  { d: 'M34 14h32a24 24 0 0 1 24 24v32a24 24 0 0 1-24 24H34a24 24 0 0 1-24-24V38a24 24 0 0 1 24-24Z' },
  { d: 'M24 12h52a20 20 0 0 1 20 20v30a20 20 0 0 1-20 20H44L30 96l2-14h-8A20 20 0 0 1 4 62V32a20 20 0 0 1 20-20Z', dyMax: 2 },
];
const FACE_EYES = ['dot', 'stroke', 'bean'];
const SPOTS = [[0, 0], [16, -14], [-16, -8], [14, 16], [-14, 18], [0, -20]];
const IDLE_VARIANTS = ['a', 'b', 'c'];

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); return (h ^ h >>> 16) >>> 0; };

/** 모양을 직접 고를 수도 있다({shape, color, eyes}) — 랜딩 장면에선 인물마다 겹치지 않게 지정한다. */
export function faceGeometry(id, pick) {
  const h = (k) => hash(`${id}|${k}`);
  const f = { color: h('color') % 10, shape: h('shape') % 6, eyes: h('eyes') % 3, spot: h('spot') % 6, ...pick };
  const s = FACE_SHAPES[f.shape];
  let [dx, dy] = SPOTS[f.spot];
  if (s.dxMax != null) dx = Math.max(-s.dxMax, Math.min(dx, s.dxMax));
  if (s.dyMax != null) dy = Math.max(s.dyMin ?? -20, Math.min(dy, s.dyMax));
  if (s.dyMin != null) dy = Math.max(s.dyMin, dy);
  const cx = 50 + dx, cy = 52 + dy;
  return { cx, cy, L: cx - 8, R: cx + 8, d: s.d, color: FACE_COLORS[f.color], eyes: FACE_EYES[f.eyes] };
}

export function faceMotion(id) {
  const h = (k) => hash(`${id}|motion|${k}`);
  const duration = 4 + (h('dur') % 801) / 100;
  const delay = -((h('delay') % 10000) / 10000) * duration;
  return { variant: IDLE_VARIANTS[h('variant') % 3], duration: `${duration.toFixed(2)}s`, delay: `${delay.toFixed(2)}s` };
}
