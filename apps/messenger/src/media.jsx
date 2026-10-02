// 첨부 말풍선·크게 보기·링크 카드(2026-10-02 유건 요청, 텔레그램·카카오톡 참고) — 사람이 올린 파일과 에이전트가 보낸 파일이 같은 부품을 쓴다.
//   사진: 말풍선 안 썸네일(비율 유지, 최대 폭·높이), 여러 장은 한 줄 3장 묶음(gridRows). 누르면 크게 보기.
//   크게 보기: 닫기·확대(두 손가락·두 번 탭·휠)·좌우 넘기기·아래로 끌어 닫기, 저장·공유(폰)·이미지 복사·링크 복사(데스크톱) — 안 되는 버튼은 숨김.
//   파일: 종류 아이콘 + 가운데 말줄임 이름(확장자 유지) + 종류·크기. 누르면 받기(진행 표시, 실패 시 다시 시도).
//   링크 카드: 보낼 때 한 번 저장한 meta.link_preview만 그린다(화면을 그릴 때 가져오지 않는다). 글자는 글자로만 넣는다.
// 순수 판정은 media-actions.mjs·lightbox-gesture.mjs, 네트워크·기기 동작은 media-io.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '@argo/i18n';
import { t as tm } from './i18n.js';
import { I } from './icons.jsx';
import { gridRows } from '../../../src/media-kind.mjs';
import { urlSegments } from '../../../supabase/functions/_shared/link-preview.js';
import { splitAttachments, fileView, previewFor } from './media-actions.mjs';
import { clampPan, clampZoom, zoomAt, swipeDecision, dismissDecision, isDoubleTap, wheelZoom, DOUBLE_TAP_ZOOM } from './lightbox-gesture.mjs';
import { inTauri } from './platform.js';
import { signedUrl, forgetSigned, currentCaps, saveAttachment, shareAttachment, openAttachment, copyImage, copyLink, openExternalUrl, revealSaved } from './media-io.js';

// 앱(Tauri) 오프너 허용 목록은 https·mailto뿐이다(3차 검수 H-1 — 넓히지 않는다). 앱에서 못 여는 http 링크는 누를 수 있는 것처럼 그리지 않는다.
const openable = (url) => !inTauri() || /^https:\/\//i.test(url);
function useTr() { const { lang } = useLang(); return useCallback((k, vars) => tm(k, lang, vars), [lang]); }

/** 서명 URL로 그림 주소 — 만료(그림 오류)면 한 번 새로 받고, 또 실패하면 onFail(파일 말풍선으로 물러난다). */
function useSignedSrc(path, onFail) {
  const [src, setSrc] = useState(null);
  const retried = useRef(false);
  const fail = useRef(onFail); fail.current = onFail;
  useEffect(() => {
    let on = true; retried.current = false; setSrc(null);
    if (!path) return undefined;
    signedUrl(path).then((u) => { if (on) setSrc(u); }).catch(() => { if (on) fail.current?.(); });
    return () => { on = false; };
  }, [path]);
  const onError = useCallback(() => {
    if (retried.current) { fail.current?.(); return; }
    retried.current = true; forgetSigned(path);
    signedUrl(path, { fresh: true }).then(setSrc).catch(() => fail.current?.());
  }, [path]);
  return { src, onError };
}

// 포털이어도 React 이벤트는 메시지 행으로 올라간다(길게 누르기·행 키보드) — 크게 보기 안의 입력은 여기서 멈춘다(검수 M5와 같은 이유)
const stop = (e) => e.stopPropagation();
const STOPS = { onPointerDown: stop, onPointerUp: stop, onClick: stop, onContextMenu: stop, onKeyDown: stop, onTouchStart: stop, onTouchEnd: stop, onDoubleClick: stop };

