// 모듈 크기 규칙(유건 10/1 확정) — 가장자리를 끌어 폭(12열 격자의 열 단위)과 높이(8px 단위, 줄 공유)를 바꾼다.
// 끌기 화면 코드(ui/module-resize.js)와 ⋯ '크기 되돌리기'가 같이 쓰는 순수 함수. 첫 화면 묶음에 넣지 않는다(쓸 때 불러온다).
import { SPAN, rowsOf, spanOf, sizeForSpan } from './layout.js';

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
/** 키보드 한 번(↑/↓) = 16px — 지금 높이를 먼저 눈금에 맞춘 뒤 더한다. 내용대로인 줄(예: 418px)에서 바로 더하고 맞추면 +14가 되었다(통합 검수 10/1) */
export const stepH = (px, d, min = MIN_H) => snapH(Math.round(px / STEP_H) * STEP_H + d * 16, min);

/** 폭 가장자리가 움직이는 모듈 — index = 줄 안 자리, n = 줄 모듈 수. 맞닿은 옆 모듈이 있으면 그 경계(a = 앞, b = 뒤),
 *  줄 바깥 가장자리면 이 모듈만(b = null). 왼쪽 바깥 가장자리는 끄는 방향과 폭이 반대다(sign -1: 오른쪽으로 끌면 준다) */
export function edgePair(index, n, side) {
  const near = side === 'r' ? index + 1 : index - 1;
  if (near < 0 || near >= n) return { a: index, b: null, sign: side === 'l' ? -1 : 1 };
  return side === 'l' ? { a: near, b: index, sign: 1 } : { a: index, b: near, sign: 1 };
}

/**
 * patch = { [id]: { span?, h? } } — span null이면 폭을 지운다, h가 0이면 높이를 지운다.
 * 옛 앱·옛 화면은 size만 읽으므로 span을 쓰면 size도 가장 가까운 허용 단계로 같이 쓰고, 끌기 전 단계는 baseSize에 남긴다.
 * 폭을 지우거나 끌기 전 열 수로 돌아오면 끌기 전 단계로 돌아간다(등록부 기본값이 아니라 — 홈 기본 배치·대시보드 기본값이 다르다).
 */
export function applySizes(items, patch, modOf) {
  return items.map((item) => {
    const p = patch[item.id];
    if (!p) return item;
    // 끌기 전 단계 — 옛 탭이 size만 바꿔 span이 맞지 않으면(spanOf가 span을 버림) 지금 size가 끌기 전 단계다
    const next = { ...item }, base = spanOf(item) === item.span && modOf(item).sizes.includes(item.baseSize) ? item.baseSize : item.size;
    if ('span' in p) {
      delete next.baseSize; delete next.span; next.size = base;
      if (p.span != null && p.span !== SPAN[base]) Object.assign(next, { span: p.span, baseSize: base, size: sizeForSpan(p.span) }); // 허용 열 범위 안의 가장 가까운 단계는 늘 그 모듈이 허용하는 단계다(테스트로 잠금)
    }
    if ('h' in p) { if (p.h) next.h = p.h; else delete next.h; }
    return next;
  });
}

/** 되돌릴 것 — 그 줄에서 사용자가 바꾼 것만: 바꾼 폭은 끌기 전 단계로(경계를 같이 끈 옆 모듈도 — 하나만 되돌리면 줄 합이 12를 넘어 떨어진다), 줄 높이는 같이 쓰므로 줄 전체.
 *  axis = 'span'|'h'면 그 방향만(가장자리 두 번 누르기), 없으면 둘 다(⋯ 크기 되돌리기). 바꾼 게 없으면 빈 patch(저장하지 않는다) */
export const resetPatch = (row, axis) => Object.fromEntries(row.map((item) => [item.id, { ...(axis !== 'h' && 'span' in item ? { span: null } : {}), ...(axis !== 'span' && 'h' in item ? { h: 0 } : {}) }]).filter(([, p]) => Object.keys(p).length));

/** ⋯ 크기 되돌리기 — 그 줄에서 바꾼 폭·높이를 끌기 전으로. 바꾸지 않은 폭은 그대로 */
export function resetSize(items, id, modOf) {
  const row = rowsOf(items.filter((item) => !item.hidden)).find((r) => r.some((item) => item.id === id)) ?? [];
  return applySizes(items, resetPatch(row), modOf);
}
