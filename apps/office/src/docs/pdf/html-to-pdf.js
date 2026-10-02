// 서식 HTML → A4 PDF, 브라우저 안에서(서버에 크롬이 없다 — 인트라넷 lib/docgen/render.ts의 헤드리스 크롬 대체).
// 방법: 서식을 보이지 않는 틀(iframe)에 실제 크기(210mm)로 그리고, 브라우저가 계산한 자리(배경·테두리·그림·글자 한 자 한 자)를
// 그대로 pdf-lib로 옮긴다. 틀과 PDF가 같은 글꼴 파일(Pretendard)을 써서 줄 바꿈·폭이 같다 — 글자는 그림이 아니라 글자로 들어가
// 검색·복사가 되고, 자동 서명란 감지(pdfjs 글자층)도 그대로 된다. 쓴 글자만 넣어 한 장에 수십 KB.
import { PDFDocument, rgb } from 'pdf-lib';
import { fontkit } from './fontkit.js';
import * as fk from 'fontkit';

const FONT_URLS = { regular: '/fonts/Pretendard-Regular.ttf', bold: '/fonts/Pretendard-Bold.ttf' };
let fontCache = null;
/** 글꼴 바이트(한 번 받고 이 탭에서 다시 쓴다) */
export function loadFonts() {
  fontCache ??= Promise.all([FONT_URLS.regular, FONT_URLS.bold].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`font ${r.status}`); return r.arrayBuffer(); })))
    .then(([regular, bold]) => ({ regular: new Uint8Array(regular), bold: new Uint8Array(bold) }))
    .catch((e) => { fontCache = null; throw e; });
  return fontCache;
}


const PT_PER_PX = 0.75; // 96dpi CSS px → 72dpi pt
const color = (css) => {
  const m = /rgba?\(([^)]+)\)/.exec(css || '');
  if (!m) return null;
  const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
  return Number(a) <= 0.01 ? null : { c: rgb(Number(r) / 255, Number(g) / 255, Number(b) / 255), a: Number(a) };
};

function frameFor(html, fontCss) {
  return new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none';
    f.srcdoc = html.replace('<style>', `<style>${fontCss}`);
    f.onload = () => resolve(f);
    f.onerror = reject;
    document.body.appendChild(f);
  });
}

