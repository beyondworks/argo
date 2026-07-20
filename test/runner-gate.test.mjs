// 러너 게이트 회귀 테스트 — "codex·gemini 연결됨인데 회사 만들기 비활성" 실사용 신고(2026-07-19) 재발 방지.
// 게이트 판정(anyRunnerUsable)과 codex 샌드박스 능력 매핑(codexSandboxArgs)을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gatetest-'));
const { anyRunnerUsable, runnerNeedsReconnect } = await import('../app/runner-usable.mjs');
const { codexSandboxArgs } = await import('../src/runners.mjs');

test('anyRunnerUsable: codex/gemini 자격 연결이면 CLI 미감지여도 통과(실사고 재현)', () => {
  // 실사용 신고 상태 재현 — OAuth 웹 브리지로 자격 저장, hostInstalled=false(미설치 또는 GUI PATH 오탐)
  const reported = {
    claude: { hostAuthed: false, hostInstalled: true, company: { connected: false } },
    codex: { hostAuthed: false, hostInstalled: false, company: { connected: true, type: 'oauth' } },
    gemini: { hostAuthed: false, hostInstalled: false, company: { connected: true, type: 'oauth' } },
    glm: { hostAuthed: false, hostInstalled: true, company: { connected: false } },
  };
  assert.equal(anyRunnerUsable(reported), true, '자격 연결(유효)만으로 게이트 통과 — hostInstalled 요구 금지');
});

test('anyRunnerUsable: 무효 자격·호스트 감지 단독은 불통과, 옵트인(host)은 통과', () => {
  const invalidOnly = { codex: { hostAuthed: false, company: { connected: true, invalid: true } } };
  assert.equal(anyRunnerUsable(invalidOnly), false, '무효(재연결 필요) 자격은 가용이 아니다');
  // 명시 연결 정본화(2026-07-19): 호스트 로그인 감지 단독은 가용이 아니다 — 옵트인(host 타입)해야 연결.
  // (실사고: 새 기기에서 호스트 Claude 흔적이 '연결중' 오표시 → 키체인 접근 불가로 전 기능 사망)
  const hostOnly = { claude: { hostAuthed: true, company: { connected: false } } };
  assert.equal(anyRunnerUsable(hostOnly), false, '호스트 로그인 감지만으론 불가용 — 자동 스캐빈징 금지');
  const hostLinked = { codex: { hostAuthed: true, company: { connected: true, type: 'host' } } };
  assert.equal(anyRunnerUsable(hostLinked), true, '"이 컴퓨터 로그인 사용" 옵트인은 정식 연결');
  assert.equal(anyRunnerUsable({}), false, '빈 상태는 불통과');
  assert.equal(anyRunnerUsable(null), false, 'null 방어');
});

test('runnerNeedsReconnect: 무효 자격이 있으면 "끊김" 분기', () => {
  assert.equal(runnerNeedsReconnect({ codex: { company: { connected: true, invalid: true } } }), true);
  assert.equal(runnerNeedsReconnect({ codex: { company: { connected: true } } }), false);
  assert.equal(runnerNeedsReconnect({}), false);
});

test('codexSandboxArgs: 능력 → 샌드박스 매핑 고정(fs=밖 쓰기, browser=네트워크)', () => {
  assert.deepEqual(codexSandboxArgs(null), [], '능력 미전달 = 기존 workspace-write 그대로(회귀 없음)');
  assert.deepEqual(codexSandboxArgs({ fs: false, browser: false }), [], '전부 꺼짐 = 오버라이드 없음');
  assert.deepEqual(codexSandboxArgs({ fs: true }), ['-c', 'sandbox_workspace_write.writable_roots=["/"]'],
    'fs ON = 워크스페이스 밖 쓰기 허용(실사용 신고: 외부 자료 가져오기)');
  assert.deepEqual(codexSandboxArgs({ browser: true }), ['-c', 'sandbox_workspace_write.network_access=true'],
    'browser ON = 네트워크 허용');
  assert.deepEqual(codexSandboxArgs({ fs: true, browser: true }), [
    '-c', 'sandbox_workspace_write.writable_roots=["/"]',
    '-c', 'sandbox_workspace_write.network_access=true',
  ], '둘 다 ON = 두 오버라이드 모두');
});

test('usableRunnerNames: 연결(유효)만, pickRunner 순서(glm→kimi), 이름은 서버 name 필드', async () => {
  const { usableRunnerNames } = await import('../app/runner-usable.mjs');
  // 실사고(2026-07-20): 명판 'Claude Agent SDK' 하드코딩 — Gemini만 연결한 사용자가 "클로드로 도는 줄" 혼란
  assert.deepEqual(usableRunnerNames({
    gemini: { name: 'Gemini', company: { connected: true } },
    claude: { name: 'Claude Code', company: { connected: false } },
  }), ['Gemini'], 'Gemini만 연결 → Gemini만');
  assert.deepEqual(usableRunnerNames({
    kimi: { name: 'Kimi', company: { connected: true } },
    glm: { name: 'GLM', company: { connected: true } },
  }), ['GLM', 'Kimi'], '입력 순서 무관 pickRunner(RUNNER_AUTH) 순 — 자동 표시가 서버 선택과 일치');
  assert.deepEqual(usableRunnerNames({
    codex: { name: 'Codex', company: { connected: true, invalid: true } },
  }), [], '무효(재연결 필요) 자격은 엔진에 세지 않는다');
  assert.deepEqual(usableRunnerNames({}), []);
  assert.deepEqual(usableRunnerNames(null), []);
});
