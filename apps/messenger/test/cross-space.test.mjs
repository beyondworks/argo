import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSpaceTotals, readableForNotify, seenOnce, badgeTotal, spaceOf, spaceKey } from '../src/cross-space.mjs';

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
  assert.match(app, /const notifyReadable = \(payload, space\) => \{ if \(!payload \|\| payload\.author_user_id === uid \|\| !shouldNotify\(payload\.channel_id\)\) return; readableForNotify\(/, '알림 전 읽힘 확인 — 알릴 상황(shouldNotify)일 때만 조회');
  assert.match(app, /crossRef\.current = \(payload, space\) => \{[\s\S]{0,200}seenOnce\(seenMsgRef\.current, payload\.id\)/, '다른 공간 처리기도 id로 한 번만(이중 송신 대비)');
  assert.match(app, /handleMessageRef\.current = \(payload\) => \{\s*if \(!seenOnce\(seenMsgRef\.current, payload\?\.id\)\) return;/, '보고 있는 공간 처리기도 id로 한 번만');
});

test('폰 홈 조직 전환 버튼: min-width:0 — 배지가 붙어도 자리 안에서 멈추고 이름만 말줄임(검수 #605, 측정은 test/org-badge-phone.browser.mjs)', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.msgr-phone\.phone-home \.msgr-side \.msgr-org \{[^}]*\bmin-width: 0;/);
});
