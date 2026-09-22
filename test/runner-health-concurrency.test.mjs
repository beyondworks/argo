// 러너 검진의 동시 쓰기·재연결 회복 회귀 테스트 (2026-09-22 감사 K15·K36)
// K15: 검진은 상태를 읽고 verify(수십 초)를 기다린 뒤 통째로 덮어썼다 → 그사이 재연결(saveRunnerCred → clearHealthEntry)이
//      지운 항목을 옛 실패로 되살리고, 턴이 남긴 인증 실패(markRunnerAuthFail)를 성공으로 덮었다.
// K36: 재연결이 항목을 지우면 다음 성공 검진이 "직전 실패"를 몰라 회복 이벤트를 안 남겨 카드가 옛 실패를 계속 그렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey();

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-hcchome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hcc-'));
const { runHealthChecks, markRunnerAuthFail, HEALTH_INTERVAL_MS } = await import('../src/runner-health.mjs');
const { saveRunnerCred } = await import('../src/runners.mjs');
const { credHash } = await import('../src/runners/shared.mjs');
const { readEvents } = await import('../src/events.mjs');
const { lastHealthFailByRunner } = await import('../app/runner-usable.mjs');

const T0 = 1_760_000_000_000;
const noProbe = async () => ({ ok: null });
async function seed(ws, creds) {
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  for (const [runner, [type, value]] of Object.entries(creds)) await saveRunnerCred(ws, runner, type, value);
}
const stateOf = async (ws) => JSON.parse(await readFile(join(process.env.ARGO_ROOT, ws, '.runner-health.json'), 'utf8'));
const healthEvents = async (ws, runner) => (await readEvents(ws, 50)).filter((e) => e.type === 'runner-health' && e.runner === runner).map((e) => e.ok);

test('K15: 검진 도중 재연결하면 옛 자격의 실패로 새 자격 항목을 되살리지 않는다', async () => {
  const ws = 'hcc-reconnect';
  await seed(ws, { glm: ['apikey', 'glm-old'] });
  await runHealthChecks(ws, { verifyFn: async () => ({ ok: false, reason: 'auth' }), probeFn: noProbe, nowMs: T0, jitterMs: 0 });
  assert.equal((await stateOf(ws)).glm.ok, false, '전제: 옛 자격 실패가 기록됨');
  // 옛 자격으로 verify가 도는 사이 사용자가 새 키로 재연결(실제 경로 saveRunnerCred → clearHealthEntry)
  await runHealthChecks(ws, {
    verifyFn: async () => { await saveRunnerCred(ws, 'glm', 'apikey', 'glm-new'); return { ok: false, reason: 'auth' }; },
    probeFn: noProbe, nowMs: T0 + HEALTH_INTERVAL_MS * 4, jitterMs: 0,
  });
  const glm = (await stateOf(ws)).glm;
  assert.notEqual(glm?.ok, false, '재연결이 지운 항목에 옛 실패가 다시 쓰이면 새 자격이 옛 백오프·실패 표시를 물려받는다');
  assert.ok(!(Number(glm?.at) > 0), '새 자격은 다음 검진에서 즉시 확인돼야 한다(옛 시각이 남으면 백오프 대기)');
});

test('K15: 검진 도중 턴이 확정한 인증 실패를 검진 결과로 덮지 않는다', async () => {
  const ws = 'hcc-turnfail';
  await seed(ws, { claude: ['apikey', 'sk-ant-x'] });
  await runHealthChecks(ws, {
    verifyFn: async () => { await markRunnerAuthFail(ws, 'claude', 'sk-ant-x', { nowMs: T0 }); return { ok: true }; },
    probeFn: noProbe, nowMs: T0, jitterMs: 0,
  });
  const claude = (await stateOf(ws)).claude;
  assert.equal(claude.ok, false, '턴 인증 실패(턴 전 게이트의 열쇠)가 사라지면 다음 턴이 같은 죽은 자격으로 또 나간다');
  assert.equal(claude.reason, 'auth');
  assert.equal(claude.credHash, credHash('sk-ant-x'));
});

test('K15: 다른 러너의 검진 결과는 그대로 저장된다(병합은 바뀐 러너만 건너뛴다)', async () => {
  const ws = 'hcc-merge';
  await seed(ws, { claude: ['apikey', 'sk-ant-y'], glm: ['apikey', 'glm-y'] });
  await runHealthChecks(ws, {
    verifyFn: async (runner) => { if (runner === 'glm') await saveRunnerCred(ws, 'glm', 'apikey', 'glm-z'); return runner === 'claude' ? { ok: false, reason: 'auth' } : { ok: true }; },
    probeFn: noProbe, nowMs: T0, jitterMs: 0,
  });
  const s = await stateOf(ws);
  assert.equal(s.claude.ok, false, '검진한 러너의 결과는 남는다');
  assert.deepEqual(await healthEvents(ws, 'claude'), [false], '실패 진입 이벤트 1회');
});

test('K36: 실패 뒤 재연결 → 다음 성공 검진이 회복 이벤트를 남겨 카드가 옛 실패를 계속 그리지 않는다(1회만)', async () => {
  const ws = 'hcc-recover';
  await seed(ws, { glm: ['apikey', 'glm-dead'] });
  let result = { ok: false, reason: 'auth' };
  const verifyFn = async () => result;
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0, jitterMs: 0 });
  assert.deepEqual(await healthEvents(ws, 'glm'), [false]);
  await saveRunnerCred(ws, 'glm', 'apikey', 'glm-alive'); // 재연결
  assert.notEqual((await stateOf(ws)).glm?.ok, false, '재연결 뒤 턴 전 게이트가 새 자격을 막지 않는다');
  result = { ok: true };
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0 + 1, jitterMs: 0 });
  assert.equal(lastHealthFailByRunner(await readEvents(ws, 50)).glm.ok, true, '카드가 회복을 읽는다');
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0 + 1 + HEALTH_INTERVAL_MS, jitterMs: 0 });
  assert.deepEqual(await healthEvents(ws, 'glm'), [true, false], '지속 성공은 이벤트를 더 쌓지 않는다(전이 원칙)');
});

test('K36 인접: 재연결한 새 자격도 실패면 실패 이벤트를 새로 남긴다', async () => {
  const ws = 'hcc-refail';
  await seed(ws, { glm: ['apikey', 'glm-a'] });
  const verifyFn = async () => ({ ok: false, reason: 'credit' });
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0, jitterMs: 0 });
  await saveRunnerCred(ws, 'glm', 'apikey', 'glm-b');
  await runHealthChecks(ws, { verifyFn: async () => ({ ok: false, reason: 'auth' }), probeFn: noProbe, nowMs: T0 + 1, jitterMs: 0 });
  assert.deepEqual(await healthEvents(ws, 'glm'), [false, false]);
  assert.equal(lastHealthFailByRunner(await readEvents(ws, 50)).glm.reason, 'auth', '카드는 새 자격의 사유를 그린다');
});

test('K36 인접: 실패 이력 없는 재연결 뒤 성공은 이벤트를 남기지 않는다', async () => {
  const ws = 'hcc-clean';
  await seed(ws, { glm: ['apikey', 'glm-1'] });
  const verifyFn = async () => ({ ok: true });
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0, jitterMs: 0 });
  await saveRunnerCred(ws, 'glm', 'apikey', 'glm-2');
  await runHealthChecks(ws, { verifyFn, probeFn: noProbe, nowMs: T0 + 1, jitterMs: 0 });
  assert.deepEqual(await healthEvents(ws, 'glm'), []);
});
