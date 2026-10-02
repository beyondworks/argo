// 오른쪽 패널 공용(유건 9/30 #8) — 결재·일정·문서·산출물·업무 카드가 모두 이 한 모양을 쓴다.
// 왼쪽 가장자리를 끌거나(손잡이에 초점을 두고 ←/→·Home/End) 폭을 바꾸고, 머리의 버튼 하나로 전체 화면을 펼치고 되돌린다.
// 폭·전체 화면 여부는 이 기기에 사람마다 기억한다(localStorage). 폰 폭(768px 미만)은 늘 전체 폭 — 손잡이·펼치기 버튼이 없다.
// 첫 화면 묶음에 싣지 않는다(쓰는 화면이 모두 지연 로드) — 폭 규칙은 panel-model.js.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { t, registerDict } from '../core/i18n.js';
import { useDialog } from './Overlay.jsx';
import { Icon } from './Icon.jsx';
import { PANEL_DICT } from './panel-i18n.js';
import { PANEL_MIN, clampWidth, widthForKey, readPref, maxWidth } from './panel-model.js';

registerDict(PANEL_DICT);

const KEY = 'argo-office-panel';
const load = () => { try { return readPref(localStorage.getItem(KEY), localStorage.getItem('argo-office-peek')); } catch { return readPref(null, null); } };
const keep = (value) => { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* 사생활 창 등 — 기억만 못 한다 */ } };

/** 펼치기·되돌리기 — Material Symbols open_in_full·close_fullscreen(ui/icon-names.js) */
const FullIcon = ({ full }) => <Icon name={full ? 'collapse' : 'expand'} />;

export function Panel({ onClose, title, children, footer }) {
  const [pref, setPref] = useState(load);
  const ref = useDialog(true, onClose);
  const save = (patch) => setPref((old) => { const next = { ...old, ...patch }; keep(next); return next; });
  const viewport = window.innerWidth, width = clampWidth(pref.width, viewport), full = pref.full;
  const drag = (event) => { // 끄는 동안은 화면만 바꾸고 놓을 때 기억한다
    if (event.button !== 0) return;
    event.preventDefault();
    const el = event.currentTarget;
    el.setPointerCapture?.(event.pointerId);
    document.body.classList.add('edge-drag-x');
    const move = (e) => setPref((old) => ({ ...old, width: clampWidth(window.innerWidth - e.clientX, window.innerWidth) }));
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove('edge-drag-x');
      setPref((old) => { keep(old); return old; });
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const onKey = (event) => { const next = widthForKey(event.key, width, window.innerWidth); if (next != null) { event.preventDefault(); save({ width: next }); } };
  return createPortal(
    <div className="scrim scrim-sheet" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} className={`sheet panel${full ? ' full' : ''}`} style={full ? undefined : { '--panel-w': `${width}px` }} role="dialog" aria-modal="true" aria-label={title}>
        {!full && <span className="panel-resize" role="separator" aria-orientation="vertical" aria-label={t('panel.resize')} aria-valuenow={width} aria-valuemin={PANEL_MIN} aria-valuemax={maxWidth(viewport)} tabIndex={0} onPointerDown={drag} onKeyDown={onKey} />}
        <header className="modal-head"><h2>{title}</h2>
          {/* class x: 창이 열릴 때 첫 초점 후보에서 뺀다(useDialog) */}
          <button type="button" className="icon-btn x panel-full-btn" aria-label={t(full ? 'panel.restore' : 'panel.full')} title={t(full ? 'panel.restore' : 'panel.full')} onClick={() => save({ full: !full })}><FullIcon full={full} /></button>
          <button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/** 예전 Sheet 자리 — open이 거짓이면 그리지 않는다 */
export function Sheet({ open, ...props }) {
  return open ? <Panel {...props} /> : null;
}
