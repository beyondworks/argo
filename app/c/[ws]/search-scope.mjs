// 상단 검색의 대상 — JSX 없는 순수 함수(UX-A03, 2026-10-05). 상단 '검색'은 argo:search 이벤트를 보내기만 하는데 받는 화면은
// 데크·활동·기억 셋뿐이라, 다른 화면에선 입력해도 아무 일도 없었다. 받는 화면에서만 보이고, 무엇을 찾는지 placeholder로 말한다.
/** → 'deck' | 'activity' | 'vault' | null(검색 없음 — 칸을 숨긴다) */
export function searchScope(pathname, ws) {
  const p = String(pathname ?? '').replace(/\/+$/, '');
  const base = `/c/${ws}`;
  if (p === base) return 'deck';
  if (p === `${base}/activity`) return 'activity';
  if (p === `${base}/vault`) return 'vault';
  return null;
}
