// 모듈 크기 규칙 — 높이는 아래 가장자리를 끌어 8px 단위로(9차: 위·왼쪽·오른쪽 손잡이 없음, 폭은 열 경계선). 옛 앱용 열 수(span·size·baseSize) 쓰기.
// 끌기 화면 코드(ui/module-resize.js)·저장(core/block-move.js)·⋯ '크기 되돌리기'가 같이 쓰는 순수 함수. 첫 화면 묶음에 넣지 않는다(쓸 때 불러온다).
import { SPAN, spanOf, sizeForSpan } from './layout.js';

export const MIN_H = 120, MAX_H = 1200, STEP_H = 8;

/** 높이 눈금: 8px 단위, 최소(기본 120)~1200 */
export const snapH = (px, min = MIN_H) => Math.min(MAX_H, Math.max(min, Math.round(px / STEP_H) * STEP_H));
/** 높이 끌기 자석 — 아래 끝이 다른 모듈의 아래 끝(edges, 격자 기준 px)과 6px 안이면 거기에 딱 맞춘다. 8px 눈금 + 12px 틈으로는
 *  옆에 쌓은 두 모듈과 큰 모듈의 아래 끝이 4px 어긋난다(예: 232 + 12 + 232 ≠ 480) — 맞출 수 있게(유건 10/1 저녁 예시) */
export const magnet = (h, top, edges, min = MIN_H) => {
  const near = edges.find((b) => Math.abs(b - (top + h)) <= 6 && b - top >= min && b - top <= MAX_H);
  return near == null ? h : Math.round(near - top);
};
/** 키보드 한 번(↑/↓) = 16px — 지금 높이를 먼저 눈금에 맞춘 뒤 더한다. 내용대로인 줄(예: 418px)에서 바로 더하고 맞추면 +14가 되었다(통합 검수 10/1) */
export const stepH = (px, d, min = MIN_H) => snapH(Math.round(px / STEP_H) * STEP_H + d * 16, min);

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

/** 되돌릴 것 — 그 모듈에서 사용자가 바꾼 것만(유건 10/1 저녁: 크기 되돌리기는 그 모듈만). axis = 'span'|'h'면 그 방향만(가장자리 두 번 누르기),
 *  없으면 둘 다(⋯ 크기 되돌리기). 바꾼 게 없으면 빈 patch(저장하지 않는다) */
export const resetPatch = (items, id, axis) => {
  const item = items.find((it) => it.id === id), p = item ? { ...(axis !== 'h' && 'span' in item ? { span: null } : {}), ...(axis !== 'span' && 'h' in item ? { h: 0 } : {}) } : {};
  return Object.keys(p).length ? { [id]: p } : {};
};

/** ⋯ 크기 되돌리기 — 그 모듈의 폭·높이를 끌기 전으로 */
export const resetSize = (items, id, modOf) => applySizes(items, resetPatch(items, id), modOf);
