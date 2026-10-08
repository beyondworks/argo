// 업무 현황(유건 10/8) — 조직 메뉴. 맥 세션·VPS 봇·아르고 에이전트가 하는 일을 사람별로 한 화면에(연결·지금 하는 일·진행 중·보류·기한·메모).
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
import { buildStatus, PLACES } from '../core/work-status-model.js';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { WORK_STATUS_DICT } from './work-status-i18n.js';
import './work-status.css';

registerDict(WORK_STATUS_DICT);

const SHOW = 3; // 사람 카드의 칸마다 보이는 할 일 수
const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const dayText = (d) => new Date(`${d}T00:00:00+09:00`).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const isoDay = (iso) => new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const DOT = { doing: 'work', hold: 'ask' };
/** 할 일의 출처 한 줄 — 세션(이름이 없어도 세션)·에이전트·사람 */
const fromText = (x) => (x.source?.kind === 'session' ? (x.source.name ? t('ws.from.session', { name: x.source.name }) : t('ws.from.sessionAnon'))
  : x.source?.kind === 'crew' ? t('ws.from.crew', { name: x.personName ?? x.source.name ?? x.source.slug ?? '' }) : t('ws.from.person'));
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

/** 할 일 한 줄 — 누르면 할 일 화면의 그 일 */
function TaskLine({ x, open, note = true, reason = false }) {
  return <button type="button" className="mod-row ws-task" onClick={() => open(x.id)}>
    <span className={`dot ${DOT[x.status] ?? 'off'}`} />
    <span className="ws-task-main">
      <span className="clamp">{x.title}</span>
      {reason && <small className="ws-reason clamp">{x.hold_reason || t('ws.noReason')}</small>}
      {reason && <small className="clamp">{[x.held_at && t('ws.heldAt', { d: isoDay(x.held_at) }), who(x), fromText(x)].filter(Boolean).join(' · ')}</small>}
      {note && !reason && x.noteLine && <small className="clamp">{x.noteLine}</small>}
    </span>
    {x.due_on && <span className={`badge${x.overdue ? ' danger' : ''}`}>{dayText(x.due_on)}</span>}
  </button>;
}

function Group({ label, list, open, show = SHOW, assignee = false }) {
  if (!list.length) return null;
  return <div className="ws-group">
    <h4>{label} <span>{list.length}</span></h4>
    {list.slice(0, show).map((x) => <TaskLine key={x.id} x={assignee ? { ...x, noteLine: [who(x), x.noteLine].filter(Boolean).join(' · ') } : x} open={open} />)}
    {list.length > show && <p className="ws-more">{t('ws.more', { n: list.length - show })}</p>}
  </div>;
}

function PersonCard({ p, open }) {
  const face = p.places.local[0]?.id ?? p.places.bot[0]?.id;
  const owner = ownerOf(p);
  return <section className="module ws-person" aria-label={label(p)}>
    <div className="module-head">
      <span className="ws-head-main">
        {face ? <Face id={face} size={22} dim={!p.online} /> : <Icon name="person" size={16} className="dim" />}
        <h3>{p.name}</h3>
        {owner && <span className="ws-owner dim small">{owner}</span>}
        <span className={`dot ${p.online ? 'ok' : 'off'}`} role="img" aria-label={t(p.online ? 'ws.online' : 'ws.offline')} title={t(p.online ? 'ws.online' : 'ws.offline')} />
      </span>
    </div>
    {PLACES.some((k) => p.places[k].length) && <div className="ws-places">{PLACES.filter((k) => p.places[k].length).map((k) => <span key={k} className="badge">{t(`ws.place.${k}`)}{p.places[k].length > 1 ? ` ${p.places[k].length}` : ''}</span>)}</div>}
    {p.now.length > 0 && <div className="ws-now">{p.now.map((x, i) => <p key={`${x.kind}:${x.id ?? x.crewId ?? i}`}>
      <b>{t(x.kind === 'run' && x.status === 'blocked' ? 'ws.now.blocked' : `ws.now.${x.kind}`)}</b>
      {x.kind === 'session' ? <button type="button" className="link-btn small" onClick={() => open(x.id)}>{x.text}</button> : x.kind === 'exec' ? t(`ws.place.${x.place}`) : x.text}
    </p>)}</div>}
    <Group label={t('ws.doing')} list={p.doing} open={open} />
    <Group label={t('ws.hold')} list={p.held} open={open} />
    <Group label={t('ws.todo')} list={p.todo} open={open} />
    <div className="ws-foot">
      {p.overdue > 0 && <span className="badge danger">{t('ws.overdueN', { n: p.overdue })}</span>}
      {p.nextDue && <span>{t('ws.nextDue', { d: dayText(p.nextDue) })}</span>}
      <span className="grow" />
      <span>{p.online ? t('ws.online') : p.lastSeen ? t('ws.lastSeen', { t: ago(new Date(p.lastSeen).toISOString()) }) : ''}</span>
    </div>
  </section>;
}

