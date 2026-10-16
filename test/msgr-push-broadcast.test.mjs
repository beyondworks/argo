// 메신저 일시 중단 공지 푸시(엣지 msgr-push broadcast_id, 20261016171000) — 실제 index.ts를 가짜 DB·APNs·FCM으로 돌린다(msgr-push-handler와 같은 방식).
// 잠그는 것: 토큰 있는 사용자의 기기마다 한 번(토큰 없는 사용자는 대상 밖), 두 번 불러도 0건 더, 없는 공지·형식이 틀린 id는 0건,
// 문구는 공지 행에서(요청 본문 무시) ko 다음 줄 en, 무효 토큰 정리, 일시 오류 재시도 상한 3번, 동시 10개, 기기 상한(PUSH_BROADCAST_MAX).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as core from '../supabase/functions/msgr-push/core.js';

const source = stripTypeScriptTypes(await readFile(new URL('../supabase/functions/msgr-push/index.ts', import.meta.url), 'utf8')).replace(/^import .* from .*;$/gm, '');
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const p8 = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const rsaPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;

// 유건님 승인 문구(2026-10-16) — 제목·본문 ko·en
const ROW = { id: 'pause:2026-10-16T18:00:00+09:00', ko_title: 'Argo Messenger 운영 일시 중단', ko: '더 안정적인 서비스를 위해 잠시 운영을 멈춥니다. 대화와 파일은 Argo 데스크톱 다음 업데이트에서 옮겨 드립니다.',
  en_title: 'Argo Messenger is pausing', en: "We're pausing briefly to make it more stable. Your chats and files will move to Argo desktop in the next update." };
