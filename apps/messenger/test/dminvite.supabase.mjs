// Browser-only fixture: no credentials or production client imported.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const asMember = new URLSearchParams(location.search).get('role') === 'member';
const withVacated = new URLSearchParams(location.search).get('vacated') === '1'; // D35: 상대가 모두 빠진 대화 // 방장이 아닌 참여자 시점(2026-09-16 에이전트 참여 승인)
const channel = (id, kind, name, orgId = org) => ({ id, org_id: orgId, kind, name, created_by: asMember ? 'user-colleague' : uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: orgId ? 'approval' : 'blocked' });
const state = window.__dmInviteFixture = { calls: [], failNext: null, broadcasts: {}, channelNames: [], tables: {
  msgr_org_members: [
    { user_id: uid, org_id: org, role: asMember ? 'member' : 'owner', display_name: 'Fixture Owner', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
    { user_id: 'user-colleague', org_id: org, role: 'member', display_name: 'Org Colleague', removed_at: null },
    { user_id: 'user-third', org_id: org, role: 'member', display_name: 'Third Person', removed_at: null },
  ],
  msgr_channels: [...(withVacated ? [channel('left-dm', 'dm', 'dm:Gone Person'), channel('left-group', 'dm', 'dm:Gone Person With A Rather Long Display Name, Fixture Agent'), channel('agent-dm', 'dm', 'dm:Fixture Agent'), channel('renamed-dm', 'dm', 'dm:Old Agent Name'), channel('widened-dm', 'dm', 'dm:Third Person'), channel('owner-left', 'dm', 'dm:Colleague Agent'), channel('people-minus', 'dm', 'dm:Third Person, Gone Person'), channel('gone-widened', 'dm', 'dm:Departed Person')] : []), channel('general', 'public', 'Fixture General'), channel('open-2', 'public', 'Open Lounge'), channel('org-dm', 'dm', 'dm:Org Colleague'), channel('group-dm', 'dm', 'dm:여럿'), ...Array.from({ length: 12 }, (_, i) => channel(`fold-${i + 1}`, 'private', `Folder Room ${i + 1}`))],
  msgr_crews: [
    { id: 'crew-1', org_id: org, owner_user_id: uid, slug: 'fixture-crew', display_name: 'Fixture Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' },
    { id: 'crew-3', org_id: org, owner_user_id: uid, slug: 'second-crew', display_name: 'Second Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' }, // 일괄 추가 대상 둘째(유건 2026-09-17)
    { id: 'crew-2', org_id: org, owner_user_id: 'user-colleague', slug: 'colleague-crew', display_name: 'Colleague Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' }, // 다른 멤버의 크루 — 레일에 나오면 안 된다
    { id: 'crew-bot', org_id: org, owner_user_id: 'user-colleague', slug: 'bot-crew', display_name: 'External Bot', hosting: 'bot', status: 'active', last_seen_at: now, created_at: now, allow: 'all' }, // 외부 에이전트 — 남는다
  ],
  msgr_channel_members: [
    // D35 판정 표: R1 left-dm·R2 left-group·R6 widened-dm·조직을 떠난 상대의 R6 gone-widened(크루가 나중에 들어옴)·남의 크루만 남은 owner-left = 나간 대화 / R3 agent-dm·크루 이름 바뀐 renamed-dm·R5 people-minus = 표지 없음
    ...(withVacated ? [{ channel_id: 'left-dm', member_kind: 'user', member_id: uid }, { channel_id: 'left-group', member_kind: 'user', member_id: uid }, { channel_id: 'left-group', member_kind: 'crew', member_id: 'crew-1' }, { channel_id: 'agent-dm', member_kind: 'user', member_id: uid }, { channel_id: 'agent-dm', member_kind: 'crew', member_id: 'crew-1' }, { channel_id: 'renamed-dm', member_kind: 'user', member_id: uid, added_at: '2026-09-01T00:00:00Z' }, { channel_id: 'renamed-dm', member_kind: 'crew', member_id: 'crew-3', added_at: '2026-09-01T00:00:00Z' }, { channel_id: 'gone-widened', member_kind: 'user', member_id: uid, added_at: '2026-09-01T00:00:00Z' }, { channel_id: 'gone-widened', member_kind: 'crew', member_id: 'crew-1', added_at: '2026-09-02T00:00:00Z' }, { channel_id: 'widened-dm', member_kind: 'user', member_id: uid }, { channel_id: 'widened-dm', member_kind: 'crew', member_id: 'crew-1' }, { channel_id: 'owner-left', member_kind: 'user', member_id: uid }, { channel_id: 'owner-left', member_kind: 'crew', member_id: 'crew-2' }, { channel_id: 'people-minus', member_kind: 'user', member_id: uid }, { channel_id: 'people-minus', member_kind: 'user', member_id: 'user-third' }] : []),
    { channel_id: 'general', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: 'user-colleague' },
    // 여럿이 있는 방 — 에이전트 둘, 사람 둘. 아바타가 누구 한 사람 것으로 굳으면 안 된다.
    { channel_id: 'group-dm', member_kind: 'user', member_id: uid },
    { channel_id: 'group-dm', member_kind: 'user', member_id: 'user-colleague' },
    { channel_id: 'group-dm', member_kind: 'user', member_id: 'user-third' },
    { channel_id: 'group-dm', member_kind: 'crew', member_id: 'crew-1' },
    { channel_id: 'group-dm', member_kind: 'crew', member_id: 'crew-bot' },
    ...Array.from({ length: 12 }, (_, i) => ({ channel_id: `fold-${i + 1}`, member_kind: 'user', member_id: uid })),
  ],
  msgr_messages: [
    { id: 21, channel_id: 'open-2', org_id: org, author_kind: 'user', author_user_id: 'user-colleague', crew_id: null, kind: 'text', body: 'Lounge note for everyone', created_at: now, deleted_at: null, mentions: [], reply_to: null, client_msg_id: 'm21' }, // 참여하지 않은 공개 채널의 글
    { id: 11, channel_id: 'general', org_id: org, author_kind: 'user', author_user_id: 'user-colleague', crew_id: null, kind: 'text', body: '스크린샷 붙입니다', created_at: now, deleted_at: null, mentions: [], reply_to: null, client_msg_id: 'm11' },
  ],
  msgr_attachments: [
    { id: 'att-1', message_id: 11, channel_id: 'general', org_id: org, name: 'shot.png', mime: 'image/png', bytes: 1024, storage_path: `${org}/general/11/shot.png` },
  ],
  msgr_channel_crew_requests: asMember ? [] : [{ id: 'req-1', channel_id: 'general', crew_id: 'crew-2', requested_by: 'user-colleague', status: 'pending', created_at: now }],
  msgr_target_prefs: [], msgr_channel_prefs: Array.from({ length: 12 }, (_, i) => ({ user_id: uid, channel_id: `fold-${i + 1}`, muted: false, pinned: false, pin_pos: null, folder: `Group ${String(i + 1).padStart(2, '0')}` })),
  // Friends fixture
  msgr_friends: [
    { user_id: 'user-alice', status: 'accepted', requested_by: uid, display_name: 'Alice Friend', handle: 'alice', created_at: now },
    { user_id: 'user-bob', status: 'pending', requested_by: 'user-bob', display_name: 'Bob Pending', handle: 'bob', created_at: now },
  ],
  // Personal DMs fixture
  msgr_personal_list: [
    { channel_id: 'pdm-alice', other_user_id: 'user-alice', last_at: now, last_body: 'Hello from personal' },
  ],
  msgr_personal_channels: [channel('pdm-alice', 'dm', 'dm:Alice Friend', null)],
  msgr_personal_members: [
    { channel_id: 'pdm-alice', member_kind: 'user', member_id: uid },
    { channel_id: 'pdm-alice', member_kind: 'user', member_id: 'user-alice' },
  ],
}};

function result(call, action) {
  state.calls.push(structuredClone(call));
  if (state.failNext === `${call.table || call.rpc}:${call.op || 'rpc'}`) { state.failNext = null; return { data: null, error: { message: 'Fixture temporary failure.' } }; }
  return { data: action(), error: null };
}

function query(table) {
  let op = 'select', values, cols = '*', one = false;
  const filters = [];
  const api = {
    select(c = '*') { cols = c; return api; }, eq(k, v) { filters.push(r => r[k] === v); return api; }, neq(k, v) { filters.push(r => r[k] !== v); return api; }, is(k, v) { filters.push(r => (r[k] ?? null) === v); return api; },
    in(k, vs) { filters.push(r => vs.includes(r[k])); return api; }, gt(k, v) { filters.push(r => r[k] > v); return api; }, lt(k, v) { filters.push(r => r[k] < v); return api; },
    order() { return api; }, limit() { return api; }, contains() { return api; }, or() { return api; }, ilike() { return api; }, maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    upsert(v) { op = 'upsert'; values = v; return api; }, update(v) { op = 'update'; values = v; return api; }, delete() { op = 'delete'; return api; }, insert(v) { op = 'insert'; values = v; return api; },
    then(resolve, reject) {
      return Promise.resolve(result({ table, op, values }, () => {
        const all = state.tables[table] ?? [];
        let rows = all.filter(r => filters.every(f => f(r)));
        if (op === 'upsert' || op === 'insert') {
          rows = (Array.isArray(values) ? values : [values]).map(v => {
            const keys = table === 'msgr_target_prefs' ? ['user_id', 'org_id', 'target_kind', 'target_id'] : table === 'msgr_channel_members' ? ['channel_id', 'member_kind', 'member_id'] : ['user_id', 'channel_id']; // 실제 onConflict와 같은 키 — 종전 키는 채널의 첫 행을 덮어썼다
            const old = op === 'upsert' ? all.find(r => keys.every(k => r[k] === v[k])) : null;
            if (old) { Object.assign(old, v); return old; } const row = { ...v }; all.push(row); return row;
          });
        } else if (op === 'update') rows.forEach(r => Object.assign(r, values));
        else if (op === 'delete') state.tables[table] = all.filter(r => !rows.includes(r));
        if (table === 'msgr_channel_members' && cols.includes('msgr_channels')) rows = rows.map(r => ({ ...r, msgr_channels: [...(state.tables.msgr_channels || []), ...(state.tables.msgr_personal_channels || [])].find(c => c.id === r.channel_id) }));
        // 실제 PostgREST처럼 요청한 열만 돌려준다 — 가져오지 않은 열(org_id 등)에 기대는 코드가 픽스처에서만 통과하지 않게(2026-09-16 실사고)
        if (op === 'select' && cols !== '*' && !cols.includes('(')) { const keep = cols.split(',').map((c) => c.trim()); rows = rows.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]]))); }
        return structuredClone(one ? rows[0] ?? null : rows);
      })).then(resolve, reject);
    },
  };
  return api;
}

