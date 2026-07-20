// 웹 브리지 OAuth state 회귀 테스트 — PKCE code_verifier가 state로 인증 URL에 실려,
// 사용자가 공유하는 리다이렉트 주소가 그 자체로 탈취 가능한 자격이 되던 감사 HIGH(2026-07-20) 재발 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-webauthtest-'));
const { startRunnerWebAuth, submitRunnerWebAuth } = await import('../src/runners.mjs');

/** 실네트워크 차단 — 이 파일의 submit 테스트는 state 게이트 통과 여부만 본다. */
function blockFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('blocked-by-test'); };
  return () => { globalThis.fetch = real; };
}

test('startRunnerWebAuth: state ≠ verifier — verifier는 인증 URL 어디에도 실리지 않는다', () => {
  // wsId 미전달 = 콜백 리스너 미기동(포트 점유 없음)
  const r = startRunnerWebAuth('codex');
  assert.ok(r.ok, '브리지 시작');
  const sess = globalThis.__argoWebAuth?.codex;
  assert.ok(sess?.verifier && sess?.state, '세션에 verifier·state 저장');
  assert.notEqual(sess.state, sess.verifier, 'state는 verifier와 무관한 별도 난수(과거 설계 회귀 방지)');
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('state'), sess.state, 'URL state = 저장된 난수');
  assert.ok(!r.url.includes(sess.verifier), 'verifier가 URL 전체에 부재 — 주소 공유가 자격 유출이 아니게');
  // PKCE 정합: challenge = S256(verifier)는 유지되어야 교환이 성립한다
  const challenge = createHash('sha256').update(sess.verifier).digest('base64url');
  assert.equal(u.searchParams.get('code_challenge'), challenge, 'code_challenge = S256(메모리 verifier)');
});

test('submitRunnerWebAuth: state 불일치는 교환 시도 전에 거절(state-mismatch)', async () => {
  const restore = blockFetch(); // 게이트가 뚫리면 blocked-by-test(network)로 드러난다
  try {
    startRunnerWebAuth('codex');
    const r = await submitRunnerWebAuth('webauthco', 'codex', 'http://localhost:1455/auth/callback?code=abc123&state=FORGED');
    assert.deepEqual(r, { ok: false, reason: 'state-mismatch' }, '위조·타 세션 state는 토큰 교환 자체를 막는다');
  } finally { restore(); }
});

test('submitRunnerWebAuth: 올바른 state·생 코드(무 state)는 게이트를 통과해 교환 단계 도달', async () => {
  const restore = blockFetch();
  try {
    const { url } = startRunnerWebAuth('codex');
    const state = new URL(url).searchParams.get('state');
    // 올바른 state — 게이트 통과 후 fetch(차단됨) 도달 = reason 'network'
    let r = await submitRunnerWebAuth('webauthco', 'codex', `http://localhost:1455/auth/callback?code=abc123&state=${state}`);
    assert.equal(r.reason, 'network', '정상 state는 교환 단계까지 진행(리스너·전체 URL 경로)');
    // 생 코드 붙여넣기(state 부재) — 관용 통과(PKCE 교환이 위조 코드를 차단)
    r = await submitRunnerWebAuth('webauthco', 'codex', 'abc123');
    assert.equal(r.reason, 'network', 'state 없는 생 코드는 관용 — 교환 단계 도달');
  } finally { restore(); }
});
