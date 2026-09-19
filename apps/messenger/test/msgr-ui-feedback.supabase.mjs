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
  live: new Set(),         // 만들어졌고 아직 걷히지 않은 채널(supabase.getChannels 대역 — 고아 구독 집계)
  authDelay: 0,            // realtime.setAuth 지연(ms) — 방을 빠르게 옮길 때 정리가 setAuth보다 먼저 끝나는 경쟁을 재현한다
  statusCbs: {},           // 토픽 → 구독 상태 콜백(끊김을 흉내낼 때 부른다)
  nextId: 200,
  tables: {
    msgr_org_members: [{ user_id: uid, org_id: org, role: 'owner', display_name: '나', removed_at: null, msgr_orgs: { id: org, name: 'Fixture Organization', slug: 'fixture', owner_user_id: uid } },
                       { user_id: 'user-other', org_id: org, role: 'member', display_name: '동료', removed_at: null },
                       { user_id: 'user-crystal', org_id: org, role: 'member', display_name: 'crystal', removed_at: null }],
    // 제보 상황: DM 그룹 "다빈치, crystal" — 사람 둘(나·crystal) + 에이전트 다빈치 하나

    msgr_channels: [channelRow('general', 'public', 'Fixture General'), channelRow('dm-group', 'dm', 'dm:다빈치, crystal'), { ...channelRow('priv', 'private', '디자인 비공개'), topic: '제품 출시 준비 — 이번 주 목표와 결정 사항을 여기에 모읍니다' },
      channelRow('lounge', 'public', 'Lounge'), channelRow('lounge2', 'public', 'Lounge Two'), // 참여 안 한 공개 채널 — 초대 코드 가입(lounge)·남이 나를 추가(lounge2) 뒤 사이드바 확인용
      { ...channelRow('long', 'private', '2026 하반기 제품 출시 준비와 파트너 협업 채널'), topic: 'Launch readiness, partner onboarding and weekly decisions — keep everything for the release here' }], // 긴 이름·긴 주제 — 상단 바 접힘 확인용. 비공개 채널 — 에이전트 추가 안내(ch.add.crew.note) 확인용
    msgr_channel_members: [{ channel_id: 'general', member_kind: 'user', member_id: uid },
      { channel_id: 'dm-group', member_kind: 'user', member_id: uid }, { channel_id: 'dm-group', member_kind: 'user', member_id: 'user-crystal' },
      { channel_id: 'dm-group', member_kind: 'crew', member_id: 'crew-davinci' },
      { channel_id: 'priv', member_kind: 'user', member_id: uid }, { channel_id: 'priv', member_kind: 'crew', member_id: 'crew-davinci' },
      { channel_id: 'long', member_kind: 'user', member_id: uid }, { channel_id: 'long', member_kind: 'user', member_id: 'user-crystal' }, { channel_id: 'long', member_kind: 'crew', member_id: 'crew-davinci' }],
    // 결재 카드 시나리오용 크루 하나(다른 사람 소유) — 시작 시 목록에 있어야 카드의 크루 이름이 그려진다
    msgr_crews: CREWS,
    msgr_target_prefs: [], msgr_channel_prefs: [],
    msgr_messages: [{ id: 101, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: uid, kind: 'text', body: '먼저 있던 글', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null }],
    msgr_crew_approvals: [], msgr_attachments: [], msgr_reactions: [], msgr_reads: [],
  },
};
// 주소로 보는 사람을 바꾼다 — ?role=member(관리자 아닌 멤버) ·&host=0(어느 채널의 방장도 아님: 초대 버튼 대신 관리자 안내) ·&nochannels=1(참여한 채널 0개: 빈 상태 안전망) ·&empty=1(막 만든 조직) ·&noorg=1(조직 없음) ·&nocrews=1(에이전트 0)
{ const sp = new URLSearchParams(globalThis.location?.search ?? '');
  if (sp.get('role')) { state.tables.msgr_org_members[0].role = sp.get('role'); state.tables.msgr_org_members[1].role = 'owner'; } // 소유자는 늘 있다 — 동료가 맡는다
  if (sp.get('host') === '0') state.tables.msgr_channels.forEach((c) => { c.created_by = 'user-other'; }); // 방장도 아님 → 초대 버튼 대신 관리자 안내
  if (sp.get('nochannels')) { state.tables.msgr_channel_members = state.tables.msgr_channel_members.filter((m) => m.member_id !== uid);
    state.tables.msgr_channels = state.tables.msgr_channels.filter((c) => c.kind === 'public'); } // 비공개·DM은 멤버가 아니면 서버(RLS)가 안 보여 준다
  if (sp.get('empty')) { const T = state.tables; // &empty=1 막 만든 조직: 채널·다른 멤버·에이전트 0(시작 단계 안내 D1·D3·D6)
    T.msgr_channels = []; T.msgr_channel_members = []; T.msgr_messages = []; T.msgr_crews = []; T.msgr_org_members = T.msgr_org_members.filter((m) => m.user_id === uid); }
  if (sp.get('noorg')) state.tables.msgr_org_members = [];
  if (sp.get('nocrews')) state.tables.msgr_crews = []; } // &noorg=1 조직 없는 첫 화면(D4)
