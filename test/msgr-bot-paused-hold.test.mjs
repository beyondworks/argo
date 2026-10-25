// msgr-bot 중단 응답 늦게 주기(2026-10-25 남은 옛 v1 토큰 호출 — 맥 one 운영 10분: node getUpdates 429 214건(2곳)·Python getMe 401 41건(1곳)).
// 옛 연결 도구는 retry_after를 따르지 않는다: OpenClaw ≤0.3.3은 429에 1→30초 사다리(받기 timeout=20, 35초에 끊음), Hermes는 게이트웨이가 약 15초마다 getMe로 다시 연결.
// 서버는 같은 응답을 클라이언트가 끊기 전까지 붙잡았다가 준다(DB 호출 없음). 잠그는 것: 붙잡는 시간 < 클라이언트가 끊는 시각, 실제 받기 루프로 잰 시간당 요청 수.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pausedHoldMs, HOLD_MAX_MS } from '../supabase/functions/msgr-bot/paused.js';
import { pollLoop, ArgoMsgrError } from '../integrations/openclaw-argo-msgr/src/api.js';

const T = 'argo_bot_' + 'c'.repeat(48);
const p = (m) => `/msgr-bot/bot${T}/${m}`;

test('붙잡는 시간: 받기 = 요청 timeout + 8초(상한 140초), Python getMe 20초, node getMe·보내기·연결 스크립트·timeout 없는 받기는 곧바로', () => {
  assert.equal(pausedHoldMs({ path: p('getUpdates'), userAgent: 'node', timeout: '20' }), 28_000);
  assert.equal(pausedHoldMs({ path: p('getUpdates'), userAgent: 'Python-urllib/3.12', timeout: '50' }), 58_000);
  assert.equal(pausedHoldMs({ path: p('getUpdates'), userAgent: 'node', timeout: '140' }), HOLD_MAX_MS);
  assert.equal(pausedHoldMs({ path: p('getUpdates'), userAgent: 'node', timeout: null }), 0);
  assert.equal(pausedHoldMs({ path: p('getMe'), userAgent: 'Python-urllib/3.12' }), 20_000);
  assert.equal(pausedHoldMs({ path: p('getMe'), userAgent: 'node' }), 0);
  for (const m of ['sendMessage', 'getFile', 'reportStatus']) assert.equal(pausedHoldMs({ path: p(m), userAgent: 'node', timeout: '20' }), 0, m);
  assert.equal(pausedHoldMs({ path: '/msgr-bot/connect' }), 0);
});

test('클라이언트가 끊기 전에 답한다 — 받기 timeout t는 t + 15초에 끊고(OpenClaw·Hermes 모두), getMe는 urllib 30초', () => {
  for (const t of [20, 25, 50, 140]) assert.ok(pausedHoldMs({ path: p('getUpdates'), userAgent: 'node', timeout: String(t) }) <= (t + 15) * 1000 - 5_000, `timeout ${t}`);
  assert.ok(pausedHoldMs({ path: p('getMe'), userAgent: 'Python-urllib/3.12' }) <= 30_000 - 5_000);
  assert.ok(HOLD_MAX_MS < 150_000, '엣지 벽시계 상한 아래');
});

/** 옛 OpenClaw(≤0.3.3)의 받기 루프 1계정 1시간 — 실제 pollLoop에 retry_after 없는 429(옛판이 읽지 않는 것과 같다)를 준다. 반환 = 요청 수 */
async function oldOpenClawHour(holdMs) {
  let t = 0; let n = 0; const ctl = new AbortController();
  const api = { getUpdates: async () => { n += 1; t += holdMs; if (t >= 3_600_000) ctl.abort(); throw new ArgoMsgrError(429, 'Too Many Requests', null); } };
  await pollLoop(api, { onMessage: async () => {}, signal: ctl.signal, sleep: async (ms) => { t += ms; if (t >= 3_600_000) ctl.abort(); } });
  return n;
}

test('측정: 옛 OpenClaw 1계정 60분 — 종전(곧바로 429) 약 2회/분 → 붙잡기(28초) 약 1회/분, Hermes 게이트웨이(15초마다 다시 연결) 4회/분 → 약 1.7회/분', async () => {
  const before = await oldOpenClawHour(0); const after = await oldOpenClawHour(28_000);
  assert.ok(before >= 118 && before <= 126, `종전 ${before}`); // 사다리 1·2·4·8·16·30초 뒤 30초마다
  assert.ok(after >= 60 && after <= 66, `붙잡기 ${after}`); // 28초 + 30초마다(처음 몇 번은 사다리가 짧다)
  assert.ok(after / before <= 0.55);
  const hermes = (hold) => Math.floor(3_600_000 / (hold + 15_000));
  assert.equal(hermes(0), 240); assert.equal(hermes(20_000), 102);
});

test('배선: 엣지(index.ts)는 중단 경로에서 붙잡은 뒤 같은 중단 응답을 준다 — RPC·DB 없이(중단 경로가 RPC보다 먼저 돌려준다)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../supabase/functions/msgr-bot/index.ts', import.meta.url), 'utf8');
  const paused = src.slice(src.indexOf("if (route === 'paused') {"), src.indexOf("if (route === 'connect')"));
  assert.match(paused, /const hold = pausedHoldMs\(\{ path, userAgent, timeout: url\.searchParams\.get\('timeout'\) \}\);/);
  assert.match(paused, /if \(hold > 0\) await new Promise\(\(r\) => setTimeout\(r, hold\)\);/);
  assert.match(paused, /return new Response\(r\.body, \{ status: r\.status, headers: r\.headers \}\);/);
  assert.doesNotMatch(paused, /rpc\(|fetch\(/, 'DB·외부 호출 없음');
});
