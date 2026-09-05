// 러너 견고화 불변식 5종(2026-09-05, 유건 지시 "연결 후 러너·모델 스위치에 절대 오류 없이") — Hermes·OpenClaw
// 코드베이스 대조에서 Argo에 없던 불변식을 코드로 잠근다. 각 테스트 제목이 불변식이다.
//  A. 턴 전 자격 판정 — 인증 실패로 확정된 자격은 실행하지 않는다(OpenClaw "did not start the run")
//  B. 자격 파일 크로스 프로세스 잠금 — 두 프로세스의 read-modify-write가 직렬화된다(Hermes flock)
//  C. 실패 구조화·출처 판정 — 코드 표 + 맨 프로브로 vendor/argo 확정(유건 기준)
//  D. 모델 스위치 안전 — 원격 카탈로그 오버레이·alias·저장 검증·강등 고지
//  E. 구독 차단 ≠ 인증 실패 — 자가치유 미발동 + 키 전환 안내, i18n 코드 표 1:1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, utimes, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-inv-home-')); // 러너 env 조립 테스트는 HOME 임시화(스위프 규칙)
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-inv-'));
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-inv-cache-'));
process.env.ARGO_MODEL_CATALOG = 'off'; // 실행 경로의 원격 fetch 차단 — 카탈로그 테스트는 fetchImpl 주입으로 켠다

const { paths } = await import('../src/workspace.mjs');
const { withDirLock } = await import('../src/mutex.mjs');
const { credHash, HEALTH_FILE_NAME } = await import('../src/runners/shared.mjs');
const { runnerCredEnv, saveRunnerCred, loadRunnerCred } = await import('../src/runners/creds.mjs');
const { markRunnerAuthFail, applyHealthResult } = await import('../src/runner-health.mjs');
const { classifyRunnerError, FAIL_CODES, SUBSCRIPTION_BLOCKED_RE, subscriptionBlockedNotice } = await import('../src/runners/error-class.mjs');
const cat = await import('../src/runners/catalog-remote.mjs');
const { RUNNERS } = await import('../src/runners/catalog.mjs');
const { AUTH_ERR_RE, surfaceRunnerFailure } = await import('../src/chat.mjs');

const KEY = 'sk-ant-api03-invariantAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function company(ws) {
  await mkdir(paths(ws).root, { recursive: true });
  await mkdir(join(paths(ws).root, 'vault'), { recursive: true });
  return paths(ws).root;
}
const healthPath = (ws) => join(paths(ws).root, HEALTH_FILE_NAME);

/* ── A ─────────────────────────────────────────────────────────────── */
test('A. 턴 전 게이트 — 인증 실패로 확정된 같은 자격은 실행 전에 authExpired로 끊는다(전 러너)', async () => {
  const ws = 'inv-a'; await company(ws);
  await saveRunnerCred(ws, 'claude', 'apikey', KEY);
  assert.ok(await runnerCredEnv(ws, 'claude'), '검진 기록 없음 = 통과(기본 fail-open)');
  await markRunnerAuthFail(ws, 'claude', KEY);
  const saved = JSON.parse(await readFile(healthPath(ws), 'utf8'));
  assert.equal(saved.claude.reason, 'auth'); assert.equal(saved.claude.credHash, credHash(KEY));
  await assert.rejects(runnerCredEnv(ws, 'claude'), (e) => e.authExpired === 'claude' && e.knownInvalid === true, '같은 자격 재발사 금지');
  // 지문 불일치 → 통과 — 엔트리는 그대로 두고 지문만 다른 자격의 것으로 바꿔 **비교 자체**를 핀한다
  // (변이 배터리 A-1 실증: 재연결 경로는 clearHealthEntry가 엔트리를 지워 비교를 안 거치므로 그 경로로는 못 잡는다)
  const stale = JSON.parse(await readFile(healthPath(ws), 'utf8'));
  await writeFile(healthPath(ws), JSON.stringify({ ...stale, claude: { ...stale.claude, credHash: credHash('some-other-credential') } }));
  assert.ok(await runnerCredEnv(ws, 'claude'), '실패 기록은 다른 자격의 것 = 이 자격은 통과(지문 대조)');
  await writeFile(healthPath(ws), JSON.stringify(stale));
  await assert.rejects(runnerCredEnv(ws, 'claude'), (e) => e.authExpired === 'claude', '지문 일치로 되돌리면 다시 차단');
  // 재연결(saveRunnerCred)은 엔트리를 지우므로 새 키는 게이트를 안 탄다
  await saveRunnerCred(ws, 'claude', 'apikey', KEY + 'B');
  assert.ok(await runnerCredEnv(ws, 'claude'), '재연결된 새 자격은 통과');
  assert.equal(JSON.parse(await readFile(healthPath(ws), 'utf8').catch(() => '{}')).claude, undefined, '재연결 = 엔트리 삭제');
  // reason이 auth가 아니면(예: tier) 게이트 아님 — 인증 외 실패로 실행을 막지 않는다
  await writeFile(healthPath(ws), JSON.stringify({ claude: { at: Date.now(), ok: false, fails: 1, reason: 'tier', credHash: credHash(KEY + 'B') } }));
  assert.ok(await runnerCredEnv(ws, 'claude'), 'tier/credit 실패는 실행을 막지 않는다');
  // 손상 파일 → 통과(게이트가 멀쩡한 자격을 막는 것이 최악)
  await writeFile(healthPath(ws), '{not json');
  assert.ok(await runnerCredEnv(ws, 'claude'), '손상 = 통과');
});

