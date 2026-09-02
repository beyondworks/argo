// Antigravity 러너(BYOA 2호) — 카탈로그·인증 방식·디스패치 배선 회귀 테스트.
//
// 배경: 구글이 개인용 Gemini Code Assist OAuth를 폐기하고 Antigravity로 이전(피드백 38e5281d 규명).
// Gemini 구독 사용자의 유일한 경로가 agy CLI라 codex/gemini와 같은 CLI 래핑으로 태운다.
// 자격은 OS 키링 — 파일 감지·붙여넣기·웹 브리지 전부 불가, 호스트 로그인 옵트인 전용.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNERS, RUNNER_AUTH, isCliRunner, apiError , isHiddenRunner} from '../src/runners.mjs';
import { PICK_ORDER } from '../app/runner-usable.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('카탈로그 — antigravity는 kind cli, 첫 모델은 게이트 없음', () => {
  const r = RUNNERS.antigravity;
  assert.ok(r, 'RUNNERS.antigravity가 없다');
  assert.equal(r.kind, 'cli');
  assert.equal(r.name, 'Antigravity');
  assert.ok(r.models.length >= 5, 'agy models 실측 목록이 비었다');
  assert.ok(!r.models[0].gated, 'models[0]은 러너 전환 기본값 — 게이트 모델을 앞에 두면 안 된다(gemini 카탈로그 관례)');
});

test('인증 방식 — 호스트 로그인 옵트인 전용(키링이라 붙여넣기·브리지 불가)', () => {
  const a = RUNNER_AUTH.antigravity;
  assert.deepEqual(a.methods, ['oauth']);
  assert.equal(a.oauthPasteable, false, '키링 자격은 붙여넣을 수 없다');
  assert.ok(a.hostUsable, '호스트 옵트인이 유일한 연결 경로다');
  assert.ok(!a.webConnect && !a.connect, '웹 브리지·CLI 로그인 대행은 키링 구조상 불가 — 생기면 설계 재검토');
});

test('디스패치 — isCliRunner가 카탈로그 kind 기준으로 판정한다', () => {
  assert.equal(isCliRunner('antigravity'), true);
  assert.equal(isCliRunner('codex'), true);
  assert.equal(isCliRunner('gemini'), true);
  assert.equal(isCliRunner('claude'), false);
  assert.equal(isCliRunner('openrouter'), false, 'sdk-compat은 SDK 경로');
  assert.equal(isCliRunner('없는러너'), false);
});

test('배선 — chat/oneshot이 하드코딩 열거 대신 isCliRunner를 쓴다', () => {
  // 'codex' || 'gemini' 하드코딩이 남으면 다음 CLI 러너 추가 때 배선 누락이 재발한다(#119 전수 수색 교훈).
  for (const f of ['src/chat.mjs', 'src/oneshot.mjs']) {
    const src = read(f);
    assert.ok(src.includes('isCliRunner(runner)'), `${f}가 isCliRunner를 쓰지 않는다`);
    assert.ok(!/runner === 'codex' \|\| runner === 'gemini'/.test(src),
      `${f}에 CLI 러너 하드코딩 열거가 남아 있다 — antigravity가 SDK 경로로 새서 죽는다`);
  }
});

test('자동 선택 순서 — PICK_ORDER는 RUNNER_AUTH 정의 순과 일치한다', () => {
  // pickRunner가 RUNNER_AUTH 정의 순이므로 어긋나면 "자동" 표시가 실제 실행 러너와 다르게 뜬다(주석 참조).
  // 숨김 러너(gemini, 2026-09-03)는 자동 선택 대상이 아니라 PICK_ORDER에서도 뺀다 — 가시 러너끼리 정의 순 일치
  assert.deepEqual(PICK_ORDER, Object.keys(RUNNER_AUTH).filter((id) => !isHiddenRunner(id)));
});

test('연결 UI — RUNNER_ORDER·RUNNER_NAMES에 antigravity가 있다', () => {
  // 목록 전체를 리터럴로 고정하던 단언이었다. 그건 **누락은 못 잡으면서 추가는 막는다** —
  // grok을 넣자 이 테스트가 red가 됐고(분리 검수 2026-08-03 C-1), 그동안 grok이 빠져 있어도
  // 초록이었다. 그래서 "이 러너가 들어 있나"만 본다. 전수 동기화는 runner-order-sync가 잠근다.
  const src = read('app/runner-connect.jsx');
  const order = src.match(/RUNNER_ORDER = \[([^\]]*)\]/)[1];
  assert.match(order, /'antigravity'/);
  assert.match(src, /antigravity: 'Antigravity'/);
});

test('에러 매핑 — agy 무응답 타임아웃이 로그인 안내로 번역된다(antigravity 한정)', () => {
  // agy 1.1.7 실측(2026-07-27): 미로그인 + -p(비대화)는 로그인 플로우를 못 열고
  // "Error: timeout waiting for response"(exit 1)로만 죽는다. 원문을 그대로 두면
  // 사용자는 자기 설정을 의심하며 시간을 태운다(P0-2와 같은 실패 모드).
  // 픽스처는 실측 형상(재검 N1: agy는 이 문구를 stderr로 낸다 — STDOUT 0바이트 실측)
  const e = Object.assign(new Error('cmd failed'), { stdout: '', stderr: 'Error: timeout waiting for response', code: 1 });
  const mapped = apiError(e, 'antigravity');
  assert.match(mapped.message, /agy/, '로그인 처방(agy 실행)이 없다');
  assert.match(mapped.message, /제한 시간|timed out/i, '장시간 작업 초과 가능성도 함께 안내해야 한다(문구가 동일해 구분 불가)');
  // AUTH_ERR_RE 계약(분리 검수 H1b) — 이 문구가 자가치유(다른 가용 러너 1회 폴백)를 발화시켜야
  // 미로그인 antigravity가 동작하는 러너 옆에서 무한 타임아웃을 반복하지 않는다.
  assert.match(mapped.message, /not logged in/i, 'AUTH_ERR_RE(chat.mjs)가 잡을 표현이 없다 — 자가치유 소실');
});

