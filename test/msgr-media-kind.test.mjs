// 첨부 표시 규칙(2026-10-02) — 사람이 올린 파일과 에이전트(게이트웨이·봇)가 보낸 파일이 같은 말풍선으로 보이게.
// 원인 기록: 앱은 mime 앞부분(image/)만 보고 이미지를 골랐고, 게이트웨이는 png·jpg·webp·gif 네 가지에만 mime을 붙였다
// (운영 집계 2026-10-02: 크루 첨부 21건 전부 mime 빈 값). mime이 비었거나 octet-stream이면 확장자로 정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeOf, isImage, fileExt, middleEllipsis, fileKind, formatBytes, gridRows } from '../src/media-kind.mjs';

test('mimeOf — 구체적인 mime은 그대로, 빈 값·octet-stream이면 확장자로', () => {
  assert.equal(mimeOf('a.png', 'image/png'), 'image/png');
  assert.equal(mimeOf('a.PNG', ''), 'image/png');
  assert.equal(mimeOf('photo.JPG', null), 'image/jpeg');
  assert.equal(mimeOf('photo.jpeg', 'application/octet-stream'), 'image/jpeg');
  assert.equal(mimeOf('IMG_0001.HEIC', 'binary/octet-stream'), 'image/heic');
  assert.equal(mimeOf('r.pdf', ''), 'application/pdf');
  assert.equal(mimeOf('notes.md', ''), 'text/markdown');
  assert.equal(mimeOf('data.xlsx', ''), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mimeOf('x', ''), 'application/octet-stream');
  assert.equal(mimeOf('a.txt', 'text/plain'), 'text/plain');
  assert.equal(mimeOf('a.png', 'IMAGE/PNG; charset=binary'), 'image/png');
});

test('isImage — 말풍선 썸네일로 그릴 수 있는 그림만(mime 기준, 비었으면 확장자)', () => {
  for (const a of [{ name: 'a.png', mime: 'image/png' }, { name: 'a.jpg', mime: '' }, { name: 'a.webp' }, { name: 'a.gif', mime: 'application/octet-stream' }, { name: 'a.heic', mime: 'image/heic' }, { name: 'x', mime: 'image/jpeg' }, { name: 'a.avif' }])
    assert.equal(isImage(a), true, JSON.stringify(a));
  for (const a of [{ name: 'a.pdf', mime: 'application/pdf' }, { name: 'a.md', mime: '' }, { name: 'a.png', mime: 'text/plain' }, { name: 'a.tiff', mime: 'image/tiff' }, { name: 'a.psd', mime: 'image/vnd.adobe.photoshop' }, {}, null])
    assert.equal(isImage(a), false, JSON.stringify(a));
});

test('fileExt — 마지막 점 뒤(소문자), 점으로 시작하는 이름·확장자 없음은 빈 값', () => {
  assert.equal(fileExt('보고서 최종.PDF'), 'pdf');
  assert.equal(fileExt('archive.tar.gz'), 'gz');
  assert.equal(fileExt('.env'), '');
  assert.equal(fileExt('README'), '');
  assert.equal(fileExt('a.'), '');
});

test('middleEllipsis — 긴 이름은 가운데를 줄이고 확장자는 남긴다(한글도 글자 단위)', () => {
  assert.equal(middleEllipsis('short.pdf', 20), 'short.pdf');
  const long = '2026년 3분기 아르고 메신저 사용자 인터뷰 정리본 최종 수정.docx';
  const out = middleEllipsis(long, 24);
  assert.equal(Array.from(out).length, 24);
  assert.ok(out.endsWith('.docx'), out);
  assert.ok(out.includes('…'));
  assert.ok(out.startsWith('2026년'), out);
  assert.equal(middleEllipsis('averyveryverylongnamewithoutextension', 12).length, 12);
  assert.ok(middleEllipsis('a.verylongextensionname', 10).length <= 10, '확장자가 너무 길면 확장자도 줄인다');
  assert.equal(middleEllipsis('', 10), '');
});

test('fileKind — 아이콘을 고르는 갈래', () => {
  assert.equal(fileKind('a.pdf'), 'pdf');
  assert.equal(fileKind('a.docx'), 'doc');
  assert.equal(fileKind('a.hwp'), 'doc');
  assert.equal(fileKind('a.xlsx'), 'sheet');
  assert.equal(fileKind('a.csv'), 'sheet');
  assert.equal(fileKind('a.pptx'), 'slide');
  assert.equal(fileKind('a.zip'), 'archive');
  assert.equal(fileKind('a.mp4'), 'video');
  assert.equal(fileKind('a.m4a'), 'audio');
  assert.equal(fileKind('a.md'), 'text');
  assert.equal(fileKind('a.json'), 'code');
  assert.equal(fileKind('a.png'), 'image');
  assert.equal(fileKind('a.bin'), 'file');
  assert.equal(fileKind('x', 'application/pdf'), 'pdf');
});

test('formatBytes — 사람이 읽는 크기', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(12 * 1024), '12 KB');
  assert.equal(formatBytes(3.42 * 1024 * 1024), '3.4 MB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
  assert.equal(formatBytes(null), '');
});

test('gridRows — 여러 장은 카톡처럼 한 줄 3장, 남는 1장은 2+2로', () => {
  assert.deepEqual(gridRows(1), [1]);
  assert.deepEqual(gridRows(2), [2]);
  assert.deepEqual(gridRows(3), [3]);
  assert.deepEqual(gridRows(4), [2, 2]);
  assert.deepEqual(gridRows(5), [3, 2]);
  assert.deepEqual(gridRows(6), [3, 3]);
  assert.deepEqual(gridRows(7), [3, 2, 2]);
  assert.deepEqual(gridRows(8), [3, 3, 2]);
  assert.deepEqual(gridRows(10), [3, 3, 2, 2]);
  assert.deepEqual(gridRows(0), []);
});
