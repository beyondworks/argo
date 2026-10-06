// PDF 보기 — pdfjs로 쪽마다 캔버스를 그리고 글자 항목(자동 서명란 감지용)을 비율 좌표로 돌려준다(인트라넷 esign/new·sign 페이지의 렌더 부분).
// 서명 세팅·서명 화면만 불러온다(지연 로드 — pdfjs 묶음은 첫 화면에 안 실린다). 일꾼(worker)은 같은 출처에서 받는다(데스크톱 CSP).
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { itemFromTransform } from '../detect.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** bytes(Uint8Array) → pdf 문서 */
export const openPdf = (bytes) => pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;

/** 문서 닫기(일꾼 자원 정리) — pdfjs 6은 문서가 아니라 불러오기 작업을 닫는다 */
export const closePdf = (pdf) => { try { (pdf.loadingTask ?? pdf).destroy?.(); } catch { /* 이미 닫힘 */ } };

/** box 안에 쪽들을 그린다 — 각 쪽은 data-page(0부터)를 가진 겹(div)이고, 그 위에 칸을 얹는다. 반환: { pages, items } */
export async function renderPdf(bytes, box, { maxWidth = 820, onPage } = {}) {
  const pdf = await openPdf(bytes);
  box.replaceChildren();
  const W = Math.min(maxWidth, box.clientWidth || maxWidth);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const items = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = W / vp0.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`; canvas.style.height = `${Math.floor(vp.height)}px`;
    const layer = document.createElement('div');
    layer.className = 'pdf-page';
    layer.style.width = `${Math.floor(vp.width)}px`;
    layer.dataset.page = String(i - 1);
    layer.appendChild(canvas);
    box.appendChild(layer);
    onPage?.(layer, i - 1);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    try {
      const tc = await page.getTextContent();
      for (const it of tc.items) if (it.str && it.str.trim()) items.push(itemFromTransform(i - 1, it.str, pdfjs.Util.transform(vp.transform, it.transform), (it.width || 0) * scale, vp));
    } catch { /* 글자층이 없는 스캔 PDF — 자동 감지 생략 */ }
  }
  const pages = pdf.numPages;
  closePdf(pdf);
  return { pages, items };
}

/** 글자만 뽑기(사업자등록증 PDF 등) — 쪽마다 줄 단위로 */
export async function pdfText(bytes, maxPages = 3) {
  const pdf = await openPdf(bytes);
  const out = [];
  for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let lastY = null, line = '';
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
      line += (line && !line.endsWith(' ') ? ' ' : '') + it.str; lastY = y;
    }
    if (line) out.push(line);
  }
  closePdf(pdf);
  return out.join('\n');
}
