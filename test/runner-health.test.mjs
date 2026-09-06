// 러너 주기 건강 검진 회귀 테스트 (2026-09-01, P1-2 후속)
// 절대 제약 3종을 행동으로 잠근다: ①과금 러너 스로틀·백오프 ②판정 불가 무해 스킵 ③자격 미삭제.
import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey(); // 전체 봉투 기본 켜짐 — 계정 키 없으면 EXCLUDE가 전체를 보류한다

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-hchome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hc-'));
const {
  healthDue, applyHealthResult, runHealthChecks,
  HEALTH_INTERVAL_MS, HEALTH_INTERVAL_BILLED_MS, HEALTH_BACKOFF_CAP_MS, HEALTH_BILLED_RUNNERS,
  HEALTH_PROBE_INTERVAL_MS, HEALTH_PROBE_RETRY_MS, HEALTH_PROBE_PER_RUN, PROBE_MIN_OUTPUT_TOKENS, turnProbeHash, turnProbeDue, turnProbeApplies, classifyProbeError, runTurnProbe, probeToolSpecs, resolveProbe,
} = await import('../src/runner-health.mjs');
const { startStrictVendor } = await import('./helpers/strict-vendor.mjs');
const { saveRunnerCred, loadRunnerCred, verifyRunnerCred } = await import('../src/runners.mjs');
const { credHash } = await import('../src/runners/shared.mjs'); // 실패 엔트리의 자격 지문(턴 전 게이트 열쇠 — 불변식 A)
const { readEvents } = await import('../src/events.mjs');

const T0 = 1_760_000_000_000;

// ── ① 스로틀·백오프 ──────────────────────────────────────────────────────
test('healthDue: 기본 30분 · 과금 러너(grok)는 6시간 — 호출당 청구되는 verify를 아끼는 것이 이 상수의 이유', () => {
  assert.ok(HEALTH_BILLED_RUNNERS.has('grok'), 'grok verify는 실 벤더 POST(#378 검수)');
  assert.equal(healthDue(undefined, 'claude', T0), true, '첫 검진은 즉시');
  assert.equal(healthDue({ at: T0, ok: true, fails: 0 }, 'claude', T0 + HEALTH_INTERVAL_MS - 1), false);
  assert.equal(healthDue({ at: T0, ok: true, fails: 0 }, 'claude', T0 + HEALTH_INTERVAL_MS), true);
  // 과금 러너는 같은 시각에도 아직 아니다 — 기본 간격을 쓰면 12배 더 자주 청구된다
  assert.equal(healthDue({ at: T0, ok: true, fails: 0 }, 'grok', T0 + HEALTH_INTERVAL_MS), false);
  assert.equal(healthDue({ at: T0, ok: true, fails: 0 }, 'grok', T0 + HEALTH_INTERVAL_BILLED_MS), true);
});
test('healthDue: 연속 실패는 지수 백오프, 24시간 상한 — 죽은 자격을 30분마다 두드리지 않는다', () => {
  assert.equal(healthDue({ at: T0, ok: false, fails: 1 }, 'claude', T0 + HEALTH_INTERVAL_MS), false, '1회 실패 = 2배');
  assert.equal(healthDue({ at: T0, ok: false, fails: 1 }, 'claude', T0 + HEALTH_INTERVAL_MS * 2), true);
  // 연속 실패 clamp(4) → 기본 러너의 최대 대기는 30m×16 = 8시간(24h 상한에 닿지 않는다)
  assert.equal(healthDue({ at: T0, ok: false, fails: 99 }, 'claude', T0 + HEALTH_INTERVAL_MS * 16 - 1), false, '기본 러너 최대 대기 전');
  assert.equal(healthDue({ at: T0, ok: false, fails: 99 }, 'claude', T0 + HEALTH_INTERVAL_MS * 16), true, '기본 러너 최대 대기 = 8h');
  // 과금 러너는 6h×16 = 96h가 되어 **24시간 상한이 실제로 문다** — 상한이 없으면 죽은 grok 자격을
  // 나흘 뒤에야 다시 본다(사용자가 재연결했는지 모른 채 경고가 굳는다).
  assert.equal(healthDue({ at: T0, ok: false, fails: 99 }, 'grok', T0 + HEALTH_BACKOFF_CAP_MS - 1), false);
  assert.equal(healthDue({ at: T0, ok: false, fails: 99 }, 'grok', T0 + HEALTH_BACKOFF_CAP_MS), true, '24h 상한 적용');
  assert.equal(healthDue({ at: T0, ok: false, fails: -3 }, 'claude', T0 + HEALTH_INTERVAL_MS), true, '이상값은 0으로');
});

