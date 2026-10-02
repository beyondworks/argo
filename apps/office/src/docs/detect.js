// PDF 글자에서 "채워야 할 칸"을 찾는다(모두싸인식 자동 필드) — 인트라넷 lib/esign/detect.ts + autofields.ts를 합쳤다.
// 순수 함수: 좌표는 호출자가 비율(0~1, 좌상단 기준)로 바꿔 넘긴다(브라우저 pdfjs·노드 테스트 공용).

const SIG_RE = /(\(\s*인\s*\)|（\s*인\s*）|\(\s*서명\s*\)|（\s*서명\s*）|서명\s*또는\s*인|서명\s*란|서명\s*[:：]|날\s*인|서\s*명\s*$)/;
const BLANK_RE = /[_＿]{3,}/;
const FILL_RE = /\(\s*계약\s*체결\s*시\s*기입\s*\)|\(\s*기입\s*\)/;
const DATE_LABEL_RE = /^계약일자$|^체결일자?$/;
const TAIL_SIG_RE = /(\(\s*서명\s*또는\s*인\s*\)|\(\s*인\s*\)|\(\s*서명\s*\))\s*$/;

/** 서명자 화면에서 쓰는 기본 감지(인트라넷 detect.ts:34-73) — items: [{ page, str, xr, yr, wr, hr }] → [{ id, page, kind, xr, yr, wr, hr, label }] */
export function detectFields(items = []) {
  const out = [];
  for (const it of items) {
    const s = String(it.str || '').trim();
    if (!s) continue;
    if (SIG_RE.test(s)) {
      const cw = Math.max(it.hr * 7, 0.11), bh = Math.max(it.hr * 2.6, 0.03);
      const cx = it.xr + it.wr / 2, cy = it.yr + it.hr / 2;
      out.push({ page: it.page, kind: 'signature', xr: Math.max(0, cx - cw / 2), yr: Math.max(0, cy - bh / 2), wr: cw, hr: bh, label: s.slice(0, 16) });
    } else if (BLANK_RE.test(s)) {
      out.push({ page: it.page, kind: 'text', xr: it.xr, yr: Math.max(0, it.yr - it.hr * 0.2), wr: Math.max(it.wr, 0.08), hr: it.hr * 1.4, label: '기입란' });
    }
  }
  return out.sort((a, b) => a.page - b.page || a.yr - b.yr || a.xr - b.xr).map((f, i) => ({ ...f, id: `f${i}` }));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 소유자 세팅 화면에 미리 채울 필드(인트라넷 autofields.ts:60-127) — 짧은 라벨만 서명란으로 보고(본문 문장 오탐 차단),
 *  "(계약 체결 시 기입)"은 기입란, "계약일자" 라벨은 오른쪽에 날짜 칸, 왼쪽 열 = 갑(0)·오른쪽 열 = 을(1) */
export function autoFields(items = []) {
  // 긴 항목이라도 끝이 서명 표시면("이한빛      (서명 또는 인)" — 이름과 표시가 한 덩어리로 나오는 PDF) 그 표시 자리만 떼어 본다(글자 수 비례)
  const labelish = items.flatMap((it) => {
    const t = String(it.str || '').trim();
    if (t.length <= 14 || BLANK_RE.test(t)) return [it];
    const m = TAIL_SIG_RE.exec(t);
    if (!m) return [];
    const full = String(it.str), at = full.lastIndexOf(m[1]);
    return [{ ...it, str: m[1], xr: it.xr + it.wr * (at / full.length), wr: it.wr * (m[1].length / full.length) }];
  });
  const out = detectFields(labelish).map(({ id, ...f }) => f);
  for (const it of items) {
    const s = String(it.str || '').trim();
    if (FILL_RE.test(s)) out.push({ page: it.page, xr: it.xr, yr: Math.max(0, it.yr - it.hr * 0.2), wr: Math.max(it.wr, 0.16), hr: it.hr * 1.6, kind: 'text', label: '기입란' });
    if (DATE_LABEL_RE.test(s)) {
      // 같은 줄 오른쪽에 이미 글자(예: "2026년 월 일")가 있으면 그 뒤에 놓는다 — 인쇄된 빈칸 안내와 겹치지 않게(인트라넷은 라벨 바로 옆에 겹쳐 놓였다)
      const right = items.filter((x) => x.page === it.page && x !== it && x.xr > it.xr && Math.abs((x.yr + x.hr / 2) - (it.yr + it.hr / 2)) < it.hr).reduce((m, x) => Math.max(m, x.xr + x.wr), it.xr + it.wr);
      out.push({ page: it.page, xr: Math.min(0.82, right + 0.02), yr: Math.max(0, it.yr - it.hr * 0.2), wr: 0.16, hr: it.hr * 1.6, kind: 'date', label: '계약일자', ordX: it.xr }); // 서명자는 라벨 자리로 정한다
    }
  }
  return out.sort((a, b) => a.page - b.page || a.yr - b.yr || a.xr - b.xr).map((f, i) => ({
    id: `fd${i}`, signer_ord: (f.ordX ?? f.xr + f.wr / 2) < 0.5 ? 0 : 1, page: f.page,
    xr: clamp(f.xr, 0, 1), yr: clamp(f.yr, 0, 1), wr: clamp(f.wr, 0.02, 1), hr: clamp(f.hr, 0.01, 1), kind: f.kind, required: true,
  }));
}

/** pdfjs 글자 항목 → 비율 좌표(브라우저 view.js·서버 공용). tx = pdfjs.Util.transform(viewport.transform, item.transform) */
export function itemFromTransform(page, str, tx, width, vp) {
  const h = Math.hypot(tx[2], tx[3]);
  return { page, str, xr: tx[4] / vp.width, yr: (tx[5] - h) / vp.height, wr: width / vp.width, hr: h / vp.height };
}
