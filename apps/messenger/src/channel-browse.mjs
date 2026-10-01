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