test('A2. applyHealthResult — 실패에 credHash를 각인하고, 판정 불가는 직전 지문을 보존한다', () => {
  const f = applyHealthResult(undefined, { ok: false, reason: 'auth' }, 1000, 'h1');
  assert.deepEqual(f, { at: 1000, ok: false, fails: 1, reason: 'auth', credHash: 'h1' });
  assert.deepEqual(applyHealthResult(f, { ok: null }, 2000), { ...f, at: 2000 });
  assert.deepEqual(applyHealthResult(f, { ok: true }, 3000, 'h1'), { at: 3000, ok: true, fails: 0 });
});

/* ── B ─────────────────────────────────────────────────────────────── */
test('B. withDirLock — 두 프로세스의 임계 구간이 겹치지 않는다(mkdir 배타), stale 회수, 타임아웃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-lock-'));
  const log = join(dir, 'log.txt');
  const lock = join(dir, 'auth.json.lockd');
  // ESM import 지정자는 **file:// URL**이어야 한다 — Windows 절대 경로(D:\a\…)를 그대로 넣으면 'd:' 스킴으로
  // 해석돼 ERR_UNSUPPORTED_ESM_URL_SCHEME으로 자식이 죽는다(CI windows-latest 실측 2026-09-05: child exit 1).
  const mutexUrl = pathToFileURL(join(ROOT, 'src', 'mutex.mjs')).href;
  const child = `import { appendFile } from 'node:fs/promises'; import { withDirLock } from ${JSON.stringify(mutexUrl)};
    await withDirLock(${JSON.stringify(lock)}, async () => { await appendFile(${JSON.stringify(log)}, 'start\\n'); await new Promise((r) => setTimeout(r, 150)); await appendFile(${JSON.stringify(log)}, 'end\\n'); });`;
  // stderr는 상속 — 자식이 죽으면 CI 로그에 원인이 보이게(무음 'child exit 1'만 남던 것)
  const run = () => new Promise((res, rej) => { const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'ignore', 'inherit'] }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`child exit ${c}`)))); });
  await Promise.all([run(), run(), run()]);
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, ['start', 'end', 'start', 'end', 'start', 'end'], '겹치면 start,start가 연달아 나온다');
  // stale 회수 — 60초 전 잔재 락은 staleMs=1000이면 회수된다
  await mkdir(lock); const old = (Date.now() - 60_000) / 1000; await utimes(lock, old, old);
  assert.equal(await withDirLock(lock, async () => 'ok', { staleMs: 1000 }), 'ok');
  assert.equal(await stat(lock).catch(() => null), null, '해제 시 락 제거');
  // 살아 있는 락 — 타임아웃은 던진다(조용히 진행 금지)
  await mkdir(lock);
  await assert.rejects(withDirLock(lock, async () => 'no', { timeoutMs: 200, staleMs: 60_000 }), (e) => e.code === 'ELOCKTIMEOUT');
});

