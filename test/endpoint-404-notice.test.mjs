// 엔드포인트 404 → "선택한 모델 문제" 오역 대응 (실사용 제보 2026-09-05: OpenRouter 잔액 있음·모델 무관·VPS)
//
// 실측 근거(로컬 스텁으로 상태코드별 대조, @anthropic-ai/claude-agent-sdk 0.3.258 / CLI 2.1.x):
//   404(본문 무엇이든) → `There's an issue with the selected model (<id>). It may not exist or you may not have access to it.`
//   400              → `API Error: 400 <원문>`  ← 원문이 그대로 나온다
// 즉 이 문구는 **404 전용 신호**이고 모델과 무관하다. 모델을 바꿔도 같은 문구가 반복되므로,
// 안내 없이는 사용자가 "모델이 없다"를 믿고 모델만 바꾸며 시간을 버린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { endpointNotFoundNotice, isEndpointNotFoundMsg } from '../src/runners.mjs';

// 사용자가 실제로 받은 두 줄(제보 원문, 모델만 다르다)
const REPORTED = [
  "There's an issue with the selected model (qwen/qwen3.7-max). It may not exist or you may not have access to it.",
  "There's an issue with the selected model (z-ai/glm-5.3). It may not exist or you may not have access to it.",
];

test('isEndpointNotFoundMsg: 제보 원문 두 건을 잡는다 — 모델 id와 무관', () => {
  for (const m of REPORTED) assert.equal(isEndpointNotFoundMsg(m), true, m);
  assert.equal(isEndpointNotFoundMsg(`턴 실패: ${REPORTED[0]}`), true, '표면이 접두를 붙여도 잡는다');
  assert.equal(isEndpointNotFoundMsg("There’s an issue with the selected model (x/y)."), true, '타이포그래피 아포스트로피 변형');
});

test('isEndpointNotFoundMsg: 다른 실패는 잡지 않는다 — 400 원문·인증·빈 값', () => {
  assert.equal(isEndpointNotFoundMsg('API Error: 400 Deferred custom tools are only supported on Anthropic models'), false, '400은 원문 경로');
  assert.equal(isEndpointNotFoundMsg('API Error: 402 This request requires more credits'), false);
  assert.equal(isEndpointNotFoundMsg('Failed to authenticate.'), false);
  // 근접 문자열 — 매처를 "There's an issue"까지로 넓히면 SDK의 다른 오류에 404 안내가 붙는다(검수 MEDIUM-4 변이 실증)
  assert.equal(isEndpointNotFoundMsg("There's an issue with your request. Please try again."), false, '요청 일반 오류');
  assert.equal(isEndpointNotFoundMsg("There's an issue with the selected tool (Bash)."), false, '도구 오류');
  assert.equal(isEndpointNotFoundMsg("There's an issue with the configured advisor model"), false, 'advisor 모델 오류');
  assert.equal(isEndpointNotFoundMsg('The model claude-x is not available on your deployment.'), false, '배포 미지원(별도 문구)');
  assert.equal(isEndpointNotFoundMsg(''), false);
  assert.equal(isEndpointNotFoundMsg(null), false);
});

test('endpointNotFoundNotice(openrouter): 404임을 밝히고 확인 순서 3종 — 데이터 정책·base URL·프록시', () => {
  const ko = endpointNotFoundNotice('ko', 'openrouter');
  assert.ok(ko.includes('404'), '원인을 404로 명시');
  assert.ok(ko.includes('원인이 모델이 아닌 경우가 많습니다'), '원인을 단정하지 않는다 — 벤더가 모델을 내려도 404다(검수 MEDIUM-2)');
  assert.ok(!ko.includes('모델을 바꿔도 같은 문구가 나옵니다'), '"바꿔도 소용없다"는 단정 금지 — 모델이 실제로 내려간 사용자를 반대로 몬다');
  assert.ok(ko.includes('④') && ko.includes('다른 모델로 한 번만 시험'), '모델 회수 가능성을 후보 ④로 제시');
  assert.ok(ko.includes('openrouter.ai/settings/privacy'), '데이터 정책 확인처');
  assert.ok(ko.includes('OPENROUTER_BASE_URL') && ko.includes('https://openrouter.ai/api'), '셀프호스트 base URL 정본');
  assert.ok(ko.includes('프록시') || ko.includes('방화벽'), '서버 아웃바운드 확인');
  const en = endpointNotFoundNotice('en', 'openrouter');
  assert.ok(en.includes('404') && en.includes('openrouter.ai/settings/privacy') && en.includes('OPENROUTER_BASE_URL'));
  assert.ok(!/[가-힣]/.test(en), '영어 모드에 한국어 미노출(i18n 절대규칙)');
});

