// 홈 '캘린더' 모듈(위젯) — 유건 10/1 4차 명세 B절.
// 보기 9가지: 목록·카드·칸반·표(views/Board.jsx 그대로) · 주(노션식 한 주 카드) · 월 · 미니 달력 · 오늘 시간표 · 다음 일정.
// 디자인 3가지(⋯ 메뉴, 기본 미니멀): 미니멀·강조는 주·월·미니에서 모듈 제목 줄을 숨기고(손잡이·⋯는 오른쪽 위에 떠서), 기본은 제목 줄 유지.
// 위젯마다 따로: 색 기준·보여 줄 것(모듈 cfg.cal, 고르지 않은 값은 캘린더 페이지 설정). 높이는 보기를 바꿔도 같다(본문 360px, 사용자가 높이를 정하면 그 높이를 채운다).
// 일정을 누르면 그 자리에서 오른쪽 패널(EventSheet), 날짜를 누르면 그날로 맞춘 캘린더 페이지, '+'는 그 자리에서 만들기. ‹ 오늘 › 이동은 저장하지 않는다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { ME } from '../core/session.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { openMenu, menuProps } from '../ui/Menu.jsx';
import { Modal } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import * as M from '../calendar/model.js';
import * as W from '../calendar/widget-model.js';
import * as V from './model.js';
import { useEvents } from '../calendar/api.js';
import { inSpace, calOf, colorOf, fmtDay, fmtTime, locale, pref, orgSpaces, idOf } from '../calendar/shared.js';
import { TimeGrid, EventSheet, AskScope, blankDraft } from '../calendar/Calendar.jsx';
import { holidayName } from '../calendar/calendar-i18n.js';
import { useViewTasks, usePeople, makeCtx } from './data.js';
import { ItemsView, useItemActions, viewMenu } from './Board.jsx';

const DAY = 86400e3;
const NONE = [];
const BASE = { view: 'list' };
const label = (v) => t(['mini', 'day', 'next'].includes(v) ? `calw.v.${v}` : `views.v.${v}`);

