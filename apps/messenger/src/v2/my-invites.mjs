// 메신저 v2 받은 초대(사람을 지정한 공간 초대 — U6d msgr2_my_invites). 옛 앱에는 "나에게 온 초대"가 없었다(링크 코드뿐).
// 셸은 이것을 친구 요청과 같은 자리에 보인다: 데스크톱 알림함 항목(kind 'invite'), 폰 친구 탭의 요청 줄 아래. 누르면 기존 초대 미리보기 카드(InvitePreview)로 연다.
// 다시 읽는 때: 시작·복귀(syncEpoch)·v2:u: 'invite' 사건(누가 나를 초대함)·'spaces' 사건(수락해 멤버가 되면 서버 목록에서 빠진다). 주기 조회 없음.

/** 서버 행 → 화면 행. 코드가 없거나 공간이 없는 행은 뺀다(열 수 없다). 같은 공간 초대가 여럿이면 가장 최근 것 하나만(서버는 최근순). */
export function myInviteRows(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows ?? []) {
    if (!r?.code || !r.space_id || seen.has(r.space_id)) continue;
    seen.add(r.space_id);
    out.push({ id: r.invite_id, code: r.code, spaceId: r.space_id, spaceName: r.space_name || '', role: r.role ?? null,
      inviterId: r.inviter_id ?? null, inviterName: r.inviter_name || '', at: r.created_at ?? null, expiresAt: r.expires_at ?? null });
  }
  return out;
}

/** 알림함 항목(데스크톱) — 친구 요청 항목과 같은 모양. 누르면 inviteCode로 미리보기를 연다. */
export function inviteInboxItems(list, t) {
  return (list ?? []).map((v) => ({ kind: 'invite', key: `invite:${v.id}`, channel_id: null, at: v.at, who: v.inviterId, whoKind: 'user', friendName: v.inviterName,
    inviteCode: v.code, text: t('inbox.invite.text', { name: v.inviterName || t('inbox.invite.someone'), space: v.spaceName }) }));
}

/** 서버에서 받은 초대 목록을 읽는다. 실패하면 null(화면은 이전 목록을 그대로 둔다 — 실패를 빈 목록으로 덮지 않는다). */
export async function loadMyInvites(rpc) {
  const r = await rpc('msgr2_my_invites').catch((e) => ({ error: e }));
  if (!r || r.error) return null;
  return myInviteRows(r.data);
}
