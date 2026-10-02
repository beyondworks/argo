// 업무 자동화 카드 접기/펼치기 — 여러 개 동시에 펼칠 수 있어 열린 id 집합으로 관리한다(순수 함수, 컴포넌트는 Set만 감싼다).
export function toggleId(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// 기억 탭 '모두 접기 / 모두 펼치기'(유건 2026-10-02) — 기존 접기 저장 모양({ '조직id:폴더키': true }, PhoneMemory의 argo-msgr-mem-fold) 그대로.
// keys = 지금 보이는 폴더 키. 다른 조직·지금 안 보이는 폴더의 값은 건드리지 않는다.
export function foldAll(map, orgId, keys, shut) {
  const next = { ...map };
  for (const k of keys) { if (shut) next[`${orgId}:${k}`] = true; else delete next[`${orgId}:${k}`]; }
  return next;
}
export function allFolded(map, orgId, keys) {
  return keys.length > 0 && keys.every((k) => !!map?.[`${orgId}:${k}`]);
}
