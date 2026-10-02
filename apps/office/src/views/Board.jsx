// 여러 보기 화면 — 목록·카드·칸반·표(주·월·일은 기존 달력 화면을 그대로 쓴다). 일정 페이지와 홈 모듈 카드가 같이 쓴다(유건 9/30 명세).
// 노션식 조작: 모든 항목 우클릭 메뉴, 빈 곳 우클릭(새 일정·새 할 일·보기 바꾸기), 빈 곳에서 끌어 여러 개 선택(Shift·⌘ 클릭으로 추가),
// 선택하면 아래 떠 있는 막대에서 한꺼번에(완료·날짜·분류·삭제), Esc로 해제. 칸반은 카드를 다른 칸으로 끌면 그 속성이 바뀐다.
// 끌기는 앱 전체 DndContext(App.jsx) 안에서 종류 'vcard'로만 움직인다 — 받는 칸도 같은 보기(group)의 칸뿐이라 모듈·페이지·크루 끌기와 섞이지 않는다.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDraggable, useDroppable, useDndMonitor } from '@dnd-kit/core';
import { t, registerDict, useLang } from '../core/i18n.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { openMenu, menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { canManage } from '../core/session.js';
import { useSelection, selProps } from '../core/selection.js';
import * as V from './model.js';
import { runWrites } from './data.js';
import { colorOf, fmtDay, fmtTime } from '../calendar/shared.js';
import { CAL_DICT } from '../calendar/calendar-i18n.js';
import { TASK_DICT } from '../pages/task-i18n.js';
import { VIEWS_DICT } from './views-i18n.js';
import './views.css';

registerDict({ ...CAL_DICT, ...TASK_DICT, ...VIEWS_DICT });
const newId = () => crypto.randomUUID();

/* ── 글자 ── */
export function whenText(it) {
  if (!it.day) return t('views.noDate');
  const d = fmtDay(it.day, { month: 'short', day: 'numeric', weekday: 'short' });
  if (it.kind === 'task') return `${t('views.due')} ${d}`;
  return `${d} · ${it.allDay ? t('views.allDay') : fmtTime(it.start)}`;
}
/** 칸·담당 이름 */
export function colLabel(by, key, people, items) {
  if (by === 'status' || by === 'date') return t(`views.col.${key}`);
  if (key === 'none') return t(`views.none.${by}`);
  if (by === 'category') return key.slice(2);
  if (by === 'customer') return items?.find((x) => x.customer === key.slice(2))?.customerName || '?';
  return key === `p:${people.me}` ? t('views.me') : people.name(key);
}

/** 드롭다운(유건 9/30 피드백 2번) — `보기: 월 ⌄` 모양 버튼 하나. 누르거나 ↓로 열고, 메뉴 안은 화살표·Enter·Esc(메뉴 호스트), 닫으면 버튼으로 초점이 돌아온다.
 *  options: [{ value, label }] — 보기·묶기·정렬·색이 같은 모양을 쓴다 */
export function Dropdown({ label, value, options, onChange }) {
  const open = (e) => openMenu(e, options.map((o) => ({ label: o.label, checked: o.value === value, run: () => onChange(o.value) })), { anchor: e.currentTarget });
  return <button type="button" className="btn sm vw-dd" aria-haspopup="menu" onClick={open} onKeyDown={(e) => { if (e.key === 'ArrowDown') open(e); }}>
    <span className="vw-dd-k">{label}:</span>{options.find((o) => o.value === value)?.label}<Icon name="caret" size={12} />
  </button>;
}

