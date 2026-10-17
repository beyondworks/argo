// 메신저 v2 휴대폰 알림 엣지 함수(supabase/functions/msgr2-push) — index.ts를 타입만 지워 vm에서 돌리고, DB(REST)·APNs·FCM은 가짜 서버(fetch 대역)로 판정한다.
// 받는 사람 판정·트리거·멱등 장부의 SQL 쪽은 test/msgr2-push-pg.test.mjs(실제 PG).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as core from '../supabase/functions/msgr2-push/core.js';

const source = stripTypeScriptTypes(await readFile(new URL('../supabase/functions/msgr2-push/index.ts', import.meta.url), 'utf8')).replace(/^import .* from .*;$/gm, '');
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const p8 = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', ec.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const rsaPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const IOS = 'a'.repeat(64);
const AND = 'fcm-token:APA91bExampleTokenValue_1234567890';
const ROOM = '11111111-2222-4333-8444-555555555555';

/** 가짜 서버들 + 엣지 핸들러. apns/fcm = 토큰 → 답 순서 배열(마지막 값이 계속), 기본 200. */
function edge({ msg = {}, recipients = [{ user_id: 'u2', push_token: IOS }, { user_id: 'u3', push_token: AND }], apns = {}, fcm = {}, secret = 'push-s', room = { name: '팀방', kind: 'private', space_id: 'sp1' } } = {}) {
  const claimed = new Set(); const calls = { apns: [], fcm: [], drops: [], patches: [], rpc: 0, delays: [], logs: [] };
  const message = { id: 9, room_id: ROOM, author_kind: 'agent', author_user_id: null, author_agent_id: 'ag1', kind: 'text', body: '초안을 올렸습니다', meta: {}, deleted_at: null, ...msg };
  const next = (map, tok) => { const q = map[tok]; if (!q) return 200; return q.length > 1 ? q.shift() : q[0]; };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.push.apple.com') {
      const tok = url.pathname.split('/').at(-1); const st = next(apns, tok);
      calls.apns.push({ tok, body: JSON.parse(init.body), collapse: init.headers['apns-collapse-id'] });
      return st === 200 ? new Response(null, { status: 200 }) : Response.json({ reason: st === 410 ? 'Unregistered' : 'TooManyRequests' }, { status: st });
    }
    if (url.hostname === 'oauth.test') return Response.json({ access_token: 'fcm-access' });
    if (url.hostname === 'fcm.googleapis.com') {
      const b = JSON.parse(init.body); const tok = b.message.token; const st = next(fcm, tok);
      calls.fcm.push({ tok, body: b });
      return st === 200 ? Response.json({ name: 'ok' }) : new Response(st === 404 ? '{"error":{"status":"NOT_FOUND","message":"UNREGISTERED"}}' : '{"error":"x"}', { status: st });
    }
    assert.equal(url.hostname, 'db.test');
    if (url.pathname.startsWith('/auth/v1/')) return new Response('nf', { status: 404 });
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === 'msgr2_push_sent' && init.method === 'POST') {
      const { message_id } = JSON.parse(init.body);
      if (claimed.has(message_id)) return new Response('dup', { status: 409 });
      claimed.add(message_id); return new Response(null, { status: 201 });
    }
    if (path === 'msgr2_push_sent' && init.method === 'PATCH') { calls.patches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (path === 'msgr2_messages') return Response.json([message]);
    if (path === 'rpc/msgr2_push_recipients') { calls.rpc++; assert.deepEqual(JSON.parse(init.body), { p_message: message.id }); return Response.json(recipients); }
    if (path === 'msgr2_rooms') return Response.json([room]);
    if (path === 'msgr2_agents') return Response.json([{ display_name: '에이' }]);
    if (path === 'msgr2_space_members') return Response.json([{ display_name: '유건' }]);
    if (path === 'msgr2_devices' && init.method === 'PATCH') { calls.drops.push({ token: decodeURIComponent(url.search.split('eq.')[1]), body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${path}`);
  };
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', APNS_KEY_P8: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', PUSH_FN_SECRET: secret,
    FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@x.test', private_key: rsaPem, project_id: 'proj', token_uri: 'https://oauth.test/token' }) };
  let handler;
  vm.runInNewContext(source, {
    ...core, Deno: { env: { get: (k) => env[k] }, serve: (fn) => { handler = fn; } },
    fetch, Response, Request, TextEncoder, URLSearchParams, crypto, Date, JSON, Number, String, Math, Promise, Set, Map, Uint8Array, encodeURIComponent,
    setTimeout: (fn, ms) => { calls.delays.push(ms); return setImmediate(fn); }, // 재시도 간격은 기록만(시험은 기다리지 않는다)
    console: { log: (...a) => calls.logs.push(a.join(' ')) },
  });
  const send = async (body = { message_id: message.id }, auth = `Bearer ${secret}`) => {
    const r = await handler(new Request('https://edge.test', { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) }));
    return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
  };
  return { send, calls };
}

test('글 하나 → 받는 사람 기기마다 한 번(iOS는 APNs, Android는 FCM), 문구 "이름 · #방", 장부에 결과', async () => {
  const e = edge();
  const r = await e.send();
  assert.deepEqual(r.body, { ok: true, sent: 2, failed: 0 });
  assert.deepEqual(e.calls.apns.map((x) => x.tok), [IOS]);
  assert.deepEqual(e.calls.fcm.map((x) => x.tok), [AND]);
  assert.deepEqual(e.calls.apns[0].body.aps.alert, { title: '에이 · #팀방', body: '초안을 올렸습니다' });
  assert.equal(e.calls.apns[0].body.channel_id, ROOM);
  assert.equal(e.calls.apns[0].collapse, `room-${ROOM}`.slice(0, 64));
  assert.equal(e.calls.fcm[0].body.message.notification.title, '에이 · #팀방');
  assert.deepEqual({ ...e.calls.patches[0], finished_at: 'x' }, { tokens: 2, sent: 2, failed: 0, finished_at: 'x' });
  assert.ok(!e.calls.logs.join(' ').includes(IOS) && !e.calls.logs.join(' ').includes('초안'), '로그에 토큰·본문 없음');
});

test('멱등: 같은 글을 두 번 받아도(재생·재시도) 두 번째는 보내지 않는다', async () => {
  const e = edge();
  await e.send();
  const again = await e.send();
  assert.deepEqual(again.body, { ok: true, dup: true });
  assert.equal(e.calls.apns.length + e.calls.fcm.length, 2);
  assert.equal(e.calls.rpc, 1);
});

test('일시 오류는 간격을 두고 기기마다 3번까지(1초 → 3초), 성공하면 멈춘다', async () => {
  const ok = edge({ apns: { [IOS]: [503, 200] } });
  assert.equal((await ok.send()).body.sent, 2);
  assert.equal(ok.calls.apns.length, 2);
  assert.deepEqual(ok.calls.delays, [1000]);
  const bad = edge({ apns: { [IOS]: [429] }, fcm: { [AND]: [500] } });
  const r = await bad.send();
  assert.deepEqual(r.body, { ok: false, sent: 0, failed: 2 });
  assert.equal(bad.calls.apns.length, 3); assert.equal(bad.calls.fcm.length, 3);
  assert.deepEqual(bad.calls.delays.sort((a, b) => a - b), [1000, 1000, 3000, 3000]);
});

test('무효 토큰(APNs 410·FCM UNREGISTERED)은 다시 보내지 않고 기기 행의 push_token만 비운다', async () => {
  const e = edge({ apns: { [IOS]: [410] }, fcm: { [AND]: [404] } });
  const r = await e.send();
  assert.equal(r.body.sent, 0);
  assert.equal(e.calls.apns.length, 1); assert.equal(e.calls.fcm.length, 1);
  assert.deepEqual(e.calls.drops.map((d) => [d.token, d.body]).sort(), [[AND, { push_token: null }], [IOS, { push_token: null }]].sort());
});

test('받을 사람이 없거나 지운 글이면 공급자 호출 0, 같은 토큰이 둘이면 한 번', async () => {
  const none = edge({ recipients: [] });
  assert.deepEqual((await none.send()).body, { ok: true, sent: 0 });
  assert.equal(none.calls.apns.length + none.calls.fcm.length, 0);
  const del = edge({ msg: { deleted_at: '2026-10-18T00:00:00Z' } });
  assert.deepEqual((await del.send()).body, { ok: true, sent: 0 });
  assert.equal(del.calls.rpc, 0);
  const twin = edge({ recipients: [{ user_id: 'u2', push_token: IOS }, { user_id: 'u2', push_token: IOS }] });
  await twin.send();
  assert.equal(twin.calls.apns.length, 1);
});

test('인증: 비밀이 다르면 401, message_id가 정수가 아니면 400 — 장부를 잡지 않는다', async () => {
  const e = edge();
  assert.equal((await e.send(undefined, 'Bearer nope')).status, 401);
  assert.equal((await e.send({ message_id: 'x' })).status, 400);
  assert.equal((await e.send({ message_id: 2 ** 60 })).status, 400);
  assert.equal(e.calls.rpc, 0);
});

test('승인 요청 카드는 "승인 요청" 머리, 1:1 방은 제목에 방 이름이 없다, 사람 작성자는 공간 멤버 이름', async () => {
  const e = edge({ msg: { kind: 'card', body: '메일 3통 발송', meta: { code: 'approval.request' }, author_kind: 'user', author_user_id: 'u1', author_agent_id: null }, room: { name: null, kind: 'direct', space_id: 'sp1' } });
  await e.send();
  assert.deepEqual(e.calls.apns[0].body.aps.alert, { title: '유건', body: '승인 요청 · 메일 3통 발송' });
});

test('core: platformOf(접두·64자 16진수·그 밖 FCM·빈 값), pushText 미리보기 상한', () => {
  assert.deepEqual(core.platformOf(IOS.toUpperCase()), { platform: 'ios', token: IOS });
  assert.deepEqual(core.platformOf(`ios:${'b'.repeat(64)}`), { platform: 'ios', token: 'b'.repeat(64) });
  assert.deepEqual(core.platformOf('android:abc'), { platform: 'android', token: 'abc' });
  assert.deepEqual(core.platformOf(AND), { platform: 'android', token: AND });
  assert.equal(core.platformOf(''), null); assert.equal(core.platformOf('has space token value here'), null); assert.equal(core.platformOf('ios:'), null);
  const t = core.pushText({ body: '가'.repeat(500), authorName: '에이'.repeat(80), roomName: '방', roomKind: 'open' });
  assert.equal(t.body.length, core.PREVIEW_MAX); assert.equal(t.title.length, core.TITLE_MAX);
  assert.equal(core.pushText({ body: '  \n ', authorName: '', roomKind: 'direct' }).body, '…');
  assert.equal(core.retryable('apns 503 x', 1), true); assert.equal(core.retryable('apns 503 x', 3), false); assert.equal(core.retryable('apns 410 x', 1), false);
});
