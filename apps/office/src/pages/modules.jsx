// 모듈 등록부 — 홈 격자에 놓이는 것은 전부 여기 한 줄씩. 직무별 템플릿(2차)·크루가 만드는 모듈(3차)도 여기에 항목을 더하는 것으로 끝난다.
import { lazy, Suspense, useMemo } from 'react';
import { OFFICE_MODULES } from '../core/module-registry.js';
import { Face } from '../ui/Face.jsx';
import { Icon } from '../ui/Icon.jsx';
import { menuProps, openMenu } from '../ui/Menu.jsx';
import { Link } from '../core/router.jsx';
import { t, ago } from '../core/i18n.js';
import { useStore, toggleTodo, crewName, crewsIn, approvalsIn } from '../core/store.js';
import { baseOf, mailMenu, pageMenu, fileMenu, recordMenu } from '../core/commands.js';
import { SPACES, ME, useSession } from '../core/session.js';
import { useTasks } from '../core/tasks.js';
import { kstDay, groupTasks } from '../core/task-model.js';
import { fmtBytes } from '../core/files.js';
import { pickCards, statsFor, MAX_CARDS } from '../core/stats.js';

export { crewName };
const inSpace = (space) => (x) => space === 'me' || x.space === space;
const spaceName = (key) => SPACES.find((s) => s.key === key)?.name ?? '';

function Empty() { return <div className="mod-empty">{t('mod.empty')}</div>; }

function Approvals({ space }) {
  const list = useStore((s) => s.approvals);
  const rows = useMemo(() => list.filter(approvalsIn(space)), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.slice(0, 4).map((a) => (
    <Link key={a.id} to={`${baseOf(space)}/approvals?open=${a.id}`} className="mod-row" {...menuProps(() => recordMenu(a, a.plain))}>
      <Face id={a.crew} size={18} />
      <span className="mod-main"><span className="clamp">{a.plain}</span><small>{[crewName(a.crew), space === 'me' ? spaceName(a.space) : `#${a.channel}`, ago(a.at)].filter(Boolean).join(' · ')}</small></span>
      {a.risk === 'high' && <span className="badge warn">{t('risk.high')}</span>}
    </Link>
  ));
}

function Work({ space }) {
  const list = useStore((s) => s.work);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.slice(0, 5).map((w) => (
    <Link key={w.id} to={`${baseOf(space)}/work?open=${w.id}`} className="mod-row" {...menuProps(() => recordMenu(w, w.goal))}>
      <span className={`dot ${w.status === 'blocked' ? 'ask' : 'work'}`} />
      <span className="mod-main"><span className="clamp">{w.goal}</span><small>{[crewName(w.lead), w.status === 'blocked' ? t('status.blocked') : t('status.running'), w.status === 'blocked' && w.blockedBy].filter(Boolean).join(' · ')}</small></span>
      <span className="mono dim">{w.steps ?? ago(w.started)}</span>
    </Link>
  ));
}

function Mail() {
  const list = useStore((s) => s.mails);
  const rows = useMemo(() => list.filter((m) => m.folder === 'inbox' && m.unread), [list]);
  if (!rows.length) return <Empty />;
  return rows.map((m) => (
    <Link key={m.id} to={`/me/mail/${m.id}`} className="mod-row" {...menuProps(() => mailMenu(m))}>
      <span className="dot mark" />
      <span className="mod-main"><span className="clamp">{m.subject}</span><small>{m.from} · {ago(m.at)}</small></span>
    </Link>
  ));
}

// 로그인하면 서버에 저장되는 실제 할 일(성과 기록 1단계), 예시 화면은 메일에서 뽑은 할 일
const TaskList = lazy(() => import('./TaskList.jsx'));
function Todos({ space }) {
  const mode = useSession();
  if (mode === 'signedIn') return <Suspense fallback={<div className="mod-empty" role="status">…</div>}><TaskList space={space} /></Suspense>;
  return <SampleTodos />;
}
function SampleTodos() {
  const mails = useStore((s) => s.mails);
  const done = useStore((s) => s.todosDone);
  const rows = useMemo(() => mails.flatMap((m) => (m.note?.todos ?? []).map((text, i) => ({ key: `${m.id}:${i}`, text, crew: m.note.crew, from: m.subject }))), [mails]);
  if (!rows.length) return <Empty />;
  return rows.map((r) => (
    <label key={r.key} className={`mod-row todo${done[r.key] ? ' done' : ''}`}>
      <input type="checkbox" checked={!!done[r.key]} onChange={() => toggleTodo(r.key)} />
      <span className="mod-main"><span className="clamp">{r.text}</span><small>{[crewName(r.crew), r.from].filter(Boolean).join(' · ')}</small></span>
    </label>
  ));
}

function Pages({ space }) {
  const pages = useStore((s) => s.pages);
  const rows = useMemo(() => pages.filter((p) => !p.template && p.space === space).slice().sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)).slice(0, 5), [pages, space]);
  if (!rows.length) return <Empty />;
  return rows.map((p) => (
    <Link key={p.id} to={`${baseOf(space)}/p/${p.id}`} className="mod-row" {...menuProps(() => pageMenu(p))}>
      <Icon name={p.restricted ? 'lock' : 'doc'} size={14} className="dim" />
      <span className="mod-main"><span className="clamp">{p.title || t('page.untitled')}</span></span>
      <small className="dim">{ago(p.updated)}</small>
    </Link>
  ));
}

