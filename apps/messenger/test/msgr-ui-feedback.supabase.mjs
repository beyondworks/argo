// 메신저 0.1.28 실사용 제보 4건 재현용 가짜 백엔드(instant-delivery 픽스처에서 파생).
// 즉시성 실측용 가짜 백엔드. 자격증명·운영 클라이언트를 전혀 불러오지 않는다.
// 실제 왕복을 흉내내기 위해 모든 쿼리에 지연(LAT)을 건다 — 지연이 0이면 "쿼리를 줄였다"가
// 화면에서 드러나지 않는다. 방송은 하네스가 직접 쏜다(서버 트리거 대역).
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me', org = 'org-fixture', now = new Date().toISOString();
const channelRow = (id, kind, name) => ({ id, org_id: org, kind, name, created_by: uid, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: true });

// 조직 에이전트 7 — 설명이 긴 것(제보: "기록보존 (Deep", "AI-Native 조직의 마케"가 잘림)
const crew = (id, name, role) => ({ id: `crew-${id}`, org_id: org, owner_user_id: uid, slug: id, display_name: name, role_text: role, hosting: 'resident', status: 'active', last_seen_at: now, created_at: now, allow: 'all', allow_users: [] });
const CREWS = [crew('davinci', '다빈치', '디자인 리드'), crew('alfred', '알프레드', '기록보존 (Deep Archive) — 회사 문서를 장기 보관하고 검색할 수 있게 정리'),
  crew('beast', '비스트', 'AI-Native 조직의 마케팅 전략을 세우고 캠페인을 운영하는 에이전트'), crew('carmack', '카맥', '백엔드 엔지니어'),
  crew('edna', '에드나', '브랜드·의상 디자인 감독'), crew('feynman', '파인만', '리서치·실험 설계'), crew('hermes', 'Hermes', '외부 연결 담당')];
const state = window.__instant = {
  latency: 120,            // 한 번의 DB 왕복에 해당하는 시간(ms)
  queries: [],             // 걸린 쿼리 기록 — 테이블별로 몇 번 갔는지 센다
  topics: {},              // 구독된 실시간 토픽 → 핸들러
  statusCbs: {},           // 토픽 → 구독 상태 콜백(끊김을 흉내낼 때 부른다)
  nextId: 200,
  tables: {
    msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: '나', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
                       { user_id: 'user-other', org_id: org, role: 'member', display_name: '동료', removed_at: null },
                       { user_id: 'user-crystal', org_id: org, role: 'member', display_name: 'crystal', removed_at: null }],
    // 제보 상황: DM 그룹 "다빈치, crystal" — 사람 둘(나·crystal) + 에이전트 다빈치 하나

    msgr_channels: [channelRow('general', 'public', 'Fixture General'), channelRow('dm-group', 'dm', 'dm:다빈치, crystal'), channelRow('priv', 'private', '디자인 비공개')], // 비공개 채널 — 에이전트 추가 안내(ch.add.crew.note) 확인용
    msgr_channel_members: [{ channel_id: 'general', member_kind: 'user', member_id: uid },
      { channel_id: 'dm-group', member_kind: 'user', member_id: uid }, { channel_id: 'dm-group', member_kind: 'user', member_id: 'user-crystal' },
      { channel_id: 'dm-group', member_kind: 'crew', member_id: 'crew-davinci' },
      { channel_id: 'priv', member_kind: 'user', member_id: uid }, { channel_id: 'priv', member_kind: 'crew', member_id: 'crew-davinci' }],
    // 결재 카드 시나리오용 크루 하나(다른 사람 소유) — 시작 시 목록에 있어야 카드의 크루 이름이 그려진다
    msgr_crews: CREWS,
    msgr_target_prefs: [], msgr_channel_prefs: [],
    msgr_messages: [{ id: 101, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: uid, kind: 'text', body: '먼저 있던 글', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null }],
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

// 서버 트리거 대역. 실제 트리거처럼 org: 여윈 방송과 ch: 본문 방송을 **둘 다** 쏜다.
// lean만 쏘면 마이그레이션 적용 전 서버를, 둘 다 쏘면 적용 후 서버를 흉내낸다.
state.post = ({ body, author = 'user-other', withChannelTopic = true }) => {
  const row = { id: state.nextId++, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: author,
    kind: 'text', body, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null };
  state.tables.msgr_messages.push(row);
  const lean = { id: row.id, channel_id: 'general', author_kind: 'user', author_user_id: author, crew_id: null, kind: 'text', mentions: [], reply_to: null };
  const at = performance.now();
  state.topics[`org:${org}`]?.message?.forEach((h) => h({ payload: lean }));
  if (withChannelTopic) state.topics['ch:general']?.message?.forEach((h) => h({ payload: { ...lean, body: row.body, created_at: row.created_at, meta: null, client_msg_id: null } }));
  return { id: row.id, body, at };
};

// 구독이 끊겼다고 알린다(CHANNEL_ERROR·TIMED_OUT·CLOSED) — 실제 전송이 끊길 때 supabase-js가 부르는 것과 같은 자리.
state.status = (topic, status) => (state.statusCbs[topic] ?? []).forEach((cb) => cb?.(status));

export const supabase = {
  from: query,
  auth: { getSession: async () => ({ data: { session: { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name, args) => settle({ rpc: name }, () => name === 'msgr_dm_candidates'
    ? CREWS.filter((c) => !state.tables.msgr_channel_members.some((m) => m.channel_id === args?.p_channel && m.member_kind === 'crew' && m.member_id === c.id)).map((c) => ({ ...c, delivery_ready: true }))
    : []),
  realtime: { setAuth: async () => {} },
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
