// cmpVersion — 웹 업데이트 확인의 유일한 비교 함수. 여기서 어긋나면 '업데이트 있음'이
// 조용히 안 뜨거나(미탐) 최신인데 뜬다(오탐). 분리 검수가 지적한 v-접두 결함을 트립와이어로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersion } from '../src/version-compare.mjs';

test('기본 비교 — a<b는 -1, 같으면 0, a>b는 1', () => {
  assert.equal(cmpVersion('0.1.31', '0.1.32'), -1);
  assert.equal(cmpVersion('0.1.32', '0.1.32'), 0);
  assert.equal(cmpVersion('0.2.0', '0.1.99'), 1);
});

test('v 접두 허용 — 릴리스 태그 형태(v0.1.32)가 와도 숫자로 비교된다', () => {
  // 결함 재현: 접두 미제거면 parseInt('v0')=NaN→0이 되어 v1.x가 0.x로 취급됐다.
  assert.equal(cmpVersion('0.1.31', 'v0.1.32'), -1);
  assert.equal(cmpVersion('v1.0.0', '0.9.9'), 1);
  assert.equal(cmpVersion('V1.2.3', 'v1.2.3'), 0);
});

test('파트 수 불일치는 0 패딩 — 1.0 == 1.0.0, 1.0.1 > 1.0', () => {
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(cmpVersion('1.0.1', '1.0'), 1);
});

test('자릿수 비교는 숫자 기준 — 0.1.9 < 0.1.10 (문자열 비교였다면 역전)', () => {
  assert.equal(cmpVersion('0.1.9', '0.1.10'), -1);
});

test('깨진 입력은 0으로 취급 — null/빈 문자열/비숫자에서 예외 없이 동작', () => {
  assert.equal(cmpVersion(null, '0.0.1'), -1);
  assert.equal(cmpVersion('', ''), 0);
  assert.equal(cmpVersion('abc', '0.0.1'), -1);
});
