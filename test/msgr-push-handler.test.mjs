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

function edge({ rejectDevice = null, failSigning = 0 } = {}) {
  const delivered = [], providerTokens = new Set(), claimed = new Set(), writes = [], logs = [], reportClaims = new Set(), sentText = [], collapse = [];
  let handler, minted = 0, currentProviderToken, providerChangedAt = 0;
  const clock = { now: 1_800_000_000_000 };
  const statuses = [];
  const config = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service', APNS_KEY_P8: p8, APNS_KEY_ID: 'TESTKEY', APNS_TEAM_ID: 'TESTTEAM' };
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.push.apple.com') {
      const jwt = init.headers.authorization;
      providerTokens.add(jwt);
      if (currentProviderToken !== jwt) {
        if (currentProviderToken && clock.now - providerChangedAt < 20 * 60_000) return Response.json({ reason: 'TooManyProviderTokenUpdates' }, { status: 429 });
        currentProviderToken = jwt; providerChangedAt = clock.now;
      }
      if (url.pathname.endsWith(`/${rejectDevice}`)) return Response.json({ reason: 'TooManyRequests' }, { status: 429 });
      delivered.push(url.pathname.split('/').at(-1)); sentText.push(JSON.parse(init.body).aps?.alert); collapse.push(init.headers['apns-collapse-id']);
      return new Response(null, { status: 200 });
    }
    assert.equal(url.hostname, 'database.test');
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === 'msgr_push_sent' && init.method === 'POST') {
      const { message_id } = JSON.parse(init.body);
      if (claimed.has(message_id)) return new Response(null, { status: 409 });
      claimed.add(message_id); return new Response(null, { status: 201 });
    }
    if (path === 'msgr_push_sent' && init.method === 'PATCH') { writes.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (path === 'msgr_reports' && init.method === 'PATCH') { // notified_at 선점 흉내 — 한 번만 행을 돌려준다
      const id = url.searchParams.get('id').replace('eq.', ''); assert.equal(url.searchParams.get('notified_at'), 'is.null');
      if (reportClaims.has(id)) return Response.json([]); reportClaims.add(id);
      return Response.json([{ id, org_id: null, channel_id: 'dm', message_id: 7, reason: '괴롭힘', body_snapshot: '문제 글' }]);
    }
    if (path === 'msgr_report_operators') return Response.json([{ user_id: 'operator' }]);
    if (path === 'msgr_messages') return Response.json([{ id: 1, channel_id: 'channel', author_kind: 'crew', crew_id: 'crew', kind: 'text', body: 'fixture' }]);
    if (path === 'rpc/msgr_push_recipients_of') return Response.json(['recipient']);
    if (path === 'msgr_push_tokens') return Response.json(['phone-a', 'phone-b', 'phone-c'].map((token) => ({ token, platform: 'ios', user_id: 'recipient' })));
    if (path === 'msgr_channels') return Response.json([{ kind: 'dm', name: '' }]);
    if (path === 'msgr_crews') return Response.json([{ display_name: 'Fixture' }]);
    if (path === 'rpc/msgr_push_unread_total') return Response.json(1);
    throw new Error(`Unexpected fixture route ${path}`);
  };
  vm.runInNewContext(source, {
    ...core, apnsJwt: async (args) => { minted++; if (minted <= failSigning) throw new Error('fixture signing failure'); return core.apnsJwt(args); },
    Deno: { env: { get: (name) => config[name] }, serve: (fn) => { handler = fn; } },
    fetch, Response, Request, TextEncoder, crypto, Date: class extends Date { static now() { return clock.now; } },
    console: { log: (...args) => logs.push(args) },
  });
  const invoke = async (body) => {
    const response = await handler(new Request('https://edge.test', { method: 'POST', body: JSON.stringify(body) }));
    statuses.push(response.status); return response.json();
  };
  return { send: (id = 1) => invoke({ message_id: id }), report: (id) => invoke({ report_id: id }), sentText, collapse,
    badge: () => invoke({ badge_user: '11111111-1111-1111-1111-111111111111' }),
    delivered, providerTokens, writes, logs, clock, statuses, minted: () => minted };
}

