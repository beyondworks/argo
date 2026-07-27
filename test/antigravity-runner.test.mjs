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
import { RUNNERS, RUNNER_AUTH, isCliRunner, apiError } from '../src/runners.mjs';
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
  assert.deepEqual(PICK_ORDER, Object.keys(RUNNER_AUTH));
});

test('연결 UI — RUNNER_ORDER·RUNNER_NAMES에 antigravity가 있다', () => {
  const src = read('app/runner-connect.jsx');
  assert.match(src, /RUNNER_ORDER = \['claude', 'codex', 'gemini', 'antigravity', 'glm', 'kimi', 'openrouter'\]/);
  assert.match(src, /antigravity: 'Antigravity'/);
});

test('에러 매핑 — agy 무응답 타임아웃이 로그인 안내로 번역된다', () => {
  // agy 1.1.7 실측(2026-07-27): 미로그인 + -p(비대화)는 로그인 플로우를 못 열고
  // "Error: timeout waiting for response"(exit 1)로만 죽는다. 원문을 그대로 두면
  // 사용자는 자기 설정을 의심하며 시간을 태운다(P0-2와 같은 실패 모드).
  const e = Object.assign(new Error('cmd failed'), { stdout: 'Error: timeout waiting for response', stderr: '', code: 1 });
  const mapped = apiError(e);
  assert.match(mapped.message, /agy/, '로그인 처방(agy 실행)이 없다');
  assert.match(mapped.message, /제한 시간|timed out/i, '장시간 작업 초과 가능성도 함께 안내해야 한다(문구가 동일해 구분 불가)');
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
