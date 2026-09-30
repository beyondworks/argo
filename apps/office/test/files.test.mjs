import test from 'node:test';
import assert from 'node:assert/strict';
import { fileKind } from '../src/core/files.js';

// 이유(유건 9/30): 산출물을 눌러도 안 열렸다 — 그림·문서는 그 자리에서 보이고, 나머지는 받기. 메신저 첨부의 mime이 비어 있는 경우가 많다(운영 21건) → 확장자로도 판단.
test('파일 종류: mime 먼저, 비어 있으면 확장자', () => {
  assert.equal(fileKind('a.png', 'image/png'), 'image');
  assert.equal(fileKind('사진.JPG', ''), 'image');
  assert.equal(fileKind('보고.md', null), 'md');
  assert.equal(fileKind('메모.txt', 'text/plain'), 'text');
  assert.equal(fileKind('data.csv', ''), 'text');
  assert.equal(fileKind('x.json', 'application/json'), 'text');
  assert.equal(fileKind('계약.pdf', 'application/pdf'), 'pdf');
  assert.equal(fileKind('표.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'other');
  assert.equal(fileKind('그림.svg', 'image/svg+xml'), 'other'); // svg는 스크립트를 품을 수 있어 받기만
});
