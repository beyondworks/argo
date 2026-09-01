// 엣지 펑션(supabase/functions/ls-webhook)의 test_mode 게이트 잠금.
//
// 왜 소스 구간 불변식인가: 이 파일은 Deno 런타임 전용(Deno.serve·Deno.env)이라 node 테스트가
// import할 수 없다. 그래서 "핸들러가 어떻게 동작하는가"를 못 부른다. 대신 **쓰기 이전에 게이트가
// 있다**는 구간 불변식을 건다 — 낱개 문자열 존재 단언은 배선을 못 지킨다는 반복 교훈(가드가
// upsert 뒤로 밀려도, 조건이 뒤집혀도 초록이 된다) 때문에, 위치·조건·환경 플래그를 함께 본다.
//
// 실사고 2026-09-01: 이 수신자에만 게이트가 없어 테스트 주문(LS 정산액 0)이 실 계정에 pro를
// 부여했다. 정본 계약은 src/lsbilling.mjs — test_mode는 기본 거부, 명시 opt-in에서만 수용.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'supabase/functions/ls-webhook/index.ts');

// 주석은 스캔의 fail-open 표면 — 주석에 test_mode를 적어두면 게이트를 지워도 초록이 된다.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => {
    const i = l.indexOf('//');
    return i === -1 ? l : l.slice(0, i);
  }).join('\n');

const code = stripComments(readFileSync(FN, 'utf8'));

test('엣지 수신자: test_mode 결제는 entitlements 쓰기 이전에 차단된다', () => {
  const gate = code.search(/attributes\?\.test_mode/);
  assert.notEqual(gate, -1, 'test_mode를 읽는 게이트가 없다 — 테스트 결제가 실 Pro를 부여한다');

  const write = code.search(/\.upsert\(/);
  assert.notEqual(write, -1, 'upsert 호출을 찾지 못했다 — 이 테스트의 기준점이 사라졌다');
  assert.ok(gate < write, '게이트가 쓰기보다 뒤에 있다 — 차단 전에 plan이 이미 갱신된다');
});

test('엣지 수신자: 게이트는 명시 opt-in에서만 열린다(기본 거부)', () => {
  // 정본과 같은 계약: test_mode가 참이고 허용 플래그가 '1'이 아니면 쓰기 없이 반환.
  const m = code.match(/if\s*\(\s*evt\?\.data\?\.attributes\?\.test_mode\s*&&([\s\S]{0,160}?)\)\s*\{([\s\S]{0,200}?)\}/);
  assert.ok(m, 'test_mode 게이트의 형태가 계약과 다르다(조건 && 허용플래그)');

  const [, cond, body] = m;
  assert.match(cond, /LS_ALLOW_TEST/, '허용 플래그(LS_ALLOW_TEST)를 보지 않는다 — 항상 열리거나 항상 닫힌다');
  assert.match(cond, /!==\s*'1'/, "기본 거부가 아니다 — 플래그 비교가 !== '1' 이어야 opt-in이 된다");
  assert.match(body, /return\s+new\s+Response/, '게이트가 반환하지 않는다 — 아래 쓰기로 계속 흐른다');
  assert.doesNotMatch(body, /upsert/, '게이트 본문이 쓰기를 한다 — 차단이 아니다');
});

test('엣지 수신자: 게이트가 재시도 폭주를 만들지 않는다(200 반환)', () => {
  const m = code.match(/attributes\?\.test_mode[\s\S]{0,200}?status:\s*(\d{3})/);
  assert.ok(m, '게이트 응답의 status를 찾지 못했다');
  assert.equal(m[1], '200', 'test_mode 차단은 200이어야 한다 — 4xx/5xx면 LS가 무한 재시도한다');
});
