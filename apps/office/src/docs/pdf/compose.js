// 서명본 합성 — 원본 PDF 위에 서명자들의 서명 그림·기입 글자를 좌표대로 얹고 감사(증명) 페이지를 덧붙인다(인트라넷 lib/esign/pdf.ts).
// 브라우저(예시 모드)와 서버 함수(api/esign — 크롬 없이 pdf-lib만)가 같은 함수를 쓴다. 글꼴은 호출자가 바이트로 넘긴다(Pretendard).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fontkit } from './fontkit.js';
import { partyLabel } from '../esign-model.js';
import { DOC } from '../doc-text.js';

const A = DOC.audit;
const fmt = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-');

/** origPdf: Uint8Array · signers: [{ name, email, ord, signed_at, ip, placements: [{ page, kind, xr, yr, wr, text?, sizeR?, img?: { type:'png'|'jpg', bytes } }] }]
 *  docHash: 원본 SHA-256 · title · completedAt(ISO) · font/bold: 글꼴 바이트(없으면 Helvetica — 한글이 빠지므로 운영은 꼭 넘긴다) → Uint8Array */
export async function composeSignedPdf({ origPdf, signers, docHash, title, completedAt = new Date().toISOString(), font: fontBytes, bold: boldBytes }) {
  const pdf = await PDFDocument.load(origPdf);
  pdf.registerFontkit(fontkit);
  const pages = pdf.getPages();
  // 글꼴은 쓴 글자만 넣는다(subset) — 인트라넷은 일부 넣기에서 글자가 빠져 2.5MB 통째로 넣었다. 원래 fontkit으로 바꿔 해결(fontkit.js)
  const font = fontBytes ? await pdf.embedFont(fontBytes, { subset: true }) : await pdf.embedFont(StandardFonts.Helvetica);
  const bold = boldBytes ? await pdf.embedFont(boldBytes, { subset: true }) : fontBytes ? font : await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink0 = rgb(0.1, 0.1, 0.1);

  for (const s of signers) {
    for (const p of s.placements ?? []) {
      if (p.page < 0 || p.page >= pages.length) continue;
      const page = pages[p.page];
      const pw = page.getWidth(), ph = page.getHeight();
      if (p.kind === 'text') {
        const text = String(p.text || '').trim();
        if (!text) continue;
        const size = Math.max(6, (p.sizeR || 0.02) * ph), lineH = size * 1.32;
        const x = p.xr * pw;
        let y = ph - p.yr * ph - size; // 좌상단 기준 → 첫 줄 글자 바닥선
        if (p.cover) page.drawRectangle({ x: x - 1, y: y - size * 0.35, width: Math.max(p.wr * pw, font.widthOfTextAtSize(text, size)) + 2, height: size * 1.4, color: rgb(1, 1, 1) }); // 인쇄된 빈칸 안내를 덮는다(서식 바탕은 흰색)
        for (const line of text.split('\n')) { page.drawText(line, { x, y, size, font, color: ink0 }); y -= lineH; }
        continue;
      }
      if (!p.img?.bytes) continue;
      let img;
      try { img = p.img.type === 'jpg' ? await pdf.embedJpg(p.img.bytes) : await pdf.embedPng(p.img.bytes); } catch { try { img = await pdf.embedPng(p.img.bytes); } catch { continue; } }
      const w = Math.max(20, p.wr * pw), h = w * (img.height / img.width);
      page.drawImage(img, { x: p.xr * pw, y: ph - p.yr * ph - h, width: w, height: h }); // pdf-lib 좌표는 아래 기준
    }
  }

  // ── 증명(감사) 페이지 ──
  const page = pdf.addPage([595.28, 841.89]);
  const M = 56;
  let y = 841.89 - M;
  const ink = rgb(0.11, 0.11, 0.11), mute = rgb(0.42, 0.42, 0.42), accent = rgb(0.1, 0.1, 0.1);
  const line = (t, { size = 10.5, color = ink, f = font, gap } = {}) => { page.drawText(String(t), { x: M, y, size, font: f, color }); y -= gap ?? size + 8; };
  const rule = () => { page.drawLine({ start: { x: M, y: y + 4 }, end: { x: 595.28 - M, y: y + 4 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) }); y -= 10; };
  line(A.title, { size: 20, f: bold, gap: 30 });
  line(A.doc(title), { color: mute, gap: 16 });
  line(A.completed(fmt(completedAt)), { color: mute, gap: 22 });
  rule();
  line(A.signers, { size: 12, f: bold, gap: 20 });
  for (const s of signers) {
    line(`· ${partyLabel(s.ord ?? 0)}  ${s.name}  <${s.email}>`, { size: 11, f: bold, gap: 16 });
    line(A.signed(fmt(s.signed_at), s.ip || '-'), { size: 9.5, color: mute, gap: 18 });
  }
  y -= 6;
  rule();
  line(A.integrity, { size: 12, f: bold, gap: 20 });
  line(A.hash, { size: 9.5, color: mute, gap: 14 });
  line(docHash, { size: 8, color: accent, gap: 22 });
  line(A.footnote, { size: 8.5, color: mute });
  return pdf.save();
}

/** PDF 쪽수(서명 제출 검사용) */
export async function pageCountOf(bytes) { return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount(); }
