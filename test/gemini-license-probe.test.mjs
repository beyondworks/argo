// Gemini 구독(OAuth) 연결 단계 사전 감지 회귀 테스트 (2026-08-31, #373 분리 검수 반영 개정)
// 판정은 loadCodeAssist 1콜·0토큰(ineligibleTiers — 검수가 라이브로 확인한 벤더 자기신호).
// 유효 자격 오거절 방지가 최우선 제약(glm verify 선례) — 확정 거절은 두 형태뿐, 나머지 전부 관용.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-gemhome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gemtest-'));
// AUTH off — 라우트 실호출(행동 게이트)이 가드를 지나기 위해(api-error-lang ⑤ 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url), import.meta.url);

// 가짜 gemini CLI를 PATH 선두에 심는다 — webauth 행동 테스트의 probeGeminiOAuth가 **실제 CLI를
// 절대 타지 않게**(실측 사고 2026-08-31: 무효 자격을 만난 실제 CLI가 구글 로그인 브라우저 창을
// 반복으로 띄웠고, CI에서는 CLI 조달 다운로드까지 트리거된다). 즉시 실패 스텁 → ok:null 관용 경로.
import { chmod } from 'node:fs/promises';
const fakeBin = join(process.env.HOME, 'fakebin');
await mkdir(fakeBin, { recursive: true });
await writeFile(join(fakeBin, 'gemini'), '#!/bin/sh\nexit 1\n');
await chmod(join(fakeBin, 'gemini'), 0o755);
await writeFile(join(fakeBin, 'gemini.cmd'), '@exit /b 1\r\n'); // Windows CI 대칭
process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;

const { probeGeminiSubscription, geminiAccessToken } = await import('../src/runners/gemini.mjs');

const FUTURE = Date.now() + 3_600_000;
const blob = (over = {}) => JSON.stringify({ access_token: 'ya29.fresh', refresh_token: 'r', expiry_date: FUTURE, ...over });
// 이 기기 라이브 실측 바디 그대로(2026-08-31, 차단 실계정) — 판정의 근거 표본
const BLOCKED_BODY = { allowedTiers: [{ id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true }], ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'no longer supported for Gemini Code Assist for individuals' }] };

// fetch 스텁 — 호출 URL을 수집해 단언한다(#6: "의도 밖 호출 = 실패" 주장이 거짓이었던 것을
// 관측 가능한 계약으로 교체 — 프로브 최외곽 catch가 스텁 예외를 삼켜도 호출 목록은 남는다).
const stub = (routes, calls = []) => {
  const f = async (url) => {
    calls.push(String(url).replace(/^https:\/\//, '').split('?')[0]);
    for (const [frag, resp] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        return { ok: resp.status < 300, status: resp.status, json: async () => resp.json ?? {}, text: async () => resp.text ?? JSON.stringify(resp.json ?? {}) };
      }
    }
    throw new Error(`unstubbed: ${url}`);
  };
  f.calls = calls;
  return f;
};

// ── 단위: 판정 계약 ─────────────────────────────────────────────────────────
test('차단 실계정 형태(관리형 프로젝트 없음 + free-tier UNSUPPORTED_CLIENT) = gemini-license, 1콜·0토큰', async () => {
  const f = stub({ 'loadCodeAssist': { status: 200, json: BLOCKED_BODY } });
  assert.deepEqual(await probeGeminiSubscription(blob(), f), { ok: false, reason: 'gemini-license' });
  assert.deepEqual(f.calls, ['cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'], '생성 호출·GCP 목록 열람 없음(0토큰·부작용 0)');
});
test('403 + valid license 문구(관리자 미배정) = gemini-license / 403 비라이선스 문구 = 관용', async () => {
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 403, text: '{"error":{"message":"You do not have a valid license of this product."}}' } })), { ok: false, reason: 'gemini-license' });
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 403, text: '{"error":{"message":"Permission denied on resource"}}' } })), { ok: null }, '403은 인증 통과 후 권한 오류 — 재발급 오안내 금지(검수 #2)');
});
test('오거절 방지: 관리형 프로젝트 보유·미온보딩 개인(free-tier 허용)·401 외 오류·오프라인·만료 전부 확정 거절 아님', async () => {
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 200, json: { cloudaicompanionProject: 'managed-p' } } })), { ok: null }, '관리형 보유');
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 200, json: { allowedTiers: [{ id: 'free-tier', isDefault: true }] } } })), { ok: null }, '미온보딩 개인 계정 — 차단 금지');
  // free-tier가 부적격 목록에 있어도 **허용 목록에도 있으면** 차단하지 않는다 — 벤더가 과도기에
  // 양쪽에 싣는 형태를 오거절하지 않기 위한 보수 경계("freeBlocked만 보기" 완화 변이를 문다).
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 200, json: { allowedTiers: [{ id: 'free-tier' }], ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT' }] } } })), { ok: null }, '부적격+허용 공존 = 관용');
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 429, text: 'rate limit' } })), { ok: null });
  assert.deepEqual(await probeGeminiSubscription(blob(), async () => { throw new Error('offline'); }), { ok: null });
  const f = stub({});
  assert.deepEqual(await probeGeminiSubscription(blob({ expiry_date: Date.now() - 1000 }), f), { ok: null });
  assert.deepEqual(f.calls, [], '만료 blob은 네트워크 0(갱신 미탑재 — 사유는 geminiAccessToken 주석)');
});
test('401 = 토큰 무효(auth — 기존 재발급 안내 경로)', async () => {
  assert.deepEqual(await probeGeminiSubscription(blob(), stub({ 'loadCodeAssist': { status: 401 } })), { ok: false, reason: 'auth' });
});
test('geminiAccessToken: 신선/만료/무만료시각/형식불명', () => {
  assert.equal(geminiAccessToken(blob()), 'ya29.fresh');
  assert.equal(geminiAccessToken(blob({ expiry_date: Date.now() - 1 })), null);
  assert.equal(geminiAccessToken(JSON.stringify({ access_token: 'a' })), 'a', '만료시각 없는 값은 통과(관용)');
  assert.equal(geminiAccessToken('not-json'), null);
});

