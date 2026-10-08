// 업무 현황(유건 10/8) — 조직 메뉴. 맥 세션·VPS 봇·아르고 에이전트가 하는 일을 사람별로 한 화면에(연결·지금 하는 일·진행 중·보류·기한·메모).
// 틀(유건 10/8 2차): 위 요약 카드 → 왼쪽 사람 목록(산출물·에이전트 일지와 같은 폴더 줄, ?folder=) → 오른쪽 가로 탭 + 업무 표(전체는 사람별 머리 줄로 묶음).
// 관리자(owner·admin)는 조직 전체, 일반 멤버는 자기 에이전트·자기 세션·자기 일만(서버 office_work_status가 거른다). 묶기·정렬은 core/work-status-model.js.
// 할 일 줄을 누르면 할 일 화면에서 그 일을 연다(?open=id — 할 일 패널). 쓰기 0.
// 갱신: 열 때 1회, 화면이 보이는 동안 60초에 1회, 탭 복귀(1분에 한 번까지 — core/refetch.js 같은 규칙). 갱신 중 실패하면 보던 화면을 그대로 둔다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, ago, getLang, useLang, registerDict } from '../core/i18n.js';
import { ME } from '../core/session.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { refetchDue } from '../core/refetch.js';
import { loadWorkStatus, statusError, POLL_MS } from '../core/work-status.js';
import { buildStatus, sourceOf, PLACES } from '../core/work-status-model.js';
import { Icon } from '../ui/Icon.jsx';
import { pickFolder } from '../ui/FolderView.jsx';
import { kstDay } from '../core/task-model.js';
import { Face } from '../ui/Face.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { WORK_STATUS_DICT } from './work-status-i18n.js';
import './work-status.css';

registerDict(WORK_STATUS_DICT);

const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const dayText = (d) => new Date(`${d}T00:00:00+09:00`).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const isoDay = (iso) => new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const TONE = { doing: 'ok', hold: 'warn' }; // 상태 배지 — 진행 중 초록·보류 노랑·시작 전 회색
const TABS = ['all', 'doing', 'hold', 'overdue', 'now'];
const UNOWNED = 'unowned'; // 왼쪽 목록의 '에이전트 없이 맡긴 일' 줄
const lateDays = (due, today) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400e3);
/** 할 일의 출처 한 줄 — 세션(이름이 없어도 세션)·에이전트·사람 */
const fromText = (x) => { const f = sourceOf(x); return f.kind === 'person' ? t('ws.from.person') : f.name ? t(`ws.from.${f.kind}`, { name: f.name }) : t(`ws.from.${f.kind}Anon`); };
/** 담당 — 실제로 맡은 사람(에이전트·세션 이름은 출처 줄에만) */
const who = (x) => x.assigneeName ?? t('ws.left');
/** 카드 주인 — 내 카드가 아니면 주인 이름(이름을 못 받았으면 '다른 사람') */
const ownerOf = (p) => (p.mine ? null : p.ownerName ?? t('ws.otherOwner'));
const label = (p) => { const o = ownerOf(p); return o ? `${p.name} (${o})` : p.name; };

function useWorkStatus(space) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const last = useRef(0), seq = useRef(0), live = useRef(true), inflight = useRef(0);
  const load = async (quiet) => {
    const n = ++seq.current;
    last.current = Date.now(); inflight.current++; setBusy(true);
    if (!quiet) setError(null);
    try { const d = await loadWorkStatus(space); if (live.current && n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (live.current && n === seq.current) setError(e); } // 갱신 실패여도 받아 둔 화면은 그대로(아래 작은 안내)
    finally { inflight.current--; if (live.current && n === seq.current) setBusy(false); }
  };
  useEffect(() => {
    live.current = true;
    if (space === 'me') return undefined;
    load(false);
    // 화면이 보이는 동안 60초에 1회 + 탭 복귀 — 둘 다 마지막 읽기에서 1분이 지났을 때만(탭을 자주 오가도 분당 한 번)
    const again = () => { if (refetchDue({ hidden: document.visibilityState !== 'visible', now: Date.now(), last: last.current, busy: inflight.current > 0, gap: POLL_MS })) load(true); };
    const id = setInterval(again, POLL_MS);
    document.addEventListener('visibilitychange', again); addEventListener('focus', again);
    return () => { live.current = false; clearInterval(id); document.removeEventListener('visibilitychange', again); removeEventListener('focus', again); };
  }, [space]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, busy, retry: () => load(false) };
}

