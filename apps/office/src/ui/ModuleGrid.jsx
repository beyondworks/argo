import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDndMonitor } from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { Icon } from './Icon.jsx';
import { openMenu, menuProps, mergeHandlers } from './Menu.jsx';
import { Link } from '../core/router.jsx';
import { t } from '../core/i18n.js';
import { SPAN, linkedResize, rowsOf } from '../core/layout.js';
import { moduleDrag, sideOf } from '../core/module-drag.js';
import { flipGrid, flipPrepare } from '../core/motion.js';

const nearest = (sizes, span) => sizes.reduce((b, s) => (Math.abs(SPAN[s] - span) < Math.abs(SPAN[b] - span) ? s : b), sizes[0]);
const gridStrategy = () => null;

function ModuleCard({ item, space, items, partner, canResize, canEdit, scope, commit, resolveModule, bodyClassName }) {
  const mod = resolveModule(item);
  const pmod = partner && resolveModule(partner);
  const keyboardTarget = useRef(null);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({ id: JSON.stringify([scope, item.id]), disabled: !canEdit, data: { kind: 'module', id: item.id, group: scope, label: mod.title, keyboardTarget } });
  const card = useRef(null), cleanup = useRef(null);
  useEffect(() => () => cleanup.current?.(), []);
  useLayoutEffect(() => { if (card.current) card.current.style.gridColumn = ''; }, [item.size]);
  const save = (sizes) => commit(items.map((x) => (sizes[x.id] ? { ...x, size: sizes[x.id] } : x)));
  const set = (patch) => commit(items.map((x) => (x.id === item.id ? { ...x, ...patch } : x)));
  const menu = () => !canEdit ? [{ heading: t('home.readOnly') }] : [
    ...(mod.actions?.length ? [...mod.actions, { sep: true }] : []),
    { heading: t('mod.size') },
    ...mod.sizes.map((s) => ({ label: t(`mod.size.${s}`), checked: item.size === s, run: () => set({ size: s }) })),
    { sep: true },
    { label: t('mod.hide'), icon: 'x', run: () => set({ hidden: true }) },
  ];
  const nextSizes = (target) => (partner ? linkedResize(item.size, partner.size, target, mod.sizes, pmod.sizes) : [nearest(mod.sizes, target), null]);
  const onResize = (e) => {
    if (!canEdit) return;
    e.preventDefault(); e.stopPropagation();
    const el = card.current, grid = el.parentElement, gr = grid.getBoundingClientRect(), cr = el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const colW = (gr.width + gap) / 12;
    const partnerEl = partner && [...grid.children].find((node) => node.dataset.mod === partner.id);
    el.classList.add('resizing'); document.body.classList.add('col-resizing');
    e.currentTarget.setPointerCapture(e.pointerId);
    let cur = [item.size, partner?.size ?? null];
    const move = (ev) => {
      const next = nextSizes(Math.max(0.5, (ev.clientX - cr.left + gap / 2) / colW));
      if (next[0] === cur[0] && next[1] === cur[1]) return;
      cur = next;
      flipGrid(grid, () => { el.style.gridColumn = `span ${SPAN[next[0]]}`; if (partnerEl) partnerEl.style.gridColumn = `span ${SPAN[next[1]]}`; });
    };
    const clean = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      el.classList.remove('resizing'); document.body.classList.remove('col-resizing');
      el.style.gridColumn = ''; if (partnerEl) partnerEl.style.gridColumn = '';
      cleanup.current = null;
    };
    const up = (event) => {
      clean();
      if (event.type !== 'pointercancel' && (cur[0] !== item.size || (partner && cur[1] !== partner.size))) save({ [item.id]: cur[0], ...(partner ? { [partner.id]: cur[1] } : {}) });
    };
    cleanup.current = clean;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const onResizeKey = (e) => {
    if (!canEdit) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = nextSizes(SPAN[item.size] + (e.key === 'ArrowRight' ? 2 : -2));
    if (next[0] !== item.size) save({ [item.id]: next[0], ...(partner ? { [partner.id]: next[1] } : {}) });
  };
  const Body = mod.render;
  return (
    <section ref={(el) => { setNodeRef(el); card.current = el; }} data-mod={item.id} className={`module size-${item.size}${isDragging ? ' dragging' : ''}`}
      aria-label={mod.title} {...menuProps(menu)}>
      <header className="module-head">
        {mod.icon && <Icon name={mod.icon} size={14} className="dim" />}
        <h3>{mod.title}</h3>
        {mod.link && <Link to={mod.link} className="module-link">{t('mod.more')}</Link>}
        {canEdit && <button type="button" ref={setActivatorNodeRef} className="grip" aria-label={t('mod.drag')} {...mergeHandlers(attributes, listeners)}><Icon name="grip" size={14} /></button>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
      </header>
      <div className={`module-body${bodyClassName ? ` ${bodyClassName}` : ''}`}><Body space={space} item={item} canEdit={canEdit} setCfg={(cfg) => set({ cfg: { ...item.cfg, ...cfg } })} /></div>
      {canEdit && canResize && <span className="col-handle" role="separator" aria-orientation="vertical" aria-label={t('mod.resize')} tabIndex={0} onPointerDown={onResize} onKeyDown={onResizeKey} />}
    </section>
  );
}


export function ModuleGrid({ id, items, canEdit, onChange, resolveModule, space, bodyClassName }) {
  const grid = useRef(null), lock = useRef(null), latest = useRef(null), mounted = useRef(true);
  const [optimistic, setOptimistic] = useState(null), [pendingScope, setPendingScope] = useState(null);
  const [preview, setPreview] = useState(null);
  // 자리가 바뀐 뒤에는 (1) 모듈이 미끄러지는 0.26초 동안, (2) 포인터가 그 자리에서 16px 넘게 움직이기 전까지 다시 재지 않는다.
  // 폭이 다른 모듈이 자리를 바꾸면 줄이 바뀌어 가만히 있는 포인터 밑에 다른 모듈이 온다 — 사용자가 움직일 때만 반응한다(9/30).
  const drag = useRef(null), settle = useRef(0), anchor = useRef(null), last = useRef(null), recheck = useRef(0);
  useEffect(() => () => clearTimeout(recheck.current), []);
  const pending = pendingScope === id;
  latest.current = { id, items, canEdit, onChange };
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
    if (lock.current?.id === id || !latest.current.canEdit || latest.current.id !== id || !mounted.current) return false;
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
    const size = drag.current?.items.find((item) => item.id === over.id)?.size;
    return el ? { ...over, side: sideOf(el.getBoundingClientRect(), point, size), point } : over;
  };
  const dragEvent = (type, event, over = event.over?.data.current) => {
    if (event.active.data.current?.group !== id) return;
    if (type === 'start') anchor.current = null;
    if (type === 'over') last.current = event;
    if (type !== 'over') { clearTimeout(recheck.current); last.current = null; }
    if (type === 'over' && (Date.now() < settle.current || (anchor.current && over?.point && Math.hypot(over.point.x - anchor.current.x, over.point.y - anchor.current.y) < 16))) return;
    const result = moduleDrag(drag.current, { type, scope: id, source: latest.current.items, items: base,
      canEdit: latest.current.canEdit && lock.current?.id !== id, active: event.active.data.current, over });
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
  const links = new Map(rowsOf(visible).flatMap((row) => row.map((item, index) => [item.id, { partner: row[index + 1] ?? null, canResize: row.length === 1 || index < row.length - 1 }])));
  return <SortableContext items={visible.map((item) => JSON.stringify([id, item.id]))} strategy={gridStrategy}>
    <div className="grid" ref={grid} aria-busy={pending}>{visible.map((item) => <ModuleCard key={item.id} item={item} space={space} items={displayed} scope={id} commit={commit} canEdit={canEdit && !pending} resolveModule={resolveModule} bodyClassName={bodyClassName} {...links.get(item.id)} />)}</div>
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
