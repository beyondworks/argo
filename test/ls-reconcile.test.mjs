// 하루 1회 결제 대사(supabase/functions/ls-reconcile) — LS 활성 구독 ↔ entitlements 불일치를 billing_unmatched에 적어 알림이 나가게 한다.
// 자동 수정은 하지 않는다. 엣지 index.ts는 타입만 지워 node vm에서 실행한다(ls-webhook-edge.test.mjs와 같은 방식). LS·DB는 가짜.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as core from '../supabase/functions/ls-reconcile/core.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const FUTURE = '2026-11-09T21:00:00Z';
const PAST = '2026-10-01T00:00:00Z';
const sub = (id, attrs = {}) => ({ id: String(id), attributes: { status: 'active', test_mode: false, variant_id: 1, customer_id: 900 + Number(id) % 100, user_email: `u${id}@example.com`, ends_at: null, updated_at: '2026-10-09T21:00:00Z', ...attrs } });
const ent = (sid, row = {}) => ({ user_id: `user-${sid}`, plan: 'pro', ends_at: null, ls_subscription_id: String(sid), ls_customer_id: 'c', granted: false, ...row });

test('LS Pro 판정 — 웹훅과 같은 상태 집합, 시험 결제·다른 변형·기한 지난 cancelled는 아니다', () => {
  const o = { nowMs: NOW };
  for (const s of ['active', 'on_trial', 'past_due']) assert.equal(core.lsCountsAsPro(sub(1, { status: s }), o), true, s);
  assert.equal(core.lsCountsAsPro(sub(1, { status: 'cancelled', ends_at: FUTURE }), o), true, '말일 전 cancelled = Pro');
  assert.equal(core.lsCountsAsPro(sub(1, { status: 'cancelled', ends_at: PAST }), o), false, '말일 지난 cancelled');
  for (const s of ['expired', 'unpaid', 'paused', 'weird']) assert.equal(core.lsCountsAsPro(sub(1, { status: s }), o), false, s);
  assert.equal(core.lsCountsAsPro(sub(1, { test_mode: true }), o), false, '시험 결제 제외');
  assert.equal(core.lsCountsAsPro(sub(1, { test_mode: true }), { ...o, allowTest: true }), true);
  assert.equal(core.lsCountsAsPro(sub(1, { variant_id: 7 }), { ...o, allowedVariants: new Set(['1']) }), false, '허용 목록 밖 변형');
});