// ── ② 판정 불가 무해 스킵 ────────────────────────────────────────────────
test('applyHealthResult: ok:null은 시각만 갱신 — 연속 실패·직전 판정을 건드리지 않는다', () => {
  const prev = { at: T0 - 1, ok: false, fails: 2, reason: 'auth' };
  assert.deepEqual(applyHealthResult(prev, { ok: null }, T0), { at: T0, ok: false, fails: 2, reason: 'auth' },
    '오프라인 하루가 판정을 뒤집거나 백오프를 밀면 안 된다');
  assert.deepEqual(applyHealthResult(prev, { ok: true }, T0), { at: T0, ok: true, fails: 0 }, '성공은 카운터 리셋');
  assert.deepEqual(applyHealthResult({ fails: 1 }, { ok: false, reason: 'gemini-license' }, T0),
    { at: T0, ok: false, fails: 2, reason: 'gemini-license' }, '실패는 누적 + 사유 보존');
});

// ── 실행 경로(주입) — ①②③ 종합 ─────────────────────────────────────────
async function seed(ws, creds) {
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  for (const [runner, [type, value]] of Object.entries(creds)) await saveRunnerCred(ws, runner, type, value);
}
const stateOf = async (ws) => JSON.parse(await readFile(join(process.env.ARGO_ROOT, ws, '.runner-health.json'), 'utf8'));

test('runHealthChecks: 실패는 이벤트 + 상태, 판정 불가는 조용히, 성공은 이벤트 없음 — 그리고 자격은 그대로', async () => {
  const ws = 'hc-mix';
  await seed(ws, { claude: ['apikey', 'sk-ant-alive'], glm: ['apikey', 'glm-dead'], kimi: ['apikey', 'kimi-offline'] });
  const verifyFn = async (runner) => ({ claude: { ok: true }, glm: { ok: false, reason: 'auth' }, kimi: { ok: null } }[runner] ?? { ok: null });
  const checked = await runHealthChecks(ws, { verifyFn, nowMs: T0 });
  assert.deepEqual(checked.map((c) => `${c.runner}:${c.ok}`).sort(), ['claude:true', 'glm:false', 'kimi:null']);
  const ev = (await readEvents(ws, 50)).filter((e) => e.type === 'runner-health');
  assert.deepEqual(ev.map((e) => e.runner), ['glm'], '확정 실패만 이벤트(성공·판정 불가는 활동 화면을 안 채운다)');
  assert.equal(ev[0].reason, 'auth');
  const st = await stateOf(ws);
  assert.deepEqual(st.claude, { at: T0, ok: true, fails: 0 });
  assert.deepEqual(st.glm, { at: T0, ok: false, fails: 1, reason: 'auth', credHash: credHash((await loadRunnerCred(ws, 'glm')).value) }, '실패 엔트리는 어느 자격의 실패인지 지문을 각인한다(불변식 A)');
  assert.deepEqual(st.kimi, { at: T0 }, '판정 불가 — 시각만');
  // ③ 자격 미삭제(절대 제약) — 실패한 glm도 그대로 있어야 한다
  assert.ok(await loadRunnerCred(ws, 'glm'), '검진 실패가 자격을 지우면 일시 장애가 연결 해제로 둔갑한다');
  assert.ok(await loadRunnerCred(ws, 'claude'));
});
test('runHealthChecks: 스로틀 — 간격 전 재호출은 벤더를 부르지 않는다(과금 보호)', async () => {
  const ws = 'hc-throttle';
  await seed(ws, { grok: ['apikey', 'xai-k'] });
  const calls = [];
  const verifyFn = async (runner) => { calls.push(runner); return { ok: true }; };
  await runHealthChecks(ws, { verifyFn, nowMs: T0, jitterMs: 0 });
  assert.deepEqual(calls, ['grok'], '첫 검진');
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS, jitterMs: 0 });      // 기본 간격 경과
  assert.deepEqual(calls, ['grok'], '과금 러너는 기본 간격으론 안 돈다');
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_BILLED_MS, jitterMs: 0 });
  assert.deepEqual(calls, ['grok', 'grok'], '6시간 경과 후에만');
});
test('runHealthChecks: 미연결·host 마커는 벤더 미호출 (host는 이 컴퓨터 CLI — 원격 판정 대상 아님)', async () => {
  const ws = 'hc-skip';
  await seed(ws, { codex: ['host', 'host'] });
  const calls = [];
  const checked = await runHealthChecks(ws, { verifyFn: async (r) => { calls.push(r); return { ok: false }; }, nowMs: T0 });
  assert.deepEqual(calls, [], '미연결 러너·host 마커 모두 호출 0');
  assert.deepEqual(checked, []);
  assert.deepEqual((await stateOf(ws)).codex, { at: T0 }, 'host는 시각만(다음 틱 폭주 방지)');
});
test('runHealthChecks: verify가 던져도 판정 불가로 흡수 — 검진이 틱을 깨지 않는다', async () => {
  const ws = 'hc-throw';
  await seed(ws, { claude: ['apikey', 'sk-ant-x'] });
  const checked = await runHealthChecks(ws, { verifyFn: async () => { throw new Error('boom'); }, nowMs: T0 });
  assert.deepEqual(checked, [{ runner: 'claude', ok: null, reason: null }]);
  assert.equal((await readEvents(ws, 50)).filter((e) => e.type === 'runner-health').length, 0);
});