/* ── C ─────────────────────────────────────────────────────────────── */
test('C. classifyRunnerError — 상주 실측 원문 → 코드·출처 표 (순서: 구독 차단 > 404 > 크래시 > CLI > 한도 > 인증 > 모델 > 과부하)', () => {
  const c = (m, f) => classifyRunnerError(m, { flags: f });
  assert.deepEqual(c('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed'), { code: 'auth_expired', origin: 'probe' });
  assert.deepEqual(c('Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead'), { code: 'subscription_blocked', origin: 'vendor' });
  assert.equal(c('Failed to authenticate. Your organization has disabled Claude subscription access', { auth: true }).code, 'subscription_blocked', '"authenticate"가 섞여도 구독 차단이 인증보다 먼저');
  assert.deepEqual(c("You've hit your weekly limit · resets Aug 6"), { code: 'quota', origin: 'vendor' });
  assert.deepEqual(c('API Error: 403 {"code":"personal-team-blocked:spending-limit","error":"You have run out of credits'), { code: 'quota', origin: 'vendor' });
  assert.deepEqual(c('API Error: 529 Overloaded. This is a server-side issue'), { code: 'vendor_overloaded', origin: 'vendor' });
  assert.deepEqual(c('Connection closed mid-response'), { code: 'vendor_overloaded', origin: 'vendor' });
  assert.deepEqual(c('러너 CLI를 찾지 못했습니다 (설치 또는 PATH 문제)'), { code: 'cli_missing', origin: 'argo' });
  assert.deepEqual(c('exited with code 3221225477', { crash: true }), { code: 'crash', origin: 'argo' });
  assert.deepEqual(c('anything', { endpointNotFound: true }), { code: 'endpoint_not_found', origin: 'vendor' });
  assert.deepEqual(c('The model does not support this model xyz'), { code: 'model_unavailable', origin: 'vendor' });
  assert.deepEqual(c('중단됨', { aborted: true }), { code: 'aborted', origin: 'user' });
  assert.deepEqual(c('something odd'), { code: 'unknown', origin: 'probe' });
  assert.ok(FAIL_CODES.includes('unknown') && FAIL_CODES.length === 10);
});

test('C2. surfaceRunnerFailure — 맨 프로브로 vendor/argo를 갈라 각인하고, 벤더 거절일 때만 다음 턴을 차단한다', async () => {
  const ws = 'inv-c'; await company(ws);
  const calls = { verify: 0, mark: 0 };
  const base = { wsId: ws, runner: 'claude', lang: 'ko', loadCredFn: async () => ({ type: 'apikey', value: KEY }), markFn: async () => { calls.mark += 1; } };
  const authMsg = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  // ① 벤더도 거절 → vendor + 차단 각인 + 행동 안내 덧붙임(원문 보존)
  let out = await surfaceRunnerFailure(new Error(authMsg), { ...base, verifyFn: async () => { calls.verify += 1; return { ok: false, reason: 'auth' }; } });
  assert.equal(out.failCode, 'auth_expired'); assert.equal(out.failOrigin, 'vendor'); assert.equal(calls.mark, 1); assert.equal(out.authError, true);
  assert.match(out.message, /OAuth session expired/); assert.match(out.message, /다시 연결/);
  // ② 벤더는 통과 → argo(우리 배관 문제) — 차단하지 않는다(fail-open)
  calls.mark = 0;
  out = await surfaceRunnerFailure(new Error(authMsg), { ...base, verifyFn: async () => ({ ok: true }) });
  assert.equal(out.failOrigin, 'argo'); assert.equal(calls.mark, 0, '자격이 멀쩡하면 다음 턴을 막지 않는다');
  // ③ 판정 불가 → probe, 차단 없음
  out = await surfaceRunnerFailure(new Error(authMsg), { ...base, verifyFn: async () => ({ ok: null }) });
  assert.equal(out.failOrigin, 'probe'); assert.equal(calls.mark, 0);
  // ④ host 자격은 원격 판정 대상 아님 — 프로브·각인 없음
  calls.verify = 0;
  out = await surfaceRunnerFailure(new Error(authMsg), { ...base, loadCredFn: async () => ({ type: 'host', value: 'host' }), verifyFn: async () => { calls.verify += 1; return { ok: false }; } });
  assert.equal(calls.verify, 0); assert.equal(calls.mark, 0);
  // ⑤ 과금 프로브 러너(grok)는 프로브 없이 probe로 남긴다
  out = await surfaceRunnerFailure(new Error(authMsg), { ...base, runner: 'grok', verifyFn: async () => { calls.verify += 1; return { ok: false }; } });
  assert.equal(calls.verify, 0); assert.equal(out.failOrigin, 'probe');
  // ⑥ 게이트가 끊은 턴(knownInvalid) — 이미 vendor 확정, 재프로브 없음
  out = await surfaceRunnerFailure(Object.assign(new Error('x'), { authExpired: 'claude', knownInvalid: true }), { ...base, verifyFn: async () => { calls.verify += 1; return { ok: false }; } });
  assert.equal(calls.verify, 0); assert.equal(out.failOrigin, 'vendor');
  // ⑦ 실제 게이트 연동 — vendor 판정 뒤 runnerCredEnv가 실행 전에 끊는다(A와 C의 접점)
  await saveRunnerCred(ws, 'claude', 'apikey', KEY);
  await surfaceRunnerFailure(new Error(authMsg), { ...base, markFn: undefined, verifyFn: async () => ({ ok: false, reason: 'auth' }) });
  await assert.rejects(runnerCredEnv(ws, 'claude'), (e) => e.authExpired === 'claude');
});

