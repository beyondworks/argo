// v2 셸 픽스처용 가짜 Supabase — 메모리 표(msgr2_*)와 v2 RPC 몇 개. 자격증명·실제 클라이언트를 가져오지 않는다.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = '5c1e0a77-0000-4000-8000-000000000001', mate = '9b2d4f10-0000-4000-8000-000000000002', now = Date.now();
const at = (min) => new Date(now - min * 60_000).toISOString();
const later = (min) => new Date(now + min * 60_000).toISOString();
const T = 'space-team', P = 'space-personal', GEN = 'room-general', PLAN = 'room-plan', DM = 'room-dm';
const A = 'agent-research', B = 'agent-writer';
const state = window.__v2Fixture = { calls: [], tables: {
  msgr2_spaces: [{ id: P, kind: 'personal', name: '', owner_user_id: uid }, { id: T, kind: 'team', name: 'Beyond 팀', owner_user_id: mate }],
  msgr2_space_members: [{ space_id: P, user_id: uid, role: 'owner' }, { space_id: T, user_id: uid, role: 'member' }],
  msgr2_rooms: [
    { id: GEN, space_id: T, kind: 'open', name: '일반', created_at: at(500) }, { id: PLAN, space_id: T, kind: 'private', name: '기획', created_at: at(400) },
    { id: DM, space_id: P, kind: 'direct', pair_key: 'me-research', name: '', created_at: at(300) },
  ],
  msgr2_room_members: [
    { room_id: GEN, member_kind: 'user', member_id: uid }, { room_id: GEN, member_kind: 'user', member_id: mate }, { room_id: GEN, member_kind: 'agent', member_id: A }, { room_id: GEN, member_kind: 'agent', member_id: B },
    { room_id: PLAN, member_kind: 'user', member_id: uid }, { room_id: DM, member_kind: 'user', member_id: uid }, { room_id: DM, member_kind: 'agent', member_id: A },
  ],
  msgr2_agents: [{ id: A, owner_user_id: uid, display_name: '리서치', slug: 'research', status: 'active' }, { id: B, owner_user_id: mate, display_name: '라이터', slug: 'writer', status: 'active' }],
  msgr2_messages: [
    { id: 101, room_id: GEN, author_kind: 'user', author_user_id: mate, kind: 'text', body: '이번 주 경쟁사 가격표 정리가 필요해요.', meta: {}, created_at: at(40) },
    { id: 102, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 경쟁사 3곳 가격표 모아 줘', meta: {}, created_at: at(38) },
    { id: 103, room_id: GEN, author_kind: 'agent', author_agent_id: A, kind: 'text', body: '세 곳 가격표를 표로 정리했습니다.\n\n| 회사 | 기본 | 프로 |\n|---|---|---|\n| 가 | 9,900원 | 29,000원 |\n| 나 | 12,000원 | 33,000원 |', meta: { work: 'w-done', mark: 'work.late' }, work_id: 'w-done', created_at: at(20) },
    { id: 104, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 고객 3명에게 결과 메일 보내 줘', meta: {}, created_at: at(15) },
    { id: 105, room_id: GEN, author_kind: 'agent', author_agent_id: A, kind: 'card', body: '3명에게 발송', meta: { code: 'approval.request' }, work_id: 'w-ap', created_at: at(14) },
    { id: 106, room_id: GEN, author_kind: 'user', author_user_id: mate, kind: 'text', body: '@라이터 소개 문구 초안도 부탁해요', meta: {}, created_at: at(10) },
    { id: 107, room_id: GEN, author_kind: 'system', kind: 'system', body: '', meta: { code: 'work.limit', limit: 'agent_minute', agent: B }, created_at: at(9) },
    { id: 108, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 결제 대행 정산 확인해 줘', meta: {}, created_at: at(6) },
    { id: 109, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 자료 폴더 정리', meta: {}, created_at: at(4) },
    { id: 110, room_id: GEN, author_kind: 'system', kind: 'system', body: '', meta: { code: 'work.error', error: 'timeout', agent: A, work: 'w-fail' }, work_id: 'w-fail', created_at: at(3) },
    { id: 111, room_id: GEN, author_kind: 'user', author_user_id: uid, kind: 'text', body: '@리서치 오늘 회의록 요약', meta: {}, created_at: at(1) },
    { id: 201, room_id: DM, author_kind: 'user', author_user_id: uid, kind: 'text', body: '안녕, 오늘 할 일 정리해 줘', meta: {}, created_at: at(30) },
    { id: 202, room_id: DM, author_kind: 'agent', author_agent_id: A, kind: 'text', body: '오늘 할 일 3가지를 정리했어요.', meta: { work: 'w-dm' }, work_id: 'w-dm', created_at: at(29) },
  ],
  msgr2_attachments: [{ id: 1, message_id: 103, room_id: GEN, name: '가격표.csv', mime: 'text/csv', bytes: 2048, storage_path: `msgr/${T}/${GEN}/103/0-가격표.csv` }],
  msgr2_works: [
    { id: 'w-done', room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 102, state: 'done', has_result: true, late: true, expires_at: later(10), lease_until: at(25), created_at: at(38) },
    { id: 'w-ap', room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 104, state: 'awaiting_approval', has_result: false, late: false, expires_at: later(10), lease_until: later(8), created_at: at(15) },
    { id: 'w-unknown', room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 108, state: 'running', has_result: false, late: false, expires_at: later(10), lease_until: at(1), created_at: at(6) },
    { id: 'w-fail', room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 109, state: 'failed', has_result: false, late: false, error_code: 'timeout', expires_at: later(10), lease_until: at(3), created_at: at(4) },
    { id: 'w-run', room_id: GEN, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 111, state: 'running', has_result: false, late: false, expires_at: later(10), lease_until: later(9), created_at: at(1) },
    { id: 'w-dm', room_id: DM, agent_id: A, owner_user_id: uid, root_user_id: uid, source_message_id: 201, state: 'done', has_result: true, late: false, expires_at: later(10), lease_until: at(28), created_at: at(30) },
  ],
  msgr2_approvals: [{ id: 'ap-1', work_id: 'w-ap', room_id: GEN, action: '고객 3명에게 결과 메일 발송', risk: 'high', summary: '받는 사람: 김○○, 이○○, 박○○ — 보낸 뒤에는 되돌릴 수 없습니다.', card_message_id: 105, state: 'pending', expires_at: later(50), created_at: at(14) }],
} };

function result(call, action) { state.calls.push(structuredClone(call)); try { return { data: action(), error: null, status: 200 }; } catch (e) { return { data: null, error: { message: String(e.message) }, status: 400 }; } }

function query(table) {
  let op = 'select', values, one = false, desc = false, lim = null;
  const filters = [];
  const api = {
    select() { return api; }, eq(k, v) { filters.push((r) => r[k] === v); return api; }, is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; },
    in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; }, lt(k, v) { filters.push((r) => r[k] < v); return api; }, gt(k, v) { filters.push((r) => r[k] > v); return api; },
    order(k, o) { desc = o && o.ascending === false; api._k = k; return api; }, limit(n) { lim = n; return api; }, maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    insert(v) { op = 'insert'; values = v; return api; },
    then(resolve, reject) {
      return Promise.resolve(result({ table, op, values }, () => {
        const all = (state.tables[table] ??= []);
        if (op === 'insert') {
          const rows = (Array.isArray(values) ? values : [values]).map((v) => ({ ...v, id: table === 'msgr2_messages' ? Math.max(0, ...all.map((m) => m.id)) + 1 : v.id, created_at: new Date().toISOString(), meta: v.meta ?? {} }));
          all.push(...rows); return structuredClone(one ? rows[0] : rows);
        }
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (api._k) rows = [...rows].sort((a, b) => (a[api._k] < b[api._k] ? -1 : 1) * (desc ? -1 : 1));
        if (lim != null) rows = rows.slice(0, lim);
        return structuredClone(one ? rows[0] ?? null : rows);
      })).then(resolve, reject);
    },
  };
  return api;
}

const rpcs = {
  argo_min_app_version: () => null,
  msgr2_service_pause: () => null,
  msgr2_device_register: () => ({ device_id: 'dev-fixture', kind: 'app', wrote: false }),
  msgr2_catch_up: () => ({ rooms: [], next_since: 111 }),
  msgr2_my_personal_space: () => P,
  msgr2_work_status: ({ p_work }) => ({ work: p_work, effects: p_work === 'w-unknown' ? [{ key: 'pay-settle-17', kind: 'pay', state: 'unknown' }] : [] }),
  msgr2_approval_decide: ({ p_approval, p_decision }) => { const a = state.tables.msgr2_approvals.find((x) => x.id === p_approval); a.state = p_decision === 'approve' ? 'approved' : 'rejected'; const w = state.tables.msgr2_works.find((x) => x.id === a.work_id); w.state = 'running'; return a.state; },
  msgr2_work_cancel: ({ p_work }) => { const w = state.tables.msgr2_works.find((x) => x.id === p_work); w.state = 'cancelled'; return 'cancelled'; },
};

const channels = new Set();
export const supabase = {
  from: query,
  auth: { getSession: async () => ({ data: { session: { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name, args = {}) => result({ rpc: name, args }, () => (rpcs[name] ? rpcs[name](args) : null)),
  realtime: { setAuth: async () => {} },
  channel: (topic) => {
    const c = { topic, handlers: [], on(kind, filter, cb) { c.handlers.push({ kind, filter, cb }); return c; }, subscribe(cb) { queueMicrotask(() => cb?.('SUBSCRIBED')); return c; }, presenceState: () => ({}), send: async () => {}, unsubscribe: async () => {} };
    channels.add(c); return c;
  },
  removeChannel: async (c) => { channels.delete(c); return 'ok'; }, removeAllChannels: async () => {},
  storage: { from: () => ({ upload: async (path) => ({ data: { path }, error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'data:,' }, error: null }) }) },
};
// 시험이 진행 방송(v2:wk:)을 흉내 낸다
window.__v2Progress = (work, stage) => { for (const c of channels) if (c.topic === `v2:wk:${work}`) for (const h of c.handlers) if (h.kind === 'broadcast') h.cb({ event: 'progress', payload: { stage } }); };
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
