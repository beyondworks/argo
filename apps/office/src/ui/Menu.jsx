// 우클릭 메뉴·드롭다운 — 하나의 메뉴 호스트를 모든 대상이 함께 쓴다(메신저 우클릭 규칙: 커서 위치, 화면 안으로 클램프,
// 화살표·Enter·Esc, 닫으면 포커스 복귀). 하루 수십 번 여는 메뉴라 열고 닫는 애니메이션은 넣지 않는다(emil 규칙).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';

let current = null;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

/** e: 마우스 이벤트(커서 위치) 또는 anchor 요소(버튼 아래). items: {label, icon, shortcut, danger, checked, run} | {sep:true} | {heading} */
export function openMenu(e, items, { anchor } = {}) {
  e?.preventDefault?.(); e?.stopPropagation?.();
  let x = e?.clientX, y = e?.clientY, anchorRect = null;
  if (anchor || x == null) {
    anchorRect = (anchor ?? e.currentTarget).getBoundingClientRect();
    x = anchorRect.left; y = anchorRect.bottom + 4;
  }
  current = { x, y, anchorRect, items: items.filter(Boolean), back: document.activeElement };
  emit();
}
export function closeMenu() {
  if (!current) return;
  const back = current.back; current = null; emit();
  back?.focus?.({ preventScroll: true });
}

const actionable = (it) => it && !it.sep && !it.heading && !it.disabled;

export function MenuHost() {
  const m = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [idx, setIdx] = useState(-1);

  useLayoutEffect(() => {
    setPos(null);
    if (!m || !ref.current) return;
    const vv = window.visualViewport;
    const W = vv?.width ?? innerWidth, H = vv?.height ?? innerHeight;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    let { x, y } = m;
    if (x + w > W - 8) x = Math.max(8, (m.anchorRect ? m.anchorRect.right : x) - w);
    if (y + h > H - 8) y = Math.max(8, (m.anchorRect ? m.anchorRect.top - 4 : y) - h);
    setPos({ x, y });
    setIdx(m.items.findIndex(actionable));
    ref.current.focus({ preventScroll: true });
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const outside = (e) => { if (!ref.current?.contains(e.target)) closeMenu(); };
    const close = () => closeMenu();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close); window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close); document.removeEventListener('scroll', close, true); };
  }, [m]);

  if (!m) return null;
  const step = (d) => {
    const n = m.items.length;
    for (let i = 1; i <= n; i++) { const j = (idx + d * i + n) % n; if (actionable(m.items[j])) { setIdx(j); return; } }
  };
  const run = (it) => { closeMenu(); it.run?.(); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (actionable(m.items[idx])) run(m.items[idx]); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.x ?? m.x, top: pos?.y ?? m.y, visibility: pos ? 'visible' : 'hidden' }}>
      {m.items.map((it, i) => it.sep ? <div key={i} className="menu-sep" role="separator" />
        : it.heading ? <div key={i} className="menu-heading">{it.heading}</div>
          : <button key={i} type="button" role={it.checked != null ? 'menuitemradio' : 'menuitem'} aria-checked={it.checked ?? undefined} disabled={it.disabled}
            className={`menu-item${i === idx ? ' on' : ''}${it.danger ? ' danger' : ''}`} onPointerMove={() => setIdx(i)} onClick={() => run(it)}>
            <span className="menu-ico">{it.face ?? (it.icon && <Icon name={it.icon} size={14} />)}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
            {it.checked && <Icon name="check" size={14} className="menu-check" />}
          </button>)}
    </div>,
    document.body,
  );
}

/** 대상 하나에 우클릭·길게 누르기(터치 450ms, 10px 움직이면 취소)·Shift+F10·메뉴 키를 한 번에 붙인다. */
export function menuProps(build) {
  let timer = null, start = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  return {
    onContextMenu: (e) => openMenu(e, build()),
    onKeyDown: (e) => { if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') openMenu({ preventDefault: () => e.preventDefault(), stopPropagation() {}, currentTarget: e.currentTarget }, build()); },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return;
      fired = false; start = { x: e.clientX, y: e.clientY };
      const target = e.currentTarget;
      timer = setTimeout(() => { fired = true; openMenu({ clientX: start.x, clientY: start.y, currentTarget: target }, build()); }, 450);
    },
    onPointerMove: (e) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); },
    onPointerUp: cancel, onPointerCancel: cancel,
    onClickCapture: (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; } },
  };
}

/** 같은 이름의 이벤트 처리기를 이어 붙인다 — 끌기(dnd-kit)와 우클릭 메뉴가 한 요소에서 onKeyDown 등을 서로 덮지 않게. */
export function mergeHandlers(...objs) {
  const out = {};
  for (const o of objs) for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v !== 'function' || !k.startsWith('on') || !out[k]) { out[k] = v; continue; }
    const prev = out[k];
    out[k] = (e) => { prev(e); if (!e?.defaultPrevented || k !== 'onKeyDown') v(e); };
  }
  return out;
}
