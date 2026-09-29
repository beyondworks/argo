import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useDndMonitor } from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { Icon } from './Icon.jsx';
import { openMenu, menuProps, mergeHandlers } from './Menu.jsx';
import { Link } from '../core/router.jsx';
import { t } from '../core/i18n.js';
import { SPAN, linkedResize, rowsOf } from '../core/layout.js';
import { moduleDrag } from '../core/module-drag.js';
import { flipGrid } from '../core/motion.js';

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
        <h3>{mod.title}</h3>
        <div className="module-controls">
        {mod.link && <Link to={mod.link} className="module-link">{t('mod.more')}</Link>}
        {canEdit && <button type="button" ref={setActivatorNodeRef} className="grip" aria-label={t('mod.drag')} {...mergeHandlers(attributes, listeners)}><Icon name="grip" size={14} /></button>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
        </div>
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
  const drag = useRef(null);
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
  const animate = (write) => grid.current ? flipGrid(grid.current, () => flushSync(write)) : write();
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
  const dragEvent = (type, event, over = event.over?.data.current) => {
    if (event.active.data.current?.group !== id) return;
    const result = moduleDrag(drag.current, { type, scope: id, source: latest.current.items, items: base,
      canEdit: latest.current.canEdit && lock.current?.id !== id, active: event.active.data.current, over });
    drag.current = result.drag;
    setPreview(result.drag);
    if (result.commit) commit(result.commit);
  };
  useDndMonitor({
    onDragStart: (event) => dragEvent('start', event),
    onDragMove: (event) => {
      const active = event.active.data.current;
      if (event.activatorEvent?.type !== 'keydown' || active?.group !== id || !active.keyboardTarget?.current) return;
      const target = active.keyboardTarget.current;
      active.keyboardTarget.current = null;
      dragEvent('over', event, target);
    },
    onDragOver: (event) => { if (event.activatorEvent?.type !== 'keydown') dragEvent('over', event); },
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
