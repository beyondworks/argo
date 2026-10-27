// 계정 삭제가 소유 조직 때문에 거부될 때(서버 msgr_owner_transfer_required)의 안내 고르기. 화면 문구는 i18n 사전(acct.delete.*)만 쓴다.
// v2(새 메신저)에는 주인 넘기기·조직 삭제가 아직 없어(설정 › 조직의 그 단추는 v2_unsupported) 남은 멤버를 내보내는 길만 안내한다(2026-10-27 총괄 결정).
// 경로는 실제 메뉴 이름 키에서 조립한다 — 데스크톱 설정 › 멤버, 폰 나 › 조직 프로필·계정 › 조직 설정 › 멤버. 옛(v1) 모드는 종전 문구 그대로.
export function ownerDeleteBlockedCopy(t, { v2 = false, phone = false, orgs = '' } = {}) {
  if (!v2) return t('acct.delete.transferFirst', { orgs });
  const path = (phone ? ['phone.tab.me', 'phone.set.orgRow', 'phone.org.settings', 'set.tab.members'] : ['ui.settings', 'set.tab.members']).map((k) => t(k)).join(' › ');
  return t('acct.delete.removeMembersFirst', { orgs, path });
}