/** 메시지의 첨부 줄 — 사진 묶음 + 파일 말풍선 */
export function MediaAttachments({ atts, onError, rowTab = 0, mine = false }) {
  const t = useTr();
  const tab = rowTab === 0 ? undefined : -1; // 서명 URL 뒤 늦게 붙는 버튼은 행의 로빙 효과가 놓친다 — 직접 탭 순서 밖으로(검수 K10)
  const [failed, setFailed] = useState(() => new Set());
  const { images, files } = useMemo(() => splitAttachments(atts, failed), [atts, failed]);
  const [open, setOpen] = useState(null);
  const markFailed = useCallback((id) => setFailed((s) => (s.has(id) ? s : new Set(s).add(id))), []);
  return (
    <div className={`msgr-media${mine ? ' mine' : ''}`}>
      {images.length > 0 && <ImageGroup images={images} onOpen={setOpen} onFail={markFailed} tab={tab} t={t} />}
      {files.map((a) => <FileBubble key={a.id ?? a.storage_path} a={a} tab={tab} t={t} onError={onError} />)}
      {open != null && images[open] && <Lightbox items={images} start={open} onClose={() => setOpen(null)} t={t} />}
    </div>
  );
}

function ImageGroup({ images, onOpen, onFail, tab, t }) {
  if (images.length === 1) return <Thumb a={images[0]} single onOpen={() => onOpen(0)} onFail={onFail} tab={tab} t={t} />;
  let k = 0;
  return (
    <div className="msgr-mgrid" role="group" aria-label={t('media.group', { n: images.length })}>
      {gridRows(images.length).map((cols, r) => (
        <div className="mrow" key={r} style={{ '--cols': cols }}>
          {Array.from({ length: cols }, () => { const i = k++; const a = images[i]; return <Thumb key={a.id ?? a.storage_path} a={a} onOpen={() => onOpen(i)} onFail={onFail} tab={tab} t={t} />; })}
        </div>
      ))}
    </div>
  );
}

function Thumb({ a, single = false, onOpen, onFail, tab, t }) {
  const { src, onError } = useSignedSrc(a.storage_path, () => onFail(a.id));
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" className={`msgr-thumb${single ? ' single' : ''}${loaded ? ' loaded' : ''}`} tabIndex={tab} aria-label={t('media.view', { name: a.name })} onClick={onOpen}>
      {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={onError} />}
    </button>
  );
}

/** 파일 말풍선 — 누르면 받기(폰 앱은 열기·공유 시트, 데스크톱 앱은 다운로드 폴더, 브라우저는 내려받기) */
function FileBubble({ a, tab, t }) {
  const v = fileView(a, 30);
  const [st, setSt] = useState({ phase: 'idle', p: null, path: null });
  const run = async () => {
    if (st.phase === 'busy') return;
    if (st.phase === 'done' && st.path) { revealSaved(st.path); return; }
    setSt({ phase: 'busy', p: null, path: null });
    try {
      const r = await openAttachment(a, { onProgress: (p) => setSt((s) => ({ ...s, p })) });
      setSt({ phase: r?.where === 'downloads' || r?.where === 'browser' ? 'done' : 'idle', p: null, path: r?.path ?? null, where: r?.where });
    } catch { setSt({ phase: 'fail', p: null, path: null }); }
  };
  const sub = st.phase === 'busy' ? (st.p == null ? t('file.downloadingAny') : t('file.downloading', { p: Math.round(st.p * 100) }))
    : st.phase === 'fail' ? t('file.failed')
    : st.phase === 'done' ? (st.where === 'downloads' ? t('file.savedDownloads') : t('file.saved'))
    : [v.ext, v.size].filter(Boolean).join(' · ');
  return (
    <button type="button" className={`msgr-fileb k-${v.kind}${st.phase === 'fail' ? ' fail' : ''}`} tabIndex={tab} title={v.full} onClick={run}
      aria-label={t('file.open', { name: v.full })} aria-busy={st.phase === 'busy' || undefined}>
      <span className="fic" aria-hidden="true"><I name={v.icon} size={22} /></span>
      <span className="fmeta"><span className="fname"><span className="fh">{v.head}</span><span className="ft">{v.tail}</span></span><span className="fsub" aria-live="polite">{sub}</span></span>
      <span className="fact" aria-hidden="true">{st.phase === 'busy' ? <span className="msgr-spin" /> : <I name={st.phase === 'fail' ? 'retry' : 'download'} size={18} />}</span>
      {st.phase === 'busy' && st.p != null && <span className="fbar" style={{ '--p': st.p }} aria-hidden="true" />}
    </button>
  );
}

