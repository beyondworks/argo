// 메신저 v2 앱 내 검색(⌘K)의 글 찾기(U6c-2b) — 서버 msgr2_search(U6d: 내가 읽을 수 있는 방 최근 200개 × 방마다 최근 글 300개 안, 차단한 사람 글 제외, 최대 50개)를
// 한 번 부르고 지금 보는 공간의 방 글만 옛 검색 행 모양으로 돌려준다. 사람·에이전트·채널 찾기는 화면이 이미 가진 목록으로 한다(종전과 같음).
export const V2_SEARCH_MAX = 50; // 서버 상한(p_limit 1~50)

/** client = 조회 어댑터(msgr2_*는 기기 등록 뒤에 나간다), q = 찾을 말(서버는 2~100자만 찾는다), roomIds = 이 공간의 방 id 집합.
    옛 검색 행 배열을 돌려준다(최신순). 실패는 던진다 — 자르기·실패 표시는 셸의 fetchSearchRows가 종전대로 한다. */
export async function v2SearchFound(client, q, roomIds) {
  const r = await client.rpc('msgr2_search', { p_q: q, p_limit: V2_SEARCH_MAX });
  if (r?.error) throw new Error(r.error.message);
  return (r.data?.messages ?? []).filter((m) => roomIds.has(m.room_id)).map((m) => ({ id: Number(m.id), channel_id: m.room_id, author_kind: m.author_kind === 'agent' ? 'crew' : m.author_kind,
    author_user_id: m.author_user_id ?? null, crew_id: m.author_agent_id ?? null, body: m.snippet ?? '', created_at: m.created_at, _v2: true }));
}
