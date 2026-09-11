import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptFiles, withoutFile, storageKey } from '../src/attach-files.mjs';

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

test('storageKey: 한글·대괄호·공백은 ASCII 안전 문자로, 확장자 보존, 순번 접두(Storage "Invalid key" 실사고 2026-09-11)', () => {
  assert.equal(storageKey('[패스트캠퍼스 _ 265263] 혼자서 팀급 아웃풋! 김효율의 나만을 위한 일잘러 앱 만들기(with Claude Code) - [강사님] 상세 커리큘럼.csv', 0), '0-265263_with_Claude_Code_-.csv');
  assert.equal(storageKey('HFA-2026-CVVYQOUTFBGC.png', 1), '1-HFA-2026-CVVYQOUTFBGC.png');
  assert.equal(storageKey('스크린샷.PNG'), '0-file.PNG', '줄기가 전부 비ASCII면 file');
  assert.equal(storageKey('.env'), '0-env', '점으로 시작하는 이름은 확장자가 아니라 줄기');
  assert.match(storageKey('x'.repeat(200) + '.tar.gz', 3), /^3-x{60}\.gz$/, '줄기 60자·확장자는 마지막 것만');
  assert.doesNotMatch(storageKey('a b/c\\d.txt'), /[\s/\\]/);
});
