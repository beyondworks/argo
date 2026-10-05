// 조직 시작 단계의 판단(D1·D3) — 빈 조직 안내·첫 채널 뒤 남은 단계 카드·새 채널 폼이 같은 판단을 쓴다.

// 새 채널 기본 종류: 조직에 공개 채널이 없으면 공개(#general), 있으면 비공개 — 무료 조직은 공개 채널 1개(S33).
// 참여 안 한 공개 채널(preview)도 조직의 공개 채널이다.
export const hasPublicChannel = (channels = [], preview = []) => channels.some((c) => c.kind === 'public') || preview.length > 0;
export const newChannelKind = (channels, preview) => (hasPublicChannel(channels, preview) ? 'private' : 'public');

// 단계 표지: 'done' 끝남 · 'mark' 지금 할 일(하나) · '' 아직. 초대 단계는 관리자에게만 있다.
export function stepMarks({ hasChannel, isAdmin, invited, hasCrew }) {
  const next = !hasChannel ? 'channel' : isAdmin && !invited ? 'invite' : 'agent';
  const st = (k, done) => (done ? 'done' : k === next ? 'mark' : '');
  return { channel: st('channel', hasChannel), ...(isAdmin ? { invite: st('invite', invited) } : {}), agent: st('agent', hasCrew) };
}

// 새 채널을 만들 수 있나(서버 msgr_create_channel: owner·admin·member만, 잠긴 조직은 msgr_forbidden) — 못 만들면 단추를 빼고 이유를 보인다(2차 검수 L-b).
// why = 이유 문구 키(잠김이 먼저 — 게스트도 잠김이 풀려야 한다), 개인 공간·역할 모름은 이유 없이 못 만든다.
export function newChannelOffer({ role = null, locked = false, personal = false } = {}) {
  if (personal || !role) return { can: false, why: null };
  if (locked) return { can: false, why: 'ch.new.blocked.locked' };
  if (role === 'guest') return { can: false, why: 'ch.new.blocked.guest' };
  return { can: true, why: null };
}
