// 보낸 뒤 대기 표시 화면 확인용 가짜 백엔드(instant-delivery.supabase.mjs를 바탕으로) — 자격증명·운영 클라이언트를 불러오지 않는다.
// 방(general, 공개)에 내 크루 '페퍼'가 있고, 같은 이름의 사람 '페퍼'(동명이인 안내 확인용)도 있다. 1:1 방(dm-p)은 나와 페퍼.
// ?offline=1 이면 페퍼의 마지막 접속을 10분 전으로 둔다(꺼진 기기). 게이트웨이 대역: window.__sf.typing(ch, phase?) · progress(ch, srcId) · reply(ch, body).
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const offline = new URLSearchParams(location.search).has('offline');
const channelRow = (id, kind, name) => ({ id, org_id: org, kind, name, created_by: uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: true });

const state = window.__sf = {
  latency: 120,            // 한 번의 DB 왕복에 해당하는 시간(ms)
  queries: [],             // 걸린 쿼리 기록 — 테이블별로 몇 번 갔는지 센다
  topics: {},              // 구독된 실시간 토픽 → 핸들러
  statusCbs: {},           // 토픽 → 구독 상태 콜백(끊김을 흉내낼 때 부른다)
  nextId: 200,
  tables: {
    msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: '나', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
                       { user_id: 'user-twin', org_id: org, role: 'member', display_name: '페퍼', removed_at: null }],
    msgr_channels: [channelRow('general', 'public', 'Fixture General'), channelRow('dm-p', 'dm', 'dm:페퍼')],
    msgr_channel_members: [{ channel_id: 'general', member_kind: 'user', member_id: uid }, { channel_id: 'general', member_kind: 'user', member_id: 'user-twin' }, { channel_id: 'general', member_kind: 'crew', member_id: 'crew-p' },
                           { channel_id: 'dm-p', member_kind: 'user', member_id: uid }, { channel_id: 'dm-p', member_kind: 'crew', member_id: 'crew-p' }],
    msgr_crews: [{ id: 'crew-p', org_id: org, owner_user_id: uid, slug: 'pepper', display_name: '페퍼', role_text: '모더레이터', hosting: 'resident', status: 'active', last_seen_at: offline ? new Date(Date.now() - 600_000).toISOString() : now, created_at: now, allow: 'all' }],
    msgr_target_prefs: [], msgr_channel_prefs: [],
    msgr_messages: [{ id: 101, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: uid, kind: 'text', body: '먼저 있던 글', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: 'seed-101' }],
    msgr_crew_approvals: [], msgr_attachments: [], msgr_reactions: [], msgr_reads: [],
  },
};
// 구독을 놓으면 그 채널이 걸어 둔 핸들러도 실제로 걷어낸다(실제 전송처럼).
function drop(c) { if (!c?.__own) return; const bag = state.topics[c.__topic]; if (!bag) return;
  for (const [ev, w] of c.__own) { const arr = bag[ev]; const i = arr?.indexOf(w) ?? -1; if (i >= 0) arr.splice(i, 1); }
  c.__own.length = 0; state.drops = (state.drops ?? 0) + 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 같은 조회가 같은 데이터를 돌려줄 때는 **같은 참조**를 준다. 매번 새 배열을 주면 그것을 의존성으로
// 둔 effect들이 끝없이 다시 돌아 앱이 스스로 재초기화하고, 그 과정에서 실시간 구독이 죽는다.
const memo = new Map();
function stable(key, value) {
  const json = JSON.stringify(value);
  const hit = memo.get(key);
  if (hit && hit.json === json) return hit.value;
  memo.set(key, { json, value });
  return value;
}
async function settle(call, action) { state.queries.push(call.table ?? call.rpc); await sleep(state.latency); return { data: action(), error: null }; }

function query(table) {
  let op = 'select', values, cols = '*', one = false; const filters = []; const key = []; // key = 필터의 '값'까지 — 개수만 쓰면 gt(id,0)과 gt(id,101)이 같은 키가 된다
  const api = {
    select(c = '*') { cols = c; return api; },
    eq(k, v) { key.push(['eq', k, v]); filters.push((r) => r[k] === v); return api; },
    neq(k, v) { key.push(['neq', k, v]); filters.push((r) => r[k] !== v); return api; },
    is(k, v) { key.push(['is', k, v]); filters.push((r) => (r[k] ?? null) === v); return api; },
    in(k, vs) { key.push(['in', k, vs]); filters.push((r) => vs.includes(r[k])); return api; },
    gt(k, v) { key.push(['gt', k, v]); filters.push((r) => r[k] > v); return api; },
    lt(k, v) { key.push(['lt', k, v]); filters.push((r) => r[k] < v); return api; },
    order(k, o = {}) { filters.push(Object.assign(() => true, { __order: [k, o.ascending !== false] })); return api; },
    limit(n) { filters.push(Object.assign(() => true, { __limit: n })); return api; },
    contains() { return api; }, or() { return api; }, ilike() { return api; }, like() { return api; }, not() { return api; },
    maybeSingle() { one = true; return api; }, single() { one = true; return api; },
    upsert(v) { op = 'upsert'; values = v; return api; }, update(v) { op = 'update'; values = v; return api; },
    delete() { op = 'delete'; return api; }, insert(v) { op = 'insert'; values = v; return api; },
    then(resolve, reject) {
      return settle({ table, op }, () => {
        const all = state.tables[table] ??= [];
        let rows = all.filter((r) => filters.every((f) => f(r)));
        const ord = filters.find((f) => f.__order)?.__order;
        if (ord && op === 'select') rows = [...rows].sort((a, b) => { const x = a[ord[0]], y = b[ord[0]];
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? '')); return c * (ord[1] ? 1 : -1); });
        const lim = filters.find((f) => f.__limit)?.__limit;
        if (lim != null && op === 'select') rows = rows.slice(0, lim);
        if (op === 'insert' || op === 'upsert') {
          rows = (Array.isArray(values) ? values : [values]).map((v) => {
            const row = { id: state.nextId++, org_id: org, kind: 'text', created_at: new Date().toISOString(),
              edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null, ...v };
            all.push(row); return row;
          });
        } else if (op === 'update') rows.forEach((r) => Object.assign(r, values));
        else if (op === 'delete') state.tables[table] = all.filter((r) => !rows.includes(r));
        if (table === 'msgr_channel_members' && cols.includes('msgr_channels')) rows = rows.map((r) => ({ ...r, msgr_channels: state.tables.msgr_channels.find((c) => c.id === r.channel_id) }));
        const out = structuredClone(one ? rows[0] ?? null : rows);
        if (op !== 'select') { memo.clear(); return out; } // 쓰기 뒤에는 캐시를 버린다
        return stable(`${table}|${cols}|${one}|${JSON.stringify(key)}`, out);
      }).then(resolve, reject);
    },
  };
  return api;
}

