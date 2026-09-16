// Browser-only fixture: no credentials or production client imported.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const channel = (id, kind, name, orgId = org) => ({ id, org_id: orgId, kind, name, created_by: uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: orgId ? 'allowed' : 'blocked' });
const state = window.__ux3Fixture = { calls: [], failNext: null, broadcasts: {}, channelNames: [], tables: {
  msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: 'Fixture Owner', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } }],
  msgr_channels: [channel('general', 'public', 'Fixture General'), channel('org-dm', 'dm', 'dm:Org Colleague')],
  msgr_crews: [
    { id: 'crew-1', org_id: org, owner_user_id: uid, slug: 'fixture-crew', display_name: 'Fixture Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' },
    { id: 'crew-2', org_id: org, owner_user_id: 'user-colleague', slug: 'colleague-crew', display_name: 'Colleague Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' }, // 다른 멤버의 크루 — 레일에 나오면 안 된다
    { id: 'crew-bot', org_id: org, owner_user_id: 'user-colleague', slug: 'bot-crew', display_name: 'External Bot', hosting: 'bot', status: 'active', last_seen_at: now, created_at: now, allow: 'all' }, // 외부 에이전트 — 남는다
  ],
  msgr_channel_members: [
    { channel_id: 'general', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: 'user-colleague' },
  ],
  msgr_messages: [
    { id: 11, channel_id: 'general', org_id: org, author_kind: 'user', author_user_id: 'user-colleague', crew_id: null, kind: 'text', body: '스크린샷 붙입니다', created_at: now, deleted_at: null, mentions: [], reply_to: null, client_msg_id: 'm11' },
  ],
  msgr_attachments: [
    { id: 'att-1', message_id: 11, channel_id: 'general', org_id: org, name: 'shot.png', mime: 'image/png', bytes: 1024, storage_path: `${org}/general/11/shot.png` },
  ],
  msgr_target_prefs: [], msgr_channel_prefs: [],
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
            const keys = table === 'msgr_target_prefs' ? ['user_id', 'org_id', 'target_kind', 'target_id'] : ['user_id', 'channel_id'];
            const old = op === 'upsert' ? all.find(r => keys.every(k => r[k] === v[k])) : null;
            if (old) { Object.assign(old, v); return old; } const row = { ...v }; all.push(row); return row;
          });
        } else if (op === 'update') rows.forEach(r => Object.assign(r, values));
        else if (op === 'delete') state.tables[table] = all.filter(r => !rows.includes(r));
        if (table === 'msgr_channel_members' && cols.includes('msgr_channels')) rows = rows.map(r => ({ ...r, msgr_channels: [...(state.tables.msgr_channels || []), ...(state.tables.msgr_personal_channels || [])].find(c => c.id === r.channel_id) }));
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
window.__ux3Broadcast = (event, payload) => { for (const cb of state.broadcasts[event] ?? []) cb({ payload }); };