/* ── E ─────────────────────────────────────────────────────────────── */
test('E. 구독 차단은 인증 실패가 아니다 — AUTH_ERR_RE 미매칭(자가치유 미발동) + 키 전환 안내로 대체', async () => {
  const msg = 'Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead';
  assert.ok(SUBSCRIPTION_BLOCKED_RE.test(msg));
  assert.equal(AUTH_ERR_RE.test(msg), false, '자가치유(다른 러너 갈아타기) 발동 금지 — 사용자 고지 없이 실과금 키로 넘어간다');
  assert.ok(AUTH_ERR_RE.test('Failed to authenticate: OAuth session expired and could not be refreshed'), '상주 실패 1위 문구는 이제 자가치유·안내 대상');
  const out = await surfaceRunnerFailure(new Error(msg), { wsId: 'inv-e', runner: 'claude', lang: 'ko', loadCredFn: async () => null });
  assert.equal(out.failCode, 'subscription_blocked'); assert.equal(out.failOrigin, 'vendor');
  assert.equal(out.authError, undefined, 'authError 표식 없음'); assert.equal(out.subscriptionBlocked, true);
  assert.match(out.message, /API 키 방식/); assert.match(out.message, /disabled Claude subscription/, '원문 보존');
  assert.match(subscriptionBlockedNotice('en', 'Claude'), /not a sign-in problem/);
});

test('E2. i18n 코드 표 1:1 — FAIL_CODES 전부 chat.fail.<code>가 ko/en 사전에 있다', async () => {
  const src = await readFile(join(ROOT, 'app', 'i18n.jsx'), 'utf8');
  for (const code of FAIL_CODES) assert.match(src, new RegExp(`'chat\\.fail\\.${code}': \\['[^']+', '[^']+'\\]`), `chat.fail.${code} 누락`);
  assert.match(src, /'chat\.modelFallback': \['[^']+', '[^']+'\]/);
});

