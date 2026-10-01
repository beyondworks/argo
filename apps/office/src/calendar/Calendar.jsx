// 일정(캘린더) — 구글 캘린더처럼 전체 페이지를 쓰는 달력(유건 9/30 명세 규칙 1~10).
// 왼쪽 레일(만들기 · 작은 월 달력 · 캘린더 목록), 오른쪽 큰 달력(오늘 · ‹ ›(월 보기 제외) · 기간 제목 · 보기·묶기·정렬·색 드롭다운).
// 월 보기는 주 단위로 위아래로 이어진다(유건 9/30 피드백 1번) — 멈추면 주 경계에 붙고, 제목은 가장 많이 보이는 달, '오늘'은 오늘 주를 가운데로.
// 같은 일정 행이 개인 달력과 조직 달력에 함께 보인다(저장 행은 하나). 할 일 기한은 겹쳐 보인다.
// 여러 보기(유건 9/30): 목록·카드·칸반·표는 views/Board.jsx가 일정 + 할 일을 합쳐 그리고, 주·월·일은 아래 달력이 그린다.
// 옛 '거래처' 보기는 칸반의 '거래처로 묶기'로 들어갔다. 보기 설정(보기·묶기·필터·정렬)은 사람마다 따로(views/data.js).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, registerDict, useLang, getLang } from '../core/i18n.js';
import { ME, SPACES } from '../core/session.js';
import { baseOf } from '../core/commands.js';
import { navigate, useUrl } from '../core/router.jsx';
import { crewName } from '../core/store.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Sheet } from '../ui/Panel.jsx';
import { openMenu, menuProps } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import * as M from './model.js';
import * as V from '../views/model.js';
import { useEvents, useEventWindows, writeEvent, loadPeople, loadCustomers } from './api.js';
import { orgSpaces, idOf, spaceOfOrg, writableOrgs, inSpace, calOf, colorOf, fmtDay, fmtTime, locale, pref, setPref } from './shared.js';
import { useViewTasks, usePeople, makeCtx, readCfg, writeCfg } from '../views/data.js';
import { ItemsView, useItemActions, filterMenu, filterCount, Dropdown } from '../views/Board.jsx';
import { CAL_DICT, holidayName } from './calendar-i18n.js';
import './calendar.css';

registerDict(CAL_DICT);
const VIEWS = V.VIEWS;
const HOUR = 48, MAX_LANES = 3;
const newId = () => crypto.randomUUID();
const fail = (e) => showToast(t(e.message));

