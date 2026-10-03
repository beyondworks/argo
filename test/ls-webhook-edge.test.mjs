// 운영 결제 수신자(supabase/functions/ls-webhook/index.ts) 행동 테스트 — 진입점 파일을 그대로 node vm에서 실행한다
// (test/helpers/ls-webhook-edge.mjs). DB는 아래 메모리 가짜. 실제 SQL(ls_user_by_email·apply_ls_event·billing_unmatched)과
// 이어 붙인 실행은 test/billing-pg-integration.test.mjs가 본다.
//
// 실사고 2026-10-03: 랜딩 결제 링크는 custom user_id를 붙이지 않는데 이 수신자는 user_id가 없으면 400으로 끝나,
//   실결제 2건이 Pro에 연결되지 않았고 billing_unmatched에도 남지 않았다(LS 재시도도 전부 400).
// 실사고 2026-09-01: 이 수신자에만 test_mode 게이트가 없어 테스트 주문(LS 정산액 0)이 실 계정에 pro를 부여했다.
// (예전 이 자리의 test/ls-webhook-edge-testmode.test.mjs는 소스 문자열 검사였다 — 같은 뜻을 실행으로 확인한다.
//  그때의 granted 가드는 SQL apply_ls_event로 옮겨 갔고 billing-pg-integration의 R2·엣지 실행 테스트가 본다.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLsWebhook, sign } from './helpers/ls-webhook-edge.mjs';
import { mapSubscriptionEvent, applyLsEvent, unmatchedRow } from '../src/lsbilling.mjs';

const UID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const SUB = '9000001'; // 가짜 구독 번호 — 실제 구독 번호를 테스트에 쓰지 않는다
const UNMATCHED_OPTS = { onConflict: 'ls_subscription_id,reason', ignoreDuplicates: true };

/** LS 구독 이벤트. userId를 안 주면 custom_data가 없다(= 랜딩 결제 링크). */
function event({ name = 'subscription_created', userId, sub = SUB, ...attrs } = {}) {
  return {
    meta: { event_name: name, ...(userId === undefined ? {} : { custom_data: { user_id: userId } }) },
    data: {
      id: sub,
      attributes: {
        status: 'active', customer_id: 7001, user_email: 'pay@example.com', updated_at: '2026-10-03T12:24:00.000000Z',
        ends_at: null, test_mode: false, urls: { customer_portal: 'https://argo.lemonsqueezy.com/billing?expires=1' }, ...attrs,
      },
    },
  };
}

/** 메모리 가짜 supabase 클라이언트 — 엣지 함수가 쓰는 호출만. entitlements 행(rows)에 eq/neq 필터를 실제로 적용한다
    (조회 조건이 틀리면 가짜도 틀린 답을 준다). RPC는 정해 준 답을 돌려주고 인자를 기록한다. fail: { lookup|select|apply|upsert: 메시지 }
    기록은 structuredClone으로 — vm 안에서 만든 객체는 프로토타입이 달라 deepStrictEqual이 값이 같아도 다르다고 본다. */
function memSb({ rows = [], emailOwner = null, applyResult = 'applied', fail = {} } = {}) {
  const calls = { rpc: [], selects: [], upserts: [] };
  const err = (k) => (fail[k] ? { message: fail[k] } : null);
  const sb = {
    async rpc(fn, args) {
      calls.rpc.push([fn, structuredClone(args)]);
      if (fn === 'ls_user_by_email') return { data: fail.lookup ? null : emailOwner, error: err('lookup') };
      if (fn === 'apply_ls_event') return { data: fail.apply ? null : applyResult, error: err('apply') };
      throw new Error(`예상 밖 RPC ${fn}`);
    },
    from(table) {
      return {
        select(cols) {
          const where = [];
          const q = {
            eq(c, v) { where.push((r) => r[c] === v); return q; },
            neq(c, v) { where.push((r) => r[c] !== v); return q; },
            async limit(n) {
              calls.selects.push({ table, cols });
              if (fail.select) return { data: null, error: err('select') };
              const hit = table === 'entitlements' ? rows.filter((r) => where.every((f) => f(r))) : [];
              return { data: hit.slice(0, n).map((r) => ({ [cols]: r[cols] })), error: null };
            },
          };
          return q;
        },
        async upsert(row, opts) {
          calls.upserts.push({ table, row: structuredClone(row), opts: structuredClone(opts) });
          return { error: err('upsert') };
        },
      };
    },
  };
  return { sb, calls };
}

