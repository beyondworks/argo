// 러너 주기 건강 검진 회귀 테스트 (2026-09-01, P1-2 후속)
// 절대 제약 3종을 행동으로 잠근다: ①과금 러너 스로틀·백오프 ②판정 불가 무해 스킵 ③자격 미삭제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-hchome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hc-'));
const {
  healthDue, applyHealthResult, runHealthChecks,
  HEALTH_INTERVAL_MS, HEALTH_INTERVAL_BILLED_MS, HEALTH_BACKOFF_CAP_MS, HEALTH_BILLED_RUNNERS,
} = await import('../src/runner-health.mjs');
const { saveRunnerCred, loadRunnerCred } = await import('../src/runners.mjs');
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
  assert.deepEqual(st.glm, { at: T0, ok: false, fails: 1, reason: 'auth' });
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
  await runHealthChecks(ws, { verifyFn, nowMs: T0 });
  assert.deepEqual(calls, ['grok'], '첫 검진');
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_MS });      // 기본 간격 경과
  assert.deepEqual(calls, ['grok'], '과금 러너는 기본 간격으론 안 돈다');
  await runHealthChecks(ws, { verifyFn, nowMs: T0 + HEALTH_INTERVAL_BILLED_MS });
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

// ── 배선 ────────────────────────────────────────────────────────────────
test('배선: 스케줄러 틱이 cloudLeader 게이트 안에서 in-flight 가드와 함께 호출한다', async () => {
  const src = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(cloudLeader && !healthChecking\.has\(cid\)\) \{[\s\S]{0,220}?runHealthChecks\(cid\)/,
    'cloudLeader 안 + 중복 방지 가드 — 기기마다 돌면 과금 검증이 기기 수만큼 곱해진다');
  assert.match(src, /\.finally\(\(\) => healthChecking\.delete\(cid\)\)/, '가드 해제');
  assert.doesNotMatch(src, /await runHealthChecks/, '틱에서 대기 금지(우편·루틴과 같은 fire-and-forget 계약)');
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
  assert.match(connect, /: 'settings\.runners\.healthFailed'\)\}/, '문구는 사전 경유(사유별 삼항의 기본 갈래)');
});