test('endpointNotFoundNotice: 다른 러너는 러너 이름 + 일반 안내(러너 중립성 — OpenRouter 링크를 남에게 주지 않는다)', () => {
  // 두 언어를 함께 본다 — 한쪽만 검사하면 반대 갈래에 링크가 새로 들어가도 초록이다(변이 M6 실증)
  for (const runner of ['glm', 'kimi', 'grok']) {
    for (const lang of ['ko', 'en']) {
      const msg = endpointNotFoundNotice(lang, runner);
      assert.ok(!msg.includes('openrouter.ai'), `남의 러너(${runner}/${lang})에 OpenRouter 안내 금지 — 러너 중립성`);
      assert.ok(!msg.includes('OPENROUTER_BASE_URL'), `남의 러너(${runner}/${lang})에 OpenRouter env 금지`);
      assert.ok(msg.includes('404'), `${runner}/${lang}: 원인을 404로 명시`);
    }
  }
  const ko = endpointNotFoundNotice('ko', 'glm');
  assert.ok(ko.includes('GLM'), '러너 이름');
  const en = endpointNotFoundNotice('en', 'glm');
  assert.ok(en.includes('GLM'), '러너 이름(en)');
  assert.ok(!/[가-힣]/.test(en));
  assert.ok(endpointNotFoundNotice('ko', 'unknown-x').includes('unknown-x'), '미등록 러너는 id 그대로');
});

// ── 배선 구간 불변식 — chat.mjs가 실제로 소비하는가(원문 보존 + 안내 덧붙임) ──
// 함수 핀이 아니라 구간 불변식으로 잠근다(argo-graph-empty-sky 교훈: JSX·거대 함수는 구간으로만).
test('chat.mjs 배선: 404 문구면 원문을 남기고 안내를 덧붙인다 — surfaced 삼항의 첫 갈래', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('const surfaced = ');
  assert.ok(i > 0, 'surfaced 선언 존재');
  const seg = src.slice(i, src.indexOf('throw aborted ?', i));
  assert.ok(/^const surfaced = \(isEndpointNotFoundMsg\(eMsg\) && !e\?\.endpointNotFound\)\s*\n\s*\? Object\.assign\(new Error\(`\$\{eMsg\.slice\(0, 300\)\}/.test(seg),
    '첫 갈래가 404 판정이고 원문(eMsg)을 보존한다 — 안내로 대체하면 벤더 상세가 사라진다(정직 오류 원칙)');
  assert.ok(seg.includes('${endpointNotFoundNotice(lang, runner)}'), '사용자 언어·러너로 안내를 붙인다');
  assert.ok(seg.includes('endpointNotFound: true'), '표면이 종류를 구분할 수 있게 표식');
  assert.ok(seg.indexOf('isEndpointNotFoundMsg') < seg.indexOf('isGrokCreditError'), '뒤 갈래가 이 문구를 먼저 삼키지 않는다');
});

// ── oneshot 패리티 — 온보딩·영입·루틴·기억정리가 같은 안내를 받는가(검수 MEDIUM-3) ──
test('oneshot.mjs 배선: 최종 실패 직전에 404 안내를 덧붙인다 — 러너별 원문 대장은 보존', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('if (isEndpointNotFoundMsg(e?.message))');
  assert.ok(i > 0, 'oneshot에도 404 분기가 있다');
  const seg = src.slice(i, i + 400);
  assert.ok(seg.includes('formatOneShotFailure(__failures, runner, e, lang)'), '러너별 원인 대장을 그대로 싣는다');
  assert.ok(seg.includes('${endpointNotFoundNotice(lang, runner)}'), '사용자 언어·러너로 안내를 붙인다');
  assert.ok(seg.includes('endpointNotFound: true'), '표식');
  assert.ok(i < src.indexOf('throw Object.assign(new Error(formatOneShotFailure(__failures, runner, e, lang)), { cause: e });'), '무조건 throw보다 앞');
});

// ── 재부착 방지 — 재시도 프레임이 안내를 두 번 붙이면 원문이 중간에서 잘린다(검수 MEDIUM-1 라이브 재현) ──
test('chat.mjs 배선: 이미 안내가 붙은 오류(endpointNotFound)는 다시 감싸지 않는다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('const surfaced = ');
  const seg = src.slice(i, src.indexOf('throw aborted ?', i));
  assert.ok(/isEndpointNotFoundMsg\(eMsg\)\s*&&\s*!e\?\.endpointNotFound/.test(seg),
    '재부착 가드 — 아래 인증 갈래의 !e?.authError와 같은 계약');
});
