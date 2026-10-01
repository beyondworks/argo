// 빈 목록 문구 고르기 — 순수 함수(App.jsx가 쓴다). 필터·탭 결과가 비었을 때 "아직 채팅이 없습니다"라고 거짓말하거나 아무 말도 안 하지 않게(점검 A·B #6).

/** 폰 채팅 탭·홈 채팅 구역 — total은 필터 전의 대화 수(고정 포함). 비었을 때 보일 문구 키, 안내가 필요 없으면 null.
    대화가 있는데 필터 결과가 비면 그 필터의 문구. 전체인데 목록이 비는 것은 대화가 전부 고정(즐겨찾기)된 경우뿐이라 고정 구역이 이미 보이므로 안내하지 않는다(점검 A·B #6 재검수). */
export function dmEmptyKey({ filter, total }) {
  if (total === 0) return 'phone.dm.empty';
  if (['group', 'unread', 'fav'].includes(filter)) return `phone.dm.empty.${filter}`;
  return null;
}

/** 대화방 탭(멘션·결재·에이전트) — 글은 있는데 이 탭에 보일 글이 없을 때만. 방 자체가 비었으면(total 0) 기존 방 안내가 맡는다. */
export function roomTabEmptyKey({ tab, total, shown }) {
  if (tab === 'all' || total === 0 || shown > 0) return null;
  return `tab.empty.${tab}`;
}
