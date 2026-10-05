// 견적서·계약서 크게 보기(유건 10/2 13차) — 미리보기를 누르면 화면을 덮는 창에서 쪽을 위아래로 이어 보고 확대한다.
// 돋보기 줄(− · % · + · 폭 맞춤 · 쪽 맞춤), ⌘+ · ⌘− · ⌘0, 트랙패드 핀치·⌘+휠(포인터 자리 기준), 두 손가락 핀치(터치), 끌어서 이동, 쪽 번호, PDF 받기.
// 쪽 = 794×1123px(A4, 서식 기준) 한 장. 작성 화면은 서식 HTML(html·pages)을, 목록·문서함은 PDF 바이트(pdf)를 준다 — 둘 다 같은 쪽 틀에 그린다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../core/i18n.js';
import './register-i18n.js'; // 문서함 미리보기에서도 열린다 — 사전·모양을 스스로 싣는다
import './docs.css';
import { useDialog } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { clampZoom, stepZoom, fitZoom, zoomAt, pageAt, PAGE_W, PAGE_H, PAGE_GAP, STAGE_PAD } from './zoom-model.js';

/** PDF 쪽을 한 번만 고화질(쪽 폭 2배)로 그려 그림 주소로 돌려준다 — 확대는 그림을 늘려 보여 준다(400%까지 흐려지지 않게 2배) */
function usePdfPages(pdf) {
  const [pages, setPages] = useState(null);
  useEffect(() => {
    if (!pdf) return undefined;
    let live = true;
    (async () => {
      const { openPdf, closePdf } = await import('./pdf/view.js');
      const doc = await openPdf(pdf);
      const out = [];
      for (let i = 1; i <= doc.numPages && live; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: (PAGE_W * 2) / page.getViewport({ scale: 1 }).width });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
        out.push({ src: c.toDataURL('image/png'), ratio: vp.height / vp.width });
      }
      closePdf(doc);
      if (live) setPages(out);
    })().catch(() => live && setPages([]));
    return () => { live = false; };
  }, [pdf]);
  return pages;
}

