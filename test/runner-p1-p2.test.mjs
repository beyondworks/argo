// 러너 견고화 P1·P2 회귀 테스트 (2026-09-01, docs/runner-resilience-v0155.md P1·P2)
// P1-1 마지막 턴 상태: SDK 턴 이벤트에도 runner가 실리고(CLI 갈래엔 기존재 — 비대칭 봉합),
//   연결 카드가 활동 이벤트에서 러너별 최신 턴을 읽어 경고를 단다.
// P1-2 연결 확인: 저장 자격 온디맨드 재검증 라우트 + 카드 버튼.
// P2 폴백 투명화: chat 반환 fellBack → 스레드 크루 메시지 저장 → 크루 UI 안내.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-p12home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-p12-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url), import.meta.url);

const chatSrc = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
const threadSrc = await readFile(new URL('../src/thread.mjs', import.meta.url), 'utf8');
const routeSrc = await readFile(new URL('../app/api/companies/[ws]/chat/route.js', import.meta.url), 'utf8');
const crewSrc = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
const connectSrc = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');

// ── P1-1: SDK evBase runner 비대칭 봉합 ──────────────────────────────────
test('SDK 턴 이벤트에 runner가 실린다 — CLI 갈래와 대칭(연결 카드 마지막 턴 상태의 원천)', () => {
  // SDK evBase 구간: 두 evBase 중 msg를 싣는 쪽(SDK). runner 부재가 이 기능의 결함이었다.
  const sdkEv = chatSrc.match(/const evBase = \{\n[\s\S]{0,600}?gist, runner, msg: userMsg\.slice\(0, 2000\),\n  \};/);
  assert.ok(sdkEv, 'SDK evBase에 runner 포함(제거 변이는 여기서 red)');
});
test('lastTurnByRunner(순수): 최신 우선·ok 판정·중단 필드/레거시 문자열 (검수 관점5 — 소스 핀은 판정 두 필드에 fail-open이었다)', async () => {
  const { lastTurnByRunner } = await import('../app/runner-usable.mjs');
  const by = lastTurnByRunner([
    { type: 'turn', runner: 'grok', ok: false, error: 'API Error: 400 …' },          // 최신 — 실패
    { type: 'turn', runner: 'grok', ok: true },                                       // 과거 — 무시(첫 매치)
    { type: 'turn', runner: 'claude', ok: false, aborted: true, error: '사장 지시로 중단' }, // 필드 중단
    { type: 'turn', runner: 'kimi', ok: false, error: '사장 지시로 중단' },            // 레거시 문자열 중단
    { type: 'turn', runner: 'glm' },                                                  // ok 부재 = 성공 취급
    { type: 'mcp', runner: 'codex', ok: false },                                      // 비턴 이벤트 무시
  ]);
  assert.deepEqual(by.grok, { ok: false, aborted: false }, '실패 턴 — 경고 대상');
  assert.deepEqual(by.claude, { ok: false, aborted: true }, '중단 필드 — 경고 제외');
  assert.deepEqual(by.kimi, { ok: false, aborted: true }, '레거시 문자열 폴백 — 경고 제외');
  assert.deepEqual(by.glm, { ok: true, aborted: false });
  assert.ok(!('codex' in by), '턴 이벤트만');
  assert.deepEqual(lastTurnByRunner(undefined), {}, '이벤트 부재 관용');
});
test('연결 카드: 순수 판정 소비 + 경고 렌더 조건 배선', () => {
  assert.match(connectSrc, /setLastTurns\(lastTurnByRunner\(d\.events\)\)/, '수집은 순수 함수 단일 진실');
  assert.match(connectSrc, /lastTurn && !lastTurn\.ok && !lastTurn\.aborted && \(/, '실패(중단 제외)에만 경고');
  assert.match(connectSrc, /t\('settings\.runners\.lastTurnFailed'\)/, '경고 문구는 사전 경유(i18n 절대규칙)');
});

// ── P1-2: verify 라우트 행동 ─────────────────────────────────────────────
test('keys/verify 라우트: 저장 자격 재검증 — 무연결 관용·host 관용·gemini 차단 판정(행동)', async () => {
  const ws = 'p12-verify';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await writeFile(join(process.env.ARGO_ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 't', lang: 'ko' }));
  const route = await import('../app/api/companies/[ws]/keys/verify/route.js');
  const post = (runner) => route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ runner }) }), { params: Promise.resolve({ ws }) });
  // 무연결 → ok:null(관용)
  assert.deepEqual(await (await post('grok')).json(), { ok: null, reason: 'not-connected' });
  // gemini oauth 차단 계정(스텁 fetch — 실측 바디 형태) → ok:false + gemini-license
  const { saveRunnerCred } = await import('../src/runners.mjs');
  await saveRunnerCred(ws, 'gemini', 'oauth', JSON.stringify({ access_token: 'ya29.x', refresh_token: 'r', expiry_date: Date.now() + 3600_000 }));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('loadCodeAssist')) return new Response(JSON.stringify({ allowedTiers: [{ id: 'standard-tier', isDefault: true }], ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT' }] }), { status: 200 });
      throw new Error('unstubbed: ' + url);
    };
    assert.deepEqual(await (await post('gemini')).json(), { ok: false, reason: 'gemini-license' });
  } finally { globalThis.fetch = realFetch; }
  // host 마커 → ok:null(원격 판정 불가 정직 표기)
  await saveRunnerCred(ws, 'codex', 'host', 'host');
  assert.deepEqual(await (await post('codex')).json(), { ok: null, reason: 'host' });
});
test('연결 카드: 확인 버튼 배선 — 결과 3분기(성공·실패/license·판정 불가) 전부 사전 경유', () => {
  assert.match(connectSrc, /api\(`\/api\/companies\/\$\{ws\}\/keys\/verify`, \{ runner: id \}\)/, 'verify 호출(api 래퍼 계약 — 두 번째 인자 = JSON 바디)');
  for (const k of ['checkOk', 'checkFailed', 'geminiLicenseBlocked', 'checkInconclusive', 'checkNow']) {
    assert.match(connectSrc, new RegExp(`t\\('settings\\.runners\\.${k}'\\)`), `분기 문구: ${k}`);
  }
});