test('이벤트는 상태 전이에서만 — 지속 실패 재적재 없음 + 회복 이벤트로 경고가 풀린다(검수 HIGH-1)', async () => {
  const ws = 'hc-edge';
  await seed(ws, { claude: ['apikey', 'sk-ant-x'] });
  const evOf = async () => (await readEvents(ws, 50)).filter((e) => e.type === 'runner-health').map((e) => e.ok);
  let result = { ok: false, reason: 'auth' };
  const verifyFn = async () => result;
  await runHealthChecks(ws, { verifyFn, nowMs: T0, jitterMs: 0 });
  assert.deepEqual(await evOf(), [false], '실패 진입 1회');
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS * 4, jitterMs: 0 }); // 백오프 넘겨 재검진
  assert.deepEqual(await evOf(), [false], '지속 실패는 재적재하지 않는다(타임라인 오염 방지)');
  result = { ok: true };
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS * 20, jitterMs: 0 });
  assert.deepEqual(await evOf(), [true, false], '회복 이벤트 추가(readEvents는 최신순) — 없으면 카드 경고가 영구히 굳는다');
  const { lastHealthFailByRunner } = await import('../app/runner-usable.mjs');
  assert.equal(lastHealthFailByRunner(await readEvents(ws, 50)).claude.ok, true, '카드가 회복을 읽는다');
});
test('grok BYOA 만료 토큰엔 유료 프로브를 쓰지 않는다(검수 MEDIUM-1 — 로컬로 아는 만료)', async () => {
  const ws = 'hc-grok-exp';
  await seed(ws, { grok: ['oauth', JSON.stringify({ access_token: 'stale', refresh_token: 'r', expires_at: T0 - 1000 })] });
  const calls = [];
  const checked = await runHealthChecks(ws, { verifyFn: async (r) => { calls.push(r); return { ok: false }; }, nowMs: T0 });
  assert.deepEqual(calls, [], '만료가 로컬로 확정이면 벤더를 부르지 않는다(청구·오탐 방지)');
  assert.deepEqual(checked, []);
  // 유효 토큰이면 정상 검진
  await seed(ws, { grok: ['oauth', JSON.stringify({ access_token: 'fresh', refresh_token: 'r', expires_at: T0 + HEALTH_INTERVAL_BILLED_MS * 3 })] }); // 검진 시각(12h 뒤)에도 유효해야 대상이 된다
  await runHealthChecks(ws, { verifyFn: async (r) => { calls.push(r); return { ok: true }; }, nowMs: T0 + HEALTH_INTERVAL_BILLED_MS * 2, jitterMs: 0 });
  assert.deepEqual(calls, ['grok'], '유효 토큰은 검진 대상');
});
test('상태 쓰기 실패는 드러나고 프로세스 폴백으로 스로틀이 유지된다(검수 MEDIUM-2)', async () => {
  const ws = 'hc-wfail';
  await seed(ws, { claude: ['apikey', 'sk-ant-x'] });
  const { chmod } = await import('node:fs/promises');
  const dir = join(process.env.ARGO_ROOT, ws);
  const calls = [];
  const verifyFn = async (r) => { calls.push(r); return { ok: true }; };
  await runHealthChecks(ws, { verifyFn, nowMs: T0 });
  assert.equal(calls.length, 1);
  await chmod(dir, 0o500); // 쓰기 불가
  try {
    await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS * 2, jitterMs: 0 });
    const n = calls.length;
    await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS * 2 + 1, jitterMs: 0 }); // 간격 전 재호출
    assert.equal(calls.length, n, '쓰기 실패 후에도 스로틀 유지(매 틱 검증 = 1440회/일 폭주 차단)');
  } finally { await chmod(dir, 0o700); }
});
test('.runner-health.json은 기기 간 동기화 제외 — 그 기기의 자격에 대한 사실이다(검수 MEDIUM-3)', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  assert.equal(EXCLUDE('co/.runner-health.json'), true);
  assert.equal(EXCLUDE('.runner-health.json'), true);
  assert.equal(EXCLUDE('co/chats/pepper.json'), false, '대조군 — 스레드는 동기화 대상');
});
test('재연결(saveRunnerCred)은 검진 상태를 지운다 — 새 자격이 옛 백오프를 물려받지 않게(검수 LOW)', async () => {
  const ws = 'hc-reconnect';
  await seed(ws, { claude: ['apikey', 'sk-ant-old'] });
  await runHealthChecks(ws, { verifyFn: async () => ({ ok: false, reason: 'auth' }), nowMs: T0 });
  assert.equal((await stateOf(ws)).claude.fails, 1);
  const { saveRunnerCred } = await import('../src/runners.mjs');
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-new');
  assert.ok(!('claude' in await stateOf(ws)), '재연결 = 상태 초기화(즉시 재검진 가능)');
});

