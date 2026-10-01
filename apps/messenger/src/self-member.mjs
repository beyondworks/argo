// 내 구성원 행 — 조직은 구성원 목록에서 찾고, 개인 공간은 목록(친구만)에 내가 없어 따로 만든다.
// 개인 공간에서 me가 비어 레일 하단은 이메일, 설정은 '—', 에이전트 시트는 uid 앞 8자리로 보이던 결함(검수 F, 2026-10-01).
// 이름 규칙은 서버와 같다: 조직 안 이름 → 프로필 이름 → 이메일 앞부분(msgr_person_label). 개인 방 목록(msgr_dm_personal_list)의 구성원 이름이 이미 그 규칙을 지난 값이다.
const pick = (v) => (typeof v === 'string' ? v.trim() : '');
export const emailLocal = (email) => pick(String(email ?? '').split('@')[0]);
export const personalSelfName = (names, uid) => pick(names?.[uid]);
export function selfMember({ members, uid, isPersonal, personalName = '', email = '' }) {
  const found = members.find((m) => m.user_id === uid);
  if (found || !isPersonal) return found;
  return { user_id: uid, role: null, display_name: pick(personalName) || emailLocal(email) };
}

// 개인 공간 내 이름 — 서버 이름 규칙(msgr_people_names, 자기 자신 허용) 한 번 읽기. 개인 방이 없어도·프로필을 방금 바꿔도 맞다(방 목록의 이름은 최대 30초 늦다, #793 검수 LOW-2).
// rpc = (함수 이름, 인자) => 행 배열. 못 읽으면(옛 서버·오류) 빈 문자열 — 호출한 쪽이 방 목록 이름·이메일 앞부분으로 물러난다.
export async function fetchSelfName(rpc, uid) {
  try { return pick((await rpc('msgr_people_names', { ids: [uid] })).find((r) => r.user_id === uid)?.name); } catch { return ''; }
}
