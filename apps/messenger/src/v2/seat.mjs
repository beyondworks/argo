// 메신저 v2 에이전트 자리(팀 공간 seat) 호출 — 재공개 전 검수 F1(2026-10-23).
// 방에 넣기·파견은 msgr2_seat_ensure(자리가 없을 때만 'all'로 만들고, 있으면 주인이 정한 범위를 그대로 둔다 — 서버 20261023180000).
// 사용 범위 저장('모두'·'나만'·'지정한 사람')은 msgr2_set_seat(주인만, allow·users). 회수는 msgr2_set_seat p_remove(범위는 건드리지 않는다).
// 종전에는 방에 넣을 때마다 msgr2_set_seat(p_allow 'all')을 불러 '나만'·'지정한 사람'이 'all'로 덮어써졌다(0.1.63 대비 권한 회귀).
// rpc = (이름, 인자) => Promise<{ data, error }> (rawSupabase.rpc). 순수 — 시험이 가짜 rpc로 부른다.

const ALLOW = ['all', 'owner', 'list'];

/** 방에 넣기·다시 파견 — 자리가 없으면 만들고 있으면 범위 보존 */
export const seatEnsure = (rpc, agent, space) => rpc('msgr2_seat_ensure', { p_agent: agent, p_space: space });

/** 회수 — 자리를 빼되 범위는 그대로(다시 파견하면 seatEnsure가 되살린다) */
export const seatRecall = (rpc, agent, space) => rpc('msgr2_set_seat', { p_agent: agent, p_space: space, p_allow: 'all', p_remove: true });

/** 사용 범위 저장. 'list'가 아니면 명단은 비운다(옛 msgr_crews 저장과 같은 규칙). 모르는 값은 보내지 않는다(서버도 msgr2_bad_allow). */
export function seatSaveScope(rpc, agent, space, allow, users = []) {
  if (!ALLOW.includes(allow)) return Promise.resolve({ data: null, error: { message: 'msgr2_bad_allow' } });
  return rpc('msgr2_set_seat', { p_agent: agent, p_space: space, p_allow: allow, p_users: allow === 'list' ? [...new Set(users)] : [] });
}
