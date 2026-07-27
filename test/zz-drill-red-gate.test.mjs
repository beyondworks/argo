// red-차단 드릴 전용 — 게이트가 실패를 실제로 막는지 실증하기 위한 일부러 깨지는 테스트.
// 이 PR은 머지하지 않는다(드릴 확인 후 닫고 브랜치 삭제).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('드릴: 이 테스트는 일부러 실패한다 — CI가 red로 차단해야 게이트 성립', () => {
  assert.equal(1, 2, '게이트 드릴 — 이 실패가 PR 체크를 red로 만들면 성공');
});
