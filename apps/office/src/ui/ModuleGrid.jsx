import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDndMonitor } from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { Icon } from './Icon.jsx';
import { openMenu, menuProps, mergeHandlers } from './Menu.jsx';
import { Link } from '../core/router.jsx';
import { t } from '../core/i18n.js';
import { spanOf, spanRange, heightOf, rowInfo } from '../core/layout.js';
import { moduleDrag, sideOf } from '../core/module-drag.js';
import { flipPrepare } from '../core/motion.js';

const gridStrategy = () => null;
// 가장자리 끌기(유건 10/1) — 손잡이는 늘 그리고, 끄는 코드는 처음 다가갈 때 불러온다(첫 화면 150KB 상한)
const EDGES = ['l', 'r', 't', 'b'];
let resizer;
const loadResizer = () => (resizer ??= import('./module-resize.js').catch((error) => { resizer = null; throw error; })); // 실패하면 다음에 다시 받는다(배포 뒤 옛 탭)

function ModuleCard({ item, space, items, row, canEdit, editable, scope, commit, resolveModule, bodyClassName }) {
  const mod = resolveModule(item), rh = row.h;
  const keyboardTarget = useRef(null);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({ id: JSON.stringify([scope, item.id]), disabled: !canEdit, data: { kind: 'module', id: item.id, group: scope, label: mod.title, keyboardTarget } });
  const card = useRef(null);
  // 높이 손잡이가 알리는 값 = 지금 카드 높이(8px 눈금) — 정한 적 없는 줄은 내용대로라 그릴 때 값이 없다. 크기가 바뀔 때마다(내용·끌기·좁은 폭) 다시 잰다
  useEffect(() => {
    const el = card.current;
    if (!editable || !el) return;
    const ro = new ResizeObserver(() => el.querySelectorAll(':scope > .edge-y').forEach((node) => node.setAttribute('aria-valuenow', Math.round(el.offsetHeight / 8) * 8)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editable]);
  const set = (patch) => commit(items.map((x) => (x.id === item.id ? { ...x, ...patch } : x)));
  // 끄기·키보드·두 번 누르기는 module-resize.js가 맡는다 — 지금 자리(DOM)와 항목을 넘긴다
  const edge = (kind, e, side) => loadResizer().then((m) => card.current && m[kind]?.({ el: card.current, items, modOf: resolveModule, commit, canEdit }, e, side), () => {});
  const own = useRef(null); // 카드 본문이 더하는 메뉴(예: 여러 보기의 보기 고르기)
  const menu = () => !canEdit ? [...(own.current?.() ?? []), { heading: t('home.readOnly') }] : [
    ...(own.current?.() ?? []),
    ...(mod.actions?.length ? [...mod.actions, { sep: true }] : []),
    ...('span' in item || rh ? [{ label: t('mod.size.reset'), icon: 'resize', run: () => edge('resetAll') }] : []),
    { label: t('mod.hide'), icon: 'x', run: () => set({ hidden: true }) },
  ];
  const Body = mod.render, span = spanOf(item), [lo, hi] = spanRange(mod.sizes);
  return (
    <section ref={(el) => { setNodeRef(el); card.current = el; }} data-mod={item.id} className={`module size-${item.size}${rh ? ' sized-h' : ''}${heightOf(item) ? ' own-h' : ''}${isDragging ? ' dragging' : ''}`}
      style={{ '--span': span, ...(rh ? { '--rh': `${rh}px`, '--mh': heightOf(item) ? `${item.h}px` : 'auto' } : {}) }} aria-label={mod.title} {...menuProps(menu)}>
      <header className="module-head">
        {mod.icon && <Icon name={mod.icon} size={14} className="dim" />}
        <h3>{mod.link ? <Link to={mod.link} className="module-title">{mod.title}</Link> : mod.title}</h3>{/* 제목을 누르면 그 화면으로(유건 9/30 — '모두 보기' 대신) */}
        {canEdit && <button type="button" ref={setActivatorNodeRef} className="grip" aria-label={t('mod.drag')} {...mergeHandlers(attributes, listeners)}><Icon name="grip" size={14} /></button>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
      </header>
      <div className={`module-body${bodyClassName ? ` ${bodyClassName}` : ''}`}><Body space={space} item={item} canEdit={canEdit} menu={own} setCfg={(cfg) => set({ cfg: { ...item.cfg, ...cfg } })} /></div>
      {editable && EDGES.map((side) => { // 저장 중(canEdit 꺼짐)에도 그대로 둔다 — 키보드 초점이 손잡이에 남는다. 그동안은 aria-disabled
        const x = side === 'l' || side === 'r'; // 좌우 = 폭, 위아래 = 높이
        return <span key={side} className={`edge edge-${side} edge-${x ? 'x' : 'y'}`} role="separator" aria-orientation={x ? 'vertical' : 'horizontal'} aria-label={t(x ? 'mod.resize.w' : 'mod.resize.h')}
          aria-valuenow={x ? span : undefined} aria-valuemin={x ? lo : row.min} aria-valuemax={x ? hi : 1200} aria-disabled={!canEdit || undefined} tabIndex={side === 'r' || side === 'b' ? 0 : -1}
          onPointerEnter={() => edge()} onDoubleClick={() => edge('reset', null, side)} onBlur={() => edge('blur')}
          onFocus={(e) => !x && edge('focus', e.currentTarget, side)} // 높이는 지금 보이는 높이·최소를 화면에서 다시 잰다(좁은 폭은 넓은 화면의 줄이 아니라 자기 것)
          onKeyDown={(e) => { if (!e.key.startsWith('Arrow')) return; e.preventDefault(); e.stopPropagation(); edge('key', { key: e.key }, side); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} // 터치 길게 누르기·오른쪽 클릭이 모듈 ⋯ 메뉴를 열지 않게(pointerdown을 막아도 contextmenu는 따로 온다)
          onPointerDown={(e) => { // 길게 누르기 메뉴·끌어 옮기기·글 선택이 같이 시작되지 않게
            e.stopPropagation(); if (e.button) return; e.preventDefault();
            const target = e.currentTarget; target.setPointerCapture(e.pointerId);
            edge('drag', { x: e.clientX, y: e.clientY, id: e.pointerId, target }, side);
          }} />;
      })}
    </section>
  );
}


// locked = 바깥에서 다른 저장이 진행 중(업무 대시보드 business.busy) — 편집 권한(canEdit)과 따로 받아 그동안 손잡이를 빼지 않는다(검수 10/1: 키보드 초점이 사라졌다)
export function ModuleGrid({ id, items, canEdit, locked = false, onChange, resolveModule, space, bodyClassName }) {
  const grid = useRef(null), lock = useRef(null), latest = useRef(null), mounted = useRef(true);
  const [optimistic, setOptimistic] = useState(null), [pendingScope, setPendingScope] = useState(null);
  const [preview, setPreview] = useState(null);
  // 자리가 바뀐 뒤에는 (1) 모듈이 미끄러지는 0.26초 동안, (2) 포인터가 그 자리에서 16px 넘게 움직이기 전까지 다시 재지 않는다.
  // 폭이 다른 모듈이 자리를 바꾸면 줄이 바뀌어 가만히 있는 포인터 밑에 다른 모듈이 온다 — 사용자가 움직일 때만 반응한다(9/30).
  const drag = useRef(null), settle = useRef(0), anchor = useRef(null), last = useRef(null), recheck = useRef(0);
  useEffect(() => () => clearTimeout(recheck.current), []);
  const pending = pendingScope === id;
  latest.current = { id, items, canEdit, locked, onChange };
  const base = optimistic?.id === id ? optimistic.items : items;
  const displayed = preview?.scope === id && preview.source === items && canEdit ? preview.items : base;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (optimistic && (optimistic.id !== id || (!pending && optimistic.source !== items))) setOptimistic(null);
  }, [id, items, pending, optimistic]);
  useLayoutEffect(() => {
    if (drag.current && (drag.current.scope !== id || drag.current.source !== items || !canEdit)) { drag.current = null; setPreview(null); }
  }, [id, items, canEdit]);
  // 순서·폭이 바뀌면 이전 자리에서 미끄러진다 — 자리를 재 두고, 다시 그린 직후(layout effect)에 움직인다
  const flip = useRef(null);
  const animate = (write) => { if (grid.current) flip.current = flipPrepare(grid.current); write(); };
  useLayoutEffect(() => { const run = flip.current; flip.current = null; run?.(); });
  const commit = async (next) => {
    if (lock.current?.id === id || !latest.current.canEdit || latest.current.locked || latest.current.id !== id || !mounted.current) return false;
    const request = { id }, source = latest.current.items, write = latest.current.onChange;
    lock.current = request;
    animate(() => { setOptimistic({ id, source, items: next }); setPendingScope(id); });
    let saved = false;
    try {
      saved = await write(next) !== false;
      return saved;
    } catch { return false; }
    finally {
      if (mounted.current && lock.current === request) {
        if (latest.current.id === id) animate(() => { if (!saved || latest.current.items !== source) setOptimistic(null); setPendingScope(null); });
        else setPendingScope((scope) => scope === id ? null : scope);
      }
      if (lock.current === request) lock.current = null;
    }
  };
  // 포인터(마우스·터치)가 대상 모듈의 앞·뒤 어느 절반에 있는지 붙인다(9/30: 가만히 있어도 자리가 또 바뀌던 결함)
  // 실제 포인터 좌표 — '누른 자리 + 끈 거리'는 끄는 중 화면이 스크롤되면 어긋난다
  const pointer = useRef(null);
  useEffect(() => {
    const track = (e) => { const p = e.touches?.[0] ?? e; pointer.current = { x: p.clientX, y: p.clientY }; };
    window.addEventListener('mousemove', track, { passive: true }); window.addEventListener('touchmove', track, { passive: true }); // 끌기 센서와 같은 이벤트(MouseSensor·TouchSensor)
    return () => { window.removeEventListener('mousemove', track); window.removeEventListener('touchmove', track); };
  }, []);
  const pointerOf = (event) => (event.activatorEvent?.type === 'keydown' ? null : pointer.current);
  const withSide = (event) => {
    const point = pointerOf(event);
    if (!point) return event.over?.data.current; // 키보드 끌기는 기존 경로
    // 포인터 밑 모듈은 지금 화면에서 찾는다(끌기 라이브러리가 잰 자리는 순서가 바뀐 직후 한동안 옛 자리다). 모듈 사이 틈이면 바꾸지 않는다
    const under = document.elementsFromPoint(point.x, point.y).find((node) => node.parentElement === grid.current && node.dataset.mod);
    if (!under) return null;
    const over = { kind: 'module', group: id, id: under.dataset.mod };
    const el = [...(grid.current?.children ?? [])].find((node) => node.dataset.mod === over.id);
    const target = drag.current?.items.find((item) => item.id === over.id);
    return el ? { ...over, side: sideOf(el.getBoundingClientRect(), point, target && spanOf(target) > 11 ? 'full' : 'm'), point } : over;
  };
  const dragEvent = (type, event, over = event.over?.data.current) => {
    if (event.active.data.current?.group !== id) return;
    if (type === 'start') anchor.current = null;
    if (type === 'over') last.current = event;
    if (type !== 'over') { clearTimeout(recheck.current); last.current = null; }
    if (type === 'over' && (Date.now() < settle.current || (anchor.current && over?.point && Math.hypot(over.point.x - anchor.current.x, over.point.y - anchor.current.y) < 16))) return;
    const result = moduleDrag(drag.current, { type, scope: id, source: latest.current.items, items: base,
      canEdit: latest.current.canEdit && !latest.current.locked && lock.current?.id !== id, active: event.active.data.current, over });
    const moved = type === 'over' && result.drag && result.drag !== drag.current;
    drag.current = result.drag;
    if (moved) {
      settle.current = Date.now() + 260; anchor.current = over?.point ?? null;
      animate(() => setPreview(result.drag)); // 옆 모듈이 밀려나며 미끄러진다
      // 미끄러지는 동안 빠르게 움직이고 멈췄으면 그 마지막 자리로 한 번 더 잰다(다음 움직임을 기다리지 않는다)
      clearTimeout(recheck.current);
      recheck.current = setTimeout(() => { if (drag.current && last.current) dragEvent('over', last.current, withSide(last.current)); }, 280);
    }
    else setPreview(result.drag);
    if (result.commit) commit(result.commit);
  };
  useDndMonitor({
    onDragStart: (event) => dragEvent('start', event),
    onDragMove: (event) => {
      const active = event.active.data.current;
      if (event.activatorEvent?.type !== 'keydown') { if (active?.group === id) dragEvent('over', event, withSide(event)); return; }
      if (active?.group !== id || !active.keyboardTarget?.current) return;
      const target = active.keyboardTarget.current;
      active.keyboardTarget.current = null;
      dragEvent('over', event, target);
    },
    onDragOver: (event) => { if (event.activatorEvent?.type !== 'keydown') dragEvent('over', event, withSide(event)); },
    onDragCancel: (event) => dragEvent('cancel', event),
    onDragEnd: (event) => dragEvent('end', event),
  });
  const visible = displayed.filter((item) => !item.hidden);
  const rows = rowInfo(visible, resolveModule);
  return <SortableContext items={visible.map((item) => JSON.stringify([id, item.id]))} strategy={gridStrategy}>
    <div className="grid" ref={grid} aria-busy={pending}>{visible.map((item) => <ModuleCard key={item.id} item={item} space={space} items={displayed} scope={id} commit={commit} canEdit={canEdit && !pending && !locked} editable={canEdit} resolveModule={resolveModule} bodyClassName={bodyClassName} row={rows.get(item.id)} />)}</div>
  </SortableContext>;
}

export function ModuleAddButton({ items, disabled = false }) {
  const lock = useRef(false), unavailable = useRef(disabled);
  unavailable.current = disabled;
  const [pending, setPending] = useState(false);
  const run = async (item) => {
    if (unavailable.current || lock.current) return;
    lock.current = true; setPending(true);
    try { return await item.run(); } catch { return false; } finally { lock.current = false; setPending(false); }
  };
  return <button type="button" className="btn" disabled={disabled || pending} onClick={(event) => openMenu(event, items.length ? items.map((item) => ({ label: item.title, icon: item.icon, run: () => run(item) })) : [{ heading: t('home.noHidden') }], { anchor: event.currentTarget })}><Icon name="plus" size={14} />{t('home.addModule')}</button>;
}
