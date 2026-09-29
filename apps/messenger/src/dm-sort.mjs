// 폰 DM 탭 정렬(유건 요청 2026-09-15) — 순수 함수. 고정(즐겨찾기) DM은 호출자가 앞에 둔다.
//   recent: 마지막 메시지 시각 내림차순(모르면 가장 오래된 것으로) · unread: 안읽음 있는 대화 먼저, 그 안은 최근순 · name: 이름순(한글)
//   custom: 직접 배치(유건 확정 2026-09-29) — 사용자가 끌어서 정한 순서(sort_pos). "내 에이전트" 레일 정렬도 이 함수를 그대로 쓴다.
export const DM_SORTS = ['recent', 'unread', 'name', 'custom'];

// sort_pos가 있는 항목은 그 값 오름차순, 없는(새로 생긴) 항목은 맨 아래에 붙이고 그 안은 이름순.
export function sortByCustomOrder(list, sortPos = {}, nameOf = (c) => c.name ?? '') {
  return [...list].sort((a, b) => {
    const pa = sortPos[a.id], pb = sortPos[b.id];
    if (pa == null && pb == null) return nameOf(a).localeCompare(nameOf(b), 'ko');
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });
}

export function sortDms(list, { sort = 'recent', lastAt = {}, unread = {}, nameOf = (c) => c.name ?? '', sortPos = {} } = {}) {
  const key = DM_SORTS.includes(sort) ? sort : 'recent';
  if (key === 'custom') return sortByCustomOrder(list, sortPos, nameOf);
  return [...list].sort((a, b) => {
    if (key === 'name') return nameOf(a).localeCompare(nameOf(b), 'ko');
    const ua = unread[a.id]?.n ?? 0, ub = unread[b.id]?.n ?? 0;
    if (key === 'unread' && (ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1;
    return (lastAt[b.id] ?? 0) - (lastAt[a.id] ?? 0) || nameOf(a).localeCompare(nameOf(b), 'ko');
  });
}
