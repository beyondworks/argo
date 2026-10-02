// 크게 보기(라이트박스) 제스처 계산 — 화면 부품(media.jsx Lightbox)과 분리한 순수 함수. 테스트: test/media-viewer.test.mjs
// 좌표는 화면 가운데를 (0,0)으로 둔다. view = { z: 배율, x·y: 이동(px) }. 이미지는 1배일 때 화면에 맞춰(contain) 그려진다.

export const ZOOM_MAX = 4;
export const DOUBLE_TAP_ZOOM = 2.5;

export const clampZoom = (z) => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(1, z)) : 1);

/** p(가운데 기준 화면 좌표)를 붙잡고 배율을 z2로 — 손가락·커서 밑의 그림이 제자리에 있게 이동값을 같이 바꾼다. */
export function zoomAt(view, z2, p) {
  const z = clampZoom(z2);
  const k = z / view.z;
  return { z, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k };
}

/** 확대한 그림의 가장자리가 화면 안쪽으로 들어오지 않게 이동을 묶는다. box = 1배일 때 그려진 크기, viewport = 화면 크기. */
export function clampPan(view, box, viewport) {
  if (view.z <= 1) return { z: view.z, x: 0, y: 0 };
  const mx = Math.max(0, (box.w * view.z - viewport.w) / 2);
  const my = Math.max(0, (box.h * view.z - viewport.h) / 2);
  return { z: view.z, x: Math.min(mx, Math.max(-mx, view.x)), y: Math.min(my, Math.max(-my, view.y)) };
}

/** 손을 뗐을 때 넘길지 — 1 다음 장, -1 이전 장, 0 그대로. 확대 중이면 이동만 한다. vx: px/ms */
export function swipeDecision({ dx, vx = 0, width, zoom, index, count }) {
  if (zoom > 1.01) return 0;
  const far = Math.max(40, width * 0.18);
  const dir = dx < -far || vx < -0.5 ? 1 : dx > far || vx > 0.5 ? -1 : 0;
  if (dir === 1 && index >= count - 1) return 0;
  if (dir === -1 && index <= 0) return 0;
  return dir;
}

/** 아래로 끌어 닫기 — 1배일 때만. vy: px/ms */
export const dismissDecision = ({ dy, vy = 0, zoom }) => zoom <= 1.01 && (dy > 120 || (dy > 20 && vy > 0.6));

/** 두 번 탭 — 300ms·30px 안 */
export const isDoubleTap = (prev, cur) => !!prev && cur.t - prev.t <= 300 && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= 30;

/** 휠·트랙패드 확대 — 위로 굴리면(deltaY<0) 커진다 */
export const wheelZoom = (z, deltaY) => clampZoom(z * Math.exp(-deltaY * 0.002));