/* ── 보기 설정 메뉴(카드 ⋯ 메뉴·빈 곳 우클릭·도구 막대가 같이 쓴다) ── */
export function viewMenu(cfg, set, views, label = (v) => t(`views.v.${v}`)) {
  return [
    { heading: t('views.view') },
    ...views.map((v) => ({ label: label(v), checked: cfg.view === v, run: () => set({ view: v }) })),
    ...(cfg.view === 'kanban' ? [{ heading: t('views.group') }, ...V.GROUPS.map((g) => ({ label: t(`views.g.${g}`), checked: cfg.group === g, run: () => set({ group: g }) }))] : []),
    ...(V.BOARD.includes(cfg.view) ? [{ heading: t('views.sort') }, ...V.SORTS.map((s) => ({ label: t(`views.s.${s}`), checked: cfg.sort === s, run: () => set({ sort: s }) }))] : []),
  ];
}
/** 필터 메뉴 — 종류·기간·담당자·분류. whoKeys/categories: 지금 항목에 있는 값 */
export function filterMenu(cfg, set, { whoKeys, categories, people, kinds = true }) {
  const f = cfg.filter, put = (patch) => set({ filter: { ...f, ...patch } });
  return [
    ...(kinds ? [{ heading: t('views.kind') }, ...V.KINDS.map((k) => ({ label: t(`views.k.${k}`), checked: f.kind === k, run: () => put({ kind: k }) }))] : []),
    { heading: t('views.period') }, ...V.PERIODS.map((p) => ({ label: t(`views.p.${p}`), checked: f.period === p, run: () => put({ period: p }) })),
    { heading: t('views.who') }, { label: t('views.all'), checked: f.who === 'all', run: () => put({ who: 'all' }) },
    ...whoKeys.map((k) => ({ label: colLabel('who', k, people), checked: f.who === k, run: () => put({ who: k }) })),
    { heading: t('views.category') }, { label: t('views.all'), checked: f.category === 'all', run: () => put({ category: 'all' }) },
    ...categories.map((c) => ({ label: c, checked: f.category === c, run: () => put({ category: c }) })), { label: t('views.none.category'), checked: f.category === 'none', run: () => put({ category: 'none' }) },
    { sep: true }, { label: t('views.filterReset'), icon: 'x', run: () => put({ who: 'all', category: 'all', period: 'all', ...(kinds ? { kind: 'all' } : {}) }) },
  ];
}
export const filterCount = (f, kinds = true) => ['who', 'category', 'period', ...(kinds ? ['kind'] : [])].filter((k) => f[k] !== 'all').length;

/* ── 항목 동작(우클릭·선택 막대·칸반·확인 창) ── */
/** space: 보고 있는 공간, ctx: model.js 권한 문맥, onOpen(item), onNewEvent(). 반환 { single, many, empty, apply, dialogs } */
export function useItemActions({ space, ctx, people, onOpen, onNewEvent, categories = [] }) {
  const [ask, setAsk] = useState(null);
  const apply = async (items, plan, { quiet = false, msg } = {}) => {
    const { writes, skipped } = V.planMany(items, plan);
    if (!writes.length) { showToast(t(skipped.length ? `views.why.${skipped[0].reason}` : 'views.nothing')); return false; }
    const { ok, failed } = await runWrites(writes, space);
    if (failed) showToast(t(failed));
    else if (!quiet || skipped.length) showToast([typeof msg === 'function' ? msg(ok) : msg ?? t('views.applied', { n: ok }), skipped.length ? t('views.skipped', { n: skipped.length }) : ''].filter(Boolean).join(' · '));
    return !failed;
  };
  const can = (it, op) => !V.whyNot(it, op, ctx);
  const single = (it) => [
    { label: t('views.open'), icon: 'doc', run: () => onOpen(it) },
    it.kind === 'task' && can(it, 'done') && { label: t(it.done ? 'views.reopen' : 'views.done'), icon: 'check', run: () => apply([it], (x) => V.planDone(x, !it.done, ctx), { quiet: true }) },
    can(it, 'date') && { label: t('views.changeDate'), icon: 'calendar', run: () => setAsk({ kind: 'date', items: [it] }) },
    it.kind === 'event' && can(it, 'category') && { label: t('views.changeCategory'), icon: 'tag', run: () => setAsk({ kind: 'category', items: [it] }) },
    { label: t('views.duplicate'), icon: 'copy', run: () => apply([it], (x) => V.planDuplicate(x, ctx, newId()), { msg: t('views.duplicated') }) },
    can(it, 'delete') && { sep: true },
    can(it, 'delete') && { label: t(it.kind === 'task' ? 'views.cancelTask' : 'views.delete'), icon: it.kind === 'task' ? 'x' : 'trash', danger: true, run: () => setAsk({ kind: 'delete', items: [it] }) },
  ].filter(Boolean);
  const many = (items, clear) => {
    const tasks = items.filter((x) => x.kind === 'task' && !x.done);
    return [
      { heading: t('views.selected', { n: items.length }) },
      tasks.length > 0 && { label: t('views.done'), icon: 'check', run: () => apply(tasks, (x) => V.planDone(x, true, ctx)).then((ok) => ok && clear?.()) },
      { label: t('views.moveDate'), icon: 'calendar', run: () => setAsk({ kind: 'date', items, clear }) },
      items.some((x) => x.kind === 'event') && { label: t('views.changeCategory'), icon: 'tag', run: () => setAsk({ kind: 'category', items, clear }) },
      { sep: true },
      { label: t('views.delete'), icon: 'trash', danger: true, run: () => setAsk({ kind: 'delete', items, clear }) },
      { sep: true },
      clear && { label: t('views.clear'), icon: 'x', run: clear },
    ].filter(Boolean);
  };
  const empty = (cfg, set, views, label) => [
    { label: t('views.newEvent'), icon: 'calendar', run: onNewEvent },
    { label: t('views.newTask'), icon: 'check', run: () => setAsk({ kind: 'task' }) },
    ...(cfg && set ? [{ sep: true }, ...viewMenu(cfg, set, views, label)] : []),
  ];
  const close = () => setAsk(null);
  const done = (ok) => { if (ok) { ask?.clear?.(); close(); } };
  const dialogs = ask && (ask.kind === 'task' ? <NewTask space={space} people={people} onClose={close} />
    : ask.kind === 'date' ? <DateAsk items={ask.items} onClose={close} onSave={(day) => apply(ask.items, (x) => V.planDate(x, day, ctx)).then(done)} />
      : ask.kind === 'category' ? <CategoryAsk items={ask.items} categories={categories} onClose={close} onSave={(c) => apply(ask.items.filter((x) => x.kind === 'event'), (x) => V.planCategory(x, c, ctx)).then(done)} />
        : <DeleteAsk items={ask.items} onClose={close} onSave={() => apply(ask.items, (x) => V.planDelete(x, ctx), { msg: (n) => t('views.deleted', { n }) }).then(done)} />);
  return { space, single, many, empty, apply, dialogs, newTask: () => setAsk({ kind: 'task' }) };
}

