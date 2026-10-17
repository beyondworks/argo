// 메신저 v2 어댑터의 RPC 번역(U6c-2b) — 기존 셸이 부르던 옛 RPC(msgr_*)를 U6d 서버 RPC(msgr2_*, 20261018040000_msgr2_rooms.sql)로 바꿔 보내고
// 결과를 옛 모양으로 돌려준다. source.mjs의 client.rpc가 여기 이름이면 이 함수로 보낸다. 옛 호출 코드(App.jsx)는 그대로 둔다.
// c = { call(name, args) → { data, error }, personal() → 내 개인 공간 id, roomsOf(space) → 방 id 목록, forget(space), inviteSpace: Map(초대 id → 공간) }.
// 오류는 서버 원문(msgr2_…)을 그대로 넘긴다 — 사람이 읽는 문구는 v2/errors.mjs(friendlyErr가 부른다).

const done = (data) => ({ data, error: null, status: 200 });
const pass = async (r, map) => (r.error ? r : done(map(r.data)));
const roomKind = (k) => (k === 'public' ? 'open' : 'private');
const dmTitle = (name) => String(name ?? '').replace(/^dm:/, '').trim().slice(0, 80);

/** 옛 초대 행 모양(invite-flow.mjs·OrgCard가 읽는 열). 거절된 초대는 취소된 것으로 본다(목록에서 숨김). */
export function legacyInvite(i) {
  const gone = i.state === 'revoked' || i.state === 'declined';
  return { id: i.id, code: i.code, role: i.role, channel_ids: i.room_ids ?? [], expires_at: i.expires_at ?? null, max_uses: i.max_uses ?? null,
    use_count: i.use_count ?? 0, revoked_at: gone ? (i.created_at ?? new Date(0).toISOString()) : null, accepted_at: null, for_node: false,
    guest_days: i.guest_days ?? null, created_by: i.created_by ?? null, created_at: i.created_at ?? null, target_user_id: i.target_user_id ?? null, _v2: true };
}

/** 받는 쪽 미리보기(옛 msgr_invite_preview 모양 — InvitePreview가 읽는 열). 이미 멤버면 상태를 already_member로. */
export function legacyPreview(p) {
  if (!p) return p;
  return { state: p.state === 'valid' && p.already_member ? 'already_member' : p.state, org_id: p.space_id ?? null, org_name: p.space_name ?? '',
    role: p.role ?? null, inviter_name: p.inviter_name ?? null, expires_at: p.expires_at ?? null,
    channels: (p.rooms ?? []).map((r) => ({ id: r.id, name: r.name, kind: 'public' })), _v2: true };
}