function Outputs({ space }) {
  const all = useStore((s) => s.outputs);
  const rows = useMemo(() => all.filter(inSpace(space)), [all, space]);
  if (!rows.length) return <Empty />;
  return rows.slice(0, 5).map((f) => (
    <Link key={f.id} to={`${baseOf(space)}/outputs?open=${f.id}`} className="mod-row" {...menuProps(() => fileMenu(f))}>
      <Icon name="file" size={14} className="dim" />
      <span className="mod-main"><span className="clamp mono-name">{f.name}</span><small>{[crewName(f.crew), f.channel && `#${f.channel}`].filter(Boolean).join(' · ')}</small></span>
      <small className="dim mono">{fmtBytes(f.bytes)}</small>
    </Link>
  ));
}

// 홈에는 최근 5건만, 두 줄까지(유건 9/30: 125건이 끝없이 이어져 피곤했다). 전체는 일지 화면에서.
function Journal({ space }) {
  const days = useStore((s) => s.journal);
  const day = days.find(inSpace(space));
  if (!day) return <Empty />;
  return <>
    <div className="mod-date mono">{day.date}</div>
    {day.entries.slice(-5).reverse().map((e, i) => (
      <Link key={i} to={`${baseOf(space)}/journal`} className="mod-row top"><Face id={e.crew} size={18} /><span className="mod-main"><span className="clamp two">{e.text}</span><small>{[crewName(e.crew) || e.name, e.time].filter(Boolean).join(' · ')}</small></span></Link>
    ))}
  </>;
}

