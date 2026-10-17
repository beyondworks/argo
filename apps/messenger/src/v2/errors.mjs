// 메신저 v2 서버 오류 코드(U6d 20261018040000_msgr2_rooms.sql 등) → 사전 키(U6c-2b). friendlyErr(error-toast.mjs)가 가장 먼저 부른다.
// 코드는 서버 예외 원문 안의 단어다(PostgREST message). 모르는 msgr2_ 코드는 null — 부르는 쪽의 기존 판정(권한·한도·진단 안내)으로 간다.
const KEYS = [
  [/\bmsgr2_app_device_required\b/, 'v2.err.appDevice'],
  [/\bmsgr2_device_invalid\b|\bv2_not_registered\b/, 'v2.state.unreachable'],
  [/\bservice_paused\b/, 'v2.state.paused'],
  [/\bmsgr2_not_space_member\b/, 'v2.err.notSpaceMember'],
  [/\bmsgr2_not_friend\b/, 'v2.err.notFriend'],
  [/\bmsgr2_group_blocked_pair\b/, 'v2.err.blockedPair'],
  [/\bmsgr2_invite_rejoin_direct_only\b/, 'v2.err.rejoinDirect'],
  [/\bmsgr2_dm_unavailable\b/, 'v2.err.dmUnavailable'],
  [/\bmsgr2_invite_unavailable\b/, 'v2.err.inviteUnavailable'],
  [/\bmsgr2_agent_not_allowed\b/, 'v2.err.agentNotAllowed'],
  [/\bmsgr2_room_not_found\b/, 'v2.err.roomNotFound'],
  [/\bmsgr2_space_not_found\b/, 'v2.err.spaceNotFound'],
  [/\bmsgr2_direct_fixed\b/, 'v2.err.directFixed'],
  [/\bmsgr2_invite_not_found\b/, 'inv.err.notFound'],
  [/\bmsgr2_invite_expired\b/, 'inv.err.expired'],
  [/\bmsgr2_invite_exhausted\b/, 'inv.err.exhausted'],
  [/\bmsgr2_invite_revoked\b/, 'inv.err.revoked'],
  [/\bmsgr2_invite_declined\b/, 'v2.err.inviteDeclined'],
  [/\bmsgr2_invite_room_forbidden\b/, 'inv.err.channelForbidden'],
  [/\bmsgr2_bad_name\b/, 'v2.err.badName'],
  [/\bmsgr2_slug_taken\b/, 'v2.err.slugTaken'],
  [/\bmsgr2_bad_[a-z_]+\b/, 'v2.err.bad'],
  [/\bmsgr2_limit\b/, 'err.limit'],
  [/\bmsgr_owner_transfer_required\b/, 'v2.err.ownerTransfer'],
  [/\bmsgr2_report_own\b/, 'v2.err.reportOwn'],
  [/\bmsgr2_report_no_message\b/, 'v2.err.reportGone'],
  [/\bmsgr2_(?:forbidden|use_leave)\b/, 'err.denied'],
];
/** 서버 원문 → 사전 키, 모르면 null. */
export const v2ErrorKey = (msg) => KEYS.find(([re]) => re.test(String(msg ?? '')))?.[1] ?? null;
export const V2_ERROR_KEYS = KEYS.map(([, k]) => k);
