// 기억 → docx/xlsx/csv(의존 없음). ZIP 구조·XML 정합·표 변환을 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { toCsv, toDocx, toXlsx, zip, parseBlocks } from '../src/office-export.mjs';

const md = '---\ntitle: x\n---\n# 브랜드 전략\n핵심은 [[콘텐츠 캘린더]]와 **연결**된다.\n\n| 채널 | 주기 |\n|---|---|\n| 뉴스레터 | 주 1회 |\n| 블로그, "A" | 2 |\n\n- 항목\n';
function unzipNames(buf) { // 중앙 디렉터리에서 이름만 — 기록기의 오프셋·카운트가 맞는지 확인
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const names = []; let p = cdOff;
  for (let i = 0; i < n; i++) { const len = buf.readUInt16LE(p + 28); names.push(buf.slice(p + 46, p + 46 + len).toString()); p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32); }
  return names;
}
test('zip — 로컬 헤더의 deflate 본문이 원문으로 복원된다', () => {
  const b = zip([{ name: 'a.txt', data: '안녕 hello' }]);
  const nameLen = b.readUInt16LE(26), csize = b.readUInt32LE(18);
  assert.equal(inflateRawSync(b.slice(30 + nameLen, 30 + nameLen + csize)).toString(), '안녕 hello');
  assert.deepEqual(unzipNames(b), ['a.txt']);
});
test('parseBlocks — frontmatter 제거, 위키링크·굵게 풀기, 표 인식', () => {
  const bl = parseBlocks(md);
  assert.equal(bl[0].type, 'h'); assert.equal(bl[1].text, '핵심은 콘텐츠 캘린더와 연결된다.');
  assert.equal(bl[2].type, 'table'); assert.equal(bl[2].rows.length, 3);
});
test('csv — 표만, 콤마·따옴표 이스케이프, BOM', () => {
  const c = toCsv(md);
  assert.ok(c.startsWith('﻿'));
  assert.ok(c.includes('"블로그, ""A""",2'));
  assert.ok(!c.includes('브랜드 전략'), '표가 있으면 본문은 안 들어간다');
});
test('docx/xlsx — 필수 파트가 들어 있다', () => {
  assert.deepEqual(unzipNames(toDocx(md)).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort());
  assert.ok(unzipNames(toXlsx(md)).includes('xl/worksheets/sheet1.xml'));
});
