// 브라우저 안 글자 읽기(서버 OCR이 없을 때 — 예시 모드 포함). 이 파일과 라이브러리는 부를 때만 받는다(첫 화면 150KB 상한).
// · PDF: pdf.js 글자층을 먼저 읽고, 글자층이 없으면(스캔본) 쪽마다 그림으로 그려 tesseract로 읽는다.
// · 그림: tesseract(한국어+영어). 워커·코어는 같은 출처에서 싣는다 — 데스크톱 CSP(script-src 'self')가 CDN 워커·blob 워커를 막는다.
//   언어 데이터만 jsDelivr에서 받아(connect-src https:) 브라우저 저장소에 캐시한다(tesseract 기본 — 다음부터는 내려받지 않는다).
// · 문서 전체가 이 기기 밖으로 나가지 않는다(언어 데이터만 받아 온다).
// 트랙 A(견적·계약 사업자등록증 OCR)와 같이 쓴다 — readTextInBrowser(blob, name) → { status: 'done'|'failed'|'unsupported', text }.
import { kindOf } from '../files/model.js';

const PDF_PAGES = 10;   // 스캔 PDF는 앞 10쪽까지(브라우저에서 수십 쪽을 그리면 멈춘 것처럼 보인다)
const CMAPS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/cmaps/';

let pdfjs = null, tess = null;
async function pdf() {
  if (!pdfjs) {
    const [lib, worker] = await Promise.all([import('pdfjs-dist/build/pdf.min.mjs'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    pdfjs = lib;
  }
  return pdfjs;
}
/** tesseract 워커 하나를 다시 쓴다(언어 데이터를 매번 싣지 않게) — 쓰지 않으면 1분 뒤 닫는다 */
let closeTimer = null;
async function worker() {
  clearTimeout(closeTimer);
  if (!tess) {
    tess = (async () => {
      const [lib, w, core] = await Promise.all([
        import('tesseract.js/dist/tesseract.esm.min.js'),
        import('tesseract.js/dist/worker.min.js?url'),
        import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'),
      ]);
      const { createWorker } = lib.default ?? lib; // ESM 묶음은 CJS를 default 하나로 내보낸다
      return createWorker(['kor', 'eng'], 1, { workerPath: w.default, corePath: core.default, workerBlobURL: false });
    })().catch((e) => { tess = null; throw e; });
  }
  return tess;
}
const idle = () => { clearTimeout(closeTimer); closeTimer = setTimeout(async () => { const t = tess; tess = null; (await t?.catch(() => null))?.terminate().catch(() => {}); }, 60_000); };

async function ocrImage(source) {
  const w = await worker();
  try { return (await w.recognize(source)).data.text ?? ''; } finally { idle(); }
}

/** 글자층 줄 맞추기 — 같은 높이(y)의 글자를 한 줄로(인트라넷 사이드카의 줄 순서 복원과 같은 생각) */
function layoutText(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const y = Math.round(it.transform[5]), x = it.transform[4];
    const row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (row) row.cells.push({ x, s: it.str }); else rows.push({ y, cells: [{ x, s: it.str }] });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim()).join('\n');
}

async function readPdf(blob) {
  const lib = await pdf();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), cMapUrl: CMAPS, cMapPacked: true, isEvalSupported: false }).promise;
  try {
    const n = Math.min(doc.numPages, 200);
    const parts = [];
    for (let i = 1; i <= n; i++) parts.push(layoutText((await (await doc.getPage(i)).getTextContent()).items));
    const text = parts.join('\n\n').trim();
    if (text.replace(/\s/g, '').length >= 20) return text;
    // 글자층이 없다 — 스캔본. 쪽을 그려서 읽는다
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, PDF_PAGES); i++) {
      const page = await doc.getPage(i), view = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = view.width; canvas.height = view.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: view, canvas }).promise;
      out.push(await ocrImage(canvas));
    }
    return out.join('\n\n').trim();
  } finally { doc.destroy(); }
}

/** blob(파일) → { status, text } — 실패해도 던지지 않는다(문서함은 메타만 저장하고 '실패'로 표시) */
export async function readTextInBrowser(blob, name = '', mime = '') {
  const kind = kindOf(name, mime || blob?.type);
  try {
    if (kind === 'pdf') return { status: 'done', text: await readPdf(blob) };
    if (kind === 'image') return { status: 'done', text: (await ocrImage(blob)).trim() };
    return { status: 'unsupported', text: '' };
  } catch (e) {
    console.warn('[office] browser ocr failed', e?.message);
    return { status: 'failed', text: '' };
  }
}
