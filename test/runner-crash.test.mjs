// 러너 프로세스 크래시의 분류·복구 회귀 테스트.
//
// 실사용 신고 2026-08-02(Windows): "AI 호출이 실패했습니다 — 설정 → AI 연결에서 러너 연결 상태를
// 확인해 주세요. (Claude Code process exited with code 3221225477)". 사용자는 연결도 정상이고
// 크레딧도 남아 있어서 "러너 연결 정상인데 왜 계속 실패하죠?"라고 되물었다 — **안내가 거짓**이었다.
// 3221225477 = 0xC0000005(접근 위반)로, 연결·자격·크레딧과 무관한 프로세스 강제 종료다.
//
// 여기서 잠그는 계약:
//  ① 크래시 계열을 평범한 실패·인증 실패와 **구분**한다(구분이 없으면 복구 방법도 안내도 못 고른다).
//  ② 크래시와 인증 실패는 **서로 배타**다 — chat.mjs에서 크래시 분기가 인증 분기보다 앞에 있으므로,
//     인증 문구가 크래시로 오분류되면 죽은 자격으로 같은 러너를 다시 때리고 자가치유가 죽는다.
//  ③ 크래시엔 같은 러너 1회 재시도가 먼저(사용자가 고른 엔진·과금처를 조용히 바꾸지 않는다).
//  ④ 최종 안내에서 "연결을 확인하라"고 하지 않는다 — 그 문구가 이 신고의 본체다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isProcessCrash } from '../src/runners/shared.mjs';

// chat.mjs의 정본과 동일 — 배타성(②) 검증용.
const AUTH_ERR_RE = /not logged in|run \/login|invalid api key|invalid authentication|authentication[_ ]error|api[_ ]?key[_ ]?(?:not valid|invalid)|token (?:is )?(?:expired|revoked|invalid|incorrect)|\b401\b/i;

test('① 신고된 실제 문구를 크래시로 분류한다', () => {
  assert.ok(isProcessCrash('Claude Code process exited with code 3221225477'),
    '0xC0000005 접근 위반 — 이 신고를 못 잡으면 이 파일 전체가 무의미하다');
});

test('① Windows NTSTATUS 계열과 Unix 신호 종료를 크래시로 분류', () => {
  for (const m of [
    'process exited with code 3221225725',  // 0xC00000FD 스택 오버플로
    'process exited with code 3221226505',  // 0xC0000409 스택 버퍼 오버런
    'process exited with code 3221225781',  // 0xC0000135 DLL 없음
    'process exited with code 139',         // 128+SIGSEGV
    'process exited with code 134',         // 128+SIGABRT
    'child killed by SIGSEGV',
  ]) assert.ok(isProcessCrash(m), `크래시로 분류돼야 한다: ${m}`);
});

test('① 평범한 실패는 크래시가 아니다 — 아니면 모든 실패가 재시도로 2배 과금된다', () => {
  for (const m of [
    'process exited with code 1',
    'process exited with code 41',           // gemini GOOGLE_CLOUD_PROJECT 미설정
    'exit 2: usage error',
    'rate limit exceeded',
    'sdk-timeout: 120초 안에 응답이 끝나지 않아 중단했습니다',
    'empty-reply',
    '',
    null,
  ]) assert.equal(isProcessCrash(m), false, `크래시가 아니어야 한다: ${JSON.stringify(m)}`);
});

test('② 인증 실패와 배타 — 겹치면 죽은 자격으로 같은 러너를 다시 때린다', () => {
  for (const m of [
    'invalid api key',
    'API Error: 401 Unauthorized',
    'not logged in — run /login',
    'token is expired',
  ]) {
    assert.match(m, AUTH_ERR_RE, '전제: 이 문구들은 인증 실패다');
    assert.equal(isProcessCrash(m), false,
      `인증 문구가 크래시로 오분류되면 chat.mjs에서 크래시 분기가 먼저 물어 자가치유가 죽는다: ${m}`);
  }
  // 반대 방향 — 크래시 문구가 인증으로 읽히지도 않아야 한다(러너 교체가 헛돈다).
  assert.doesNotMatch('Claude Code process exited with code 3221225477', AUTH_ERR_RE);
});

