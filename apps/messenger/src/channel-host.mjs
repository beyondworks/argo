// 채널 관리 판정 — 서버 msgr_can_manage_channel·msgr_is_channel_host(20261006160000_msgr_security_fixes.sql 2절)와 같은 규칙.
//   조직 관리자 || ((채널 생성자 || 채널 관리자) && 지금 그 채널에 참여 중)
// 참여 행이 없으면 서버는 생성자·채널 관리자의 쓰기를 거절한다. 9/16 전에 만든 공개 채널은 생성자가 한 번도 참여하지 않았을 수 있고(그때는 공개 채널이 조직 전체에 열려 있었다),
// 그 생성자가 미리보기로 열어 설정 단추가 보여도 저장은 거절됐다(점검 H44). 최종 판정은 RLS — 이 함수는 단추를 서버와 같은 모양으로 보이게 할 뿐이다.
//
// joined = 내가 이 채널에 지금 참여 중인가. App에서는 `channels`(참여 중인 채널 + 비공개·1:1)에 있으면 참, `previewChannels`(참여 전 공개 채널)에 있으면 거짓.

/**
 * @param {{ channel: object, uid: string|null, isAdmin?: boolean, joined?: boolean }} p
 * @returns {{ canEdit: boolean, canAssignAdmins: boolean, needsJoin: boolean }} needsJoin = 지금 막힌 이유가 '참여하지 않아서'뿐일 때(참여하면 풀린다) — 안내 문구를 가른다
 */
export function channelManage({ channel, uid, isAdmin = false, joined = false }) {
  const isCreator = !!uid && channel?.created_by === uid; // uid가 아직 없을 때 created_by 없는 채널과 같다고 보지 않는다
  const isChannelAdmin = !!uid && (channel?.admin_user_ids ?? []).includes(uid);
  const host = isCreator || isChannelAdmin;
  return {
    canEdit: !!isAdmin || (host && !!joined),
    // 채널 관리자 지정은 조직 관리자·생성자만(자기 증식 방지 — 서버 msgr_channel_admins_guard). 생성자도 참여 중이어야 서버 갱신 정책(msgr_can_manage_channel)을 통과한다
    canAssignAdmins: channel?.kind !== 'dm' && (!!isAdmin || (isCreator && !!joined)),
    needsJoin: !isAdmin && host && !joined,
  };
}

/**
 * 내가 관리하는 채널 id 집합(초대 창의 hostOf) — 서버 msgr_is_channel_host와 같게, **참여 중인 채널 목록**(`channels`)에서만 센다.
 * 참여 전 공개 채널(previewChannels)은 넘기지 않는다. 조직 관리자는 이 집합이 아니라 isAdmin으로 따로 취급한다. 1:1은 채널이 아니다.
 */
export const hostChannelIds = ({ channels, uid }) => new Set(!uid ? [] : (channels ?? []).filter((c) => c.kind !== 'dm' && (c.created_by === uid || (c.admin_user_ids ?? []).includes(uid))).map((c) => c.id));

/**
 * 폰 설정 > 에이전트 기억 카드의 채널 한 줄 — 켜고 끌 수 있는가, 못 하면 줄 옆에 보일 이유(i18n 키).
 * hostIds는 위 hostChannelIds(참여 중인 채널 중 내가 만들었거나 관리자인 채널). 서버 갱신 정책(msgr_can_manage_channel)과 같은 규칙이다.
 * 만들었거나 관리자인데 hostIds에 없으면 참여하지 않은 채널이다 — 채널 시트와 같게 '참여하면 바꿀 수 있음'으로 알려 준다(조직 정책 고정이 먼저).
 * @returns {{ can: boolean, hintKey: string|null }}
 */
export function memoryToggle({ channel, uid, isAdmin = false, hostIds, locked = false }) {
  if (locked) return { can: false, hintKey: 'phone.set.chMemory.lockedShort' };
  if (isAdmin || hostIds?.has(channel?.id)) return { can: true, hintKey: null };
  const { needsJoin } = channelManage({ channel, uid, isAdmin: false, joined: false });
  return { can: false, hintKey: needsJoin ? 'phone.set.chMemory.needJoin' : 'phone.set.chMemory.hostOnly' };
}
