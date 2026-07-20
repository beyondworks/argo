// 러너 선택·자가 치유 회귀 테스트 — 명시 연결 정본화(유건 지시 2026-07-19) 고정.
// 실사용 사고: ① 새 기기에서 호스트 Claude 흔적이 '연결중' 오표시 → 회사 생성 통과 → 키체인 접근
// 불가로 "Not logged in · Please run /login" 전 기능 사망 ② 크루 영입 Claude 하드코딩.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-picktest-'));
const { pickRunner } = await import('../src/runners.mjs');
const { AUTH_ERR_RE } = await import('../src/chat.mjs');

// runnerStatus 응답 뼈대 — 테스트가 관심 필드만 덮어쓴다
const st = (over = {}) => {
  const base = (o = {}) => ({ hostInstalled: false, hostAuthed: false, company: { connected: false }, ...o });
  return { claude: base(over.claude), codex: base(over.codex), gemini: base(over.gemini), glm: base(over.glm) };
};

test('pickRunner: 호스트 로그인 감지만으론 절대 가용이 아니다 — 자동 스캐빈징 금지(실사고 재현)', () => {
  // 새 기기 재현: 호스트 Claude 로그인 감지(키체인이라 앱은 못 읽음), 명시 연결 0개
  const r = pickRunner(st({ claude: { hostAuthed: true }, codex: { hostInstalled: true, hostAuthed: true } }), 'claude');
  assert.equal(r.available, false, '감지는 안내일 뿐 — 명시 연결 없이는 어떤 러너도 실행하지 않는다');
});

test('pickRunner: host 타입(옵트인) 자격은 connected로 가용, 로그아웃되면 invalid로 불가용', () => {
  const linked = st({ codex: { hostInstalled: true, hostAuthed: true, company: { connected: true, type: 'host' } } });
  assert.equal(pickRunner(linked, 'claude').runner, 'codex', '옵트인한 호스트 로그인은 정식 연결');
  const loggedOut = st({ codex: { hostInstalled: true, hostAuthed: false, company: { connected: true, type: 'host', invalid: true } } });
  assert.equal(pickRunner(loggedOut, 'claude').available, false, 'CLI 로그아웃 → invalid → 재연결 안내로');
});

test('pickRunner: want=null(크루 러너 무선호) — 첫 연결 러너를 대체 고지 없이 쓴다(claude 하드코딩 제거)', () => {
  const r = pickRunner(st({ gemini: { hostInstalled: true, company: { connected: true, type: 'oauth' } } }), null);
  assert.equal(r.runner, 'gemini');
  assert.equal(r.fellBack, false, '무선호는 대체가 아니다 — 매 턴 대체 고지 소음 방지');
});

test('pickRunner: exclude — 인증 실패한 러너를 제외하고 다음 연결 러너로(자가 치유 재시도)', () => {
  const s = st({
    claude: { company: { connected: true, type: 'oauth' } }, // 연결돼 있지만 실제론 죽은 자격(만료 등)
    codex: { hostInstalled: true, company: { connected: true, type: 'host' } },
  });
  assert.equal(pickRunner(s, 'claude').runner, 'claude', '1차: 연결 자격은 신뢰하고 실행');
  const retry = pickRunner(s, 'claude', 'claude');
  assert.equal(retry.runner, 'codex', '재시도: 실패 러너 제외 → 다음 연결 러너');
  assert.equal(retry.fellBack, true, '지정 러너 대체는 크루가 사장에게 고지');
});

test('pickRunner: 무효(invalid) 자격 제외 + CLI 미설치는 차단 사유가 아니다(자동 조달)', () => {
  assert.equal(pickRunner(st({ codex: { hostInstalled: true, company: { connected: true, invalid: true } } }), 'claude').available, false);
  // 실사용 신고(2026-07-20) 재현: codex/gemini OAuth만 연결, 이 컴퓨터에 벤더 CLI 없음.
  // 예전엔 available:false + credButNoCli 안내 → 이제 턴 시점 자동 조달(provision*Cli)이 있어 가용이다.
  // "설정은 연결됨, 영입은 러너 없음" 모순의 본체 수정 — 게이트가 아니라 실행기가 따라온다.
  for (const id of ['codex', 'gemini']) {
    const r = pickRunner(st({ [id]: { hostInstalled: false, company: { connected: true, type: 'oauth' } } }), 'claude');
    assert.equal(r.available, true, `${id}: 자격 연결이면 CLI 미설치여도 가용`);
    assert.equal(r.runner, id);
  }
  const none = pickRunner(st(), 'claude');
  assert.equal(none.available, false);
  assert.deepEqual(none.credButNoCli, [], '조달 도입 후 항상 빈 배열(호환 유지 필드)');
});

test('AUTH_ERR_RE: 인증성 실패만 매칭 — 자가 치유 오발동 방지', () => {
  for (const s of [
    '턴 실패: error_during_execution — Not logged in · Please run /login', // 실사고 원문(Claude SDK)
    'Invalid API key · Please run /login',
    '401 invalid authentication credentials',
    'Not logged in, please run codex login', // codex CLI
    'OAuth token is expired',
    'API key not valid. Please pass a valid API key.', // gemini 무효 키(HTTP 400 — 실측 2026-07-20)
    '턴 실패: error — got status: 400 Bad Request. API_KEY_INVALID', // gemini
    '턴 실패: authenticate_error — token expired or incorrect', // glm 만료(HTTP 200 바디 401 — 실측)
  ]) assert.ok(AUTH_ERR_RE.test(s), `매칭돼야 함: ${s}`);
  for (const s of [
    '턴 실패: error_during_execution — MCP 서버 연결 실패',
    'network timeout after 300s',
    'HTTP 4011 custom code', // 401 단어 경계 확인
    'context token limit exceeded', // 'token' 오탐 방지 — expired/invalid/incorrect가 뒤따르지 않음
  ]) assert.ok(!AUTH_ERR_RE.test(s), `매칭되면 안 됨: ${s}`);
});