/** 정본(src/lsbilling.mjs)이 같은 페이로드로 apply_ls_event에 보낼 [함수, 인자]. */
async function canonicalApply(payload) {
  const out = [];
  await applyLsEvent({ rpc: async (fn, args) => { out.push([fn, args]); return { data: 'applied', error: null }; } },
    mapSubscriptionEvent(payload.meta.event_name, payload));
  return out[0];
}

const applies = (calls) => calls.rpc.filter(([fn]) => fn === 'apply_ls_event');
const noDb = (fn, calls) => {
  assert.equal(fn.clients.length, 0, 'DB 클라이언트를 만들었다');
  assert.deepEqual(calls, { rpc: [], selects: [], upserts: [] }, 'DB에 손댔다');
};

test('서명이 틀리면 401 — DB에 손대지 않는다', async () => {
  const { sb, calls } = memSb({ emailOwner: UID });
  const fn = loadLsWebhook({ sb });
  const payload = event({ userId: UID });
  const body = JSON.stringify(payload);
  assert.equal((await fn.post(payload, { signature: sign(body, 'other-secret') })).status, 401, '다른 시크릿');
  assert.equal((await fn.post(payload, { signature: '' })).status, 401, '서명 없음');
  assert.equal((await fn.post(null, { rawBody: `${body} `, signature: sign(body) })).status, 401, '본문 1바이트 변조');
  noDb(fn, calls);
});

test('test_mode 결제는 200으로 무시 — DB 접근 없음, LS_ALLOW_TEST=1일 때만 받는다', async () => {
  for (const [userId, flag] of [[UID, undefined], [undefined, undefined], [UID, 'true'], [UID, '0']]) {
    const { sb, calls } = memSb({ emailOwner: UID });
    const fn = loadLsWebhook({ sb, env: flag === undefined ? {} : { LS_ALLOW_TEST: flag } });
    const r = await fn.post(event({ userId, test_mode: true }));
    assert.equal(r.status, 200, '4xx/5xx면 LS가 재시도를 반복한다');
    assert.equal(r.text, 'test mode ignored');
    noDb(fn, calls);
  }
  const { sb, calls } = memSb();
  const fn = loadLsWebhook({ sb, env: { LS_ALLOW_TEST: '1' } });
  const r = await fn.post(event({ userId: UID, test_mode: true }));
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' }, '스테이징(LS_ALLOW_TEST=1)은 받는다');
  assert.equal(applies(calls).length, 1);
});

test('user_id가 있으면 그 계정에 apply_ls_event — 인자는 정본과 같고, 이메일 조회는 하지 않는다', async () => {
  for (const [status, plan] of [['active', 'pro'], ['cancelled', 'pro'], ['past_due', 'pro'], ['expired', 'free'], ['paused', 'free']]) {
    const payload = event({ name: 'subscription_updated', userId: UID.toUpperCase(), status, ends_at: plan === 'pro' && status === 'active' ? null : '2026-11-03T00:00:00.000000Z' });
    const { sb, calls } = memSb({ emailOwner: OTHER }); // 이메일은 다른 계정을 가리켜도 user_id가 이긴다
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(payload);
    assert.equal(r.status, 200, status);
    assert.deepEqual(r.json, { ok: true, plan, status }, status);
    assert.deepEqual(calls.rpc.map(([f]) => f), ['apply_ls_event'], `${status}: 이메일 조회 없이 적용만`);
    assert.deepEqual(calls.rpc[0], await canonicalApply(payload), `${status}: 정본 매핑과 다른 인자`);
    assert.equal(calls.rpc[0][1].p_user_id, UID, '정본처럼 소문자로');
    assert.equal(calls.upserts.length, 0);
  }
});

test('user_id가 없으면 결제 이메일로 찾은 계정에 적용 — 공백만 빼서 보내고, 적용 인자는 user_id가 있을 때와 같다', async () => {
  const payload = event({ user_email: '  Pay@Example.com ' }); // custom_data 없음 = 랜딩 결제 링크
  const { sb, calls } = memSb({ emailOwner: UID });
  const fn = loadLsWebhook({ sb });
  const r = await fn.post(payload);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' });
  assert.deepEqual(calls.rpc[0], ['ls_user_by_email', { p_email: 'Pay@Example.com' }], '대소문자는 SQL이 무시한다');
  const withId = structuredClone(payload);
  withId.meta.custom_data = { user_id: UID };
  assert.deepEqual(calls.rpc[1], await canonicalApply(withId), '계정만 이메일로 정했을 뿐 나머지 인자는 정본과 같다');
  assert.equal(calls.upserts.length, 0);
  assert.deepEqual(calls.selects, [{ table: 'entitlements', cols: 'user_id' }], '적용 전에 다른 계정 연결 여부를 본다');
});

