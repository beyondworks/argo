// 일정(캘린더) — 구글 캘린더처럼 전체 페이지를 쓰는 달력(유건 9/30 명세 규칙 1~10).
// 왼쪽 레일(만들기 · 작은 월 달력 · 캘린더 목록), 오른쪽 큰 달력(오늘 · ‹ › · 기간 제목 · 보기 전환 · 색 기준).
// 같은 일정 행이 개인 달력과 조직 달력에 함께 보인다(저장 행은 하나). 할 일 기한은 읽기 전용으로 겹쳐 보인다.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { ME, SPACES, getMode } from '../core/session.js';
import { useTasks } from '../core/tasks.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { crewName } from '../core/store.js';
import { Modal, Sheet, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import * as M from './model.js';
import { useEvents, writeEvent, loadPeople, loadCustomers, loadOrgTasks, sampleTasks } from './api.js';
import { orgSpaces, idOf, spaceOfOrg, writableOrgs, inSpace, calOf, colorOf, fmtDay, fmtTime, locale, pref, setPref } from './shared.js';
import { CAL_DICT, holidayName } from './calendar-i18n.js';
import './calendar.css';

registerDict(CAL_DICT);
const VIEWS = ['day', 'week', 'month', 'list', 'customers'];
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
  if (view === 'list' || view === 'customers') {
    const [a, b] = M.windowOf(view, anchor);
    return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${a}T00:00:00Z`), new Date(`${M.addDays(b, -1)}T00:00:00Z`));
  }
  return fmtDay(anchor, { year: 'numeric', month: 'long' });
}
const whenText = (o) => (o.all_day ? t('cal.allDay') : `${fmtTime(o.start)} – ${fmtTime(o.end)}`);

/* ── 화면 ── */
export default function Calendar({ space, day }) {
  useLang();
  const phone = usePhone(), now = useNow();
  const today = M.localDay(now);
  const [view, setViewState] = useState(() => (phone ? 'list' : pref('view', 'month')));
  const [anchor, setAnchor] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? day : today));
  const [colorBy, setColorBy] = useState(() => pref('color', 'category'));
  const [off, setOff] = useState(() => new Set(pref(`off:${space}`, [])));
  const [rail, setRail] = useState(false);
  const [quick, setQuick] = useState(null), [sheet, setSheet] = useState(null), [ask, setAsk] = useState(null), [dayList, setDayList] = useState(null);
  useEffect(() => { setOff(new Set(pref(`off:${space}`, []))); }, [space]);
  useEffect(() => { if (/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) setAnchor(day); }, [day]);
  const setView = (v) => { setViewState(v); if (!phone) setPref('view', v); };
  const toggle = (id) => { const next = new Set(off); if (next.has(id)) next.delete(id); else next.add(id); setOff(next); setPref(`off:${space}`, [...next]); };

  const [from, to] = M.windowOf(view, anchor);
  const data = useEvents(from, to);
  const tasks = useTaskDues(space);
  const items = useMemo(() => {
    const occ = data.events ? M.expand(inSpace(data.events, space), M.kstStart(from) - 86400e3, M.kstStart(to) + 86400e3).filter((o) => !off.has(calOf(o, space))) : [];
    const dues = off.has('tasks') ? [] : tasks.map((x) => ({ kind: 'task', key: `t:${x.id}`, id: x.id, title: x.title, done: !!x.done_at, space: x.space, all_day: true, start: M.kstStart(x.due_on), end: M.kstStart(M.addDays(x.due_on, 1)) }));
    return [...dues, ...occ];
  }, [data.events, tasks, space, off, from, to]);
  const categories = useMemo(() => [...new Set((data.events ?? []).map((e) => e.category).filter(Boolean))].sort(), [data.events]);
  const holidays = !off.has('holidays');

  const open = (o) => { if (o.kind === 'task') navigate(`${baseOf(o.space)}?open=${o.id}`); else setSheet({ occ: o }); };
  const create = (at) => {
    const base = at ?? { day: anchor === today ? today : anchor, min: anchor === today ? Math.min(23 * 60, (new Date(now).getHours() + 1) * 60) : 9 * 60 };
    const draft = blankDraft(space, base);
    if (at) setQuick(draft); else setSheet({ draft });
  };
  const go = (dir) => setAnchor(M.shift(view, anchor, dir));
  const pickDay = (d, v) => { setAnchor(d); if (v) setView(v); setRail(false); };
  const props = { items, today, now, colorBy, holidays, phone, onOpen: open, onCreate: create };

  return (
    <div className={`cal${phone ? ' phone' : ''}${rail ? ' rail-open' : ''}`}>
      <aside className="cal-rail" aria-label={t('cal.rail')}>
        <button type="button" className="btn primary cal-create" onClick={() => { setRail(false); create(); }}><Icon name="plus" size={14} />{t('cal.create')}</button>
        <MiniMonth anchor={anchor} today={today} holidays={holidays} onPick={(d) => pickDay(d)} />
        <CalendarList space={space} off={off} toggle={toggle} />
      </aside>
      {rail && <div className="cal-scrim" onClick={() => setRail(false)} />}
      <section className="cal-main">
        <div className="cal-bar">
          {phone && <button type="button" className="icon-btn" aria-label={t('cal.rail')} aria-expanded={rail} onClick={() => setRail(!rail)}><Icon name="sidebar" /></button>}
          <button type="button" className="btn sm" onClick={() => setAnchor(today)}>{t('cal.today')}</button>
          <span className="cal-nav">
            <button type="button" className="icon-btn sm" aria-label={t('cal.prev')} onClick={() => go(-1)}><Icon name="back" size={14} /></button>
            <button type="button" className="icon-btn sm" aria-label={t('cal.next')} onClick={() => go(1)}><Icon name="chevron" size={14} /></button>
          </span>
          <h2 className="cal-title" aria-live="polite">{periodTitle(view, anchor, phone)}</h2>
          {data.loading && <span className="dim small" role="status">{t('cal.loading')}</span>}
          {data.error && <span className="cal-err small" role="alert">{t(data.error)}</span>}
          <span className="cal-tools">
            <span className="seg" role="group" aria-label={t('cal.view')}>
              {VIEWS.map((v) => <button key={v} type="button" className={`seg-btn${view === v ? ' on' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>{t(`cal.v.${v}`)}</button>)}
            </span>
            <select className="input cal-color" value={colorBy} aria-label={t('cal.colorBy')} onChange={(e) => { setColorBy(e.target.value); setPref('color', e.target.value); }}>
              {['category', 'person', 'agent'].map((k) => <option key={k} value={k}>{t('cal.colorBy')}: {t(`cal.c.${k}`)}</option>)}
            </select>
            {phone && <button type="button" className="icon-btn" aria-label={t('cal.create')} onClick={() => create()}><Icon name="plus" /></button>}
          </span>
        </div>
        <div className={`cal-body v-${view}`}>
          {view === 'month' && <MonthView {...props} anchor={anchor} onDay={(d, v) => (v ? pickDay(d, v) : setDayList(d))} />}
          {(view === 'week' || view === 'day') && <TimeGrid {...props} days={view === 'week' ? M.weekDays(anchor) : [anchor]} onDay={(d) => pickDay(d, 'day')} />}
          {view === 'list' && <ListView {...props} from={from} to={to} space={space} />}
          {view === 'customers' && <CustomerView {...props} space={space} />}
        </div>
      </section>
      {dayList && <DayModal day={dayList} {...props} space={space} onClose={() => setDayList(null)} onOpen={(o) => { setDayList(null); open(o); }} />}
      {quick && <QuickCreate draft={quick} space={space} onClose={() => setQuick(null)} onMore={(d) => { setQuick(null); setSheet({ draft: d }); }} />}
      {sheet && <EventSheet key={sheet.occ?.key ?? sheet.draft?.id} init={sheet} space={space} categories={categories} onClose={() => setSheet(null)} onAsk={setAsk} />}
      {ask && <AskScope ask={ask} rows={data.events ?? []} onClose={() => setAsk(null)} onDone={() => { setAsk(null); setSheet(null); }} />}
    </div>
  );
}

