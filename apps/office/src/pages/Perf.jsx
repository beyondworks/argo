// 성과 기록(유건 9/29) — 사람 직원의 일과 성과가 매일 자동으로 쌓이는 개인 기록. 연봉 협상·월말/연말 평가 자료.
// 일간 기록이 주·월·연으로 모인다(숫자는 서버가 원본에서 계산). 본인만 보고, 월말·연말에 공유하면 관리자가 그 사본을 본다.
// 고치기·지우기는 없고 추가만 — 성과 한 줄은 관리자가 허용한 고치기 요청으로 한 번 고친다(원래 내용이 같이 남는다).
import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { t, getLang, registerDict, useLang } from '../core/i18n.js';
import { ME, canManage } from '../core/session.js';
import { useTasks } from '../core/tasks.js';
import { kstDay, groupTasks, dueInfo } from '../core/task-model.js';
import { usePerfReport, usePerfTeam, perfWrite, perfManage } from '../core/perf.js';
import { periodRange, shiftAnchor, groupByDay, groupByMonth, daySummary, rate, canShare } from '../core/perf-model.js';
import { api as mailApi } from '../core/mail.js';
import { orgOf } from '../core/tasks.js';
import { Link } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { PERF_DICT } from './perf-i18n.js';
import './perf.css';
import { Hide } from '../business/Redact.jsx';

