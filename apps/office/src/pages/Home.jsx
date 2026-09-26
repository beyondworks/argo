// 홈 — 모듈 격자. 끌어서 순서, 모서리 손잡이로 크기(1/3·1/2·2/3·전체), 메뉴로 숨기기·추가. 바꾸는 즉시 저장된다.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '../ui/Icon.jsx';
import { openMenu, menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Link } from '../core/router.jsx';
import { t, useLang } from '../core/i18n.js';
import { useStore, saveLayout } from '../core/store.js';
import { mergeLayout, SPAN, linkedResize, rowsOf } from '../core/layout.js';
import { flipGrid } from '../core/motion.js';
import { baseOf } from '../core/commands.js';
import { MODULES, DEFAULTS } from './modules.jsx';
import { SPACES, ME } from '../data/sample.js';

export const layoutKey = (space) => `home:${space}`;
export const kindOf = (space) => (space === 'me' ? 'me' : 'org');
export function useHomeLayout(space) {
  const saved = useStore((s) => s.layouts[layoutKey(space)]);
  return useMemo(() => mergeLayout(saved, MODULES, kindOf(space), DEFAULTS[kindOf(space)]), [saved, space]);
}

/** 격자 변경을 모션으로 — React 렌더를 동기로 끝내야 새 자리를 잴 수 있다 */
const animated = (el, fn) => (el ? flipGrid(el.closest('.grid'), () => flushSync(fn)) : fn());
const nearest = (sizes, span) => sizes.reduce((b, s) => (Math.abs(SPAN[s] - span) < Math.abs(SPAN[b] - span) ? s : b), sizes[0]);

