// 메신저 v2 모드(기존 셸 + v2 어댑터, U6c-1b) 화면 픽스처용 가짜 Supabase — 메모리 표(msgr2_*)와 연결 상태 기계·셸이 부르는 RPC 몇 개.
// 자격증명·실제 클라이언트를 가져오지 않는다. 운영·qbwr에 접속하지 않는다. 옛 표(msgr_*) 조회는 어댑터가 v2 표로 바꿔 여기로 온다.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = '5c1e0a77-0000-4000-8000-000000000001', mate = '9b2d4f10-0000-4000-8000-000000000002', now = Date.now();
const at = (min) => new Date(now - min * 60_000).toISOString();
const later = (min) => new Date(now + min * 60_000).toISOString();
const T = '7e000000-0000-4000-8000-0000000000aa', P = '7e000000-0000-4000-8000-0000000000bb', PM = '7e000000-0000-4000-8000-0000000000cc'; // PM = 친구(민지)의 개인 공간
const GEN = '7f000000-0000-4000-8000-000000000001', PLAN = '7f000000-0000-4000-8000-000000000002', DM = '7f000000-0000-4000-8000-000000000003', NEWS = '7f000000-0000-4000-8000-000000000004';
const A = 'a0000000-0000-4000-8000-000000000001', B = 'a0000000-0000-4000-8000-000000000002', C = 'a0000000-0000-4000-8000-000000000003';
const W = (n) => `b0000000-0000-4000-8000-00000000000${n}`;
const state = window.__v2Fixture = { calls: [], topics: new Map(), signedIn: true, authCbs: new Set(), tables: {
  msgr2_spaces: [{ id: P, kind: 'personal', name: '', owner_user_id: uid }, { id: PM, kind: 'personal', name: '', owner_user_id: mate }, { id: T, kind: 'team', name: 'Beyond 팀', owner_user_id: mate }],
  msgr2_space_members: [{ space_id: P, user_id: uid, role: 'owner', display_name: '나' }, { space_id: T, user_id: uid, role: 'member', display_name: '유건' }, { space_id: T, user_id: mate, role: 'owner', display_name: '민지' }],
  msgr2_rooms: [
    { id: GEN, space_id: T, kind: 'open', name: '일반', memory: true, agent_policy: 'allowed', created_at: at(500), archived_at: null },
    { id: PLAN, space_id: T, kind: 'private', name: '기획', memory: true, agent_policy: 'approval', created_at: at(400), archived_at: null },
    { id: DM, space_id: P, kind: 'private', name: '', /* 서버 msgr2_agent_dm_open과 같이 에이전트 1:1은 이름 없는 private 방(20261020200600) */ memory: true, agent_policy: 'allowed', created_at: at(300), archived_at: null },
    { id: NEWS, space_id: T, kind: 'open', name: '공지', memory: true, agent_policy: 'allowed', created_at: at(450), archived_at: null }, // 참여 전 open 방(둘러보기)
  ],
  msgr2_room_members: [
    { room_id: GEN, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: GEN, member_kind: 'user', member_id: mate, removed_at: null }, { room_id: NEWS, member_kind: 'user', member_id: mate, removed_at: null }, { room_id: GEN, member_kind: 'agent', member_id: A, removed_at: null }, { room_id: GEN, member_kind: 'agent', member_id: B, removed_at: null },
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
let workSeq = 0;
function query(table) {
  let op = 'select', values, one = false, desc = false, orderKey = null, lim = null, head = false;
  const filters = []; const embeds = [];
  const api = {
    select(c, o) { if (o?.head) head = true; for (const m of String(c ?? '').matchAll(/([a-z_]+):(msgr2_rooms)(!inner)?\(/g)) embeds.push({ alias: m[1], inner: !!m[3] }); return api; }, // 끼워 읽기(방): 'msgr_channels:msgr2_rooms!inner(…)' — room_id로 붙인다
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
            const w = { id: `b1000000-0000-4000-8000-${String(Date.now() * 10 + (workSeq = (workSeq + 1) % 10)).slice(-12)}`, /* 한 글의 멘션 여럿('모두에게')이 같은 id가 되지 않게 */ room_id: m.room_id, agent_id: agent, owner_user_id: state.tables.msgr2_agents.find((a) => a.id === agent)?.owner_user_id, root_user_id: uid, source_message_id: m.id, state: 'offered', has_result: false, late: false, expires_at: later(30), created_at: new Date().toISOString() };
            state.tables.msgr2_works.push(w); setTimeout(() => fire(`v2:u:${uid}`, 'work', { work: w }), 50);
          }
        }
      } else {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') { rows.forEach((r) => Object.assign(r, values)); out = rows; }
        else if (op === 'delete') { state.tables[table] = all.filter((r) => !rows.includes(r)); out = rows; }
        else {
          for (const e of embeds) { rows = rows.map((r) => ({ ...r, [e.alias]: state.tables.msgr2_rooms.find((x) => x.id === r.room_id) ?? null })); if (e.inner) rows = rows.filter((r) => r[e.alias]); }
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
  msgr2_device_register: () => { if (state.free) throw Object.assign(new Error('msgr2_pro_required'), { code: '42501' }); /* ?free=1 — 무료 계정(새 기기 등록은 Pro만, #1133 검수) */ if (state.loginReq) { state.loginReq -= 1; throw Object.assign(new Error('device_login_required'), { code: '42501' }); } /* ?loginreq=N — 처음 N번 '다시 로그인 필요'(10분 규칙, F8 재로그인 안내 화면) */ if (state.failRegister) { state.failRegister -= 1; throw Object.assign(new Error('msgr2_device_invalid'), { code: '22023' }); } return { device_id: 'd0000000-0000-4000-8000-000000000001', kind: 'app', wrote: false }; }, // ?failreg=N — 처음 N번 등록 거부(#1086 검수 1: 다시 붙기 그만둠 화면)
  msgr2_catch_up: () => ({ rooms: [], next_since: 202 }),
  msgr2_my_personal_space: () => P,
  msgr2_work_status: ({ p_work }) => ({ work: p_work, effects: [] }),
  msgr2_approval_decide: ({ p_approval, p_decision }) => { const a = state.tables.msgr2_approvals.find((x) => x.id === p_approval); a.state = p_decision === 'approve' ? 'approved' : 'rejected'; const w = state.tables.msgr2_works.find((x) => x.id === a.work_id); w.state = 'running'; fire(`v2:u:${uid}`, 'work', { work: w }); return a.state; },
  msgr2_work_cancel: ({ p_work }) => { const w = state.tables.msgr2_works.find((x) => x.id === p_work); w.state = 'cancelled'; fire(`v2:u:${uid}`, 'work', { work: w }); return 'cancelled'; },
  // 실제 서버(20261020200000 msgr2_set_seat·20261023180000 msgr2_seat_ensure)와 같은 의미 — 종전 가짜는 p_allow를 무시해 'all' 덮어쓰기 결함(재공개 전 검수 F1)을 못 잡았다
  msgr2_set_seat: ({ p_agent, p_space, p_allow = 'all', p_users = [], p_remove = false }) => { const s = state.tables.msgr2_agent_seats; const row = s.find((x) => x.agent_id === p_agent && x.space_id === p_space); if (p_remove) { if (row && !row.removed_at) row.removed_at = new Date().toISOString(); return null; } if (row) Object.assign(row, { allow: p_allow, allow_users: [...(p_users ?? [])], removed_at: null }); else s.push({ agent_id: p_agent, space_id: p_space, allow: p_allow, allow_users: [...(p_users ?? [])], removed_at: null }); return null; },
  msgr2_seat_scope: ({ p_agent, p_space, p_allow, p_users = [] }) => { const row = state.tables.msgr2_agent_seats.find((x) => x.agent_id === p_agent && x.space_id === p_space); if (!row || row.removed_at) throw Object.assign(new Error('msgr2_seat_not_found'), { code: 'P0002' }); row.allow = p_allow; row.allow_users = p_allow === 'list' ? [...new Set(p_users)] : []; return 'saved'; }, // 서버(20261023180000 msgr2_seat_scope)와 같이 빠진 자리는 되살리지 않는다
  msgr2_seat_ensure: ({ p_agent, p_space }) => { const s = state.tables.msgr2_agent_seats; const row = s.find((x) => x.agent_id === p_agent && x.space_id === p_space); if (!row) { s.push({ agent_id: p_agent, space_id: p_space, allow: 'all', allow_users: [], removed_at: null }); return 'created'; } if (row.removed_at) { row.removed_at = null; return 'restored'; } return 'kept'; },
  msgr2_devices_list: () => state.devices.map((d) => ({ ...d })),
  msgr2_device_revoke: ({ p_device }) => { const d = state.devices.find((x) => x.id === p_device); if (!d || d.revoked_at) return false; d.revoked_at = new Date().toISOString(); d.state = 'revoked'; if (d.is_current) setTimeout(() => fire(`v2:u:${uid}`, 'device_revoked', { device_id: d.id }), 50); return true; },
  // U6d(방·공간·초대·안 읽음·찾기·신고) 대역 — 메모리 표를 바꾸고 v2:u: 방 사건을 보낸다
  // 개인 방 목록(나 기준): 개인 종류 공간의 내 1:1·그룹방 — 친구가 연 방은 친구의 개인 공간(PM)에 있다(U6d·U8)
  msgr2_dm_list: ({ p_include_groups }) => { const T_ = state.tables; const personal = new Set(T_.msgr2_spaces.filter((x) => x.kind === 'personal').map((x) => x.id)); return T_.msgr2_rooms.filter((r) => personal.has(r.space_id) && !r.archived_at && (r.kind === 'direct' || (p_include_groups && r.kind === 'private')) && T_.msgr2_room_members.some((m) => m.room_id === r.id && m.member_kind === 'user' && m.member_id === uid && !m.removed_at)).map((r) => { const mem = T_.msgr2_room_members.filter((m) => m.room_id === r.id && !m.removed_at); const other = r.kind === 'direct' ? mem.find((m) => m.member_kind === 'user' && m.member_id !== uid)?.member_id ?? null : null; const last = T_.msgr2_messages.filter((m) => m.room_id === r.id && m.kind !== 'system').sort((a, b) => b.id - a.id)[0]; return { room_id: r.id, space_id: r.space_id, kind: r.kind, name: r.name ?? '', other_user_id: other, other_name: other === mate ? '민지' : null, members: mem.map((m) => ({ kind: m.member_kind, id: m.member_id, name: m.member_kind === 'agent' ? T_.msgr2_agents.find((a) => a.id === m.member_id)?.display_name : m.member_id === uid ? '유건' : '민지' })), agent_id: null, last_id: last?.id ?? null, last_at: last?.created_at ?? r.created_at, last_body: last?.body ?? '', created_by: r.created_by ?? uid }; }); },
  // 한 목록(메신저 단순화 2단계) — 서버 msgr2_inbox(20261022160000)와 같은 열·같은 판정: 내 활동 멤버 방, 보관·지운 공간 제외, 팀은 활동 공간 멤버만, 고정 → 최근 활동 순, 상한 200
  msgr2_inbox: ({ p_limit = 200 } = {}) => {
    if (state.free) throw Object.assign(new Error('msgr2_pro_required'), { code: '42501' });
    const T_ = state.tables; const lim = Math.max(1, Math.min(200, p_limit || 200));
    const rows = T_.msgr2_room_members.filter((m) => m.member_kind === 'user' && m.member_id === uid && !m.removed_at).map((m) => T_.msgr2_rooms.find((r) => r.id === m.room_id)).filter((r) => r && !r.archived_at).map((r) => {
      const sp = T_.msgr2_spaces.find((x) => x.id === r.space_id);
      if (!sp || sp.deleted_at) return null;
      if (sp.kind === 'team' && !T_.msgr2_space_members.some((x) => x.space_id === sp.id && x.user_id === uid && !x.removed_at)) return null;
      const msgs = T_.msgr2_messages.filter((x) => x.room_id === r.id && !x.deleted_at).sort((a, b) => a.id - b.id); const last = msgs[msgs.length - 1] ?? null;
      const read = T_.msgr2_reads.find((x) => x.room_id === r.id)?.last_read_id ?? 0; const pref = T_.msgr2_prefs.find((x) => x.room_id === r.id) ?? {};
      const mem = T_.msgr2_room_members.filter((x) => x.room_id === r.id && !x.removed_at);
      const others = mem.filter((x) => !(x.member_kind === 'user' && x.member_id === uid)); // 서버와 같은 상대 규칙(819fce07): direct, 또는 나 말고 활동 멤버가 하나인 private
      const peer = r.kind === 'direct' || (r.kind === 'private' && others.length === 1) ? (others.find((x) => x.member_kind === 'user') ?? others.find((x) => x.member_kind === 'agent')) ?? null : null;
      return { room_id: r.id, room_kind: r.kind, room_name: r.name ?? '', space_id: sp.id, space_kind: sp.kind, space_name: sp.kind === 'team' ? sp.name : null,
        peer_kind: peer ? peer.member_kind : null, peer_id: peer ? peer.member_id : null, users: mem.filter((x) => x.member_kind === 'user').length, agents: mem.filter((x) => x.member_kind === 'agent').length,
        last_id: last ? last.id : null, last_at: last ? last.created_at : r.created_at, last_kind: last ? last.kind : null, last_author_kind: last ? last.author_kind : null,
        last_author_id: last ? (last.author_user_id ?? last.author_agent_id ?? null) : null, last_preview: last && last.kind !== 'system' ? String(last.body ?? '').slice(0, 140) : null,
        unread: Math.min(99, msgs.filter((x) => x.id > read && x.kind !== 'system' && x.author_user_id !== uid).length), last_read_id: read, pinned: !!pref.pinned, muted: !!pref.muted };
    }).filter(Boolean);
    rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (Date.parse(b.last_at) - Date.parse(a.last_at)) || (b.room_id < a.room_id ? -1 : 1));
    return rows.slice(0, lim);
  },
  msgr2_unread: ({ p_space }) => { const T_ = state.tables; return T_.msgr2_room_members.filter((m) => m.member_kind === 'user' && m.member_id === uid && !m.removed_at).map((m) => T_.msgr2_rooms.find((r) => r.id === m.room_id)).filter((r) => r && !r.archived_at && (!p_space || r.space_id === p_space)).map((r) => { const last = T_.msgr2_reads.find((x) => x.room_id === r.id)?.last_read_id ?? 0; const n = T_.msgr2_messages.filter((x) => x.room_id === r.id && x.id > last && x.author_user_id !== uid && x.kind !== 'system').length; return { room_id: r.id, space_id: r.space_id, n: Math.min(n, 99), last_id: null, last_read_id: last, muted: false }; }); },
  msgr2_mark_read: ({ p_room, p_last_id }) => { const T_ = state.tables.msgr2_reads; const cur = T_.find((x) => x.room_id === p_room); if (cur) { if (p_last_id > cur.last_read_id) Object.assign(cur, { last_read_id: p_last_id, updated_at: new Date().toISOString() }); } else T_.push({ room_id: p_room, user_id: uid, last_read_id: p_last_id, updated_at: new Date().toISOString() }); return p_last_id; },
  msgr2_room_pref_set: ({ p_room, p_muted, p_pinned }) => { const T_ = state.tables.msgr2_prefs; let r = T_.find((x) => x.room_id === p_room); if (!r) { r = { room_id: p_room, user_id: uid, muted: false, pinned: false }; T_.push(r); } if (p_muted != null) r.muted = p_muted; if (p_pinned != null) r.pinned = p_pinned; return { muted: r.muted, pinned: r.pinned }; },
  msgr2_rooms_browse: ({ p_space }) => state.tables.msgr2_rooms.filter((r) => r.space_id === p_space && r.kind === 'open' && !r.archived_at && !state.tables.msgr2_room_members.some((m) => m.room_id === r.id && m.member_kind === 'user' && m.member_id === uid && !m.removed_at)).map((r) => ({ id: r.id, name: r.name, members: state.tables.msgr2_room_members.filter((m) => m.room_id === r.id && m.member_kind === 'user' && !m.removed_at).length, created_at: r.created_at, joined: false })),
  msgr2_room_join: ({ p_room }) => { if (state.tables.msgr2_room_members.some((m) => m.room_id === p_room && m.member_id === uid && !m.removed_at)) return false; state.tables.msgr2_room_members.push({ room_id: p_room, member_kind: 'user', member_id: uid, removed_at: null }); roomEvent(p_room); return true; },
  msgr2_room_leave: ({ p_room }) => { const m = state.tables.msgr2_room_members.find((x) => x.room_id === p_room && x.member_id === uid && !x.removed_at); if (!m) return false; m.removed_at = new Date().toISOString(); fire(`v2:u:${uid}`, 'rooms', { room_id: p_room, removed: true }); return true; },
  msgr2_room_create: ({ p_space, p_kind, p_name, p_users = [], p_agents = [] }) => { if (p_space && !String(p_name ?? '').trim()) throw new Error('msgr2_bad_name'); const id = `7f100000-0000-4000-8000-${String(Date.now()).slice(-12)}`; state.tables.msgr2_rooms.push({ id, space_id: p_space ?? P, kind: p_kind, name: p_name, memory: true, agent_policy: 'allowed', created_at: new Date().toISOString(), archived_at: null }); for (const u of [uid, ...p_users]) state.tables.msgr2_room_members.push({ room_id: id, member_kind: 'user', member_id: u, removed_at: null }); for (const a of p_agents) state.tables.msgr2_room_members.push({ room_id: id, member_kind: 'agent', member_id: a, removed_at: null }); roomEvent(id); return id; },
  msgr2_dm_open: ({ p_user, p_space }) => { if (p_user === 'blocked') throw new Error('msgr2_dm_unavailable'); const sp = p_space ?? P; let r = state.tables.msgr2_rooms.find((x) => x.kind === 'direct' && x.space_id === sp && state.tables.msgr2_room_members.some((m) => m.room_id === x.id && m.member_id === p_user)); if (!r) { const id = `7f200000-0000-4000-8000-${String(Date.now()).slice(-12)}`; r = { id, space_id: sp, kind: 'direct', pair_key: `${uid}:${p_user}`, name: '', memory: true, agent_policy: 'allowed', created_at: new Date().toISOString(), archived_at: null }; state.tables.msgr2_rooms.push(r); for (const u of [uid, p_user]) state.tables.msgr2_room_members.push({ room_id: id, member_kind: 'user', member_id: u, removed_at: null }); roomEvent(id); } return { room_id: r.id, space_id: sp, existing: false }; },
  // 서버(msgr2_agent_dm_open)와 같은 동작: 내 에이전트의 개인 공간 direct 방이 있으면 그 방, 없으면 개인 공간에 새 direct 방(나 + 에이전트)을 만든다. 남의 에이전트는 거절
  msgr2_agent_dm_open: ({ p_agent }) => {
    const T_ = state.tables; const ag = T_.msgr2_agents.find((x) => x.id === p_agent);
    if (!ag || ag.owner_user_id !== uid) throw Object.assign(new Error('msgr2_agent_not_found'), { code: '42501' });
    const r = T_.msgr2_rooms.find((x) => x.space_id === P && x.kind === 'private' && !x.archived_at && T_.msgr2_room_members.some((m) => m.room_id === x.id && m.member_kind === 'agent' && m.member_id === p_agent && !m.removed_at));
    if (r) return { room_id: r.id, space_id: P, existing: true };
    const id = `7f40${String(T_.msgr2_rooms.length).padStart(4, '0')}-0000-4000-8000-${p_agent.slice(-12)}`;
    T_.msgr2_rooms.push({ id, space_id: P, kind: 'private', name: '', memory: true, agent_policy: 'allowed', created_at: new Date().toISOString(), archived_at: null });
    T_.msgr2_room_members.push({ room_id: id, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: id, member_kind: 'agent', member_id: p_agent, removed_at: null });
    state.createdDm = (state.createdDm ?? 0) + 1; fire(`v2:u:${uid}`, 'rooms', { space_id: P, room_id: id });
    return { room_id: id, space_id: P, existing: false };
  },
  msgr2_room_members_add: ({ p_room, p_users = [], p_agents = [] }) => { let n = 0; for (const [k, ids] of [['user', p_users], ['agent', p_agents]]) for (const id of ids) if (!state.tables.msgr2_room_members.some((m) => m.room_id === p_room && m.member_id === id && !m.removed_at)) { state.tables.msgr2_room_members.push({ room_id: p_room, member_kind: k, member_id: id, removed_at: null }); n++; } return n; },
  msgr2_room_member_remove: ({ p_room, p_member }) => { const m = state.tables.msgr2_room_members.find((x) => x.room_id === p_room && x.member_id === p_member && !x.removed_at); if (!m) return false; m.removed_at = new Date().toISOString(); return true; },
  msgr2_search: ({ p_q }) => { const q = String(p_q ?? '').trim(); if (q.length < 2) return { rooms: [], messages: [], people: [], agents: [] }; return { rooms: state.tables.msgr2_rooms.filter((r) => (r.name ?? '').includes(q)).map((r) => ({ id: r.id, space_id: r.space_id, kind: r.kind, name: r.name })), messages: state.tables.msgr2_messages.filter((m) => m.kind !== 'system' && (m.body ?? '').includes(q)).sort((a, b) => b.id - a.id).map((m) => ({ id: m.id, room_id: m.room_id, author_kind: m.author_kind, author_user_id: m.author_user_id ?? null, author_agent_id: m.author_agent_id ?? null, created_at: m.created_at, snippet: m.body.slice(0, 200) })), people: [], agents: [] }; },
  msgr2_report_message: ({ p_message }) => { state.reports = [...(state.reports ?? []), p_message]; return 'r1'; },
  msgr2_space_create: ({ p_name }) => { const id = `7e100000-0000-4000-8000-${String(Date.now()).slice(-12)}`; state.tables.msgr2_spaces.push({ id, kind: 'team', name: p_name, owner_user_id: uid }); state.tables.msgr2_space_members.push({ space_id: id, user_id: uid, role: 'owner', display_name: '유건' }); fire(`v2:u:${uid}`, 'spaces', { space_id: id }); return id; },
  msgr2_invite_create: ({ p_space, p_role, p_rooms = [], p_max_uses, p_expires_in_s }) => { const inv = { id: `c1000000-0000-4000-8000-${String(Date.now()).slice(-12)}`, code: 'ab'.repeat(24), role: p_role, room_ids: p_rooms, max_uses: p_max_uses, use_count: 0, expires_at: p_expires_in_s ? later(p_expires_in_s / 60) : null, created_by: uid, created_at: new Date().toISOString(), state: 'valid', space_id: p_space }; (state.invites ??= []).push(inv); return { invite_id: inv.id, code: inv.code, expires_at: inv.expires_at, existing: false }; },
  msgr2_invites_list: ({ p_space }) => (state.invites ?? []).filter((i) => i.space_id === p_space),
  msgr2_invite_revoke: ({ p_invite }) => { const i = (state.invites ?? []).find((x) => x.id === p_invite); if (!i || i.state === 'revoked') return false; i.state = 'revoked'; return true; },
  msgr2_my_invites: () => state.myInvites.filter((i) => !state.revokedInvites.includes(i) && Date.parse(i.expires_at) > Date.now()), // 받은 초대(사람 지정) — state.invited()가 하나 넣고 v2:u: invite 사건을 보낸다
  msgr2_invite_preview: ({ p_code }) => { if (p_code === 'ff'.repeat(24)) return { state: 'expired', space_name: 'Beyond 팀' }; const mine = (state.myInvites.concat(state.revokedInvites)).find((i) => i.code === p_code); if (mine) return { state: state.revokedInvites.includes(mine) ? 'revoked' : Date.parse(mine.expires_at) <= Date.now() ? 'expired' : 'valid', space_id: mine.space_id, space_name: mine.space_name, role: mine.role, inviter_name: mine.inviter_name, expires_at: mine.expires_at, already_member: false, rooms: [] }; return { state: 'valid', space_id: T, space_name: 'Beyond 팀', role: 'member', inviter_name: '민지', expires_at: later(60 * 24 * 6), already_member: false, rooms: [{ id: GEN, name: '일반' }, { id: NEWS, name: '공지' }] }; },
  msgr2_invite_decline: async ({ p_code }) => { const ms = state.declineDelay?.[p_code] ?? 0; if (ms) await new Promise((r) => setTimeout(r, ms)); // state.declineDelay = {코드: ms} — 응답 전에 창 닫기·동시 거절 확인
    if (state.failDecline) throw new Error('msgr2_app_device_required'); // state.failDecline = true면 실패(미리보기 안 오류 확인)
    const had = state.myInvites.some((i) => i.code === p_code && Date.parse(i.expires_at) > Date.now()); state.myInvites = state.myInvites.filter((i) => i.code !== p_code); return had; }, // 서버처럼: 이미 정해졌으면(만료·취소) false
  msgr2_invite_accept: ({ p_code }) => { const mine = state.myInvites.find((i) => i.code === p_code); if (mine) { state.myInvites = state.myInvites.filter((i) => i.code !== p_code); fire(`v2:u:${uid}`, 'spaces', { space_id: mine.space_id }); } return { space_id: T, role: 'member', rooms: [GEN], already_member: true }; },
  // 재공개 전 검수 b·F7(서버 20261023180000)과 같은 의미의 대역 — 거부 코드는 {ok:false, code}
  msgr2_room_delete_files: ({ p_room }) => { const T_ = state.tables; if (T_.msgr2_works.some((w) => w.room_id === p_room && ['offered', 'accepted', 'running', 'awaiting_approval'].includes(w.state))) return { ok: false, code: 'work_active' };
    return { ok: true, paths: T_.msgr2_attachments.filter((a) => a.room_id === p_room).map((a) => a.storage_path.replace(/^msgr\//, '')) }; },
  msgr2_room_delete: ({ p_room }) => { const T_ = state.tables; const r = T_.msgr2_rooms.find((x) => x.id === p_room); if (!r) return { ok: false, code: 'forbidden' };
    const mids = new Set(T_.msgr2_messages.filter((m) => m.room_id === p_room).map((m) => m.id));
    T_.msgr2_rooms = T_.msgr2_rooms.filter((x) => x.id !== p_room); T_.msgr2_room_members = T_.msgr2_room_members.filter((x) => x.room_id !== p_room);
    T_.msgr2_messages = T_.msgr2_messages.filter((m) => m.room_id !== p_room); T_.msgr2_attachments = T_.msgr2_attachments.filter((a) => !mids.has(a.message_id) && a.room_id !== p_room);
    state.deletedRooms = [...(state.deletedRooms ?? []), p_room]; fire(`v2:u:${uid}`, 'rooms', { space_id: r.space_id, room_id: p_room, removed: true }); return { ok: true, messages: mids.size }; },
  msgr2_room_set: ({ p_room, p_name, p_memory, p_archive }) => { const r = state.tables.msgr2_rooms.find((x) => x.id === p_room); if (!r) return { ok: false, code: 'forbidden' };
    if (r.archived_at && (p_name != null || p_memory != null)) return { ok: false, code: 'archived' };
    if (p_name != null) r.name = String(p_name).trim(); if (p_memory != null) r.memory = p_memory; if (p_archive) r.archived_at = r.archived_at ?? new Date().toISOString(); roomEvent(p_room); return { ok: true, changed: true }; },
  msgr2_set_room_agent_policy: ({ p_room, p_policy }) => { const r = state.tables.msgr2_rooms.find((x) => x.id === p_room); if (!r) throw Object.assign(new Error('msgr2_forbidden'), { code: '42501' }); r.agent_policy = p_policy; roomEvent(p_room); return null; },
  msgr2_set_member_role: ({ p_space, p_user, p_role }) => { const m = state.tables.msgr2_space_members.find((x) => x.space_id === p_space && x.user_id === p_user && !x.removed_at); if (!m) throw Object.assign(new Error('msgr2_forbidden'), { code: '42501' }); m.role = p_role; return null; },
  msgr2_space_member_remove: ({ p_space, p_user }) => { const m = state.tables.msgr2_space_members.find((x) => x.space_id === p_space && x.user_id === p_user && !x.removed_at); if (!m) return false; m.removed_at = new Date().toISOString(); return true; },
  msgr2_space_display_name_set: ({ p_space, p_name }) => { const m = state.tables.msgr2_space_members.find((x) => x.space_id === p_space && x.user_id === uid); if (!m) return { ok: false, code: 'forbidden' }; m.display_name = String(p_name ?? '').trim() || null; return { ok: true, changed: true }; },
  msgr2_message_edit: ({ p_id, p_body }) => { const m = state.tables.msgr2_messages.find((x) => x.id === p_id); if (!m || m.author_user_id !== uid || m.deleted_at) return { ok: false, code: 'forbidden' }; m.body = p_body; m.edited_at = new Date().toISOString(); return { ok: true }; },
  // 자동화 일정(20261024100000) — 서버와 같은 인자·같은 거부 이름. 크론은 없다(지금 실행만 글을 넣는다)
  msgr2_automation_save: ({ p_automation, p_room, p_agent, p_title, p_prompt, p_schedule, p_request_id }) => { const T_ = state.tables; T_.msgr2_automations ??= [];
    if (!T_.msgr2_room_members.some((m) => m.room_id === p_room && m.member_kind === 'agent' && m.member_id === p_agent && !m.removed_at)) throw Object.assign(new Error('msgr_automation_forbidden'), { code: '42501' });
    if (p_schedule?.kind === 'interval' && !(p_schedule.minutes >= 5)) throw Object.assign(new Error('msgr_automation_invalid_schedule'), { code: 'P0001' });
    let a = T_.msgr2_automations.find((x) => x.id === p_automation || (p_request_id && x.create_request_id === p_request_id));
    const next = new Date(Date.now() + 3600_000).toISOString();
    if (!a) { a = { id: `c7000000-0000-4000-8000-${String(Date.now()).slice(-12)}`, space_id: T_.msgr2_rooms.find((r) => r.id === p_room)?.space_id, room_id: p_room, created_by: uid, create_request_id: p_request_id, enabled: true, last_run_at: null, last_status: null, last_error: null, created_at: new Date().toISOString(), deleted_at: null }; T_.msgr2_automations.push(a); }
    Object.assign(a, { agent_id: p_agent, title: p_title, prompt: p_prompt, schedule: p_schedule, next_run_at: next, updated_at: new Date().toISOString() }); return { ...a }; },
  msgr2_automation_set_enabled: ({ p_automation, p_enabled }) => { const a = state.tables.msgr2_automations.find((x) => x.id === p_automation); a.enabled = p_enabled; return { ...a }; },
  msgr2_automation_delete: ({ p_automation }) => { const a = state.tables.msgr2_automations.find((x) => x.id === p_automation); a.deleted_at = new Date().toISOString(); a.enabled = false; return true; },
  msgr2_automation_run_now: ({ p_automation, p_request_id }) => { const T_ = state.tables; const a = T_.msgr2_automations.find((x) => x.id === p_automation); T_.msgr2_automation_runs ??= [];
    const prev = T_.msgr2_automation_runs.find((r) => r.automation_id === p_automation && p_request_id && r.request_id === p_request_id); if (prev) return prev;
    const r = { id: `c7100000-0000-4000-8000-${String(Date.now()).slice(-12)}`, automation_id: p_automation, request_id: p_request_id, trigger: 'manual', status: 'queued', scheduled_for: new Date().toISOString(), message_id: null, work_id: null, error: null, created_at: new Date().toISOString(), finished_at: null };
    T_.msgr2_automation_runs.push(r); Object.assign(a, { last_run_at: r.created_at, last_status: 'queued' }); return r; },
  msgr2_automation_scheduler_status: () => ({ server_active: true }),
  msgr2_message_delete: ({ p_id }) => { const m = state.tables.msgr2_messages.find((x) => x.id === p_id); if (!m || m.author_user_id !== uid) return { ok: false, code: 'forbidden' }; m.body = ''; m.deleted_at = m.deleted_at ?? new Date().toISOString(); return { ok: true }; },
  // 그대로 쓰는 옛 RPC(설계 1-2절)
  msgr_my_friends: () => [{ user_id: mate, status: 'accepted', display_name: '민지', handle: 'minji' }],
  msgr_avatars: () => [], msgr_people_names: ({ ids }) => (ids ?? []).map((id) => ({ user_id: id, display_name: id === uid ? '유건' : '민지' })),
  msgr_friend_request: () => 'sent', msgr_find_user: () => [{ user_id: '9b2d4f10-0000-4000-8000-000000000003', display_name: '지수', handle: 'jisu' }],
  msgr_my_hidden_users: () => [], msgr_my_blocked: () => [], my_plan: () => ({ plan: 'pro' }) /* 서버 my_plan은 {plan, …} 객체(src/entitlement.mjs effectivePlanOf) */, msgr_my_ai_consent: () => new URLSearchParams(globalThis.location?.search ?? '').get('noconsent') !== '1', /* ?noconsent=1 = AI 이용 동의 전 계정(한 목록이 조직 방을 빼는지) */
};

function roomEvent(room) { const r = state.tables.msgr2_rooms.find((x) => x.id === room); setTimeout(() => fire(`v2:u:${uid}`, 'rooms', { space_id: r?.space_id ?? null, room_id: room }), 30); }
function fire(topic, event, payload) { for (const c of state.topics.get(topic) ?? []) for (const h of c.handlers) if (h.kind === 'broadcast' && (h.filter?.event === '*' || h.filter?.event === event)) h.cb({ event, payload }); }
export const supabase = {
  from: query,
  auth: { // 로그인 세션 대역 — signOut이면 세션을 비우고 SIGNED_OUT을 알린다(기기 폐기·모든 기기 로그아웃 화면 확인용)
    getSession: async () => ({ data: { session: state.signedIn ? { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } : null }, error: null }),
    onAuthStateChange: (cb) => { state.authCbs.add(cb); return { data: { subscription: { unsubscribe() { state.authCbs.delete(cb); } } } }; },
    signOut: async () => { state.signedIn = false; for (const cb of state.authCbs) cb('SIGNED_OUT', null); return { error: null }; },
  },
  rpc: async (name, args = {}) => { call({ rpc: name }); try { return { data: rpcs[name] ? await rpcs[name](args) : [], error: null, status: 200 }; } catch (e) { return { data: null, error: { message: String(e.message), code: e.code }, status: 400 }; } },
  realtime: { setAuth: async () => {}, isConnected: () => true },
  functions: { invoke: async () => ({ data: null, error: null }) },
  // supabase-js(realtime-js RealtimeClient.channel)처럼 같은 토픽의 채널이 있으면 그것을 돌려주고, 가입한 채널에 presence 콜백을 붙이면 던진다(2026-10-23 '모두에게' 화면 깨짐 재현)
  channel: (topic) => {
    const had = state.topics.get(topic)?.values().next().value; if (had) return had;
    const c = { topic, handlers: [], joined: false, on(kind, filter, cb) { if (c.joined && (kind === 'presence' || kind === 'postgres_changes')) throw new Error(`cannot add \`${kind}\` callbacks for realtime:${topic} after \`subscribe()\`.`); c.handlers.push({ kind, filter, cb }); return c; }, subscribe(cb) { c.joined = true; queueMicrotask(() => cb?.('SUBSCRIBED')); return c; }, presenceState: () => ({}), send: async () => 'ok', unsubscribe: async () => {} };
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
state.failRegister = Number(new URLSearchParams(globalThis.location?.search ?? '').get('failreg') || 0);
state.loginReq = Number(new URLSearchParams(globalThis.location?.search ?? '').get('loginreq') || 0);
state.signInAgain = () => { state.signedIn = true; const sess = { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' }; for (const cb of state.authCbs) cb('SIGNED_IN', sess); }; // 화면 시험: 다시 로그인한 것처럼
state.free = new URLSearchParams(globalThis.location?.search ?? '').get('free') === '1';
// 한 목록 시험 자료(메신저 단순화 2단계): 두 번째 조직(Lumen 연구)의 채널, 개인 여러 명 방(주말 모임), 친구가 연 1:1(친구 개인 공간)
{ const T2 = '7e000000-0000-4000-8000-0000000000ee', LAB = '7f000000-0000-4000-8000-000000000005', GROUP = '7f000000-0000-4000-8000-000000000006', FDM = '7f000000-0000-4000-8000-000000000007';
  const T_ = state.tables;
  T_.msgr2_spaces.push({ id: T2, kind: 'team', name: 'Lumen 연구', owner_user_id: mate });
  T_.msgr2_space_members.push({ space_id: T2, user_id: uid, role: 'member', display_name: '유건' }, { space_id: T2, user_id: mate, role: 'owner', display_name: '민지' });
  T_.msgr2_rooms.push({ id: LAB, space_id: T2, kind: 'open', name: '연구실', memory: true, agent_policy: 'allowed', created_at: at(600), archived_at: null },
    { id: GROUP, space_id: P, kind: 'private', name: '주말 모임', memory: true, agent_policy: 'allowed', created_by: uid, created_at: at(700), archived_at: null },
    { id: FDM, space_id: PM, kind: 'direct', pair_key: 'p:me-minji', name: null, memory: true, agent_policy: 'allowed', created_by: mate, created_at: at(800), archived_at: null });
  T_.msgr2_room_members.push({ room_id: LAB, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: LAB, member_kind: 'user', member_id: mate, removed_at: null },
    { room_id: GROUP, member_kind: 'user', member_id: uid, removed_at: null }, { room_id: GROUP, member_kind: 'user', member_id: mate, removed_at: null }, { room_id: GROUP, member_kind: 'agent', member_id: C, removed_at: null },
    { room_id: FDM, member_kind: 'user', member_id: mate, removed_at: null }, { room_id: FDM, member_kind: 'user', member_id: uid, removed_at: null });
  T_.msgr2_messages.push({ id: 301, room_id: LAB, author_kind: 'user', author_user_id: mate, kind: 'text', body: '실험 결과 공유합니다', meta: {}, mentions: [], created_at: at(12) },
    { id: 302, room_id: GROUP, author_kind: 'user', author_user_id: mate, kind: 'text', body: '토요일 11시 어때요?', meta: {}, mentions: [], created_at: at(45) },
    { id: 303, room_id: FDM, author_kind: 'user', author_user_id: mate, kind: 'text', body: '내일 점심 같이 해요', meta: {}, mentions: [], created_at: at(90) });
  T_.msgr2_prefs.push({ room_id: GEN, user_id: uid, muted: false, pinned: true }); }

// 자동화 일정 시험 자료: 에이전트 1:1(DM)의 매일 아침 보고 1개 + 실행 기록 3줄(완료·막힘·만료)
{ const T_ = state.tables; const AU = 'c7000000-0000-4000-8000-000000000001';
  T_.msgr2_automations = [{ id: AU, space_id: P, room_id: DM, agent_id: A, created_by: uid, title: '아침 자료 조사 보고', prompt: '어제 나온 업계 소식을 다섯 줄로 정리해 줘', schedule: { kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Asia/Seoul' },
    enabled: true, next_run_at: later(600), last_run_at: at(840), last_status: 'completed', last_error: null, created_at: at(9000), updated_at: at(840), deleted_at: null }];
  T_.msgr2_automation_runs = [
    { id: 'c7100000-0000-4000-8000-000000000001', automation_id: AU, trigger: 'schedule', status: 'completed', scheduled_for: at(840), message_id: 1, work_id: null, error: null, created_at: at(840), finished_at: at(838) },
    { id: 'c7100000-0000-4000-8000-000000000002', automation_id: AU, trigger: 'schedule', status: 'failed', scheduled_for: at(2280), message_id: 2, work_id: null, error: 'expired', created_at: at(2280), finished_at: at(2250) },
    { id: 'c7100000-0000-4000-8000-000000000003', automation_id: AU, trigger: 'manual', status: 'blocked', scheduled_for: at(3000), message_id: null, work_id: null, error: 'pro_required', created_at: at(3000), finished_at: at(3000) }]; }
if (new URLSearchParams(globalThis.location?.search ?? '').get('admin') === '1') { const me = state.tables.msgr2_space_members.find((m) => m.space_id === T && m.user_id === uid); if (me) me.role = 'admin'; } // ?admin=1 — 나를 이 팀의 관리자로(관리자 전용 설정 화면)
{ const n = Number(new URLSearchParams(globalThis.location?.search ?? '').get('legacybots') || 0); for (let i = 0; i < n; i++) { const slug = `bot-${(0x0804ccfb1680 + i).toString(16).padStart(12, '0')}`; state.tables.msgr2_agents.push({ id: `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, owner_user_id: uid, display_name: i % 2 ? slug : '', slug, role_text: null, hosting: 'bot', status: 'active', created_at: at(100 + i) }); } } // ?legacybots=N — 이름 없는 옛 봇 N개(자리 없음, 유건 계정 45개 모양)
if (new URLSearchParams(globalThis.location?.search ?? '').get('noagents') === '1') { state.tables.msgr2_agents = state.tables.msgr2_agents.filter((a) => a.owner_user_id !== uid); state.tables.msgr2_room_members = state.tables.msgr2_room_members.filter((m) => !(m.member_kind === 'agent' && [A, C].includes(m.member_id))); state.tables.msgr2_agent_seats = state.tables.msgr2_agent_seats.filter((x) => x.agent_id !== A); } // ?noagents=1 — 내 에이전트 0명 계정(빈 안내)
// 두 번째 계정(민지)이 나에게 새 1:1을 연다 — 서버처럼 방을 민지의 개인 공간(PM)에 두고, 나에게 rooms 사건과 글 방송을 보낸다(#1088 검수 1: 받는 쪽에 보여야 한다)
state.friendOpens = (body = '안녕하세요, 민지예요') => {
  const T_ = state.tables; const id = '7f300000-0000-4000-8000-000000000001';
  if (!T_.msgr2_rooms.some((r) => r.id === id)) {
    T_.msgr2_rooms.push({ id, space_id: PM, kind: 'direct', pair_key: `p:${uid}:${mate}`, name: '', memory: true, agent_policy: 'allowed', created_by: mate, created_at: new Date().toISOString(), archived_at: null });
    for (const u of [mate, uid]) T_.msgr2_room_members.push({ room_id: id, member_kind: 'user', member_id: u, removed_at: null });
  }
  const m = { id: Math.max(0, ...T_.msgr2_messages.map((x) => x.id)) + 1, room_id: id, author_kind: 'user', author_user_id: mate, kind: 'text', body, meta: {}, mentions: [], created_at: new Date().toISOString() };
  T_.msgr2_messages.push(m);
  fire(`v2:u:${uid}`, 'rooms', { space_id: PM, room_id: id }); fire(`v2:u:${uid}`, 'msg', { message: m });
  return id;
};
// 받은 초대: 민지가 나를 다른 팀 공간(Acme 디자인)에 초대한다 — 서버처럼 목록에 넣고 나에게 invite 사건을 보낸다. ?invites=1이면 처음부터 하나 있다
const INV_CODE = 'cd'.repeat(24), INV_SPACE = '7e000000-0000-4000-8000-0000000000dd';
state.myInvites = [];
state.invited = () => { if (!state.myInvites.some((i) => i.code === INV_CODE)) state.myInvites.unshift({ invite_id: 'c2000000-0000-4000-8000-000000000001', code: INV_CODE, space_id: INV_SPACE, space_name: 'Acme 디자인', role: 'member', inviter_id: mate, inviter_name: '민지', created_at: new Date().toISOString(), expires_at: later(60 * 24 * 7) }); fire(`v2:u:${uid}`, 'invite', { invite_id: 'c2000000-0000-4000-8000-000000000001', space_id: INV_SPACE }); };
state.revokedInvites = [];
// ?invites=3: 초대 셋 — 7일 남음(Acme), 3시간 남음(Lumen, 손님), 열고 20초 뒤 만료(Orbit — 목록을 받은 뒤 만료되는 경우)
const inv = (n, name, min, role = 'member') => ({ invite_id: `c2000000-0000-4000-8000-00000000000${n}`, code: `${n}e`.repeat(24), space_id: `7e000000-0000-4000-8000-0000000000e${n}`, space_name: name, role, inviter_id: mate, inviter_name: '민지', created_at: new Date(Date.now() - n * 60_000).toISOString(), expires_at: new Date(Date.now() + min * 60_000).toISOString() });
state.revoke = (code) => { const i = state.myInvites.find((x) => x.code === code); if (i) state.revokedInvites.push(i); }; // 초대한 사람이 취소(받는 쪽에는 방송이 없다 — 다음 다시 읽기 때 빠진다)
{ const want = new URLSearchParams(globalThis.location?.search ?? '').get('invites'); if (want === '1' || want === '3') state.invited(); if (want === '3') state.myInvites.push(inv(2, 'Lumen 연구', 180, 'guest'), inv(3, 'Orbit 마케팅', 1 / 3)); }
state.pause = (on) => fire(`v2:u:${uid}`, 'pause', { paused: !!on }); // 서버 중단 스위치 대역
state.client = () => supabase; // 페이지 시험은 이 함수로 앱과 같은 대역을 쓴다(모듈을 다시 불러오면 다른 사본이 생긴다)
state.ids = { uid, mate, T, P, PM, GEN, PLAN, DM, NEWS, A, B, C, W };
// VPS 서버 연결(2026-10-23, 20261023190000) 대역 — 명령 만들기 → (자동) 서버가 보고 → 고르고 연결 → (자동) 설치 끝. ?vps=list = 연결된 서버 에이전트 둘이 있는 계정,
// ?vps=re = 같은 서버를 다시 연결(이 서버에서 안 보이는 에이전트 1개). state.vpsStep(n)으로 단계를 직접 넘길 수도 있다(캡처용). 자격 값은 가짜다.
{ const want = new URLSearchParams(globalThis.location?.search ?? '').get('vps');
  const HOST = 'srv1102938.hstgr.cloud';
  const vps = state.vps = { link: null, gets: 0, bots: [] };
  const bot = (n, name, seenMin) => ({ agent_id: `a5000000-0000-4000-8000-00000000000${n}`, kind: 'hermes', host: HOST, name, last_seen_at: seenMin == null ? null : at(seenMin), created_at: at(3000) });
  if (want === 'list' || want === 're') vps.bots.push(bot(1, 'Hermes', 3), bot(2, 'Research', want === 're' ? 4000 : null));
  const iso = (d) => new Date(d).toISOString();
  const view = () => ({ ...vps.link, expired: vps.link.status !== 'done' && Date.parse(vps.link.expires_at) < Date.now() });
  state.vpsStep = () => { const l = vps.link; if (!l) return;
    if (l.status === 'waiting') Object.assign(l, { status: 'reported', host: HOST, agents: [{ kind: 'hermes', id: 'default', name: 'Hermes', default: true }, { kind: 'hermes', id: 'marketing', name: '마케팅 담당 에이전트 이름이 긴 경우', default: false }],
      missing: want === 're' ? [{ agent_id: bot(2).agent_id, kind: 'hermes', id: 'research', name: 'Research' }] : [] });
    else if (l.status === 'approved') Object.assign(l, { status: 'done', results: l.approved.map((x) => ({ kind: x.kind, id: x.id, ok: true, detail: '' })) }); };
  Object.assign(rpcs, {
    msgr2_server_link_create: () => { if (state.free) throw Object.assign(new Error('msgr2_pro_required'), { code: '42501' }); vps.gets = 0; vps.link = { link_id: 'c5000000-0000-4000-8000-000000000001', status: 'waiting', host: null, agents: [], missing: [], approved: [], results: [], expires_at: iso(Date.now() + 15 * 60_000) }; return { link_id: vps.link.link_id, code: `argo_link_${'0f'.repeat(24)}` }; },
    msgr2_server_link_get: ({ p_link }) => { if (!vps.link || (p_link == null && !['reported', 'approved'].includes(vps.link.status))) return null; vps.gets += 1; if (new URLSearchParams(globalThis.location?.search ?? '').get('vpsauto') !== '0' && vps.gets % 3 === 0) state.vpsStep(); return view(); },
    msgr2_server_link_approve: ({ p_picks, p_retire }) => { const out = p_picks.map((x, i) => ({ ...x, agent_id: `a5000000-0000-4000-8000-00000000010${i}`, reused: x.id === 'default' && want === 're' }));
      vps.link.status = 'approved'; vps.link.approved = out; vps.bots = vps.bots.filter((b) => !(p_retire ?? []).includes(b.agent_id));
      for (const o of out) { const name = vps.link.agents.find((a) => a.id === o.id)?.name ?? o.id; if (!vps.bots.some((b) => b.name === name)) vps.bots.push({ agent_id: o.agent_id, kind: o.kind, host: HOST, name, last_seen_at: null, created_at: iso(Date.now()) });
        if (!state.tables.msgr2_agents.some((a) => a.id === o.agent_id)) state.tables.msgr2_agents.push({ id: o.agent_id, owner_user_id: uid, display_name: name, slug: `~bot.${o.kind}.${o.id}`, role_text: '', hosting: 'bot', status: 'active', created_at: iso(Date.now()) }); }
      return out; },
    msgr2_bots_mine: () => vps.bots.map((b) => ({ ...b })),
    msgr2_bot_revoke: ({ p_agent }) => { const n = vps.bots.length; vps.bots = vps.bots.filter((b) => b.agent_id !== p_agent); const a = state.tables.msgr2_agents.find((x) => x.id === p_agent); if (a) a.status = 'retired'; return vps.bots.length < n; },
  }); }
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

// 화면 보기용: HMR로 어떤 파일이 바뀌든 화면 전체를 다시 불러온다 — 가짜 서버 상태(기기 등록·방)가 모듈 교체로 날아가 '대화 목록을 불러오지 못했습니다'가 뜨던 것(총괄 실측). 앱 코드에는 영향 없음
if (import.meta.hot) { import.meta.hot.decline(); import.meta.hot.on('vite:afterUpdate', () => location.reload()); }
