// 메신저 v2 모드(기존 셸 + v2 어댑터, U6c-1b) 화면 픽스처용 가짜 Supabase — 메모리 표(msgr2_*)와 연결 상태 기계·셸이 부르는 RPC 몇 개.
// 자격증명·실제 클라이언트를 가져오지 않는다. 운영·qbwr에 접속하지 않는다. 옛 표(msgr_*) 조회는 어댑터가 v2 표로 바꿔 여기로 온다.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = '5c1e0a77-0000-4000-8000-000000000001', mate = '9b2d4f10-0000-4000-8000-000000000002', now = Date.now();
const at = (min) => new Date(now - min * 60_000).toISOString();
const later = (min) => new Date(now + min * 60_000).toISOString();
const T = '7e000000-0000-4000-8000-0000000000aa', P = '7e000000-0000-4000-8000-0000000000bb';
const GEN = '7f000000-0000-4000-8000-000000000001', PLAN = '7f000000-0000-4000-8000-000000000002', DM = '7f000000-0000-4000-8000-000000000003';
const A = 'a0000000-0000-4000-8000-000000000001', B = 'a0000000-0000-4000-8000-000000000002', C = 'a0000000-0000-4000-8000-000000000003';
const W = (n) => `b0000000-0000-4000-8000-00000000000${n}`;
const state = window.__v2Fixture = { calls: [], topics: new Map(), signedIn: true, authCbs: new Set(), tables: {
  msgr2_spaces: [{ id: P, kind: 'personal', name: '', owner_user_id: uid }, { id: T, kind: 'team', name: 'Beyond 팀', owner_user_id: mate }],
  msgr2_space_members: [{ space_id: P, user_id: uid, role: 'owner', display_name: '나' }, { space_id: T, user_id: uid, role: 'member', display_name: '유건' }, { space_id: T, user_id: mate, role: 'owner', display_name: '민지' }],
  msgr2_rooms: [
    { id: GEN, space_id: T, kind: 'open', name: '일반', memory: true, agent_policy: 'allowed', created_at: at(500), archived_at: null },
    { id: PLAN, space_id: T, kind: 'private', name: '기획', memory: true, agent_policy: 'approval', created_at: at(400), archived_at: null },
    { id: DM, space_id: P, kind: 'direct', pair_key: 'me-research', name: null, memory: true, agent_policy: 'allowed', created_at: at(300), archived_at: null },
  ],
  msgr2_room_members: [
    { room_id: GEN, member_kind: 'user', member_id: mate, removed_at: null }, { room_id: GEN, member_kind: 'agent', member_id: A, removed_at: null }, { room_id: GEN, member_kind: 'agent', member_id: B, removed_at: null },
    { room_id: PLAN, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: PLAN, member_kind: 'user', member_id: mate, removed_at: null },
    { room_id: DM, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: DM, member_kind: 'agent', member_id: A, removed_at: null },
  ],
  msgr2_agents: [
    { id: A, owner_user_id: uid, display_name: '리서치', slug: 'research', role_text: '자료 조사', hosting: 'local', status: 'active', created_at: at(900) },
    { id: B, owner_user_id: mate, display_name: '라이터', slug: 'writer', role_text: '글쓰기', hosting: 'local', status: 'active', created_at: at(800) },
    { id: C, owner_user_id: uid, display_name: '정리봇', slug: 'tidy', role_text: '폴더 정리', hosting: 'local', status: 'active', created_at: at(700) },
  ],
  msgr2_agent_seats: [{ agent_id: A, space_id: T, allow: 'all', allow_users: [], removed_at: null }, { agent_id: B, space_id: T, allow: 'all', allow_users: [], removed_at: null }],
  msgr2_messages: [
    { id: 101, room_id: GEN, author_kind: 'user', author_user_id: mate, kind: 'text', body: '이번 주 경쟁사 가격표 정리가 필요해요.', meta: {}, mentions: [], created_at: at(40) },
    { id: 102, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 경쟁사 3곳 가격표 모아 줘', meta: {}, mentions: [A], created_at: at(38) },
    { id: 103, room_id: GEN, author_kind: 'agent', author_agent_id: A, kind: 'text', body: '세 곳 가격표를 표로 정리했습니다.\n\n| 회사 | 기본 | 프로 |\n|---|---|---|\n| 가 | 9,900원 | 29,000원 |\n| 나 | 12,000원 | 33,000원 |', meta: { work: W(1) }, work_id: W(1), mentions: [], created_at: at(20) },
    { id: 104, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 고객 3명에게 결과 메일 보내 줘', meta: {}, mentions: [A], created_at: at(15) },
    { id: 105, room_id: GEN, author_kind: 'agent', author_agent_id: A, kind: 'card', body: '3명에게 발송', meta: { code: 'approval.request' }, work_id: W(2), mentions: [], created_at: at(14) },
    { id: 106, room_id: GEN, author_kind: 'user', author_user_id: mate, kind: 'text', body: '@라이터 소개 문구 초안도 부탁해요', meta: {}, mentions: [B], created_at: at(10) },
    { id: 107, room_id: GEN, author_kind: 'system', kind: 'system', body: '', meta: { code: 'work.limit', limit: 'agent_minute', agent: B }, mentions: [], created_at: at(9) },
    { id: 108, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 오늘 회의록 요약', meta: {}, mentions: [A], created_at: at(2) },
    { id: 201, room_id: DM, author_kind: 'user', author_user_id: uid, kind: 'text', body: '안녕, 오늘 할 일 정리해 줘', meta: {}, mentions: [], created_at: at(30) },
    { id: 202, room_id: DM, author_kind: 'agent', author_agent_id: A, kind: 'text', body: '오늘 할 일 3가지를 정리했어요.', meta: { work: W(5) }, work_id: W(5), mentions: [], created_at: at(29) },
  ],
  msgr2_attachments: [{ id: 1, message_id: 103, room_id: GEN, name: '가격표.csv', mime: 'text/csv', bytes: 2048, storage_path: `msgr/${T}/${GEN}/103/0-가격표.csv` }],
  msgr2_works: [
    { id: W(1), room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 102, state: 'done', has_result: true, late: true, expires_at: later(10), lease_until: at(25), created_at: at(38) },
    { id: W(2), room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 104, state: 'awaiting_approval', has_result: false, late: false, expires_at: later(10), lease_until: later(8), created_at: at(15) },
    { id: W(3), room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 108, state: 'running', has_result: false, late: false, expires_at: later(10), lease_until: later(9), created_at: at(2) },
    { id: W(5), room_id: DM, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 201, state: 'done', has_result: true, late: false, expires_at: later(10), lease_until: at(28), created_at: at(30) },
  ],
  msgr2_approvals: [{ id: 'c0000000-0000-4000-8000-000000000001', work_id: W(2), room_id: GEN, action: '고객 3명에게 결과 메일 발송', risk: 'high', summary: '받는 사람: 김○○, 이○○, 박○○ — 보낸 뒤에는 되돌릴 수 없습니다.', card_message_id: 105, state: 'pending', expires_at: later(50), created_at: at(14) }],
  msgr2_reactions: [], msgr2_reads: [], msgr2_prefs: [],
} };

const call = (c) => state.calls.push(c);
function query(table) {
  let op = 'select', values, one = false, desc = false, orderKey = null, lim = null, head = false;
  const filters = [];
  const api = {
    select(_c, o) { if (o?.head) head = true; return api; },
    eq(k, v) { filters.push((r) => r[k] === v); return api; }, neq(k, v) { filters.push((r) => r[k] !== v); return api; },
    is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; }, in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
    lt(k, v) { filters.push((r) => r[k] < v); return api; }, lte(k, v) { filters.push((r) => r[k] <= v); return api; },
    gt(k, v) { filters.push((r) => r[k] > v); return api; }, gte(k, v) { filters.push((r) => r[k] >= v); return api; },
    contains(k, v) { filters.push((r) => (Array.isArray(v) ? v.every((x) => (r[k] ?? []).includes(x)) : true)); return api; },
    or() { return api; }, not() { return api; }, ilike() { return api; }, like() { return api; }, range() { return api; },
    order(k, o) { orderKey = k; desc = o && o.ascending === false; return api; }, limit(n) { lim = n; return api; },
    maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    insert(v) { op = 'insert'; values = v; return api; }, upsert(v) { op = 'upsert'; values = v; return api; }, update(v) { op = 'update'; values = v; return api; }, delete() { op = 'delete'; return api; },
    then(resolve, reject) {
      call({ table, op });
      const all = (state.tables[table] ??= []);
      let out;
      if (op === 'insert' || op === 'upsert') {
        const rows = (Array.isArray(values) ? values : [values]).map((v) => ({ ...v, id: table === 'msgr2_messages' ? Math.max(0, ...all.map((m) => m.id)) + 1 : v.id, created_at: new Date().toISOString(), meta: v.meta ?? {} }));
        all.push(...rows); out = one ? rows[0] : rows;
        if (table === 'msgr2_messages') for (const m of rows) {
          fire(`v2:u:${uid}`, 'msg', { message: m }); // 서버 글 방송 대역
          for (const agent of m.mentions ?? []) { // 서버(U2)가 멘션으로 일을 만들고(U6c-1a) 일 표지를 보낸다
            const w = { id: `b1000000-0000-4000-8000-${String(Date.now()).slice(-12)}`, room_id: m.room_id, agent_id: agent, owner_user_id: state.tables.msgr2_agents.find((a) => a.id === agent)?.owner_user_id, root_user_id: uid, source_message_id: m.id, state: 'offered', has_result: false, late: false, expires_at: later(30), created_at: new Date().toISOString() };
            state.tables.msgr2_works.push(w); setTimeout(() => fire(`v2:u:${uid}`, 'work', { work: w }), 50);
          }
        }
      } else {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') { rows.forEach((r) => Object.assign(r, values)); out = rows; }
        else if (op === 'delete') { state.tables[table] = all.filter((r) => !rows.includes(r)); out = rows; }
        else {
          if (orderKey) rows = [...rows].sort((a, b) => (a[orderKey] < b[orderKey] ? -1 : a[orderKey] > b[orderKey] ? 1 : 0) * (desc ? -1 : 1));
          if (lim != null) rows = rows.slice(0, lim);
          out = one ? rows[0] ?? null : rows;
        }
      }
      return Promise.resolve({ data: head ? null : structuredClone(out), error: null, status: 200, count: Array.isArray(out) ? out.length : out ? 1 : 0 }).then(resolve, reject);
    },
  };
  return api;
}

const rpcs = {
  argo_min_app_version: () => null, msgr2_service_pause: () => null,
  msgr2_device_register: () => ({ device_id: 'd0000000-0000-4000-8000-000000000001', kind: 'app', wrote: false }),
  msgr2_catch_up: () => ({ rooms: [], next_since: 202 }),
  msgr2_my_personal_space: () => P,
  msgr2_work_status: ({ p_work }) => ({ work: p_work, effects: [] }),
  msgr2_approval_decide: ({ p_approval, p_decision }) => { const a = state.tables.msgr2_approvals.find((x) => x.id === p_approval); a.state = p_decision === 'approve' ? 'approved' : 'rejected'; const w = state.tables.msgr2_works.find((x) => x.id === a.work_id); w.state = 'running'; fire(`v2:u:${uid}`, 'work', { work: w }); return a.state; },
  msgr2_work_cancel: ({ p_work }) => { const w = state.tables.msgr2_works.find((x) => x.id === p_work); w.state = 'cancelled'; fire(`v2:u:${uid}`, 'work', { work: w }); return 'cancelled'; },
  msgr2_set_seat: ({ p_agent, p_space, p_remove }) => { const s = state.tables.msgr2_agent_seats; const row = s.find((x) => x.agent_id === p_agent && x.space_id === p_space); if (p_remove) { if (row) row.removed_at = new Date().toISOString(); } else if (row) row.removed_at = null; else s.push({ agent_id: p_agent, space_id: p_space, allow: 'all', allow_users: [], removed_at: null }); return null; },
  msgr2_devices_list: () => state.devices.map((d) => ({ ...d })),
  msgr2_device_revoke: ({ p_device }) => { const d = state.devices.find((x) => x.id === p_device); if (!d || d.revoked_at) return false; d.revoked_at = new Date().toISOString(); d.state = 'revoked'; if (d.is_current) setTimeout(() => fire(`v2:u:${uid}`, 'device_revoked', { device_id: d.id }), 50); return true; },
  // 그대로 쓰는 옛 RPC(설계 1-2절)
  msgr_my_friends: () => [{ user_id: mate, status: 'accepted', display_name: '민지', handle: 'minji' }],
  msgr_avatars: () => [], msgr_people_names: ({ ids }) => (ids ?? []).map((id) => ({ user_id: id, display_name: id === uid ? '유건' : '민지' })),
  msgr_my_hidden_users: () => [], msgr_my_blocked: () => [], my_plan: () => 'pro', msgr_my_ai_consent: () => true,
};

function fire(topic, event, payload) { for (const c of state.topics.get(topic) ?? []) for (const h of c.handlers) if (h.kind === 'broadcast' && (h.filter?.event === '*' || h.filter?.event === event)) h.cb({ event, payload }); }
export const supabase = {
  from: query,
  auth: { // 로그인 세션 대역 — signOut이면 세션을 비우고 SIGNED_OUT을 알린다(기기 폐기·모든 기기 로그아웃 화면 확인용)
    getSession: async () => ({ data: { session: state.signedIn ? { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } : null }, error: null }),
    onAuthStateChange: (cb) => { state.authCbs.add(cb); return { data: { subscription: { unsubscribe() { state.authCbs.delete(cb); } } } }; },
    signOut: async () => { state.signedIn = false; for (const cb of state.authCbs) cb('SIGNED_OUT', null); return { error: null }; },
  },
  rpc: async (name, args = {}) => { call({ rpc: name }); try { return { data: rpcs[name] ? rpcs[name](args) : [], error: null, status: 200 }; } catch (e) { return { data: null, error: { message: String(e.message) }, status: 400 }; } },
  realtime: { setAuth: async () => {}, isConnected: () => true },
  functions: { invoke: async () => ({ data: null, error: null }) },
  channel: (topic) => {
    const c = { topic, handlers: [], on(kind, filter, cb) { c.handlers.push({ kind, filter, cb }); return c; }, subscribe(cb) { queueMicrotask(() => cb?.('SUBSCRIBED')); return c; }, presenceState: () => ({}), send: async () => 'ok', unsubscribe: async () => {} };
    if (!state.topics.has(topic)) state.topics.set(topic, new Set()); state.topics.get(topic).add(c); return c;
  },
  removeChannel: async (c) => { state.topics.get(c.topic)?.delete(c); return 'ok'; }, removeAllChannels: async () => { state.topics.clear(); }, getChannels: () => [...state.topics.values()].flatMap((s) => [...s]),
  // Storage 대역: 버킷 'msgr' 안의 객체 이름만 받는다 — 'msgr/'로 시작하는 이름(버킷을 두 번 쓴 경로)이나 첨부 행에 없는 이름이면 실패한다(#1085 검수: 첨부를 열 수 없던 결함을 잡게)
  storage: { from: (bucket) => {
    const known = (name) => bucket === 'msgr' && !String(name).startsWith('msgr/') && state.tables.msgr2_attachments.some((a) => a.storage_path === `msgr/${name}`);
    const bad = (name) => ({ data: null, error: { message: `Object not found: ${bucket}/${name}`, statusCode: '400' }, status: 400 });
    return {
      upload: async (path) => { call({ storage: 'upload', bucket, path }); return bucket === 'msgr' && !String(path).startsWith('msgr/') ? { data: { path }, error: null } : bad(path); },
      list: async () => ({ data: [], error: null }),
      remove: async (paths) => { call({ storage: 'remove', bucket, paths }); return (paths ?? []).every(known) ? { data: paths.map((name) => ({ name })), error: null } : bad(paths.find((p) => !known(p))); },
      createSignedUrl: async (path) => { call({ storage: 'sign', bucket, path }); return known(path) ? { data: { signedUrl: 'data:text/plain,fixture' }, error: null } : bad(path); },
    };
  } },
};
// 시험·캡처가 쓰는 대역: 본체의 진행 봉투(v2:wk:), 새 일 표지(v2:u: work)
state.progress = (work, stage) => fire(`v2:wk:${work}`, 'envelope', { v: 1, id: 'e', work, seq: 1, type: 'work.progress', at: new Date().toISOString(), data: { stage } });
state.work = (w) => { const all = state.tables.msgr2_works; const i = all.findIndex((x) => x.id === w.id); if (i >= 0) Object.assign(all[i], w); else all.push(w); fire(`v2:u:${uid}`, 'work', { work: all.find((x) => x.id === w.id) }); };
state.devices = [
  { id: 'd0000000-0000-4000-8000-000000000001', kind: 'app', app: 'messenger', app_version: '0.2.0', registered_at: at(5), created_at: at(600), state: 'active', is_current: true },
  { id: 'd0000000-0000-4000-8000-000000000002', kind: 'runner', app: 'desktop', app_version: '0.9.1', registered_at: at(30), created_at: at(9000), state: 'active', is_current: false },
  { id: 'd0000000-0000-4000-8000-000000000003', kind: 'app', app: 'messenger', app_version: '0.1.9', registered_at: at(4000), created_at: at(9000), state: 'active', is_current: false },
  { id: 'd0000000-0000-4000-8000-000000000004', kind: 'app', app: 'messenger', app_version: '0.1.5', registered_at: at(60000), created_at: at(90000), state: 'expired', is_current: false },
];
state.pause = (on) => fire(`v2:u:${uid}`, 'pause', { paused: !!on }); // 서버 중단 스위치 대역
state.client = () => supabase; // 페이지 시험은 이 함수로 앱과 같은 대역을 쓴다(모듈을 다시 불러오면 다른 사본이 생긴다)
state.ids = { uid, mate, T, P, GEN, PLAN, DM, A, B, C, W };
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
