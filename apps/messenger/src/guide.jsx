import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { guideSteps, PHONE_TABS_MARK, resolveStep, usableBox, mostlyVisible, spotRect, tooTall, clipTo, placeCard } from './guide.mjs';
import './guide.css';

// 첫 사용 안내 화면(유건 결정 2026-10-01) — 실제 버튼·영역을 밝히고 나머지는 어둡게, 옆에 짧은 설명과 다음·건너뛰기.
// 판정·좌표 계산은 guide.mjs(순수, 테스트 대상). 여기는 DOM을 재고 그린다.
// 안전 영역·키보드·회전·창 크기·테마가 바뀌면 다시 잰다(이벤트 + 0.4초 확인 — 목록이 늦게 그려져도 따라간다).

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readSafe(probe) { // env(safe-area-inset-*)는 JS에서 바로 못 읽는다 — 그 값을 padding으로 받은 숨은 요소에서 읽는다
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

function viewSize() {
  const vv = window.visualViewport;
  return { w: Math.round(Math.min(window.innerWidth, vv?.width ?? Infinity)), h: Math.round(Math.min(window.innerHeight, vv?.height ?? Infinity)) };
}

const box4 = (r) => ({ left: r.left, top: r.top, width: r.width, height: r.height });

// 스크롤 목록처럼 넘친 내용을 자르는 조상들의 칸 — 그 밖으로 나간 부분은 화면에 안 보인다
function clipsOf(el) {
  const out = [];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(box4(p.getBoundingClientRect()));
  }
  return out;
}

// 그 지점에서 실제로 눌리는 요소가 대상(또는 그 안)인가 — 다른 화면·시트에 덮였으면 거짓
function onTop(el, r, root) {
  const hit = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((n) => !root?.contains(n));
  return !!hit && el.contains(hit);
}

/** 대상 하나를 찾는다 — 보이는 첫 요소의 '보이는 부분'. 가려졌거나 잘렸으면 한 번 스크롤해 데려온다(요소마다 한 번). */
function locate(target, { view, root, scrolled, maxShare }) {
  const box = usableBox(view, null, 0); // 보이는지는 화면 전체 기준 — 탭 바처럼 홈 바 자리에 걸친 요소도 보인다
  for (const found of document.querySelectorAll(target.sel)) {
    if (root?.contains(found)) continue;
    const full0 = found.getBoundingClientRect();
    if (full0.width < 2 || full0.height < 2 || getComputedStyle(found).visibility === 'hidden') continue;
    const el = target.head && tooTall(full0, view, maxShare) ? found.querySelector(target.head) ?? found : found; // 긴 목록은 머리만
    const visible = () => { const full = box4(el.getBoundingClientRect()); const vis = clipTo(full, clipsOf(el)); return vis && (vis.width * vis.height) / (full.width * full.height) >= 0.9 && mostlyVisible(vis, box, 0.9) && onTop(el, vis, root) ? vis : null; };
    let vis = visible();
    if (!vis && !scrolled.has(el)) {
      scrolled.add(el);
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch { /* 옛 웹뷰 */ }
      vis = visible();
    }
    if (vis) return vis;
  }
  return null;
}

