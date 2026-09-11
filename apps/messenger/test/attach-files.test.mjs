import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptFiles, withoutFile } from '../src/attach-files.mjs';

const f = (name, size) => ({ name, size });

test('acceptFiles: 상한 초과는 거절 목록으로, 같은 이름+크기는 한 번만, 기존 목록에 누적(드롭·선택창 공용)', () => {
  const r = acceptFiles([f('a.csv', 10)], [f('b.png', 20), f('a.csv', 10), f('big.zip', 100), f('b.png', 20)], 50);
  assert.deepEqual(r.files.map((x) => x.name), ['a.csv', 'b.png']);
  assert.deepEqual(r.rejected.map((x) => x.name), ['big.zip']);
  assert.deepEqual(acceptFiles([], null, 50), { files: [], rejected: [] }, '빈 입력');
  assert.deepEqual(acceptFiles([], [{ name: 'x' }], 50).files, [], 'size 없는 항목(드롭된 텍스트 등)은 무시');
});

test('withoutFile: 같은 이름이 둘이어도 고른 객체 하나만 뺀다', () => {
  const a = f('a.csv', 10), b = f('a.csv', 11);
  assert.deepEqual(withoutFile([a, b], a), [b]);
});