/** 업무 한 줄(표) — 누르면 할 일 화면의 그 일. 보류면 사유·보류한 날·담당·출처, 아니면 메모 첫 줄(에이전트 없이 맡긴 일은 담당을 앞에) */
function TaskRow({ x, open, today, assignee = false }) {
  const sub = x.status === 'hold'
    ? [x.hold_reason || t('ws.noReason'), x.held_at && t('ws.heldAt', { d: isoDay(x.held_at) }), who(x), fromText(x)].filter(Boolean).join(' · ')
    : [assignee && who(x), x.noteLine].filter(Boolean).join(' · ');
  const late = x.overdue ? lateDays(x.due_on, today) : 0;
  return <tr className="row-link" tabIndex={0} onClick={() => open(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(x.id); }}>
    <td className="ws-st"><span className={`badge ${TONE[x.status] ?? ''}`}>{t(x.status === 'doing' ? 'ws.doing' : x.status === 'hold' ? 'ws.hold' : 'ws.todo')}</span></td>
    <td className="ws-title"><span className="strong">{x.title}</span>{sub && <small className="clamp">{sub}</small>}</td>
    <td className="ws-due">{x.due_on ? <>{late > 0 && <span className="ws-late">{t('ws.lateBy', { n: late })}</span>}<small className={late > 0 ? 'ws-late' : ''}>{dayText(x.due_on)}</small></> : <small className="dim">—</small>}</td>
  </tr>;
}

/** 지금 하는 일 한 줄(작업 중 탭) */
function NowRow({ x, open }) {
  const k = x.kind === 'run' && x.status === 'blocked' ? 'ws.now.blocked' : `ws.now.${x.kind}`;
  const go = x.kind === 'session' ? () => open(x.id) : null;
  return <tr className={go ? 'row-link' : ''} tabIndex={go ? 0 : undefined} onClick={go ?? undefined} onKeyDown={go ? (e) => { if (e.key === 'Enter') go(); } : undefined}>
    <td className="ws-st"><span className={`badge ${x.kind === 'run' && x.status === 'blocked' ? 'warn' : 'ok'}`}>{t(k)}</span></td>
    <td className="ws-title"><span className="strong">{x.kind === 'exec' ? t(`ws.place.${x.place}`) : x.text}</span></td>
    <td className="ws-due" />
  </tr>;
}

const PlaceBadges = ({ p }) => PLACES.filter((k) => p.places[k].length).map((k) => <span key={k} className="badge">{t(`ws.place.${k}`)}{p.places[k].length > 1 ? ` ${p.places[k].length}` : ''}</span>);
const faceOf = (p) => p.places.local[0]?.id ?? p.places.bot[0]?.id;
const seenText = (p) => (p.online ? t('ws.online') : p.lastSeen ? t('ws.lastSeen', { t: ago(new Date(p.lastSeen).toISOString()) }) : t('ws.noReport'));
const openOf = (p) => [...p.doing, ...p.held, ...p.todo];

/** 표 안 사람 머리 줄(전체) — 얼굴·이름·자리·연결·건수·기한 지남 */
function GroupHead({ p, n }) {
  const face = faceOf(p), owner = ownerOf(p);
  return <tr className="ws-grp"><td colSpan={3}><span className="ws-grp-in">
    {face ? <Face id={face} size={18} dim={!p.online} /> : <Icon name="person" size={14} className="dim" />}
    <b>{p.name}</b>{owner && <span className="dim small">{owner}</span>}
    <span className={`dot ${p.online ? 'ok' : 'off'}`} role="img" aria-label={t(p.online ? 'ws.online' : 'ws.offline')} />
    <PlaceBadges p={p} />
    <span className="dim small">{t('ws.grpCount', { n })}</span>
    <span className="grow" />
    {p.overdue > 0 && <span className="badge danger">{t('ws.overdueN', { n: p.overdue })}</span>}
  </span></td></tr>;
}