function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export default function CalendarWidget({ space, item, canEdit, setCfg, menu }) {
  useLang();
  const now = useNow(), today = M.localDay(now);
  const [local, setLocal] = useState(null); // 배치를 바꿀 수 없는 사람(조직 홈의 직원) — 이번 화면에서만
  const cfg = V.normalizeCfg(local?.views ?? item?.cfg?.views, BASE, W.WIDGET_VIEWS);
  const rawCal = local?.cal ?? item?.cfg?.cal;
  const off = pref(`off:${space}`, []);
  const page = W.pageDefaults({ color: pref('color', 'category'), off, space, orgIds: space === 'me' ? orgSpaces().map(idOf) : [] });
  const w = W.resolveWidget(rawCal, page);
  const save = (patch) => { if (canEdit && setCfg) { setLocal(null); setCfg(patch); } else setLocal((l) => ({ ...l, ...patch })); };
  const setView = (patch) => {
    const next = V.normalizeCfg({ ...cfg, ...patch }, BASE, W.WIDGET_VIEWS);
    if (JSON.stringify(next) !== JSON.stringify(cfg)) save({ views: next });
  };
  const saveCal = (next) => { if (JSON.stringify(next) !== JSON.stringify(W.normalizeWidget(rawCal))) save({ cal: next }); }; // 바뀐 것이 없으면 쓰지 않는다

  const view = cfg.view, design = w.design, bare = W.isBare(view, design), board = V.BOARD.includes(view);
  const [anchor, setAnchor] = useState(today);
  const [dir, setDir] = useState(0); // 옮긴 방향(미끄러지는 쪽)
  const go = (d) => { setDir(d); setAnchor((a) => W.navShift(view, a, d)); };
  const goToday = () => { setDir(anchor < today ? 1 : anchor > today ? -1 : 0); setAnchor(today); };
  const [from, to] = W.readWindow(view, anchor, today);
  const fresh = useEvents(from, to);
  // ‹ ›로 옮기는 동안 새 창을 읽는 사이에는 보던 일정을 그대로 둔다(달력이 '불러오는 중'으로 깜빡이지 않게)
  const last = useRef(null);
  if (fresh.events) last.current = fresh.events;
  const data = fresh.events || !last.current ? fresh : { ...fresh, events: last.current };
  const allTasks = useViewTasks(space), people = usePeople(space);
  const tasks = w.show.tasks ? allTasks : NONE;
  const ctx = useMemo(() => makeCtx(today, people), [today, people]);
  const ownKey = JSON.stringify(w.own), offKey = off.join('|');
  const occ = useMemo(() => {
    if (!data.events) return NONE;
    const lo = board ? now : M.kstStart(from) - DAY, hi = board ? M.kstStart(M.addDays(today, 7)) : M.kstStart(to) + DAY; // 목록 계열은 지금부터 7일(끝난 일정은 빼고)
    return M.expand(inSpace(data.events, space), lo, hi).filter((o) => W.keepEvent(o, { space, me: ME.id, own: w.own, off, calKey: calOf(o, space) }));
  }, [data.events, space, board, board ? now : 0, from, to, today, ownKey, offKey]);
  const boardItems = useMemo(() => (board ? V.mergeItems(occ, tasks, { from: today, to: M.addDays(today, 7) }) : NONE), [board, occ, tasks, today]);
  const items = useMemo(() => {
    if (board) return NONE;
    const dues = tasks.filter((x) => x.due_on && !x.cancelled_at && x.due_on >= from && x.due_on < to)
      .map((x) => ({ kind: 'task', key: `t:${x.id}`, id: x.id, title: x.title, done: !!x.done_at, space: x.space, all_day: true, start: M.kstStart(x.due_on), end: M.kstStart(M.addDays(x.due_on, 1)), vi: V.taskItem(x) }));
    return [...dues, ...occ];
  }, [board, occ, tasks, from, to]);
  const categories = useMemo(() => [...new Set((data.events ?? []).map((e) => e.category).filter(Boolean))].sort(), [data.events]);

  const base = baseOf(space);
  const [sheet, setSheet] = useState(null), [ask, setAsk] = useState(null), [settings, setSettings] = useState(false);
  const openTask = (x) => navigate(`${baseOf(x.space)}?open=${x.id}`);
  const open = (o) => (o.kind === 'task' ? openTask(o) : setSheet({ occ: o })); // 그 자리에서 오른쪽 패널(페이지 이동 없음)
  const openItem = (it) => (it.kind === 'task' ? openTask(it) : setSheet({ occ: it.src }));
  const openDay = (d) => navigate(`${base}/calendar?day=${d}`);
  const create = (at = {}) => {
    const day = at.day ?? today;
    const min = at.min ?? (day === today ? Math.min(23 * 60, (new Date(now).getHours() + 1) * 60) : 9 * 60);
    setSheet({ draft: blankDraft(space, { day, min, allDay: !!at.allDay }) });
  };
  const actions = useItemActions({ space, ctx, people, categories, onOpen: openItem, onNewEvent: () => create() });
  const onMenu = (o) => actions.single(o.kind === 'task' ? o.vi : V.eventItem(o));
  const [sel, setSel] = useState(today); // 미니 달력에서 고른 날
  const addDay = view === 'mini' ? sel : today; // '+' — 미니에서 날짜를 골랐으면 그 날짜로(B-6)

  if (menu) menu.current = () => [
    ...viewMenu(cfg, setView, W.WIDGET_VIEWS, label),
    ...(board ? [{ heading: t('views.kind') }, ...V.KINDS.map((k) => ({ label: t(`views.k.${k}`), checked: cfg.filter.kind === k, run: () => setView({ filter: { ...cfg.filter, kind: k } }) }))] : []),
    ...(W.DESIGNED.includes(view) ? [{ heading: t('calw.design') }, ...W.DESIGNS.map((d) => ({ label: t(`calw.d.${d}`), checked: design === d, run: () => saveCal({ ...W.normalizeWidget(rawCal), design: d }) }))] : []),
    { sep: true },
    { label: t('calw.settings'), icon: 'gear', run: () => setSettings(true) },
    { sep: true },
  ];

  // 제목 줄을 숨긴 위젯은 그 줄 높이만큼 본문이 길다 — 보기를 바꿔도 모듈 높이가 같게(셸마다 제목 줄 높이가 달라 직접 잰다)
  const root = useRef(null);
  useLayoutEffect(() => {
    const el = root.current, head = el?.closest('.module')?.querySelector(':scope > .module-head');
    if (!bare || !head) return undefined;
    const put = () => el.style.setProperty('--calw-head', `${head.offsetHeight}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(head);
    return () => ro.disconnect();
  }, [bare]);

  const loading = !data.events;
  const colorBy = w.color, holidays = w.show.holidays;
  const common = { items, today, now, colorBy, holidays, onOpen: open, onMenu, onDay: openDay };
  const nav = W.NAVIGABLE.includes(view) && <Nav view={view} onGo={go} onToday={goToday} />;
  const add = <button type="button" className="icon-btn sm calw-add" aria-label={t('calw.add')} title={t('calw.add')} onClick={() => create({ day: addDay })}><Icon name="plus" size={14} /></button>;
  const hero = design === 'accent' && W.DESIGNED.includes(view);
  const period = `${view}:${view === 'week' ? M.mondayOf(anchor) : M.monthOf(anchor)}`;

  let body;
  if (loading && data.error) body = <p className="mod-empty" role="alert">{t(data.error)}</p>;
  else if (loading) body = <p className="mod-empty" role="status">{t('cal.loading')}</p>;
  else if (board) body = <div className="calw-scroll"><ItemsView id={`home:${space}:${item?.id ?? 'x'}`} items={boardItems} cfg={cfg} setCfg={setView} views={W.WIDGET_VIEWS} today={today} ctx={ctx} people={people} actions={actions} colorBy={colorBy} compact onOpen={openItem} /></div>;
  else if (view === 'week') body = <WeekCards key={period} days={M.weekDays(anchor)} dir={dir} {...common} />;
  else if (view === 'month') body = <MonthDots key={period} anchor={anchor} dir={dir} {...common} />;
  else if (view === 'mini') body = <MiniCal key={period} anchor={anchor} dir={dir} sel={sel} onPick={setSel} {...common} />;
  else if (view === 'day') body = <div className="calw-day-grid"><TimeGrid days={[today]} {...common} onCreate={create} /></div>;
  else body = <NextUp {...common} />;

  return (
    <div ref={root} className={`calw d-${design} v-${view}${bare ? ' bare' : ''}`}
      onContextMenu={(e) => { if (!board && !e.target.closest('button, a, .cal-block, .cal-chip')) openMenu(e, actions.empty(cfg, setView, W.WIDGET_VIEWS, label)); }}>
      {hero && <Hero today={today}>{add}</Hero>}
      <div className="calw-top">
        <h4 className="calw-cap" aria-live="polite">{caption(view, anchor, today)}</h4>
        {nav}
        <span className="calw-sp" />
        {!hero && add}
      </div>
      <div key={view} className="calw-body">{body}</div>
      {settings && <WidgetSettings w={w} onClose={() => setSettings(false)} onSave={(next) => saveCal(W.widgetPatch(rawCal, next, page))} />}
      {sheet && <EventSheet key={sheet.occ?.key ?? sheet.draft?.id} init={sheet} space={space} categories={categories} onClose={() => setSheet(null)} onAsk={setAsk} />}
      {ask && <AskScope ask={ask} rows={data.events ?? []} onClose={() => setAsk(null)} onDone={() => { setAsk(null); setSheet(null); }} />}
      {actions.dialogs}
    </div>
  );
}

/* ── 위쪽 줄 ── */
function caption(view, anchor, today) {
  if (view === 'week') {
    const w = M.weekDays(anchor);
    return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${w[0]}T00:00:00Z`), new Date(`${w[6]}T00:00:00Z`));
  }
  if (view === 'month' || view === 'mini') return fmtDay(anchor, anchor.slice(0, 4) === today.slice(0, 4) ? { month: 'long' } : { year: 'numeric', month: 'long' });
  if (view === 'day' || view === 'next') return t('calw.todayIs', { date: fmtDay(today, { month: 'long', day: 'numeric', weekday: 'short' }) });
  return t('calw.next7');
}
function Nav({ view, onGo, onToday }) {
  const week = view === 'week';
  return <span className="calw-nav">
    <button type="button" className="icon-btn sm" aria-label={t(week ? 'calw.prevWeek' : 'calw.prevMonth')} title={t(week ? 'calw.prevWeek' : 'calw.prevMonth')} onClick={() => onGo(-1)}><Icon name="back" size={14} /></button>
    <button type="button" className="btn sm ghost calw-today" onClick={onToday}>{t('calw.today')}</button>
    <button type="button" className="icon-btn sm" aria-label={t(week ? 'calw.nextWeek' : 'calw.nextMonth')} title={t(week ? 'calw.nextWeek' : 'calw.nextMonth')} onClick={() => onGo(1)}><Icon name="chevron" size={14} /></button>
  </span>;
}
/** 강조 디자인 머리 — 오늘 날짜 크게 + 달·요일, 이번 달 진행 막대(주 단위, 지난 주는 채움) */
function Hero({ today, children }) {
  const prog = W.monthProgress(today), cur = prog.findIndex((f) => f > 0 && f < 1);
  return <>
    <div className="calw-hero">
      <span className="calw-big" aria-hidden="true">{Number(today.slice(8))}</span>
      <span className="calw-hero-sub"><strong>{fmtDay(today, { month: 'long' })}</strong><span>{fmtDay(today, { weekday: 'long' })}</span></span>
      <span className="calw-sp" />
      {children}
    </div>
    <div className="calw-prog" role="img" aria-label={t('calw.progress', { n: (cur < 0 ? prog.filter((f) => f === 1).length : cur + 1) })}>
      {prog.map((f, i) => <i key={i} style={{ '--f': f }} />)}
    </div>
  </>;
}

