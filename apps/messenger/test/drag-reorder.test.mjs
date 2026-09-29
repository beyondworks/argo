// 길게 눌러 끌어 옮기기 — 드롭 위치 판정(순수). 실제 배선은 App.jsx(포인터 이벤트), 순서 재계산은 rail-state.mjs reorderFavorites 재사용.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropBeforeIdAtY, reorderVisibleInFull } from '../src/drag-reorder.mjs';

const rows = [{ id: 'a', top: 0, height: 40 }, { id: 'b', top: 40, height: 40 }, { id: 'c', top: 80, height: 40 }];

test('dropBeforeIdAtY — y가 속한 행(중간선 기준) 앞에 넣는다는 뜻의 id, 마지막 행 아래면 null(맨 뒤)', () => {
  assert.equal(dropBeforeIdAtY(rows, 5), 'a', '첫 행 위쪽');
  assert.equal(dropBeforeIdAtY(rows, 19), 'a', 'a 중간선 전');
  assert.equal(dropBeforeIdAtY(rows, 21), 'b', 'a 중간선 지나면 b 앞');
  assert.equal(dropBeforeIdAtY(rows, 99), 'c', 'b 중간선도 지나면 c 앞'); // 79 -> b 넘음, 99 -> c 중간선(100) 전이라 c 앞
  assert.equal(dropBeforeIdAtY(rows, 101), null, 'c 중간선도 지나면 맨 뒤');
  assert.equal(dropBeforeIdAtY([], 10), null, '빈 목록은 맨 뒤');
});

// 걸러 보이는 목록(안읽음·그룹)이나 접힌 묶음에서 끌어도 전체 순서가 섞이지 않게(유건 2026-09-29 "어디든 꾹 눌러 원하는 위치로" — 검수 MEDIUM-1: 부분 목록을 0..k로 매기면 전체가 섞였다)
test('reorderVisibleInFull — 보이는 행 사이에 놓으면 전체 순서에서도 그 자리, 보이지 않는 항목의 상대 순서는 그대로', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(reorderVisibleInFull(full, ['b', 'd', 'e'], 'e', 'b'), ['a', 'e', 'b', 'c', 'd'], 'e를 b 앞으로');
  assert.deepEqual(reorderVisibleInFull(full, ['a', 'c'], 'a', null), ['b', 'c', 'a', 'd', 'e'], '보이는 마지막(c) 바로 뒤 — 전체 맨 뒤가 아니다');
  assert.deepEqual(reorderVisibleInFull(full, full, 'b', null), ['a', 'c', 'd', 'e', 'b'], '다 보이면 맨 뒤');
  assert.deepEqual(reorderVisibleInFull(full, ['c', 'e'], 'e', null), full, '이미 보이는 마지막이면 그대로');
});