registerDict(PERF_DICT);
// 평가 레포트(트랙 C, 유건 10/2 — 인트라넷 인사고과 레포트)는 그 탭을 열 때만 받는다
const PerfEvals = lazy(() => import('./PerfEvals.jsx'));
const EvalStrip = lazy(() => import('./PerfEvals.jsx').then((m) => ({ default: m.EvalStrip })));
const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const money = (n) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(n || 0));
const dayText = (d, opts) => new Date(`${d}T00:00:00+09:00`).toLocaleDateString(locale(), { timeZone: 'Asia/Seoul', ...opts });
const stamp = (v) => new Date(v).toLocaleDateString(locale(), { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
const newId = () => crypto.randomUUID();
const minutes = (m) => (m < 60 ? t('perf.min', { n: m }) : m < 1440 ? t('perf.hour', { n: Math.round(m / 6) / 10 }) : t('perf.day', { n: Math.round(m / 144) / 10 }));
const fail = (e) => showToast(t(e.message));

function periodLabel(p) {
  if (p.unit === 'day') return dayText(p.from, { month: 'long', day: 'numeric', weekday: 'short' });
  if (p.unit === 'week') return `${dayText(p.from, { month: 'short', day: 'numeric' })} – ${dayText(p.to, { month: 'short', day: 'numeric' })}`;
  if (p.unit === 'month') return dayText(p.from, { year: 'numeric', month: 'long' });
  return dayText(p.from, { year: 'numeric' });
}

export default function Perf({ space, tab: asked }) {
  useLang();
  const manager = canManage(space);
  const tabs = manager ? ['mine', 'evals', 'team'] : ['mine', 'evals'];
  const [tab, setTab] = useState(tabs.includes(asked) ? asked : 'mine'), [evalOpen, setEvalOpen] = useState(null);
  if (space === 'me') return <div className="page-wrap"><Head /><div className="empty-state"><Icon name="target" size={20} /><p>{t('perf.orgOnly')}</p></div></div>;
  const openEval = (id) => { setEvalOpen(id); setTab('evals'); };
  return <div className="page-wrap wide perf">
    <Head right={<div className="seg" role="tablist">{tabs.map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' on' : ''}`} onClick={() => { setTab(k); setEvalOpen(null); }}>{t(`perf.tab.${k}`)}</button>)}</div>} />
    {tab === 'team' && manager ? <Team space={space} onEval={openEval} /> : tab === 'evals' ? <Suspense fallback={<p className="dim small" role="status">{t('perf.loading')}</p>}><PerfEvals key={evalOpen ?? 'list'} space={space} manager={manager} openId={evalOpen} /></Suspense> : <Mine space={space} onEval={openEval} />}
  </div>;
}

function Head({ right }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{t('perf.title')}</h1><p className="dim">{t('perf.subtitle')}</p></div>{right}</div>;
}

function Mine({ space, onEval }) {
  const today = kstDay();
  const [unit, setUnit] = useState('day'), [anchor, setAnchor] = useState(today);
  const p = periodRange(unit, anchor);
  const report = usePerfReport(space, p.from, p.to);
  const r = report.data;
  useEffect(() => { // 거래처 메일 신호 — 서버가 6시간에 한 번만 실제로 읽는다. 새로 들어온 것이 있을 때만 다시 불러온다
    let live = true;
    mailApi('signals', { org: orgOf(space) }).then((x) => { if (live && x?.rows > 0) report.reload(); }).catch(() => {});
    return () => { live = false; };
  }, [space]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <div className="perf-bar">
      <div className="seg" role="tablist">{['day', 'week', 'month', 'year'].map((u) => <button key={u} type="button" role="tab" aria-selected={unit === u} className={`seg-btn${unit === u ? ' on' : ''}`} onClick={() => setUnit(u)}>{t(`perf.unit.${u}`)}</button>)}</div>
      <div className="perf-nav">
        <button type="button" className="icon-btn" aria-label={t('perf.prev')} onClick={() => setAnchor(shiftAnchor(unit, anchor, -1))}><Icon name="chevron" size={14} className="flip" /></button>
        <strong>{periodLabel(p)}</strong>
        <button type="button" className="icon-btn" aria-label={t('perf.next')} disabled={p.to >= today} onClick={() => setAnchor(shiftAnchor(unit, anchor, 1))}><Icon name="chevron" size={14} /></button>
        {anchor !== today && <button type="button" className="btn ghost sm" onClick={() => setAnchor(today)}>{t('perf.today')}</button>}
      </div>
      {unit === 'year' && r && <button type="button" className="btn sm" onClick={() => window.print()}><Icon name="file" size={13} />{t('perf.print')}</button>}
    </div>
    {report.error && <p className="biz-error" role="alert">{t(report.error)}</p>}
    {!r ? <p className="dim small" role="status">{report.loading ? t('perf.loading') : ''}</p> : <>
      {unit === 'day' && p.from === today && <Briefing space={space} />}
      <Numbers totals={r.totals} />
      <Goals space={space} goals={r.goals} year={Number(p.to.slice(0, 4))} reload={report.reload} />
      {p.key && <Suspense fallback={null}><EvalStrip space={space} from={p.from} to={p.to} onOpen={onEval} /></Suspense>}
      {p.key && <Review space={space} period={p.key} review={r.reviews?.find((x) => x.period === p.key)} today={today} reload={report.reload} />}
      <Log report={r} space={space} requests={r.requests ?? []} goals={r.goals} reload={report.reload} day={unit === 'day' ? p.from : today} canAdd={p.from <= today && today <= p.to} unit={unit} />
    </>}
  </>;
}

/** 오늘 브리핑 — 내가 맡은 일 중 기한 지난 일·오늘까지인 일. 끝낸 일은 아래 기록에 쌓인다 */
function Briefing({ space }) {
  const { rows } = useTasks(space);
  if (!rows) return null;
  const today = kstDay(), g = groupTasks(rows, today, ME.id), list = [...g.overdue, ...g.today];
  return <section className="module perf-brief" aria-label={t('perf.brief')}>
    <header className="module-head"><Icon name="check" size={15} /><h3>{t('perf.brief')}</h3><span className="dim small">{list.length}</span></header>
    {list.length ? <ul>{list.map((x) => { const info = dueInfo(x.due_on, today); return <li key={x.id} className="perf-item">
      <span className={`badge${info.key === 'overdue' ? ' late' : ''}`}>{info.key === 'overdue' ? t('perf.brief.overdue', { n: info.n }) : t('perf.brief.today')}</span>
      <span className="perf-item-main">{x.title}</span></li>; })}</ul> : <p className="mod-empty">{t('perf.brief.none')}</p>}
  </section>;
}

function Numbers({ totals: s }) {
  const onTime = rate(s.tasks_on_time, s.tasks_due), done = rate(s.tasks_done_due, s.tasks_due);
  const cards = [
    { label: t('perf.n.contract'), num: <Hide k="perf:contract">{money(s.contract)}</Hide>, sub: t('perf.n.contractSub') },
    { label: t('perf.n.paid'), num: <Hide k="perf:paid">{money(s.paid)}</Hide>, sub: t('perf.n.paidSub') },
    { label: t('perf.n.done'), num: s.tasks_done, sub: t('perf.n.doneSub') },
    { label: t('perf.n.onTime'), num: onTime == null ? '—' : `${onTime}%`, sub: onTime == null ? t('perf.n.noDue') : t('perf.n.onTimeSub', { a: s.tasks_on_time, b: s.tasks_due }) },
    { label: t('perf.n.achieve'), num: done == null ? '—' : `${done}%`, sub: done == null ? t('perf.n.noDue') : t('perf.n.achieveSub', { a: s.tasks_done_due, b: s.tasks_due }) },
    { label: t('perf.n.mail'), num: s.mail_threads ? t('perf.n.mailNum', { n: s.mail_good }) : '—', sub: s.mail_threads ? t('perf.n.mailSub', { n: s.mail_normal, c: s.mail_caution }) : t('perf.n.mailNone') },
    { label: t('perf.n.asks'), num: s.req_minutes == null ? '—' : minutes(s.req_minutes), sub: s.req_count ? t('perf.n.asksSub', { n: s.req_count, u: s.req_unanswered, d: s.req_done }) : t('perf.n.asksNone') },
    { label: t('perf.n.other'), num: s.approvals + s.pages + s.crew, sub: t('perf.n.otherSub', { a: s.approvals, b: s.pages, c: s.crew }) },
  ];
  return <div className="stats perf-stats">{cards.map((c) => <div key={c.label} className="stat-card">
    <span className="stat-top"><span className="stat-label">{c.label}</span></span>
    <span className="stat-num mono">{c.num}</span>
    <span className="stat-sub">{c.sub}</span>
  </div>)}</div>;
}

const METRICS = ['', 'contract', 'paid', 'tasks_done', 'on_time'];
function goalValue(g) {
  if (!g.metric) return t('perf.goals.notes', { n: g.notes });
  const fmt = (v) => (g.metric === 'on_time' ? `${v ?? '—'}%` : g.metric === 'tasks_done' ? String(v ?? 0) : money(v));
  return `${fmt(g.value)} / ${fmt(g.target)}`;
}

function Goals({ space, goals, year, reload, readOnly }) {
  const [edit, setEdit] = useState(null);
  const formId = useId();
  const slots = [1, 2, 3].map((position) => goals?.find((g) => g.position === position) ?? { position });
  const save = async (e) => {
    e.preventDefault();
    try {
      await perfWrite(space, 'goal.save', { id: edit.id ?? newId(), year, position: edit.position, title: edit.title.trim(), metric: edit.metric || null, target: edit.metric ? Number(edit.target) : null });
      setEdit(null); reload();
    } catch (err) { fail(err); }
  };
  return <section className="module perf-goals" aria-label={t('perf.goals')}>
    <header className="module-head"><Icon name="target" size={15} /><h3>{t('perf.goals')} · {year}</h3></header>
    <div className="perf-goal-list">{slots.map((g) => {
      const pct = g.metric && g.target ? Math.max(0, Math.min(100, Math.round(((g.value ?? 0) * 100) / g.target))) : null;
      if (!g.id) return readOnly ? null : <button key={g.position} type="button" className="perf-goal empty" onClick={() => setEdit({ position: g.position, title: '', metric: '', target: '' })}><Icon name="plus" size={13} />{t('perf.goals.empty', { n: g.position })}</button>;
      return <div key={g.position} className="perf-goal">
        <div className="perf-goal-head"><strong>{g.title}</strong>{!readOnly && <button type="button" className="icon-btn" aria-label={t('perf.goals.edit')} onClick={() => setEdit({ id: g.id, position: g.position, title: g.title, metric: g.metric ?? '', target: g.target ?? '' })}><Icon name="draft" size={13} /></button>}</div>
        {pct != null && <span className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>}
        <span className="dim small mono">{goalValue(g)}{pct != null ? ` · ${pct}%` : ''}</span>
      </div>;
    })}</div>
    {edit && <Modal open title={t(edit.id ? 'perf.goals.edit' : 'perf.goals.add')} onClose={() => setEdit(null)} footer={<>
      <button type="button" className="btn" onClick={() => setEdit(null)}>{t('perf.close')}</button>
      <button type="submit" form={formId} className="btn primary" disabled={!edit.title.trim() || (edit.metric && !(Number(edit.target) > 0))}>{t('perf.save')}</button></>}>
      <form id={formId} className="perf-form" onSubmit={save}>
        <p className="dim small">{t('perf.goals.hint')}</p>
        <label className="field-block"><span className="label">{t('perf.goals.title')}</span><input className="input" maxLength={200} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
        <label className="field-block"><span className="label">{t('perf.goals.kind')}</span><select className="input" value={edit.metric} onChange={(e) => setEdit({ ...edit, metric: e.target.value })}>{METRICS.map((m) => <option key={m} value={m}>{t(`perf.goals.m.${m || 'text'}`)}</option>)}</select></label>
        {edit.metric && <label className="field-block"><span className="label">{t('perf.goals.target')}</span><input className="input" type="number" min={1} max={edit.metric === 'on_time' ? 100 : undefined} value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} /></label>}
      </form>
    </Modal>}
  </section>;
}

/** 날짜별 기록 — 자동 기록과 성과 한 줄. canAdd면 성과 한 줄 추가·고치기 요청.
 *  일간은 다 펼치고, 주간·월간은 날짜마다 한 줄 요약, 연간은 월 한 줄 → 날짜 한 줄 → 세부 항목(유건 9/30) */
function Log({ report, space, requests = [], goals = [], reload, day, canAdd, unit = 'day' }) {
  const days = useMemo(() => groupByDay(report), [report]);
  const months = useMemo(() => (unit === 'year' ? groupByMonth(days) : null), [days, unit]);
  const [text, setText] = useState(''), [goal, setGoal] = useState(''), [busy, setBusy] = useState(false), [ask, setAsk] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const formId = useId(), foldId = useId();
  const toggle = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const add = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await perfWrite(space, 'note.add', { id: newId(), body: text.trim(), day, goal_id: goal || null });
      setText(''); setGoal(''); setOpen((s) => new Set(s).add(day).add(day.slice(0, 7))); reload(); // 방금 남긴 날(과 그 달)은 펼쳐 둔다
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const submitAsk = async (e) => {
    e.preventDefault();
    try {
      if (ask.mode === 'request') await perfWrite(space, 'edit.request', { id: newId(), note_id: ask.note.id, reason: ask.value.trim() });
      else await perfWrite(space, 'note.edit', { id: newId(), request_id: ask.request.id, body: ask.value.trim() });
      setAsk(null); reload();
    } catch (err) { fail(err); }
  };
  const noteRow = (n) => {
    const q = requests.find((x) => x.note_id === n.id && x.status !== 'rejected') ?? requests.find((x) => x.note_id === n.id);
    const items = !canAdd ? [] : q?.status === 'approved' ? [{ label: t('perf.req.edit'), icon: 'draft', run: () => setAsk({ mode: 'edit', request: q, note: n, value: n.body }) }]
      : q?.status === 'pending' ? [] : [{ label: t('perf.req.ask'), icon: 'hand', run: () => setAsk({ mode: 'request', note: n, value: '' }) }];
    return <li key={n.id} className="perf-item note">
      <span className="badge">{t('perf.note')}</span>
      <span className="perf-item-main">{n.body}{n.edited && <small className="dim" title={t('perf.note.original', { t: n.original })}> · {t('perf.note.edited')}</small>}
        {q && <small className={`perf-req ${q.status}`}> · {t(`perf.req.${q.status}`)}</small>}</span>
      {items.length > 0 && <button type="button" className="icon-btn perf-more" aria-label={t('perf.req.ask')} onClick={(e) => openMenu(e, items, { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>}
    </li>;
  };
  const dayItems = (d) => <ul>
    {d.deals.map((x, i) => <li key={`d${i}`} className="perf-item"><span className={`badge k-${x.kind}`}>{t(`perf.k.${x.kind}`)}</span><span className="perf-item-main">{x.title}{x.co > 1 && <small className="dim"> · {t('perf.co', { n: x.co })}</small>}</span><strong className="mono"><Hide k={`perf:deal:${i}:${x.title}`}>{money(x.amount)}</Hide></strong></li>)}
    {d.tasks.map((x) => <li key={x.id} className="perf-item"><span className="badge">{t('perf.taskDone')}</span><span className="perf-item-main">{x.title}</span><small className={x.due_on ? (x.on_time ? 'ok' : 'late') : 'dim'}>{x.due_on ? t(x.on_time ? 'perf.onTime' : 'perf.late') : t('perf.noDue')}</small></li>)}
    {d.approvals > 0 && <li className="perf-item"><span className="badge">{t('perf.approvals', { n: d.approvals })}</span></li>}
    {d.pages.length > 0 && <li className="perf-item"><span className="badge">{t('perf.pages')}</span><span className="perf-item-main">{d.pages.map((x) => x.title || '—').join(', ')}</span></li>}
    {d.crew > 0 && <li className="perf-item"><span className="badge">{t('perf.crew', { n: d.crew })}</span></li>}
    {d.mail.map((m) => <li key={m.thread_id} className="perf-item"><span className={`badge mail-${m.grade}`}>{t(`perf.g.${m.grade}`)}</span>
      <span className="perf-item-main">{m.customer ?? '—'} <small className="dim">· {m.reasons.map((x) => t(`perf.r.${x}`)).join(' · ')}</small></span>
      {canAdd && m.account && <Link className="btn ghost sm" to={`/me/mail/${m.account}.${m.message_id}`}>{t('perf.mailOpen')}</Link>}</li>)}
    {d.asks.length > 0 && <li className="perf-item"><span className="badge">{t('perf.asks', { n: d.asks.length })}</span>
      <span className="perf-item-main dim">{[d.asks.some((q) => q.minutes != null) && t('perf.asksAvg', { t: minutes(Math.round(d.asks.filter((q) => q.minutes != null).reduce((a, q) => a + q.minutes, 0) / d.asks.filter((q) => q.minutes != null).length)) }),
        d.asks.some((q) => q.unanswered) && t('perf.asksLate', { n: d.asks.filter((q) => q.unanswered).length }), d.asks.some((q) => q.done) && t('perf.asksDone', { n: d.asks.filter((q) => q.done).length })].filter(Boolean).join(' · ')}</span></li>}
    {d.notes.map(noteRow)}
  </ul>;
  // 접힌 한 줄 — 날짜(또는 월) · 칩 · 계약 금액. 세부는 늘 그려 두고 hidden으로 접는다(인쇄 때 모두 펼치려고)
  const fold = (key, label, s, body) => {
    const on = open.has(key), id = `${foldId}-${key}`;
    return <li key={key} className="perf-fold">
      <button type="button" className="perf-fold-row" aria-expanded={on} aria-controls={id} onClick={() => toggle(key)}>
        <Icon name="chevron" size={12} className="perf-fold-chev" />
        <span className="perf-fold-label">{label}</span>
        <span className="perf-fold-chips">{s.chips.map((c) => `${t(`perf.s.${c.key}`)} ${c.n}`).join(' · ')}</span>
        {s.amount != null && <strong className="mono perf-fold-amount"><Hide k={`perf:fold:${key}`} focusable={false}>{money(s.amount)}</Hide></strong>}
      </button>
      <div id={id} className="perf-fold-body" hidden={!on}>{body}</div>
    </li>;
  };
  const dayLabel = (d) => dayText(d, { month: 'long', day: 'numeric', weekday: 'short' });
  const dayFolds = (list) => <ol className="perf-folds">{list.map((d) => fold(d.day, dayLabel(d.day), daySummary(d), dayItems(d)))}</ol>;
  return <section className="module perf-log" aria-label={t('perf.log')}>
    <header className="module-head"><Icon name="history" size={15} /><h3>{t('perf.log')}</h3></header>
    {canAdd && <form className="perf-note-add" onSubmit={add}>
      <input className="input" maxLength={2000} value={text} placeholder={t('perf.note.hint')} aria-label={t('perf.note')} onChange={(e) => setText(e.target.value)} />
      {goals.length > 0 && <select className="input" value={goal} aria-label={t('perf.note.goal')} onChange={(e) => setGoal(e.target.value)}><option value="">{t('perf.note.noGoal')}</option>{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select>}
      <button className="btn sm" disabled={busy || !text.trim()}>{t('perf.note.add')}</button>
    </form>}
    {canAdd && <p className="dim small perf-lock-hint">{t('perf.note.locked')}</p>}
    {!days.length ? <p className="mod-empty">{t('perf.log.empty')}</p>
      : unit === 'day' ? <ol className="perf-days">{days.map((d) => <li key={d.day} className="perf-day"><h4>{dayLabel(d.day)}</h4>{dayItems(d)}</li>)}</ol>
      : unit === 'year' ? <ol className="perf-folds perf-months">{months.map((m) => fold(m.month, dayText(`${m.month}-01`, { year: 'numeric', month: 'long' }), m, dayFolds(m.days)))}</ol>
      : dayFolds(days)}
    {ask && <Modal open title={t(ask.mode === 'request' ? 'perf.req.ask' : 'perf.req.edit')} onClose={() => setAsk(null)} footer={<>
      <button type="button" className="btn" onClick={() => setAsk(null)}>{t('perf.close')}</button>
      <button type="submit" form={formId} className="btn primary" disabled={!ask.value.trim()}>{t(ask.mode === 'request' ? 'perf.req.send' : 'perf.save')}</button></>}>
      <form id={formId} className="perf-form" onSubmit={submitAsk}>
        <blockquote className="perf-quote">{ask.note.body}</blockquote>
        {ask.mode === 'edit' && <p className="dim small">{t('perf.req.once')}</p>}
        <label className="field-block"><span className="label">{t(ask.mode === 'request' ? 'perf.req.reason' : 'perf.note')}</span>
          {ask.mode === 'request' ? <input className="input" maxLength={500} value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })} />
            : <textarea className="input" rows={3} maxLength={2000} value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })} />}</label>
      </form>
    </Modal>}
  </section>;
}

function Thread({ comments }) {
  if (!comments?.length) return null;
  return <ol className="perf-thread">{comments.map((c) => <li key={c.id} className={`c-${c.kind}`}><span className="badge">{t(`perf.c.${c.kind}`)}</span><p>{c.body}</p><small className="dim">{stamp(c.created_at)}</small></li>)}</ol>;
}

/** 본인 평가 상자(월간·연간) — 공유 전 / 요청받음 / 공유됨(답·이의) / 완료(잠금) */
function Review({ space, period, review, today, reload }) {
  const [confirm, setConfirm] = useState(false), [body, setBody] = useState(''), [kind, setKind] = useState('reply');
  const status = review?.status ?? 'none';
  const ready = canShare(period, today);
  const share = async () => { try { await perfWrite(space, 'review.share', { period }); setConfirm(false); reload(); } catch (err) { fail(err); } };
  const send = async (e) => { e.preventDefault(); if (!body.trim()) return; try { await perfWrite(space, 'comment.add', { period, kind, body: body.trim() }); setBody(''); reload(); } catch (err) { fail(err); } };
  return <section className={`module perf-review st-${status}`} aria-label={t('perf.review')}>
    <header className="module-head"><Icon name="stamp" size={15} /><h3>{t('perf.review')}</h3><span className="badge">{t(`perf.st.${status}`)}</span></header>
    <div className="perf-review-body">
      {(status === 'none' || status === 'requested') && <div className="perf-review-row">
        <p>{status === 'requested' ? t('perf.review.requested') : t('perf.review.private')}{!ready && <span className="dim"> {t(period.length === 4 ? 'perf.review.yearFrom' : 'perf.review.notYet')}</span>}</p>
        <button type="button" className="btn primary sm" disabled={!ready} onClick={() => setConfirm(true)}>{t('perf.review.share')}</button>
      </div>}
      {status === 'shared' && <p>{t('perf.review.shared', { date: stamp(review.shared_at) })}</p>}
      {status === 'done' && <p>{t('perf.review.done', { date: stamp(review.done_at) })}</p>}
      <Thread comments={review?.comments} />
      {status === 'shared' && <form className="perf-comment" onSubmit={send}>
        <select className="input" value={kind} aria-label={t('perf.c.reply')} onChange={(e) => setKind(e.target.value)}><option value="reply">{t('perf.c.reply')}</option><option value="objection">{t('perf.c.objection')}</option></select>
        <input className="input" maxLength={4000} value={body} placeholder={t('perf.c.write')} onChange={(e) => setBody(e.target.value)} />
        <button className="btn sm" disabled={!body.trim()}>{t('perf.c.send')}</button>
      </form>}
    </div>
    <Modal open={confirm} title={t('perf.review.shareTitle')} onClose={() => setConfirm(false)} footer={<>
      <button type="button" className="btn" onClick={() => setConfirm(false)}>{t('perf.close')}</button>
      <button type="button" className="btn primary" onClick={share}>{t('perf.review.share')}</button></>}><p>{t('perf.review.shareBody')}</p></Modal>
  </section>;
}

/** 관리자: 구성원별 공유 상태, 공유된 사본 보기·메모·평가 완료, 고치기 요청 허용/거절 */
function Team({ space, onEval }) {
  const today = kstDay();
  const lastMonth = periodRange('month', shiftAnchor('month', today, -1)).key;
  const [period, setPeriod] = useState(lastMonth), [open, setOpen] = useState(null), [memo, setMemo] = useState(''), [finish, setFinish] = useState(false);
  const team = usePerfTeam(space, period, true);
  const d = team.data;
  const act = async (action, data, after) => { try { await perfManage(space, action, data); after?.(); team.reload(); } catch (err) { fail(err); } };
  const review = open && d?.reviews.find((r) => r.user_id === open);
  const name = (id) => d?.members.find((m) => m.user_id === id)?.name ?? '?';
  const periods = [lastMonth, periodRange('month', shiftAnchor('month', today, -2)).key, String(Number(today.slice(0, 4)) - 1), today.slice(0, 4)];
  return <>
    <p className="dim small">{t('perf.team.hint')}</p>
    <div className="perf-bar"><div className="seg" role="tablist">{periods.map((k) => <button key={k} type="button" role="tab" aria-selected={period === k} className={`seg-btn${period === k ? ' on' : ''}`} onClick={() => { setPeriod(k); setOpen(null); }}>{k.length === 4 ? `${k} ${t('perf.team.periodYear')}` : `${k} ${t('perf.team.periodMonth')}`}</button>)}</div></div>
    {team.error && <p className="biz-error" role="alert">{t(team.error)}</p>}
    {d && d.requests.length > 0 && <section className="module perf-requests"><header className="module-head"><Icon name="hand" size={15} /><h3>{t('perf.team.requests')}</h3></header>
      <ul>{d.requests.map((q) => <li key={q.id} className="perf-item"><span className="perf-item-main"><strong>{name(q.user_id)}</strong> · {dayText(q.day, { month: 'short', day: 'numeric' })} · “{q.body}”<br /><small className="dim">{t('perf.team.reason', { t: q.reason })}</small></span>
        <button type="button" className="btn sm" onClick={() => act('edit.decide', { id: q.id, approve: false })}>{t('perf.team.reject')}</button>
        <button type="button" className="btn primary sm" onClick={() => act('edit.decide', { id: q.id, approve: true })}>{t('perf.team.approve')}</button></li>)}</ul></section>}
    {d && <div className="table-wrap"><table className="table perf-team"><thead><tr><th>{t('perf.team.name')}</th><th>{t('perf.team.status')}</th><th /></tr></thead><tbody>
      {d.members.filter((m) => m.user_id !== ME.id).map((m) => { const st = m.review?.status ?? 'none'; return <tr key={m.user_id}><td>{m.name}</td><td><span className={`badge st-${st}`}>{t(`perf.st.${st}`)}</span></td><td className="num">
        {st === 'none' && <button type="button" className="btn sm" onClick={() => act('review.request', { user_id: m.user_id, period })}>{t('perf.team.request')}</button>}
        {(st === 'shared' || st === 'done') && <button type="button" className="btn sm" onClick={() => setOpen(m.user_id)}>{t('perf.team.open')}</button>}
      </td></tr>; })}
    </tbody></table></div>}
    {review && <Modal open width={880} title={`${name(review.user_id)} · ${period}`} onClose={() => setOpen(null)} footer={<>
      <button type="button" className="btn" onClick={() => setOpen(null)}>{t('perf.team.close')}</button>
      {review.status === 'shared' && <button type="button" className="btn primary" onClick={() => setFinish(true)}>{t('perf.team.finish')}</button>}</>}>
      <div className="perf-snapshot">
        <p className="dim small">{t(review.status === 'done' ? 'perf.review.done' : 'perf.review.shared', { date: stamp(review.done_at ?? review.shared_at) })}</p>
        <Numbers totals={review.snapshot.totals} />
        <Suspense fallback={null}><EvalStrip space={space} user={review.user_id} from={periodRange(review.period.length === 4 ? 'year' : 'month', review.period.length === 4 ? `${review.period}-01-01` : `${review.period}-01`).from} to={periodRange(review.period.length === 4 ? 'year' : 'month', review.period.length === 4 ? `${review.period}-01-01` : `${review.period}-01`).to} onOpen={(id) => { setOpen(null); onEval(id); }} /></Suspense>
        {review.snapshot.goals?.length > 0 && <Goals goals={review.snapshot.goals} year={Number(review.period.slice(0, 4))} readOnly />}
        <Log report={review.snapshot} unit={review.period.length === 4 ? 'year' : 'month'} />
        <Thread comments={review.comments} />
        {review.status === 'shared' && <form className="perf-comment" onSubmit={(e) => { e.preventDefault(); if (memo.trim()) act('comment.add', { review_id: review.id, body: memo.trim() }, () => setMemo('')); }}>
          <input className="input" maxLength={4000} value={memo} placeholder={t('perf.c.memoWrite')} onChange={(e) => setMemo(e.target.value)} />
          <button className="btn sm" disabled={!memo.trim()}>{t('perf.c.send')}</button></form>}
      </div>
    </Modal>}
    <Modal open={finish} title={t('perf.team.finish')} onClose={() => setFinish(false)} footer={<>
      <button type="button" className="btn" onClick={() => setFinish(false)}>{t('perf.close')}</button>
      <button type="button" className="btn primary" onClick={() => act('review.done', { review_id: review.id }, () => setFinish(false))}>{t('perf.team.finish')}</button></>}><p>{t('perf.team.finishBody')}</p></Modal>
  </>;
}