export default function WorkStatus({ space, folder }) {
  useLang();
  const { data, error, busy, retry } = useWorkStatus(space);
  const view = useMemo(() => (data ? buildStatus(data, { me: ME.id }) : null), [data]);
  const [tab, setTab] = useState('all');
  const head = (sub, right) => <div className="page-title-row"><div><h1 className="page-h1">{t('nav.status')}</h1>{sub && <p className="dim">{sub}</p>}</div>{right}</div>;
  if (space === 'me') return <div className="page-wrap wide ws">{head(null)}<div className="empty-state"><Icon name="layout" size={20} /><p>{t('ws.orgOnly')}</p></div></div>;
  const open = (id) => navigate(`${baseOf(space)}/tasks?open=${encodeURIComponent(id)}`);
  const refresh = <button type="button" className="btn sm" onClick={retry} disabled={busy}><Icon name="refresh" size={13} />{t(busy ? 'ws.loading' : 'ws.refresh')}</button>;

  if (!view) return <div className="page-wrap wide ws">{head(t('ws.sub'))}
    {error ? <LoadFail text={t(statusError(error))} onRetry={retry} /> : <div className="skeleton-lines" aria-busy="true"><span /><span /><span /></div>}</div>;

  const today = kstDay();
  const { summary: s, people, idle, hidden, unowned } = view;
  const unownedRows = [...unowned.doing, ...unowned.held, ...unowned.todo];
  const rail = [...people, ...idle];
  const cur = folder === UNOWNED && unownedRows.length ? UNOWNED : rail.find((p) => p.key === folder) ? folder : 'all';
  const sel = rail.find((p) => p.key === cur) ?? null;
  // 지금 보는 범위(전체·한 사람·에이전트 없이 맡긴 일)의 업무 — 탭 건수도 이 범위에서 센다
  const groups = cur === 'all' ? [...people.map((p) => ({ p, rows: openOf(p) })), ...(unownedRows.length ? [{ p: null, rows: unownedRows }] : [])]
    : cur === UNOWNED ? [{ p: null, rows: unownedRows }] : [{ p: sel, rows: openOf(sel) }];
  const nowRows = (cur === UNOWNED ? [] : cur === 'all' ? people : [sel]).flatMap((p) => p.now.map((x, i) => ({ ...x, p, key: `${p.key}|${x.kind}|${x.id ?? x.crewId ?? i}` })));
  const pick = { all: () => true, doing: (x) => x.status === 'doing', hold: (x) => x.status === 'hold', overdue: (x) => x.overdue };
  const counts = Object.fromEntries(TABS.map((k) => [k, k === 'now' ? nowRows.length : groups.reduce((n, g) => n + g.rows.filter(pick[k]).length, 0)]));
  const tb = TABS.includes(tab) ? tab : 'all';
  const working = people.filter((p) => p.now.length).length;
  const empty = !rail.length && !unownedRows.length;

  const cards = [
    { label: 'ws.card.doing', n: s.doing, badge: { tone: '', icon: 'run', text: t('ws.card.doingBadge') }, main: t('ws.card.doingMain', { todo: rail.reduce((n, p) => n + p.todo.length, 0) + unowned.todo.length, hold: s.hold }), sub: t('ws.card.doingSub') },
    { label: 'ws.card.now', n: working, total: s.people, badge: { tone: s.online ? 'ok' : '', icon: 'person', text: t('ws.card.online', { n: s.online }) }, main: t('ws.card.nowMain', { n: s.online }), sub: t('ws.card.nowSub') },
    { label: 'ws.card.late', n: s.overdue, badge: { tone: s.overdue ? 'danger' : 'ok', icon: 'calendar', text: t(s.overdue ? 'ws.card.lateBadge' : 'ws.card.none') }, main: t('ws.card.lateMain', { hold: s.hold }), sub: t('ws.card.lateSub') },
  ];
  const railItem = (key, icon, name, sub, n, on) => <button key={key} type="button" className={`fold-item ws-rail-item${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => pickFolder(key)}>
    {icon}<span className="ws-rail-text"><span className="fold-name">{name}</span>{sub && <small className="ws-rail-sub">{sub}</small>}</span><small className="fold-n">{n}</small>
  </button>;

  const rows = tb === 'now' ? (cur === 'all' ? people.filter((p) => p.now.length) : []).flatMap((p) => [<GroupHead key={`h:${p.key}`} p={p} n={p.now.length} />, ...nowRows.filter((x) => x.p === p).map((x) => <NowRow key={x.key} x={x} open={open} />)])
      .concat(cur === 'all' ? [] : nowRows.map((x) => <NowRow key={x.key} x={x} open={open} />)) // 전체는 사람별 머리 줄로 묶는다 — 누가 하는 일인지 보이게(검수 10/8)
    : groups.flatMap((g) => {
      const list = g.rows.filter(pick[tb]);
      if (!list.length) return [];
      const head = cur !== 'all' ? [] : g.p ? [<GroupHead key={`h:${g.p.key}`} p={g.p} n={list.length} />]
        : [<tr key="h:unowned" className="ws-grp"><td colSpan={3}><span className="ws-grp-in"><Icon name="person" size={14} className="dim" /><b>{t('ws.unowned')}</b><span className="dim small">{t('ws.grpCount', { n: list.length })}</span></span></td></tr>];
      return [...head, ...list.map((x) => <TaskRow key={x.id} x={x} open={open} today={today} assignee={!g.p} />)];
    });

  return <div className="page-wrap wide ws">
    {head(t(data.admin ? 'ws.sub' : 'ws.subMember'), refresh)}
    {error && <LoadFail small text={t(statusError(error))} onRetry={retry} />}
    <div className="stats ws-stats" role="status">{cards.map((c) => <div key={c.label} className="stat-card">
      <span className="stat-top"><span className="stat-label">{t(c.label)}</span><span className={`badge ${c.badge.tone}`}><Icon name={c.badge.icon} size={12} />{c.badge.text}</span></span>
      <span className="stat-num">{c.n}{c.total != null && <small> / {c.total}</small>}</span>
      <span className="stat-main">{c.main}</span><span className="stat-sub">{c.sub}</span>
    </div>)}</div>
    {empty ? <div className="empty-state"><Icon name="layout" size={20} /><p>{t('ws.empty')}</p></div> : <div className="fold ws-fold">
      <nav className="fold-nav" aria-label={t('ws.people')}>
        {railItem('all', <span className="fold-ico"><Icon name="layout" size={14} /></span>, t('fold.all'), t('ws.railAll', { n: s.online, m: s.people }), rail.reduce((n, p) => n + openOf(p).length, 0) + unownedRows.length, cur === 'all')}
        {rail.map((p) => railItem(p.key, <span className="ws-rail-face">{faceOf(p) ? <Face id={faceOf(p)} size={20} dim={!p.online} /> : <span className="fold-ico"><Icon name="person" size={13} /></span>}<span className={`dot ${p.online ? 'ok' : 'off'}`} /></span>,
          label(p), seenText(p), openOf(p).length, cur === p.key))}
        {unownedRows.length > 0 && railItem(UNOWNED, <span className="fold-ico"><Icon name="person" size={13} /></span>, t('ws.unowned'), t('ws.unownedSub'), unownedRows.length, cur === UNOWNED)}
        {hidden > 0 && <p className="ws-hidden">{t('ws.hiddenN', { n: hidden })}</p>}
      </nav>
      <div className="fold-main">
        {sel && <div className="ws-sel">
          <span className="ws-sel-top">{faceOf(sel) ? <Face id={faceOf(sel)} size={22} dim={!sel.online} /> : <Icon name="person" size={16} className="dim" />}<b>{sel.name}</b>{ownerOf(sel) && <span className="dim small">{ownerOf(sel)}</span>}<PlaceBadges p={sel} /><span className="grow" /><span className="dim small">{seenText(sel)}</span></span>
          {sel.now.length > 0 && <p className="ws-sel-now">{sel.now.map((x) => t(x.kind === 'run' && x.status === 'blocked' ? 'ws.now.blocked' : `ws.now.${x.kind}`) + ' ' + (x.kind === 'exec' ? t(`ws.place.${x.place}`) : x.text)).join(' · ')}</p>}
        </div>}
        <div className="seg ws-tabs" role="group" aria-label={t('ws.tabs')}>{TABS.map((k) => <button key={k} type="button" className={`seg-btn${tb === k ? ' on' : ''}`} aria-pressed={tb === k} onClick={() => setTab(k)}>{t(`ws.tab.${k}`)} <span className="ws-tab-n">{counts[k]}</span></button>)}</div>
        {rows.length ? <div className="table-wrap"><table className="table ws-table">
          <thead><tr><th>{t('ws.col.status')}</th><th>{t(tb === 'now' ? 'ws.col.now' : 'ws.col.task')}</th><th className="ws-due">{tb === 'now' ? '' : t('ws.col.due')}</th></tr></thead>
          <tbody>{rows}</tbody>
        </table></div> : <p className="dim fold-none">{t(tb === 'now' ? 'ws.noNow' : 'ws.noRows')}</p>}
      </div>
    </div>}
  </div>;
}