function edge({ tokens, rows = [ROW], answer = () => 200, env = {}, delayMs = 0 } = {}) {
  const claims = new Set(); const deliveries = []; const deletes = []; const finished = []; const attempts = new Map(); let inflight = 0; let maxInflight = 0;
  const config = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service', APNS_KEY_P8: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T',
    FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'fcm@test', private_key: rsaPem, token_uri: 'https://oauth.test/token', project_id: 'proj' }), ...env };
  const provider = async (platform, token, payload) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      if (delayMs) await new Promise((r) => setImmediate(r));
      const n = (attempts.get(token) ?? 0) + 1; attempts.set(token, n);
      const status = answer(token, n, platform);
      if (status === 200) { deliveries.push({ platform, token, payload }); return new Response(null, { status: 200 }); }
      const reason = status === 410 ? 'Unregistered' : status === 404 ? 'UNREGISTERED' : 'TooManyRequests';
      return new Response(JSON.stringify({ reason, error: { status: reason } }), { status });
    } finally { inflight--; }
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.push.apple.com') return provider('ios', url.pathname.split('/').at(-1), JSON.parse(init.body));
    if (url.hostname === 'oauth.test') return Response.json({ access_token: 'fcm-access' });
    if (url.hostname === 'fcm.googleapis.com') { const b = JSON.parse(init.body); return provider('android', b.message.token, b); }
    assert.equal(url.hostname, 'database.test');
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === 'msgr_push_broadcasts' && init.method === 'PATCH') {
      const id = decodeURIComponent(url.searchParams.get('id').replace(/^eq\./, ''));
      const body = JSON.parse(init.body);
      if (body.claimed_at) { // 선점 — claimed_at=is.null 조건이 있을 때만 한 번
        const row = rows.find((r) => r.id === id);
        if (!row || (url.searchParams.get('claimed_at') === 'is.null' && claims.has(id))) return Response.json([]);
        claims.add(id); return Response.json([row]);
      }
      finished.push({ id, ...body }); return new Response(null, { status: 204 });
    }
    if (path === 'msgr_push_tokens' && init.method === 'DELETE') { deletes.push(decodeURIComponent(url.searchParams.get('token').replace(/^eq\./, ''))); return new Response(null, { status: 204 }); }
    if (path === 'msgr_push_tokens') {
      const from = Number(url.searchParams.get('offset') ?? 0), lim = Number(url.searchParams.get('limit') ?? 1000);
      return Response.json(tokens.slice(from, from + Math.min(lim, 1000))); // 서버 최대 행 1000
    }
    throw new Error(`Unexpected fixture route ${path}`);
  };
  let handler;
  vm.runInNewContext(source, { ...core, Deno: { env: { get: (k) => config[k] }, serve: (fn) => { handler = fn; } }, fetch, Response, Request, TextEncoder, URLSearchParams, crypto,
    setTimeout: (fn) => setImmediate(fn), Date, console: { log: () => {} } }); // 재시도 대기는 바로(시험 시간)
  const call = async (body) => { const r = await handler(new Request('https://edge.test', { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, json: r.status === 200 ? await r.json() : await r.text() }; };
  return { call, deliveries, deletes, finished, attempts, maxInflight: () => maxInflight };
}
const tok = (user, platform, i) => ({ token: `${platform}-${user}-${i}`, platform, user_id: user, sound: 'wood-knock' });

test('기기마다 한 번 — 토큰 있는 사용자 전원(아이폰·안드로이드), 토큰 없는 사용자는 대상 밖, 제목은 ko 제목·본문은 ko 다음 줄 "en 제목: en 본문"(요청의 문구는 무시)', async () => {
  const tokens = [tok('u1', 'ios', 1), tok('u1', 'android', 1), tok('u2', 'ios', 1), tok('u3', 'android', 1)];
  const e = edge({ tokens });
  const r = await e.call({ broadcast_id: ROW.id, ko_title: '위조', ko: '위조 문구', en_title: 'x', en: 'forged' });
  assert.equal(r.status, 200);
  assert.deepEqual({ users: r.json.users, tokens: r.json.tokens, sent: r.json.sent, failed: r.json.failed }, { users: 3, tokens: 4, sent: 4, failed: 0 });
  assert.deepEqual(e.deliveries.map((d) => d.token).sort(), tokens.map((t) => t.token).sort(), '기기마다 정확히 한 번');
  const ios = e.deliveries.find((d) => d.platform === 'ios').payload.aps.alert;
  const android = e.deliveries.find((d) => d.platform === 'android').payload.message.notification;
  for (const n of [ios, android]) assert.deepEqual(n, { title: 'Argo Messenger 운영 일시 중단',
    body: "더 안정적인 서비스를 위해 잠시 운영을 멈춥니다. 대화와 파일은 Argo 데스크톱 다음 업데이트에서 옮겨 드립니다.\nArgo Messenger is pausing: We're pausing briefly to make it more stable. Your chats and files will move to Argo desktop in the next update." });
  assert.equal(e.deliveries.find((d) => d.platform === 'ios').payload.aps.badge, undefined, '배지는 건드리지 않는다');
  assert.equal(e.finished.length, 1); assert.equal(e.finished[0].result.sent, 4);
});

test('두 번 불러도 0건 더(선점) — 없는 공지 id는 0건, 형식이 틀린 id는 400', async () => {
  const e = edge({ tokens: [tok('u1', 'ios', 1), tok('u2', 'android', 1)] });
  assert.equal((await e.call({ broadcast_id: ROW.id })).json.sent, 2);
  const again = await e.call({ broadcast_id: ROW.id });
  assert.deepEqual(again.json, { ok: true, dup: true });
  assert.equal(e.deliveries.length, 2, '재생 호출은 알림을 더 만들지 않는다');
  assert.deepEqual((await e.call({ broadcast_id: 'pause:forged' })).json, { ok: true, dup: true }, '행이 없는 위조 id');
  for (const bad of ['', 'x'.repeat(121), 'a b', 12, null]) assert.equal((await e.call({ broadcast_id: bad })).status, 400, `형식 거절: ${JSON.stringify(bad)}`);
  assert.equal(e.deliveries.length, 2);
});

test('무효 토큰은 지우고(410·404) 다시 보내지 않는다 — 일시 오류(429·5xx)는 최대 3번, 그 뒤 실패로 센다', async () => {
  const tokens = [tok('u1', 'ios', 1), tok('u2', 'android', 1), tok('u3', 'ios', 1), tok('u4', 'android', 1), tok('u5', 'ios', 1)];
  const answer = (t, n) => ({ 'ios-u1-1': 410, 'android-u2-1': 404 }[t] ?? (t === 'ios-u3-1' ? (n < 2 ? 429 : 200) : t === 'android-u4-1' ? 503 : 200));
  const e = edge({ tokens, answer });
  const r = await e.call({ broadcast_id: ROW.id });
  assert.deepEqual(e.deletes.sort(), ['android-u2-1', 'ios-u1-1'], '무효 토큰 정리(shouldDropToken 그대로)');
  assert.equal(e.attempts.get('ios-u1-1'), 1, '무효 토큰은 재시도하지 않는다'); assert.equal(e.attempts.get('android-u2-1'), 1);
  assert.equal(e.attempts.get('ios-u3-1'), 2, '429 한 번 뒤 성공'); assert.equal(e.attempts.get('android-u4-1'), 3, '503은 3번에서 멈춘다');
  assert.equal(core.BROADCAST_MAX_ATTEMPTS, 3);
  assert.deepEqual({ sent: r.json.sent, failed: r.json.failed }, { sent: 2, failed: 3 });
});

test('동시 발송은 10개까지, 기기 수 상한(PUSH_BROADCAST_MAX)을 넘으면 상한까지만 보내고 truncated', async () => {
  const many = Array.from({ length: 1205 }, (_, i) => tok(`u${i}`, i % 2 ? 'ios' : 'android', 1));
  const e = edge({ tokens: many, delayMs: 1, env: { PUSH_BROADCAST_MAX: '1100' } });
  const r = await e.call({ broadcast_id: ROW.id });
  assert.ok(e.maxInflight() <= 10, `동시 ${e.maxInflight()}개`); assert.ok(e.maxInflight() >= 2, '병렬로는 보낸다');
  assert.deepEqual({ tokens: r.json.tokens, sent: r.json.sent, truncated: r.json.truncated }, { tokens: 1100, sent: 1100, truncated: true }, '1000행 넘는 목록도 끝까지 읽고 상한에서 자른다');
  const e2 = edge({ tokens: many.slice(0, 3) });
  const r2 = await e2.call({ broadcast_id: ROW.id });
  assert.equal(r2.json.truncated, false);
});

test('인접 핀: 메시지 알림(message_id) 경로는 그대로 — broadcast_id가 없는 본문은 종전 검사(잘못된 message_id → 400)', async () => {
  const e = edge({ tokens: [] });
  assert.equal((await e.call({ message_id: 'x' })).status, 400);
  assert.equal((await e.call({})).status, 400);
});