/* ── D ─────────────────────────────────────────────────────────────── */
test('D. 원격 카탈로그 오버레이 — 검증·add/retire/alias·TTL·stale 유지·디스크 캐시', async () => {
  cat._resetForTest();
  const ov = { schema: 1, runners: { claude: { add: [{ id: 'claude-new-9', label: 'New 9' }], retire: ['claude-opus-4-6'], alias: { 'claude-old-1': 'claude-opus-5' } } } };
  assert.equal(cat.validateOverlay({ schema: 2, runners: {} }), null, '스키마 불일치 거절');
  assert.equal(cat.validateOverlay({ schema: 1, runners: { nope: {} } }), null, '모르는 러너 거절(부분 수용 없음)');
  assert.equal(cat.validateOverlay({ schema: 1, runners: { claude: { add: [{ id: 42 }] } } }), null, '모양 틀린 add 거절');
  const v = cat.validateOverlay(ov);
  const models = cat.applyOverlay('claude', RUNNERS.claude.models, v);
  assert.ok(models.some((m) => m.id === 'claude-new-9') && !models.some((m) => m.id === 'claude-opus-4-6'), 'add·retire 적용');
  assert.equal(models.filter((m) => m.id === '').length, RUNNERS.claude.models.filter((m) => m.id === '').length, '기본 모델(빈 id) 항목은 있으면 그대로 보존');
  assert.equal(cat.applyOverlay('claude', RUNNERS.claude.models, v).length, RUNNERS.claude.models.length, '중복 add 없음 = 개수 불변(+1 -1)');
  assert.ok(cat.isKnownModel('claude', '', v), '빈 id(기본 모델)는 목록 항목 유무와 무관하게 항상 유효');
  assert.equal(cat.normalizeModelId('claude', 'claude-old-1', v), 'claude-opus-5', 'alias');
  assert.equal(cat.normalizeModelId('claude', 'claude-opus-5', v), 'claude-opus-5', '매핑 없으면 그대로');
  assert.ok(cat.isKnownModel('claude', 'claude-old-1', v) && cat.isKnownModel('claude', '', v) && !cat.isKnownModel('claude', 'claude-opus-4-6', v));
  // 로더 — fetch 1회, TTL 안 재호출 없음, 실패는 stale 유지, 디스크 캐시 재기동 복원
  let fetches = 0; let now = 1_000_000;
  const good = async () => { fetches += 1; return { ok: true, json: async () => ov }; };
  const got = await cat.loadRemoteCatalog({ fetchImpl: good, now });
  assert.equal(got.runners.claude.add[0].id, 'claude-new-9'); assert.equal(fetches, 1);
  await cat.loadRemoteCatalog({ fetchImpl: good, now: now + 60_000 }); assert.equal(fetches, 1, 'TTL 안 = 캐시');
  const bad = async () => { fetches += 1; throw new Error('offline'); };
  const stale = await cat.loadRemoteCatalog({ fetchImpl: bad, now: now + 30 * 60_000 });
  assert.equal(stale.runners.claude.add[0].id, 'claude-new-9', '실패 시 stale 유지'); assert.equal(fetches, 2);
  const junk = async () => { fetches += 1; return { ok: true, json: async () => ({ schema: 1, runners: { nope: {} } }) }; };
  assert.equal((await cat.loadRemoteCatalog({ fetchImpl: junk, now: now + 60 * 60_000 })).runners.claude.add[0].id, 'claude-new-9', '스키마 위반 응답도 stale 유지');
  cat._resetForTest();
  assert.equal((await cat.loadRemoteCatalog({ fetchImpl: bad, now })).runners.claude.add[0].id, 'claude-new-9', '재기동 = 디스크 캐시로 즉시 채움');
  assert.equal(cat.effectiveModels('claude').some((m) => m.id === 'claude-new-9'), true, 'effectiveModels가 메모리 오버레이를 본다');
  cat._resetForTest();
});

test('D2. 모델 저장 검증 — 러너 목록 밖 id는 저장 시점에 거절, 폐기 id는 alias로 현행 저장, 빈 값(기본)은 통과', async () => {
  const ws = 'inv-d'; await company(ws);
  const { updateAgentMeta } = await import('../src/persona.mjs');
  const file = join(paths(ws).agents, 'tester.md'); // persona.cardPath와 같은 자리(비공개 함수 — 경로 계약만 공유)
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '---\nname: 테스터\nrole: QA\nrunner: claude\nmodel: \n---\n# 테스터 — QA\n');
  // 목록 밖 id는 **거절하지 않고 그대로 저장**(분리 검수 HIGH-2: 거절하면 카탈로그에서 제거된 모델을 쓰던 업그레이드
  // 사용자의 크루가 이름 편집까지 막힌다). 실행 시 chat.mjs가 기본 모델로 답하고 modelFallback으로 고지한다.
  await updateAgentMeta(ws, 'tester', { name: '테스터2', model: 'gpt-nope-9' });
  assert.match(await readFile(file, 'utf8'), /^model: gpt-nope-9$/m, '목록 밖 id도 저장(오류 없음)');
  assert.match(await readFile(file, 'utf8'), /^name: 테스터2$/m, '무관한 편집(이름)이 막히지 않는다');
  await updateAgentMeta(ws, 'tester', { model: 'claude-opus-5' });
  assert.match(await readFile(file, 'utf8'), /^model: claude-opus-5$/m);
  cat._resetForTest();
  await cat.loadRemoteCatalog({ fetchImpl: async () => ({ ok: true, json: async () => ({ schema: 1, runners: { claude: { alias: { 'claude-old-1': 'claude-opus-5' } } } }) }), now: 5_000_000 });
  await updateAgentMeta(ws, 'tester', { model: 'claude-old-1' });
  assert.match(await readFile(file, 'utf8'), /^model: claude-opus-5$/m, '폐기 id는 현행 id로 저장');
  await updateAgentMeta(ws, 'tester', { model: '' });
  assert.doesNotMatch(await readFile(file, 'utf8'), /^model:/m, '빈 값 = 기본 모델 통과(검증을 거치지 않고, setFrontmatterKey가 키를 제거)');
  cat._resetForTest();
});

