// 사업자등록증 읽기(인트라넷 app/api/bizcert/ocr — PaddleOCR 사이드카, 꺼져 있으면 못 씀) → 오피스는 브라우저 안에서 읽는다.
// 순서: 문서함 서버 OCR(트랙 B readText, 설정돼 있을 때) → PDF 글자층(홈택스 발급 PDF는 글자가 들어 있다) → 그림 글자 인식(tesseract.js, 한국어).
// 사업자등록증은 서버로 올리지 않는다(문서함 서버 OCR을 켠 조직만 예외). tesseract 일꾼·엔진은 같은 출처에서, 한국어 학습 데이터는 jsDelivr에서 받는다.
import { parseBizCert } from './bizcert.js';

const docStore = import.meta.glob('../core/doc-store.js');

async function ocrImage(source) {
  const [lib, workerPath, simdCore, plainCore] = await Promise.all([
    import('tesseract.js'),
    import('tesseract.js/dist/worker.min.js?url').then((m) => m.default),
    import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url').then((m) => m.default),
    import('tesseract.js-core/tesseract-core-lstm.wasm.js?url').then((m) => m.default),
  ]);
  const { createWorker } = lib.default ?? lib; // ESM 빌드가 CJS를 default 하나로 내보낸다(트랙 B 실측)
  const simd = typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  const worker = await createWorker(['kor', 'eng'], 1, { workerPath, corePath: simd ? simdCore : plainCore, workerBlobURL: false });
  try { return (await worker.recognize(source)).data.text ?? ''; } finally { await worker.terminate(); }
}

async function pdfFirstPageImage(bytes) {
  const { openPdf, closePdf } = await import('./pdf/view.js');
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  closePdf(pdf);
  return canvas;
}

/** file(그림·PDF) → { ok, fields, via: 'server'|'pdf'|'ocr', text } · 형식이 아니면 { ok:false, error:'type' } */
export async function readBizcert(space, file, { onStep } = {}) {
  if (!/^(image\/|application\/pdf)/.test(file?.type || '')) return { ok: false, error: 'type' };
  const load = docStore['../core/doc-store.js'];
  if (load) {
    try { const r = await (await load()).readText?.(space, file); if (r?.status === 'done' && r.text?.trim()) return { ok: true, via: 'server', text: r.text, fields: parseBizCert(r.text) }; } catch { /* 다음 방법으로 */ }
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'application/pdf') {
    onStep?.('pdf');
    const { pdfText } = await import('./pdf/view.js');
    const text = await pdfText(bytes).catch(() => '');
    if (text.replace(/\s/g, '').length >= 20) return { ok: true, via: 'pdf', text, fields: parseBizCert(text) };
    onStep?.('ocr');
    const text2 = await ocrImage(await pdfFirstPageImage(bytes));
    return { ok: !!text2.trim(), via: 'ocr', text: text2, fields: parseBizCert(text2) };
  }
  onStep?.('ocr');
  const text = await ocrImage(file);
  return { ok: !!text.trim(), via: 'ocr', text, fields: parseBizCert(text) };
}
