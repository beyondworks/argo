// 크게 보기 배율 규칙(순수 함수 — 테스트가 잠근다). 쪽 = 서식 794×1123px(A4), 쪽 사이 16px, 무대 안쪽 여백 24px. 배율 50~400%.
export const PAGE_W = 794, PAGE_H = 1123, PAGE_GAP = 16, STAGE_PAD = 24, MIN_Z = 0.5, MAX_Z = 4;
const STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export const clampZoom = (z) => Math.round(Math.min(MAX_Z, Math.max(MIN_Z, Number(z) || 1)) * 1000) / 1000;

/** − / + 한 칸 — 지금 배율보다 한 단계 작거나 큰 정해진 값(브라우저 확대와 같은 계단) */
export function stepZoom(z, dir) {
  const cur = clampZoom(z);
  const next = dir > 0 ? STEPS.find((s) => s > cur + 0.001) : [...STEPS].reverse().find((s) => s < cur - 0.001);
  return next ?? cur;
}

/** 폭 맞춤 = 쪽 폭이 무대 폭에 꼭 맞게, 쪽 맞춤 = 한 쪽 전체가 무대에 들어오게(둘 다 여백 빼고) */
export function fitZoom(mode, { width, height }) {
  const w = (width - STAGE_PAD * 2) / PAGE_W, h = (height - STAGE_PAD * 2) / PAGE_H;
  return clampZoom(mode === 'page' ? Math.min(w, h) : w);
}

/** 배율을 prev → next로 바꿀 때 무대 안 점 p(포인터)가 가리키던 문서 지점을 그 자리에 두는 스크롤 값 */
export function zoomAt({ scrollLeft, scrollTop }, p, prev, next, stageW = 0) {
  // 쪽이 무대보다 좁으면 가운데 놓인다 — 그 빈 폭(off)과 무대 안쪽 여백은 배율과 상관없이 그대로
  const off = (z) => Math.max(0, (stageW - STAGE_PAD * 2 - PAGE_W * z) / 2);
  const x = (scrollLeft + p.x - STAGE_PAD - off(prev)) / prev, y = (scrollTop + p.y - STAGE_PAD) / prev;
  return { scrollLeft: Math.max(0, x * next + STAGE_PAD + off(next) - p.x), scrollTop: Math.max(0, y * next + STAGE_PAD - p.y) };
}

/** 스크롤 위치(px) → 지금 보이는 쪽 번호(1부터) */
export const pageAt = (y, z, count) => Math.min(Math.max(1, count), Math.max(1, Math.floor(Math.max(0, y - STAGE_PAD) / (PAGE_H * z + PAGE_GAP)) + 1));