export const supabase = {
  from: query,
  auth: { getSession: async () => ({ data: { session: { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name, args) => result({ rpc: name, args }, () => {
    if (name === 'msgr_my_friends') return structuredClone(state.tables.msgr_friends);
    if (name === 'msgr_dm_personal_list') return structuredClone(state.tables.msgr_personal_list);
    if (name === 'msgr_dm_personal') {
      // Return existing personal DM or create one
      const existing = state.tables.msgr_personal_list.find(r => r.other_user_id === args.target);
      if (existing) return existing.channel_id;
      const id = `pdm-${Date.now()}`;
      const friend = state.tables.msgr_friends.find(f => f.user_id === args.target && f.status === 'accepted');
      if (!friend) throw new Error('msgr_not_friend');
      state.tables.msgr_personal_list.push({ channel_id: id, other_user_id: args.target, last_at: new Date().toISOString(), last_body: '' });
      state.tables.msgr_personal_channels.push(channel(id, 'dm', `dm:${friend.display_name}`, null));
      state.tables.msgr_personal_members.push({ channel_id: id, member_kind: 'user', member_id: uid }, { channel_id: id, member_kind: 'user', member_id: args.target });
      return id;
    }
    if (name === 'msgr_create_channel') {
      const id = `created-${state.tables.msgr_channels.length}`;
      state.tables.msgr_channels.push(channel(id, args.kind, args.name));
      state.tables.msgr_channel_members.push({ channel_id: id, member_kind: 'user', member_id: uid }, ...args.others.map(m => ({ channel_id: id, member_kind: m.kind, member_id: m.id })));
      return id;
    }
    if (name === 'msgr_unread') return [];
    if (name === 'msgr_joinable_orgs') return [];
    if (name === 'msgr_my_deleted_orgs') return [];
    if (name === 'msgr_friend_request') return 'friend';
    if (name === 'msgr_dm_latest') return [];
    if (name === 'msgr_browse_channels') {
      const joined = new Set(state.tables.msgr_channel_members.filter((m) => m.member_kind === 'user' && m.member_id === uid).map((m) => m.channel_id));
      return state.tables.msgr_channels.filter((c) => c.kind === 'public' && !joined.has(c.id)).map((c) => ({ id: c.id, name: c.name, topic: null, members: 1, created_at: now }));
    }
    if (name === 'msgr_join_channel') { state.tables.msgr_channel_members.push({ channel_id: args.ch, member_kind: 'user', member_id: uid }); return true; }
    if (name === 'msgr_crew_join') {
      const members = state.tables.msgr_channel_members;
      if (members.some((m) => m.channel_id === args.ch && m.member_kind === 'crew' && m.member_id === args.crew)) return 'already';
      const ch = state.tables.msgr_channels.find((c) => c.id === args.ch);
      if (!asMember || ch?.kind === 'dm') { members.push({ channel_id: args.ch, member_kind: 'crew', member_id: args.crew }); return 'joined'; }
      state.tables.msgr_channel_crew_requests.push({ id: `req-${Date.now()}`, channel_id: args.ch, crew_id: args.crew, requested_by: uid, status: 'pending', created_at: new Date().toISOString() });
      return 'requested';
    }
    if (name === 'msgr_crew_join_decide') {
      const r = state.tables.msgr_channel_crew_requests.find((x) => x.id === args.req);
      if (!r || r.status !== 'pending') throw new Error('msgr_request_closed');
      r.status = args.approve ? 'approved' : 'rejected';
      if (args.approve) state.tables.msgr_channel_members.push({ channel_id: r.channel_id, member_kind: 'crew', member_id: r.crew_id });
      return r.status;
    }
    if (name === 'msgr_push_badge_resync') return null;
    return [];
  }),
  realtime: { setAuth: async () => {} },
  channel: (name) => {
    const c = { on: (kind, filter, cb) => { if (kind === 'broadcast') (state.broadcasts[filter?.event] ??= []).push(cb); return c; }, subscribe: (cb) => { cb?.('SUBSCRIBED'); return c; }, send: async () => {}, unsubscribe: async () => {} };
    state.channelNames.push(name);
    return c;
  },
  removeChannel: async () => 'ok', removeAllChannels: async () => {},
  storage: { from: () => ({
    remove: async () => ({ data: [], error: null }),
    // 라이트박스 테스트용 — 실제 스토리지 없이 그릴 수 있는 1×1 png
    createSignedUrl: async () => ({ data: { signedUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }, error: null }),
  }) },
};

export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

// 테스트가 방송을 흉내 낸다 — 앱의 알림 경로(본문 보충 포함)를 실제로 태운다.
window.__dmInviteBroadcast = (event, payload) => { for (const cb of state.broadcasts[event] ?? []) cb({ payload }); };
