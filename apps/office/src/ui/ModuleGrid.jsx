import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { openMenu, menuProps } from './Menu.jsx';
import { Link } from '../core/router.jsx';
import { t } from '../core/i18n.js';
import { heightOf, minHeight, colMin, layoutRows, placeRows } from '../core/layout.js';
import { flipPrepare } from '../core/motion.js';
import { record, attach } from '../core/history.js';
import { useSelection, selProps } from '../core/selection.js';

// 옮기기·높이·열 경계선(9차, 노션식 블록) — 손잡이는 늘 그리고, 끄는 코드는 처음 다가갈 때 불러온다(첫 화면 150KB 상한)
const once = (load) => { let p; return () => (p ??= load().catch((error) => { p = null; throw error; })); }; // 실패하면 다음에 다시 받는다(배포 뒤 옛 탭)
const resizer = once(() => import('./module-resize.js')), mover = once(() => import('./module-move.js'));
const preload = (load) => () => load().catch(() => {});

// place = 이 모듈 자리 { x, w(24분의 몇), top, o(좁은 폭 순서), min(최소 높이) }, rows = 지금 줄 목록(끄는 코드가 쓴다)
/** 모듈 하나가 그리다 실패해도 그 카드 안에만 안내한다 — 홈 전체가 오류 화면으로 바뀌지 않게(유건 10/2). 보기·설정이 바뀌면(key) 다시 그려 본다 */
class ModuleBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="mod-empty" role="alert">{t('mod.failed')}</p> : this.props.children; }
}