function ModuleCard({ item, space, items, partner, canResize }) {
  const mod = MODULES.find((m) => m.id === item.id);
  const pmod = partner && MODULES.find((m) => m.id === partner.id);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: `module:${item.id}`, data: { kind: 'module', id: item.id, group: 'grid', label: t(mod.title) } });
  const card = useRef(null);
  // 끄는 동안 붙인 임시 폭은 저장된 크기가 그려진 뒤 걷는다(같은 값이라 화면은 그대로)
  useLayoutEffect(() => { if (card.current) card.current.style.gridColumn = ''; }, [item.size]);
  const save = (sizes) => saveLayout(layoutKey(space), items.map((x) => (sizes[x.id] ? { ...x, size: sizes[x.id] } : x)));
  const set = (patch) => animated(card.current, () => saveLayout(layoutKey(space), items.map((x) => (x.id === item.id ? { ...x, ...patch } : x))));
  const menu = () => [
    { heading: t('mod.size') },
    ...mod.sizes.map((s) => ({ label: t(`mod.size.${s}`), checked: item.size === s, run: () => set({ size: s }) })),
    { sep: true },
    { label: t('mod.hide'), icon: 'x', run: () => set({ hidden: true }) },
  ];
  /** 경계 → 다음 크기: 같은 줄 옆 모듈이 있으면 둘의 합을 유지(노션 열), 혼자인 줄이면 자유롭게 */
  const nextSizes = (target) => (partner ? linkedResize(item.size, partner.size, target, mod.sizes, pmod.sizes) : [nearest(mod.sizes, target), null]);
  const onResize = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = card.current, grid = el.parentElement, gr = grid.getBoundingClientRect(), cr = el.getBoundingClientRect(); // 끄는 동안 선은 모듈이 실제로 붙은 경계에만(커서를 따라가는 선은 옆 모듈을 가로질러 어색했다 — 유건 2026-09-26)
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const colW = (gr.width + gap) / 12;
    const partnerEl = partner && grid.querySelector(`[data-mod="${partner.id}"]`);
    el.classList.add('resizing'); document.body.classList.add('col-resizing');
    e.currentTarget.setPointerCapture(e.pointerId);
    let cur = [item.size, partner?.size ?? null];
    const move = (ev) => {
      const next = nextSizes(Math.max(0.5, (ev.clientX - cr.left + gap / 2) / colW)); // 반올림하지 않는다 — 단계 사이 한가운데서 한쪽으로 쏠리지 않게
      if (next[0] === cur[0] && next[1] === cur[1]) return;
      cur = next; // 단계를 지날 때만 모듈이 미끄러진다
      flipGrid(grid, () => { el.style.gridColumn = `span ${SPAN[next[0]]}`; if (partnerEl) partnerEl.style.gridColumn = `span ${SPAN[next[1]]}`; });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      el.classList.remove('resizing'); document.body.classList.remove('col-resizing');
      if (cur[0] !== item.size || (partner && cur[1] !== partner.size)) save({ [item.id]: cur[0], ...(partner ? { [partner.id]: cur[1] } : {}) });
      else { el.style.gridColumn = ''; if (partnerEl) partnerEl.style.gridColumn = ''; }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const onResizeKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = nextSizes(SPAN[item.size] + (e.key === 'ArrowRight' ? 2 : -2));
    if (next[0] !== item.size) animated(card.current, () => save({ [item.id]: next[0], ...(partner ? { [partner.id]: next[1] } : {}) }));
  };
  const Body = mod.render;
  return (
    <section ref={(el) => { setNodeRef(el); card.current = el; }} data-mod={item.id} className={`module size-${item.size}${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }} aria-label={t(mod.title)} {...menuProps(menu)}>
      <header className="module-head">
        <button type="button" ref={setActivatorNodeRef} className="grip" aria-label={t('mod.drag')} {...mergeHandlers(attributes, listeners)}><Icon name="grip" size={14} /></button>
        <Icon name={mod.icon} size={14} className="dim" />
        <h3>{t(mod.title)}</h3>
        {mod.link && <Link to={mod.link === '/mail' ? '/me/mail' : `${baseOf(space)}${mod.link}`} className="module-link">{t('mod.more')}</Link>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
      </header>
      <div className="module-body"><Body space={space} /></div>
      {canResize && <span className="col-handle" role="separator" aria-orientation="vertical" aria-label={t('mod.resize')} tabIndex={0} onPointerDown={onResize} onKeyDown={onResizeKey} />}
    </section>
  );
}

export function Home({ space }) {
  useLang();
  const items = useHomeLayout(space);
  const visible = items.filter((i) => !i.hidden);
  const hidden = items.filter((i) => i.hidden);
  const sp = SPACES.find((s) => s.key === space);
  const grid = useRef(null);
  const withMotion = (fn) => (grid.current ? flipGrid(grid.current, () => flushSync(fn)) : fn());
  // 경계 손잡이: 같은 줄 오른쪽에 모듈이 있으면 그 모듈과 연결, 혼자인 줄이면 자유 조절, 줄 끝 모듈은 손잡이 없음(격자 끝이 경계)
  const rows = rowsOf(visible);
  const links = new Map(rows.flatMap((row) => row.map((it, i) => [it.id, { partner: row[i + 1] ?? null, canResize: row.length === 1 || i < row.length - 1 }])));
  const add = (e) => openMenu(e, hidden.length
    ? hidden.map((h) => { const m = MODULES.find((x) => x.id === h.id); return { label: t(m.title), icon: m.icon, run: () => withMotion(() => saveLayout(layoutKey(space), [...items.filter((x) => x.id !== h.id), { ...h, hidden: false }])) }; })
    : [{ heading: t('home.noHidden') }], { anchor: e.currentTarget });
  const today = new Intl.DateTimeFormat(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return (
    <div className="page-wrap wide">
      <div className="page-title-row">
        <div>
          <p className="eyebrow">{today}</p>
          <h1 className="page-h1">{sp.kind === 'me' ? `${t('home.title')} · ${ME.name}` : sp.name}</h1>
        </div>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={() => withMotion(() => saveLayout(layoutKey(space), []))}>{t('home.reset')}</button>
          <button type="button" className="btn" onClick={add}><Icon name="plus" size={14} />{t('home.addModule')}</button>
        </div>
      </div>
      <SortableContext items={visible.map((i) => `module:${i.id}`)} strategy={rectSortingStrategy}>
        <div className="grid" ref={grid}>
          {visible.map((i) => <ModuleCard key={i.id} item={i} space={space} items={items} {...links.get(i.id)} />)}
        </div>
      </SortableContext>
    </div>
  );
}
