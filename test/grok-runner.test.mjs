// Grok 러너 — BYOK(키) + BYOA(기기 코드). 실측 근거는 src/runners/grok.mjs 머리 주석.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNNERS, RUNNER_AUTH, GROK_DEFAULT_MODEL } from '../src/runners/catalog.mjs';
import { grokAccessToken, grokNeedsRefresh, packGrokTokens, pollGrokDeviceLogin, refreshGrokTokens, startGrokDeviceLogin } from '../src/runners/grok.mjs';

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('카탈로그 — 기본 모델은 첫 항목과 같아야 한다(러너 전환의 기본값)', () => {
  assert.equal(RUNNERS.grok.kind, 'sdk-compat');
  assert.equal(RUNNERS.grok.models[0].id, GROK_DEFAULT_MODEL);
  // 두 방식 모두 열려 있다 — 키만 되거나 계정만 되면 그 자체가 편파다(러너 중립성).
  assert.deepEqual(RUNNER_AUTH.grok.methods, ['apikey', 'oauth']);
  assert.equal(RUNNER_AUTH.grok.deviceCode, true);
  // 붙여넣을 코드가 없는 흐름이다 — true면 UI가 쓸모없는 입력칸을 띄운다
  assert.equal(RUNNER_AUTH.grok.oauthPasteable, false);
});

test('접두사를 걸지 않는다 — 키 형식이 바뀌어도 저장이 막히지 않게(GLM·Kimi 관례)', () => {
  assert.equal(RUNNER_AUTH.grok.apikeyPrefix, '');
});

test('토큰 포장 — expires_at은 절대시각, 없으면 1시간으로 본다', () => {
  const now = 1_000_000;
  assert.deepEqual(packGrokTokens({ access_token: 'a', refresh_token: 'r', expires_in: 120 }, now),
    { access_token: 'a', refresh_token: 'r', expires_at: now + 120_000 });
  assert.equal(packGrokTokens({ access_token: 'a' }, now).expires_at, now + 3_600_000);
  assert.equal(packGrokTokens({}, now), null, 'access_token이 없으면 저장할 게 없다');
});

test('저장 형식이 무엇이든 토큰을 꺼낸다 — 구형(생 토큰)도 받는다', () => {
  assert.equal(grokAccessToken(JSON.stringify({ access_token: 'tok-1' })), 'tok-1');
  assert.equal(grokAccessToken('raw-token'), 'raw-token');
  assert.equal(grokAccessToken(''), '');
});

test('갱신 판정 — 만료 60초 전부터, 갱신 토큰이 있을 때만', () => {
  const now = 2_000_000;
  const mk = (exp, refresh = true) => JSON.stringify({ access_token: 'a', ...(refresh ? { refresh_token: 'r' } : {}), expires_at: exp });
  assert.equal(grokNeedsRefresh(mk(now + 30_000), now), true);
  assert.equal(grokNeedsRefresh(mk(now + 600_000), now), false);
  assert.equal(grokNeedsRefresh(mk(now + 30_000, false), now), false, '갱신 토큰이 없으면 갱신할 수 없다');
  assert.equal(grokNeedsRefresh('raw-token', now), false, '구형 값은 건드리지 않는다');
});

test('갱신 응답이 refresh_token을 안 줘도 쓰던 것을 유지한다 — 안 그러면 다음 갱신이 불가능해진다', async () => {
  const stored = JSON.stringify({ access_token: 'old', refresh_token: 'keep-me', expires_at: 1 });
  const next = await refreshGrokTokens(stored, async () => jsonRes({ access_token: 'new', expires_in: 3600 }));
  const d = JSON.parse(next);
  assert.equal(d.access_token, 'new');
  assert.equal(d.refresh_token, 'keep-me');
});

test('갱신 실패는 null — 호출부가 쓰던 토큰으로 진행한다(일시 장애가 연결 해제로 둔갑하지 않게)', async () => {
  const stored = JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: 1 });
  assert.equal(await refreshGrokTokens(stored, async () => jsonRes({ error: 'nope' }, 400)), null);
  assert.equal(await refreshGrokTokens(stored, async () => { throw new Error('네트워크'); }), null);
  assert.equal(await refreshGrokTokens('raw', async () => jsonRes({})), null);
});

