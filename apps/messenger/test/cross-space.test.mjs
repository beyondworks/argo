import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSpaceTotals, readableForNotify, seenOnce, badgeTotal, spaceOf, spaceKey, joinWithBackoff } from '../src/cross-space.mjs';

// 가짜 supabase — rpc와 from().select().eq().is().maybeSingle() 체인만. 호출 기록을 남긴다.
function fakeSb({ rpcs = {}, rows = {} } = {}) {
  const calls = [];
  const from = (table) => {
    const filters = {};
    const chain = {
      select() { return chain; },
      eq(k, v) { filters[k] = v; return chain; },
      is(k, v) { filters[k] = v; return chain; },
      async maybeSingle() { calls.push(['from', table, { ...filters }]); return { data: (rows[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))) ?? null }; },
    };
    return chain;
  };
  // rpc는 실제 supabase-js처럼 then만 있는 thenable을 돌려준다(catch 없음 — 이 차이로 합계가 늘 조용히 실패했다, 실측 2026-09-18)
  const thenable = (fn) => ({ then: (ok, bad) => Promise.resolve().then(fn).then(ok, bad) });
  return { calls, from, rpc(name, args) { calls.push(['rpc', name, args]); const f = rpcs[name]; return thenable(() => (f ? f(args) : { data: null, error: { code: 'PGRST202', message: `function ${name} not found` } })); } };
}

test('공간별 합계: 서버에 msgr_unread_totals가 있으면 한 번에 쓴다(org_id null = 개인 공간)', async () => {
  const sb = fakeSb({ rpcs: { msgr_unread_totals: () => ({ data: [{ org_id: 'o1', n: 3, mention: 1 }, { org_id: null, n: 2, mention: 0 }] }) } });
  const r = await loadSpaceTotals(sb, ['o1', 'o2']);
  assert.equal(r.source, 'rpc');
  assert.deepEqual(r.totals, { o1: { n: 3, mention: 1 }, personal: { n: 2, mention: 0 } });
  assert.equal(sb.calls.filter((c) => c[1] === 'msgr_unread').length, 0, '공간별 조회를 하지 않는다');
});

test('공간별 합계: 합계 RPC가 없는 서버(라이브 적용 전)는 공간마다 기존 msgr_unread로 세어 합친다 — 음소거 채널 제외', async () => {
  const per = { o1: [{ channel_id: 'a', n: 2, mention: 1 }, { channel_id: 'muted', n: 9, mention: 0 }], o2: [], null: [{ channel_id: 'p', n: 1, mention: 0 }] };
  const sb = fakeSb({ rpcs: { msgr_unread: ({ org }) => ({ data: per[org] }) } });
  const r = await loadSpaceTotals(sb, ['o1', 'o2'], new Set(['muted']));
  assert.equal(r.source, 'fallback');
  assert.deepEqual(r.totals, { o1: { n: 2, mention: 1 }, personal: { n: 1, mention: 0 } }, '음소거 9건은 빠지고, 0인 공간은 싣지 않는다');
  assert.deepEqual(sb.calls.filter((c) => c[1] === 'msgr_unread').map((c) => c[2].org).sort(), ['o1', 'o2', null].sort(), '모든 조직 + 개인(null)을 센다');
});

test('공간별 합계: 조회가 던져도(네트워크) 앱이 죽지 않고 빈 합계로 물러난다', async () => {
  const sb = { rpc: () => ({ then: (ok, bad) => Promise.reject(new Error('fetch failed')).then(ok, bad) }) }; // 실제 빌더 모양(catch 없음)
  const r = await loadSpaceTotals(sb, ['o1']);
  assert.deepEqual(r, { source: 'fallback', totals: {} });
});

test('알림 전 확인: 내 권한으로 읽을 수 없는 글(내가 없는 방)은 null — 알림을 내지 않는다', async () => {
  const sb = fakeSb({ rows: { msgr_messages: [] } }); // RLS가 가린 결과 = 행 없음
  assert.equal(await readableForNotify(sb, { id: 640, channel_id: 'bc-dm', author_kind: 'user', author_user_id: 'B', kind: 'text' }, 'o1'), null);
});