function usePhone() {
  const q = '(max-width: 767px)';
  const [on, setOn] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q), f = () => setOn(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return on;
}
function useNow(ms = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

function periodTitle(view, anchor, phone) {
  if (view === 'day') return fmtDay(anchor, { year: phone ? undefined : 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  if (view === 'week') {
    const w = M.weekDays(anchor);
    return new Intl.DateTimeFormat(locale(), { year: phone ? undefined : 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${w[0]}T00:00:00Z`), new Date(`${w[6]}T00:00:00Z`));
  }
  if (V.BOARD.includes(view)) {
    const [a, b] = M.windowOf('list', anchor);
    return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${a}T00:00:00Z`), new Date(`${M.addDays(b, -1)}T00:00:00Z`));
  }
  return fmtDay(anchor, { year: 'numeric', month: 'long' });
}
const whenText = (o) => (o.all_day ? t('cal.allDay') : `${fmtTime(o.start)} – ${fmtTime(o.end)}`);

/* ── 화면 ── */
/** 저장된 보기 설정 — 없으면 예전 달력 설정(보기)을 옮겨 온다('거래처' 보기 → 칸반·거래처로 묶기). 폰은 목록으로 연다 */
function firstCfg(space, phone) {
  const saved = readCfg(`cal:${space}`), old = pref('view', 'month');
  const cfg = V.normalizeCfg(saved ?? (old === 'customers' ? { view: 'kanban', group: 'customer' } : { view: old }), { view: 'month' });
  return phone ? { ...cfg, view: 'list' } : cfg;
}

export default function Calendar({ space, day }) {
  useLang();
  const phone = usePhone(), now = useNow();
  const today = M.localDay(now);
  const [cfg, setCfgState] = useState(() => firstCfg(space, phone));
  const view = cfg.view;
  const setCfg = (patch) => setCfgState((c) => { const next = V.normalizeCfg({ ...c, ...patch }); writeCfg(`cal:${space}`, next); return next; });
  const [anchor, setAnchor] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? day : today));
  const [colorBy, setColorBy] = useState(() => pref('color', 'category'));
  const [off, setOff] = useState(() => new Set(pref(`off:${space}`, [])));
  const [rail, setRail] = useState(false);
  const [quick, setQuick] = useState(null), [sheet, setSheet] = useState(null), [ask, setAsk] = useState(null), [dayList, setDayList] = useState(null);
  // 연속 월 보기로 '이 날로 가라'는 신호 — 오늘·작은 달력·주소(?day=)에서만. 스크롤로 바뀐 기준 날짜는 되돌려 스크롤하지 않는다
  const [jump, setJump] = useState(() => ({ day: anchor, seq: 0 }));
  const jumpTo = (d) => { if (view !== 'month') setAnchor(d); setJump((j) => ({ day: d, seq: j.seq + 1 })); };
  useEffect(() => { setOff(new Set(pref(`off:${space}`, []))); }, [space]);
  useEffect(() => { if (/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) jumpTo(day); }, [day]);
  const setView = (v) => setCfg({ view: v });
  const toggle = (id) => { const next = new Set(off); if (next.has(id)) next.delete(id); else next.add(id); setOff(next); setPref(`off:${space}`, [...next]); };

  const board = V.BOARD.includes(view);
  const [from, to] = M.windowOf(board ? 'list' : view, anchor);
  const data = useEvents(from, to);
  const tasks = useViewTasks(space), people = usePeople(space);
  const ctx = useMemo(() => makeCtx(today, people), [today, people]);
  const occ = useMemo(() => (data.events ? M.expand(inSpace(data.events, space), M.kstStart(from) - 86400e3, M.kstStart(to) + 86400e3).filter((o) => !off.has(calOf(o, space))) : []), [data.events, space, off, from, to]);
  const items = useMemo(() => {
    const dues = off.has('tasks') ? [] : tasks.filter((x) => x.due_on).map((x) => ({ kind: 'task', key: `t:${x.id}`, id: x.id, title: x.title, done: !!x.done_at, space: x.space, all_day: true, start: M.kstStart(x.due_on), end: M.kstStart(M.addDays(x.due_on, 1)), vi: V.taskItem(x) }));
    return [...dues, ...occ];
  }, [occ, tasks, off]);
  const boardItems = useMemo(() => (board ? V.mergeItems(occ.filter((o) => o.end > M.kstStart(from) && o.start < M.kstStart(to)), off.has('tasks') ? [] : tasks, { from, to, undated: true, overdue: true }) : []), [board, occ, tasks, off, from, to]);
  const categories = useMemo(() => [...new Set((data.events ?? []).map((e) => e.category).filter(Boolean))].sort(), [data.events]);
  const holidays = !off.has('holidays');

  const openTask = (x) => navigate(`${baseOf(x.space)}?open=${x.id}`);
  const open = (o) => { if (o.kind === 'task') openTask(o); else setSheet({ occ: o }); };
  const openItem = (it) => (it.kind === 'task' ? openTask(it) : setSheet({ occ: it.src }));
  const create = (at) => {
    const base = at ?? { day: anchor === today ? today : anchor, min: anchor === today ? Math.min(23 * 60, (new Date(now).getHours() + 1) * 60) : 9 * 60 };
    const draft = blankDraft(space, base);
    if (at) setQuick(draft); else setSheet({ draft });
  };
  const go = (dir) => setAnchor(M.shift(board ? 'list' : view, anchor, dir));
  const pickDay = (d, v) => { if (v) { setAnchor(d); setView(v); } jumpTo(d); setRail(false); };
  /** 연속 월 보기가 멈춘 자리 — 제목·작은 달력은 가장 많이 보이는 달(vis), 기준 날짜는 보이는 주 안의 고른 날·오늘·지금 기준(없으면 그 달 1일).
   *  기준 날짜는 만들기 기본 날짜와 다른 보기로 바꿀 때 쓴다. 월 보기에서는 오늘·작은 달력도 스크롤만 하고 이 값으로 맞춘다 */
  const [vis, setVis] = useState(null);
  const onMonth = (m, lo, hi) => { setVis(m); setAnchor((a) => [jump.day, today, a].find((d) => d >= lo && d <= hi) ?? `${m}-01`); };
  const monthVis = view === 'month' && vis ? `${vis}-01` : null;
  const actions = useItemActions({ space, ctx, people, categories, onOpen: openItem, onNewEvent: () => create() });
  const onMenu = (o) => actions.single(o.kind === 'task' ? o.vi : V.eventItem(o));
  const props = { items, today, now, colorBy, holidays, phone, onOpen: open, onCreate: create, onMenu };

  // 주소로 온 요청 — ?view=(커맨더 보기 전환) · ?new=event|task(새 일정·새 할 일) · ?open=회차 키(홈 카드에서 연 일정). 처리하면 주소에서 뺀다
  const [path, qs] = useUrl().split('?');
  const q = new URLSearchParams(qs ?? '');
  const strip = (...keys) => { keys.forEach((k) => q.delete(k)); const rest = q.toString(); navigate(`${path}${rest ? `?${rest}` : ''}`, { replace: true }); };
  const wantView = q.get('view'), wantNew = q.get('new'), wantOpen = q.get('open');
  useEffect(() => { if (!wantView && !wantNew) return; if (VIEWS.includes(wantView)) setView(wantView); if (wantNew === 'task') actions.newTask(); else if (wantNew === 'event') create(); strip('view', 'new'); }, [wantView, wantNew]);
  useEffect(() => { if (!wantOpen || !data.events) return; const o = occ.find((x) => x.key === wantOpen); if (o) setSheet({ occ: o }); strip('open'); }, [wantOpen, data.events]);
  const whoKeys = useMemo(() => [...new Set(boardItems.map((x) => x.who).filter(Boolean))], [boardItems]);
  const nf = filterCount(cfg.filter);
  const opts = (list, key) => list.map((v) => ({ value: v, label: t(`${key}.${v}`) }));
  const dues = useMemo(() => items.filter((o) => o.kind === 'task'), [items]);

  return (
    <div className={`cal${phone ? ' phone' : ''}${rail ? ' rail-open' : ''}`}>
      <aside className="cal-rail" aria-label={t('cal.rail')}>
        <button type="button" className="btn primary cal-create" onClick={() => { setRail(false); create(); }}><Icon name="plus" size={14} />{t('cal.create')}</button>
        <MiniMonth anchor={monthVis ?? anchor} on={view === 'month' ? jump.day : anchor} today={today} holidays={holidays} onPick={(d) => pickDay(d)} />
        <CalendarList space={space} off={off} toggle={toggle} />
      </aside>
      {rail && <div className="cal-scrim" onClick={() => setRail(false)} />}
      <section className="cal-main">
        <div className="cal-bar">
          {phone && <button type="button" className="icon-btn" aria-label={t('cal.rail')} aria-expanded={rail} onClick={() => setRail(!rail)}><Icon name="sidebar" /></button>}
          <button type="button" className="btn sm" onClick={() => (view === 'month' ? jumpTo(today) : setAnchor(today))}>{t('cal.today')}</button>
          {view !== 'month' && <span className="cal-nav">
            <button type="button" className="icon-btn sm" aria-label={t('cal.prev')} onClick={() => go(-1)}><Icon name="back" size={14} /></button>
            <button type="button" className="icon-btn sm" aria-label={t('cal.next')} onClick={() => go(1)}><Icon name="chevron" size={14} /></button>
          </span>}
          <h2 className="cal-title" aria-live="polite">{periodTitle(view, monthVis ?? anchor, phone)}</h2>
          {data.loading && <span className="dim small" role="status">{t('cal.loading')}</span>}
          {data.error && <span className="cal-err small" role="alert">{t(data.error)}</span>}
          <span className="cal-tools">
            {view === 'kanban' && <Dropdown label={t('views.group')} value={cfg.group} options={opts(V.GROUPS, 'views.g')} onChange={(g) => setCfg({ group: g })} />}
            {board && <Dropdown label={t('views.sort')} value={cfg.sort} options={opts(V.SORTS, 'views.s')} onChange={(x) => setCfg({ sort: x })} />}
            {board && <button type="button" className={`btn sm vw-dd${nf ? ' on' : ''}`} aria-haspopup="menu" onClick={(e) => openMenu(e, filterMenu(cfg, setCfg, { whoKeys, categories, people }), { anchor: e.currentTarget })}
              onKeyDown={(e) => { if (e.key === 'ArrowDown') openMenu(e, filterMenu(cfg, setCfg, { whoKeys, categories, people }), { anchor: e.currentTarget }); }}>{nf ? t('views.filterOn', { n: nf }) : t('views.filter')}<Icon name="caret" size={12} /></button>}
            {/* '보기'는 '색' 바로 옆 오른쪽 끝에 고정 — 묶기·정렬·필터는 그 왼쪽에 생기고 사라진다(유건 9/30 1번) */}
            <Dropdown label={t('views.view')} value={view} options={opts(VIEWS, 'views.v')} onChange={setView} />
            <Dropdown label={t('cal.colorBy')} value={colorBy} options={opts(['category', 'person', 'agent'], 'cal.c')} onChange={(k) => { setColorBy(k); setPref('color', k); }} />
            {phone && <button type="button" className="icon-btn" aria-label={t('cal.create')} onClick={() => create()}><Icon name="plus" /></button>}
          </span>
        </div>
        <div className={`cal-body v-${board ? 'board' : view}`} onContextMenu={(e) => { if (!e.target.closest('.cal-chip, .cal-block, .cal-row')) openMenu(e, actions.empty(cfg, setCfg, VIEWS)); }}>
          {view === 'month' && <ScrollMonth {...props} items={dues} space={space} off={off} start={anchor} jump={jump} onMonth={onMonth} onDay={(d, v) => (v ? pickDay(d, v) : (setAnchor(d), setDayList(d)))} />}
          {(view === 'week' || view === 'day') && <TimeGrid {...props} days={view === 'week' ? M.weekDays(anchor) : [anchor]} onDay={(d) => pickDay(d, 'day')} />}
          {board && <ItemsView id={`cal:${space}`} items={boardItems} cfg={cfg} setCfg={setCfg} views={VIEWS} today={today} ctx={ctx} people={people} actions={actions} colorBy={colorBy} onOpen={openItem} />}
        </div>
      </section>
      {dayList && <DayModal day={dayList} {...props} space={space} onClose={() => setDayList(null)} onOpen={(o) => { setDayList(null); open(o); }} />}
      {quick && <QuickCreate draft={quick} space={space} onClose={() => setQuick(null)} onMore={(d) => { setQuick(null); setSheet({ draft: d }); }} />}
      {sheet && <EventSheet key={sheet.occ?.key ?? sheet.draft?.id} init={sheet} space={space} categories={categories} onClose={() => setSheet(null)} onAsk={setAsk} />}
      {ask && <AskScope ask={ask} rows={data.events ?? []} onClose={() => setAsk(null)} onDone={() => { setAsk(null); setSheet(null); }} />}
      {actions.dialogs}
    </div>
  );
}

/* ── 왼쪽 레일 ── */
function MiniMonth({ anchor, on, today, holidays, onPick }) {
  const [month, setMonth] = useState(anchor);
  useEffect(() => { setMonth(anchor); }, [anchor]);
  const grid = M.monthGrid(month), cur = M.monthOf(month);
  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <strong>{fmtDay(month, { year: 'numeric', month: 'long' })}</strong>
        <button type="button" className="icon-btn sm" aria-label={t('cal.prevMonth')} onClick={() => setMonth(M.addMonths(month, -1))}><Icon name="back" size={12} /></button>
        <button type="button" className="icon-btn sm" aria-label={t('cal.nextMonth')} onClick={() => setMonth(M.addMonths(month, 1))}><Icon name="chevron" size={12} /></button>
      </div>
      <div className="cal-mini-grid" role="grid">
        {grid.slice(0, 7).map((d) => <span key={d} className="cal-mini-wd" aria-hidden="true">{fmtDay(d, { weekday: 'narrow' })}</span>)}
        {grid.map((d) => {
          const red = holidays && M.holidaysOn(d).some((h) => h.off);
          return <button key={d} type="button" className={`cal-mini-day${M.monthOf(d) !== cur ? ' out' : ''}${d === today ? ' today' : ''}${d === on ? ' on' : ''}${red || M.weekday(d) === 6 ? ' red' : ''}`}
            aria-label={fmtDay(d, { month: 'long', day: 'numeric', weekday: 'long' })} aria-current={d === today ? 'date' : undefined} onClick={() => onPick(d)}>{Number(d.slice(8))}</button>;
        })}
      </div>
    </div>
  );
}

