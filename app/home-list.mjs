// 홈 회사 목록 표시 상태 — JSX 없는 순수 함수(F13, 2026-10-05: 조회 실패 시 해골 화면이 끝없이 돌았다).
/** companies: null(아직) | 배열, failed: 조회 실패 여부 → 'loading' | 'error' | 'empty' | 'list' */
export function homeListView(companies, failed) {
  if (Array.isArray(companies)) return companies.length ? 'list' : 'empty';
  return failed ? 'error' : 'loading';
}