function DateAsk({ items, onClose, onSave }) {
  const [day, setDay] = useState(items[0]?.day ?? new Date().toISOString().slice(0, 10)), [busy, setBusy] = useState(false);
  const formId = useId();
  const submit = async (e) => { e.preventDefault(); if (!day || busy) return; setBusy(true); await onSave(day); setBusy(false); };
  return <Modal open width={380} title={t('views.dateTitle', { n: items.length })} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('views.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={!day || busy}>{t('views.save')}</button></>}>
    <form id={formId} className="vw-form" onSubmit={submit}>
      <input type="date" className="input" value={day} aria-label={t('views.th.date')} onChange={(e) => setDay(e.target.value)} />
      <p className="dim small">{t('views.dateNote')}</p>
    </form>
  </Modal>;
}

function CategoryAsk({ items, categories, onClose, onSave }) {
  const [value, setValue] = useState(items.find((x) => x.category)?.category ?? ''), [busy, setBusy] = useState(false);
  const formId = useId(), listId = useId();
  const submit = async (e) => { e.preventDefault(); if (busy) return; setBusy(true); await onSave(value); setBusy(false); };
  return <Modal open width={380} title={t('views.catTitle', { n: items.filter((x) => x.kind === 'event').length })} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('views.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={busy}>{t('views.save')}</button></>}>
    <form id={formId} className="vw-form" onSubmit={submit}>
      <input className="input" maxLength={40} list={listId} value={value} placeholder={t('views.catHint')} aria-label={t('views.category')} onChange={(e) => setValue(e.target.value)} />
      <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
      {items.some((x) => x.kind === 'task') && <p className="dim small">{t('views.catNote')}</p>}
    </form>
  </Modal>;
}

/** 여러 개 삭제는 개수를 보여 주고 확인한다(되돌리기 어렵다 — 명세). 할 일은 서버에 지우기가 없어 취소 */
function DeleteAsk({ items, onClose, onSave }) {
  const [busy, setBusy] = useState(false);
  const ev = items.filter((x) => x.kind === 'event'), tk = items.filter((x) => x.kind === 'task');
  const run = async () => { setBusy(true); await onSave(); setBusy(false); };
  return <Modal open width={400} title={items.length === 1 ? items[0].title : t('views.delTitle', { n: items.length })} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('views.cancel')}</button>
    <button type="button" className="btn danger" disabled={busy} onClick={run}>{tk.length && !ev.length ? t('views.cancelTask') : t('views.delete')}</button></>}>
    <div className="vw-form">
      {ev.length > 0 && <p>{t('views.delEvents', { n: ev.length })}{ev.some((x) => x.recurring) && <><br /><span className="dim small">{t('views.delRepeat')}</span></>}</p>}
      {tk.length > 0 && <p>{t('views.delTasks', { n: tk.length })}</p>}
      <p className="dim small">{t('views.delBody')}</p>
    </div>
  </Modal>;
}