function CalendarList({ space, off, toggle }) {
  const cals = space === 'me' ? [{ id: 'me', label: t('cal.cal.me') }, ...orgSpaces().map((s) => ({ id: idOf(s), label: s.name }))]
    : [{ id: 'others', label: t('cal.cal.org') }, { id: 'mine', label: t('cal.cal.mine') }];
  const row = (c) => <label key={c.id} className="cal-check"><input type="checkbox" checked={!off.has(c.id)} onChange={() => toggle(c.id)} /><span>{c.label}</span></label>;
  return <>
    <section className="cal-cals"><h4>{t('cal.calendars')}</h4>{cals.map(row)}</section>
    <section className="cal-cals"><h4>{t('cal.overlays')}</h4>{[{ id: 'tasks', label: t('cal.tasks') }, { id: 'holidays', label: t('cal.holidays') }].map(row)}</section>
  </>;
}

/* ── 칩 ── */
function Chip({ o, colorBy, onOpen, onMenu, bar, compact }) {
  const color = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  const label = o.kind === 'task' ? t('cal.taskDue', { title: o.title }) : `${o.title}, ${whenText(o)}`;
  return (
    <button type="button" className={`cal-chip${bar || o.kind === 'task' ? ' bar' : ''}${o.kind === 'task' ? ' task' : ''}${o.done ? ' done' : ''}${color ? '' : ' neutral'}`}
      style={color ? { '--ev': color } : undefined} aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onOpen(o); }} {...(onMenu ? menuProps(() => onMenu(o)) : {})}>
      {o.kind === 'task' ? <Icon name="check" size={11} /> : !bar && <span className="cal-dot" />}
      {!bar && o.kind !== 'task' && !compact && <span className="cal-chip-time">{fmtTime(o.start)}</span>}
      {o.crew && colorBy === 'agent' && <Face id={o.crew} size={12} />}
      <span className="cal-chip-title">{o.title}</span>
    </button>
  );
}

