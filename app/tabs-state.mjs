// 탭 초기 선택 — 순수 판정(테스트 대상). 우선순위: ?tab= 쿼리 → 저장된 마지막 탭 → 기본.
// 쿼리·저장값이 현재 탭 목록에 없으면(탭 개편·오타) 조용히 다음 후보로 — 잘못된 값으로 빈 화면을 만들지 않는다.
export function resolveTab({ query, stored, ids, fallback }) {
  const ok = (v) => typeof v === 'string' && ids.includes(v);
  if (ok(query)) return query;
  if (ok(stored)) return stored;
  return ids.includes(fallback) ? fallback : ids[0];
}