test('D3. 배선 핀 — chat.mjs가 modelFallback을 두 반환 경로에 싣고, 두 catch가 surfaceRunnerFailure를 지난다', async () => {
  const src = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.equal((src.match(/\.\.\.modelFallbackInfo \}/g) ?? []).length, 2, 'CLI·SDK 반환 둘 다');
  assert.match(src, /const modelFallbackInfo = \(!resolved\.fellBack && wantModel && !knownHere\)/);
  assert.equal((src.match(/await surfaceRunnerFailure\(/g) ?? []).length, 2, 'CLI·SDK catch 둘 다');
  assert.match(src, /const wantModel = normalizeModelId\(runner, modelOverride \|\| meta\.model\)/, 'alias가 실행 경로에도 적용');
  const thread = await readFile(join(ROOT, 'src', 'thread.mjs'), 'utf8');
  assert.equal((thread.match(/\.\.\.\(modelFallback \? \{ modelFallback \} : \{\}\)/g) ?? []).length, 2, '크루 메시지 두 push 지점');
  const route = await readFile(join(ROOT, 'app', 'api', 'companies', '[ws]', 'chat', 'route.js'), 'utf8');
  assert.match(route, /failedCode, failedOrigin, aborted, attachments \}/, '실패 코드가 스레드에 기록');
  assert.match(route, /modelFallback: t\.modelFallback/, '강등 고지가 스레드에 기록');
});

