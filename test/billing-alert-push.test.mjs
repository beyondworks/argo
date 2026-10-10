// 결제 미연결 알림 — msgr-push의 billing_unmatched_id 분기(운영자 기기 푸시). 신고 알림과 같은 운영자·토큰 경로를 쓴다.
// 가짜 송신기: APNs·DB를 이 파일의 fetch가 받는다(실제 발송 없음). 잠그는 것: 행당 한 번, 대상 규칙(시험 결제·probe·처리된 행 제외),
// 푸시 내용은 구독 번호·가린 이메일·사유만, 로그에 이메일 없음, 공유 비밀이 있으면 비밀 없는 호출 거절.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as core from '../supabase/functions/msgr-push/core.js';

const source = stripTypeScriptTypes(await readFile(new URL('../supabase/functions/msgr-push/index.ts', import.meta.url), 'utf8'))
  .replace(/^import .* from .*;$/gm, '');
const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const p8 = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;

const ROW = { id: 41, event_name: 'subscription_created', reason: 'no-user', ls_subscription_id: '2595064', ls_customer_id: '7001',
  user_email: 'gasinabro@gmail.com', resolved_at: null, notified_at: null, created_at: '2026-10-09T21:00:01Z' };

function edge({ row = ROW, operators = ['operator'], tokens = ['op-phone'], secret = null } = {}) {
  const sent = [], logs = [], claims = new Set();
  let handler;
  const config = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', APNS_KEY_P8: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', PUSH_FN_SECRET: secret ?? undefined };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.push.apple.com') {
      sent.push({ device: url.pathname.split('/').at(-1), body: JSON.parse(init.body), collapse: init.headers['apns-collapse-id'] });
      return new Response(null, { status: 200 });
    }
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === 'billing_unmatched' && init.method === 'PATCH') { // notified_at 선점 흉내 — 처음 한 번만 행을 돌려준다
      assert.equal(url.searchParams.get('notified_at'), 'is.null');
      const id = url.searchParams.get('id').replace('eq.', '');
      if (claims.has(id) || !row || String(row.id) !== id) return Response.json([]);
      claims.add(id); return Response.json([{ ...row, notified_at: JSON.parse(init.body).notified_at }]);
    }
    if (path === 'msgr_report_operators') return Response.json(operators.map((user_id) => ({ user_id })));
    if (path === 'msgr_push_tokens') return Response.json(tokens.map((token) => ({ token, platform: 'ios', user_id: 'operator' })));
    throw new Error(`unexpected ${path}`);
  };
  vm.runInNewContext(source, {
    ...core, fetch, Response, Request, TextEncoder, crypto, Date,
    Deno: { env: { get: (k) => config[k] }, serve: (fn) => { handler = fn; } },
    console: { log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) },
  });
  const call = async (body, auth) => {
    const res = await handler(new Request('https://edge.test', { method: 'POST', headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) }));
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
  };
  return { call, sent, logs };
}

test('미연결 행 → 운영자 기기에 한 번만, 내용은 구독 번호·가린 이메일·사유뿐', async () => {
  const e = edge();
  const r = await e.call({ billing_unmatched_id: 41 });
  assert.deepEqual(r.body, { ok: true, sent: 1 });
  assert.equal(e.sent.length, 1);
  const alert = e.sent[0].body.aps.alert;
  assert.equal(alert.title, '결제 미연결');
  assert.equal(alert.body, '구독 2595064 · g***@gmail.com · 결제 이메일과 같은 계정 없음');
  assert.ok(!JSON.stringify(e.sent[0].body).includes('gasinabro'), '이메일 전체가 푸시에 없다');
  assert.ok(!JSON.stringify(e.sent[0].body).includes('7001'), '고객 번호도 싣지 않는다');
  assert.equal(e.sent[0].body.channel_id, 'billing', '앱이 모르는 채널 값 — 탭하면 앱만 열린다');
  assert.equal(e.sent[0].collapse, 'billing-41');
  assert.ok(!e.logs.join('\n').includes('@'), '로그에 이메일이 없다');
  const again = await e.call({ billing_unmatched_id: 41 });
  assert.deepEqual(again.body, { ok: true, dup: true }, '재생 호출은 알림을 더 만들지 않는다');
  assert.equal(e.sent.length, 1);
});

test('대사 불일치 사유는 제목이 다르다', async () => {
  const e = edge({ row: { ...ROW, event_name: 'reconcile-daily', reason: 'reconcile-pro-not-in-ls', user_email: '' } });
  await e.call({ billing_unmatched_id: 41 });
  assert.deepEqual(e.sent[0].body.aps.alert, { title: '결제 대사 불일치', body: '구독 2595064 · ? · Pro인데 LS에 유효 구독 없음' });
});

test('대상이 아닌 행 — 시험 결제·probe·숫자 아닌 구독·처리된 행·다른 사유는 선점만 하고 보내지 않는다', async () => {
  const cases = [
    { test_mode: true },
    { event_name: 'probe' },
    { ls_subscription_id: 'probe-1' },
    { ls_subscription_id: '' },
    { resolved_at: '2026-10-10T00:00:00Z' },
    { reason: 'test-mode' },
    { reason: 'other-product:5' },
    { reason: 'unknown-status' },
  ];
  for (const c of cases) {
    const e = edge({ row: { ...ROW, ...c } });
    const r = await e.call({ billing_unmatched_id: 41 });
    assert.deepEqual(r.body, { ok: true, sent: 0, skip: 'not-alertable' }, JSON.stringify(c));
    assert.equal(e.sent.length, 0, JSON.stringify(c));
  }
});

test('운영자·토큰이 없으면 0건, 잘못된 id는 400, 공유 비밀이 있으면 비밀 없는 호출은 401', async () => {
  assert.deepEqual((await edge({ operators: [] }).call({ billing_unmatched_id: 41 })).body, { ok: true, sent: 0 });
  const noTok = edge({ tokens: [] });
  assert.deepEqual((await noTok.call({ billing_unmatched_id: 41 })).body, { ok: true, sent: 0 });
  for (const bad of [0, -1, 1.5, 'x', null]) assert.equal((await edge().call({ billing_unmatched_id: bad })).status, 400, String(bad));
  const locked = edge({ secret: 'push-secret' });
  assert.equal((await locked.call({ billing_unmatched_id: 41 })).status, 401);
  assert.equal(locked.sent.length, 0);
  assert.equal((await locked.call({ billing_unmatched_id: 41 }, 'Bearer push-secret')).body.sent, 1);
});

test('가린 이메일 — 첫 글자와 도메인만(ls-webhook maskEmail과 같은 모양)', () => {
  assert.equal(core.maskEmail('pay@example.com'), 'p***@example.com');
  assert.equal(core.maskEmail(' A.B+c@x.io '), 'A***@x.io');
  assert.equal(core.maskEmail(''), '?');
  assert.equal(core.maskEmail(null), '?');
  assert.equal(core.maskEmail('no-at'), '***');
  assert.equal(core.maskEmail('@x.io'), '***');
});