function Decisions({ space }) {
  const list = useStore((s) => s.decisions);
  const rows = useMemo(() => list.filter(inSpace(space)).slice(0, 5), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.map((d) => (
    <Link key={d.id} to={`${baseOf(space)}/decisions?open=${d.id}`} className="mod-row">
      <span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span>
      <span className="mod-main"><span className="clamp">{d.plain}</span><small>{[d.by, ago(d.at)].filter(Boolean).join(' · ')}</small></span>
    </Link>
  ));
}

const WEEK = 7 * 24 * 3600 * 1000;
const recent = (at) => Date.now() - new Date(at).getTime() < WEEK;

/** 지표 값 — 카드 한 장에 필요한 것: 큰 숫자(n, 선택 total), 배지(아이콘·말·색), 굵은 줄, 흐린 줄, 누르면 갈 곳 */
function useStatValues(space) {
  const approvals = useStore((s) => s.approvals), work = useStore((s) => s.work), mails = useStore((s) => s.mails);
  const decisions = useStore((s) => s.decisions), pages = useStore((s) => s.pages), done = useStore((s) => s.todosDone);
  const crewList = useStore((s) => s.crews), outputs = useStore((s) => s.outputs);
  const mode = useSession(), tasks = useTasks(space).rows; // 로그인하면 서버에 저장된 실제 할 일로 센다(성과 기록 1단계)
  return useMemo(() => {
    const base = baseOf(space), ok = (text, icon) => ({ tone: 'ok', text, icon }), warn = (text, icon) => ({ tone: 'warn', text, icon });
    const ap = approvals.filter(approvalsIn(space)), high = ap.filter((a) => a.risk === 'high').length;
    const wk = work.filter(inSpace(space)), blocked = wk.filter((w) => w.status === 'blocked').length;
    const unread = mails.filter((m) => m.folder === 'inbox' && m.unread).length;
    const cs = crewsIn(crewList, space, ME.id), working = cs.filter((c) => c.status === 'work').length, asking = cs.filter((c) => c.status === 'ask').length;
    const todos = mails.flatMap((m) => (m.note?.todos ?? []).map((_, i) => `${m.id}:${i}`)), todoDone = todos.filter((k) => done[k]).length;
    const dec = decisions.filter(inSpace(space)).filter((d) => recent(d.at)), approved = dec.filter((d) => d.result === 'approved').length;
    const out = outputs.filter(inSpace(space)).filter((f) => recent(f.at));
    const pg = pages.filter((p) => !p.template && p.space === space), pgRecent = pg.filter((p) => p.updated && recent(p.updated)).length;
    return {
      approvals: { n: ap.length, badge: ap.length ? warn(t('stat.b.waiting'), 'stamp') : ok(t('stat.b.none'), 'stamp'), main: high ? t('stat.highRisk', { n: high }) : t('stat.noHighRisk'), sub: t('stat.approvalsSub'), to: `${base}/approvals` },
      work: { n: wk.length, badge: blocked ? warn(t('stat.b.blocked'), 'run') : ok(t('stat.b.normal'), 'run'), main: t('stat.blocked', { n: blocked }), sub: t('stat.workSub'), to: `${base}/work` },
      mail: { n: unread, badge: unread ? warn(t('stat.b.unread'), 'mail') : ok(t('stat.b.none'), 'mail'), main: unread ? t('stat.mailCheck') : t('stat.mailDone'), sub: t('stat.mailSub'), to: '/me/mail' },
      crews: { n: working, total: cs.length, badge: asking ? warn(t('stat.b.check'), 'person') : ok(t('stat.b.normal'), 'person'), main: t('stat.crewWorking'), sub: t('stat.crewAsk', { n: asking }) },
      todos: mode === 'signedIn' && tasks ? (() => {
        const g = groupTasks(tasks, kstDay(), ME.id), open = g.overdue.length + g.today.length + g.week.length + g.later.length + g.none.length;
        return { n: open, badge: g.overdue.length ? warn(t('stat.b.late'), 'check') : ok(t('stat.b.none'), 'check'), main: t('stat.taskMain', { late: g.overdue.length, today: g.today.length }), sub: t('stat.tasksSub') };
      })() : { n: todos.length - todoDone, badge: todos.length - todoDone ? warn(t('stat.b.open'), 'check') : ok(t('stat.b.none'), 'check'), main: t('stat.todoDone', { done: todoDone, total: todos.length }), sub: t('stat.todosSub') },
      decisions: { n: dec.length, badge: ok(t('stat.b.week'), 'check'), main: t('stat.decided', { a: approved, r: dec.length - approved }), sub: t('stat.weekSub'), to: `${base}/decisions` },
      outputs: { n: out.length, badge: ok(t('stat.b.week'), 'file'), main: fmtBytes(out.reduce((s, f) => s + f.bytes, 0)), sub: t('stat.weekSub'), to: `${base}/outputs` },
      pages: { n: pg.length, badge: ok(t('stat.b.wiki'), 'doc'), main: t('stat.pagesRecent', { n: pgRecent }), sub: t(space === 'me' ? 'stat.pagesMe' : 'stat.pagesOrg') },
    };
  }, [approvals, work, mails, decisions, pages, done, crewList, outputs, space, mode, tasks]);
}

/** 현황 카드(유건 9/27) — 카드마다 지표를 고른다. 1~5장, 조직 홈은 관리자만 바꾼다(구조는 공유). */
function Stats({ space, item, canEdit, setCfg }) {
  const kind = space === 'me' ? 'me' : 'org';
  const cards = pickCards(item?.cfg?.cards, kind);
  const vals = useStatValues(space);
  const unused = statsFor(kind).filter((k) => !cards.includes(k));
  const save = (next) => setCfg?.({ cards: next });
  const change = (i, id) => { const j = cards.indexOf(id); const next = cards.slice(); if (j >= 0) next[j] = cards[i]; next[i] = id; save(next); }; // 이미 있는 지표를 고르면 자리를 바꾼다
  const menuFor = (i) => (!canEdit ? [{ heading: t('home.readOnly') }] : [
    { heading: t('stat.pick') },
    ...statsFor(kind).map((id) => ({ label: t(`stat.${id}`), checked: cards[i] === id, run: () => change(i, id) })),
    cards.length > 1 && { sep: true },
    cards.length > 1 && { label: t('stat.remove'), icon: 'x', run: () => save(cards.filter((_, j) => j !== i)) },
  ].filter(Boolean));
  const add = (e) => openMenu(e, [{ heading: t('stat.add') }, ...unused.map((id) => ({ label: t(`stat.${id}`), run: () => save([...cards, id]) }))], { anchor: e.currentTarget });
  return (
    <div className="stats">
      {cards.map((id, i) => {
        const v = vals[id];
        const body = <>
          <span className="stat-top"><span className="stat-label">{t(`stat.${id}`)}</span><span className={`badge ${v.badge.tone}`}><Icon name={v.badge.icon} size={12} />{v.badge.text}</span></span>
          <span className="stat-num mono">{v.n}{v.total != null && <small> / {v.total}</small>}</span>
          <span className="stat-main">{v.main}</span>
          <span className="stat-sub">{v.sub}</span>
        </>;
        return v.to ? <Link key={id} to={v.to} className="stat-card" {...menuProps(() => menuFor(i))}>{body}</Link>
          : <div key={id} className="stat-card" {...menuProps(() => menuFor(i))}>{body}</div>;
      })}
      {canEdit && cards.length < MAX_CARDS && unused.length > 0 && <button type="button" className="stat-card stat-add" aria-label={t('stat.add')} onClick={add}><Icon name="plus" size={16} /></button>}
    </div>
  );
}

// sizes: s=1/3, m=1/2, l=2/3, full=전체. spaces: 이 모듈을 쓸 수 있는 공간 종류.
const renderers = { stats: Stats, approvals: Approvals, mail: Mail, todos: Todos, pages: Pages, work: Work, outputs: Outputs, journal: Journal, decisions: Decisions };
const BusinessHomeCard = lazy(() => import('../business/HomeModules.jsx').then((module) => ({ default: module.BusinessHomeCard })));
const LazyBusinessHomeProvider = lazy(() => import('../business/HomeModules.jsx').then((module) => ({ default: module.BusinessHomeProvider })));
export function BusinessHomeProvider(props) {
  return <Suspense fallback={<div className="mod-empty" role="status">{t('biz.loading')}</div>}><LazyBusinessHomeProvider {...props} /></Suspense>;
}
export const MODULES = OFFICE_MODULES.map((module) => ({ ...module, render: renderers[module.id] ?? function BusinessModule(props) {
  return <Suspense fallback={<div className="mod-empty" role="status">{t('biz.loading')}</div>}><BusinessHomeCard {...props} tab={module.businessTab} /></Suspense>;
} }));

export const DEFAULTS = {
  me: [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'work', size: 'full' }],
  org: [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'work', size: 'm' }, { id: 'outputs', size: 'l' }, { id: 'journal', size: 's' }, { id: 'decisions', size: 'full' }, { id: 'todos', size: 'full' }],
};
