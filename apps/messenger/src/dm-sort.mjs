// 폰 DM 탭 정렬(유건 요청 2026-09-15) — 순수 함수. 고정(즐겨찾기) DM은 호출자가 앞에 둔다.
//   recent: 마지막 메시지 시각 내림차순(모르면 가장 오래된 것으로) · unread: 안읽음 있는 대화 먼저, 그 안은 최근순 · name: 이름순(한글)
export const DM_SORTS = ['recent', 'unread', 'name'];
export function sortDms(list, { sort = 'recent', lastAt = {}, unread = {}, nameOf = (c) => c.name ?? '' } = {}) {
  const key = DM_SORTS.includes(sort) ? sort : 'recent';
  return [...list].sort((a, b) => {
    if (key === 'name') return nameOf(a).localeCompare(nameOf(b), 'ko');
    const ua = unread[a.id]?.n ?? 0, ub = unread[b.id]?.n ?? 0;
    if (key === 'unread' && (ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1;
    return (lastAt[b.id] ?? 0) - (lastAt[a.id] ?? 0) || nameOf(a).localeCompare(nameOf(b), 'ko');
  });
}