test('기기 코드 시작 — 사용자에게 줄 주소·코드를 그대로 돌려준다', async () => {
  let sent = null;
  const r = await startGrokDeviceLogin(async (url, init) => {
    sent = { url, body: init.body };
    return jsonRes({ device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH', interval: 5, expires_in: 1800 });
  });
  assert.equal(r.ok, true);
  assert.equal(r.userCode, 'ABCD-EFGH');
  assert.equal(r.deviceCode, 'dev-1');
  assert.match(r.url, /accounts\.x\.ai/);
  assert.equal(sent.url, 'https://auth.x.ai/oauth2/device/code');
  // 갱신 토큰을 받으려면 offline_access가 반드시 실려야 한다 — 빠지면 만료마다 재로그인이다
  assert.match(sent.body, /offline_access/);
  assert.match(sent.body, /grok-cli%3Aaccess/);
});

test('규격과 다른 응답은 성공으로 치지 않는다', async () => {
  const r = await startGrokDeviceLogin(async () => jsonRes({ device_code: 'only-device' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'device-shape');
});

test('폴링 — 대기 신호(authorization_pending·slow_down)는 실패가 아니다', async () => {
  const pending = await pollGrokDeviceLogin('dev-1', async () => jsonRes({ error: 'authorization_pending' }, 400));
  assert.deepEqual(pending, { ok: false, pending: true, slowDown: false });
  const slow = await pollGrokDeviceLogin('dev-1', async () => jsonRes({ error: 'slow_down' }, 400));
  assert.equal(slow.pending, true);
  assert.equal(slow.slowDown, true);
  // 진짜 실패는 그대로 올린다 — 대기로 뭉개면 사용자는 영원히 도는 스피너를 본다
  const denied = await pollGrokDeviceLogin('dev-1', async () => jsonRes({ error: 'access_denied' }, 400));
  assert.equal(denied.ok, false);
  assert.equal(denied.pending, undefined);
  assert.equal(denied.reason, 'access_denied');
});

test('폴링 성공 — 저장 형식(JSON 문자열)으로 돌려준다', async () => {
  let sent = null;
  const r = await pollGrokDeviceLogin('dev-1', async (url, init) => { sent = { url, body: init.body }; return jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }); });
  assert.equal(r.ok, true);
  const d = JSON.parse(r.tokens);
  assert.equal(d.access_token, 'at');
  assert.ok(d.expires_at > Date.now());
  assert.equal(sent.url, 'https://auth.x.ai/oauth2/token');
  assert.match(sent.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
});

test('기기 코드 상태는 스코프별로 격리된다 — 남의 시작이 내 세션을 덮으면 로그인이 영원히 안 끝난다', async () => {
  // 분리 검수 2026-08-03 M3. 시작하지 않은 스코프의 폴링은 남의 세션을 보지 못하고 no-session이어야 한다.
  const { pollRunnerDeviceAuth } = await import('../src/runners/webauth.mjs');
  const r = await pollRunnerDeviceAuth('grok', 'ws-never-started');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-session');
});

test('기기 코드는 러너 단위 전역 키를 쓰지 않는다(소스 트립와이어)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/runners/webauth.mjs', import.meta.url), 'utf8');
  assert.match(src, /const deviceKey = \(runner, wsId\)/);
  const dev = src.slice(src.indexOf('const DEVICE_OAUTH'));
  assert.doesNotMatch(dev, /webAuthState\[runner\]/, '기기 코드 분기가 러너 단위 전역 키로 되돌아갔다');
});

/* ── 크레딧 소진을 인증 실패로 오안내하던 것 (실사용 신고 2026-08-03) ──────────────────
   유건 계정으로 BYOA 연결에 성공한 직후 첫 턴이 "Failed to authenticate. API Error: 403"으로
   죽었다. 실제 원인은 xAI 계정 잔액이었다(토큰은 통과). 사용자는 방금 성공한 로그인을 의심한다. */
test('크레딧 소진은 인증 실패가 아니다 — 실측 본문으로 판정한다', async () => {
  const { isGrokCreditError, grokCreditNotice } = await import('../src/runners/grok.mjs');
  // 실측 원문(2026-08-03): 403/402 모두 같은 code
  const real = 'Claude Code returned an error result: Failed to authenticate. API Error: 403 {"code":"personal-team-blocked:spending-limit","error":"You have run out of credits or need a Grok subscription."}';
  assert.equal(isGrokCreditError(real), true);
  // 진짜 인증 오류까지 크레딧으로 몰면 안 된다 — 상태코드가 아니라 본문으로 가르는 이유다
  assert.equal(isGrokCreditError('API Error: 403 {"code":"forbidden","error":"invalid api key"}'), false);
  assert.equal(isGrokCreditError('401 authentication_error'), false);
  // 안내는 갈 곳(충전·구독)을 함께 준다 + "로그인은 정상"을 명시한다
  for (const lang of ['ko', 'en']) {
    const n = grokCreditNotice(lang);
    assert.match(n, /console\.x\.ai/);
    assert.match(n, /grok\.com\/supergrok/);
  }
  assert.match(grokCreditNotice('ko'), /로그인 자체는 정상/);
  assert.match(grokCreditNotice('en'), /sign-in itself worked/);
});

test('배선 — chat·oneshot 두 갈래 모두에 걸린다(한쪽만 고치면 다른 경로가 옛 문구로 남는다)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['../src/chat.mjs', '../src/oneshot.mjs']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /isGrokCreditError/, `${f}에 배선 없음`);
    assert.match(src, /grokCreditNotice/, `${f}에 안내 없음`);
  }
});
