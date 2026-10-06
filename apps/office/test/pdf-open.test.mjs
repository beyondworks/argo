import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { withPdf } from '../src/core/pdf-open.js';

// 이유(운영 결함 10/3): pdf.js 6에서 문서.destroy()가 없어져 브라우저 글자 읽기가 'destroy is not a function'으로 전부 '실패'가 됐다.
// 실제 pdf.js(같은 6.x, 노드용 legacy 빌드)로 열고 닫아 본다 — 닫기를 문서 쪽으로 되돌리면 이 시험이 실패한다.
const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function onePagePdf(text) {
  const d = await PDFDocument.create();
  const page = d.addPage([300, 120]);
  page.drawText(text, { x: 20, y: 60, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  return new Uint8Array(await d.save());
}

test('withPdf: pdf.js 6 문서를 열어 글자를 읽고, 불러오기 작업으로 닫는다(문서.destroy 없음)', async () => {
  const data = await onePagePdf('Argo Office text layer check');
  const text = await withPdf(lib, data, async (doc) => {
    assert.equal(typeof doc.destroy, 'undefined', 'pdf.js 6 문서에는 destroy가 없다 — 이 전제가 바뀌면 이 모듈도 다시 본다');
    const c = await (await doc.getPage(1)).getTextContent();
    return c.items.map((i) => i.str).join(' ');
  });
  assert.match(text, /Argo Office text layer check/);
});

test('withPdf: 읽는 중 오류가 나도 작업을 닫고 오류는 그대로 올린다', async () => {
  const data = await onePagePdf('x');
  await assert.rejects(withPdf(lib, data, async () => { throw new Error('boom'); }), /boom/);
});