/* ── 날짜 칸 공용 ── */
const isRed = (d, holidays) => M.weekday(d) === 6 || (holidays && M.holidaysOn(d).some((h) => h.off));
const holiText = (d, holidays) => (holidays ? M.holidaysOn(d).map((h) => holidayName(h.name, t)).join(', ') : '');
function Dots({ list, colorBy }) {
  if (!list?.length) return <span className="calw-dots" aria-hidden="true" />;
  return <span className="calw-dots" aria-hidden="true">{list.slice(0, 3).map((o) => {
    const c = o.kind === 'task' ? undefined : colorOf(o, colorBy);
    return <i key={o.key} className={o.kind === 'task' ? 'task' : c ? '' : 'neutral'} style={c ? { '--ev': c } : undefined} />;
  })}</span>;
}
function Weekdays({ days, style = 'short' }) {
  return <div className="calw-wd" aria-hidden="true">{days.map((d) => <span key={d} className={M.weekday(d) === 6 ? 'red' : ''}>{fmtDay(d, { weekday: style })}</span>)}</div>;
}
const dayLabel = (d, holidays, n) => [fmtDay(d, { month: 'long', day: 'numeric', weekday: 'long' }), holiText(d, holidays), n ? t('cal.nItems', { n }) : ''].filter(Boolean).join(', ');

