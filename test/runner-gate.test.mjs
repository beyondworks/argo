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
const { codexSandboxArgs, codexSandboxModeArgs } = await import('../src/runners.mjs');

test('codexSandboxModeArgs: 윈도우=샌드박스 우회, 그 외=workspace-write (읽기전용 쓰기 전멸 신고 2026-08-03~05)', () => {
  // 윈도우 codex는 OS 샌드박스 기전이 없어 workspace-write가 read-only로 떨어진다(openai/codex#6374).
  // 전권 원칙(capabilities.mjs)에 따라 윈도우만 우회 — 맥·리눅스는 seatbelt/Landlock이 실제로 지켜
  // "앱 본체 보호"가 여기 걸려 있으므로 절대 우회로 바꾸지 않는다(2026-07-22 writable_roots="/" 크리티컬 계열).
  assert.deepEqual(codexSandboxModeArgs('win32'), ['--dangerously-bypass-approvals-and-sandbox'],
    '윈도우 = 우회(샌드박스가 쓰기 전멸을 만들던 자리)');
  assert.deepEqual(codexSandboxModeArgs('darwin'), ['--sandbox', 'workspace-write'], '맥 = 기존 유지');
  assert.deepEqual(codexSandboxModeArgs('linux'), ['--sandbox', 'workspace-write'], '리눅스 = 기존 유지');
  // 현재 플랫폼 기본값 = 위 둘 중 하나와 정확히 일치(주입 없는 실호출 경로 잠금)
  assert.deepEqual(codexSandboxModeArgs(),
    codexSandboxModeArgs(process.platform), '기본 인자 = process.platform');
});

test('codexSandboxModeArgs 배선: externalExec가 하드코딩 --sandbox가 아니라 이 함수를 지난다', async () => {
  // 순수 함수만 잠그면 호출부가 '--sandbox workspace-write' 하드코딩으로 롤백돼도 초록이다 —
  // facade의 externalExec 앵커 테스트와 같은 패턴으로 배선 자체를 잠근다.
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  const codexBlock = src.split("if (runner === 'codex')")[1]?.split("if (runner === 'gemini')")[0] ?? '';
  assert.ok(codexBlock.includes('...codexSandboxModeArgs()'), 'codex exec 인자에 codexSandboxModeArgs 배선');
  assert.ok(!codexBlock.includes("'--sandbox', 'workspace-write'"), 'codex 블록에 하드코딩 샌드박스 인자 잔존 금지');
});

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

test('codexSandboxArgs: 능력 → 샌드박스 매핑 고정(fs=홈 한정 쓰기, browser=네트워크)', async () => {
  const { homedir } = await import('node:os');
  // 제품과 같은 JSON.stringify 이스케이프 — Windows 홈(C:\Users\…)은 생 보간과 어긋난다(백슬래시)
  const HOME_ROOT = `sandbox_workspace_write.writable_roots=[${JSON.stringify(homedir())}]`;
  assert.deepEqual(codexSandboxArgs(null), [], '능력 미전달 = 기존 workspace-write 그대로(회귀 없음)');
  assert.deepEqual(codexSandboxArgs({ fs: false, browser: false }), [], '전부 꺼짐 = 오버라이드 없음');
  // fs ON = 홈 디렉토리 한정 — "/"(루트 전체)는 /Applications의 앱 본체까지 열었다(크리티컬 2026-07-22)
  assert.deepEqual(codexSandboxArgs({ fs: true }), ['-c', HOME_ROOT],
    'fs ON = 사용자 문서 접근은 유지하되 앱 본체(/Applications)는 샌드박스 밖');
  assert.deepEqual(codexSandboxArgs({ browser: true }), ['-c', 'sandbox_workspace_write.network_access=true'],
    'browser ON = 네트워크 허용');
  assert.deepEqual(codexSandboxArgs({ fs: true, browser: true }), [
    '-c', HOME_ROOT,
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

/* ── 격리 홈 env — 플랫폼별 변수(실사용 신고 2026-07-26: Windows gemini exit 41) ── */
test('homeEnv: Windows는 USERPROFILE까지 준다 — HOME만 주면 CLI가 진짜 홈을 읽는다', async () => {
  const { homeEnv } = await import('../src/runners.mjs');
  assert.deepEqual(homeEnv('/Users/x/.argo/gemini-home-ws', 'darwin'), { HOME: '/Users/x/.argo/gemini-home-ws' });
  const win = homeEnv('C:\\Users\\kim\\.argo\\gemini-home-ws', 'win32');
  assert.equal(win.USERPROFILE, 'C:\\Users\\kim\\.argo\\gemini-home-ws');
  assert.equal(win.HOME, win.USERPROFILE, '두 변수가 같은 곳을 가리켜야 도구별 분기가 없다');
  assert.equal(win.HOMEDRIVE, 'C:');
  assert.equal(win.HOMEPATH, '\\Users\\kim\\.argo\\gemini-home-ws');
});

/* ── 전권 기본값 — 유건 지시 2026-07-30(능력 토글 제거) ── */
test('capabilities: 설치 시점부터 전권 — 크루가 능력 부족으로 막히지 않는다', async () => {
  const { CAPABILITIES } = await import('../src/capabilities.mjs');
  assert.ok(CAPABILITIES.fs && CAPABILITIES.shell && CAPABILITIES.browser && CAPABILITIES.bypass);
});

/* ── 추론 강도: codex도 지원(실측 2026-07-26 codex-cli 0.144.1) ── */
test('codexEffortArgs: 지원 값은 -c 인자로, max는 xhigh로 사상, 빈/미지원은 무인자', async () => {
  const { codexEffortArgs } = await import('../src/runners.mjs');
  assert.deepEqual(codexEffortArgs('low'), ['-c', 'model_reasoning_effort=low']);
  assert.deepEqual(codexEffortArgs('xhigh'), ['-c', 'model_reasoning_effort=xhigh']);
  assert.deepEqual(codexEffortArgs('max'), ['-c', 'model_reasoning_effort=xhigh'], 'max는 Claude 전용 명칭');
  assert.deepEqual(codexEffortArgs(''), [], '미설정이면 모델 기본');
  assert.deepEqual(codexEffortArgs('bogus'), [], '미지원 값은 조용히 무시(턴을 깨뜨리지 않는다)');
});
