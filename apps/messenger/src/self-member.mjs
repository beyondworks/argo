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