test('에러 매핑 — 같은 문구라도 다른 러너(stdout 오염)는 오분류하지 않는다(분리 검수 M1)', () => {
  // 크루가 셸로 실행한 명령 출력에 같은 문구가 섞인 codex 실패 — 벤더 원인(stderr)이 보존돼야
  // AUTH_ERR_RE 자가치유가 산다(2026-07-23 stdout 오염 원칙과 동일 클래스).
  const e = Object.assign(new Error('x'), {
    stdout: '$ curl …\ncurl: timeout waiting for response\n', stderr: '{"message":"invalid api key"}', code: 1,
  });
  const mapped = apiError(e, 'codex');
  assert.doesNotMatch(mapped.message, /Antigravity/, 'codex 실패가 Antigravity 문구로 오분류됐다');
  assert.match(mapped.message, /invalid api key/i, '벤더 원인이 지워졌다 — 자가치유(AUTH_ERR_RE) 소실');
});

test('자동 선택 선점 차단 — antigravity는 RUNNER_AUTH 맨 끝이다(분리 검수 H1a)', () => {
  // authed가 낙관값인 유일한 러너 — 검증된 자격(BYOK·파일)보다 앞이면 미로그인 antigravity가
  // 동작하는 러너를 선점해 러너 미지정 크루의 전 턴이 타임아웃으로 죽는다(검수 실증).
  const keys = Object.keys(RUNNER_AUTH);
  assert.equal(keys[keys.length - 1], 'antigravity');
});

test('샌드박스 fail-closed — caps 미전달이면 --sandbox가 켜진다(분리 검수 H2)', () => {
  // oneshot(영입·기억 정리)은 caps를 전달하지 않는다 — fail-open이면 그 경로만 터미널 무제한이 된다
  // (codex 상시 샌드박스·gemini 셸 상시 제외와 반대 방향). 배선을 소스로 잠근다.
  const src = read('src/runners.mjs');
  // caps → effCaps(readOnly면 전부 false로 눌러 셸도 닫힘 — readOnly 도입 2026-08-29). fail-closed 방향은 동일.
  assert.ok(src.includes("...(effCaps?.shell ? [] : ['--sandbox'])"),
    'antigravity --sandbox가 fail-closed가 아니다 — caps 미전달·readOnly 경로가 터미널 무제한이 된다');
});

test('에러 매핑 — gemini 개인 OAuth 중단 안내가 Antigravity 대안을 담는다', () => {
  const e = Object.assign(new Error('x'), { stdout: '', stderr: 'IneligibleTierError: ...', code: 1 });
  assert.match(apiError(e).message, /Antigravity/, 'Gemini 구독 사용자에게 대안 경로(Antigravity 러너)를 알려야 한다');
});

test('러너 열거 안내 문자열에 Antigravity가 빠지지 않았다(전수 수색 규칙)', () => {
  for (const f of ['src/chat.mjs', 'src/oneshot.mjs', 'src/trial.mjs', 'src/persona.mjs']) {
    const src = read(f);
    for (const m of src.matchAll(/Claude[·, ]+Codex[·, ]+Gemini[^)\n']*/g)) {
      assert.ok(m[0].includes('Antigravity'), `${f}의 러너 열거에 Antigravity 누락: "${m[0].slice(0, 80)}"`);
    }
  }
});

test('에러 매핑 — 진행 기록(stderr)에 섞인 "command not found"는 CLI 미발견이 아니다(제보 2026-08-22 "업데이트 후 CLI를 찾을 수 없음")', () => {
  // codex exec는 크루 셸 명령의 출력까지 stderr에 쓴다(실측: stdout 0B·stderr 4KB). 샌드박스 제거(0.1.43)
  // 뒤 셸이 전면 허용되자 이 문구가 흔해졌고, 턴이 한도 초과로 죽으면 원인이 'CLI 미발견'으로 덮였다.
  const transcript = '2026-08-22T05:21:50Z codex_core exec: $ pandoc --version\n/bin/sh: pandoc: command not found\n'.repeat(6)
    + '{"error":{"type":"usage_limit_reached","message":"You have hit your usage limit."}}';
  const e = Object.assign(new Error('x'), { stdout: '', stderr: transcript, code: 1 });
  const mapped = apiError(e, 'codex');
  assert.doesNotMatch(mapped.message, /CLI를 찾지 못했습니다|Runner CLI not found/, '진행 기록의 셸 실패가 CLI 미발견으로 오분류됐다');
  assert.match(mapped.message, /usage limit/i, '벤더 원인(한도)이 보존돼야 한다');
});

test('에러 매핑 — 진짜 스폰 실패(e.code ENOENT)와 짧은 셸 래퍼 실패는 여전히 CLI 미발견이다', () => {
  assert.match(apiError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }), 'codex').message, /CLI를 찾지 못했습니다/);
  assert.match(apiError(Object.assign(new Error('x'), { code: 127, stdout: '', stderr: '/bin/sh: gemini: command not found\n' }), 'gemini').message, /CLI를 찾지 못했습니다/);
});