/* ── 월 ── */
function MonthDots({ anchor, dir, items, today, colorBy, holidays, onDay }) {
  const weeks = W.monthWeeks(anchor), cur = M.monthOf(anchor);
  const buckets = useMemo(() => W.dayBuckets(weeks.flat(), items), [anchor, items]);
  return <div className="calw-month">
    <Weekdays days={weeks[0]} />
    <div className="calw-mgrid calw-slide" style={{ '--dx': `${dir * 8}px`, gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
      {weeks.flat().map((d) => {
        const list = buckets.get(d);
        return <button key={d} type="button" className={`calw-cell${M.monthOf(d) !== cur ? ' out' : ''}${d === today ? ' today' : ''}${isRed(d, holidays) ? ' red' : ''}`}
          aria-label={dayLabel(d, holidays, list.length)} aria-current={d === today ? 'date' : undefined} title={holiText(d, holidays) || undefined} onClick={() => onDay(d)}>
          <span className="calw-num">{Number(d.slice(8))}</span>
          <Dots list={list} colorBy={colorBy} />
        </button>;
      })}
    </div>
  </div>;
}

/* ── 미니 달력 + 고른 날 목록 ── */
function MiniCal({ anchor, dir, sel, onPick, items, today, colorBy, holidays, onOpen, onMenu, onDay }) {
  const weeks = W.monthWeeks(anchor), cur = M.monthOf(anchor);
  const days = weeks.flat();
  const buckets = useMemo(() => W.dayBuckets(days.includes(sel) ? days : [...days, sel], items), [anchor, sel, items]);
  const list = buckets.get(sel) ?? [];
  const date = fmtDay(sel, { month: 'long', day: 'numeric', weekday: 'short' });
  return <div className="calw-mini">
    <div className="calw-month">
      <Weekdays days={weeks[0]} style="narrow" />
      <div className="calw-mgrid calw-slide" role="grid" style={{ '--dx': `${dir * 8}px` }}>
        {days.map((d) => <button key={d} type="button" className={`calw-cell${M.monthOf(d) !== cur ? ' out' : ''}${d === today ? ' today' : ''}${d === sel ? ' on' : ''}${isRed(d, holidays) ? ' red' : ''}`}
          aria-label={dayLabel(d, holidays, buckets.get(d)?.length)} aria-pressed={d === sel} aria-current={d === today ? 'date' : undefined} onClick={() => onPick(d)}>
          <span className="calw-num">{Number(d.slice(8))}</span>
          <Dots list={buckets.get(d)} colorBy={colorBy} />
        </button>)}
      </div>
    </div>
    <section className="calw-agenda" aria-label={t('calw.dayItems', { date })}>
      <header className="calw-ag-head">
        <strong className={isRed(sel, holidays) ? 'red' : ''}>{date}</strong>
        {holiText(sel, holidays) && <small className="calw-holi">{holiText(sel, holidays)}</small>}
        <span className="calw-sp" />
        <button type="button" className="calw-link" aria-label={t('calw.openDayOf', { date })} onClick={() => onDay(sel)}>{t('calw.openDay')}<Icon name="chevron" size={12} /></button>
      </header>
      <div key={sel} className="calw-ag-list">
        {list.length ? list.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} />) : <p className="calw-none">{t('cal.dayEmpty')}</p>}
      </div>
    </section>
  </div>;
}
const timeOf = (o) => (o.kind === 'task' ? t('cal.due') : o.all_day || M.isBar(o) ? t('cal.allDay') : fmtTime(o.start));
function Row({ o, colorBy, onOpen, onMenu, when = timeOf(o) }) {
  const c = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  return <button type="button" className={`calw-row${o.done ? ' done' : ''}`} style={c ? { '--ev': c } : undefined} onClick={() => onOpen(o)} {...menuProps(() => onMenu(o))}>
    <span className="calw-row-when">{when}</span>
    {o.kind === 'task' ? <Icon name="check" size={12} className="dim" /> : <span className={`cal-dot${c ? '' : ' neutral'}`} />}
    <span className="calw-row-title">{o.title}</span>
    {o.crew && colorBy === 'agent' && <Face id={o.crew} size={14} />}
  </button>;
}

