// 폰 조직 설정 멤버 탭(5차 피드백, 유건 2026-10-02) — 판단은 여기 한 곳(화면은 App.jsx PhoneMembers).
export const MEMBER_CHIPS = ['all', 'admin', 'member', 'guest'];

/** 나를 뺀 멤버 줄 — chip: 'all'|'admin'(소유자 포함)|'member'|'guest', q: 이름·부서. 서버 계정(serviceId)은 '전체'에서만 보인다.
    줄마다 sub = '부서 · 직급'(빈 칸은 뺀다), service = 서버 계정인가. */
export function memberRows(members, { uid, profiles = null, serviceId = null, chip = 'all', q = '' } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  return (members ?? []).filter((m) => m.user_id !== uid).map((m) => {
    const p = profiles?.get?.(m.user_id) ?? {};
    return { ...m, service: !!serviceId && m.user_id === serviceId, department: p.department ?? '', title: p.title ?? '', sub: [p.department, p.title].filter(Boolean).join(' · ') };
  }).filter((m) => {
    if (chip !== 'all' && (m.service || !(chip === 'admin' ? m.role === 'admin' || m.role === 'owner' : m.role === chip))) return false;
    return !needle || [m.display_name, m.department].some((v) => String(v ?? '').toLowerCase().includes(needle));
  });
}

/** 시트에서 할 수 있는 일 — 관리자·소유자만, 대상이 나·소유자·서버 계정이면 아무도 못 한다(서버도 같은 규칙으로 다시 막는다). */
export function memberPerms({ viewerRole, target, uid, serviceId = null }) {
  const ok = (viewerRole === 'admin' || viewerRole === 'owner') && !!target && target.user_id !== uid && target.user_id !== serviceId && target.role !== 'owner';
  return { canRole: ok, canRemove: ok };
}
