// 팀 메신저 역할 경계표 — 단일 정본. pg 드릴(test/msgr-pg-integration.test.mjs)이 실제 RLS에 대고 돌리고,
// 후속 JS 거울(앱의 권한 표시)이 같은 표를 읽는다. 값을 여기서만 바꾼다.
// 역할: owner·admin·member·guest·removed(제거된 멤버)·outsider(멤버였던 적 없음)
export const ROLES = Object.freeze(['owner', 'admin', 'member', 'guest', 'removed', 'outsider']);

// 행동별 허용 역할. 'guest'는 초대된 채널(channel_members)만 보므로 공개 채널 행동은 불허.
export const ROLE_MATRIX = Object.freeze({
  readPublicChannel: ['owner', 'admin', 'member'],
  postPublicChannel: ['owner', 'admin', 'member'],
  createChannel: ['owner', 'admin', 'member'],
  inviteMember: ['owner', 'admin'],
  removeMember: ['owner', 'admin'],
  registerCrew: ['owner', 'admin', 'member'],
  readAudit: ['owner', 'admin'],
  readInvitedPrivateChannel: ['owner', 'admin', 'member', 'guest'], // 초대된 비공개 채널은 guest도 읽는다
  editPolicy: ['owner', 'admin'],                                    // 조직 정책(msgr_org_policies)은 관리자만 — 부록 H
});

export const FREE_SEATS = 3;         // 무료 조직 좌석(guest 포함) — 마이그레이션 msgr_member_seat_gate와 동일
export const FREE_PUBLIC_CHANNELS = 1; // 무료 조직 공개 채널 수 — msgr_channel_gate와 동일
