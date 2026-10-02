// 크루 오피스 도구의 "이 대화를 누가 보는가"(분리 검수 MEDIUM 3) — 도구 출력은 그대로 채널에 올라갈 수 있으므로, 민감한 값(평가 점수·총평,
// 계좌·세무·가림 항목, 통장사본 글자)은 주인 혼자 보는 1:1에서만 내고, 손님·조직 밖 사람이 있을 수 있는 방에서는 회사·파일 기록을 아예 다루지 않는다.
//   'owner' — 1:1(DM) 방이고 사람 참여자가 주인 하나뿐
//   'org'   — 공개 채널(손님은 못 읽는다 — msgr_channels_select) 또는 사람 참여자가 모두 이 조직의 손님 아닌 멤버
//   'mixed' — 그 밖(손님·나간 사람·조직 밖 사람이 있거나, 확인하지 못함 — 모르면 좁게)
// 비용: 도구를 부를 때 조회 1~2건(채널 사람 목록·그 사람들의 역할). 주기 호출 없음.
export async function audienceOf(client, ctx, ownerId) {
  if (ctx?.channelKind === 'public') return 'org';
  if (!ctx?.channelId || !ctx?.orgId) return 'mixed';
  let users;
  try {
    const { data, error } = await client.from('msgr_channel_members').select('member_id').eq('channel_id', ctx.channelId).eq('member_kind', 'user');
    if (error) return 'mixed';
    users = [...new Set((data ?? []).map((r) => r.member_id))];
  } catch { return 'mixed'; }
  if (!users.length) return 'mixed';
  if (ctx.channelKind === 'dm' && users.every((u) => u === ownerId)) return 'owner';
  try {
    const { data, error } = await client.from('msgr_org_members').select('user_id, role, removed_at').eq('org_id', ctx.orgId).in('user_id', users);
    if (error) return 'mixed';
    const ok = new Set((data ?? []).filter((m) => !m.removed_at && m.role !== 'guest').map((m) => m.user_id));
    return users.every((u) => ok.has(u)) ? 'org' : 'mixed';
  } catch { return 'mixed'; }
}

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
export const ONLY_DM = (lang) => pick('주인과의 1:1 대화에서만', 'only in a 1:1 chat with the owner', lang);
export const mixedRefusal = (lang) => pick('이 방에는 손님이나 조직 밖 사람이 있을 수 있어 회사·파일 기록을 다루지 않는다 — 주인과의 1:1이나 조직 채널에서 다시 부탁하라고 알려라.',
  'This room may include guests or people outside the organization, so company and file records are not used here — ask in a 1:1 or an org channel.', lang);
