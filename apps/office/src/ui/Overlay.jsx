// 모달·시트·토스트 — portal로 body에 붙인다(transform 조상이 fixed를 깨뜨리는 문제 회피, 본체 규칙).
// 스크롤 잠금은 참조 카운트(겹친 모달이 서로의 잠금을 풀지 않게).
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { t } from '../core/i18n.js';

let locks = 0;
function useScrollLock(on) {
  useEffect(() => {
    if (!on) return;
    if (locks++ === 0) document.documentElement.classList.add('scroll-locked');
    return () => { if (--locks === 0) document.documentElement.classList.remove('scroll-locked'); };
  }, [on]);
}

function useDialog(open, onClose) {
  const ref = useRef(null);
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement;
    // autoFocus 대신 마운트 뒤 포커스 — 폰에서는 키보드가 튀어나오지 않게 생략
    if (!matchMedia('(pointer: coarse)').matches) ref.current?.querySelector('input, textarea, select, button:not(.x)')?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) { // 포커스를 대화상자 안에 가둔다
        const f = [...ref.current.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); back?.focus?.({ preventScroll: true }); };
  }, [open, onClose]);
  return ref;
}

export function Modal({ open, onClose, title, children, width = 480, footer }) {
  const ref = useDialog(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <header className="modal-head"><h2>{title}</h2><button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet({ open, onClose, title, children, footer }) {
  const ref = useDialog(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="scrim scrim-sheet" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><h2>{title}</h2><button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button></header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/* ── 토스트: 한 번에 하나, 되돌릴 수 있는 동작은 "되돌리기"를 붙인다(확인 창 대신) ── */
let toast = null, timer = null;
const tl = new Set();
const temit = () => tl.forEach((l) => l());
export function showToast(message, { undo } = {}) {
  clearTimeout(timer);
  toast = { message, undo, key: Date.now() }; temit();
  timer = setTimeout(() => { toast = null; temit(); }, undo ? 6000 : 3000);
}
export function ToastHost() {
  const cur = useSyncExternalStore((l) => { tl.add(l); return () => tl.delete(l); }, () => toast);
  if (!cur) return null;
  return createPortal(
    <div className="toast" role="status" aria-live="polite" key={cur.key}>
      <span>{cur.message}</span>
      {cur.undo && <button type="button" className="toast-undo" onClick={() => { cur.undo(); toast = null; temit(); }}>{t('undo')}</button>}
    </div>,
    document.body,
  );
}