function ModuleCard({ item, space, items, rows, place, canEdit, editable, commit, resolveModule, bodyClassName, sel }) {
  const mod = resolveModule(item), own = heightOf(item);
  const card = useRef(null);
  // 높이 손잡이가 알리는 값 = 지금 카드 높이(8px 눈금) — 정한 적 없는 모듈은 내용대로라 그릴 때 값이 없다. 크기가 바뀔 때마다(내용·끌기·좁은 폭) 다시 잰다
  useEffect(() => {
    const el = card.current;
    if (!editable || !el) return;
    const ro = new ResizeObserver(() => el.querySelector(':scope > .edge-b')?.setAttribute('aria-valuenow', Math.round(el.offsetHeight / 8) * 8));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editable]);
  const set = (patch, quiet) => commit(items.map((x) => (x.id === item.id ? { ...x, ...patch } : x)), quiet); // quiet = 되돌리기 기록에 쌓지 않는다(보기·필터 같은 모듈 설정)
  // 끄기·키보드·두 번 누르기는 module-resize.js(높이)·module-move.js(옮기기)가 맡는다 — 지금 자리(DOM)·줄 목록·항목을 넘긴다
  // group = 고른 모듈(11차) — 고른 모듈의 손잡이를 잡으면 고른 것 전부가 같이 간다
  const run = (load, kind, ...args) => load().then((m) => card.current && m[kind]?.({ el: card.current, items, rows, modOf: resolveModule, commit, canEdit, title: mod.title, group: sel.has(item.id) && sel.size > 1 ? [...sel] : null }, ...args), () => {});
  const edge = (kind, e) => run(resizer, kind, e);
  const menuOwn = useRef(null); // 카드 본문이 더하는 메뉴(예: 여러 보기의 보기 고르기)
  const [sub, setSub] = useState(''); // 카드 본문이 머리에 붙이는 작은 이름(예: 지금 보기 — "캘린더 · 월") — 같은 모듈을 여러 개 놓았을 때 구분(유건 10/1 5차)
  const menu = () => !canEdit ? [...(menuOwn.current?.() ?? []), { heading: t('home.readOnly') }] : [
    ...(menuOwn.current?.() ?? []),
    ...(mod.actions?.length ? [...mod.actions, { sep: true }] : []),
    ...('h' in item ? [{ label: t('mod.size.reset'), icon: 'resize', run: () => edge('resetAll') }] : []), // 높이만 — 폭은 열 경계선(9차)
    { label: t('mod.hide'), icon: 'x', run: () => set({ hidden: true }) },
  ];
  const Body = mod.render;
  return (
    <section ref={card} data-mod={item.id} {...selProps(sel, item.id)} className={`module size-${item.size}${own ? ' sized-h own-h' : mod.stack ? ' fixed-h' : ''}`}
      style={{ '--x': place.x, '--w': place.w, '--y': `${place.top}px`, '--o': place.o, ...(own ? { '--rh': `${own}px`, '--mh': `${own}px` } : {}) }} aria-label={sub ? `${mod.title} · ${sub}` : mod.title} {...menuProps(menu)}>
      <header className="module-head">
        {mod.icon && <Icon name={mod.icon} size={14} className="dim" />}
        <h3>{mod.link ? <Link to={mod.link} className="module-title">{mod.title}{sub && <span className="module-sub">{sub}</span>}</Link> : <>{mod.title}{sub && <span className="module-sub">{sub}</span>}</>}</h3>{/* 제목을 누르면 그 화면으로(유건 9/30 — '모두 보기' 대신) */}
        {/* 옮기기(9차, 노션식 — 손잡이 자리는 머리 오른쪽 ⋯ 앞 그대로, 유건 10/2): 끄는 동안 다른 모듈은 그대로, 놓일 자리에 파란 삽입선만. 키보드 = Space/Enter로 들고 화살표·Enter·Esc. 저장 중에도 그대로 둔다(초점 유지) */}
        {editable && <button type="button" className="grip" aria-label={t('mod.drag')} aria-disabled={!canEdit || undefined} onPointerEnter={preload(mover)}
          onPointerDown={(e) => { e.stopPropagation(); if (e.button) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); run(mover, 'drag', { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.currentTarget }); }}
          onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); run(mover, 'pick', e.currentTarget); } }}><Icon name="grip" size={14} /></button>}
        <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
      </header>
      <div className={`module-body${bodyClassName ? ` ${bodyClassName}` : ''}`}><ModuleBoundary key={JSON.stringify(item.cfg ?? null)}><Body space={space} item={item} canEdit={canEdit} menu={menuOwn} onSub={setSub} setCfg={(cfg) => set({ cfg: { ...item.cfg, ...cfg } }, true)} /></ModuleBoundary></div>
      {/* 높이 = 아래 가장자리만(9차, 노션 임베드처럼 8px 눈금). 저장 중(canEdit 꺼짐)에도 그대로 둔다 — 키보드 초점이 손잡이에 남는다. 그동안은 aria-disabled */}
      {editable && <span className="edge edge-b" role="separator" aria-orientation="horizontal" aria-label={t('mod.resize.h')} aria-valuemin={place.min} aria-valuemax={1200} aria-disabled={!canEdit || undefined} tabIndex={0}
        onPointerEnter={preload(resizer)} onDoubleClick={() => edge('reset')} onBlur={() => edge('blur')} onFocus={(e) => edge('focus', e.currentTarget)}
        onKeyDown={(e) => { if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault(); e.stopPropagation(); edge('key', { key: e.key }); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} // 터치 길게 누르기·오른쪽 클릭이 모듈 ⋯ 메뉴를 열지 않게(pointerdown을 막아도 contextmenu는 따로 온다)
        onPointerDown={(e) => { // 길게 누르기 메뉴·옮기기·글 선택이 같이 시작되지 않게
          e.stopPropagation(); if (e.button) return; e.preventDefault();
          const target = e.currentTarget; target.setPointerCapture(e.pointerId);
          edge('drag', { x: e.clientX, y: e.clientY, id: e.pointerId, target });
        }} />}
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
  const visible = displayed.filter((item) => !item.hidden), ids = visible.map((item) => item.id).join();
  // 여러 개 고르기(11차) — 끌어 감싸기·⇧/⌘ 클릭·⌘A로 고른 모듈. 선택 막대 = 숨기기(저장·되돌리기 한 번)
  const [sel] = useSelection(`mod:${id}`, { keys: visible.map((item) => item.id), actions: (keys, clear) => [
    canEdit && !pending && !locked && { label: t('mod.hide'), icon: 'eyeOff', run: () => { const pick = new Set(keys); commit(displayed.map((x) => (pick.has(x.id) ? { ...x, hidden: true } : x))); clear(); } },
  ] });
  // 높이를 정하지 않은 모듈은 내용 높이라 화면에서 재서 쌓는다(그리기 전에 한 번, 내용·폭이 바뀌면 다시)
  const [seen, setSeen] = useState(null), last = useRef(null), hold = useRef(false);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    // 내용 높이 = 머리 + 본문 — 카드 높이는 미끄러지는 중(FLIP)에 애니메이션 값이라 쓰지 않는다
    const read = () => {
      const next = { gap: parseFloat(getComputedStyle(el).rowGap) || 12 };
      for (const node of el.children) if (node.dataset.mod) next[node.dataset.mod] = (node.querySelector(':scope > .module-head')?.offsetHeight ?? 0) + (node.querySelector(':scope > .module-body')?.offsetHeight ?? 0);
      if (last.current && Object.keys(next).every((k) => last.current[k] === next[k])) return;
      last.current = next; hold.current = true; setSeen(next);
    };
    read();
    const ro = new ResizeObserver(read);
    for (const node of el.children) if (node.dataset.mod) ro.observe(node);
    return () => ro.disconnect();
  }, [ids]);
  // 자리·폭이 바뀌면 이전 자리에서 미끄러진다 — 자리를 재 두고, 다시 그린 직후(layout effect)에 움직인다. 높이를 새로 쟀으면 그 자리로 다시 그린 뒤에
  const flip = useRef(null);
  const animate = (write) => { if (grid.current) flip.current = flipPrepare(grid.current); write(); };
  useLayoutEffect(() => { if (hold.current) { hold.current = false; return; } const run = flip.current; flip.current = null; run?.(); });
  // 줄 → 열 → 모듈(9차). 줄·열이 없는 옛 배치·5~7차 배치는 지금 화면 모양에서 줄·열을 만든다 — 그리기만 하고 저장하지 않는다(사용자가 바꿀 때 같이 저장)
  const gap = seen?.gap ?? 12, byId = new Map(visible.map((item) => [item.id, item]));
  const hOf = (item) => heightOf(item) || seen?.[item.id] || (resolveModule(item).stack ? 320 : 0);
  const rows = layoutRows(visible, hOf, gap, (key) => colMin(resolveModule(byId.get(key))));
  const { pos, lines, height } = placeRows(rows, (key) => hOf(byId.get(key)), gap);
  const live = canEdit && !pending && !locked;
  // 열 경계선 — 올리면 세로 선, 끌어 두 열 폭을 나눈다(합 유지, 1/24 눈금), 두 번 누르면 똑같이. 키보드 ←/→
  const cols = (r, k, kind, e) => resizer().then((m) => grid.current && m[kind]?.({ el: grid.current, items: displayed, rows, modOf: resolveModule, commit, canEdit: live, r, k }, e), () => {});
  return <div className="grid" ref={grid} aria-busy={pending} data-sel-scope={`mod:${id}`} data-sel-units="" style={{ '--gh': `${height}px` }}>
    {visible.map((item) => <ModuleCard key={item.id} item={item} space={space} items={displayed} rows={rows} commit={commit} canEdit={live} editable={canEdit} resolveModule={resolveModule} bodyClassName={bodyClassName} sel={sel} place={{ ...pos.get(item.id), min: minHeight(resolveModule(item)) }} />)}
    {canEdit && rows.flatMap((row, r) => row.slice(1).map((_, i) => {
      const k = i + 1, x = row.slice(0, k).reduce((s, col) => s + col.w, 0);
      return <span key={`${r}:${k}`} className="col-gap" role="separator" aria-orientation="vertical" aria-label={t('mod.resize.w')} tabIndex={0} aria-valuenow={Math.round((x / 24) * 100)} aria-valuemin={0} aria-valuemax={100} aria-disabled={!live || undefined}
        style={{ '--x': x, '--y': `${lines[r].top}px`, '--rh': `${lines[r].h}px` }} onPointerEnter={preload(resizer)} onDoubleClick={() => cols(r, k, 'equal')} onBlur={() => cols(r, k, 'blur')}
        onKeyDown={(e) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); cols(r, k, 'colKey', { key: e.key, target: e.currentTarget }); }}
        onPointerDown={(e) => { if (e.button) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); cols(r, k, 'colDrag', { x: e.clientX, id: e.pointerId, target: e.currentTarget }); }} />;
    }))}
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