export default function DocZoom({ title, html, pages = 1, pdf, onDownload, onClose }) {
  const ref = useDialog(true, onClose);
  const stage = useRef(null), z = useRef(1);
  const [zoom, setZoomState] = useState(null); // null = 처음 폭 맞춤 전
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const pdfPages = usePdfPages(pdf);
  const sheets = pdf ? (pdfPages ?? []).map((p) => ({ h: PAGE_W * p.ratio, src: p.src })) : Array.from({ length: pages }, () => ({ h: PAGE_H }));
  const count = sheets.length;

  /** 배율 바꾸기 — at(포인터 자리, 무대 안 좌표)이 가리키던 문서 지점이 그 자리에 남게 스크롤을 옮긴다 */
  const setZoom = useCallback((next, at) => {
    const el = stage.current; if (!el) return;
    const prev = z.current, nz = clampZoom(next);
    if (nz === prev) return;
    const p = at ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const s = zoomAt({ scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }, p, prev, nz, el.clientWidth);
    z.current = nz; setZoomState(nz);
    requestAnimationFrame(() => { el.scrollLeft = s.scrollLeft; el.scrollTop = s.scrollTop; });
  }, []);
  const fit = useCallback((mode) => {
    const el = stage.current; if (!el) return;
    const nz = fitZoom(mode, { width: el.clientWidth, height: el.clientHeight });
    z.current = nz; setZoomState(nz);
    requestAnimationFrame(() => { el.scrollLeft = 0; if (mode === 'page') el.scrollTop = (page - 1) * (PAGE_H * nz + PAGE_GAP); });
  }, [page]);
  useLayoutEffect(() => { if (zoom == null) fit('width'); }, [zoom, fit]);

  // ⌘+ · ⌘− · ⌘0(100%) — 브라우저 확대 대신 문서만
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(stepZoom(z.current, 1)); }
      else if (e.key === '-') { e.preventDefault(); setZoom(stepZoom(z.current, -1)); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setZoom]);

  // 트랙패드 핀치(ctrlKey 휠)·⌘+휠 — 포인터 자리 기준. 기본 동작(화면 확대)을 막으려면 passive: false
  useEffect(() => {
    const el = stage.current; if (!el) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setZoom(z.current * Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.0075), { x: e.clientX - r.left, y: e.clientY - r.top }); // 트랙패드 핀치는 작은 값이 여러 번, 휠 한 칸은 100 — 한 번에 최대 1.35배
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // 끌어서 이동(마우스·펜) · 두 손가락 핀치(터치) — 한 손가락 터치는 브라우저 스크롤 그대로
  const pts = useRef(new Map()), drag = useRef(null), pinch = useRef(null);
  const onPointerDown = (e) => {
    const el = stage.current;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: z.current };
      drag.current = null; return;
    }
    if (e.pointerType === 'touch' || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = stage.current;
    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()], r = el.getBoundingClientRect();
      setZoom(pinch.current.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d), { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top });
    } else if (drag.current) {
      el.scrollLeft = drag.current.l - (e.clientX - drag.current.x);
      el.scrollTop = drag.current.t - (e.clientY - drag.current.y);
    }
  };
  const onPointerUp = (e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; if (!pts.current.size) drag.current = null; };
  const onScroll = () => { const el = stage.current; if (el) setPage(pageAt(el.scrollTop + el.clientHeight / 3, z.current, count)); };

  const download = async () => { setBusy(true); try { await onDownload(); } finally { setBusy(false); } };
  const zv = zoom ?? 1;
  return createPortal(
    <div className="scrim doc-zoom-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal doc-zoom" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <span className="dim small mono doc-zoom-page" aria-live="polite">{t('docs.zoom.page', { n: page, total: count || 1 })}</span>
          <div className="doc-zoom-bar" role="toolbar" aria-label={t('docs.zoom.bar')}>
            <button type="button" className="icon-btn sm" aria-label={t('docs.zoom.out')} title={`${t('docs.zoom.out')} (⌘−)`} disabled={zv <= 0.5} onClick={() => setZoom(stepZoom(z.current, -1))}><Icon name="divider" size={14} /></button>
            <button type="button" className="btn sm ghost doc-zoom-pct mono" title={`${t('docs.zoom.actual')} (⌘0)`} onClick={() => setZoom(1)}>{Math.round(zv * 100)}%</button>
            <button type="button" className="icon-btn sm" aria-label={t('docs.zoom.in')} title={`${t('docs.zoom.in')} (⌘+)`} disabled={zv >= 4} onClick={() => setZoom(stepZoom(z.current, 1))}><Icon name="plus" size={14} /></button>
            <button type="button" className="btn sm ghost" onClick={() => fit('width')}>{t('docs.zoom.fitWidth')}</button>
            <button type="button" className="btn sm ghost" onClick={() => fit('page')}>{t('docs.zoom.fitPage')}</button>
          </div>
          {onDownload && <button type="button" className="btn sm" disabled={busy} onClick={download}><Icon name="download" size={13} />{busy ? t("docs.step.pdf") : t("docs.zoom.download")}</button>}
          <button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button>
        </header>
        <div ref={stage} className={`doc-zoom-stage${zv > 0 && stage.current && PAGE_W * zv + STAGE_PAD * 2 > stage.current.clientWidth ? ' pan' : ''}`} tabIndex={0} aria-label={t('docs.zoom.stage')}
          onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="doc-zoom-pages" style={{ width: PAGE_W * zv }}>
            {pdf && !pdfPages ? <div className="doc-zoom-sheet boot" aria-busy="true" style={{ width: PAGE_W * zv, height: PAGE_H * zv }} />
              : sheets.map((s, i) => <div key={i} className="doc-zoom-sheet ha ha-cover" style={{ width: PAGE_W * zv, height: s.h * zv }}>
                {s.src ? <img src={s.src} alt={t('docs.zoom.page', { n: i + 1, total: count })} draggable={false} />
                  : <iframe title={t('docs.zoom.page', { n: i + 1, total: count })} srcDoc={html} sandbox="allow-same-origin" tabIndex={-1} style={{ width: PAGE_W, height: PAGE_H * pages, transform: `scale(${zv}) translateY(${-i * PAGE_H}px)` }} />}
              </div>)}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