test('cold alert fanout shares one provider JWT across all iPhones', async () => {
  const app = edge();
  const result = await app.send();
  assert.equal(app.minted(), 1, 'one concurrent JWT signing operation');
  assert.deepEqual(result.results, ['ok', 'ok', 'ok']);
  assert.equal(result.sent, 3);
  assert.equal(result.ok, true);
  assert.equal(app.providerTokens.size, 1);
  assert.deepEqual(app.delivered.sort(), ['phone-a', 'phone-b', 'phone-c']);
});

test('warm alert and badge requests reuse the same provider JWT', async () => {
  const app = edge();
  await app.badge();
  assert.equal((await app.send()).sent, 3);
  assert.equal((await app.send(2)).sent, 3);
  assert.equal(app.minted(), 1);
  assert.equal(app.providerTokens.size, 1);
});

test('a partial provider failure stays visible and replay does not resend accepted devices', async () => {
  const app = edge({ rejectDevice: 'phone-b' });
  assert.equal((await app.badge()).ok, false, 'badge failure is not total success');
  app.delivered.length = 0;
  const result = await app.send();
  assert.equal(result.sent, 2);
  assert.equal(result.ok, false);
  assert.equal(app.statuses.at(-1), 200, 'batch was processed; HTTP retry would duplicate accepted pushes');
  assert.match(result.results[1], /apns 429.*TooManyRequests/);
  assert.equal(app.writes.at(-1).sent, 2);
  assert.equal((await app.send()).dup, true);
  assert.deepEqual(app.delivered.sort(), ['phone-a', 'phone-c']);
});


test('45-minute boundary refresh shares one new JWT and uses its issue time', async () => {
  const app = edge();
  assert.equal((await app.send()).sent, 3);
  app.clock.now += 45 * 60_000 - 1;
  assert.equal((await app.send(2)).sent, 3);
  assert.equal(app.minted(), 1);
  app.clock.now += 1;
  assert.equal((await app.send(3)).sent, 3);
  assert.equal(app.minted(), 2);
  assert.equal(app.providerTokens.size, 2);
  const jwts = [...app.providerTokens].map((value) => JSON.parse(Buffer.from(value.split('.')[1], 'base64url')));
  assert.equal(jwts[1].iat - jwts[0].iat, 45 * 60);
});

test('failed signing is shared, reported, and cleared for the next message', async () => {
  const app = edge({ failSigning: 1 });
  const failed = await app.send();
  assert.equal(failed.ok, false);
  assert.equal(failed.sent, 0);
  assert.equal(app.minted(), 1);
  assert.equal(app.delivered.length, 0);
  assert.equal(failed.results.filter((value) => value.includes('fixture signing failure')).length, 3);
  assert.equal((await app.send(2)).sent, 3);
  assert.equal(app.minted(), 2);
});

test('신고 접수 푸시는 운영자 기기로 한 번만 간다(재생 호출은 dup)', async () => {
  const app = edge();
  const rid = '22222222-2222-4222-8222-222222222222';
  const first = await app.report(rid);
  assert.equal(first.sent, 3);
  assert.deepEqual(app.sentText[0], { title: '신고 접수 · 개인 대화', body: '괴롭힘 — 문제 글' });
  assert.deepEqual([...new Set(app.collapse)], [`report-${rid}`], '신고 알림은 채널 메시지 알림과 칸을 나눈다(검수 M2)');
  assert.equal((await app.report(rid)).dup, true, '같은 신고 재호출은 보내지 않는다');
  assert.equal(app.delivered.length, 3);
});

test('일반 메시지 알림의 알림 칸은 종전 그대로 ch-<채널>', async () => {
  const app = edge();
  await app.send();
  assert.deepEqual([...new Set(app.collapse)], ['ch-channel']);
});
