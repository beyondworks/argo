// 문서 글자 꺼내기(유건 10/2) — 실제 zip(docx·xlsx·hwpx 모양)을 만들어 본문이 검색할 수 있는 글이 되는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractDocText, unzipParts, xmlText, decodeText } from '../src/files/extract.js';

/** 최소 zip(로컬 헤더 + 중앙 목록 + 끝 표시) — files: [[이름, 글, 압축여부]] */
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text, deflate = true] of files) {
    const n = Buffer.from(name), raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const blob = (buf, type = '') => new Blob([buf], { type });

test('docx: 문단은 줄로, 탭·엔티티를 풀고 머리글도 읽는다', async () => {
  const doc = '<w:document><w:body><w:p><w:r><w:t>견적서</w:t></w:r></w:p><w:p><w:r><w:t>공급가액</w:t><w:tab/><w:t>1,000,000 &amp; 부가세</w:t></w:r></w:p></w:body></w:document>';
  const r = await extractDocText(blob(zip([['[Content_Types].xml', '<x/>'], ['word/document.xml', doc], ['word/header1.xml', '<w:hdr><w:p><w:t>한빛코퍼레이션</w:t></w:p></w:hdr>']])), '견적.docx');
  assert.equal(r.status, 'done');
  assert.match(r.text, /견적서\n공급가액\t1,000,000 & 부가세/);
  assert.match(r.text, /한빛코퍼레이션/);
});

test('xlsx 공유 문자열·hwpx 본문(압축 안 한 항목 포함)', async () => {
  const x = await extractDocText(blob(zip([['xl/sharedStrings.xml', '<sst><si><t>거래처</t></si><si><t>넥스트필드</t></si></sst>']])), '목록.xlsx');
  assert.deepEqual(x.text.split('\n'), ['거래처', '넥스트필드']);
  const h = await extractDocText(blob(zip([['Contents/section0.xml', '<hs:sec><hp:p><hp:run><hp:t>용역 계약서</hp:t></hp:run></hp:p></hs:sec>', false]])), '계약.hwpx');
  assert.equal(h.text, '용역 계약서');
});

test('pptx 슬라이드는 번호 순서(slide2 < slide10)', async () => {
  const parts = await unzipParts(zip([['ppt/slides/slide10.xml', '<a:t>열</a:t>'], ['ppt/slides/slide2.xml', '<a:t>둘</a:t>']]), (n) => n.startsWith('ppt/slides/'));
  assert.deepEqual(parts.map((p) => p.name), ['ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
});

test('글 파일: UTF-8, 깨지면 EUC-KR(한글 윈도우 csv)', async () => {
  assert.equal((await extractDocText(blob(Buffer.from('﻿이름,금액\n한빛,100')), 'a.csv')).text, '이름,금액\n한빛,100');
  const euckr = Buffer.from([0xc7, 0xd1, 0xba, 0xfb]); // '한빛'
  assert.equal(decodeText(euckr), '한빛');
});

test('못 읽는 형식은 unsupported, 깨진 zip은 failed', async () => {
  assert.equal((await extractDocText(blob(Buffer.from('xx')), '옛문서.hwp')).status, 'unsupported');
  assert.equal((await extractDocText(blob(Buffer.from('not a zip')), 'a.docx')).status, 'failed');
  assert.equal(xmlText('<a>1 &lt; 2 &#44032;</a>'), '1 < 2 가');
});
