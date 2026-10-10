// 우클릭 메뉴·드롭다운 — 하나의 메뉴 호스트를 모든 대상이 함께 쓴다(메신저 우클릭 규칙: 커서 위치, 화면 안으로 클램프,
// 화살표·Enter·Esc, 닫으면 포커스 복귀). 하루 수십 번 여는 메뉴라 열고 닫는 애니메이션은 넣지 않는다(emil 규칙).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';

let current = null;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

let innerEvent = null; // 안쪽 값(가리기)이 먼저 연 메뉴의 이벤트 — 같은 우클릭으로 바깥 대상(카드·줄)의 메뉴가 열리면 한 메뉴로 합친다

/** e: 마우스 이벤트(커서 위치) 또는 anchor 요소(버튼 아래). items: {label, icon, shortcut, danger, checked, run} | {sep:true} | {heading}
 *  inner: 이 메뉴를 연 뒤에도 이벤트를 바깥으로 보낸다 — 바깥 대상이 메뉴를 열면 그 항목을 앞에, 안쪽 항목을 뒤에 둔다.
 *  카드 제목처럼 가린 값 위에서 우클릭하면 '가리기'만 떠 카드 메뉴(에이전트에게 맡기기 등)에 닿지 못했다(17차 화면 확인) */
export function openMenu(e, items, { anchor, inner = false } = {}) {
  const native = e?.nativeEvent ?? null;
  if (!inner && native && native === innerEvent && current) {
    e.preventDefault?.(); e.stopPropagation?.(); innerEvent = null;
    current = { ...current, items: [...items.filter(Boolean), { sep: true }, ...current.items] };
    emit();
    return;
  }
  innerEvent = inner ? native : null;
  e?.preventDefault?.(); if (!inner) e?.stopPropagation?.();
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
/** 열 때 강조할 항목(10/9 검수: '낮음' 칸에서 ↓로 열고 ↓ Enter를 누르면 '보통'이 골라졌다) — 값 고르기 메뉴(맨 처음 고를 수 있는 항목이 표시(checked)를 가진 메뉴 —
 *  표 칸·보기 드롭다운·공간 바꾸기·거르기)면 지금 값으로 표시된 항목, 아니면 지금처럼 맨 위. 동작 메뉴 중간에 섞인 표시(우클릭의 '상태 바꾸기', 페이지 메뉴의 '제한' 켜짐)는
 *  고르지 않는다 — 열자마자 Enter를 눌렀을 때 켜 둔 것을 끄지 않게 */
export const startIndex = (items) => {
  const first = items.findIndex(actionable), on = items.findIndex((it) => actionable(it) && it.checked);
  return first >= 0 && items[first].checked != null && on >= 0 ? on : first;
};

export function MenuHost() {
  const m = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [idx, setIdx] = useState(-1);

  // 자리를 재기 전에는 opacity 0 — visibility:hidden이면 처음 여는 메뉴에 초점이 안 가 키보드(↓·Enter)로 못 골랐다
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
    setIdx(startIndex(m.items));
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
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(); } // Esc는 메뉴만 닫는다 — 하루 목록 창 같은 바깥 창까지 닫지 않게(#925 검수)
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.x ?? m.x, top: pos?.y ?? m.y, opacity: pos ? 1 : 0 }}>
      {m.items.map((it, i) => it.sep ? <div key={i} className="menu-sep" role="separator" />
        : it.heading ? <div key={i} className="menu-heading">{it.heading}</div>
          : <button key={i} type="button" role={it.checked != null ? 'menuitemradio' : 'menuitem'} aria-checked={it.checked} disabled={it.disabled}
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

/** 이벤트가 실제 DOM 안에서 났는가 — 포털(body에 붙은 패널·대화창)의 React 이벤트는 트리를 따라 부모까지 올라오므로, 그 부모의 메뉴가 열리지 않게 거른다. */
export const fromInside = (e) => e.currentTarget.contains(e.target);

/** 대상 하나에 우클릭·길게 누르기(터치 450ms, 10px 움직이면 취소)·Shift+F10·메뉴 키를 한 번에 붙인다. */
export function menuProps(build) {
  let timer = null, start = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  return {
    // 끌어서 고른 칸(data-cell-on) 위 우클릭은 전역 '칸 N개 가리기' 메뉴(ui/marquee.js)에 맡긴다 — 카드 메뉴가 가로채던 것(17차 A 검수 MEDIUM-3)
    onContextMenu: (e) => { if (fromInside(e) && !e.target.closest?.('[data-cell-on]')) openMenu(e, build()); },
    onKeyDown: (e) => { if (fromInside(e) && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) openMenu({ preventDefault: () => e.preventDefault(), stopPropagation() {}, currentTarget: e.currentTarget }, build()); },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch' || !fromInside(e)) return;
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