test('지터: 결정적(같은 조합=같은 값) · 기본 간격의 10% 이내 — 회사 수만큼 동시 발사 분산(검수 LOW)', () => {
  // 첫 검진은 지터와 무관하게 즉시(entry 없음) — 지터는 다음 경계부터 작동한다.
  const at = { at: T0, ok: true, fails: 0 };
  const withJ = (j) => healthDue(at, 'claude', T0 + HEALTH_INTERVAL_MS, { jitterMs: j });
  assert.equal(withJ(0), true, '지터 0이면 정확히 간격에서');
  assert.equal(withJ(60_000), false, '지터만큼 뒤로 밀린다');
  assert.equal(healthDue(at, 'claude', T0 + HEALTH_INTERVAL_MS + 60_000, { jitterMs: 60_000 }), true);
});

// ── 배선 ────────────────────────────────────────────────────────────────
test('tickHealthCheck(행동): in-flight 가드가 실행 완료까지 유지된다 — 죽은 코드·즉시 해제 변이를 문다', async () => {
  const { tickHealthCheck } = await import('../src/scheduler.mjs');
  const inflight = new Set();
  let started = 0; let release;
  const runFn = () => { started += 1; return new Promise((r) => { release = r; }); };
  assert.equal(tickHealthCheck('ws1', { runFn, inflight }), true, '첫 발사');
  assert.equal(tickHealthCheck('ws1', { runFn, inflight }), false, '실행 중 재호출은 발사 안 함(중복 벤더 호출 방지)');
  assert.equal(started, 1);
  assert.equal(inflight.has('ws1'), true, '가드는 실행 완료까지 유지(즉시 해제 변이 red)');
  release(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(inflight.has('ws1'), false, '완료 후 해제');
  assert.equal(tickHealthCheck('ws1', { runFn, inflight }), true, '해제 뒤 재발사 가능');
  release();
  // 실패해도 가드가 남지 않는다(틱이 회사 하나 때문에 영구 굶지 않게)
  const inflight2 = new Set();
  tickHealthCheck('ws2', { runFn: async () => { throw new Error('boom'); }, inflight: inflight2 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(inflight2.has('ws2'), false, '예외 경로도 해제');
});
test('배선: 틱은 cloudLeader 게이트 안에서 tickHealthCheck를 부르고 기다리지 않는다', async () => {
  const src = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(cloudLeader\) tickHealthCheck\(cid\);/, 'cloudLeader 안(기기마다 돌면 과금이 기기 수만큼)');
  assert.doesNotMatch(src, /await tickHealthCheck|await runHealthChecks/, 'fire-and-forget 계약');
});
test('healthFailMessageKey(순수): 사유→문구 매핑 — 뒤바꾸기 변이를 문다(커버리지 0이던 자리)', async () => {
  const { healthFailMessageKey } = await import('../app/runner-usable.mjs');
  assert.equal(healthFailMessageKey('gemini-license'), 'settings.runners.geminiLicenseBlocked');
  assert.equal(healthFailMessageKey('credit'), 'settings.runners.checkCreditTier', '크레딧 소진은 "다시 연결" 오안내 금지');
  assert.equal(healthFailMessageKey('tier'), 'settings.runners.checkCreditTier');
  assert.equal(healthFailMessageKey('auth'), 'settings.runners.healthFailed');
  assert.equal(healthFailMessageKey(undefined), 'settings.runners.healthFailed');
  // 두 표면이 같은 함수를 쓴다 — 매핑 복제는 한쪽만 고쳐지는 드리프트가 된다
  for (const f of ['../app/runner-connect.jsx', '../app/c/[ws]/activity/page.jsx']) {
    assert.match(await readFile(new URL(f, import.meta.url), 'utf8'), /healthFailMessageKey\(/, `${f} 공용 매핑 사용`);
  }
});
test('배선: 카드가 검진 실패를 턴 실패와 별개 소스로 읽고 우선 표시한다', async () => {
  const { lastHealthFailByRunner } = await import('../app/runner-usable.mjs');
  const by = lastHealthFailByRunner([
    { type: 'runner-health', runner: 'gemini', ok: false, reason: 'gemini-license' },
    { type: 'runner-health', runner: 'gemini', ok: false, reason: 'auth' }, // 과거 — 첫 매치 우선
    { type: 'turn', runner: 'claude', ok: false },                          // 턴 실패는 이 소스가 아니다
  ]);
  assert.deepEqual(by.gemini, { ok: false, reason: 'gemini-license' });
  assert.ok(!('claude' in by), 'turn 이벤트 미수집(lastTurnByRunner와 분리)');
  const connect = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');
  assert.match(connect, /setHealthFails\(lastHealthFailByRunner\(d\.events\)\)/, '카드 수집');
  assert.match(connect, /healthFail\?\.ok === false\s*\n?\s*\?/, '검진 실패 우선 분기');
  assert.match(connect, /\{t\(healthFailMessageKey\(healthFail\.reason\)\)\}/, '문구는 공용 매핑+사전 경유');
});


// ── ④ 턴 모양 프로브(2026-09-06 Grok 400 제보 뒤) ─────────────────────────────────────────────────────
test('프로브 순수 함수 — 지문(버전·도구 정의), 차례(지문 변경·24h·실패 뒤 1h), 대상(네이티브 자격만), 오류 계급(4xx=probe·402=credit·429/5xx/네트워크/합성=판정 불가·키 마스킹), 프로브 선택', () => {
  const h1 = turnProbeHash(probeToolSpecs(), '0.1.63'); const h2 = turnProbeHash(probeToolSpecs(), '0.1.64'); const h3 = turnProbeHash([{ name: 'x', input_schema: { type: 'object', required: [] } }], '0.1.63');
  assert.ok(h1 !== h2 && h1 !== h3 && /^[0-9a-f]{16}$/.test(h1), '버전·도구 정의가 바뀌면 지문이 바뀐다(업데이트 직후 즉시 재프로브)');
  assert.equal(turnProbeDue(undefined, h1, T0), true); assert.equal(turnProbeDue({ probeAt: T0, probeHash: h1, probeOk: true }, h1, T0 + HEALTH_PROBE_INTERVAL_MS - 1), false); assert.equal(turnProbeDue({ probeAt: T0, probeHash: h1, probeOk: true }, h1, T0 + HEALTH_PROBE_INTERVAL_MS), true);
  assert.equal(turnProbeDue({ probeAt: T0, probeHash: h1, probeOk: true }, h2, T0 + 1), true, '지문이 다르면 즉시');
  assert.equal(turnProbeDue({ probeAt: T0, probeHash: h1, probeOk: false }, h1, T0 + HEALTH_PROBE_RETRY_MS - 1), false); assert.equal(turnProbeDue({ probeAt: T0, probeHash: h1, probeOk: false }, h1, T0 + HEALTH_PROBE_RETRY_MS), true, '실패한 프로브는 1시간 뒤 재시도(거짓 경보·일시 거절이 하루 종일 굳지 않게)');
  assert.equal(turnProbeApplies('grok', 'apikey'), true); assert.equal(turnProbeApplies('openrouter', 'apikey'), true); assert.equal(turnProbeApplies('gemini', 'apikey'), true);
  assert.equal(turnProbeApplies('gemini', 'oauth'), false, 'CLI 턴은 대상 아님'); assert.equal(turnProbeApplies('claude', 'apikey'), false, 'SDK 경로는 대상 아님'); assert.equal(turnProbeApplies('codex', 'apikey'), false, '옵트인 전엔 CLI');
  const err = (status, msg = 'x', extra = {}) => Object.assign(new Error(msg), { status, ...extra });
  assert.deepEqual(classifyProbeError(err(400, 'API Error: 400 Invalid request content: Schema validation failed')).reason, 'probe');
  assert.deepEqual(classifyProbeError(err(401)).reason, 'probe', "401도 'auth'로 각인하지 않는다 — 턴 전 게이트를 켜지 않게(HIGH-2)"); assert.deepEqual(classifyProbeError(err(403)).reason, 'probe'); assert.deepEqual(classifyProbeError(err(404, 'model not found')).reason, 'probe');
  assert.deepEqual(classifyProbeError(err(402)).reason, 'credit'); assert.equal(classifyProbeError(err(429)).ok, null, '429는 일시 — 판정 불가');
  assert.equal(classifyProbeError(err(503)).ok, null, '5xx는 판정 불가'); assert.equal(classifyProbeError(new Error('fetch failed')).ok, null, '네트워크는 판정 불가');
  assert.equal(classifyProbeError(err(400, 'API Error: 400 Gemini returned no usable content (finishReason=MAX_TOKENS)', { synthetic: true })).ok, null, '와이어가 합성한 400은 벤더 거절이 아니다(HIGH-3)');
  assert.equal(classifyProbeError(err(400, 'Incorrect API key provided: sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 — check')).detail.includes('abcdefghijklmnop'), false, '원문의 키 조각은 마스킹(MEDIUM-2)');
  assert.deepEqual(probeToolSpecs().filter((t) => t.input_schema?.type === 'object' && !Array.isArray(t.input_schema.required)), [], '프로브 스펙도 같은 정규화 관문을 지난다');
  const fake = async () => ({ ok: true });
  assert.equal(resolveProbe(fake, async () => ({ ok: true })), fake); assert.equal(resolveProbe(undefined, async () => ({ ok: true })), null, 'verify 주입 + 프로브 미주입 = 프로브 없음(실벤더 실호출 방지)'); assert.equal(resolveProbe(undefined, verifyRunnerCred), runTurnProbe, '실행 경로(기본 verify)는 실제 프로브');
});

test('runHealthChecks: 프로브 판정은 verify와 독립 — 실패는 probeOk로 남고(ok·credHash 불변 → 턴 전 게이트 미발동), verify만 도는 다음 검진이 덮지 않으며 거짓 회복 없음, 1h 뒤 재프로브, 통과해야 회복, CLI 자격 제외, 검진 1회당 1개', async () => {
  const ws = 'hc-probe';
  await seed(ws, { openrouter: ['apikey', 'or-key-1'], gemini: ['oauth', JSON.stringify({ access_token: 'x' })] });
  const verifyFn = async () => ({ ok: true });
  const probes = [];
  const failProbe = async (_ws, runner) => { probes.push(runner); return { ok: false, reason: 'probe', detail: 'API Error: 400 Schema validation failed: /required: null is not of type "array"' }; };
  const hash = 'h-aaaa';
  let checked = await runHealthChecks(ws, { verifyFn, probeFn: failProbe, probeHash: hash, nowMs: T0, jitterMs: 0 });
  assert.deepEqual(probes, ['openrouter'], 'gemini oauth(CLI 턴)는 대상 아님');
  assert.deepEqual(checked.find((c) => c.runner === 'openrouter'), { runner: 'openrouter', ok: false, reason: 'probe' });
  const file = join(process.env.ARGO_ROOT, ws, '.runner-health.json');
  let st = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(st.openrouter.ok, true, 'verify 판정은 그대로(자격 유효)'); assert.equal(st.openrouter.probeOk, false); assert.equal(st.openrouter.probeReason, 'probe'); assert.match(st.openrouter.probeDetail, /required: null/); assert.equal(st.openrouter.probeHash, hash);
  assert.equal(st.openrouter.credHash, undefined, '프로브 실패는 자격 지문을 각인하지 않는다');
  const { runnerCredEnv } = await import('../src/runners.mjs');
  assert.ok((await runnerCredEnv(ws, 'openrouter'))?.env, '턴 전 게이트가 프로브 실패로 켜지지 않는다(HIGH-2)');
  let ev = await readEvents(ws); let hev = ev.filter((e) => e.type === 'runner-health' && e.runner === 'openrouter');
  assert.equal(hev.length, 1); assert.equal(hev[0].ok, false); assert.equal(hev[0].reason, 'probe'); assert.match(hev[0].detail, /required: null/);
  // 다음 검진(verify만, 프로브 차례 아님): 실패 상태 유지·거짓 회복 이벤트 없음(HIGH-1)
  probes.length = 0;
  checked = await runHealthChecks(ws, { verifyFn, probeFn: failProbe, probeHash: hash, nowMs: T0 + HEALTH_INTERVAL_MS, jitterMs: 0 });
  assert.deepEqual(probes, [], 'openrouter는 1h 재시도 전이라 안 돈다');
  st = JSON.parse(await readFile(file, 'utf8')); assert.equal(st.openrouter.probeOk, false, 'verify 성공이 프로브 실패를 덮지 않는다');
  ev = await readEvents(ws); hev = ev.filter((e) => e.type === 'runner-health' && e.runner === 'openrouter'); assert.equal(hev.length, 1, '거짓 회복 이벤트 없음');
  assert.deepEqual(checked.find((c) => c.runner === 'openrouter'), { runner: 'openrouter', ok: false, reason: 'probe' }, '카드 원천은 여전히 실패');
  // 1h 뒤 재프로브(같은 지문) — 실패 유지면 이벤트 추가 없음
  probes.length = 0;
  await runHealthChecks(ws, { verifyFn, probeFn: failProbe, probeHash: hash, nowMs: T0 + 2 * HEALTH_INTERVAL_MS, jitterMs: 0 });
  assert.ok(probes.includes('openrouter'), '실패 프로브는 1h 뒤 재시도'); assert.equal((await readEvents(ws)).filter((e) => e.type === 'runner-health' && e.runner === 'openrouter').length, 1);
  // 통과하는 프로브 → 회복 이벤트 + probeOk true
  const okProbe = async (_ws, runner) => { probes.push(runner); return { ok: true }; };
  probes.length = 0;
  await runHealthChecks(ws, { verifyFn, probeFn: okProbe, probeHash: 'h-bbbb', nowMs: T0 + 3 * HEALTH_INTERVAL_MS, jitterMs: 0 });
  st = JSON.parse(await readFile(file, 'utf8')); assert.equal(st.openrouter.probeOk, true); assert.equal(st.openrouter.probeReason, undefined); assert.equal(st.openrouter.probeHash, 'h-bbbb');
  hev = (await readEvents(ws)).filter((e) => e.type === 'runner-health' && e.runner === 'openrouter'); assert.equal(hev.length, 2); assert.equal(hev[0].ok, true, '회복 이벤트(최신)');
  // 판정 불가 프로브는 기록하지 않는다
  await runHealthChecks(ws, { verifyFn, probeFn: async () => ({ ok: null }), probeHash: 'h-cccc', nowMs: T0 + 5 * HEALTH_INTERVAL_MS, jitterMs: 0 });
  st = JSON.parse(await readFile(file, 'utf8')); assert.equal(st.openrouter.probeHash, 'h-bbbb', '판정 불가는 지문을 갱신하지 않는다'); assert.equal(st.openrouter.probeOk, true);
  // 검진 1회당 프로브 상한(MEDIUM-4): glm·openrouter 둘 다 네이티브면 첫 검진엔 하나만, 나머지는 다음 검진에
  const ws2 = 'hc-probe-cap'; await seed(ws2, { glm: ['apikey', 'glm-key-1'], openrouter: ['apikey', 'or-key-2'] });
  probes.length = 0;
  await runHealthChecks(ws2, { verifyFn, probeFn: okProbe, probeHash: 'h-cap', nowMs: T0, jitterMs: 0 });
  assert.equal(probes.length, HEALTH_PROBE_PER_RUN, `검진 1회당 ${HEALTH_PROBE_PER_RUN}개`);
  await runHealthChecks(ws2, { verifyFn, probeFn: okProbe, probeHash: 'h-cap', nowMs: T0 + HEALTH_INTERVAL_MS, jitterMs: 0 });
  assert.deepEqual(probes.sort(), ['glm', 'openrouter'], '두 번째 검진에서 나머지');
  // verify 실패는 종전대로 ok:false + credHash(턴 전 게이트) — 프로브와 무관
  await runHealthChecks(ws, { verifyFn: async () => ({ ok: false, reason: 'auth' }), probeFn: okProbe, probeHash: 'h-bbbb', nowMs: T0 + 30 * HEALTH_INTERVAL_MS, jitterMs: 0 });
  st = JSON.parse(await readFile(file, 'utf8')); assert.equal(st.openrouter.ok, false); assert.ok(st.openrouter.credHash); assert.equal(st.openrouter.probeOk, true, '프로브 기록은 verify 실패에도 보존');
});

test('runTurnProbe(실제 프로브) — 엄격 xAI 가짜 벤더는 정규화된 도구 전량을 받아 200, 거절 벤더는 probe+원문, 닫힌 포트는 판정 불가; gemini 프로브는 출력 하한을 낮춘다; verify 주입 시 기본 프로브 실호출 0(스파이 서버로 결정적)', async () => {
  const ws = 'hc-probe-real';
  const strict = await startStrictVendor({ vendor: 'xai' });
  try {
    await seed(ws, { grok: ['apikey', 'xai-key-probe'] });
    process.env.GROK_BASE_URL = strict.base;
    const r = await runTurnProbe(ws, 'grok');
    assert.deepEqual(r, { ok: true }); assert.equal(strict.calls.length, 1); assert.equal(strict.calls[0].url, '/v1/messages');
    assert.ok(strict.calls[0].body.tools.length >= 24 && strict.calls[0].body.max_tokens === 8, '실제 대화와 같은 도구 목록·1턴');
  } finally { await strict.close(); delete process.env.GROK_BASE_URL; }
  const deny = await new Promise((resolve) => { const s = createServer((q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array"' } })); }); s.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) })); });
  try { process.env.GROK_BASE_URL = deny.base; const r2 = await runTurnProbe(ws, 'grok'); assert.equal(r2.ok, false); assert.equal(r2.reason, 'probe'); assert.match(r2.detail, /required: null/); } finally { await deny.close(); }
  process.env.GROK_BASE_URL = 'http://127.0.0.1:1'; const r3 = await runTurnProbe(ws, 'grok'); assert.equal(r3.ok, null, '네트워크 불통은 판정 불가'); delete process.env.GROK_BASE_URL;
  // gemini: 프로브 출력 하한(MEDIUM-1) — 가짜 Gemini 서버가 받은 generationConfig
  const gem = await new Promise((resolve) => { const bodies = []; const s = createServer((q, res) => { let d = ''; q.on('data', (c) => { d += c; }); q.on('end', () => { bodies.push(JSON.parse(d)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })); }); }); s.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, bodies, close: () => new Promise((r) => s.close(r)) })); });
  try {
    await seed(ws, { gemini: ['apikey', 'fake-gemini-key-probe'] }); process.env.GEMINI_BASE_URL = gem.base;
    assert.deepEqual(await runTurnProbe(ws, 'gemini'), { ok: true }); assert.equal(gem.bodies[0].generationConfig.maxOutputTokens, PROBE_MIN_OUTPUT_TOKENS, '엔진 기본 하한 16384 대신 프로브 하한');
  } finally { await gem.close(); delete process.env.GEMINI_BASE_URL; }
  // MEDIUM-3: 기본 프로브 안전장치 — 스파이 서버로 결정적 단언(가드 제거 변이 red)
  const spy = await startStrictVendor({ vendor: 'xai' });
  try {
    await seed('hc-probe-spy', { grok: ['apikey', 'xai-key-spy'] }); process.env.GROK_BASE_URL = spy.base;
    await runHealthChecks('hc-probe-spy', { verifyFn: async () => ({ ok: true }), nowMs: T0, jitterMs: 0 });
    assert.equal(spy.calls.length, 0, 'verify 주입 + 프로브 미주입 = 실벤더 호출 0');
    await runHealthChecks('hc-probe-spy', { verifyFn: async () => ({ ok: true }), probeFn: runTurnProbe, nowMs: T0 + HEALTH_INTERVAL_BILLED_MS, jitterMs: 0 });
    assert.equal(spy.calls.length, 1, '프로브를 명시 주입하면 1회');
  } finally { await spy.close(); delete process.env.GROK_BASE_URL; }
});