/* ── 주(노션식 한 주 카드) — 월~일 7칸, 칸마다 그날 카드, 넘치면 칸 안에서 스크롤. 좁으면 날짜별 세로 목록(컨테이너 쿼리) ── */
function WeekCards({ days, dir, items, today, colorBy, holidays, onOpen, onMenu, onDay }) {
  const buckets = useMemo(() => W.dayBuckets(days, items), [days[0], items]);
  return <div className="calw-week calw-slide" style={{ '--dx': `${dir * 8}px` }}>
    {days.map((d) => {
      const list = buckets.get(d);
      return <div key={d} className={`calw-wcol${d === today ? ' today' : ''}`}>
        <button type="button" className={`calw-whead${isRed(d, holidays) ? ' red' : ''}`} aria-label={dayLabel(d, holidays, list.length)} aria-current={d === today ? 'date' : undefined}
          title={holiText(d, holidays) || undefined} onClick={() => onDay(d)}>
          <small>{fmtDay(d, { weekday: 'short' })}</small><span className="calw-num">{Number(d.slice(8))}</span>
        </button>
        <div className="calw-wlist">{list.map((o) => <Card key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} />)}</div>
      </div>;
    })}
  </div>;
}
function Card({ o, colorBy, onOpen, onMenu }) {
  const c = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  return <button type="button" className={`calw-card${o.kind === 'task' ? ' task' : ''}${o.done ? ' done' : ''}${c ? '' : ' neutral'}`} style={c ? { '--ev': c } : undefined}
    title={`${o.title} · ${timeOf(o)}`} onClick={() => onOpen(o)} {...menuProps(() => onMenu(o))}>
    <span className="calw-card-when">{o.kind === 'task' ? <Icon name="check" size={11} /> : <span className={`cal-dot${c ? '' : ' neutral'}`} />}{timeOf(o)}</span>
    <span className="calw-card-title">{o.crew && colorBy === 'agent' && <Face id={o.crew} size={12} />}{o.title}</span>
  </button>;
}

