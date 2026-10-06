// 상단 검색 → 받는 화면(데크·활동·기억) 전달 — 이벤트 이름과 질의 정규화를 한 곳에 둔다(UL10, 2026-10-05).
// 레이아웃(emitSearch)과 세 화면(subscribeSearch)이 같은 모듈을 지나므로 이름이 어긋나 검색 칸이 다시 죽은 칸이 되는 일이 구조적으로 없다.
// 어느 화면이 검색을 받는지는 search-scope.mjs. JSX 없는 모듈이라 node --test가 EventTarget으로 직접 행동을 검증한다.
export const SEARCH_EVENT = 'argo:search';

/** 레이아웃 — 검색칸 값이 바뀔 때 보낸다. target = window. */
export function emitSearch(target, q) {
  target.dispatchEvent(new CustomEvent(SEARCH_EVENT, { detail: q }));
}

/** 받는 화면 — 질의(소문자로 정규화, 비면 '')를 onQuery로 받는다. 반환 = 구독 해제 함수. */
export function subscribeSearch(target, onQuery) {
  const handler = (e) => onQuery(String(e?.detail || '').toLowerCase());
  target.addEventListener(SEARCH_EVENT, handler);
  return () => target.removeEventListener(SEARCH_EVENT, handler);
}
