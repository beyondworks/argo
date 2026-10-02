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
  aiConsentAt: null,       // 2026-09-26 시각 검증용 — App Store 5.1.2 동의 상태(msgr_profiles.ai_consent_at 대역)
  mutedCrews: new Set(),   // 2026-09-26 시각 검증용 — 숨긴 크루(msgr_user_blocks.blocked_crew 대역)
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
    msgr_channel_members: [{ channel_id: 'general', member_kind: 'user', member_id: uid }, { channel_id: 'general', member_kind: 'crew', member_id: 'crew-davinci' }, // 2026-09-26: general도 크루가 읽는 채널(AI 동의 창 검증용)
      { channel_id: 'dm-group', member_kind: 'user', member_id: uid }, { channel_id: 'dm-group', member_kind: 'user', member_id: 'user-crystal' },
      { channel_id: 'dm-group', member_kind: 'crew', member_id: 'crew-davinci' },
      { channel_id: 'priv', member_kind: 'user', member_id: uid }, { channel_id: 'priv', member_kind: 'crew', member_id: 'crew-davinci' },
      { channel_id: 'long', member_kind: 'user', member_id: uid }, { channel_id: 'long', member_kind: 'user', member_id: 'user-crystal' }, { channel_id: 'long', member_kind: 'crew', member_id: 'crew-davinci' }],
    // 결재 카드 시나리오용 크루 하나(다른 사람 소유) — 시작 시 목록에 있어야 카드의 크루 이름이 그려진다
    msgr_crews: CREWS,
    msgr_target_prefs: [], msgr_channel_prefs: [],
    msgr_messages: [{ id: 101, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: uid, kind: 'text', body: '먼저 있던 글', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null },
      { id: 102, org_id: org, channel_id: 'general', author_kind: 'crew', crew_id: 'crew-davinci', kind: 'text', body: '안녕하세요, 다빈치입니다. 무엇을 도와드릴까요?', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null }, // 크루 숨기기(App Store 1.2) 검증용
      { id: 103, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: 'user-other', kind: 'text', body: '아 진짜 fuck 이거 왜 안 되지', created_at: now, edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null }], // 부적절 표현 가리기 검증용
    msgr_crew_approvals: [], msgr_attachments: [], msgr_reactions: [], msgr_reads: [],
  },
};
// 주소로 보는 사람을 바꾼다 — ?role=member(관리자 아닌 멤버) ·&host=0(어느 채널의 방장도 아님: 초대 버튼 대신 관리자 안내) ·&nochannels=1(참여한 채널 0개: 빈 상태 안전망) ·&empty=1(막 만든 조직) ·&noorg=1(조직 없음) ·&nocrews=1(에이전트 0) ·&noname=1(이름 = 이메일 앞부분) ·&loggedout=1(세션 없음 — 로그인 화면)
{ const sp = new URLSearchParams(globalThis.location?.search ?? '');
  if (sp.get('role')) { state.tables.msgr_org_members[0].role = sp.get('role'); state.tables.msgr_org_members[1].role = 'owner'; } // 소유자는 늘 있다 — 동료가 맡는다
  if (sp.get('host') === '0') state.tables.msgr_channels.forEach((c) => { c.created_by = 'user-other'; }); // 방장도 아님 → 초대 버튼 대신 관리자 안내
  if (sp.get('nochannels')) { state.tables.msgr_channel_members = state.tables.msgr_channel_members.filter((m) => m.member_id !== uid);
    state.tables.msgr_channels = state.tables.msgr_channels.filter((c) => c.kind === 'public'); } // 비공개·DM은 멤버가 아니면 서버(RLS)가 안 보여 준다
  if (sp.get('empty')) { const T = state.tables; // &empty=1 막 만든 조직: 채널·다른 멤버·에이전트 0(시작 단계 안내 D1·D3·D6)
    T.msgr_channels = []; T.msgr_channel_members = []; T.msgr_messages = []; T.msgr_crews = []; T.msgr_org_members = T.msgr_org_members.filter((m) => m.user_id === uid); }
  if (sp.get('noorg')) state.tables.msgr_org_members = [];
  if (sp.get('nocrews')) state.tables.msgr_crews = [];
  if (sp.get('noname')) state.tables.msgr_org_members[0].display_name = sp.get('noname') === 'empty' ? null : 'fixture'; // &noname=1 표시 이름 = 이메일 앞부분(가입 기본값, D5) · =empty 비어 있음
  if (sp.get('gap')) { const T = state.tables; const msg = (id, who, body) => ({ id, org_id: org, channel_id: 'general', author_kind: 'user', author_user_id: who, kind: 'text', body, created_at: new Date(Date.parse(now) + (id - 100) * 1000).toISOString(), edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null });
    // 글 시각은 1초씩 — 같은 시각이면 폰 조회 순서가 뒤집힌다
    // &gap=1 간격 장면(2026-10-02 유건 제보 재현): 같은 사람이 이어 보낸 글 9개 + 그 사이 '새 메시지' 구분선(읽음 커서 114) + 내 글 3개
    for (let i = 1; i <= 9; i++) T.msgr_messages.push(msg(109 + i, 'user-crystal', `마케팅 뱃지 점검 ${i}`));
    for (let i = 1; i <= 3; i++) T.msgr_messages.push(msg(118 + i, uid, `확인했어요 ${i}`));
    T.msgr_reads.push({ channel_id: 'general', user_id: uid, last_read_id: 114 }); state.aiConsentAt = now; } // 동의 창 없이 바로 대화
  // &mix=1(gap=1과 함께) 섞인 방(2026-10-02 상대 말풍선·턴 끝 동작 줄 확인): 에이전트 카드 · 사진+글 → 사진만(같은 턴) · 다른 사람 한 줄 · 내 글 → 내 사진만(같은 턴)
  if (sp.get('gap') && sp.get('mix')) { const T = state.tables; const at = (id) => new Date(Date.parse(now) + (id - 100) * 1000).toISOString();
    const row = (id, extra) => ({ id, org_id: org, channel_id: 'general', kind: 'text', created_at: at(id), edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null, ...extra });
    T.msgr_messages.push(row(122, { author_kind: 'crew', crew_id: 'crew-davinci', body: '시안 두 개 정리했어요.\n\n- A안: 뱃지를 카드 오른쪽 위로\n- B안: 제목 옆 작은 점으로' }),
      row(123, { author_kind: 'user', author_user_id: 'user-crystal', body: '현장 사진 공유드려요' }), row(124, { author_kind: 'user', author_user_id: 'user-crystal', body: '' }),
      row(125, { author_kind: 'user', author_user_id: 'user-other', body: '좋네요 👍' }),
      row(126, { author_kind: 'user', author_user_id: uid, body: 'A안으로 가죠' }), row(127, { author_kind: 'user', author_user_id: uid, body: '' }));
    T.msgr_attachments.push({ id: 'att-123', message_id: 123, storage_path: 'fixture/photo-a.svg', name: 'site-a.svg', mime: 'image/svg+xml', bytes: 2048 },
      { id: 'att-124', message_id: 124, storage_path: 'fixture/photo-b.svg', name: 'site-b.svg', mime: 'image/svg+xml', bytes: 2048 },
      { id: 'att-127', message_id: 127, storage_path: 'fixture/photo-c.svg', name: 'mine-c.svg', mime: 'image/svg+xml', bytes: 2048 }); }
  // &approvals=1 폰 결재 페이지(분리 검수 M-2·M-3, 2026-10-02): 꼭 확인 긴 셸 명령 · 꼭 확인 + 쉬운 문장 · 보통 + 쉬운 문장 · 남의 크루 일반 결재(결정 못 함 — 숫자·목록에서 빠진다)
  //   · 서버가 거절하는 꼭 확인(화면 판정은 결정 가능, 승인하면 RLS 42501 — 버튼 대신 안내). &role=member와 함께 쓰면 꼭 확인은 정책(관리자)에 따라 빠진다
  if (sp.get('approvals')) { const T = state.tables; const at = (m) => new Date(Date.parse(now) - m * 60_000).toISOString();
    T.msgr_crews.push({ ...crew('nova', '노바', '재무 정리'), owner_user_id: 'user-other' });
    const row = (id, crewId, risk, action, extra = {}) => ({ id, org_id: org, channel_id: 'general', crew_id: crewId, approval_id: id, action, reason: null, payload: null, risk, kind: 'action', status: 'pending', decided_by: null, decided_at: null, message_id: null, created_at: at(Number(id.slice(3))), ...extra });
    T.msgr_crew_approvals.push(
      row('ap-1', 'crew-carmack', 'high', 'rm -rf ./dist ./build && npm ci --ignore-scripts && npm run build -- --mode production && rsync -avz --delete ./dist/ deploy@prod-web-01.example.internal:/srv/www/argo/releases/2026-10-02/ && ssh deploy@prod-web-01.example.internal "ln -sfn /srv/www/argo/releases/2026-10-02 /srv/www/argo/current && sudo systemctl reload nginx"', { payload: { shell: true }, reason: '배포 서버에 새 빌드를 올립니다' }),
      row('ap-2', 'crew-beast', 'high', 'sendGmail(to=subscribers@list, template=october-newsletter, schedule=now)', { payload: { plain: { purpose: '이번 달 뉴스레터 발송', task: '구독자 1,200명에게 10월 뉴스레터 메일 보내기', need: 'Gmail 보내기 권한' } } }),
      row('ap-3', 'crew-davinci', 'low', 'figma.export(frames=["landing-hero","pricing"], format=png, scale=2)', { payload: { plain: { purpose: '랜딩 시안 공유', task: '랜딩 두 화면을 PNG로 내보내기' } } }),
      row('ap-4', 'crew-nova', 'low', 'ledger.close(month=2026-09)', { payload: { plain: { task: '9월 장부 마감' } } }),
      row('ap-5', 'crew-feynman', 'high', 'notion.delete_page(id=research-archive-2025)', { payload: { plain: { purpose: '오래된 연구 기록 정리', task: '2025 연구 기록 페이지 지우기' } } }));
    T.msgr_crew_approvals.forEach((a, i) => { const id = 130 + i; a.message_id = id; // 데스크톱 슬립은 결재 카드 글(approval_card)에 붙는다 — 데스크톱 화면이 그대로인지 같이 본다
      T.msgr_messages.push({ id, org_id: org, channel_id: 'general', author_kind: 'crew', crew_id: a.crew_id, kind: 'approval_card', body: a.action, created_at: a.created_at, edited_at: null, deleted_at: null, mentions: [{ kind: 'approval', id: a.id }], reply_to: null, meta: null, client_msg_id: null }); });
    T.msgr_org_policies = [{ org_id: org, approval_high_by: 'admin', approver_user_ids: [] }];
    state.denyApprovals = new Set(['ap-5']); // 서버(RLS)가 거절하는 결재 — 화면 판정과 서버가 어긋나는 경우의 안내 확인용
    state.aiConsentAt = now; }
  // &groups=1 채널 탭 그룹(분리 검수 M-4): '운영' 그룹에 비공개 채널 둘 — 그룹 메뉴를 고른 채로 검색하면 다른 채널·대화도 찾아야 한다
  if (sp.get('groups')) { state.tables.msgr_channel_groups = [{ id: 'g-ops', user_id: uid, org_id: org, name: '운영', pos: 0, created_at: now, msgr_channel_group_links: [{ channel_id: 'priv' }, { channel_id: 'long' }] }]; state.aiConsentAt = now; }
  state.loggedOut = !!sp.get('loggedout'); } // &loggedout=1 세션 없음 — 로그인 화면(3차 검수 M-2 시각 확인용, 2026-09-27)
 // &noorg=1 조직 없는 첫 화면(D4)
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
        if (op === 'upsert' && table === 'msgr_channel_group_links' && state.failLinks) throw Object.assign(new Error('fetch failed'), { code: 'FIXTURE' }); // 그룹에 채널 넣기 실패 대역(분리 검수 L-4)
        if (op === 'insert' || op === 'upsert') {
          rows = (Array.isArray(values) ? values : [values]).map((v) => {
            const row = { id: state.nextId++, org_id: org, kind: 'text', created_at: new Date().toISOString(),
              edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null, ...v };
            all.push(row); return row;
          });
        } else if (op === 'update') {
          if (table === 'msgr_crew_approvals' && rows.some((r) => state.denyApprovals?.has(r.id))) throw Object.assign(new Error('new row violates row-level security policy for table "msgr_crew_approvals"'), { code: '42501' }); // with check 거절 대역
          rows.forEach((r) => Object.assign(r, values));
        }
        else if (op === 'delete') state.tables[table] = all.filter((r) => !rows.includes(r));
        if (table === 'msgr_crew_approvals' && cols.includes('msgr_crews(')) rows = rows.map((r) => ({ ...r, msgr_crews: (({ owner_user_id }) => ({ owner_user_id }))(state.tables.msgr_crews.find((c) => c.id === r.crew_id) ?? {}) })); // 외래 키 임베드 대역
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

