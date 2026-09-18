// 초대 서버 호출 — 만들기·미리보기·수락·취소(설계서 invite-ux-spec 1장, 정비사 #610과 합의한 모양).
// 새 RPC·열이 없는 서버(0.1.30 앱이 라이브 적용 전 서버를 만날 때)에서는 옛 흐름으로 물러난다: 옛 insert, 즉시 수락, delete 취소.
// UI 없는 순수 모듈 — test/invite-flow.test.mjs가 가짜 supabase로 잠근다.

// 서버에 함수·열이 없다(work-panel.jsx missingSchema와 같은 판정 — .mjs 시험에서 jsx를 못 읽어 한 줄을 둔다)
export const missingFn = (error) => /PGRST20[245]|42P01|42703|42883/.test(error?.code ?? '') || /schema cache|does not exist|Could not find the (table|function)/i.test(error?.message ?? '');
const DAY = 86_400_000;
const errOf = (e) => Object.assign(new Error(e?.message ?? String(e)), { code: e?.code });

// 만들 행 — 멤버는 사용 횟수 선택(제한 없음 = null 명시: 서버 기본은 옛 앱 호환 1회), 게스트는 늘 1회·채널 하나
export function inviteRow({ orgId, uid, role, channelIds = [], expiryDays = 7, maxUses = null, guestDays = 30 }, now = Date.now()) {
  const row = { org_id: orgId, role, created_by: uid, channel_ids: role === 'guest' ? channelIds.slice(0, 1) : channelIds,
    max_uses: role === 'guest' ? 1 : maxUses, expires_at: expiryDays == null ? null : new Date(now + expiryDays * DAY).toISOString() };
  if (role === 'guest') row.guest_days = guestDays;
  return row;
}

export async function createInvite(sb, opts, now = Date.now()) {
  const row = inviteRow(opts, now);
  let res = await sb.from('msgr_invites').insert(row).select('code').single();
  if (res.error && missingFn(res.error)) { // 옛 서버: channel_ids·max_uses 열이 없다 → 옛 모양(게스트는 channel_id 단수, 만료·횟수는 서버 기본)
    const old = { org_id: row.org_id, role: row.role, created_by: row.created_by };
    if (row.role === 'guest') Object.assign(old, { channel_id: row.channel_ids[0], guest_days: row.guest_days });
    res = await sb.from('msgr_invites').insert(old).select('code').single();
    if (!res.error) return { code: res.data.code, legacy: true };
  }
  if (res.error) throw errOf(res.error);
  return { code: res.data.code, legacy: false };
}

// 미리보기 — 서버에 없으면 null(앱은 옛 즉시 수락으로). 틀린 코드는 예외 msgr_invite_not_found
export async function previewInvite(sb, code) {
  const res = await sb.rpc('msgr_invite_preview', { code });
  if (res.error) { if (missingFn(res.error)) return null; throw errOf(res.error); }
  return res.data;
}

// 수락 — v2(조직 + 첫 채널 + 건너뛴 채널), 없으면 v1(조직 id만)
export async function acceptInvite(sb, code) {
  const res = await sb.rpc('msgr_accept_invite_v2', { code });
  if (!res.error) { const d = res.data ?? {}; return { orgId: d.org_id, channelId: d.channel_id ?? null, joined: d.joined_channel_ids ?? [], skipped: d.skipped_channel_ids ?? [], legacy: false }; }
  if (!missingFn(res.error)) throw errOf(res.error);
  const old = await sb.rpc('msgr_accept_invite', { code });
  if (old.error) throw errOf(old.error);
  return { orgId: old.data, channelId: null, joined: [], skipped: [], legacy: true };
}

// 취소 — 소프트 취소(revoked_at, 목록의 "지난 초대"에 남는다), 없으면 옛 delete
export async function revokeInvite(sb, id) {
  const res = await sb.rpc('msgr_invite_revoke', { invite: id });
  if (!res.error) return { legacy: false };
  if (!missingFn(res.error)) throw errOf(res.error);
  const del = await sb.from('msgr_invites').delete().eq('id', id).select('id');
  if (del.error) throw errOf(del.error);
  if (!del.data?.length) throw new Error('msgr_invite_not_found');
  return { legacy: true };
}

// 목록의 상태 — live | expired | exhausted | revoked. 옛 1회용(열 없음)은 수락되면 소진
export function inviteStatus(inv, now = Date.now()) {
  if (inv.revoked_at) return 'revoked';
  if (inv.expires_at && Date.parse(inv.expires_at) <= now) return 'expired';
  if (inv.max_uses != null && (inv.use_count ?? 0) >= inv.max_uses) return 'exhausted';
  if (inv.max_uses === undefined && inv.accepted_at) return 'exhausted';
  return 'live';
}
export const daysLeft = (inv, now = Date.now()) => inv.expires_at ? Math.max(0, Math.ceil((Date.parse(inv.expires_at) - now) / DAY)) : null;

// 서버 오류 → 사용자 문구 키(없으면 null — 호출한 쪽이 기존 friendlyErr로)
const ERR_KEYS = [
  [/msgr_invite_not_found|msgr_invite_invalid/, 'inv.err.notFound'], [/msgr_invite_expired/, 'inv.err.expired'],
  [/msgr_invite_exhausted/, 'inv.err.exhausted'], [/msgr_invite_revoked/, 'inv.err.revoked'],
  [/msgr_invite_channel_forbidden/, 'inv.err.channelForbidden'], [/msgr_invite_channel_invalid/, 'inv.err.channelInvalid'],
  [/msgr_invite_guest_one_channel/, 'inv.err.guestOne'], [/msgr_seat_limit/, 'seat.limit'],
];
export const inviteErrorKey = (msg) => ERR_KEYS.find(([re]) => re.test(msg ?? ''))?.[1] ?? null;