test('불일치 — 양방향을 찾고, 맞는 건·운영자 부여·그랜드파더링·이미 알린 구독은 건너뛴다', () => {
  const subs = [
    sub(101),                                   // 연결됨 — 정상
    sub(102),                                   // 연결 없음 → ls-pro-not-linked (10/10 gasinabro 모양)
    sub(103),                                   // 연결됐지만 우리 쪽 free → ls-pro-not-linked
    sub(104),                                   // 운영자 부여 계정에 연결 — 정상
    sub(105, { status: 'expired' }),            // LS 끝남인데 우리 쪽 Pro → pro-not-in-ls
    sub(106, { test_mode: true }),              // 시험 결제로 우리 쪽 Pro(9/1 실사고 모양) → pro-not-in-ls
    sub(107),                                   // 이미 billing_unmatched에 미해결 행이 있다 → 건너뜀
    sub(108, { status: 'cancelled', ends_at: FUTURE }), // 해지했지만 말일 전, 우리 쪽 Pro — 정상
  ];
  const ents = [
    ent(101),
    ent(103, { plan: 'free' }),
    ent(104, { plan: 'free', granted: true }),
    ent(105),
    ent(106),
    ent(108, { ends_at: FUTURE }),
    ent(109),                                   // LS에 아예 없는 구독으로 Pro → pro-not-in-ls
    ent(110, { ends_at: PAST }),                // 기한 지난 Pro — 우리 쪽도 Pro 아님, 정상
    ent(111, { granted: true }),                // 운영자 부여 — LS와 대조하지 않는다
    { user_id: 'grandfathered', plan: 'pro', ends_at: null, ls_subscription_id: '', granted: false }, // 구독 번호 없음 — 대조 안 함
    { user_id: 'null-sub', plan: 'pro', ends_at: null, ls_subscription_id: null, granted: false },
  ];
  const out = core.findDiscrepancies({ subs, ents, knownSubIds: new Set(['107']), nowMs: NOW });
  const got = out.map((r) => `${r.ls_subscription_id}:${r.reason}`).sort();
  assert.deepEqual(got, ['102:reconcile-ls-pro-not-linked', '103:reconcile-ls-pro-not-linked', '105:reconcile-pro-not-in-ls',
    '106:reconcile-pro-not-in-ls', '109:reconcile-pro-not-in-ls']);
  const r102 = out.find((r) => r.ls_subscription_id === '102');
  assert.deepEqual(r102, { event_name: 'reconcile-daily', reason: 'reconcile-ls-pro-not-linked', ls_subscription_id: '102', ls_customer_id: '902', user_email: 'u102@example.com',
    ls_status: 'active', ls_updated_at: '2026-10-09T21:00:00Z' });
  const r109 = out.find((r) => r.ls_subscription_id === '109');
  assert.equal(r109.user_email, '', 'LS에 없는 구독은 이메일을 모른다');
  assert.equal(r109.ls_status, null);
  assert.equal(r109.ls_updated_at, null);
  assert.equal(out.find((r) => r.ls_subscription_id === '106').test_mode, undefined, '시험 구독 불일치도 test_mode를 싣지 않는다 — 알림 대상');
  // PostgREST 일괄 넣기 — 모든 행의 키가 같다
  const keySets = new Set(out.map((r) => Object.keys(r).sort().join(',')));
  assert.equal(keySets.size, 1, [...keySets].join(' | '));
  // 같은 구독에 계정 행이 둘이어도 한 번만
  const dup = core.findDiscrepancies({ subs: [], ents: [ent(120), { ...ent(120), user_id: 'other' }], nowMs: NOW });
  assert.equal(dup.length, 1);
  assert.deepEqual(core.findDiscrepancies({ subs: [sub(1)], ents: [ent(1)], nowMs: NOW }), [], '맞으면 0건');
});

test('LS 목록 — links.next를 따라 전부 읽고, 오류·LS 밖 주소·끝없는 쪽은 throw', async () => {
  const pages = {
    'https://api.lemonsqueezy.com/v1/subscriptions?page[size]=100&page[number]=1': { data: [sub(1), sub(2)], links: { next: 'https://api.lemonsqueezy.com/v1/subscriptions?page[number]=2&page[size]=100' } },
    'https://api.lemonsqueezy.com/v1/subscriptions?page[number]=2&page[size]=100': { data: [sub(3)], links: { next: null } },
  };
  const seen = [];
  const all = await core.fetchAllSubscriptions('KEY', async (url, init) => {
    seen.push(url); assert.equal(init.headers.Authorization, 'Bearer KEY');
    return Response.json(pages[url]);
  });
  assert.deepEqual(all.map((s) => s.id), ['1', '2', '3']);
  assert.equal(seen.length, 2);
  await assert.rejects(core.fetchAllSubscriptions('K', async () => new Response('no', { status: 401 })), /LS API 401/);
  await assert.rejects(core.fetchAllSubscriptions('K', async () => Response.json({ data: [], links: { next: 'https://evil.example/x' } })), /LS API 밖/);
  await assert.rejects(core.fetchAllSubscriptions('K', async () => Response.json({ data: [], links: { next: 'https://api.lemonsqueezy.com/v1/subscriptions?loop' } })), /50쪽/);
  await assert.rejects(core.fetchAllSubscriptions('K', async () => Response.json({ errors: [] })), /data 배열/);
});

// ── 엣지 핸들러(vm) ──
const source = stripTypeScriptTypes(await readFile(new URL('../supabase/functions/ls-reconcile/index.ts', import.meta.url), 'utf8'))
  .replace(/^import .* from .*;$/gm, '');

