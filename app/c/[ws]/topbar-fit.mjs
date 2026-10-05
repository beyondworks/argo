// 상단바 적재 조절(layout.jsx fitBar)의 순수 배선 — JSX 없이 node --test가 직접 검증한다(topbar-fit.test.mjs).
// 문제(UM1, 2026-10-05): fitBar는 크기 관찰(ResizeObserver)로만 다시 돌았다. '새 소식'·'새로 고침 실패' 같은 칩은 상단바 안에 생겨도 바 자체의
// 크기는 그대로(내용만 넘친다)라 관찰기가 안 돌고, 접기 단계가 걸리지 않은 채 넘쳤다(561 en: 상단바 21px·문서 13px, 360 en: 20px).
/** 상단바 안의 자식(칩·배지·슬롯 내용)이 생기거나 사라질 때 fit을 다시 부른다. 반환 = 해제 함수.
    속성 변화는 보지 않는다 — fit이 문서 루트 속성(data-narrow-*)을 바꾸는데, 그것이 다시 fit을 부르면 되먹임이 된다. */
export function watchTopbarContent(bar, fit, { MutationObserverImpl = globalThis.MutationObserver } = {}) {
  if (!bar || !MutationObserverImpl) return () => {};
  const observer = new MutationObserverImpl(() => fit());
  observer.observe(bar, { childList: true, subtree: true });
  return () => observer.disconnect();
}