// 가짜 사진 — 경로마다 다른 색의 4:3 그림(data URL). 외부 요청이 없다
const fixturePhoto = (path) => { const hue = [...String(path)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="hsl(${hue} 45% 62%)"/><circle cx="360" cy="110" r="46" fill="hsl(${hue} 60% 85%)"/><path d="M0 300 L150 170 L260 260 L340 200 L480 320 L480 360 L0 360 Z" fill="hsl(${hue} 35% 38%)"/></svg>`)}`; };
export const supabase = {
  from: query,
  auth: { getSession: async () => ({ data: { session: state.loggedOut ? null : { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name, args) => settle({ rpc: name }, () => (state.rpcs ??= []).push({ name, args }) && name === 'msgr_accept_invite' ? state.acceptInvite(args?.code)
    : name === 'msgr_invite_preview' ? state.invitePreview(args?.code) : name === 'msgr_accept_invite_v2' ? state.acceptInviteV2(args?.code) : name === 'msgr_invite_revoke' ? state.inviteRevoke(args?.invite)
    : name === 'msgr_create_channel' ? (() => { const id = `ch-${state.nextId++}`; // 서버와 같은 모양 — 만든 사람 참여 행은 비공개·DM만(20260903120000: kind <> 'public')
      state.tables.msgr_channels.push({ ...channelRow(id, args.kind, args.name), created_by: uid });
      if (args.kind !== 'public') state.tables.msgr_channel_members.push({ channel_id: id, member_kind: 'user', member_id: uid }); return id; })()
    : name === 'msgr_join_channel' ? (() => { const has = state.tables.msgr_channel_members.some((m) => m.channel_id === args.ch && m.member_kind === 'user' && m.member_id === uid);
      if (!has) state.tables.msgr_channel_members.push({ channel_id: args.ch, member_kind: 'user', member_id: uid }); state.joins = (state.joins ?? 0) + 1; return null; })()
    : name === 'msgr_dm_candidates'
    ? CREWS.filter((c) => !state.tables.msgr_channel_members.some((m) => m.channel_id === args?.p_channel && m.member_kind === 'crew' && m.member_id === c.id)).map((c) => ({ ...c, delivery_ready: true }))
    // 2026-09-26 시각 검증용 대역 — App Store 5.1.2(AI 동의)·1.2(크루 숨기기)
    : name === 'msgr_my_ai_consent' ? state.aiConsentAt
    : name === 'msgr_set_ai_consent' ? (state.aiConsentAt = args?.consent ? new Date().toISOString() : null)
    : name === 'msgr_my_muted_crews' ? [...state.mutedCrews].map((id) => ({ crew_id: id, display_name: CREWS.find((c) => c.id === id)?.display_name ?? '', created_at: now }))
    : name === 'msgr_mute_crew' ? (state.mutedCrews.add(args?.crew), null)
    : name === 'msgr_unmute_crew' ? (state.mutedCrews.delete(args?.crew), null)
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
  storage: { from: () => ({ remove: async () => ({ data: [], error: null }), upload: async () => ({ error: null }), list: async () => ({ data: [], error: null }),
    createSignedUrl: async (path) => ({ data: { signedUrl: fixturePhoto(path) }, error: null }) }) }, // 사진 첨부 장면(&mix=1) — 네트워크 없이 그리는 그림 주소
};
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
