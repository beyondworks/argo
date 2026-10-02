import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { openMenu, menuProps } from './Menu.jsx';
import { Link } from '../core/router.jsx';
import { t } from '../core/i18n.js';
import { spanOf, spanRange, heightOf, minHeight, rowInfo, hasXY, tOf, freeOrder, pack } from '../core/layout.js';
import { flipPrepare } from '../core/motion.js';
import { record, attach } from '../core/history.js';

// 가장자리 끌기·옮기기(유건 10/1) — 손잡이는 늘 그리고, 끄는 코드는 처음 다가갈 때 불러온다(첫 화면 150KB 상한)
const EDGES = ['l', 'r', 't', 'b'];
const once = (load) => { let p; return () => (p ??= load().catch((error) => { p = null; throw error; })); }; // 실패하면 다음에 다시 받는다(배포 뒤 옛 탭)
const resizer = once(() => import('./module-resize.js')), mover = once(() => import('./module-move.js'));

// place = 이 모듈이 놓인 자리 — 옛 배치는 줄 정보({ h: 줄 높이, min, first }), 자유 격자는 { x, top, o: 쌓는 순서, h: 자기 높이, min, first: 0열 }
function ModuleCard({ item, space, items, place, canEdit, editable, commit, resolveModule, bodyClassName }) {
  const mod = resolveModule(item), rh = place.h;
  const card = useRef(null);
  // 높이 손잡이가 알리는 값 = 지금 카드 높이(8px 눈금) — 정한 적 없는 모듈은 내용대로라 그릴 때 값이 없다. 크기가 바뀔 때마다(내용·끌기·좁은 폭) 다시 잰다
  useEffect(() => {
    const el = card.current;
    if (!editable || !el) return;
    const ro = new ResizeObserver(() => el.querySelectorAll(':scope > .edge-y').forEach((node) => node.setAttribute('aria-valuenow', Math.round(el.offsetHeight / 8) * 8)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editable]);
  const set = (patch, quiet) => commit(items.map((x) => (x.id === item.id ? { ...x, ...patch } : x)), quiet); // quiet = 되돌리기 기록에 쌓지 않는다(보기·필터 같은 모듈 설정)
  // 끄기·키보드·두 번 누르기는 module-resize.js(크기)·module-move.js(옮기기)가 맡는다 — 지금 자리(DOM)와 항목을 넘긴다
  const run = (load, kind, ...args) => load().then((m) => card.current && m[kind]?.({ el: card.current, items, modOf: resolveModule, commit, canEdit, title: mod.title }, ...args), () => {});
  const edge = (kind, e, side) => run(resizer, kind, e, side);
  const own = useRef(null); // 카드 본문이 더하는 메뉴(예: 여러 보기의 보기 고르기)
  const [sub, setSub] = useState(''); // 카드 본문이 머리에 붙이는 작은 이름(예: 지금 보기 — "캘린더 · 월") — 같은 모듈을 여러 개 놓았을 때 구분(유건 10/1 5차)
  const menu = () => !canEdit ? [...(own.current?.() ?? []), { heading: t('home.readOnly') }] : [
    ...(own.current?.() ?? []),
    ...(mod.actions?.length ? [...mod.actions, { sep: true }] : []),
    ...('span' in item || 'h' in item ? [{ label: t('mod.size.reset'), icon: 'resize', run: () => edge('resetAll') }] : []), // 그 모듈만(유건 10/1 저녁)
    { label: t('mod.hide'), icon: 'x', run: () => set({ hidden: true }) },
  ];
  const Body = mod.render, span = spanOf(item), [lo, hi] = spanRange(mod.sizes);
  const at = 'top' in place ? { '--x': place.x, '--y': `${place.top}px`, '--o': place.o } : {};
  return (
    <section ref={card} data-mod={item.id} className={`module size-${item.size}${rh ? ' sized-h' : ''}${heightOf(item) ? ' own-h' : ''}${!rh && mod.stack ? ' fixed-h' : ''}`}
      style={{ '--span': span, ...at, ...(rh ? { '--rh': `${rh}px`, '--mh': heightOf(item) ? `${item.h}px` : 'auto' } : {}) }} aria-label={sub ? `${mod.title} · ${sub}` : mod.title} {...menuProps(menu)}>
      <header className="module-head">
        {mod.icon && <Icon name={mod.icon} size={14} className="dim" />}
        <h3>{mod.link ? <Link to={mod.link} className="module-title">{mod.title}{sub && <span className="module-sub">{sub}</span>}</Link> : <>{mod.title}{sub && <span className="module-sub">{sub}</span>}</>}</h3>{/* 제목을 누르면 그 화면으로(유건 9/30 — '모두 보기' 대신) */}
        {/* 옮기기(유건 10/1 저녁): 끄는 동안 다른 모듈은 그대로, 놓을 자리 윤곽만 따라오고 손을 떼면 놓인다. 키보드 = Space/Enter로 들고 화살표·Enter·Esc. 저장 중에도 그대로 둔다(초점 유지) */}
        {editable && <button type="button" className="grip" aria-label={t('mod.drag')} aria-disabled={!canEdit || undefined} onPointerEnter={() => mover().catch(() => {})}
          onPointerDown={(e) => { e.stopPropagation(); if (e.button) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); run(mover, 'drag', { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.currentTarget }); }}
          onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); run(mover, 'pick', e.currentTarget); } }}><Icon name="grip" size={14} /></button>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
      </header>
      <div className={`module-body${bodyClassName ? ` ${bodyClassName}` : ''}`}><Body space={space} item={item} canEdit={canEdit} menu={own} onSub={setSub} setCfg={(cfg) => set({ cfg: { ...item.cfg, ...cfg } }, true)} /></div>
      {editable && EDGES.map((side) => { // 저장 중(canEdit 꺼짐)에도 그대로 둔다 — 키보드 초점이 손잡이에 남는다. 그동안은 aria-disabled
        if (place.first && side === 'l') return null; // 0열에 붙은 모듈의 왼쪽은 잡은 선이 손을 따라오지 않는다(반대편이 움직인다) — 그리지 않는다(유건 10/1 확정)
        const x = side === 'l' || side === 'r'; // 좌우 = 폭, 위아래 = 높이
        return <span key={side} className={`edge edge-${side} edge-${x ? 'x' : 'y'}`} role="separator" aria-orientation={x ? 'vertical' : 'horizontal'} aria-label={t(x ? 'mod.resize.w' : 'mod.resize.h')}
          aria-valuenow={x ? span : undefined} aria-valuemin={x ? lo : place.min} aria-valuemax={x ? hi : 1200} aria-disabled={!canEdit || undefined} tabIndex={side === 'r' || side === 'b' ? 0 : -1}
          onPointerEnter={() => resizer().catch(() => {})} onDoubleClick={() => edge('reset', null, side)} onBlur={() => edge('blur')}
          onFocus={(e) => !x && edge('focus', e.currentTarget, side)} // 높이는 지금 보이는 높이·최소를 화면에서 다시 잰다
          onKeyDown={(e) => { if (!e.key.startsWith('Arrow')) return; e.preventDefault(); e.stopPropagation(); edge('key', { key: e.key }, side); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} // 터치 길게 누르기·오른쪽 클릭이 모듈 ⋯ 메뉴를 열지 않게(pointerdown을 막아도 contextmenu는 따로 온다)
          onPointerDown={(e) => { // 길게 누르기 메뉴·옮기기·글 선택이 같이 시작되지 않게
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
  const pending = pendingScope === id;
  latest.current = { id, items, canEdit, locked, onChange };
  const displayed = optimistic?.id === id ? optimistic.items : items;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (optimistic && (optimistic.id !== id || (!pending && optimistic.source !== items))) setOptimistic(null);
  }, [id, items, pending, optimistic]);
  // quiet = 되돌리기·다시 하기가 저장할 때(그 단계는 되돌리기 코드가 옮긴다)·모듈 설정. 아니면 저장에 성공한 사용자 동작으로 되돌리기에 쌓는다(7차)
  const commit = async (next, quiet) => {
    if (lock.current?.id === id || !latest.current.canEdit || latest.current.locked || latest.current.id !== id || !mounted.current) return false;
    const request = { id }, source = latest.current.items, write = latest.current.onChange;
    lock.current = request;
    animate(() => { setOptimistic({ id, source, items: next }); setPendingScope(id); });
    let saved = false;
    try {
      saved = await write(next) !== false;
      if (saved && !quiet) record(id, source);
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
  const apply = useRef(null);
  apply.current = commit;
  useEffect(() => attach(id, { items: () => latest.current.items, apply: (next) => apply.current(next, true) }), [id]); // ⌘Z 대상(화면에 있는 동안)
  const visible = displayed.filter((item) => !item.hidden);
  // 자유 격자(자리 x·y가 있는 배치) — 높이를 정하지 않은 모듈은 내용 높이라 화면에서 재서 쌓는다(그리기 전에 한 번, 내용·폭이 바뀌면 다시).
  // 자리가 없는 옛 배치는 예전 그대로(CSS 격자 + 줄 높이 공유) — 바꾼 직후 사용자 홈이 달라 보이지 않는다. 옮기거나 크기를 바꿀 때 자리를 같이 저장한다
  const free = visible.some(hasXY), ids = visible.map((item) => item.id).join();
  const [seen, setSeen] = useState(null), last = useRef(null), hold = useRef(false);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!free || !el) return;
    // 내용 높이 = 머리 + 본문 — 카드 높이는 미끄러지는 중(FLIP)에 애니메이션 값이라 쓰지 않는다
    const read = () => {
      const next = { gap: parseFloat(getComputedStyle(el).rowGap) || 0 };
      for (const node of el.children) if (node.dataset.mod) next[node.dataset.mod] = (node.querySelector(':scope > .module-head')?.offsetHeight ?? 0) + (node.querySelector(':scope > .module-body')?.offsetHeight ?? 0);
      if (last.current && Object.keys(next).every((k) => last.current[k] === next[k])) return;
      last.current = next; hold.current = true; setSeen(next);
    };
    read();
    const ro = new ResizeObserver(read);
    for (const node of el.children) if (node.dataset.mod) ro.observe(node);
    return () => ro.disconnect();
  }, [free, ids]);
  // 자리·폭이 바뀌면 이전 자리에서 미끄러진다 — 자리를 재 두고, 다시 그린 직후(layout effect)에 움직인다. 높이를 새로 쟀으면 그 자리로 다시 그린 뒤에
  const flip = useRef(null);
  const animate = (write) => { if (grid.current) flip.current = flipPrepare(grid.current); write(); };
  useLayoutEffect(() => { if (hold.current) { hold.current = false; return; } const run = flip.current; flip.current = null; run?.(); });
  const boxes = free && new Map(pack(freeOrder(visible).map(({ it, x }, o) => ({ id: it.id, x, w: spanOf(it), h: heightOf(it) || seen?.[it.id] || 0, o, t: tOf(it) })), seen?.gap ?? 12).map((b) => [b.id, b]));
  const rows = !free && rowInfo(visible, resolveModule);
  const place = (item) => (free ? { ...boxes.get(item.id), h: heightOf(item), min: minHeight(resolveModule(item)), first: !boxes.get(item.id).x } : rows.get(item.id));
  return <div className={`grid${free ? ' free' : ''}`} ref={grid} aria-busy={pending} style={free ? { '--gh': `${Math.max(0, ...[...boxes.values()].map((b) => b.top + b.h))}px` } : undefined}>
    {visible.map((item) => <ModuleCard key={item.id} item={item} space={space} items={displayed} commit={commit} canEdit={canEdit && !pending && !locked} editable={canEdit} resolveModule={resolveModule} bodyClassName={bodyClassName} place={place(item)} />)}
  </div>;
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
