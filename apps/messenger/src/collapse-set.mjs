// 업무 자동화 카드 접기/펼치기 — 여러 개 동시에 펼칠 수 있어 열린 id 집합으로 관리한다(순수 함수, 컴포넌트는 Set만 감싼다).
export function toggleId(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
