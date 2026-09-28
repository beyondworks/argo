// codex 공급망 핀 + 도구 잠김(L2) 계약 — 2026-08-25 code-mode host 사고의 재발 방지 앵커.
//  ① 조달은 핀 버전만(latest 금지) — 벤더 의미 변경의 무통보 유입 차단
//  ② codex와 형제 host 자산이 6트리플 전부 짝으로 존재
//  ③ 잠김 신호(실측 문구 3종) 인식 — 성공 턴 위장을 실패로 승격하는 근거
//  ④ lockupAction: 미재시도=재조달, 재시도 후=러너 교체(인증 실패와 같은 계열)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_PIN, codexAssetUrl, codexAssetNameFor, codexHostAssetNameFor, CODEX_LOCKUP_RE, codexOutdatedError } from '../src/runners/codex.mjs';
import { lockupAction } from '../src/runners.mjs';
import { RUNNERS } from '../src/runners/catalog.mjs';

test('조달 URL은 핀 버전 — latest 금지(무통보 업스트림 변경 차단)', () => {
  assert.match(CODEX_PIN, /^rust-v\d+\.\d+\.\d+$/, 'CODEX_PIN은 릴리스 태그 형식');
  const url = codexAssetUrl('x.tar.gz');
  assert.ok(url.includes(`/releases/download/${CODEX_PIN}/`), url);
  assert.ok(!/latest/.test(url), 'latest가 되살아났다 — 핀 원칙 위반');
});

// 2026-09-28 실사고: GPT-6 Astra·Sol·Luna를 목록에 넣으며 PC에 설치된 최신 codex로만 응답을 확인했다. Argo는 핀 버전(0.149.1)으로
// 실행해 세 모델 모두 400("ChatGPT 계정에서 지원 안 함"·"더 새 버전 필요")으로 전멸했다. 0.157.1이 세 모델의 실제 턴·셸 도구·MCP 호출을 통과한 첫 핀이다.
test('GPT-6 계열이 Codex 모델 목록에 있으면 핀은 0.157.1 이상 — 핀이 못 돌리는 모델을 목록에 싣지 않는다', () => {
  const ver = CODEX_PIN.replace(/^rust-v/, '').split('.').map(Number);
  const atLeast = (min) => { for (let i = 0; i < 3; i++) { if (ver[i] !== min[i]) return ver[i] > min[i]; } return true; };
  const gpt6 = RUNNERS.codex.models.map((m) => m.id).filter((id) => /^gpt-6-/.test(id));
  if (gpt6.length) assert.ok(atLeast([0, 157, 1]), `핀 ${CODEX_PIN}으로는 ${gpt6.join(', ')} 턴이 400으로 실패한다`);
});

// 승격 실패(오프라인·스로틀)로 낡은 관리본에 머문 PC에서 GPT-6을 고르면 벤더 영어 원문만 떴다(분리 검수 #744 L1, 유건 지시로 ko/en 안내).
test('codexOutdatedError — "newer version" 거절은 항상, "ChatGPT 계정 미지원" 거절은 핀이 낡았을 때만 업데이트 대기 안내로 바꾼다', () => {
  const newer = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
  const acct = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.";
  for (const [msg, stale, want] of [[newer, false, true], [newer, true, true], [acct, true, true], [acct, false, false], ['Incorrect API key provided', true, false], ['', true, false]]) {
    const e = codexOutdatedError(msg, stale);
    assert.equal(!!e, want, `${msg.slice(0, 40)} stale=${stale}`);
    if (e) {
      assert.match(e.message, /Codex 실행기 업데이트가 아직 끝나지 않아/);
      assert.match(e.message, /Codex runner update is not finished/);
      assert.ok(e.message.includes(msg), '원문 보존(진단용)');
    }
  }
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

test('잠김 신호 — 벤더 경고 줄(줄머리 warning:)만 잡고, 인용·제보 문구·일반 오류는 안 잡는다', () => {
  for (const line of [
    'warning: Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
    'warning: Code Mode is unavailable because failed to spawn code-mode host /x/codex-code-mode-host: host executable was not found. Code mode will fail closed.',
    'x\nwarning: Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed.\ny', // 여러 줄 stderr 중간(m 플래그)
  ]) assert.ok(CODEX_LOCKUP_RE.test(line), line);
  for (const line of [
    "왜 'warning: Code Mode is unavailable because code-mode host is disabled' 라고 뜨나요?", // 사용자 인용 — codex가 stderr에 에코(분리 검수 오탐 실증)
    'Workspace code-mode host is disabled', // 제보 채팅 문구 — stderr 벤더 줄이 아니다
    'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    'command not found: foo',
    '사용자가 code review 모드를 비활성화했습니다',
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
