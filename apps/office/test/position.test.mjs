// 페이지 순서 값(분수 인덱스) — 옮긴 페이지 하나만 저장하면 되도록 앞뒤 사이의 문자열을 만든다(형제들을 다시 쓰지 않는다: DB 위생).
import test from 'node:test';
import assert from 'node:assert/strict';
import { between } from '../src/core/position.js';

test('앞뒤 사이 값은 사전순으로 정확히 그 사이', () => {
  const cases = [[null, null], ['a', null], [null, 'a'], ['a', 'b'], ['a', 'a5'], ['az', 'b'], ['0i', '1'], ['m', 'n'], ['y', 'z']];
  for (const [a, b] of cases) {
    const k = between(a, b);
    if (a != null) assert.ok(k > a, `${k} > ${a}`);
    if (b != null) assert.ok(k < b, `${k} < ${b}`);
    assert.notEqual(k.at(-1), '0', '0으로 끝나지 않는다(그 앞에 끼울 자리가 없어진다)');
  }
});

// 이유: 같은 자리에 계속 끼워 넣어도(맨 앞에 반복 추가) 항상 순서가 지켜져야 한다.
test('같은 자리에 200번 끼워도 순서가 유지된다', () => {
  const keys = [between(null, null)];
  let lo = null;
  for (let i = 0; i < 200; i++) { const k = between(lo, keys[0]); keys.unshift(k); }
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  let hi = keys.at(-1);
  for (let i = 0; i < 200; i++) { const k = between(keys.at(-2), hi); keys.splice(keys.length - 1, 0, k); hi = keys.at(-1); }
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
  assert.equal(new Set(keys).size, keys.length);
});