function DateHead({ day, today, holidays, onClick, small }) {
  const hs = holidays ? M.holidaysOn(day) : [];
  const red = hs.some((h) => h.off) || M.weekday(day) === 6;
  return <span className="cal-date">
    <button type="button" className={`cal-num${day === today ? ' today' : ''}${red ? ' red' : ''}`} aria-label={fmtDay(day, { month: 'long', day: 'numeric', weekday: 'long' })} onClick={(e) => { e.stopPropagation(); onClick?.(day); }}>{small ?? Number(day.slice(8))}</button>
    {hs.map((h) => <small key={h.name} className={`cal-holi${h.off ? ' off' : ''}`}>{holidayName(h.name, t)}</small>)}
  </span>;
}

/* ── 월 보기 ── */
/** 한 주(7칸) — 배경 칸(누르면 만들기·폰은 하루 목록) + 날짜 머리 + 줄(lane)에 놓은 칩, 넘치면 '+n개 더'. cur: 진하게 보일 달 */
function WeekRow({ week, cur, items, today, colorBy, holidays, phone, onOpen, onCreate, onDay, onMenu, style, firsts = false }) {
  const segs = [];
  for (const o of items) {
    const [a, b] = M.spanOf(o);
    if (b < week[0] || a > week[6]) continue;
    const bar = o.kind === 'task' || M.isBar(o);
    segs.push({ key: o.key, o, bar, a: Math.max(0, M.dayDiff(week[0], a)), b: bar ? Math.min(6, M.dayDiff(week[0], b)) : Math.max(0, M.dayDiff(week[0], a)) });
  }
  const lanes = M.packLanes(segs);
  const hidden = week.map((_, i) => segs.filter((s) => lanes.get(s.key) >= MAX_LANES && s.a <= i && i <= s.b).length);
  return (
    <div className="cal-week" style={style}>
      <div className="cal-wbg">
        {week.map((d) => <button key={d} type="button" tabIndex={-1} aria-hidden="true" className={`cal-cell${M.monthOf(d) !== cur ? ' out' : ''}`} onClick={() => (phone ? onDay(d) : onCreate({ day: d, allDay: true }))} />)}
      </div>
      <div className="cal-wfg">
        {week.map((d, i) => <div key={d} className={`cal-mdate${M.monthOf(d) !== cur ? ' out' : ''}`} style={{ gridColumn: i + 1 }}><DateHead day={d} today={today} holidays={holidays && !phone} small={firsts && !phone && d.endsWith('-01') ? fmtDay(d, { month: 'short', day: 'numeric' }) : undefined} onClick={(x) => (phone ? onDay(x) : onDay(x, 'day'))} /></div>)}
        {phone ? week.map((d, i) => {
          const here = segs.filter((s) => s.a <= i && i <= s.b).slice(0, 4);
          return here.length > 0 && <span key={d} className="cal-dots" style={{ gridColumn: i + 1, gridRow: 2 }} aria-label={t('cal.nItems', { n: segs.filter((s) => s.a <= i && i <= s.b).length })}>
            {here.map((s) => <span key={s.key} className={`cal-dot${s.o.kind === 'task' ? ' task' : ''}`} style={s.o.kind === 'task' ? undefined : { '--ev': colorOf(s.o, colorBy) }} />)}
          </span>;
        }) : segs.filter((s) => lanes.get(s.key) < MAX_LANES).map((s) => (
          <div key={s.key} className="cal-slot" style={{ gridColumn: `${s.a + 1} / ${s.b + 2}`, gridRow: lanes.get(s.key) + 2 }}><Chip o={s.o} bar={s.bar} colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} /></div>
        ))}
        {!phone && hidden.map((n, i) => n > 0 && <button key={i} type="button" className="cal-more" style={{ gridColumn: i + 1, gridRow: MAX_LANES + 2 }} onClick={() => onDay(week[i])}>{t('cal.more', { n })}</button>)}
      </div>
    </div>
  );
}
const weekHead = (week, phone) => <div className="cal-mhead" aria-hidden="true">{week.map((d) => <span key={d} className={M.weekday(d) === 6 ? 'red' : ''}>{fmtDay(d, { weekday: phone ? 'narrow' : 'short' })}</span>)}</div>;

/** 한 달 격자(6주) — 홈 카드용 */
export function MonthView({ anchor, ...props }) {
  const grid = M.monthGrid(anchor), cur = M.monthOf(anchor);
  const weeks = Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, i * 7 + 7));
  return <div className="cal-month">{weekHead(weeks[0], props.phone)}{weeks.map((week) => <WeekRow key={week[0]} week={week} cur={cur} {...props} />)}</div>;
}

/** 연속 월 보기 — 앞뒤 10년(주)을 한 줄로 두고 보이는 주 근처(앞뒤 BUF주)만 그린다. 주 높이는 보이는 높이를 홀수 주로 나눈 값이라
 *  멈춤(scroll-snap)과 '가운데 주'가 모두 주 경계에 붙는다. 일정은 스크롤이 멈춘 뒤 보이는 주의 달 격자 창만 읽는다(api.js 창 캐시 재사용).
 *  items: 할 일 기한(부모가 준다), 일정은 여기서 창을 읽어 편다. start: 처음 가운데 둘 날, jump: { day, seq }(오늘·작은 달력). onMonth: 제목 달 */