export function GuideTour({ t, phone = false, onDone }) {
  // 단계 목록 — 폰이고 새 셸(아래 탭 표지)이 그려져 있으면 탭 소개, 그 밖은 데스크톱 표(guide.mjs)
  const steps = guideSteps({ phone, phoneTabs: phone && !!document.querySelector(PHONE_TABS_MARK) });
  const [idxRaw, setIdx] = useState(0);
  const idx = Math.min(idxRaw, steps.length - 1); // 안내 중 창 폭이 바뀌어 표가 바뀌어도 범위 안에서
  const [layout, setLayout] = useState({ title: steps[0].title, body: steps[0].body, spot: null, view: viewSize(), safe: null });
  const [pos, setPos] = useState(null);
  const rootRef = useRef(null); const cardRef = useRef(null); const safeRef = useRef(null); const primaryRef = useRef(null);
  const scrolled = useRef(new WeakSet());
  const ids = useId(); const titleId = `${ids}-t`; const bodyId = `${ids}-b`; const keysId = `${ids}-k`;
  const step = steps[idx]; const last = idx === steps.length - 1;

  const measure = useCallback(() => {
    const view = viewSize(); const safe = readSafe(safeRef.current); const root = rootRef.current;
    let spot = null;
    const r = resolveStep(step, (target) => { const vis = locate(target, { view, root, scrolled: scrolled.current, maxShare: phone ? 0.4 : 0.55 }); spot = vis && spotRect(vis, { view }); return !!spot; });
    const next = { title: r.title, body: r.body, spot, view, safe };
    setLayout((cur) => (same(cur, next) ? cur : next));
  }, [step, phone]);

  const layoutRef = useRef(layout); layoutRef.current = layout;
  const place = useCallback(() => { // 카드 크기를 잰 뒤 자리를 정한다 — 문구·폰 폭 전환(카드 너비 320↔360)으로 크기가 바뀌면 다시
    const card = cardRef.current; if (!card) return;
    const L = layoutRef.current;
    const next = placeCard({ spot: L.spot, card: { w: card.offsetWidth, h: card.offsetHeight }, view: L.view, safe: L.safe ?? undefined, phone });
    setPos((cur) => (same(cur, next) ? cur : next));
  }, [phone]);
  useLayoutEffect(() => { scrolled.current = new WeakSet(); measure(); }, [measure]);
  useEffect(() => { // 화면이 바뀌면 다시 잰다 — 회전·창 크기·키보드(visualViewport)·스크롤·늦게 그려지는 목록
    let raf = 0; const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const vv = window.visualViewport;
    window.addEventListener('resize', kick); window.addEventListener('orientationchange', kick); window.addEventListener('scroll', kick, true);
    vv?.addEventListener('resize', kick); vv?.addEventListener('scroll', kick);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(kick) : null; ro?.observe(document.documentElement);
    const iv = setInterval(() => { measure(); place(); }, 400);
    return () => { cancelAnimationFrame(raf); clearInterval(iv); ro?.disconnect(); window.removeEventListener('resize', kick); window.removeEventListener('orientationchange', kick); window.removeEventListener('scroll', kick, true); vv?.removeEventListener('resize', kick); vv?.removeEventListener('scroll', kick); };
  }, [measure, place]);

  useLayoutEffect(() => { place(); }, [layout, place, idx]);
  useEffect(() => { // 카드 크기 변화(폰 폭 전환 뒤 클래스가 늦게 바뀌는 경우 포함 — 390 실측에서 5px 넘침)
    const card = cardRef.current; if (!card || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => place()); ro.observe(card);
    return () => ro.disconnect();
  }, [idx, place]);

  const go = useCallback((d) => { if (d > 0 && last) { onDone('finish'); return; } setIdx((i) => Math.max(0, Math.min(steps.length - 1, Math.min(i, steps.length - 1) + d))); }, [last, onDone, steps.length]);

  useEffect(() => { // 초점은 안내 안에만 — 열 때 '다음'으로, 닫으면 원래 자리로
    const prev = document.activeElement;
    primaryRef.current?.focus({ preventScroll: true });
    const back = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) primaryRef.current?.focus({ preventScroll: true }); };
    document.addEventListener('focusin', back);
    return () => { document.removeEventListener('focusin', back); if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true }); };
  }, []);
  const placed = !!pos;
  useEffect(() => { // 자리를 잡기 전(visibility hidden)에는 초점이 안 간다 — 잡은 뒤에, 다음 프레임에 한 번 더 확인
    if (!placed) return undefined;
    const grab = () => { if (!rootRef.current?.contains(document.activeElement)) primaryRef.current?.focus({ preventScroll: true }); };
    primaryRef.current?.focus({ preventScroll: true });
    const raf = requestAnimationFrame(grab); const tm = setTimeout(grab, 250);
    return () => { cancelAnimationFrame(raf); clearTimeout(tm); };
  }, [idx, placed]);

  useEffect(() => { // 키보드 — 앱의 다른 단축키(검색 ⌘K 등)로 새지 않게 창 단계에서 먼저 받는다
    const on = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone('skip'); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); if (!last) go(1); return; } // 마지막 단계는 버튼으로만 끝낸다(화살표 연타로 닫히지 않게)
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); return; }
      if (e.key === 'Tab') {
        const items = [...(cardRef.current?.querySelectorAll('button:not([disabled])') ?? [])];
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus({ preventScroll: true });
        return;
      }
      if (!rootRef.current?.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [go, onDone, last]);

  const { spot } = layout;
  return createPortal(
    <div ref={rootRef} className={`msgr-guide${phone ? ' phone' : ''}${spot ? '' : ' nospot'}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${bodyId} ${keysId}`}>
      <span ref={safeRef} className="msgr-guide-safe" aria-hidden="true" />
      {spot ? <div className="msgr-guide-spot" aria-hidden="true" style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }} /> : <div className="msgr-guide-dim" aria-hidden="true" />}
      <div key={idx} ref={cardRef} className="msgr-guide-card" data-side={pos?.side ?? 'center'} style={pos ? { left: pos.x, top: pos.y } : { visibility: 'hidden' }}>
        <div className="msgr-guide-text" aria-live="polite">
          <p className="msgr-guide-count">{t('guide.count', { n: idx + 1, total: steps.length })}</p>
          <h2 id={titleId}>{t(layout.title)}</h2>
          <p id={bodyId}>{t(layout.body)}</p>
          {step.note && <p className="msgr-guide-note">{t(step.note)}</p>}
        </div>
        <p id={keysId} className="msgr-guide-sr">{t('guide.keys')}</p>
        <div className="msgr-guide-dots" aria-hidden="true">{steps.map((s, i) => <span key={s.id} className={i === idx ? 'on' : ''} />)}</div>
        <div className="msgr-guide-acts">
          {!last && <button type="button" className="btn ghost sm msgr-guide-skip" onClick={() => onDone('skip')}>{t('guide.skip')}</button>}
          <span className="sp" />
          {idx > 0 && <button type="button" className="btn sm" onClick={() => go(-1)}>{t('guide.prev')}</button>}
          <button ref={primaryRef} type="button" className="btn btn-primary sm" onClick={() => go(1)}>{t(last ? 'guide.done' : 'guide.next')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