test('① 숫자 경계 — 인접한 무관한 코드를 끌어오지 않는다', () => {
  assert.equal(isProcessCrash('process exited with code 3221225476'), false);
  assert.equal(isProcessCrash('process exited with code 32212254771'), false, '부분 일치 금지');
  assert.equal(isProcessCrash('process exited with code 13'), false, '139의 접두가 아니다');
});

// ── 배선 트립와이어 — 분류가 실제 복구·안내 경로에 걸려 있는지 잠근다(순수 함수 테스트로는 못 본다)
test('③ oneshot: 크래시 재시도가 러너 교체보다 **앞**에 온다', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  const crash = src.indexOf('isProcessCrash(e?.message)');
  const swap = src.indexOf('const tried = excludeWith(__exclude, runner);');
  assert.ok(crash > 0, 'oneshot 실패 경로에 크래시 분기가 있어야 한다');
  assert.ok(swap > 0 && crash < swap,
    '교체가 먼저 오면 첫 크래시에 사용자가 고른 엔진이 조용히 바뀌고 과금처도 달라진다');
  assert.match(src, /__crashRetry: true/, '재시도는 1회로 묶여야 한다(무한 재시도 금지)');
});

test('④ oneshot: 크래시 최종 안내는 "연결 확인"이 아니다 — 이 문구가 신고의 본체', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (isProcessCrash(e?.message)) {'));
  const ko = /비정상 종료됐습니다[\s\S]*?연결이나 크레딧 문제가 아닙니다/.exec(block);
  assert.ok(ko, '크래시 전용 안내가 있어야 하고, 연결·크레딧 문제가 아님을 명시해야 한다');
  assert.ok(!/연결 상태를 확인/.test(ko[0]), '"연결 상태를 확인" 안내를 크래시에 붙이면 안 된다');
  assert.match(block, /crashed on this computer/, '영어 병기(i18n 절대규칙)');
});

// 첫 판(2026-08-02)에 이 트립와이어를 indexOf(첫 등장) 비교로 썼다가 **SDK 갈래에 분기가 아예 없는
// 상태로 초록**이 나왔다. 신고된 경로가 바로 그 SDK 갈래였다. 실행 갈래가 둘이면 "어딘가에 있다"가
// 아니라 **갈래마다 있다**를 세야 한다.
test('③ chat: CLI·SDK **두 갈래 모두** 크래시를 잡고, 각자 인증 재시도보다 먼저 본다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const crashes = [...src.matchAll(/isProcessCrash\(e\?\.message \|\| e\)\) \{/g)].map((m) => m.index);
  // 조건은 골격이 바뀔 수 있다(2026-08-25 도구 잠김 OR 합류 — 승인된 확장은 runner-neutrality의
  // 발동 조건 목록이 잠근다). 여기서는 위치·개수만 본다: if 줄에 AUTH_ERR_RE가 있는 자가치유 갈래 2곳.
  // 2026-09-05 #432 HIGH-1: 발동 조건이 shouldSelfHeal(필드 우선) 한 곳으로 모였다 — if 줄의 호출부가 갈래 앵커
  const auths = [...src.matchAll(/if \([^\n]*shouldSelfHeal\(e, \{/g)].map((m) => m.index);
  assert.equal(auths.length, 2, '전제: 자가치유 갈래는 CLI·SDK 둘이다');
  assert.equal(crashes.length, 2, '크래시 재시도도 두 갈래 모두에 있어야 한다 — 한쪽만 고치면 신고된 경로가 그대로 남는다');
  for (const [i, a] of auths.entries()) {
    assert.ok(crashes[i] < a, `${i === 0 ? 'CLI' : 'SDK'} 갈래: 크래시 분기가 인증 분기보다 앞에 와야 한다`);
  }
  // 벤더 교체가 아니라 같은 러너 1회 — 크래시로 엔진이 조용히 바뀌면 과금처까지 달라진다.
  assert.equal((src.match(/__crashRetry: true/g) ?? []).length, 2, '갈래마다 1회 재시도 가드');
  assert.ok(!/isProcessCrash[\s\S]{0,400}?__excludeRunners: tried/.test(src),
    '크래시 분기가 러너를 갈아타면 안 된다(교체는 인증 실패 한정 정책)');
});

test('④ chat: 크래시 최종 문구를 두 갈래 모두 정직하게 바꾼다 — 원문만 던지면 사용자가 못 읽는다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/crashHint\(lang\)/g) ?? []).length, 2, 'CLI·SDK 두 실패 경로 모두');
});