test('user_id가 UUID가 아니면 없는 것으로 보고 이메일로 찾는다', async () => {
  for (const bad of ['', 'undefined', 'DROP TABLE', 42, null]) {
    const { sb, calls } = memSb({ emailOwner: UID });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(event({ userId: bad }));
    assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' }, String(bad));
    assert.deepEqual(calls.rpc.map(([f]) => f), ['ls_user_by_email', 'apply_ls_event'], String(bad));
    assert.equal(calls.rpc[1][1].p_user_id, UID);
  }
});

test('이메일로 계정을 못 찾으면(0개·2개 이상은 null) billing_unmatched no-user 기록 후 200 — 적용하지 않는다', async () => {
  const payload = event({ user_email: 'Nobody@Example.com' });
  const { sb, calls } = memSb({ emailOwner: null });
  const fn = loadLsWebhook({ sb });
  const r = await fn.post(payload);
  assert.equal(r.status, 200, 'LS가 재시도해도 결과가 같다');
  assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' });
  assert.equal(applies(calls).length, 0);
  assert.deepEqual(calls.upserts, [{ table: 'billing_unmatched', row: unmatchedRow('subscription_created', 'no-user', payload), opts: UNMATCHED_OPTS }],
    '셀프호스트 수신자와 같은 필드·같은 중복 처리');
});

test('결제 이메일도 user_id도 없으면 조회 없이 no-user 기록 후 200', async () => {
  for (const user_email of [undefined, '', '   ']) {
    const payload = event({ user_email });
    const { sb, calls } = memSb({ emailOwner: UID });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(payload);
    assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' }, JSON.stringify(user_email));
    assert.deepEqual(calls.rpc, [], '빈 이메일로 계정을 찾지 않는다');
    assert.deepEqual(calls.upserts.map((u) => u.row.reason), ['no-user']);
  }
});

test('같은 구독이 이미 다른 계정에 붙어 있으면 적용하지 않고 duplicate-attribution 기록 후 200 — 이메일·user_id 경로 둘 다', async () => {
  for (const userId of [undefined, UID]) {
    const payload = event({ userId });
    const { sb, calls } = memSb({ emailOwner: UID, rows: [{ user_id: OTHER, ls_subscription_id: SUB }] });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(payload);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, unmatched: 'duplicate-attribution' }, `via=${userId ? 'user_id' : 'email'}`);
    assert.equal(applies(calls).length, 0, '한 결제로 두 계정이 Pro가 되면 안 된다');
    assert.deepEqual(calls.upserts, [{ table: 'billing_unmatched', row: unmatchedRow('subscription_created', 'duplicate-attribution', payload), opts: UNMATCHED_OPTS }]);
  }
});

test('그 구독을 이미 가진 계정이 같은 계정이면 중복이 아니다 — 갱신·해지 이벤트는 계속 적용된다', async () => {
  const rows = [{ user_id: UID, ls_subscription_id: SUB }, { user_id: OTHER, ls_subscription_id: 'another-sub' }];
  const { sb, calls } = memSb({ emailOwner: UID, rows });
  const fn = loadLsWebhook({ sb });
  const r = await fn.post(event({ name: 'subscription_cancelled', status: 'cancelled', ends_at: '2026-11-03T00:00:00.000000Z' }));
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'cancelled' });
  assert.equal(applies(calls).length, 1);
  assert.equal(calls.upserts.length, 0);
});

test('구독 번호가 비면 중복 확인을 건너뛴다 — 구독 번호 없는 옛 행(빈 값)을 다른 계정 연결로 오인하지 않는다', async () => {
  const { sb, calls } = memSb({ emailOwner: UID, rows: [{ user_id: OTHER, ls_subscription_id: '' }] });
  const fn = loadLsWebhook({ sb });
  const r = await fn.post(event({ sub: null })); // undefined는 기본값(SUB)이 들어간다
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' });
  assert.equal(calls.selects.length, 0);
  assert.equal(applies(calls)[0][1].p_sub_id, '', '정본과 같이 빈 문자열(apply_ls_event의 coalesce와 같은 값)');
});