const SPAN = 520, BUF = 4, SETTLE = 160;
function ScrollMonth({ items, space, off, start, jump, onMonth, phone, ...props }) {
  const ref = useRef(null);
  const [base, setBase] = useState(() => M.addDays(M.mondayOf(start), -SPAN * 7));
  const total = SPAN * 2 + 1;
  const [fit, setFit] = useState(null); // { n, h }
  const [top, setTop] = useState(SPAN), [settled, setSettled] = useState(null), [month, setMonth] = useState(M.monthOf(start));
  const pos = useRef(null); // 지금 맨 위 주 번호(소수) — 높이가 바뀌어도 같은 주를 보이게
  const want = useRef({ day: start, smooth: false }), seen = useRef(jump.seq);
  const reduce = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  // 보이는 높이 → 주 수·주 높이
  useLayoutEffect(() => {
    const el = ref.current;
    const measure = () => setFit((f) => { const next = M.weekFit(el.clientHeight, phone ? 58 : 124); return f && f.n === next.n && f.h === next.h ? f : next; });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);
  if (jump.seq !== seen.current) { seen.current = jump.seq; want.current = { day: jump.day, smooth: true }; }
  // 높이가 바뀌면 보던 주 그대로
  useLayoutEffect(() => { if (fit && ref.current && pos.current != null && !want.current) ref.current.scrollTop = pos.current * fit.h; }, [fit]);
  // 가야 할 날이 있으면 그 주를 가운데로 — 범위 밖이면 기준 주를 옮긴 뒤, 멀면(3화면 넘게) 부드럽게 대신 바로.
  // 멈춤(snap)은 그려져 있는 주에만 붙으므로 도착할 자리의 주를 먼저 그린 다음(goal) 스크롤한다
  const [goal, setGoal] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current, w = want.current;
    if (!fit || !el || !w) return;
    const i = M.dayDiff(base, M.mondayOf(w.day)) / 7;
    if (i < BUF * 2 || i > total - BUF * 2) { setBase(M.addDays(M.mondayOf(w.day), -SPAN * 7)); return; }
    const ti = i - (fit.n - 1) / 2;
    w.far ??= reduce || !w.smooth || Math.abs(ti - el.scrollTop / fit.h) > fit.n * 3; // 처음 자리에서 한 번만 정한다(주를 바꿔 그리면 브라우저가 멈춤 자리를 옮긴다)
    if (goal !== ti || (w.far && top !== ti)) { setGoal(ti); if (w.far) setTop(ti); return; }
    want.current = null;
    if (w.far) { el.scrollTop = ti * fit.h; sync(); } else el.scrollTo({ top: ti * fit.h, behavior: 'smooth' });
  });
  // 스크롤 → 맨 위 주·제목 달(한 프레임에 한 번), 멈춘 뒤 읽을 창
  const frame = useRef(0), idle = useRef(0);
  const sync = () => {
    const el = ref.current;
    if (!el || !fit) return;
    const st = el.scrollTop, i = Math.floor(st / fit.h);
    pos.current = st / fit.h;
    setTop(i);
    setMonth(M.dominantMonth(base, st, fit.h, fit.n * fit.h));
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { setSettled(i); if (!want.current) setGoal(null); }, SETTLE);
  };
  const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; sync(); }); };
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(idle.current); }, []);

  const n = fit?.n ?? 5, h = fit?.h ?? 124;
  useEffect(() => { if (settled != null) onMonth(month, M.addDays(base, settled * 7), M.addDays(base, (settled + n) * 7 - 1)); }, [month, settled, base, n]);
  const i0 = Math.max(0, Math.min(top, goal ?? top) - BUF), i1 = Math.min(total - 1, Math.max(top, goal ?? top) + n + BUF);
  const fetchWins = useMemo(() => (settled == null ? [] : M.weekWindows(base, Math.max(0, settled - 1), Math.min(total - 1, settled + n))), [base, settled, n]); // 처음 자리가 정해지기 전에는 읽지 않는다
  const showWins = useMemo(() => M.weekWindows(base, i0, i1), [base, i0, i1]);
  const data = useEventWindows(fetchWins, showWins);
  const lo = M.addDays(base, i0 * 7), hi = M.addDays(base, (i1 + 1) * 7);
  const occ = useMemo(() => M.expand(inSpace(data.events, space), M.kstStart(lo) - 86400e3, M.kstStart(hi) + 86400e3).filter((o) => !off.has(calOf(o, space))), [data.events, space, off, lo, hi]);
  const all = useMemo(() => [...items.filter((o) => { const [a, b] = M.spanOf(o); return b >= lo && a < hi; }), ...occ], [items, occ, lo, hi]);
  const weeks = [];
  for (let i = i0; i <= i1; i++) { const d0 = M.addDays(base, i * 7); weeks.push([i, Array.from({ length: 7 }, (_, k) => M.addDays(d0, k))]); }
  return (
    <div className="cal-month scroll">
      {weekHead(weeks[0][1], phone)}
      <div ref={ref} className="cal-mscroll" tabIndex={0} aria-label={fmtDay(`${month}-01`, { year: 'numeric', month: 'long' })} onScroll={onScroll}>
        <div className="cal-mtrack" style={{ height: total * h }}>
          {weeks.map(([i, week]) => <WeekRow key={week[0]} week={week} cur={month} items={all} phone={phone} {...props} firsts style={{ top: i * h, height: h }} />)}
        </div>
      </div>
    </div>
  );
}