/* ── 다음 일정 하나 ── */
function NextUp({ items, today, now, colorBy, onOpen, onMenu }) {
  const { main, live, rest } = W.nextUp(items, now);
  if (!main) return <p className="calw-none big">{t('calw.noNext')}</p>;
  const c = colorOf(main, colorBy);
  const rel = live ? W.leftParts(now, main.end) : W.untilParts(now, main.start);
  const relText = live ? `${t('calw.live')} · ${t(`calw.left.${rel.unit}`, { n: rel.n })}` : t(`calw.in.${rel.unit}`, { n: rel.n });
  const day = (o) => M.spanOf(o)[0];
  const when = (o) => {
    const d = day(o), time = o.all_day ? t('cal.allDay') : fmtTime(o.start);
    return d === today ? time : `${d === M.addDays(today, 1) ? t('calw.tomorrow') : fmtDay(d, { month: 'short', day: 'numeric' })} ${time}`;
  };
  return <div className="calw-next">
    <button type="button" className={`calw-up${live ? ' live' : ''}${c ? '' : ' neutral'}`} style={c ? { '--ev': c } : undefined} onClick={() => onOpen(main)} {...menuProps(() => onMenu(main))}>
      <span className="calw-up-when"><b>{when(main)}</b><span className="calw-badge">{relText}</span></span>
      <strong className="calw-up-title">{main.crew && colorBy === 'agent' && <Face id={main.crew} size={16} />}{main.title}</strong>
      {(main.location || main.category) && <small className="calw-up-meta">{main.category && <><span className="cal-dot" />{main.category}</>}{main.category && main.location && ' · '}{main.location}</small>}
    </button>
    {rest.length > 0 && <section className="calw-then"><h5>{t('calw.then')}</h5>{rest.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} onMenu={onMenu} when={when(o)} />)}</section>}
  </div>;
}

/* ── 이 모듈 설정 — 색 기준·보여 줄 것(저장 한 번) ── */
function WidgetSettings({ w, onClose, onSave }) {
  const [color, setColor] = useState(w.color), [show, setShow] = useState(w.show);
  const rows = [['org', t('cal.cal.org')], ['me', t('cal.cal.me')], ['tasks', t('cal.tasks')], ['holidays', t('cal.holidays')]];
  return <Modal open width={400} title={t('calw.settingsTitle')} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('cal.cancel')}</button>
    <button type="button" className="btn primary" onClick={() => { onSave({ color, show }); onClose(); }}>{t('cal.save')}</button></>}>
    <div className="calw-set">
      <div className="calw-set-row"><span className="label">{t('calw.colorBy')}</span>
        <div className="seg" role="radiogroup" aria-label={t('calw.colorBy')}>{W.COLOR_BY.map((k) => <button key={k} type="button" role="radio" aria-checked={color === k} className={`seg-btn${color === k ? ' on' : ''}`} onClick={() => setColor(k)}>{t(`cal.c.${k}`)}</button>)}</div>
      </div>
      <fieldset className="calw-set-row"><legend className="label">{t('calw.show')}</legend>
        {rows.map(([k, l]) => <label key={k} className="cal-check"><input type="checkbox" checked={!!show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /><span>{l}</span></label>)}
      </fieldset>
      <p className="dim small">{t('calw.settingsNote')}</p>
    </div>
  </Modal>;
}