export default function WorkStatus({ space }) {
  useLang();
  const { data, error, busy, retry } = useWorkStatus(space);
  const view = useMemo(() => (data ? buildStatus(data, { me: ME.id }) : null), [data]);
  const head = (sub, right) => <div className="page-title-row"><div><h1 className="page-h1">{t('nav.status')}</h1>{sub && <p className="dim">{sub}</p>}</div>{right}</div>;
  if (space === 'me') return <div className="page-wrap wide ws">{head(null)}<div className="empty-state"><Icon name="layout" size={20} /><p>{t('ws.orgOnly')}</p></div></div>;
  const open = (id) => navigate(`${baseOf(space)}/tasks?open=${encodeURIComponent(id)}`);
  const refresh = <button type="button" className="btn sm" onClick={retry} disabled={busy}><Icon name="refresh" size={13} />{t(busy ? 'ws.loading' : 'ws.refresh')}</button>;

  if (!view) return <div className="page-wrap wide ws">{head(t('ws.sub'))}
    {error ? <LoadFail text={t(statusError(error))} onRetry={retry} /> : <div className="skeleton-lines" aria-busy="true"><span /><span /><span /></div>}</div>;

  const { summary: s, held, people, idle, hidden, unowned } = view;
  const unownedN = unowned.doing.length + unowned.held.length + unowned.todo.length;
  const empty = !people.length && !idle.length && !held.length && !unownedN;
  return <div className="page-wrap wide ws">
    {head(t(data.admin ? 'ws.sub' : 'ws.subMember'), refresh)}
    {error && <LoadFail small text={t(statusError(error))} onRetry={retry} />}
    <div className="ws-sum" role="status">
      <span className="badge">{t('ws.sum.doing', { n: s.doing })}</span>
      <span className={`badge${s.hold ? ' warn' : ''}`}>{t('ws.sum.hold', { n: s.hold })}</span>
      <span className={`badge${s.overdue ? ' danger' : ''}`}>{t('ws.sum.overdue', { n: s.overdue })}</span>
      <span className={`badge${s.online ? ' ok' : ''}`}>{t('ws.sum.online', { n: s.online, m: s.people })}</span>
    </div>
    {empty ? <div className="empty-state"><Icon name="layout" size={20} /><p>{t('ws.empty')}</p></div> : <>
      {held.length > 0 && <section className="module" aria-label={t('ws.held')}>
        <div className="module-head"><h3>{t('ws.held')} <span className="module-sub">{held.length}</span></h3></div>
        <div className="module-body">{held.map((x) => <TaskLine key={x.id} x={x} open={open} reason />)}</div>
      </section>}
      {people.length > 0 && <div className="ws-grid">{people.map((p) => <PersonCard key={p.key} p={p} open={open} />)}</div>}
      {(idle.length > 0 || hidden > 0) && <p className="ws-idle">
        {idle.length > 0 && <><b>{t('ws.idle')}</b> {idle.map(label).join(' · ')}</>}
        {idle.length > 0 && hidden > 0 && ' · '}{hidden > 0 && t('ws.hiddenN', { n: hidden })}
      </p>}
      {unownedN > 0 && <section className="module" aria-label={t('ws.unowned')}>
        <div className="module-head"><h3>{t('ws.unowned')} <span className="module-sub">{unownedN}</span></h3></div>
        <div className="module-body">
          <Group label={t('ws.doing')} list={unowned.doing} open={open} show={10} assignee />
          <Group label={t('ws.hold')} list={unowned.held} open={open} show={10} assignee />
          <Group label={t('ws.todo')} list={unowned.todo} open={open} show={10} assignee />
        </div>
      </section>}
    </>}
  </div>;
}