/** 크게 보기 — 같은 메시지의 사진들. 사진 뷰어는 테마와 상관없이 어두운 바탕(사진 색이 바래지 않게). */
export function Lightbox({ items, start = 0, onClose, t }) {
  const [i, setI] = useState(start);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState({ dx: 0, dy: 0, on: false });
  const [chrome, setChrome] = useState(true);
  const [note, setNote] = useState(null); // { text, err, reveal }
  const [busy, setBusy] = useState('');
  const [held, setHeld] = useState(false); // 손가락·마우스가 닿아 있는 동안은 전환 효과 없이 바로 따라간다
  const caps = useMemo(() => currentCaps(), []);
  const a = items[i];
  const stage = useRef(null); const img = useRef(null); const closeBtn = useRef(null);
  const ptrs = useRef(new Map()); const g = useRef(null); const lastTap = useRef(null); const tapTimer = useRef(0);
  const live = useRef(); live.current = { view, i };
  const { src, onError } = useSignedSrc(a?.storage_path, () => setNote({ text: t('media.loadFail'), err: true }));

  const viewport = () => ({ w: stage.current?.clientWidth || 1, h: stage.current?.clientHeight || 1 });
  const box = () => ({ w: img.current?.offsetWidth || 1, h: img.current?.offsetHeight || 1 });
  const center = (x, y) => { const r = stage.current.getBoundingClientRect(); return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 }; };
  const settle = (v) => setView(clampPan(v, box(), viewport()));
  const go = useCallback((d) => { setI((x) => Math.min(items.length - 1, Math.max(0, x + d))); setView({ z: 1, x: 0, y: 0 }); setDrag({ dx: 0, dy: 0, on: false }); }, [items.length]);
  const zoomBy = (k) => settle(zoomAt(live.current.view, live.current.view.z * k, { x: 0, y: 0 }));

  useEffect(() => { for (const j of [i - 1, i + 1]) if (items[j]) signedUrl(items[j].storage_path).then((u) => { const im = new Image(); im.src = u; }).catch(() => {}); }, [i, items]); // 옆 장 미리 받기
  useEffect(() => { if (!note) return undefined; const id = setTimeout(() => setNote(null), note.reveal ? 5000 : 2600); return () => clearTimeout(id); }, [note]);
  useEffect(() => {
    const before = document.activeElement;
    closeBtn.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      const k = e.key;
      if (k === 'Escape') onClose();
      else if (k === 'ArrowRight') go(1);
      else if (k === 'ArrowLeft') go(-1);
      else if (k === '+' || k === '=') zoomBy(1.25);
      else if (k === '-') zoomBy(0.8);
      else if (k === '0') setView({ z: 1, x: 0, y: 0 });
      else return;
      e.preventDefault(); e.stopPropagation(); // 채널 닫기 등 앱 전역 Esc보다 먼저
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(tapTimer.current); before?.focus?.({ preventScroll: true }); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 열릴 때 한 번(go·zoomBy는 live 값을 읽는다)
  useEffect(() => { // 휠·트랙패드 확대 — 페이지 스크롤을 막아야 해 passive:false로 직접 단다
    const el = stage.current; if (!el) return undefined;
    const onWheel = (e) => { e.preventDefault(); const p = center(e.clientX, e.clientY); settle(zoomAt(live.current.view, wheelZoom(live.current.view.z, e.deltaY * (e.ctrlKey ? 4 : 1)), p)); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e) => {
    setHeld(true);
    try { stage.current.setPointerCapture?.(e.pointerId); } catch { /* 이미 끝난 포인터 — 붙잡지 못해도 제스처는 이어간다 */ }
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = live.current.view;
    if (ptrs.current.size === 2) {
      const [p1, p2] = [...ptrs.current.values()];
      g.current = { mode: 'pinch', d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, mid0: center((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), v0: v };
      setDrag({ dx: 0, dy: 0, on: false });
    } else if (ptrs.current.size === 1) {
      g.current = { mode: 'one', sx: e.clientX, sy: e.clientY, t0: performance.now(), v0: v, axis: null, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }], target: e.target };
    }
  };
  const move = (e) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current; if (!s) return;
    if (s.mode === 'pinch' && ptrs.current.size >= 2) {
      const [p1, p2] = [...ptrs.current.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y); const mid = center((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      const z = zoomAt(s.v0, clampZoom(s.v0.z * (d / s.d0)), s.mid0);
      settle({ z: z.z, x: z.x + (mid.x - s.mid0.x), y: z.y + (mid.y - s.mid0.y) });
      return;
    }
    if (s.mode !== 'one') return;
    const dx = e.clientX - s.sx; const dy = e.clientY - s.sy;
    s.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() }); while (s.samples.length > 2 && performance.now() - s.samples[0].t > 100) s.samples.shift();
    if (!s.axis) { if (Math.hypot(dx, dy) < 6) return; s.axis = s.v0.z > 1.01 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    if (s.axis === 'pan') settle({ z: s.v0.z, x: s.v0.x + dx, y: s.v0.y + dy });
    else if (s.axis === 'x') setDrag({ dx: items.length > 1 ? dx : dx * 0.25, dy: 0, on: true });
    else setDrag({ dx: 0, dy: Math.max(-40, dy), on: true });
  };
  const up = (e) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    if (!ptrs.current.size) setHeld(false);
    const s = g.current; if (!s) return;
    if (s.mode === 'pinch') {
      if (ptrs.current.size === 1) { const [p] = [...ptrs.current.values()]; g.current = { mode: 'one', sx: p.x, sy: p.y, t0: performance.now(), v0: live.current.view, axis: 'pan', samples: [] }; }
      else { g.current = null; if (live.current.view.z < 1.02) setView({ z: 1, x: 0, y: 0 }); }
      return;
    }
    g.current = null;
    const dx = e.clientX - s.sx; const dy = e.clientY - s.sy;
    const first = s.samples[0]; const dt = first ? Math.max(1, performance.now() - first.t) : 1;
    const vx = first ? (e.clientX - first.x) / dt : 0; const vy = first ? (e.clientY - first.y) / dt : 0;
    if (!s.axis) { // 탭
      const tap = { t: performance.now(), x: e.clientX, y: e.clientY };
      if (isDoubleTap(lastTap.current, tap)) {
        clearTimeout(tapTimer.current); lastTap.current = null;
        const v = live.current.view;
        settle(v.z > 1.01 ? { z: 1, x: 0, y: 0 } : zoomAt(v, DOUBLE_TAP_ZOOM, center(e.clientX, e.clientY)));
        return;
      }
      lastTap.current = tap;
      const onPhoto = s.target === img.current;
      const mouse = e.pointerType === 'mouse';
      clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => { if (mouse && !onPhoto) onClose(); else setChrome((c) => !c); }, 260); // 두 번 탭과 가르려고 잠깐 기다린다
      return;
    }
    if (s.axis === 'x') {
      const dir = swipeDecision({ dx, vx, width: viewport().w, zoom: live.current.view.z, index: live.current.i, count: items.length });
      if (dir) go(dir); else setDrag({ dx: 0, dy: 0, on: false });
    } else if (s.axis === 'y') {
      if (dismissDecision({ dy, vy, zoom: live.current.view.z })) onClose(); else setDrag({ dx: 0, dy: 0, on: false });
    }
  };
  const cancel = (e) => { ptrs.current.delete(e.pointerId); if (!ptrs.current.size) setHeld(false); g.current = null; setDrag({ dx: 0, dy: 0, on: false }); };

  const act = async (kind) => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'save') {
        const r = await saveAttachment(a);
        if (!r?.cancelled) setNote({ text: t({ photos: 'media.savedPhotos', files: 'media.savedFiles', downloads: 'media.savedDownloads' }[r?.where] ?? 'media.saved'), reveal: r?.where === 'downloads' ? r.path : null });
      } else if (kind === 'share') await shareAttachment(a);
      else if (kind === 'copyImage') { await copyImage(a); setNote({ text: t('media.copiedImage') }); }
      else if (kind === 'copyLink') { await copyLink(a); setNote({ text: t('media.copiedLink') }); }
    } catch {
      setNote({ text: t(kind === 'save' ? 'media.saveFail' : kind === 'share' ? 'media.shareFail' : 'media.copyFail'), err: true });
    } finally { setBusy(''); }
  };

  if (!a) return null;
  const fade = drag.dy > 0 ? Math.max(0.35, 1 - drag.dy / 400) : 1;
  const tf = `translate3d(${view.x + drag.dx}px, ${view.y + drag.dy}px, 0) scale(${view.z})`;
  const btn = (kind, icon, label) => (
    <button key={kind} type="button" className="lb-act" onClick={() => act(kind)} disabled={!!busy} aria-busy={busy === kind || undefined}>
      {busy === kind ? <span className="msgr-spin" /> : <I name={icon} size={22} />}<span>{label}</span>
    </button>
  );
  return createPortal(
    <div className={`msgr-viewer${chrome ? '' : ' bare'}`} role="dialog" aria-modal="true" aria-label={t('media.viewer')} style={{ '--lb-fade': fade }} {...STOPS}>
      <div className="lb-top">
        <button ref={closeBtn} type="button" className="lb-icon" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={24} /></button>
        <div className="lb-title"><span className="lb-name" title={a.name}>{a.name}</span>{items.length > 1 && <span className="lb-count">{t('media.count', { i: i + 1, n: items.length })}</span>}</div>
        <span className="lb-icon ghost" aria-hidden="true" />
      </div>
      <div ref={stage} className="lb-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
        {src && <img ref={img} key={a.storage_path} src={src} alt={a.name} draggable={false} onError={onError}
          className={held || drag.on ? 'dragging' : ''} style={{ transform: tf }} />}
        {!src && <span className="msgr-spin lg" role="status" aria-label={t('ui.loading')} />}
      </div>
      {items.length > 1 && i > 0 && <button type="button" className="lb-nav prev" onClick={() => go(-1)} aria-label={t('media.prev')}><I name="prev" size={28} /></button>}
      {items.length > 1 && i < items.length - 1 && <button type="button" className="lb-nav next" onClick={() => go(1)} aria-label={t('media.next')}><I name="next" size={28} /></button>}
      <div className="lb-bottom">
        {caps.save && btn('save', 'download', t('media.save'))}
        {caps.share && btn('share', 'share', t('media.share'))}
        {caps.copyImage && btn('copyImage', 'image', t('media.copyImage'))}
        {caps.copyLink && btn('copyLink', 'link', t('media.copyLink'))}
      </div>
      {note && <div className={`lb-note${note.err ? ' err' : ''}`} role="status">{note.text}{note.reveal && <button type="button" className="lb-reveal" onClick={() => revealSaved(note.reveal)}>{t('media.reveal')}</button>}</div>}
    </div>, document.body,
  );
}

