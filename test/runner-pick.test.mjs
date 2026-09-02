// 러너 선택·자가 치유 회귀 테스트 — 명시 연결 정본화(유건 지시 2026-07-19) 고정.
// 실사용 사고: ① 새 기기에서 호스트 Claude 흔적이 '연결중' 오표시 → 회사 생성 통과 → 키체인 접근
// 불가로 "Not logged in · Please run /login" 전 기능 사망 ② 크루 영입 Claude 하드코딩.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
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
  // gemini는 숨김(2026-09-03)이라 자동 선택 대상이 아니다 — 같은 성격(OAuth CLI 러너)인 codex로 재현
  const r = pickRunner(st({ codex: { hostInstalled: true, company: { connected: true, type: 'oauth' } } }), null);
  assert.equal(r.runner, 'codex');
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
  for (const id of ['codex']) { // gemini는 숨김(2026-09-03) — 자동 폴백 대상에서 빠져 이 시나리오의 대상이 아니다
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
    // 429(요청 한도)는 자가치유 대상이 **아니다** — oneshot.mjs가 코드로 금지하는 계약과 같다:
    // 일시적 한도인데 다른 벤더로 넘기면 사용자 고지 없이 실제 과금 키로 갈아탄다(기다리면 풀린다).
    // chat 쪽은 그 규칙이 산문 주석뿐이라, "429로 턴이 죽는데 페일오버가 안 된다"는 신고를 받은
    // 다음 사람이 이 정규식에 429를 넣는 자연스러운 수정을 아무것도 막지 못했다(3R 검수 실증: 넣어도
    // 전 테스트 초록). 술어(무엇이 인증 실패인가)를 여기서 잠근다 — 발동 조건 골격은 다른 곳에서.
    '턴 실패: error — API Error: 429 Rate limit exceeded', // OpenRouter 실측형
    'rate_limit_error: number of requests has exceeded your per-minute rate limit',
  ]) assert.ok(!AUTH_ERR_RE.test(s), `매칭되면 안 됨: ${s}`);
});