test('알림 전 확인: 읽히는 글은 본문·채널 이름·작성자 이름을 채운다 — 조직은 조직 표시 이름, 개인은 프로필, 크루는 크루 이름', async () => {
  const rows = {
    msgr_messages: [{ id: 1, body: '안녕', channel_id: 'c1', deleted_at: null, msgr_channels: { name: 'general', kind: 'public' } }, { id: 2, body: '', channel_id: 'p1', deleted_at: null, msgr_channels: { name: 'DM', kind: 'dm' } }],
    msgr_org_members: [{ org_id: 'o1', user_id: 'B', display_name: '비(조직)' }],
    msgr_profiles: [{ user_id: 'B', display_name: '비(프로필)' }],
    msgr_crews: [{ id: 'k1', display_name: '서윤' }],
  };
  const sb = fakeSb({ rows });
  const org = await readableForNotify(sb, { id: 1, author_kind: 'user', author_user_id: 'B' }, 'o1');
  assert.deepEqual([org.body, org.channel_name, org.channel_kind, org.author_name], ['안녕', 'general', 'public', '비(조직)']);
  const personal = await readableForNotify(sb, { id: 2, author_kind: 'user', author_user_id: 'B' }, null);
  assert.equal(personal.author_name, '비(프로필)');
  assert.equal(personal.channel_kind, 'dm');
  const crew = await readableForNotify(sb, { id: 1, author_kind: 'crew', crew_id: 'k1' }, 'o1');
  assert.equal(crew.author_name, '서윤');
});

test('중복 제거: 같은 글이 두 토픽(dm:·u:)으로 와도 한 번만', () => {
  const seen = new Set();
  assert.equal(seenOnce(seen, 7), true); assert.equal(seenOnce(seen, 7), false); assert.equal(seenOnce(seen, 8), true);
  for (let i = 100; i < 110; i++) seenOnce(seen, i, 5);
  assert.equal(seen.size, 5, '기억은 cap개로 제한');
});

test('독 배지: 보고 있는 공간은 채널별 안 읽음(음소거 제외), 다른 공간은 합계 — 보고 있는 공간을 두 번 세지 않는다', () => {
  const current = { a: { n: 2 }, m: { n: 5 } };
  const totals = { o1: { n: 7 }, o2: { n: 3 }, personal: { n: 1 } };
  assert.equal(badgeTotal({ current, currentKey: 'o1', muted: new Set(['m']), totals }), 2 + 3 + 1);
  assert.equal(spaceKey(null), 'personal'); assert.equal(spaceOf({ org_id: null }), null); assert.equal(spaceOf({ org_id: 'x' }, 'o9'), 'o9');
});