test('모르는 상태·라이프사이클 밖 이벤트는 200 — DB를 읽지도 쓰지도 않는다', async () => {
  const cases = [
    event({ status: 'brand_new_status' }),                 // 이메일 경로라도 계정 찾기 전에 끝난다
    event({ userId: UID, status: 'brand_new_status' }),
    event({ name: 'subscription_payment_success', status: 'paid' }), // 인보이스 이벤트
    event({ name: 'order_created' }),
  ];
  for (const payload of cases) {
    const { sb, calls } = memSb({ emailOwner: UID });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(payload);
    assert.equal(r.status, 200, payload.meta.event_name);
    noDb(fn, calls);
  }
});

test('DB 오류는 500 — LS 재시도로 한 번 더 기회를 준다(계정 찾기·중복 확인·적용 각각)', async () => {
  for (const [fail, payload] of [
    [{ lookup: 'function public.ls_user_by_email(p_email => text) does not exist' }, event()],
    [{ select: 'timeout' }, event()],
    [{ select: 'timeout' }, event({ userId: UID })],
    [{ apply: 'deadlock detected' }, event()],
    [{ apply: 'deadlock detected' }, event({ userId: UID })],
  ]) {
    const { sb, calls } = memSb({ emailOwner: UID, fail });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(payload);
    assert.equal(r.status, 500, JSON.stringify(fail));
    assert.equal(calls.upserts.length, 0, '판정하지 못한 건을 미연결로 적지 않는다');
    assert.ok(fn.logs.some((l) => l.startsWith('error:') && l.includes('[유실 위험]')), '원인을 로그에 남긴다');
  }
});

test('billing_unmatched 기록이 실패해도 200 — 로그만 남긴다(셀프호스트 수신자와 같은 처리)', async () => {
  const { sb } = memSb({ emailOwner: null, fail: { upsert: 'permission denied' } });
  const fn = loadLsWebhook({ sb });
  const r = await fn.post(event());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' });
  assert.ok(fn.logs.some((l) => l.startsWith('error:') && l.includes('미연결 기록 실패')));
});

test('apply_ls_event가 stale·other_subscription이면 셀프호스트 수신자와 같은 200 본문', async () => {
  for (const [applyResult, body] of [['stale', { ok: true, stale: true }], ['other_subscription', { ok: true, otherSubscription: true }]]) {
    const { sb } = memSb({ emailOwner: UID, applyResult });
    const fn = loadLsWebhook({ sb });
    const r = await fn.post(event({ status: 'expired' }));
    assert.equal(r.status, 200, applyResult);
    assert.deepEqual(r.json, body, applyResult);
  }
});

test('로그에는 구독 번호와 가린 이메일만 — 결제 이메일 원문·계정 id를 남기지 않는다', async () => {
  const email = 'kim.private@example.org';
  for (const opts of [{ emailOwner: UID }, { emailOwner: null }, { emailOwner: UID, rows: [{ user_id: OTHER, ls_subscription_id: SUB }] }, { emailOwner: UID, fail: { apply: 'x' } }]) {
    const { sb } = memSb(opts);
    const fn = loadLsWebhook({ sb });
    await fn.post(event({ user_email: email }));
    const all = fn.logs.join('\n');
    assert.ok(fn.logs.length > 0, '결과를 로그로 남긴다');
    assert.ok(!all.includes(email) && !all.includes('kim.private'), `이메일 원문이 로그에 있다: ${all}`);
    assert.ok(!all.includes(UID) && !all.includes(OTHER), `계정 id가 로그에 있다: ${all}`);
    assert.ok(all.includes(`sub=${SUB}`) && all.includes('k***@example.org'), `구독 번호·가린 이메일이 없다: ${all}`);
  }
});

test('POST가 아니면 405, 시크릿 미설정은 500, 서명은 맞는데 JSON이 아니면 400', async () => {
  const { sb, calls } = memSb();
  assert.equal((await loadLsWebhook({ sb }).post(event(), { method: 'GET' })).status, 405);
  assert.equal((await loadLsWebhook({ sb, env: { LS_WEBHOOK_SECRET: undefined } }).post(event())).status, 500);
  assert.equal((await loadLsWebhook({ sb }).post(null, { rawBody: 'not json' })).status, 400);
  assert.deepEqual(calls, { rpc: [], selects: [], upserts: [] });
});
