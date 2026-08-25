// codex 공급망 핀 + 도구 잠김(L2) 계약 — 2026-08-25 code-mode host 사고의 재발 방지 앵커.
//  ① 조달은 핀 버전만(latest 금지) — 벤더 의미 변경의 무통보 유입 차단
//  ② codex와 형제 host 자산이 6트리플 전부 짝으로 존재
//  ③ 잠김 신호(실측 문구 3종) 인식 — 성공 턴 위장을 실패로 승격하는 근거
//  ④ lockupAction: 미재시도=재조달, 재시도 후=러너 교체(인증 실패와 같은 계열)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_PIN, codexAssetUrl, codexAssetNameFor, codexHostAssetNameFor, CODEX_LOCKUP_RE } from '../src/runners/codex.mjs';
import { lockupAction } from '../src/runners.mjs';

test('조달 URL은 핀 버전 — latest 금지(무통보 업스트림 변경 차단)', () => {
  assert.match(CODEX_PIN, /^rust-v\d+\.\d+\.\d+$/, 'CODEX_PIN은 릴리스 태그 형식');
  const url = codexAssetUrl('x.tar.gz');
  assert.ok(url.includes(`/releases/download/${CODEX_PIN}/`), url);
  assert.ok(!/latest/.test(url), 'latest가 되살아났다 — 핀 원칙 위반');
});

test('codex·host 자산 이름이 6트리플 전부 짝으로 존재(윈도우는 .exe.tar.gz)', () => {
  const cases = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'arm64'], ['win32', 'x64']];
  for (const [pf, arch] of cases) {
    const a = codexAssetNameFor(pf, arch), h = codexHostAssetNameFor(pf, arch);
    assert.ok(a && h, `${pf}-${arch} 자산 부재`);
    assert.ok(h.startsWith('codex-code-mode-host-'), h);
    if (pf === 'win32') { assert.ok(a.endsWith('.exe.tar.gz') && h.endsWith('.exe.tar.gz'), `${a} ${h}`); }
    else { assert.ok(!a.includes('.exe') && !h.includes('.exe'), `${a} ${h}`); }
  }
  assert.equal(codexAssetNameFor('sunos', 'x64'), null, '미지원 플랫폼은 null');
});

test('잠김 신호 — 0.149.1 실측 문구 3종은 잡고, 일반 오류·크루 출력은 안 잡는다', () => {
  for (const line of [
    'warning: Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
    'warning: Code Mode is unavailable because failed to spawn code-mode host /x/codex-code-mode-host: host executable was not found.',
    'Workspace code-mode host is disabled', // 사용자 제보 원문 형태
  ]) assert.ok(CODEX_LOCKUP_RE.test(line), line);
  for (const line of [
    'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    'command not found: foo',
    '사용자가 code review 모드를 비활성화했습니다', // 크루 답변에 섞일 법한 일반 문장
  ]) assert.ok(!CODEX_LOCKUP_RE.test(line), `오탐: ${line}`);
});

test('lockupAction — 마커 없으면 null, 미재시도면 재조달, 재조달 후에도면 교체', () => {
  assert.equal(lockupAction(new Error('x')), null);
  assert.equal(lockupAction(null), null);
  const locked = Object.assign(new Error('잠김'), { toolLockup: true });
  assert.equal(lockupAction(locked), 'reprovision-retry');
  assert.equal(lockupAction(locked, { retried: false }), 'reprovision-retry');
  assert.equal(lockupAction(locked, { retried: true }), 'switch');
});
