// 길게 눌러 끌어 옮기기 — 드롭 위치 판정(순수). 실제 배선은 App.jsx(포인터 이벤트), 순서 재계산은 rail-state.mjs reorderFavorites 재사용.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropBeforeIdAtY } from '../src/drag-reorder.mjs';

const rows = [{ id: 'a', top: 0, height: 40 }, { id: 'b', top: 40, height: 40 }, { id: 'c', top: 80, height: 40 }];

test('dropBeforeIdAtY — y가 속한 행(중간선 기준) 앞에 넣는다는 뜻의 id, 마지막 행 아래면 null(맨 뒤)', () => {
  assert.equal(dropBeforeIdAtY(rows, 5), 'a', '첫 행 위쪽');
  assert.equal(dropBeforeIdAtY(rows, 19), 'a', 'a 중간선 전');
  assert.equal(dropBeforeIdAtY(rows, 21), 'b', 'a 중간선 지나면 b 앞');
  assert.equal(dropBeforeIdAtY(rows, 99), 'c', 'b 중간선도 지나면 c 앞'); // 79 -> b 넘음, 99 -> c 중간선(100) 전이라 c 앞
  assert.equal(dropBeforeIdAtY(rows, 101), null, 'c 중간선도 지나면 맨 뒤');
  assert.equal(dropBeforeIdAtY([], 10), null, '빈 목록은 맨 뒤');
});