test('App.jsx 배선: 소속 조직 전부의 org: 토픽과 u:<나> 토픽을 구독하고, 알림은 readableForNotify를 거친다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /supabase\.channel\(`u:\$\{uid\}`/, 'u:<나> 구독');
  assert.match(app, /orgs\.filter\(\(o\) => o\.id !== orgId\)\.map\(\(o\) => supabase\.channel\(`org:\$\{o\.id\}`/, '보고 있지 않은 조직의 org: 구독');
  // 알림 전 읽힘 확인 — 알릴 상황(shouldNotify)일 때만 조회. D55부터 건너뛴 이유를 진단에 남긴다(notifySkip → 'viewing'은 shouldNotify 거짓)
  assert.match(app, /const notifySkip = \(payload\) => \{[^\n]*return shouldNotify\(payload\.channel_id\) \? '' : 'viewing'; \};/);
  const body = app.slice(app.indexOf('const notifyReadable = (payload, space) => {'), app.indexOf('const notifyApproval'));
  assert.ok(body.indexOf("if (skip) { pushDiag('notify', `${tag} skip:${skip}`); return; }") > 0 && body.indexOf('if (skip)') < body.indexOf('readableForNotify('), '건너뛸 상황이면 조회 전에 돌아간다');
  assert.match(body, /if \(!payload \|\| payload\.author_user_id === uid\) return;/, '내 글은 알리지 않는다');
  assert.match(app, /crossRef\.current = \(payload, space\) => \{[\s\S]{0,200}seenOnce\(seenMsgRef\.current, payload\.id\)/, '다른 공간 처리기도 id로 한 번만(이중 송신 대비)');
  assert.match(app, /handleMessageRef\.current = \(payload\) => \{\s*if \(!seenOnce\(seenMsgRef\.current, payload\?\.id\)\) return;/, '보고 있는 공간 처리기도 id로 한 번만');
});

test('폰 홈 조직 전환 버튼: min-width:0 — 배지가 붙어도 자리 안에서 멈추고 이름만 말줄임(검수 #605, 측정은 test/org-badge-phone.browser.mjs)', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.msgr-phone\.phone-home \.msgr-side \.msgr-org \{[^}]*\bmin-width: 0;/);
});

test('u: 구독 백오프: 거절(CHANNEL_ERROR)되면 채널을 걷고 1분→2분→…→최대 10분 뒤에만 다시 붙는다, 붙으면 간격 초기화, 멈추면 예약·채널 모두 걷힌다', () => {
  const made = []; const removed = []; const timers = [];
  const sb = { realtime: { isConnected: () => true }, removeChannel: (c) => { removed.push(c.n); return Promise.resolve('ok'); } };
  const make = () => { const c = { n: made.length, subscribe(cb) { c.cb = cb; return c; } }; made.push(c); return c; };
  const stop = joinWithBackoff(sb, make, { timer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: (id) => { if (id) timers[id - 1].cleared = true; } });
  assert.equal(made.length, 1, '처음엔 바로 붙는다');
  const rejected = () => new Error('Unauthorized', { cause: { reason: 'Unauthorized: you do not have permissions' } }); // 가입 거절 = 서버 응답이 cause
  const fail = () => made.at(-1).cb('CHANNEL_ERROR', rejected());
  for (let i = 0; i < 6; i++) { fail(); timers.at(-1).fn(); }
  assert.deepEqual(timers.map((x) => x.ms), [60_000, 120_000, 240_000, 480_000, 600_000, 600_000], '두 배씩, 10분 상한');
  assert.deepEqual(removed, [0, 1, 2, 3, 4, 5], '거절된 채널은 매번 걷는다(realtime-js 자체 재시도 차단)');
  made.at(-1).cb('CHANNEL_ERROR', rejected()); made.at(-1).cb('CHANNEL_ERROR', rejected());
  assert.equal(timers.length, 7, '같은 채널의 오류가 겹쳐 와도 재시도 예약은 하나');
  timers.at(-1).fn(); made.at(-1).cb('SUBSCRIBED'); made.at(-1).cb('CHANNEL_ERROR', rejected());
  assert.equal(timers.at(-1).ms, 60_000, '붙은 뒤 끊기면 1분부터 다시');
  stop();
  assert.equal(timers.at(-1).cleared, true, '멈추면 예약된 재시도 취소');
  const before = made.length; timers.at(-1).fn(); assert.equal(made.length, before, '멈춘 뒤에는 다시 붙지 않는다');
  const stop2 = joinWithBackoff(sb, make, { timer: () => 0, clear: () => {} }); const live = made.at(-1).n; stop2();
  assert.ok(removed.includes(live), '멈추면 붙어 있던 채널도 걷는다');
});

// D55(2026-09-19 설치본 계측): 가린 창에서 하트비트가 끊기자 u:가 CHANNEL_ERROR(원인 없음)를 받았고, 종전 코드는 이를 거절로 보고 채널을 걷어
// 60초를 기다렸다 — 창을 다시 열어 소켓이 1초 만에 붙은 뒤에도 u:만 61초 뒤 복귀, 그 사이 비공개 방 글(1009)의 알림이 사라졌다.
test('u: 구독: 소켓이 끊겨 난 오류(서버 응답 없음)는 채널을 걷지 않고 기다리지도 않는다 — 재연결 뒤 realtime-js가 같은 채널을 바로 다시 붙인다', () => {
  const made = []; const removed = []; const timers = [];
  let connected = false;
  const sb = { realtime: { isConnected: () => connected }, removeChannel: (c) => { removed.push(c.n); return Promise.resolve('ok'); } };
  const make = () => { const c = { n: made.length, subscribe(cb) { c.cb = cb; return c; } }; made.push(c); return c; };
  joinWithBackoff(sb, make, { timer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {} });
  made[0].cb('SUBSCRIBED');
  class CloseEventLike extends Event { constructor() { super('close'); this.code = 1006; this.reason = ''; } }
  connected = true;
  made[0].cb('CHANNEL_ERROR', new Error('transport closed', { cause: new CloseEventLike() })); // TCP 1006 — cause가 있어도 CloseEvent는 거절이 아니다
  made[0].cb('CHANNEL_ERROR', new Error('heartbeat timeout')); made[0].cb('CLOSED'); // 하트비트 시간 초과 — cause 없음
  assert.deepEqual([removed.length, timers.length, made.length], [0, 0, 1], '걷지 않고, 재시도 예약도 없다(가입 거절이 아니다)');
  made[0].cb('SUBSCRIBED'); // 재연결 뒤 realtime-js의 재가입
  connected = false;
  made[0].cb('CHANNEL_ERROR', new Error('Unauthorized', { cause: { reason: 'Unauthorized' } }));
  assert.deepEqual([removed.length, timers.length], [0, 0], '소켓이 끊긴 상태의 {reason} 오류도 가입 거절로 확정하지 않는다');
  connected = true;
  made[0].cb('CHANNEL_ERROR', new Error('Unauthorized', { cause: { reason: 'Unauthorized' } }));
  assert.deepEqual([removed, timers.map((x) => x.ms)], [[0], [60_000]], '연결된 상태의 가입 거절(평범한 {reason} 객체)은 여전히 걷고 1분 뒤');
});
