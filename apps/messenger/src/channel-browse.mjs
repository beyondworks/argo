// 채널 둘러보기·검색 판단 — 순수 함수(App.jsx 홈 목록·검색이 쓴다).
// 조직 1:1(kind 'dm')은 채널이 아니다. channels 상태에는 1:1이 섞여 있어, 길이로 "채널이 있다"를 판단하면
// 1:1만 있는 멤버에게 둘러보기 안내가 사라지고 공개 채널에 들어갈 길이 없었다(점검 A·B #2).

const isChannel = (c) => c.kind !== 'dm';

export const hasChannelRows = (channels) => channels.some(isChannel);

/** 참여한 채널이 하나도 없고 참여할 수 있는 공개 채널이 있을 때 "둘러보기" 안내를 보인다. */
export const browseHintVisible = ({ org, channels, previewChannels }) => !!org && !hasChannelRows(channels) && previewChannels.length > 0;

/** 검색 대상 채널 — 참여한 채널과 참여 전 공개 채널(미리보기로 열 수 있다). 1:1은 제외. */
export const channelSearchPool = (channels, previewChannels) => [...channels, ...previewChannels].filter(isChannel);

export const searchChannelsByName = (channels, previewChannels, needle) => {
  const lc = String(needle).toLowerCase();
  return channelSearchPool(channels, previewChannels).filter((c) => (c.name || '').toLowerCase().includes(lc));
};

// 공개 채널에 사람으로 참여할 수 있는 조직 역할 — 서버 msgr_can_read_channel·msgr_channel_member_ok(20261006160000)와 같은 목록. 게스트는 초대받은 비공개 채널만.
const PUBLIC_ROLES = ['owner', 'admin', 'member'];

/** 내보내기가 제외 목록에 올리는 채널인가 — 공개·비공개 채널(유건 결정 2026-10-06, 서버 msgr_channel_kick_excludes). 대화방(dm)은 내보내기가 없다. */
export const kickExcludes = (channel) => channel?.kind === 'public' || channel?.kind === 'private';

/** 채널 설정의 '사람 추가' 후보인가 — 공개·비공개 채널은 제외 목록에 든 사람을 빼고(되돌리기는 '내보낸 사람' 목록에서), 공개 채널은 게스트도 뺀다(서버가 거절한다). */
export const addableToChannel = (channel, member, excludedUsers = []) =>
  !(kickExcludes(channel) && excludedUsers.includes(member.user_id)) && (channel?.kind !== 'public' || PUBLIC_ROLES.includes(member.role));