export const LEGACY_RPCS = {
  // 신고(사람 글·에이전트 명의 글 — 시스템 글·내 글은 서버가 거절)
  msgr_report_message: (c, a) => c.call('msgr2_report_message', { p_message: a.msg, p_reason: a.reason ?? null }),
  // 팀 공간의 방·1:1 만들기. 옛 dm(사람 한 명) → 팀 1:1(짝당 하나), 그 밖의 dm(여럿·에이전트) → 비공개 방
  async msgr_create_channel(c, a) {
    const others = a.others ?? []; const users = others.filter((o) => o.kind === 'user').map((o) => o.id); const agents = others.filter((o) => o.kind === 'crew').map((o) => o.id);
    const r = a.kind === 'dm' && users.length === 1 && !agents.length
      ? await pass(await c.call('msgr2_dm_open', { p_user: users[0], p_space: a.org }), (d) => d?.room_id ?? null)
      : await c.call('msgr2_room_create', { p_space: a.org, p_kind: a.kind === 'dm' ? 'private' : roomKind(a.kind), p_name: a.kind === 'dm' ? dmTitle(a.name) : a.name, p_users: users, p_agents: agents });
    if (!r.error) c.forget(a.org);
    return r;
  },
  msgr_join_channel: async (c, a) => { const r = await c.call('msgr2_room_join', { p_room: a.ch }); return r.error ? r : done(r.data ? 'joined' : 'already'); },
  msgr_browse_channels: async (c, a) => pass(await c.call('msgr2_rooms_browse', { p_space: a.org, p_include_joined: false }), (rows) => (rows ?? []).map((x) => ({ ...x, kind: 'public', topic: null }))),
  msgr_leave_dm: (c, a) => c.call('msgr2_room_leave', { p_room: a.ch }),
  // 개인 공간: 친구 1:1(짝당 하나)·내 에이전트 1:1·여러 사람 방(비공개)
  msgr_dm_personal: async (c, a) => { const r = await pass(await c.call('msgr2_dm_open', { p_user: a.target }), (d) => d?.room_id ?? null); if (!r.error) c.forget(await c.personal()); return r; },
  msgr_dm_personal_crew: async (c, a) => { const r = await pass(await c.call('msgr2_agent_dm_open', { p_agent: a.crew }), (d) => d?.room_id ?? null); if (!r.error) c.forget(await c.personal()); return r; },
  msgr_dm_personal_group: async (c, a) => { const r = await c.call('msgr2_room_create', { p_space: null, p_kind: 'private', p_name: dmTitle(a.title), p_users: a.targets ?? [] }); if (!r.error) c.forget(await c.personal()); return r; },
  // 에이전트 넣기·빼기(내 에이전트만, 팀은 그 공간에 자리가 있어야 — 서버 _msgr2_room_add_agent). 옛 반환 'joined' | 'already'
  msgr_crew_join: async (c, a) => pass(await c.call('msgr2_room_members_add', { p_room: a.ch, p_users: [], p_agents: [a.crew] }), (n) => (n > 0 ? 'joined' : 'already')),
  msgr_crew_leave_channel: async (c, a) => pass(await c.call('msgr2_room_member_remove', { p_room: a.ch, p_kind: 'agent', p_member: a.crew }), (ok) => (ok ? 'left' : 'not_member')),
  // 안 읽음: 옛 org null = 개인 공간. v2 p_space null은 모든 공간이라 개인 공간 id를 넘긴다. 사람 멘션은 v2에 없어 mention 0
  async msgr_unread(c, a) {
    const space = a?.org ?? await c.personal();
    if (!space) return done([]);
    return pass(await c.call('msgr2_unread', { p_space: space }), (rows) => (rows ?? []).map((x) => ({ channel_id: x.room_id, n: x.n ?? 0, mention: 0, muted: !!x.muted })));
  },
  // 공간별 합계(음소거 제외 — 옛 msgr_unread_totals와 같은 규칙). 개인 공간은 org_id null
  async msgr_unread_totals(c) {
    const [r, personal] = [await c.call('msgr2_unread', {}), await c.personal()];
    if (r.error) return r;
    const sum = new Map();
    for (const x of r.data ?? []) { if (x.muted || !x.n) continue; const k = x.space_id === personal ? null : x.space_id; sum.set(k, (sum.get(k) ?? 0) + x.n); }
    return done([...sum].map(([org_id, n]) => ({ org_id, n, mention: 0 })));
  },
  // 채팅·채널 탭의 본문 찾기: 맞은 방 id만(옛 모양 [{channel_id}]). 서버 검색은 공간을 가리지 않아 이 공간의 방으로 거른다
  async msgr_tab_search(c, a) {
    const space = a?.org ?? await c.personal();
    const [r, rooms] = [await c.call('msgr2_search', { p_q: a?.q ?? '', p_limit: 50 }), new Set(space ? await c.roomsOf(space) : [])];
    if (r.error) return r;
    const ids = new Set([...(r.data?.messages ?? []).map((m) => m.room_id), ...(r.data?.rooms ?? []).map((x) => x.id)].filter((id) => rooms.has(id)));
    return done([...ids].map((channel_id) => ({ channel_id })));
  },
  // 초대: 미리보기·받기·취소·새 링크로 바꾸기
  msgr_invite_preview: async (c, a) => pass(await c.call('msgr2_invite_preview', { p_code: a.code }), legacyPreview),
  msgr_accept_invite_v2: async (c, a) => {
    const r = await c.call('msgr2_invite_accept', { p_code: a.code });
    if (r.error) return r;
    c.forget(r.data?.space_id);
    const rooms = r.data?.rooms ?? [];
    return done({ org_id: r.data?.space_id ?? null, channel_id: rooms[0] ?? null, joined_channel_ids: rooms, skipped_channel_ids: [] });
  },
  msgr_invite_revoke: async (c, a) => { const r = await c.call('msgr2_invite_revoke', { p_invite: a.invite }); return r.error ? r : r.data ? done(true) : { data: null, error: { message: 'msgr_invite_not_found' }, status: 400 }; },
  // 남긴 링크(keep)와 같은 역할의 다른 링크 초대를 취소한다(사람 지정 초대는 그대로)
  async msgr_invite_replace(c, a) {
    const space = c.inviteSpace.get(a.keep);
    if (!space) return { data: null, error: { message: 'msgr_invite_not_found' }, status: 400 };
    const l = await c.call('msgr2_invites_list', { p_space: space });
    if (l.error) return l;
    const keep = (l.data ?? []).find((i) => i.id === a.keep);
    for (const i of l.data ?? []) {
      if (i.id === a.keep || i.state !== 'valid' || i.target_user_id || i.role !== keep?.role) continue;
      const r = await c.call('msgr2_invite_revoke', { p_invite: i.id });
      if (r.error) return r;
    }
    return done(true);
  },
};

/** 옛 초대 행(쓰기) → msgr2_invite_create 인자. 만료 시각은 초로(서버 범위 60초~1년), 옛 앱 기본 1회. */
export function inviteArgs(row, now = Date.now()) {
  const exp = row.expires_at == null ? (row.expires_at === null ? null : 604800) : Math.round((Date.parse(row.expires_at) - now) / 1000);
  return { p_space: row.org_id, p_role: row.role ?? 'member', p_user: null, p_rooms: row.channel_ids ?? (row.channel_id ? [row.channel_id] : []),
    p_max_uses: row.max_uses === undefined ? 1 : row.max_uses, p_expires_in_s: exp == null ? null : Math.min(31536000, Math.max(60, exp)),
    p_guest_days: row.role === 'guest' ? (row.guest_days ?? 30) : null };
}
