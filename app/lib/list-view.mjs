// 목록 표시 상태 — JSX 없는 순수 함수. 조회 실패를 '비어 있음'이나 끝없는 로딩으로 보이지 않게 한다(F12·F13, 2026-10-05).
/** items: null(아직·실패) | 배열, failed: 조회 실패 여부 → 'loading' | 'error' | 'empty' | 'list' */
export function listView(items, failed) {
  if (Array.isArray(items)) return items.length ? 'list' : 'empty';
  return failed ? 'error' : 'loading';
}