// ── P2: 폴백 투명화 배선 사슬 ────────────────────────────────────────────
test('P2 사슬: chat 반환 fellBack → 라우트 전달 → 스레드 저장 → 크루 UI 안내', () => {
  assert.match(chatSrc, /const fellBackInfo = resolved\.fellBack \? \{ fellBack: \{ from: wantRunner, to: runner, reason: wantExcluded \? 'auth' : 'unavailable' \} \} : \{\};/, '사전 폴백 표식(사유는 wantExcluded로 — 인증 제외 재귀와 프롬프트 고지의 모순 방지, 검수 M2)');
  // 자가치유 성공 래핑 — CLI·SDK 두 갈래 모두, 첫 원인 우선(안쪽 표식 유지)
  const heals = chatSrc.match(/fellBack: healed\.fellBack \?\? \{ from: runner, to: alt\.runner, reason: 'auth' \}/g) ?? [];
  assert.equal(heals.length, 2, '자가치유 래핑 2갈래(CLI·SDK)');
  assert.match(routeSrc, /artifacts: t\.artifacts, fellBack: t\.fellBack \}\)/, '라우트 전달');
  // M1 — 그 턴 즉시 표시: 라우트 응답·낙관 사본에도 실려야 한다(폴링 병합은 같은 길이면 교체 안 함)
  assert.match(routeSrc, /\.\.\.\(t\.fellBack \? \{ fellBack: t\.fellBack \} : \{\}\)/, '라우트 응답 동봉');
  assert.match(crewSrc, /\.\.\.\(r\.fellBack \? \{ fellBack: r\.fellBack \} : \{\}\)/, '낙관 사본 동봉');
  assert.match(threadSrc, /\.\.\.\(fellBack \? \{ fellBack \} : \{\}\)/, '스레드 크루 메시지 저장');
  assert.match(crewSrc, /m\.fellBack\.reason === 'auth' \? 'chat\.fellBack\.auth' : 'chat\.fellBack\.unavailable'/, '크루 UI 사유별 안내(사전 경유)');
});
test('P1-1 미탐 봉합: 자가치유 성공 턴도 실패 러너의 ok:false 이벤트를 선기록한다(2갈래)', () => {
  // 치유 성공 시 조기 return이 실패 기록을 삼켜, P2가 "인증 오류"라 말하는 턴에 연결 카드의 그
  // 러너가 멀쩡해 보였다(검수 관점3 구조적 미탐). CLI·SDK 두 자가치유 블록 모두에서 재시도 직전 기록.
  const pins = chatSrc.match(/appendEvent\(wsId, \{ \.\.\.evBase, ok: false, ms: Date\.now\(\) - t0, error: String\(e\.message \|\| e\)\.slice\(0, 400\), selfHealed: true \}\)\.catch\(\(\) => \{\}\);[\s\S]{0,700}?const healed = await chat\(/g) ?? [];
  assert.equal(pins.length, 2, '선기록→재시도 순서 고정(CLI·SDK) — 제거·순서 역전 변이는 여기서 red');
});

test('P2 행동: appendTurn이 fellBack을 크루 메시지에 저장한다', async () => {
  const { beginTurn, appendTurn, loadThread } = await import('../src/thread.mjs');
  const ws = 'p12-thread';
  await mkdir(join(process.env.ARGO_ROOT, ws, 'chats'), { recursive: true });
  const turnId = await beginTurn(ws, 'pepper', { userMsg: '지시' });
  await appendTurn(ws, 'pepper', { turnId, userMsg: '지시', reply: '답', fellBack: { from: 'grok', to: 'claude', reason: 'auth' } });
  const t = await loadThread(ws, 'pepper');
  const crew = t.messages.find((m) => m.who === 'crew');
  assert.deepEqual(crew.fellBack, { from: 'grok', to: 'claude', reason: 'auth' });
  // 폴백 없는 턴은 필드 자체가 없다(스레드 오염 금지)
  const turnId2 = await beginTurn(ws, 'pepper', { userMsg: '지시2' });
  await appendTurn(ws, 'pepper', { turnId: turnId2, userMsg: '지시2', reply: '답2' });
  const t2 = await loadThread(ws, 'pepper');
  assert.ok(!('fellBack' in t2.messages[t2.messages.length - 1]), '무폴백 턴은 무필드');
});
