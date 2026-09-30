import test from 'node:test';
import assert from 'node:assert/strict';
import { cellsInBox, bulkRedact } from '../src/business/cell-pick.js';

// 표에서 끌어 고른 칸 — 시작 칸과 끝 칸이 만드는 사각형(유건 9/29, 노션처럼)
test('picked cells are the rectangle between the start and end cell, in any drag direction', () => {
  assert.deepEqual(cellsInBox([1, 2], [0, 1]), [[0, 1], [0, 2], [1, 1], [1, 2]]);
  assert.deepEqual(cellsInBox([3, 0], [3, 0]), [[3, 0]]);
});

// 한 번에 가리기·해제는 바뀌는 칸만 보낸다 — 이미 가린 칸을 다시 가리는 쓰기를 만들지 않는다(DB 위생)
test('bulk redact sends only the cells whose state changes', () => {
  const rows = [{ id: 'a', redacted: ['phone'] }, { id: 'b', redacted: [] }];
  const fields = ['manager', 'phone'];
  const cells = cellsInBox([0, 0], [1, 1]);
  assert.deepEqual(bulkRedact(rows, fields, cells, true), [
    { entity: 'customer', id: 'a', field: 'manager', on: true },
    { entity: 'customer', id: 'b', field: 'manager', on: true },
    { entity: 'customer', id: 'b', field: 'phone', on: true },
  ]);
  assert.deepEqual(bulkRedact(rows, fields, cells, false), [{ entity: 'customer', id: 'a', field: 'phone', on: false }]);
  assert.deepEqual(bulkRedact(rows, fields, [[5, 0]], true), []); // 없는 줄은 건너뛴다
});