/** 링크 카드 — meta.link_preview(보낼 때 한 번 저장)만 그린다. 누르면 외부 브라우저. */
export function LinkCard({ m, tab }) {
  const t = useTr();
  const p = useMemo(() => previewFor(m), [m]);
  const [imgOk, setImgOk] = useState(true);
  if (!p || !openable(p.url)) return null; // 앱에서 못 여는 http 카드는 그리지 않는다(위 openable)
  return (
    <button type="button" className="msgr-linkcard" tabIndex={tab} title={p.url} aria-label={t('link.open', { host: p.host })} onClick={(e) => { e.stopPropagation(); openExternalUrl(p.url); }}>
      {p.image && imgOk && <span className="lc-img"><img src={p.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setImgOk(false)} /></span>}
      <span className="lc-body">
        {p.site && <span className="lc-site">{p.site}</span>}
        {p.title && <span className="lc-title">{p.title}</span>}
        {p.description && <span className="lc-desc">{p.description}</span>}
        <span className="lc-host"><I name="link" size={12} />{p.host}</span>
      </span>
    </button>
  );
}

/** 본문 링크를 누를 수 있게 — 링크 밖 글자는 renderText(조각, 키)로(멘션 강조 등). HTML로 넣지 않는다. */
export function linkify(text, renderText = (s) => s) {
  return urlSegments(text).map((seg, k) => (seg.url && openable(seg.url)
    ? <a key={`u${k}`} className="msgr-link" href={seg.url} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternalUrl(seg.url); }}>{seg.text}</a>
    : <span key={`t${k}`}>{renderText(seg.text, k)}</span>));
}

/** 마크다운(에이전트 답) 속 http(s) 링크 — Tauri 웹뷰는 새 창을 막으므로 외부 브라우저로 연다(위임 클릭 처리기). */
export function onLinkClick(e) {
  const el = e.target?.closest?.('a[href]');
  if (!el) return;
  const href = el.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault(); e.stopPropagation();
  if (openable(href)) openExternalUrl(href);
}