/** 할 일 기한 — 이 공간의 할 일(useTasks). 개인 공간은 속한 조직에서 나에게 맡겨진 할 일도 */
function useTaskDues(space) {
  const sample = getMode() === 'sample';
  const own = useTasks(space).rows;
  const [extra, setExtra] = useState([]);
  useEffect(() => {
    if (space !== 'me') { setExtra([]); return; }
    let live = true;
    Promise.all(writableOrgs().map((s) => loadOrgTasks(idOf(s)).then((rows) => rows.filter((x) => x.assignee === ME.id).map((x) => ({ ...x, space: s.key }))).catch(() => [])))
      .then((all) => { if (live) setExtra(all.flat()); });
    return () => { live = false; };
  }, [space]);
  return useMemo(() => {
    const here = sample ? sampleTasks(space === 'me' ? null : space) : own ?? [];
    return [...here.map((x) => ({ ...x, space })), ...extra].filter((x) => x.due_on);
  }, [sample, own, extra, space]);
}

/* ── 왼쪽 레일 ── */
function MiniMonth({ anchor, today, holidays, onPick }) {
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
          return <button key={d} type="button" className={`cal-mini-day${M.monthOf(d) !== cur ? ' out' : ''}${d === today ? ' today' : ''}${d === anchor ? ' on' : ''}${red || M.weekday(d) === 6 ? ' red' : ''}`}
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
function Chip({ o, colorBy, onOpen, bar, compact }) {
  const color = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  const label = o.kind === 'task' ? t('cal.taskDue', { title: o.title }) : `${o.title}, ${whenText(o)}`;
  return (
    <button type="button" className={`cal-chip${bar || o.kind === 'task' ? ' bar' : ''}${o.kind === 'task' ? ' task' : ''}${o.done ? ' done' : ''}${color ? '' : ' neutral'}`}
      style={color ? { '--ev': color } : undefined} aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onOpen(o); }}>
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
function MonthView({ anchor, items, today, colorBy, holidays, phone, onOpen, onCreate, onDay }) {
  const grid = M.monthGrid(anchor), cur = M.monthOf(anchor);
  const weeks = Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, i * 7 + 7));
  return (
    <div className="cal-month">
      <div className="cal-mhead" aria-hidden="true">{weeks[0].map((d) => <span key={d} className={M.weekday(d) === 6 ? 'red' : ''}>{fmtDay(d, { weekday: phone ? 'narrow' : 'short' })}</span>)}</div>
      {weeks.map((week) => {
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
          <div key={week[0]} className="cal-week">
            <div className="cal-wbg">
              {week.map((d) => <button key={d} type="button" tabIndex={-1} aria-hidden="true" className={`cal-cell${M.monthOf(d) !== cur ? ' out' : ''}`} onClick={() => (phone ? onDay(d) : onCreate({ day: d, allDay: true }))} />)}
            </div>
            <div className="cal-wfg">
              {week.map((d, i) => <div key={d} className={`cal-mdate${M.monthOf(d) !== cur ? ' out' : ''}`} style={{ gridColumn: i + 1 }}><DateHead day={d} today={today} holidays={holidays && !phone} onClick={(x) => (phone ? onDay(x) : onDay(x, 'day'))} /></div>)}
              {phone ? week.map((d, i) => {
                const here = segs.filter((s) => s.a <= i && i <= s.b).slice(0, 4);
                return here.length > 0 && <span key={d} className="cal-dots" style={{ gridColumn: i + 1, gridRow: 2 }} aria-label={t('cal.nItems', { n: segs.filter((s) => s.a <= i && i <= s.b).length })}>
                  {here.map((s) => <span key={s.key} className={`cal-dot${s.o.kind === 'task' ? ' task' : ''}`} style={s.o.kind === 'task' ? undefined : { '--ev': colorOf(s.o, colorBy) }} />)}
                </span>;
              }) : segs.filter((s) => lanes.get(s.key) < MAX_LANES).map((s) => (
                <div key={s.key} className="cal-slot" style={{ gridColumn: `${s.a + 1} / ${s.b + 2}`, gridRow: lanes.get(s.key) + 2 }}><Chip o={s.o} bar={s.bar} colorBy={colorBy} onOpen={onOpen} /></div>
              ))}
              {!phone && hidden.map((n, i) => n > 0 && <button key={i} type="button" className="cal-more" style={{ gridColumn: i + 1, gridRow: MAX_LANES + 2 }} onClick={() => onDay(week[i])}>{t('cal.more', { n })}</button>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 주·일 보기 ── */
function TimeGrid({ days, items, today, now, colorBy, holidays, onOpen, onCreate, onDay }) {
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
        {bars.map((s) => <div key={s.key} className="cal-slot" style={{ gridColumn: `${s.a + 2} / ${s.b + 3}`, gridRow: lanes.get(s.key) + 1 }}><Chip o={s.o} bar colorBy={colorBy} onOpen={onOpen} /></div>)}
      </div>
      <div ref={scroll} className="cal-tg-scroll">
        <div className="cal-tg-grid" style={{ ...cols, height: 24 * HOUR }}>
          <div className="cal-hours">{Array.from({ length: 23 }, (_, h) => <small key={h} style={{ top: (h + 1) * HOUR }}>{fmtTime(new Date(2000, 0, 1, h + 1).getTime())}</small>)}</div>
          {days.map((d, i) => {
            const pos = M.layoutDay(timed[i]);
            return <div key={d} className="cal-tg-col" onClick={(e) => slot(e, d)}>
              {timed[i].map((x) => {
                const { col, cols: n } = pos.get(x.key), color = colorOf(x.o, colorBy), short = x.end - x.start < 45;
                return <button key={x.key} type="button" className={`cal-block${color ? '' : ' neutral'}${short ? ' short' : ''}`} style={{ top: (x.start / 60) * HOUR, height: Math.max(18, ((x.end - x.start) / 60) * HOUR - 2), left: `${(col / n) * 100}%`, width: `calc(${100 / n}% - 3px)`, ...(color ? { '--ev': color } : {}) }}
                  aria-label={`${x.o.title}, ${whenText(x.o)}`} onClick={(e) => { e.stopPropagation(); onOpen(x.o); }}>
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
function Row({ o, colorBy, onOpen, date }) {
  const color = o.kind === 'task' ? undefined : colorOf(o, colorBy);
  const where = o.kind === 'task' ? t('cal.taskRow') : [calName(o), o.location, o.customer_name].filter(Boolean).join(' · ');
  return (
    <button type="button" className={`cal-row${o.done ? ' done' : ''}`} onClick={() => onOpen(o)}>
      <span className="cal-row-when">{date && <b>{fmtDay(date, { month: 'short', day: 'numeric', weekday: 'short' })}</b>}{o.kind === 'task' ? t('cal.due') : whenText(o)}</span>
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

function ListView({ items, from, to, today, holidays, colorBy, onOpen }) {
  const start = from < today && today < to ? today : from;
  const days = byDay(items, start, to);
  if (!days.length) return <p className="cal-empty">{t('cal.listEmpty')}</p>;
  return <div className="cal-list">{days.map(([d, list]) => {
    const hs = holidays ? M.holidaysOn(d) : [];
    return <section key={d} className="cal-list-day">
      <h3 className={hs.some((h) => h.off) || M.weekday(d) === 6 ? 'red' : ''}>{fmtDay(d, { month: 'long', day: 'numeric', weekday: 'short' })}{d === today && <span className="badge">{t('cal.today')}</span>}{hs.map((h) => <small key={h.name} className={`cal-holi${h.off ? ' off' : ''}`}>{holidayName(h.name, t)}</small>)}</h3>
      {list.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} />)}
    </section>;
  })}</div>;
}

function CustomerView({ items, colorBy, onOpen }) {
  const groups = new Map();
  for (const o of items) if (o.kind !== 'task' && o.customer_id) groups.set(o.customer_id, [...(groups.get(o.customer_id) ?? []), o]);
  const list = [...groups.values()].sort((a, b) => (a[0].customer_name ?? '').localeCompare(b[0].customer_name ?? ''));
  if (!list.length) return <p className="cal-empty">{t('cal.custEmpty')}</p>;
  return <div className="cal-list">{list.map((g) => <section key={g[0].customer_id} className="cal-list-day">
    <h3><Icon name="person" size={14} className="dim" />{g[0].customer_name ?? t('cal.custUnknown')}<small className="dim">{t('cal.nItems', { n: g.length })}</small></h3>
    {g.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} date={M.spanOf(o)[0]} />)}
  </section>)}</div>;
}

function DayModal({ day, items, colorBy, holidays, onOpen, onCreate, onClose }) {
  const list = byDay(items, day, M.addDays(day, 1))[0]?.[1] ?? [];
  const hs = holidays ? M.holidaysOn(day) : [];
  return <Modal open width={420} title={fmtDay(day, { month: 'long', day: 'numeric', weekday: 'long' })} onClose={onClose}
    footer={<><button type="button" className="btn" onClick={onClose}>{t('cal.close')}</button><button type="button" className="btn primary" onClick={() => { onClose(); onCreate({ day, allDay: false, min: 9 * 60 }); }}><Icon name="plus" size={13} />{t('cal.create')}</button></>}>
    {hs.length > 0 && <p className="cal-day-holi">{hs.map((h) => <span key={h.name} className={`cal-holi${h.off ? ' off' : ''}`}>{holidayName(h.name, t)}</span>)}</p>}
    {list.length ? <div className="cal-list tight">{list.map((o) => <Row key={o.key} o={o} colorBy={colorBy} onOpen={onOpen} />)}</div> : <p className="cal-empty">{t('cal.dayEmpty')}</p>}
  </Modal>;
}

/* ── 만들기·상세 ── */
function blankDraft(space, { day, min = 9 * 60, allDay = false }) {
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

function EventSheet({ init, space, categories, onClose, onAsk }) {
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
function AskScope({ ask, rows, onClose, onDone }) {
  const { kind, occ, row } = ask, series = occ.series;
  const [scope, setScope] = useState('one'), [busy, setBusy] = useState(false);
  // '이 일정 및 이후' — 그 날짜부터 뒤의 '이번만 수정'한 회차도 같이 지운다(읽은 창 안에 있는 것만)
  const dropLater = () => Promise.all(rows.filter((r) => r.parent_id === series.id && r.recur_on >= occ.occ).map((r) => writeEvent('delete', { id: r.id }, { refresh: false })));
  const run = async () => {
    setBusy(true);
    try {
      if (series && scope === 'following') await dropLater();
      if (kind === 'delete' && !series) await writeEvent('delete', { id: occ.id });
      else if (kind === 'delete') {
        if (scope === 'one') await writeEvent('skip', { id: series.id, day: occ.occ });
        else if (scope === 'all' || occ.occ <= M.kstDay(series.starts_at)) await writeEvent('delete', { id: series.id });
        else await writeEvent('save', rowFrom(series, { rrule: M.ruleString({ ...M.parseRule(series.rrule), until: M.addDays(occ.occ, -1) }) }));
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
