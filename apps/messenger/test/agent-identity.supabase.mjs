// Browser-only fixture: no credentials or production client imported.
// 에이전트 = 한 사람(유건 2026-10-05) 화면 확인용 — personal-space 픽스처에 같은 에이전트(페퍼)의 조직 행(주황 얼굴 저장)·개인 행(저장값 없음)과
// #819 전에 만든 옛 조직 1:1 방(나 + 조직 행 페퍼)을 더했다. 띄우기: npx vite --config test/agent-identity.config.mjs (AI_TEST_PORT, 기본 5288)
// 옛 방에는 글 3개(검수 #2: 개인 1:1 위 '이전 대화 보기'), localStorage aiFixtureLegacyUnread='1'이면 그중 2개가 안 읽은 글(검수 #1: 안 읽은 글이 있으면 옛 방을 연다)
// localStorage aiFixtureArchived='1'이면 옛 방을 보관한 뒤(유건 결정 2026-10-08 1-② — 마이그레이션 20261008103000) + 같은 조직의 두 번째 옛 페퍼 1:1(글 2개, 보관):
//   조직 목록에는 둘 다 없고, 개인 공간 페퍼 1:1 위 '이전 대화 보기'에 두 줄 → 누르면 읽기 전용(입력창 대신 안내, 복사만 남고 답글·반응·더보기·업무 버튼 없음)
//   첫 방은 다 읽었고(읽음 커서 3), 두 번째 방은 에이전트 글 1개를 안 읽었다 → 그 줄만 '안 읽은 글 1개'. 열면 커서를 한 번 올려(window.__psFixture.calls의 msgr_reads upsert) 돌아왔을 때 수가 사라진다
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const legacyUnread = localStorage.getItem('aiFixtureLegacyUnread') === '1';
const archivedLegacy = localStorage.getItem('aiFixtureArchived') === '1';
const ARCHIVED_AT = archivedLegacy ? '2026-10-08T01:00:00+00:00' : null;
const noFace = localStorage.getItem('aiFixtureNoFace') === '1'; // 검수 #3: 페퍼가 얼굴을 저장한 적 없을 때 — 로그인 뒤 대표 행 얼굴을 한 번 저장하는지(window.__psFixture.calls의 msgr_crews update)
const legacyMsg = (id, body, crew = false, ch = 'org-pepper-dm') => ({ id, channel_id: ch, org_id: org, author_kind: crew ? 'crew' : 'user', author_user_id: crew ? null : uid, crew_id: crew ? 'crew-pepper-org' : null, kind: 'text', body, mentions: [], reply_to: null, thread_root: null, created_at: `2026-09-2${id}T09:00:00+00:00`, edited_at: null, deleted_at: null, meta: null, client_msg_id: null });
const channel = (id, kind, name, orgId = org) => ({ id, org_id: orgId, kind, name, created_by: uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: orgId ? 'allowed' : 'blocked' });
const state = window.__psFixture = { calls: [], failNext: null, aiConsent: localStorage.getItem('psFixtureAiConsent') === 'none' ? null : undefined, tables: { // aiConsent: 시나리오가 동의 전 상태를 볼 때 'none'
  msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: 'Fixture Owner', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
    { user_id: 'user-colleague', org_id: org, role: 'member', display_name: 'Org Colleague', removed_at: null }], // 조직원이면서 친구 — 개인 공간에서는 조직 DM이 아니라 개인 1:1로 가야 한다
  msgr_channels: [channel('general', 'public', 'Fixture General'), channel('org-dm', 'dm', 'dm:Org Colleague'), { ...channel('org-pepper-dm', 'dm', 'dm:페퍼'), archived_at: ARCHIVED_AT }, ...(archivedLegacy ? [{ ...channel('org-pepper-dm-2', 'dm', 'dm:페퍼'), archived_at: ARCHIVED_AT }] : [])],
  msgr_crews: [{ id: 'crew-1', org_id: org, owner_user_id: uid, slug: 'fixture-crew', display_name: 'Fixture Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' },
    { id: 'crew-pepper-org', org_id: org, owner_user_id: uid, ws_id: 'ws-a', slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', hosting: 'local', status: 'active', last_seen_at: now, created_at: '2026-09-01T00:00:00+00:00', allow: 'owner', face: noFace ? null : { v: 2, shape: 8, color: 9 }, avatar_url: null },
    { id: 'pcrew-pepper', org_id: null, owner_user_id: uid, ws_id: 'ws-a', slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', hosting: 'local', status: 'active', last_seen_at: now, created_at: '2026-10-01T00:00:00+00:00', allow: 'owner', face: null, avatar_url: null }],
  msgr_channel_members: [
    { channel_id: 'general', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: uid },
    { channel_id: 'org-dm', member_kind: 'user', member_id: 'user-colleague' },
    { channel_id: 'org-pepper-dm', member_kind: 'user', member_id: uid }, { channel_id: 'org-pepper-dm', member_kind: 'crew', member_id: 'crew-pepper-org' }, // 옛 조직 1:1
    ...(archivedLegacy ? [{ channel_id: 'org-pepper-dm-2', member_kind: 'user', member_id: uid }, { channel_id: 'org-pepper-dm-2', member_kind: 'crew', member_id: 'crew-pepper-org' }] : []), // 같은 쌍의 두 번째 옛 방(운영 실측 모양)
  ],
  msgr_messages: [legacyMsg(1, '지난주 보고서 정리해 줘'), legacyMsg(2, '정리했습니다 — 요약은 아래에', true), legacyMsg(3, '오늘 회의 안건도 올려 두었습니다', true),
    ...(archivedLegacy ? [legacyMsg(4, '바버샵 예약 30분 전에 알려 줘', false, 'org-pepper-dm-2'), legacyMsg(5, '예약 시간 30분 전에 알려 드릴게요', true, 'org-pepper-dm-2')] : [])],
  msgr_channel_crew_requests: [{ id: 'req-alice', channel_id: 'pdm-alice', crew_id: 'pcrew-alice2', requested_by: 'user-alice', status: 'pending' }], // 친구가 자기 에이전트를 1:1에 넣겠다고 요청(승인자 = 방을 연 나)
  msgr_target_prefs: [], msgr_channel_prefs: [],
  msgr_reads: archivedLegacy ? [{ channel_id: 'org-pepper-dm', user_id: uid, last_read_id: 3, updated_at: now }] : [], // 보관 방 안 읽은 수(이전 대화 보기 줄)
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
  let op = 'select', values, cols = '*', one = false, countOpt = null;
  const filters = [], eqs = []; // eqs: 호출 기록에 남기는 등호 조건(가상 조직 id가 서버로 새는지 검사)
  const api = {
    select(c = '*', opts = null) { cols = c; countOpt = opts; return api; }, eq(k, v) { eqs.push([k, v]); filters.push(r => r[k] === v); return api; }, neq(k, v) { filters.push(r => r[k] !== v); return api; }, is(k, v) { filters.push(r => (r[k] ?? null) === v); return api; },
    in(k, vs) { filters.push(r => vs.includes(r[k])); return api; }, gt(k, v) { filters.push(r => r[k] > v); return api; }, lt(k, v) { filters.push(r => r[k] < v); return api; },
    order() { return api; }, limit() { return api; }, contains() { return api; }, or(expr) { const alts = String(expr).split(',').map((x) => x.split('.')).filter((x) => x.length >= 3); if (alts.length) filters.push((r) => alts.some(([k, o, ...v]) => (o === 'is' && v.join('.') === 'null' ? (r[k] ?? null) === null : o === 'neq' ? r[k] !== v.join('.') : o === 'eq' ? r[k] === v.join('.') : true))); return api; }, // 'a.is.null,a.neq.x' 꼴만(보관 방 안 읽은 수 — 서버처럼 내 글 제외) ilike() { return api; }, maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    upsert(v) { op = 'upsert'; values = v; return api; }, update(v) { op = 'update'; values = v; return api; }, delete() { op = 'delete'; return api; }, insert(v) { op = 'insert'; values = v; return api; },
    then(resolve, reject) {
      const slow = state.slow?.[`${table}:${op}`]; // 화면 확인용 지연(window.__psFixture.slow = { 'msgr_crews:select': 1500 }) — 돌리는 동안 연타(검수 #5)
      if (slow) { const ms = slow; state.slow[`${table}:${op}`] = 0; return new Promise((r) => setTimeout(r, ms)).then(() => api.then(resolve, reject)); }
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
      })).then((r) => (countOpt?.count && !r.error ? { data: countOpt.head ? null : r.data, count: r.data.length, error: null } : r)).then(resolve, reject); // select('id', { count, head }) — 서버처럼 개수만
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
    if (name === 'msgr_unread') return legacyUnread && args?.org === org ? [{ channel_id: 'org-pepper-dm', n: 2, mention: 0 }] : [];
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