/* ── 주·일 보기 ── */
export function TimeGrid({ days, items, today, now, colorBy, holidays, onOpen, onCreate, onDay, onMenu }) {
  const scroll = useRef(null);
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = Math.max(0, (new Date().getHours() - 1.5) * HOUR); }, [days.length]);
  const bars = [], timed = days.map(() => []);
  for (const o of items) {
    const [a, b] = M.spanOf(o);
    if (b < days[0] || a > days.at(-1)) continue;
    if (o.kind === 'task' || M.isBar(o)) { bars.push({ key: o.key, o, a: Math.max(0, M.dayDiff(days[0], a)), b: Math.min(days.length - 1, M.dayDiff(days[0], b)) }); continue; }
    days.forEach((d, i) => {
      const s0 = M.localStart(d), s1 = M.localStart(M.addDays(d, 1));
      if (o.start < s1 && o.end > s0) timed[i].push({ o, key: o.key, start: Math.max(0, (o.start - s0) / 60e3), end: Math.min(1440, (o.end - s0) / 60e3) });
    });
  }
  const lanes = M.packLanes(bars), laneN = Math.max(1, ...[...lanes.values()].map((n) => n + 1));
  const slot = (e, d) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCreate({ day: d, min: Math.min(23 * 60 + 30, Math.floor(((e.clientY - r.top) / HOUR) * 2) * 30) });
  };
  const nowMin = (now - M.localStart(M.localDay(now))) / 60e3;
  return (
    <div className="cal-tg">
      <div className="cal-tg-head" style={cols}>
        <span />
        {days.map((d) => <div key={d} className={`cal-tg-day${d === today ? ' is-today' : ''}`}>
          <small>{fmtDay(d, { weekday: 'short' })}</small>
          <DateHead day={d} today={today} holidays={holidays} onClick={onDay} />
        </div>)}
      </div>
      <div className="cal-tg-all" style={{ ...cols, gridTemplateRows: `repeat(${laneN}, 24px)` }}>
        <small className="cal-tg-label" style={{ gridRow: `1 / ${laneN + 1}` }}>{t('cal.allDay')}</small>
        {days.map((d, i) => <button key={d} type="button" tabIndex={-1} aria-hidden="true" className="cal-cell" style={{ gridColumn: i + 2, gridRow: `1 / ${laneN + 1}` }} onClick={() => onCreate({ day: d, allDay: true })} />)}
        {bars.map((s) => <div key={s.key} className="cal-slot" style={{ gridColumn: `${s.a + 2} / ${s.b + 3}`, gridRow: lanes.get(s.key) + 1 }}><Chip o={s.o} bar colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} /></div>)}
      </div>
      <div ref={scroll} className="cal-tg-scroll">
        <div className="cal-tg-grid" style={{ ...cols, height: 24 * HOUR }}>
          <div className="cal-hours">{Array.from({ length: 23 }, (_, h) => <small key={h} style={{ top: (h + 1) * HOUR }}>{new Date(2000, 0, 1, h + 1).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ko-KR', { hour: 'numeric' })}</small>)}</div>
          {days.map((d, i) => {
            const pos = M.layoutDay(timed[i]);
            return <div key={d} className="cal-tg-col" onClick={(e) => slot(e, d)}>
              {timed[i].map((x) => {
                const { col, cols: n } = pos.get(x.key), color = colorOf(x.o, colorBy), short = x.end - x.start < 45;
                return <button key={x.key} type="button" className={`cal-block${color ? '' : ' neutral'}${short ? ' short' : ''}`} style={{ top: (x.start / 60) * HOUR, height: Math.max(18, ((x.end - x.start) / 60) * HOUR - 2), left: `${(col / n) * 100}%`, width: `calc(${100 / n}% - 3px)`, ...(color ? { '--ev': color } : {}) }}
                  aria-label={`${x.o.title}, ${whenText(x.o)}`} onClick={(e) => { e.stopPropagation(); onOpen(x.o); }} {...(onMenu ? menuProps(() => onMenu(x.o)) : {})}>
                  <strong>{x.o.crew && <Face id={x.o.crew} size={12} />}{x.o.title}</strong>
                  <small>{whenText(x.o)}{x.o.location && !short ? ` · ${x.o.location}` : ''}</small>
                </button>;
              })}
              {d === today && <span className="cal-now" style={{ top: (nowMin / 60) * HOUR }} aria-hidden="true" />}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}

/* ── 목록·거래처·하루 목록 ── */
function Row({ o, colorBy, onOpen, onMenu }) {
  const color = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  const where = o.kind === 'task' ? t('cal.taskRow') : [calName(o), o.location, o.customer_name].filter(Boolean).join(' · ');
  return (
    <button type="button" className={`cal-row${o.done ? ' done' : ''}`} onClick={() => onOpen(o)} {...(onMenu ? menuProps(() => onMenu(o)) : {})}>
      <span className="cal-row-when">{o.kind === 'task' ? t('cal.due') : whenText(o)}</span>
      {o.kind === 'task' ? <Icon name="check" size={13} className="dim" /> : <span className={`cal-dot${color ? '' : ' neutral'}`} style={color ? { '--ev': color } : undefined} />}
      <span className="cal-row-main"><span className="clamp">{o.title}</span>{where && <small>{where}</small>}</span>
      {o.crew && <Face id={o.crew} size={18} />}
    </button>
  );
}
const calName = (o) => (o.org_id ? spaceOfOrg(o.org_id)?.name ?? '' : t('cal.cal.me'));
/** 날짜별로 — 여러 날에 걸친 일정은 걸친 날마다 */
function byDay(items, from, to) {
  const map = new Map();
  for (const o of items) {
    const [a, b] = M.spanOf(o);
    for (let d = a < from ? from : a; d <= b && d < to; d = M.addDays(d, 1)) map.set(d, [...(map.get(d) ?? []), o]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function DayModal({ day, items, colorBy, holidays, onOpen, onCreate, onClose, onMenu }) {
  const list = byDay(items, day, M.addDays(day, 1))[0]?.[1] ?? [];
  const hs = holidays ? M.holidaysOn(day) : [];
  return <Modal open width={420} title={fmtDay(day, { month: 'long', day: 'numeric', weekday: 'long' })} onClose={onClose}
    footer={<><button type="button" className="btn" onClick={onClose}>{t('cal.close')}</button><button type="button" className="btn primary" onClick={() => { onClose(); onCreate({ day, allDay: false, min: 9 * 60 }); }}><Icon name="plus" size={13} />{t('cal.create')}</button></>}>
    {hs.length > 0 && <p className="cal-day-holi">{hs.map((h) => <span key={h.name} className={`cal-holi${h.off ? ' off' : ''}`}>{holidayName(h.name, t)}</span>)}</p>}
    {list.length ? <div className="cal-list tight">{list.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} />)}</div> : <p className="cal-empty">{t('cal.dayEmpty')}</p>}
  </Modal>;
}

/* ── 만들기·상세 ── */
export function blankDraft(space, { day, min = 9 * 60, allDay = false }) {
  const cal = space === 'me' ? 'me' : idOf(SPACES.find((s) => s.key === space) ?? {});
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const end = Math.min(min + 60, 23 * 60 + 59);
  return { id: newId(), title: '', all_day: allDay, startDay: day, startTime: hm(min), endDay: day, endTime: hm(end), freq: '', interval: 1, until: '', cal, visibility: 'org', attendees: [], category: '', customer_id: '', location: '', note: '' };
}
function draftOf(o) {
  const rule = M.parseRule(o.series?.rrule ?? o.rrule) ?? {};
  const [a, b] = M.spanOf(o);
  return {
    id: o.id, title: o.title, all_day: o.all_day, startDay: o.all_day ? a : M.localDay(o.start), startTime: M.localTime(o.start), endDay: o.all_day ? b : M.localDay(o.end), endTime: M.localTime(o.end),
    freq: rule.freq ?? '', interval: rule.interval ?? 1, until: rule.until ?? '', cal: o.org_id ?? 'me', visibility: o.visibility ?? 'org', attendees: o.attendees ?? [],
    category: o.category ?? '', customer_id: o.customer_id ?? '', location: o.location ?? '', note: o.note ?? '',
  };
}
/** 폼 → 저장값(시각·반복·캘린더) — 시간 일정은 브라우저 시각, 종일은 한국 날짜 */
function rowOf(d) {
  const range = d.all_day ? M.allDayRange(d.startDay, d.endDay) : { starts_at: new Date(M.localAt(d.startDay, d.startTime)).toISOString(), ends_at: new Date(M.localAt(d.endDay, d.endTime)).toISOString() };
  const org = d.cal === 'me' ? null : d.cal;
  return {
    id: d.id, org_id: org, visibility: org ? d.visibility : 'private', title: d.title.trim(), note: d.note.trim(), location: d.location.trim(), category: d.category.trim(),
    customer_id: d.customer_id || null, all_day: d.all_day, ...range, attendees: org ? d.attendees.slice(0, 50) : [],
    rrule: M.ruleString({ freq: d.freq, interval: d.interval, until: d.until || null }), exdates: [], parent_id: null, recur_on: null,
  };
}
/** 서버 행 → 다시 저장할 값(바꿀 것만 덮는다) */
const rowFrom = (r, patch) => ({ id: r.id, org_id: r.org_id, visibility: r.visibility, title: r.title, note: r.note ?? '', location: r.location ?? '', category: r.category ?? '', customer_id: r.customer_id, all_day: r.all_day, starts_at: r.starts_at, ends_at: r.ends_at, attendees: r.attendees ?? [], rrule: r.rrule, exdates: r.exdates ?? [], parent_id: r.parent_id, recur_on: r.recur_on, ...patch });
const problem = (d) => {
  if (!d.title.trim()) return 'cal.error.title';
  const r = rowOf(d);
  if (!(Date.parse(r.ends_at) > Date.parse(r.starts_at))) return 'cal.error.time';
  if (d.freq && d.until && d.until < d.startDay) return 'cal.error.until';
  return null;
};
const calLabel = (cal) => (cal === 'me' ? t('cal.cal.me') : spaceOfOrg(cal)?.name ?? '');

function QuickCreate({ draft, onClose, onMore }) {
  const [d, setD] = useState(draft), [busy, setBusy] = useState(false);
  const formId = useId();
  const save = async (e) => {
    e.preventDefault();
    if (busy || problem(d)) return;
    setBusy(true);
    try { await writeEvent('save', rowOf(d)); onClose(); showToast(t('cal.saved')); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const when = d.all_day ? fmtDay(d.startDay, { month: 'long', day: 'numeric', weekday: 'short' }) + ` · ${t('cal.allDay')}` : `${fmtDay(d.startDay, { month: 'long', day: 'numeric', weekday: 'short' })} · ${fmtTime(M.localAt(d.startDay, d.startTime))} – ${fmtTime(M.localAt(d.endDay, d.endTime))}`;
  return <Modal open width={400} title={t('cal.quick')} onClose={onClose} footer={<>
    <button type="button" className="btn ghost" onClick={() => onMore(d)}>{t('cal.details')}</button>
    <button type="button" className="btn" onClick={onClose}>{t('cal.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={busy || !d.title.trim()}>{t('cal.save')}</button></>}>
    <form id={formId} className="cal-quick" onSubmit={save}>
      <input className="input" maxLength={200} value={d.title} placeholder={t('cal.titleHint')} aria-label={t('cal.f.title')} onChange={(e) => setD({ ...d, title: e.target.value })} />
      <p className="dim small">{when}</p>
      <p className="dim small">{calLabel(d.cal)}</p>
    </form>
  </Modal>;
}

/** 일정 상세·만들기 오른쪽 패널 — 캘린더 페이지와 홈 캘린더 모듈(그 자리에서 열기, 유건 10/1 B-6)이 같이 쓴다 */
export function EventSheet({ init, space, categories, onClose, onAsk }) {
  const o = init.occ ?? null, series = o?.series ?? null;
  const [d, setD] = useState(() => (o ? draftOf(o) : init.draft));
  const [people, setPeople] = useState([]), [customers, setCustomers] = useState([]), [busy, setBusy] = useState(false);
  const formId = useId(), listId = useId();
  const canEdit = !o || o.can_edit;
  const mine = !o || o.owner === ME.id;
  const org = d.cal === 'me' ? null : d.cal;
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => {
    let live = true;
    setPeople([]);
    if (org) loadPeople(org).then((p) => { if (live) setPeople(p); }).catch(() => {});
    loadCustomers(org).then((c) => { if (live) setCustomers(c); }).catch(() => { if (live) setCustomers([]); });
    return () => { live = false; };
  }, [org]);
  const err = problem(d);
  const cals = [{ id: 'me', label: t('cal.cal.me') }, ...writableOrgs().map((s) => ({ id: idOf(s), label: s.name }))];
  if (o?.org_id && !cals.some((c) => c.id === o.org_id)) cals.push({ id: o.org_id, label: calName(o) });
  const custList = o?.customer_id && !customers.some((c) => c.id === o.customer_id) ? [...customers, { id: o.customer_id, name: o.customer_name ?? t('cal.custUnknown') }] : customers;

  const submit = async (e) => {
    e.preventDefault();
    if (busy || err || !canEdit) return;
    if (series) { onAsk({ kind: 'save', occ: o, row: rowOf(d) }); return; }
    setBusy(true);
    try {
      const row = rowOf(d);
      await writeEvent('save', o ? { ...row, exdates: o.exdates ?? [], parent_id: o.parent_id, recur_on: o.recur_on, rrule: o.parent_id ? null : row.rrule } : row);
      showToast(t('cal.saved')); onClose();
    } catch (x) { fail(x); } finally { setBusy(false); }
  };
  const title = !o ? t('cal.new') : canEdit ? t('cal.edit') : t('cal.view.title');
  return <Sheet open title={title} onClose={onClose} footer={<>
    {o && canEdit && <button type="button" className="btn ghost cal-del" onClick={() => onAsk({ kind: 'delete', occ: o })}><Icon name="trash" size={14} />{t('cal.delete')}</button>}
    <button type="button" className="btn" onClick={onClose}>{canEdit ? t('cal.cancel') : t('cal.close')}</button>
    {canEdit && <button type="submit" form={formId} className="btn primary" disabled={busy || !!err}>{t('cal.save')}</button>}</>}>
    {(o?.crew || (o && !mine)) && <div className="cal-by">
      {o.crew && <><Face id={o.crew} size={20} /><span>{t('cal.byAgent', { name: crewName(o.crew) || t('cal.agent') })}</span></>}
      {!mine && <span className="dim">{t('cal.owner', { name: o.owner_name ?? '?' })}</span>}
    </div>}
    {!canEdit && <p className="cal-note">{t('cal.readOnly')}</p>}
    <form id={formId} className="cal-form" onSubmit={submit}>
      <fieldset disabled={!canEdit}>
        <label className="field-block"><span className="label">{t('cal.f.title')}</span><input className="input" maxLength={200} value={d.title} placeholder={t('cal.titleHint')} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="cal-switch"><input type="checkbox" role="switch" checked={d.all_day} onChange={(e) => set({ all_day: e.target.checked })} /><span>{t('cal.allDay')}</span></label>
        <div className="cal-when">
          <label className="field-block"><span className="label">{t('cal.f.start')}</span><span className="cal-dt"><input type="date" className="input" value={d.startDay} onChange={(e) => { const v = e.target.value; if (!v) return; const shiftBy = M.dayDiff(d.startDay, v); set({ startDay: v, endDay: M.addDays(d.endDay, shiftBy) }); }} />{!d.all_day && <input type="time" className="input" value={d.startTime} onChange={(e) => e.target.value && set({ startTime: e.target.value })} />}</span></label>
          <label className="field-block"><span className="label">{t('cal.f.end')}</span><span className="cal-dt"><input type="date" className="input" value={d.endDay} onChange={(e) => e.target.value && set({ endDay: e.target.value })} />{!d.all_day && <input type="time" className="input" value={d.endTime} onChange={(e) => e.target.value && set({ endTime: e.target.value })} />}</span></label>
        </div>
        {!o?.parent_id && <div className="cal-repeat">
          <label className="field-block"><span className="label">{t('cal.f.repeat')}</span><select className="input" value={d.freq} onChange={(e) => set({ freq: e.target.value })}>{['', 'DAILY', 'WEEKLY', 'MONTHLY'].map((f) => <option key={f} value={f}>{t(`cal.r.${f || 'none'}`, { w: fmtDay(d.startDay, { weekday: 'long' }), n: Number(d.startDay.slice(8)) })}</option>)}</select></label>
          {d.freq && <>
            <label className="field-block"><span className="label">{t('cal.f.interval')}</span><span className="cal-int"><input type="number" className="input" min={1} max={99} value={d.interval} onChange={(e) => set({ interval: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })} /><span className="dim small">{t(`cal.unit.${d.freq}`)}</span></span></label>
            <label className="field-block"><span className="label">{t('cal.f.until')}</span><input type="date" className="input" value={d.until} min={d.startDay} onChange={(e) => set({ until: e.target.value })} /></label>
          </>}
        </div>}
        <label className="field-block"><span className="label">{t('cal.f.calendar')}</span><select className="input" value={d.cal} disabled={!!o && !mine} onChange={(e) => set({ cal: e.target.value, attendees: [], customer_id: '' })}>{cals.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        {org && <label className="field-block"><span className="label">{t('cal.f.visibility')}</span><select className="input" value={d.visibility} onChange={(e) => set({ visibility: e.target.value })}><option value="org">{t('cal.vis.org')}</option><option value="private">{t('cal.vis.private')}</option></select></label>}
        {org && <div className="field-block"><span className="label">{t('cal.f.attendees')}</span>
          <div className="chips cal-people">{people.length ? people.map((p) => { const on = d.attendees.includes(p.user_id); return <button key={p.user_id} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set({ attendees: on ? d.attendees.filter((x) => x !== p.user_id) : [...d.attendees, p.user_id].slice(0, 50) })}>{on && <Icon name="check" size={11} />}{p.user_id === ME.id ? t('cal.me') : p.name}</button>; }) : <span className="dim small">{t('cal.loading')}</span>}</div></div>}
        <label className="field-block"><span className="label">{t('cal.f.category')}</span><input className="input" maxLength={40} list={listId} value={d.category} placeholder={t('cal.categoryHint')} onChange={(e) => set({ category: e.target.value })} /><datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
        <label className="field-block"><span className="label">{t('cal.f.customer')}</span><select className="input" value={d.customer_id} onChange={(e) => set({ customer_id: e.target.value })}><option value="">{t('cal.noCustomer')}</option>{custList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field-block"><span className="label">{t('cal.f.location')}</span><input className="input" maxLength={200} value={d.location} onChange={(e) => set({ location: e.target.value })} /></label>
        <label className="field-block"><span className="label">{t('cal.f.note')}</span><textarea className="input area" rows={4} maxLength={4000} value={d.note} onChange={(e) => set({ note: e.target.value })} /></label>
      </fieldset>
      {canEdit && err && d.title.trim() && <p className="cal-err small" role="alert">{t(err)}</p>}
    </form>
  </Sheet>;
}

/** 반복 일정 수정·삭제 범위 묻기 / 한 건 삭제 확인 — 확인 창은 모달(window.confirm 금지) */
export function AskScope({ ask, rows, onClose, onDone }) {
  const { kind, occ, row } = ask, series = occ.series;
  const [scope, setScope] = useState('one'), [busy, setBusy] = useState(false);
  // '이 일정 및 이후' — 서버 split이 UNTIL을 전날로 자르고 그날 뒤의 '이번만 수정' 회차까지 지운다(읽은 창 밖에 있는 것까지). next가 없으면 자르기만.
  const run = async () => {
    setBusy(true);
    try {
      if (kind === 'delete' && !series) await writeEvent('delete', { id: occ.id });
      else if (kind === 'delete') {
        if (scope === 'one') await writeEvent('skip', { id: series.id, day: occ.occ });
        else if (scope === 'all') await writeEvent('delete', { id: series.id });
        else await writeEvent('split', { id: series.id, day: occ.occ });
      } else if (scope === 'one') await writeEvent('save', { ...row, id: newId(), rrule: null, parent_id: series.id, recur_on: occ.occ });
      else if (scope === 'following') await writeEvent('split', { id: series.id, day: occ.occ, next: { ...row, id: newId() } });
      else { // 모든 일정 — 이 회차에서 옮긴 만큼 원본 시작을 옮긴다(길이는 새 값)
        const delta = Date.parse(row.starts_at) - occ.start, s = Date.parse(series.starts_at) + delta, len = Date.parse(row.ends_at) - Date.parse(row.starts_at);
        await writeEvent('save', { ...row, id: series.id, starts_at: new Date(s).toISOString(), ends_at: new Date(s + len).toISOString(), exdates: series.exdates ?? [] });
      }
      showToast(t(kind === 'delete' ? 'cal.deleted' : 'cal.saved')); onDone();
    } catch (e) { fail(e); setBusy(false); }
  };
  const title = t(kind === 'delete' ? (series ? 'cal.deleteRepeat' : 'cal.deleteOne') : 'cal.saveRepeat');
  return <Modal open width={400} title={title} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('cal.cancel')}</button>
    <button type="button" className={`btn ${kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy} onClick={run}>{t(kind === 'delete' ? 'cal.delete' : 'cal.save')}</button></>}>
    {series ? <div className="cal-scope" role="radiogroup" aria-label={title}>
      {['one', 'following', 'all'].map((k) => <label key={k} className="cal-check"><input type="radio" name="scope" checked={scope === k} onChange={() => setScope(k)} /><span>{t(`cal.scope.${k}`)}</span></label>)}
    </div> : <p><strong>{occ.title}</strong><br /><span className="dim small">{t('cal.deleteBody')}</span></p>}
  </Modal>;
}