// 구독을 놓으면 그 채널이 걸어 둔 핸들러도 실제로 걷어낸다(실제 전송처럼).
function drop(c) { state.live.delete(c); if (!c?.__own) return; const bag = state.topics[c.__topic]; if (!bag) return;
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
async function settle(call, action) { state.queries.push(call.table ?? call.rpc); await sleep(state.latency);
  try { return { data: action(), error: null }; } catch (e) { if (!e.code) throw e; return { data: null, error: { code: e.code, message: e.message } }; } } // 코드가 있는 오류는 PostgREST처럼 {error}로(옛 서버 폴백 판정용)

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
        if (op === 'insert' && table === 'msgr_invites') values = state.inviteInsert(values);
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

export const JOIN_CODE = '0123456789abcdef'.repeat(3); // parseInviteCode는 48자리 16진수만 받는다
// 초대 코드 가입 대역 — JOIN_CODE면 나를 공개 채널 lounge의 사람 멤버로 넣고 조직 id를 돌려준다(서버 msgr_accept_invite와 같은 반환형)
state.acceptInvite = (code) => {
  const inv = code === JOIN_CODE ? { channel_ids: ['lounge'] } : state.tables.msgr_invites?.find((i) => i.code === code);
  if (!inv) throw Object.assign(new Error('msgr_invite_invalid'), { code: 'P0001' });
  (inv.channel_ids ?? (inv.channel_id ? [inv.channel_id] : [])).forEach((id) => state.addMember(id)); return org;
};
// 초대 개편(0.1.30) 대역 — 새 서버(#610) 모양. noV2 = 새 열·RPC가 없는 옛 서버(앱이 옛 흐름으로 물러나는지 본다)
state.noV2 = false;
const missing = (what, code = 'PGRST202') => Object.assign(new Error(`Could not find the ${what} in the schema cache`), { code });
state.inviteInsert = (v) => {
  if (state.noV2 && 'channel_ids' in v) throw missing("'channel_ids' column of 'msgr_invites'", 'PGRST204');
  if (v.role === 'guest' && (v.channel_ids ?? [v.channel_id].filter(Boolean)).length !== 1) throw Object.assign(new Error('msgr_invite_guest_one_channel'), { code: '22023' }); // 서버 msgr_invite_prepare와 같은 거절
  const code = Array.from({ length: 48 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  return { expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), use_count: 0, revoked_at: null, ...v, code };
};
const inviteOf = (code) => code === JOIN_CODE ? { role: 'member', channel_ids: ['lounge'], created_by: 'user-other', expires_at: null } : state.tables.msgr_invites?.find((i) => i.code === code);
const joinedHere = (id) => state.tables.msgr_channel_members.some((m) => m.channel_id === id && m.member_kind === 'user' && m.member_id === uid);
state.invitePreview = (code) => {
  if (state.noV2) throw missing('function public.msgr_invite_preview(code)');
  const inv = inviteOf(code); if (!inv) throw Object.assign(new Error('msgr_invite_not_found'), { code: 'P0001' });
  const chs = (inv.channel_ids ?? []).map((id) => state.tables.msgr_channels.find((c) => c.id === id)).filter(Boolean).map(({ id, name, kind }) => ({ id, name, kind }));
  const inviter = state.tables.msgr_org_members.find((m) => m.user_id === inv.created_by)?.display_name ?? null;
  return { state: chs.length && chs.every((c) => joinedHere(c.id)) ? 'already_member' : 'valid', org_id: org, org_name: 'Fixture Organization', channels: chs, inviter_name: inviter, role: inv.role, expires_at: inv.expires_at };
};
state.acceptInviteV2 = (code) => {
  if (state.noV2) throw missing('function public.msgr_accept_invite_v2(code)');
  const inv = inviteOf(code); if (!inv) throw Object.assign(new Error('msgr_invite_not_found'), { code: 'P0001' });
  (inv.channel_ids ?? []).forEach((id) => state.addMember(id));
  if (inv.use_count != null) inv.use_count += 1;
  return { org_id: org, channel_id: inv.channel_ids?.[0] ?? null, joined_channel_ids: inv.channel_ids ?? [], skipped_channel_ids: [] };
};
state.inviteRevoke = (id) => {
  if (state.noV2) throw missing('function public.msgr_invite_revoke(invite)');
  const inv = state.tables.msgr_invites?.find((i) => i.id === id); if (inv) inv.revoked_at = new Date().toISOString(); memo.clear(); return null;
};
// 다른 사람이 나를 채널에 넣은 것 — 앱을 거치지 않고 표만 바꾼다. 캐시(memo)를 비워야 다음 조회가 새 행을 본다
state.addMember = (channel_id, clear = true) => {
  if (!state.tables.msgr_channel_members.some((m) => m.channel_id === channel_id && m.member_kind === 'user' && m.member_id === uid))
    state.tables.msgr_channel_members.push({ channel_id, member_kind: 'user', member_id: uid });
  if (clear) memo.clear();
};

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
  rpc: async (name, args) => settle({ rpc: name }, () => name === 'msgr_accept_invite' ? state.acceptInvite(args?.code)
    : name === 'msgr_invite_preview' ? state.invitePreview(args?.code) : name === 'msgr_accept_invite_v2' ? state.acceptInviteV2(args?.code) : name === 'msgr_invite_revoke' ? state.inviteRevoke(args?.invite)
    : name === 'msgr_create_channel' ? (() => { const id = `ch-${state.nextId++}`; // 서버와 같은 모양 — 만든 사람 참여 행은 비공개·DM만(20260903120000: kind <> 'public')
      state.tables.msgr_channels.push({ ...channelRow(id, args.kind, args.name), created_by: uid });
      if (args.kind !== 'public') state.tables.msgr_channel_members.push({ channel_id: id, member_kind: 'user', member_id: uid }); return id; })()
    : name === 'msgr_join_channel' ? (() => { const has = state.tables.msgr_channel_members.some((m) => m.channel_id === args.ch && m.member_kind === 'user' && m.member_id === uid);
      if (!has) state.tables.msgr_channel_members.push({ channel_id: args.ch, member_kind: 'user', member_id: uid }); state.joins = (state.joins ?? 0) + 1; return null; })()
    : name === 'msgr_dm_candidates'
    ? CREWS.filter((c) => !state.tables.msgr_channel_members.some((m) => m.channel_id === args?.p_channel && m.member_kind === 'crew' && m.member_id === c.id)).map((c) => ({ ...c, delivery_ready: true }))
    : []),
  realtime: { setAuth: async () => { if (state.authDelay) await new Promise((r) => setTimeout(r, state.authDelay)); } },
  getChannels: () => [...state.live].map((c) => ({ topic: `realtime:${c.__topic}` })),
  channel: (name) => { const bag = state.topics[name] ??= {}; const own = [];
    const c = { __topic: name, __own: own,
      on: (_kind, { event }, handler) => { const w = (...a) => { state.hits = (state.hits ?? 0) + 1; return handler(...a); };
        (bag[event] ??= []).push(w); own.push([event, w]); return c; },
      subscribe: (cb) => { state.subscribes = (state.subscribes ?? 0) + 1; (state.statusCbs[name] ??= []).push(cb); cb?.('SUBSCRIBED'); return c; },
      send: async () => {}, unsubscribe: async () => { drop(c); } };
    state.live.add(c); return c; },
  removeChannel: async (c) => { drop(c); return 'ok'; },
  removeAllChannels: async () => { state.topics = {}; state.live.clear(); },
  storage: { from: () => ({ remove: async () => ({ data: [], error: null }), upload: async () => ({ error: null }), list: async () => ({ data: [], error: null }) }) },
};
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
