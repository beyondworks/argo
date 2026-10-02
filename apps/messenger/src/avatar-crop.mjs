// 프로필 사진 자르기 계산(유건 피드백 4, 2026-10-01 밤) — 정사각형 틀(frame px) 안에 원본(w×h)을 그린다.
// zoom 1 = 틀을 꽉 채우는 배율(짧은 변 = 틀), x·y = 틀 가운데에서 사진 가운데까지 옮긴 거리(px). 순수 함수 — 화면은 App.jsx AvatarCrop.
export const ZOOM_MAX = 4;
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(1, Number(z) || 1));
export const coverScale = (w, h, frame) => frame / Math.min(w, h);

/** 사진이 틀 밖으로 빠져 빈 자리가 보이지 않게 옮긴 거리를 묶는다 */
export function clampOffset({ w, h, frame, zoom, x, y }) {
  const s = coverScale(w, h, frame) * clampZoom(zoom);
  const mx = Math.max(0, (w * s - frame) / 2); const my = Math.max(0, (h * s - frame) / 2);
  const c = (v, m) => (m === 0 ? 0 : Math.min(m, Math.max(-m, v)));
  return { x: c(x, mx), y: c(y, my) };
}

/** 저장할 원본 좌표의 정사각형 { sx, sy, size } — 틀에 보이는 그대로 */
export function cropRect({ w, h, frame, zoom, x, y }) {
  const z = clampZoom(zoom); const s = coverScale(w, h, frame) * z;
  const o = clampOffset({ w, h, frame, zoom: z, x, y });
  const ix = frame / 2 + o.x - (w * s) / 2; const iy = frame / 2 + o.y - (h * s) / 2;
  return { sx: -ix / s + 0, sy: -iy / s + 0, size: frame / s }; // + 0: -0을 0으로
}