function edge({ env = {}, lsSubs = [sub(1), sub(2)], ents = [ent(1)], open = [], lsFail = false } = {}) {
  const config = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', LS_RECONCILE_SECRET: 'rec-secret', LEMONSQUEEZY_API_KEY: 'ls-key', ...env };
  const inserts = [], logs = [], errors = [], lsCalls = [];
  let handler;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.lemonsqueezy.com') { lsCalls.push(String(input)); return lsFail ? new Response('down', { status: 503 }) : Response.json({ data: lsSubs, links: {} }); }
    assert.equal(url.hostname, 'db.test');
    assert.equal(init.headers.Authorization, 'Bearer svc');
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === 'entitlements') { assert.equal(url.searchParams.get('or'), '(plan.eq.pro,ls_subscription_id.not.is.null)'); return Response.json(ents); }
    if (path === 'billing_unmatched' && (init.method ?? 'GET') === 'GET') { assert.equal(url.searchParams.get('resolved_at'), 'is.null'); return Response.json(open); }
    if (path === 'billing_unmatched' && init.method === 'POST') {
      assert.equal(url.searchParams.get('on_conflict'), 'ls_subscription_id,reason');
      assert.match(init.headers.Prefer, /resolution=ignore-duplicates/);
      inserts.push(...JSON.parse(init.body)); return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected ${path}`);
  };
  vm.runInNewContext(source, {
    ...core, fetch, Response, Request, TextEncoder, crypto, AbortSignal, URL, Set, Date: class extends Date { static now() { return NOW; } },
    Deno: { env: { get: (k) => config[k] }, serve: (fn) => { handler = fn; } },
    console: { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => errors.push(a.map(String).join(' ')) },
  });
  const call = (auth = 'Bearer rec-secret', method = 'POST') => handler(new Request('https://edge.test', { method, headers: auth ? { authorization: auth } : {}, body: method === 'POST' ? '{}' : undefined }));
  return { call, inserts, logs, errors, lsCalls };
}

test('엣지 — 비밀 없으면 닫힘(500), 틀린 비밀 401, GET 405, 어느 경우에도 LS·DB를 부르지 않는다', async () => {
  const noSecret = edge({ env: { LS_RECONCILE_SECRET: '' } });
  assert.equal((await noSecret.call()).status, 500);
  const e = edge();
  assert.equal((await e.call('Bearer wrong')).status, 401);
  assert.equal((await e.call(null)).status, 401);
  assert.equal((await e.call('Bearer rec-secret', 'GET')).status, 405);
  assert.equal(e.lsCalls.length + noSecret.lsCalls.length, 0);
  assert.equal(e.inserts.length, 0);
  const noKey = edge({ env: { LEMONSQUEEZY_API_KEY: '' } });
  assert.equal((await noKey.call()).status, 500);
  assert.equal(noKey.lsCalls.length, 0);
});

test('엣지 — 불일치만 billing_unmatched에 넣고(중복 무시), 맞으면 쓰기 0, LS 장애면 502·쓰기 0, 로그에 이메일 없음', async () => {
  const e = edge();
  const res = await e.call();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, subscriptions: 2, findings: 1 });
  assert.deepEqual(e.inserts, [{ event_name: 'reconcile-daily', reason: 'reconcile-ls-pro-not-linked', ls_subscription_id: '2', ls_customer_id: '902', user_email: 'u2@example.com', ls_status: 'active', ls_updated_at: '2026-10-09T21:00:00Z' }]);
  assert.ok(e.logs.some((l) => /불일치 1건/.test(l) && /2:reconcile-ls-pro-not-linked/.test(l)));
  assert.ok(!e.logs.join('\n').includes('@'), '로그에 이메일이 없다');

  const clean = edge({ lsSubs: [sub(1)], ents: [ent(1)] });
  assert.equal((await clean.call()).status, 200);
  assert.equal(clean.inserts.length, 0, '불일치가 없으면 쓰기 0');

  const known = edge({ open: [{ ls_subscription_id: '2' }] });
  await known.call();
  assert.equal(known.inserts.length, 0, '이미 미해결 행이 있는 구독은 다시 적지 않는다');

  const down = edge({ lsFail: true });
  assert.equal((await down.call()).status, 502);
  assert.equal(down.inserts.length, 0, 'LS를 못 읽으면 아무것도 쓰지 않는다(빈 목록으로 오판해 전부 불일치로 적지 않게)');
  assert.ok(down.errors.some((l) => /LS 조회 실패/.test(l)));
});