/* ── 분리 검수(review-432) 처방 — HIGH-1·MEDIUM-1·2·3·4 + GREEN 변이 R2·R3·R4·R8·R9 봉합 ── */
test('HIGH-1. shouldSelfHeal — 게이트가 끊은 오류(authExpired 필드)는 문구와 무관하게 다른 러너로 자가치유한다; 구독 차단은 아니다', async () => {
  const { shouldSelfHeal } = await import('../src/chat.mjs');
  const gateErr = Object.assign(new Error('claude credential known-invalid since 2026-09-05T04:54:22.115Z — not started'), { authExpired: 'claude', knownInvalid: true });
  assert.equal(AUTH_ERR_RE.test(gateErr.message), false, '전제: 게이트 문구는 정규식에 안 걸린다(검수 실측)');
  assert.equal(shouldSelfHeal(gateErr), true, '필드 기준으로 발동 — 러너 2개 사용자가 한쪽 만료에 턴이 죽지 않는다');
  assert.equal(shouldSelfHeal(new Error('grok token expired and refresh failed')), true, '기존 grok 게이트 문구(선례) 유지');
  assert.equal(shouldSelfHeal(new Error('Your organization has disabled Claude subscription access for Claude Code')), false, '구독 차단은 자가치유 금지(E)');
  assert.equal(shouldSelfHeal(new Error('API Error: 529 Overloaded')), false, '과부하는 갈아타기 아님');
  // 배선 핀 — CLI·SDK 두 catch가 모두 이 판정을 쓴다(문자열 정규식 직접 호출 잔존 = 회귀)
  const src = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.equal((src.match(/shouldSelfHeal\(e, \{ retried: __lockupRetry \}\)/g) ?? []).length, 1, 'CLI catch 호출부(잠김 교체 포함)');
  assert.equal((src.match(/shouldSelfHeal\(e, \{ lockup: false \}\)/g) ?? []).length, 1, 'SDK catch 호출부(인증만 — 종전 계약)');
  assert.doesNotMatch(src, /if \(!aborted && \(AUTH_ERR_RE\.test\(String\(e\.message \|\| e\)\)/, '옛 문자열 판정 호출부 잔존 금지');
});

test('MEDIUM-2. surfaceRunnerFailure — 이미 코드가 붙은 오류는 재프로브·재각인하지 않는다(프레임 중첩 1회 계약)', async () => {
  const calls = { verify: 0, mark: 0 };
  const opts = { wsId: 'inv-m2', runner: 'claude', lang: 'ko', loadCredFn: async () => ({ type: 'apikey', value: KEY }), verifyFn: async () => { calls.verify += 1; return { ok: false, reason: 'auth' }; }, markFn: async () => { calls.mark += 1; } };
  const once = await surfaceRunnerFailure(new Error('OAuth session expired and could not be refreshed'), opts);
  const twice = await surfaceRunnerFailure(once, opts);
  assert.equal(calls.verify, 1); assert.equal(calls.mark, 1); assert.equal(twice, once, '같은 객체 그대로');
});

test('MEDIUM-1. 오버레이 null 상태에서도 TTL 안에는 원격을 재요청하지 않는다', async () => {
  // 앞선 테스트가 남긴 디스크 캐시가 첫 호출에서 오버레이를 채우면 "null 상태"가 재현되지 않는다(변이 M1이 초록이던 구멍) —
  // 캐시 없는 새 디렉터리로 바꿔 첫 응답이 실제로 null인지까지 핀한다.
  const prevCache = process.env.ARGO_CACHE_DIR;
  process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-inv-cache-null-'));
  try {
    cat._resetForTest();
    let fetches = 0; const now = 9_000_000;
    const off = async () => { fetches += 1; throw new Error('offline'); };
    const first = await cat.loadRemoteCatalog({ fetchImpl: off, now });
    assert.equal(first, null, '전제: 디스크 캐시 없음 + 오프라인 = 오버레이 null(기본 상태)');
    for (let i = 1; i < 5; i++) await cat.loadRemoteCatalog({ fetchImpl: off, now: now + i * 1000 });
    assert.equal(fetches, 1, 'null(자산 미게시·오프라인)에서 매 호출 재요청하던 회귀 — 검수 실측 /api/runners 6회=fetch 6회');
    await cat.loadRemoteCatalog({ fetchImpl: off, now: now + 21 * 60_000 });
    assert.equal(fetches, 2, 'TTL이 지나면 재시도');
  } finally { process.env.ARGO_CACHE_DIR = prevCache; cat._resetForTest(); }
});

test('MEDIUM-4. 락 부모 디렉터리 부재에서도 save/clear가 성공하고, clear도 같은 락을 탄다', async () => {
  const ws = 'inv-m4-fresh'; // company()를 부르지 않는다 — 회사 디렉터리 부재 상태
  await saveRunnerCred(ws, 'claude', 'apikey', KEY);
  assert.equal((await loadRunnerCred(ws, 'claude'))?.value, KEY, '부모 없는 첫 저장 성공(종전 ENOENT 회귀)');
  const { clearRunnerCred } = await import('../src/runners/creds.mjs');
  await clearRunnerCred(ws, 'claude');
  assert.equal(await loadRunnerCred(ws, 'claude'), null);
  const src = await readFile(join(ROOT, 'src', 'runners', 'creds.mjs'), 'utf8');
  assert.equal((src.match(/await withDirLock\(`\$\{secretsFile\(wsId\)\}\.lockd`/g) ?? []).length, 2, 'save·clear 둘 다 같은 락(반쪽 잠금 금지)');
});

test('R4. thread.appendTurn — failedCode/failedOrigin·modelFallback이 실제로 저장된다(배선 행동)', async () => {
  const ws = 'inv-r4'; await company(ws);
  const { appendTurn, loadThread } = await import('../src/thread.mjs');
  await mkdir(join(paths(ws).root, 'chats'), { recursive: true });
  await appendTurn(ws, 'crew-a', { userMsg: '실패할 지시', failed: 'API Error: 401', failedCode: 'auth_expired', failedOrigin: 'vendor' });
  await appendTurn(ws, 'crew-a', { userMsg: '성공 지시', reply: '답', handover: null, sessionId: null, modelFallback: { wanted: 'gpt-nope-9', runner: 'claude' } });
  const t = await loadThread(ws, 'crew-a');
  const failed = t.messages.find((m) => m.failed);
  assert.equal(failed.failedCode, 'auth_expired'); assert.equal(failed.failedOrigin, 'vendor');
  const crew = t.messages.find((m) => m.who === 'crew');
  assert.deepEqual(crew.modelFallback, { wanted: 'gpt-nope-9', runner: 'claude' });
  // turnId 선저장 갈래(beginTurn이 써 둔 줄을 마무리) — 실제 채팅 라우트가 타는 경로. 변이 R4가 초록이던 구멍(위는 무turnId 갈래만 밟았다).
  const { beginTurn } = await import('../src/thread.mjs');
  const id1 = await beginTurn(ws, 'crew-b', { userMsg: '선저장 뒤 실패' });
  await appendTurn(ws, 'crew-b', { turnId: id1, userMsg: '선저장 뒤 실패', failed: 'API Error: 429', failedCode: 'quota', failedOrigin: 'vendor' });
  const id2 = await beginTurn(ws, 'crew-b', { userMsg: '선저장 뒤 성공' });
  await appendTurn(ws, 'crew-b', { turnId: id2, userMsg: '선저장 뒤 성공', reply: '답2', handover: null, sessionId: null, modelFallback: { wanted: 'gpt-nope-9', runner: 'claude' } });
  const t2 = await loadThread(ws, 'crew-b');
  const u1 = t2.messages.find((m) => m.turnId === id1);
  assert.equal(u1.failedCode, 'quota'); assert.equal(u1.failedOrigin, 'vendor'); assert.equal(u1.failed, 'API Error: 429');
  assert.equal(t2.messages.filter((m) => m.who === 'user').length, 2, '선저장 줄을 마무리하지 새 줄을 밀어 넣지 않는다');
  const i2 = t2.messages.findIndex((m) => m.turnId === id2);
  assert.deepEqual(t2.messages[i2 + 1]?.modelFallback, { wanted: 'gpt-nope-9', runner: 'claude' }, '답은 그 지시 바로 뒤 + 강등 고지 보존');
});

test('R8. /api/runners 라우트 실호출 — 오버레이 add/retire가 응답 models에 반영된다', async () => {
  cat._resetForTest();
  await cat.loadRemoteCatalog({ fetchImpl: async () => ({ ok: true, json: async () => ({ schema: 1, runners: { claude: { add: [{ id: 'claude-r8-x', label: 'R8' }], retire: ['claude-opus-4-6'] } } }) }), now: 7_000_000 });
  const { register } = await import('node:module');
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  const route = await import('../app/api/runners/route.js');
  const res = await route.GET(new Request('http://localhost/api/runners'));
  const body = await res.json();
  const claude = (body.runners ?? body).find?.((r) => r.id === 'claude') ?? body.runners?.claude;
  assert.ok(claude, '응답에 claude 러너');
  assert.ok(claude.models.some((m) => m.id === 'claude-r8-x'), 'add 반영');
  assert.ok(!claude.models.some((m) => m.id === 'claude-opus-4-6'), 'retire 반영');
  cat._resetForTest();
});

test('R2·R3·R9·MEDIUM-3 배선 핀 — 이벤트·라우트 응답·UI 렌더·모델 소비자', async () => {
  const chat = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.equal((chat.match(/\.\.\.\(e\?\.failCode \? \{ failCode: e\.failCode, failOrigin: e\.failOrigin \} : \{\}\)/g) ?? []).length, 2, 'R2: CLI·SDK 실패 이벤트 둘 다 코드·출처를 싣는다');
  const route = await readFile(join(ROOT, 'app', 'api', 'companies', '[ws]', 'chat', 'route.js'), 'utf8');
  assert.match(route, /Response\.json\(\{ error: failed, code: failedCode, origin: failedOrigin, aborted, saved \}/, 'R3: 500 응답 code/origin');
  const page = await readFile(join(ROOT, 'app', 'c', '[ws]', 'crew', '[slug]', 'page.jsx'), 'utf8');
  assert.match(page, /\{m\.modelFallback && \(/, 'R9: 강등 고지 렌더 블록');
  assert.match(page, /t\('chat\.modelFallback', \{ wanted: m\.modelFallback\.wanted/, 'R9: 사전 키 배선');
  assert.match(page, /t\(`chat\.fail\.\$\{m\.failedCode\}`/, 'R9: 실패 코드 렌더');
  // MEDIUM-3: 오버레이 소비자 전수 — RUNNERS 원목록(.models)을 직접 판정에 쓰는 곳이 남아 있으면 UI·백엔드가 갈린다
  for (const f of ['src/chat.mjs', 'src/compete.mjs', 'src/oneshot.mjs']) {
    const s = await readFile(join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /RUNNERS(?:\[[^\]]+\]|\.[a-z]+)\??\.models\.(?:some|find|filter|map)\(/, `${f}: RUNNERS 원목록 직접 소비 잔존`);
  }
  const edit = await readFile(join(ROOT, 'app', 'c', '[ws]', 'crew-edit.jsx'), 'utf8');
  assert.match(edit, /t\('deck\.modelNotInList'\)/, 'HIGH-2: 현재 값 예외 옵션');
});
