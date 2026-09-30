// 노션식 열기(유건 9/29) — 옆에서 열기(왼쪽 가장자리를 끌어 폭 조절)·가운데에서 열기·전체 화면. 고른 방식과 폭은 이 기기에 기억한다.
// 업무 화면(거래·거래처·상품 카드)과 함께 지연 로드된다.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../core/i18n.js';
import { useDialog } from './Overlay.jsx';
import { openMenu } from './Menu.jsx';
import { Icon } from './Icon.jsx';

const KEY = 'argo-office-peek';
const MODES = ['side', 'center', 'full'];
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const keep = (value) => { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* 사생활 창 등 — 기억만 못 한다 */ } };
const clampWidth = (w) => Math.round(Math.max(420, Math.min(w, window.innerWidth - 240)));

export function Peek({ onClose, title, children }) {
  const [pref, setPref] = useState(() => { const p = read(); return { mode: MODES.includes(p.mode) ? p.mode : 'side', width: Number(p.width) || 640 }; });
  const ref = useDialog(true, onClose);
  const set = (patch) => setPref((old) => { const next = { ...old, ...patch }; keep(next); return next; });
  const mode = pref.mode, width = clampWidth(pref.width);
  const resize = (event) => { // 왼쪽 가장자리를 끌면 폭이 바뀐다(놓을 때 기억)
    event.preventDefault();
    const el = event.currentTarget; el.setPointerCapture?.(event.pointerId);
    const move = (e) => setPref((old) => ({ ...old, width: clampWidth(window.innerWidth - e.clientX) }));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); setPref((old) => { keep(old); return old; }); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const resizeKey = (event) => { const step = event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0; if (step) { event.preventDefault(); set({ width: clampWidth(width + step) }); } };
  const modeMenu = (event) => openMenu(event, MODES.map((m) => ({ label: t(`peek.${m}`), checked: mode === m, run: () => set({ mode: m }) })), { anchor: event.currentTarget });
  return createPortal(
    <div className={`scrim peek-scrim peek-${mode}`} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} className={`peek peek-${mode}`} style={mode === 'side' ? { width } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        {mode === 'side' && <span className="peek-resize" role="separator" aria-orientation="vertical" aria-label={t('peek.resize')} tabIndex={0} onPointerDown={resize} onKeyDown={resizeKey} />}
        <header className="modal-head"><h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('peek.mode')} title={t('peek.mode')} onClick={modeMenu}><Icon name="layout" /></button>
          <button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button></header>
        <div className="sheet-body peek-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
