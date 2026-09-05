// 러너 주기 건강 검진 회귀 테스트 (2026-09-01, P1-2 후속)
// 절대 제약 3종을 행동으로 잠근다: ①과금 러너 스로틀·백오프 ②판정 불가 무해 스킵 ③자격 미삭제.
import { test } from 'node:test';
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
} = await import('../src/runner-health.mjs');
const { saveRunnerCred, loadRunnerCred } = await import('../src/runners.mjs');
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
