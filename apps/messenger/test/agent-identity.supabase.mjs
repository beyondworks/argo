// Browser-only fixture: no credentials or production client imported.
// 에이전트 = 한 사람(유건 2026-10-05) 화면 확인용 — personal-space 픽스처에 같은 에이전트(페퍼)의 조직 행(주황 얼굴 저장)·개인 행(저장값 없음)과
// #819 전에 만든 옛 조직 1:1 방(나 + 조직 행 페퍼)을 더했다. 띄우기: npx vite --config test/agent-identity.config.mjs (AI_TEST_PORT, 기본 5288)
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const noFace = localStorage.getItem('aiFixtureNoFace') === '1'; // 검수 #3: 페퍼가 얼굴을 저장한 적 없을 때 — 로그인 뒤 대표 행 얼굴을 한 번 저장하는지(window.__psFixture.calls의 msgr_crews update)
const channel = (id, kind, name, orgId = org) => ({ id, org_id: orgId, kind, name, created_by: uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: orgId ? 'allowed' : 'blocked' });
const state = window.__psFixture = { calls: [], failNext: null, aiConsent: localStorage.getItem('psFixtureAiConsent') === 'none' ? null : undefined, tables: { // aiConsent: 시나리오가 동의 전 상태를 볼 때 'none'
  msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: 'Fixture Owner', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
    { user_id: 'user-colleague', org_id: org, role: 'member', display_name: 'Org Colleague', removed_at: null }], // 조직원이면서 친구 — 개인 공간에서는 조직 DM이 아니라 개인 1:1로 가야 한다
  msgr_channels: [channel('general', 'public', 'Fixture General'), channel('org-dm', 'dm', 'dm:Org Colleague'), channel('org-pepper-dm', 'dm', 'dm:페퍼')],
  msgr_crews: [{ id: 'crew-1', org_id: org, owner_user_id: uid, slug: 'fixture-crew', display_name: 'Fixture Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' },
    { id: 'crew-pepper-org', org_id: org, owner_user_id: uid, ws_id: 'ws-a', slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', hosting: 'local', status: 'active', last_seen_at: now, created_at: '2026-09-01T00:00:00+00:00', allow: 'owner', face: noFace ? null : { v: 2, shape: 8, color: 9 }, avatar_url: null },
    { id: 'pcrew-pepper', org_id: null, owner_user_id: uid, ws_id: 'ws-a', slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', hosting: 'local', status: 'active', last_seen_at: now, created_at: '2026-10-01T00:00:00+00:00', allow: 'owner', face: null, avatar_url: null }],
  msgr_channel_members: [
    { channel_id: 'general', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: 'user-colleague' },
    { channel_id: 'org-pepper-dm', member_kind: 'user', member_id: uid }, { channel_id: 'org-pepper-dm', member_kind: 'crew', member_id: 'crew-pepper-org' }, // 옛 조직 1:1
  ],
  msgr_messages: [],
  msgr_channel_crew_requests: [{ id: 'req-alice', channel_id: 'pdm-alice', crew_id: 'pcrew-alice2', requested_by: 'user-alice', status: 'pending' }], // 친구가 자기 에이전트를 1:1에 넣겠다고 요청(승인자 = 방을 연 나)
  msgr_target_prefs: [], msgr_channel_prefs: [],
  // Friends fixture
  msgr_friends: [
    { user_id: 'user-alice', status: 'accepted', requested_by: uid, display_name: 'Alice Friend', handle: 'alice', created_at: now },
    { user_id: 'user-colleague', status: 'accepted', requested_by: uid, display_name: 'Org Colleague', handle: 'colleague', created_at: now },
    { user_id: 'user-bob', status: 'pending', requested_by: 'user-bob', display_name: 'Bob Pending', handle: 'bob', created_at: now },
  ],
  // Personal DMs fixture
  msgr_personal_list: [
    { channel_id: 'pdm-alice', other_user_id: 'user-alice', last_at: now, last_body: 'Hello from personal', crews: [{ id: 'pcrew-alice', name: "Alice's Agent", owner_user_id: 'user-alice' }] }, // 친구가 이 방에 넣은 친구 에이전트
  ],
  // 개인 공간 에이전트(2026-09-30): 내 개인 크루 + 방 안의 친구 크루(표시용 — 내 목록·추가 후보에는 나오면 안 된다)
  msgr_personal_room_crews: [
    { id: 'pcrew-mine', org_id: null, slug: 'mine', display_name: 'My Agent', owner_user_id: uid, hosting: 'local', status: 'active', last_seen_at: now },
    { id: 'pcrew-pepper', org_id: null, slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', owner_user_id: uid, hosting: 'local', status: 'active', last_seen_at: now, face: null, avatar_url: null },
    { id: 'pcrew-alice', org_id: null, slug: 'alice-agent', display_name: "Alice's Agent", owner_user_id: 'user-alice', hosting: 'local', status: 'active', last_seen_at: now },
    // 개인 공간 봇 쌍둥이(2026-10-01) — 같은 에이전트를 두 조직에 연결(조직 이름 라벨), 하나는 다른 관리자가 토큰을 바꿔 '다시 연결 필요'
    { id: 'ptwin-lean', org_id: null, slug: 'bot-aaaaaaaaaaaa', display_name: 'Hermes', owner_user_id: uid, hosting: 'bot', status: 'active', last_seen_at: now, bot_kind: 'hermes', org_label: 'Lean', ready: true },
    { id: 'ptwin-lean2', org_id: null, slug: 'bot-bbbbbbbbbbbb', display_name: 'Hermes', owner_user_id: uid, hosting: 'bot', status: 'active', last_seen_at: now, bot_kind: 'hermes', org_label: 'Lean2', ready: false, paused: 'relink' },
    { id: 'ptwin-old', org_id: null, slug: 'bot-cccccccccccc', display_name: 'OpenClaw', owner_user_id: uid, hosting: 'bot', status: 'active', last_seen_at: now, bot_kind: 'openclaw', org_label: null, ready: false, paused: 'left_org' }, // 주인이 조직을 나감(유건 결정 10/1)
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
  try { return { data: action(), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; } // 서버 오류는 supabase-js처럼 error로 돌려준다
}

function query(table) {
  let op = 'select', values, cols = '*', one = false;
  const filters = [], eqs = []; // eqs: 호출 기록에 남기는 등호 조건(가상 조직 id가 서버로 새는지 검사)
  const api = {
    select(c = '*') { cols = c; return api; }, eq(k, v) { eqs.push([k, v]); filters.push(r => r[k] === v); return api; }, neq(k, v) { filters.push(r => r[k] !== v); return api; }, is(k, v) { filters.push(r => (r[k] ?? null) === v); return api; },
    in(k, vs) { filters.push(r => vs.includes(r[k])); return api; }, gt(k, v) { filters.push(r => r[k] > v); return api; }, lt(k, v) { filters.push(r => r[k] < v); return api; },
    order() { return api; }, limit() { return api; }, contains() { return api; }, or() { return api; }, ilike() { return api; }, maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    upsert(v) { op = 'upsert'; values = v; return api; }, update(v) { op = 'update'; values = v; return api; }, delete() { op = 'delete'; return api; }, insert(v) { op = 'insert'; values = v; return api; },
    then(resolve, reject) {
      return Promise.resolve(result({ table, op, values, eqs }, () => {
        const all = table === 'msgr_channel_members' && op === 'select' // 개인 방 구성원(사람·크루)도 같은 표로 보인다 — 서버와 같게
          ? [...(state.tables.msgr_channel_members ?? []), ...(state.tables.msgr_personal_members ?? []), ...state.tables.msgr_personal_list.flatMap((r) => [
              ...(r.crew_dm ? [{ channel_id: r.channel_id, member_kind: 'user', member_id: uid }] : []),
              ...(r.crews ?? []).map((c) => ({ channel_id: r.channel_id, member_kind: 'crew', member_id: c.id }))])]
          : state.tables[table] ?? [];
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
    if (name === 'msgr_dm_personal_list') return structuredClone(state.tables.msgr_personal_list.filter((r) => args?.include_groups || !r.is_group)); // 서버와 같게 — 인자 없는 옛 앱은 1:1만
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
    if (name === 'msgr_dm_personal_group') { // 친구 여럿과 조직 밖 그룹 방(유건 2026-09-17) — 서버 판정(친구만·두 명 이상)을 흉내
      const friends = args.targets.map((id) => state.tables.msgr_friends.find((f) => f.user_id === id && f.status === 'accepted'));
      if (args.targets.length < 2) throw new Error('msgr_bad_target');
      if (friends.some((f) => !f)) throw new Error('msgr_not_friend');
      const id = `pgrp-${Date.now()}`;
      state.tables.msgr_personal_list.unshift({ channel_id: id, other_user_id: args.targets[0], last_at: new Date().toISOString(), last_body: '', name: `dm:${args.title}`, is_group: true, created_by: uid, members: [{ id: uid, name: 'Me' }, ...friends.map((f) => ({ id: f.user_id, name: f.display_name }))] });
      return id;
    }
    if (name === 'msgr_create_channel') {
      const id = `created-${state.tables.msgr_channels.length}`;
      state.tables.msgr_channels.push(channel(id, args.kind, args.name));
      state.tables.msgr_channel_members.push({ channel_id: id, member_kind: 'user', member_id: uid }, ...args.others.map(m => ({ channel_id: id, member_kind: m.kind, member_id: m.id })));
      return id;
    }
    if (name === 'msgr_personal_room_crews') return structuredClone(state.tables.msgr_personal_room_crews);
    if (name === 'msgr_my_ai_consent') return state.aiConsent === undefined ? now : state.aiConsent; // 기본 동의함 — 시나리오가 null로 바꿔 동의 요청을 본다
    if (name === 'msgr_set_ai_consent') { state.aiConsent = args.consent ? now : null; return state.aiConsent; }
    if (name === 'msgr_dm_approver') return uid;
    if (name === 'msgr_dm_personal_crew') { // 내 개인 크루와 한 방(서버: 주인만, 한 크루 한 방)
      const c = state.tables.msgr_personal_room_crews.find((x) => x.id === args.crew && x.owner_user_id === uid);
      if (!c) throw new Error('msgr_bad_member');
      const hit = state.tables.msgr_personal_list.find((r) => r.crew_dm === c.id); if (hit) return hit.channel_id;
      const id = `pcdm-${c.id}`;
      state.tables.msgr_personal_list.unshift({ channel_id: id, other_user_id: null, last_at: new Date().toISOString(), last_body: '', crew_dm: c.id, crews: [{ id: c.id, name: c.display_name, owner_user_id: uid }], members: [{ id: uid, name: 'Me' }] });
      state.tables.msgr_personal_channels.push(channel(id, 'dm', `dm:${c.display_name}`, null));
      return id;
    }
    if (name === 'msgr_crew_join') { // 서버: 개인 방은 개인 크루만·내 것만, 무료 한도는 msgr_room_limit
      if (state.roomLimit) throw new Error('msgr_room_limit');
      const row = state.tables.msgr_personal_list.find((r) => r.channel_id === args.ch);
      const c = state.tables.msgr_personal_room_crews.find((x) => x.id === args.crew);
      if (!row || !c || c.owner_user_id !== uid) throw new Error('msgr_forbidden');
      if ((row.crews ?? []).some((x) => x.id === c.id)) return 'already';
      row.crews = [...(row.crews ?? []), { id: c.id, name: c.display_name, owner_user_id: c.owner_user_id }];
      return 'joined';
    }
    if (name === 'msgr_crew_join_decide') { const r = state.tables.msgr_channel_crew_requests.find((x) => x.id === args.req); if (!r) throw new Error('msgr_request_closed'); r.status = args.approve ? 'approved' : 'rejected'; return r.status; }
    if (name === 'msgr_unread') return [];
    if (name === 'msgr_joinable_orgs') return [];
    if (name === 'msgr_my_deleted_orgs') return [];
    if (name === 'msgr_find_user') return [{ user_id: 'user-newbie', display_name: 'New Person', handle: 'newbie', relation: 'none' }]; // 친구 추가 팝업(2026-09-30)
    if (name === 'msgr_friend_request') return args?.target === 'user-newbie' ? 'sent' : 'friend';
    if (name === 'msgr_dm_latest') return [];
    if (name === 'msgr_push_badge_resync') return null;
    return [];
  }),
  realtime: { setAuth: async () => {} },
  channel: () => { const c = { on: () => c, subscribe: () => c, send: async () => {}, unsubscribe: async () => {} }; return c; },
  removeChannel: async () => 'ok', removeAllChannels: async () => {},
  storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
};

export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
