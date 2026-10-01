// 모듈 크기 규칙(유건 10/1 확정) — 가장자리를 끌어 폭(12열 격자의 열 단위)과 높이(8px 단위, 줄 공유)를 바꾼다.
// 끌기 화면 코드(ui/module-resize.js)와 ⋯ '크기 되돌리기'가 같이 쓰는 순수 함수. 첫 화면 묶음에 넣지 않는다(쓸 때 불러온다).
import { SPAN, rowsOf } from './layout.js';

export const MIN_H = 120, MAX_H = 1200, STEP_H = 8;

/** 폭 끌기 결과 [a, b]. b가 있으면 맞닿은 옆 모듈 — 둘의 합(줄 폭)을 유지한다. 없으면 a만, 같은 줄에 남은 폭(room) 안에서. */
export function dragSpans({ a, b, d, ra, rb, room = 12 }) {
  if (b == null) return [Math.min(Math.min(ra[1], Math.max(a, room)), Math.max(ra[0], a + d)), null];
  const total = a + b, lo = Math.max(ra[0], total - rb[1]), hi = Math.min(ra[1], total - rb[0]);
  if (lo > hi) return [a, b];
  const next = Math.min(hi, Math.max(lo, a + d));
  return [next, total - next];
}

/** 높이 눈금: 8px 단위, 최소(기본 120)~1200 */
export const snapH = (px, min = MIN_H) => Math.min(MAX_H, Math.max(min, Math.round(px / STEP_H) * STEP_H));

const nearest = (sizes, span) => sizes.reduce((best, s) => (Math.abs(SPAN[s] - span) < Math.abs(SPAN[best] - span) ? s : best), sizes[0]);

/**
 * patch = { [id]: { span?, h? } } — span null이면 폭을 지운다, h가 0이면 높이를 지운다.
 * 옛 앱·옛 화면은 size만 읽으므로 span을 쓰면 size도 가장 가까운 허용 단계로 같이 쓰고, 끌기 전 단계는 baseSize에 남긴다.
 * 폭을 지우거나 끌기 전 열 수로 돌아오면 끌기 전 단계로 돌아간다(등록부 기본값이 아니라 — 홈 기본 배치·대시보드 기본값이 다르다).
 */
export function applySizes(items, patch, modOf) {
  return items.map((item) => {
    const p = patch[item.id];
    if (!p) return item;
    const next = { ...item }, base = modOf(item).sizes.includes(item.baseSize) ? item.baseSize : item.size;
    if ('span' in p) {
      delete next.baseSize; delete next.span; next.size = base;
      if (p.span != null && p.span !== SPAN[base]) Object.assign(next, { span: p.span, baseSize: base, size: nearest(modOf(item).sizes, p.span) });
    }
    if ('h' in p) { if (p.h) next.h = p.h; else delete next.h; }
    return next;
  });
}

/** ⋯ 크기 되돌리기 — 그 줄에서 사용자가 바꾼 것만 지운다: 바꾼 폭은 끌기 전 단계로(경계를 같이 끈 옆 모듈도), 줄 높이는 같이 쓰므로 줄 전체. 바꾸지 않은 폭은 그대로 */
export function resetSize(items, id, modOf) {
  const row = rowsOf(items.filter((item) => !item.hidden)).find((r) => r.some((item) => item.id === id)) ?? [];
  const patch = Object.fromEntries(row.map((item) => [item.id, { ...('span' in item ? { span: null } : {}), ...('h' in item ? { h: 0 } : {}) }]));
  return applySizes(items, patch, modOf);
}
