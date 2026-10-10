import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptFiles, withoutFile, storageKey, chipSize } from '../src/attach-files.mjs';
import { fileView } from '../src/media-actions.mjs';

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

test('chipSize: 보내기 전 칩 크기 표기 — 1MB 이상이면 MB(20480KB 아님), 보낸 뒤 말풍선 카드(fileView)와 같은 글자', () => {
  assert.equal(chipSize({ name: 'big.zip', size: 20 * 1024 * 1024 }), '20 MB', '20MB 파일 — 예전엔 20480KB');
  assert.equal(chipSize({ name: 'a.csv', size: 1536 }), '1.5 KB');
  assert.equal(chipSize({ name: 'a.csv', size: 300 }), '300 B');
  for (const size of [300, 1536, 800 * 1024, 1024 * 1024, 20 * 1024 * 1024, 3 * 1024 ** 3]) {
    assert.equal(chipSize({ name: 'x.bin', size }), fileView({ name: 'x.bin', bytes: size }).size, `보내기 전·후 표기 일치 ${size}`);
  }
  assert.doesNotMatch(chipSize({ name: 'z', size: 20 * 1024 * 1024 }), /KB/);
});

test('보내기 전 칩은 chipSize로 그린다 — KB 직접 계산으로 되돌아가지 않는다', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /uploading === f\.name \? t\('att\.uploading'\) : chipSize\(f\)/);
  assert.doesNotMatch(app, /Math\.round\(f\.size \/ 1024\)/);
});