function NewTask({ space, people, onClose }) {
  const [title, setTitle] = useState(''), [due, setDue] = useState(''), [who, setWho] = useState(''), [busy, setBusy] = useState(false);
  const formId = useId();
  const admin = space !== 'me' && canManage(space);
  const others = admin ? people.list(space).filter((p) => p.user_id !== people.me && p.role !== 'guest') : [];
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const { failed } = await runWrites([{ type: 'task', space, action: 'task.create', data: { id: newId(), title: title.trim(), due_on: due || null, ...(who ? { assignee: who } : {}) } }], space);
    setBusy(false);
    if (failed) showToast(t(failed)); else { showToast(t('views.taskCreated')); onClose(); }
  };
  return <Modal open width={400} title={t('views.newTask')} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('views.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={busy || !title.trim()}>{t('views.create')}</button></>}>
    <form id={formId} className="vw-form" onSubmit={submit}>
      <input className="input" maxLength={200} value={title} placeholder={t('views.taskHint')} aria-label={t('views.f.title')} onChange={(e) => setTitle(e.target.value)} />
      <label className="field-block"><span className="label">{t('views.f.due')}</span><input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      {others.length > 0 && <label className="field-block"><span className="label">{t('views.f.assignee')}</span><select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">{t('views.me')}</option>{others.map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}</select></label>}
    </form>
  </Modal>;
}

/* ── 보기 ── */
const PAGE = { list: V.LIST_PAGE, card: V.LIST_PAGE, table: V.LIST_PAGE };

/** items: model.js 보기 항목(거르기 전). cfg: { view, group, sort, filter }. actions: useItemActions 결과 */
export function ItemsView({ id, items, cfg, setCfg, views, label, today, ctx, people, actions, colorBy = 'category', compact = false, onOpen }) {
  useLang();
  const shown = useMemo(() => V.sortItems(V.filterItems(items, cfg.filter, today), cfg.sort), [items, cfg.filter, cfg.sort, today]);
  const [sel, setSel] = useState(() => new Set());
  const [limit, setLimit] = useState(PAGE.list);
  const wrap = useRef(null);
  const byKey = useMemo(() => new Map(shown.map((x) => [x.key, x])), [shown]);
  const selected = [...sel].map((k) => byKey.get(k)).filter(Boolean);
  const clear = () => setSel(new Set());
  useEffect(() => { setLimit(PAGE.list); }, [cfg.view, cfg.filter, cfg.sort]);
  // 여러 개 고르기는 오피스 공용(11차, core/selection.js) — 끌어 감싸기·⇧/⌘ 클릭·⌘A·Esc·선택 막대가 모든 화면과 같다. 고른 상태는 이 목록의 것을 그대로 쓴다
  const scope = `vw:${useId()}`;
  useSelection(scope, { value: sel, onChange: setSel, keys: shown.map((x) => x.key), actions: (keys, done) => actions.many(shown.filter((x) => keys.includes(x.key)), done).filter((x) => x.label && x.icon !== 'x') });

  // label: 보기 이름(캘린더 모듈은 자기 보기 이름 — 미니·오늘 시간표·다음 일정 — 을 넘긴다)
  const onEmptyMenu = (e) => { if (!e.target.closest('[data-vkey]')) openMenu(e, actions.empty(cfg, setCfg, views, label)); };

  const itemProps = (it) => ({
    'data-vkey': it.key, ...selProps(sel, it.key),
    'aria-selected': sel.has(it.key) || undefined,
    onClick: (e) => { // ⇧/⌘ 클릭은 공용 감지 코드가 먼저 받는다(하나 더하기·빼기)
      if (e.target.closest('.vw-check') || e.shiftKey || e.metaKey || e.ctrlKey) return;
      clear(); onOpen(it);
    },
    ...menuProps(() => (sel.has(it.key) && sel.size > 1 ? actions.many(selected, clear) : actions.single(it))),
  });
  const check = (it) => <button type="button" className={`vw-check${it.done ? ' on' : ''}`} role="checkbox" aria-checked={it.done} aria-label={it.title}
    onClick={() => actions.apply([it], (x) => V.planDone(x, !it.done, ctx), { quiet: true })}><Icon name="check" size={11} /></button>;
  const lead = (it) => (it.kind === 'task' ? check(it) : <span className={`cal-dot${colorOf(it.src, colorBy) ? '' : ' neutral'}`} style={colorOf(it.src, colorBy) ? { '--ev': colorOf(it.src, colorBy) } : undefined} />);
  const meta = (it) => [it.kind === 'event' ? whenText(it) : it.day ? whenText(it) : '', it.category, it.customerName, it.who && it.who !== `p:${ctx.me}` ? colLabel('who', it.who, people) : ''].filter(Boolean).join(' · ');
  const face = (it) => it.who.startsWith('a:') && <Face id={it.who.slice(2)} size={16} />;
  const more = (n) => n > 0 && <button type="button" className="btn ghost sm vw-more" onClick={() => setLimit(limit + V.LIST_PAGE)}>{t('views.more', { n: Math.min(n, V.LIST_PAGE) })}</button>;

  let body;
  if (!shown.length) body = <p className="vw-empty">{t('views.empty')}</p>;
  else if (cfg.view === 'kanban') body = <Kanban id={id} items={shown} cfg={cfg} ctx={ctx} people={people} compact={compact} itemProps={itemProps} lead={lead} meta={meta} face={face} actions={actions} />;
  else if (cfg.view === 'card') body = <div className="vw-cards">{shown.slice(0, limit).map((it) => <article key={it.key} className={`vw-card${it.done ? ' done' : ''}`} tabIndex={0} {...itemProps(it)}>
    <div className="vw-card-top">{lead(it)}<span className="vw-title">{it.title}</span>{face(it)}</div>
    <small className="vw-meta">{meta(it) || t('views.noDate')}</small>
    <span className="vw-tags"><span className="vw-tag">{t(`views.kind.${it.kind}`)}</span>{it.category && <span className="vw-tag">{it.category}</span>}</span>
  </article>)}{more(shown.length - limit)}</div>;
  else if (cfg.view === 'table') body = <div className="table-wrap vw-tablewrap"><table className="table vw-table">
    <thead><tr><th>{t('views.th.title')}</th><th>{t('views.th.kind')}</th><th>{t('views.th.date')}</th><th>{t('views.who')}</th><th>{t('views.category')}</th><th>{t('views.g.customer')}</th><th>{t('views.th.status')}</th></tr></thead>
    <tbody>{shown.slice(0, limit).map((it) => <tr key={it.key} tabIndex={0} className={it.done ? 'done' : ''} {...itemProps(it)}>
      <td><span className="vw-cell-title">{lead(it)}<span className="vw-title">{it.title}</span></span></td><td className="dim">{t(`views.kind.${it.kind}`)}</td>
      <td className="vw-nowrap">{whenText(it)}</td><td>{colLabel('who', it.who || 'none', people)}</td><td>{it.category || <span className="dim">—</span>}</td><td>{it.customerName || <span className="dim">—</span>}</td>
      <td>{t(`views.col.${V.keyOf(it, 'status', today)}`)}</td></tr>)}</tbody></table>{more(shown.length - limit)}</div>;
  else {
    const rows = shown.slice(0, limit), sections = [];
    for (const it of rows) { const k = cfg.sort === 'date' ? it.day ?? '' : ''; if (sections.at(-1)?.[0] !== k) sections.push([k, []]); sections.at(-1)[1].push(it); }
    body = <div className="vw-list">{sections.map(([day, list]) => <section key={day || 'none'} className="vw-sec">
      {cfg.sort === 'date' && <h4 className="vw-sec-head">{day ? fmtDay(day, { month: 'long', day: 'numeric', weekday: 'short' }) : t('views.noDate')}{day === today && <span className="badge">{t('views.today')}</span>}</h4>}
      {list.map((it) => <div key={it.key} className={`vw-row${it.done ? ' done' : ''}`} tabIndex={0} role="button" {...itemProps(it)} onKeyDown={mergeHandlers(menuProps(() => actions.single(it)), { onKeyDown: (e) => { if (e.key === 'Enter') onOpen(it); } }).onKeyDown}>
        {lead(it)}<span className="vw-main"><span className="clamp">{it.title}</span><small>{meta(it)}</small></span>{face(it)}
      </div>)}
    </section>)}{more(shown.length - limit)}</div>;
  }
  return <div ref={wrap} key={cfg.view} className={`vw is-${cfg.view}${compact ? ' compact' : ''}`} data-sel-scope={scope} onContextMenu={onEmptyMenu}>
    {body}
  </div>;
}

/* ── 칸반 ── */
function Kanban({ id, items, cfg, ctx, people, compact, itemProps, lead, meta, face, actions }) {
  const [pending, setPending] = useState(() => new Map()); // 놓은 카드는 쓰기가 끝날 때까지 새 칸에(실패하면 제자리로)
  const [drag, setDrag] = useState(null), [shown, setShown] = useState({});
  const colOf = (it) => pending.get(it.key) ?? V.keyOf(it, cfg.group, ctx.today);
  const cols = V.groupItems(items, cfg.group, { today: ctx.today, me: ctx.me, kind: cfg.filter.kind, label: (k) => colLabel(cfg.group, k, people, items) });
  const lanes = cols.map(([key]) => [key, items.filter((it) => colOf(it) === key)]);
  const byKey = new Map(items.map((it) => [it.key, it]));
  useDndMonitor({
    onDragStart: ({ active }) => { const d = active.data.current; if (d?.kind === 'vcard' && d.group === id) setDrag(byKey.get(d.key) ?? null); },
    onDragCancel: () => setDrag(null),
    onDragEnd: ({ active, over }) => {
      const d = active.data.current, o = over?.data.current;
      if (d?.kind !== 'vcard' || d.group !== id) return;
      setDrag(null);
      const it = byKey.get(d.key);
      if (!it || !o || o.group !== id || o.col === colOf(it)) return;
      const plan = V.planMove(it, cfg.group, o.col, ctx);
      if (plan.reason) { showToast(t(`views.why.${plan.reason}`)); return; }
      if (!plan.write) return;
      setPending((m) => new Map(m).set(it.key, o.col));
      runWrites([plan.write], actions.space).then(({ failed }) => { if (failed) showToast(t(failed)); })
        .finally(() => setPending((m) => { const n = new Map(m); n.delete(it.key); return n; }));
    },
  });
  return <div className="vw-board">{lanes.map(([key, list]) => {
    const n = shown[key] ?? V.KANBAN_PAGE;
    const why = drag && colOf(drag) !== key ? V.planMove(drag, cfg.group, key, ctx).reason : null;
    return <Lane key={key} id={id} col={key} label={colLabel(cfg.group, key, people, items)} count={list.length} blocked={!!why} compact={compact}>
      {list.slice(0, n).map((it) => <KCard key={it.key} id={id} it={it} itemProps={itemProps} lead={lead} meta={meta} face={face} />)}
      {list.length > n && <button type="button" className="btn ghost sm vw-more" onClick={() => setShown({ ...shown, [key]: n + V.KANBAN_PAGE })}>{t('views.more', { n: Math.min(list.length - n, V.KANBAN_PAGE) })}</button>}
      {!list.length && <p className="vw-lane-empty">{t('views.emptyCol')}</p>}
    </Lane>;
  })}</div>;
}
function Lane({ id, col, label, count, blocked, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${id}|${col}`, data: { kind: 'vcard', group: id, col } });
  return <section ref={setNodeRef} className={`vw-lane${isOver ? (blocked ? ' over no' : ' over') : ''}${blocked ? ' no' : ''}`} aria-label={label}>
    <header className="vw-lane-head"><h4>{label}</h4><span className="count">{count}</span></header>
    <div className="vw-lane-body">{children}</div>
  </section>;
}
function KCard({ id, it, itemProps, lead, meta, face }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: `${id}|${it.key}`, data: { kind: 'vcard', group: id, key: it.key, label: it.title } });
  const { onKeyDown: _keyboardDrag, ...pointer } = listeners ?? {}; // 키보드 끌기는 쓰지 않는다 — Enter는 열기, Shift+F10은 메뉴
  const props = itemProps(it);
  return <article ref={setNodeRef} {...attributes} className={`vw-kcard${it.done ? ' done' : ''}${isDragging ? ' dragging' : ''}`} {...mergeHandlers(pointer, props)} data-vkey={it.key} aria-selected={props['aria-selected']}
    onKeyDown={(e) => { props.onKeyDown?.(e); if (e.key === 'Enter' && !e.defaultPrevented) props.onClick(e); }}>
    <div className="vw-card-top">{lead(it)}<span className="vw-title">{it.title}</span>{face(it)}</div>
    {meta(it) && <small className="vw-meta">{meta(it)}</small>}
  </article>;
}