// ── 행동: 실제 저장 경로(#373 검수 HIGH-1 — 붙여넣기 verify는 UI 도달 불가, 실경로를 잠근다) ──
test('webauth finishWebAuth: 차단 계정은 저장하지 않고 API 키 안내를 돌려준다(행동)', async () => {
  const { submitRunnerWebAuth } = await import('../src/runners.mjs');
  // 토큰 교환 + loadCodeAssist를 전역 fetch 스텁으로 — finishWebAuth까지 실호출
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'ya29.x', refresh_token: 'r', expires_in: 3600, scope: 's', token_type: 'Bearer' }), { status: 200 });
    if (u.includes('loadCodeAssist')) return new Response(JSON.stringify(BLOCKED_BODY), { status: 200 });
    throw new Error('unstubbed: ' + u);
  };
  try {
    const ws = 'wa-lic';
    await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
    // 웹 브리지 상태 시드 — startRunnerWebAuth 없이 상태통에 직접(교환 코드 검증은 스텁이 담당)
    (globalThis.__argoWebAuth ??= {}).gemini = { verifier: 'v'.repeat(43), state: 'st', ts: Date.now() };
    const r = await submitRunnerWebAuth(ws, 'gemini', 'http://localhost:45289/oauth2callback?code=c&state=st');
    assert.equal(r.ok, false, '저장 거부');
    assert.equal(r.reason, 'gemini-license');
    assert.match(String(r.detail), /API 키 방식으로 연결/, 'API 키 전환 안내(재발급 오안내 아님)');
    const secrets = await readFile(join(process.env.ARGO_ROOT, ws, '.secrets.json'), 'utf8').catch(() => '{}');
    assert.ok(!JSON.parse(secrets)?.runners?.gemini, '자격이 저장되지 않았다');
  } finally { globalThis.fetch = realFetch; }
});
test('회사 keys PUT(oauth 붙여넣기·API 경로): license = API 키 안내 400, 일반 무효 = 재발급 문구(행동)', async () => {
  const ws = 'rt-lic';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await writeFile(join(process.env.ARGO_ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 't', lang: 'ko' }));
  const route = await import('../app/api/companies/[ws]/keys/route.js');
  const put = (value) => route.PUT(new Request('http://x/api', { method: 'PUT', body: JSON.stringify({ runner: 'gemini', type: 'oauth', value, lang: 'ko' }), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ ws }) });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => { if (String(url).includes('loadCodeAssist')) return new Response(JSON.stringify(BLOCKED_BODY), { status: 200 }); throw new Error('unstubbed'); };
    const r1 = await put(blob());
    assert.equal(r1.status, 400);
    assert.match((await r1.json()).error, /Code Assist 라이선스가 없어[\s\S]*API 키 방식/, 'license = API 키 전환 안내');
    globalThis.fetch = async (url) => { if (String(url).includes('loadCodeAssist')) return new Response('', { status: 401 }); throw new Error('unstubbed'); };
    const r2 = await put(blob());
    assert.equal(r2.status, 400);
    assert.match((await r2.json()).error, /새로 발급해 다시 붙여넣어/, '일반 무효 = 재발급 문구');
  } finally { globalThis.fetch = realFetch; }
});