// 게이트웨이·서버 트리거 대역 — 방송을 받을 수 있는 모든 토픽(org:·ch:·dm:·u:)의 처리기에 쏜다. 앱이 글 id로 한 번만 처리한다.
const fire = (event, payload) => { for (const [topic, bag] of Object.entries(state.topics)) if (/^(org:|ch:|dm:|u:)/.test(topic)) bag[event]?.forEach((h) => h({ payload })); };
state.typing = (ch, phase) => fire('typing', { channel_id: ch, crew_id: 'crew-p', ...(phase ? { phase } : {}) });
state.progress = (ch, src) => fire('progress', { channel_id: ch, crew_id: 'crew-p', startedAt: Date.now(), source_msg_id: src ?? null });
const crewRow = (ch, body) => { const row = { id: state.nextId++, org_id: org, channel_id: ch, author_kind: 'crew', author_user_id: null, crew_id: 'crew-p', kind: 'text', body, created_at: new Date().toISOString(),
  edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: `reply:${Date.now()}` }; state.tables.msgr_messages.push(row); memo.clear(); return row; };
state.reply = (ch, body) => { const row = crewRow(ch, body); fire('message', { ...row }); return row.id; };
// 방송을 놓친 답(2026-10-07 운영: 재연결 중 u: 방송 누락) — 행만 넣고 방송은 쏘지 않는다. 열린 방은 재연결로 목록을 다시 읽을 때(아래 status로 u: 끊김→붙음)나
// 안 읽음 재집계(다른 방 글: reply('general', …))가 이 방에 모르는 글이 있다고 할 때 따라잡아야 한다.
state.replyMissed = (ch, body) => crewRow(ch, body).id;
// 안 읽음(msgr_unread와 같은 규칙) — 내 읽음 커서 뒤 남의 글·지우지 않은 글, 99 상한
const unreadRows = () => state.tables.msgr_channels.map((c) => {
  const cursor = Math.max(0, ...state.tables.msgr_reads.filter((r) => r.channel_id === c.id && r.user_id === uid).map((r) => r.last_read_id ?? 0));
  const n = state.tables.msgr_messages.filter((m) => m.channel_id === c.id && m.id > cursor && !m.deleted_at && m.author_user_id !== uid).length;
  return { channel_id: c.id, n: Math.min(99, n), mention: 0 };
}).filter((r) => r.n > 0);
// 구독이 끊겼다고 알린다(CHANNEL_ERROR·TIMED_OUT·CLOSED) — 실제 전송이 끊길 때 supabase-js가 부르는 것과 같은 자리.
state.status = (topic, status) => (state.statusCbs[topic] ?? []).forEach((cb) => cb?.(status));

export const supabase = {
  from: query,
  auth: { getSession: async () => ({ data: { session: { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name) => settle({ rpc: name }, () => (name === 'msgr_unread' ? unreadRows() : [])),
  realtime: { setAuth: async () => {}, isConnected: () => true },
  channel: (name) => { const bag = state.topics[name] ??= {}; const own = [];
    const c = { __topic: name, __own: own,
      on: (_kind, { event }, handler) => { const w = (...a) => { state.hits = (state.hits ?? 0) + 1; return handler(...a); };
        (bag[event] ??= []).push(w); own.push([event, w]); return c; },
      subscribe: (cb) => { state.subscribes = (state.subscribes ?? 0) + 1; (state.statusCbs[name] ??= []).push(cb); cb?.('SUBSCRIBED'); return c; },
      send: async () => {}, unsubscribe: async () => { drop(c); } };
    return c; },
  removeChannel: async (c) => { drop(c); return 'ok'; },
  removeAllChannels: async () => { state.topics = {}; },
  storage: { from: () => ({ remove: async () => ({ data: [], error: null }), upload: async () => ({ error: null }), list: async () => ({ data: [], error: null }) }) },
};
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
