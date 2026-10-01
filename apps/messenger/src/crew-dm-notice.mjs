// 에이전트와의 1:1(사람은 나 하나, 에이전트 하나)에서 에이전트가 꺼져 있으면 입력창 위에 알린다 — 보내도 체크 표시만 뜨고 답이 없는데 이유를 알 길이 없었다(검수 F, 2026-10-01).
// 꺼짐 = 최근 awayMs 안에 접속 신호가 없음(시트의 '꺼져 있음'과 같은 기준). 켜는 스위치는 메신저에 없다 — 내 컴퓨터의 Argo 앱이 켜져야 신호가 온다.
export function crewAwayNotice({ channel, chCrews, people, uid, now, awayMs }) {
  if (channel?.kind !== 'dm' || chCrews.length !== 1 || people.length > 1) return null;
  const c = chCrews[0];
  if (c.last_seen_at && now - Date.parse(c.last_seen_at) < awayMs) return null;
  return { name: c.display_name, mine: c.owner_user_id === uid };
}