async function imageToPng(img, w, h, filter = 'none') {
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
  ctx.filter = filter || 'none'; // CSS filter(배너 로고 흰색 처리)를 캔버스에도
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** html: 서식 문서 전체 → { bytes: Uint8Array, pages: number }. 서식은 .page(210×297mm) 단위로 쪽을 나눈다 */
export async function htmlToPdf(html) {
  const fonts = await loadFonts();
  const urls = [new Blob([fonts.regular], { type: 'font/ttf' }), new Blob([fonts.bold], { type: 'font/ttf' })].map((b) => URL.createObjectURL(b));
  const fontCss = `@font-face{font-family:'Pretendard';font-weight:100 500;src:url('${urls[0]}') format('truetype');}@font-face{font-family:'Pretendard';font-weight:600 900;src:url('${urls[1]}') format('truetype');}`;
  const frame = await frameFor(html, fontCss);
  try {
    const doc = frame.contentDocument;
    await doc.fonts.ready;
    await Promise.all([...doc.images].map((im) => (im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const title = doc.title || '';
    pdf.setTitle(title); pdf.setCreator('Argo Office'); pdf.setProducer('Argo Office');
    const font = { 400: await pdf.embedFont(fonts.regular, { subset: true }), 700: await pdf.embedFont(fonts.bold, { subset: true }) };
    const metric = (bytes) => { const f = fk.create(bytes); return { asc: f.ascent / f.unitsPerEm, desc: f.descent / f.unitsPerEm }; };
    const m = { 400: metric(fonts.regular), 700: metric(fonts.bold) };
    const pages = [...doc.querySelectorAll('.page')];
    for (const pageEl of pages.length ? pages : [doc.body]) {
      const box = pageEl.getBoundingClientRect();
      const W = box.width * PT_PER_PX, H = (pages.length ? box.height : box.width * 297 / 210) * PT_PER_PX;
      const page = pdf.addPage([W, H]);
      const X = (px) => (px - box.left) * PT_PER_PX;
      const Y = (px) => H - (px - box.top) * PT_PER_PX;
      const rect = (x, y, w, h, col) => { if (w > 0 && h > 0) page.drawRectangle({ x: X(x), y: Y(y + h), width: w * PT_PER_PX, height: h * PT_PER_PX, color: col.c, opacity: col.a }); };
      const els = [pageEl, ...pageEl.querySelectorAll('*')];
      for (const el of els) {
        const cs = doc.defaultView.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        const bg = color(cs.backgroundColor);
        if (bg && el !== pageEl) rect(r.left, r.top, r.width, r.height, bg);
        for (const [side, w] of [['Top', r.width], ['Bottom', r.width], ['Left', r.height], ['Right', r.height]]) {
          const bw = parseFloat(cs[`border${side}Width`]) || 0;
          const bc = cs[`border${side}Style`] !== 'none' && color(cs[`border${side}Color`]);
          if (!bw || !bc) continue;
          if (side === 'Top') rect(r.left, r.top, w, bw, bc);
          else if (side === 'Bottom') rect(r.left, r.bottom - bw, w, bw, bc);
          else if (side === 'Left') rect(r.left, r.top, bw, w, bc);
          else rect(r.right - bw, r.top, bw, w, bc);
        }
        if (el.tagName === 'IMG' && r.width > 0) {
          try { const png = await pdf.embedPng(await imageToPng(el, r.width, r.height, cs.filter)); page.drawImage(png, { x: X(r.left), y: Y(r.bottom), width: r.width * PT_PER_PX, height: r.height * PT_PER_PX, opacity: Number(cs.opacity) || 1 }); } catch { /* 그림을 못 읽으면 빈 자리 */ }
        }
        if (el.tagName === 'LI' && cs.listStyleType === 'disc') drawDisc(doc, el, cs, page, X, Y, m);
        for (const node of el.childNodes) if (node.nodeType === 3 && node.data.trim()) drawText(doc, node, cs, page, X, Y, font, m);
      }
    }
    return { bytes: await pdf.save(), pages: pdf.getPageCount() };
  } finally {
    frame.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

const weightOf = (cs) => (Number(cs.fontWeight) >= 600 ? 700 : 400);
const baseline = (r, fs, mt) => r.top + (r.height - (mt.asc - mt.desc) * fs) / 2 + mt.asc * fs;

function drawDisc(doc, li, cs, page, X, Y, m) {
  const range = doc.createRange();
  const walker = doc.createTreeWalker(li, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.search(/\S/);
    if (i < 0) continue;
    range.setStart(n, i); range.setEnd(n, i + 1);
    const r = range.getClientRects()[0];
    if (!r) return;
    const fs = parseFloat(cs.fontSize) || 12, col = color(cs.color) ?? { c: rgb(0, 0, 0), a: 1 };
    const liLeft = li.getBoundingClientRect().left;
    const base = baseline(r, fs, m[400]);
    page.drawCircle({ x: X(liLeft - fs * 0.7), y: Y(base - fs * 0.32), size: fs * 0.17 * PT_PER_PX, color: col.c });
    return;
  }
}

function drawText(doc, node, cs, page, X, Y, font, m) {
  const fs = parseFloat(cs.fontSize) || 12;
  const w = weightOf(cs), f = font[w], mt = m[w];
  const col = color(cs.color) ?? { c: rgb(0, 0, 0), a: 1 };
  const spaced = cs.letterSpacing && cs.letterSpacing !== 'normal' && parseFloat(cs.letterSpacing) !== 0;
  const range = doc.createRange();
  const text = node.data;
  let run = null; // { x, top, h, s }
  const pt = fs * PT_PER_PX;
  const flush = () => {
    if (run && run.s.trim()) page.drawText(run.s.replace(/ /g, ' '), { x: X(run.x), y: Y(baseline({ top: run.top, height: run.h }, fs, mt)), size: pt, font: f, color: col.c, opacity: col.a });
    run = null;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    range.setStart(node, i); range.setEnd(node, i + 1);
    const r = range.getClientRects()[0];
    if (!r || (r.width === 0 && /\s/.test(ch))) { flush(); continue; } // 접힌 공백
    if (ch === '\n' || ch === '\t') { flush(); continue; }
    if (run) {
      const newLine = Math.abs(r.top - run.top) > fs * 0.5;
      const expect = run.x + f.widthOfTextAtSize(run.s.replace(/ /g, ' '), fs); // 같은 글꼴이므로 px 단위로 같다
      if (newLine || spaced || Math.abs(expect - r.left) > 0.6) flush(); // 자간이 있거나 어긋나면 그 자리에서 새로 시작
    }
    if (!run) run = { x: r.left, top: r.top, h: r.height, s: '' };
    run.s += ch;
  }
  flush();
}
