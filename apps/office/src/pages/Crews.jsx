// 에이전트 조직도와 에이전트 상세(17차 A-1·2·3·4, PARITY-agents O1·D1·D8·S5). 둘 다 지연 청크 — 첫 화면에는 여는 단추(좌측 크루·즐겨찾기·크루 메뉴)만 있다.
// 기록판 데이터(board.js mapBoard)와 할 일 상태만 읽는다. 고치기는 메신저에서(오피스는 기록을 읽어 보여 주는 앱), 실행(맡기기)은 기존 맡기기 창 그대로.
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { Sheet } from '../ui/Panel.jsx';
import { menuProps } from '../ui/Menu.jsx';
import { t, ago, useLang, registerDict } from '../core/i18n.js';
import { useStore } from '../core/store.js';
import { useUi, setUi } from '../core/ui-state.js';
import { ME, SPACES, getMode, nameIn } from '../core/session.js';
import { baseOf, crewMenu } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { isMine, crewsIn } from '../core/crew-list.js';
import { groupByDept, crewWork, crewRecords, crewAccess, replyLines, detailIds } from '../core/crew-model.js';
import { getClient } from '../core/supabase.js';
import { useTasks } from '../core/tasks.js';
import { fmtBytes } from '../core/files.js';
import { CREWS_DICT } from './crews-i18n.js';
import { CREW_ASSIGN_DICT } from '../core/crew-assign-i18n.js';
import { openExternal } from '../core/platform.js';
import { FAMILY } from '../core/family.js';
import { LoadFail } from '../ui/LoadFail.jsx';
import { pullBoard } from '../core/pull.js';
import './crews.css';

registerDict(CREWS_DICT); registerDict(CREW_ASSIGN_DICT); // 메신저 앱 받기·꺼짐 안내는 맡기기 창과 같은 문구

const STATUS_BADGE = { work: 'ok', ask: 'warn' };
const EMPTY = [];
/** 직무 — 예시 데이터는 role 하나뿐(좌측 목록과 같은 규칙) */
const jobOf = (c) => c.job || (c.dept ? '' : c.role);
const ownerOf = (c, space) => (c.company ? t('crew.owner.company') : isMine(c, ME.id) ? nameIn(space) : c.ownerName || t('crew.owner.unknown')); // 내 이름은 보고 있는 공간에서 보이는 이름(CX-07)
// 기록판을 못 읽는 동안 접속은 '확인 못 함' — 지난번 받은 '대기 중'·'꺼져 있음'을 그대로 보이지 않는다(2차 검수 L8)
const Status = ({ c }) => { const st = useStore((s) => (s.boardError ? 'rest' : c.status)); return <span className={`badge ${STATUS_BADGE[st] ?? ''}`}>{t(`crew.status.${st}`)}</span>; };
const openCrew = (c, space) => setUi({ crew: { id: c.id, space } });

/** 에이전트 조직도(O1) — 이 공간의 에이전트를 부서별 카드로. 조직 공간은 조직 전체(남의 크루·회사 크루 포함), 내 공간은 내 에이전트만(crewsIn과 같은 규칙) */
export default function CrewOrg({ space }) {
  useLang();
  const all = useStore((s) => s.crews);
  const crews = useMemo(() => crewsIn(all, space, ME.id), [all, space]);
  const failed = useStore((s) => !!s.boardError); // 못 읽었으면 '에이전트 없음'이 아니라 다시 시도(OFC-08)
  const groups = useMemo(() => groupByDept(crews), [crews]);
  const depts = groups.filter((g) => g.dept).length;
  return <div className="page-wrap wide">
    <div className="page-title-row"><div><h1 className="page-h1">{t('nav.agents')}</h1>
      <p className="dim">{[t(space === 'me' ? 'agents.meSub' : 'agents.sub'), crews.length > 0 && t('agents.count', { n: crews.length, d: depts })].filter(Boolean).join(' · ')}</p></div></div>
    {failed && crews.length > 0 && <LoadFail small onRetry={() => pullBoard().catch(() => {})} />}{/* 지난번 받은 목록 위에 다시 시도 */}
    {!crews.length && failed ? <LoadFail onRetry={() => pullBoard().catch(() => {})} />
      : !crews.length ? <div className="empty-state"><Icon name="hand" size={20} /><p>{t('agents.empty')}</p>{/* 다음에 할 일 = 실행기(Argo 앱) 받기 — 에이전트는 메신저가 아니라 실행기가 올린다(패밀리 원칙 6, CX-01·OFC-18) */}
      <button type="button" className="btn sm" onClick={() => openExternal(FAMILY.download)}><Icon name="download" size={13} />{t('crew.getApp')}</button></div>
      : groups.map((g) => <section key={g.dept || '-'} className="agents-dept" aria-label={g.dept || t('agents.noDept')}>
        <h2 className="agents-h">{g.dept || t('agents.noDept')} <span className="dim">· {g.crews.length}</span></h2>
        <div className="agents-grid">{g.crews.map((c) => <AgentCard key={c.id} crew={c} space={space} />)}</div>
      </section>)}
  </div>;
}

/** 카드 — 누르면 오른쪽 상세, 우클릭(터치는 길게 누르기)은 좌측 목록과 같은 크루 메뉴 */
/** 내 공간에서 한 줄로 묶인 에이전트가 들어 있는 조직 이름(CX-05) — 조직이 둘 이상일 때만 */
const whereOf = (c) => (SPACES.filter((x) => x.kind === 'org').length > 1 ? (c.spaces ?? []).map((k) => SPACES.find((x) => x.key === k)?.name).filter(Boolean).join(', ') : '');
function AgentCard({ crew: c, space }) {
  const job = jobOf(c), where = whereOf(c);
  return <button type="button" className="agent-card" onClick={() => openCrew(c, space)} {...menuProps(() => crewMenu(c, space))}>
    <Face id={c.id} size={36} />
    <span className="agent-main"><b>{c.name}</b>{job && <small>{job}</small>}<small>{t('crew.tip.owner', { name: ownerOf(c, space) })}</small>{where && <small>{where}</small>}</span>
    <Status c={c} />
  </button>;
}

/** 에이전트 상세(D1) — 오른쪽 패널. 주소가 아니라 화면 상태(ui.crew = { id, space })로 연다 — 어느 화면 위에서든 열리고, 닫으면 보던 화면 그대로 */
export function CrewSheet() {
  useLang();
  const { crew: open } = useUi();
  const c = useStore((s) => s.crews.find((x) => x.id === open?.id));
  if (!open) return null;
  const close = () => setUi({ crew: null });
  return <Sheet open onClose={close} title={c?.name ?? t('crewd.title')}>
    {c ? <CrewBody crew={c} space={open.space} close={close} /> : <p className="dim">{t('crewd.gone')}</p>}
  </Sheet>;
}

/** 이 크루가 만든 할 일을 찾을 할 일 목록 — 로그인은 크루가 사는 조직의 할 일(이미 있는 읽기 office_task_list, 30초 안에 받은 것은 다시 받지 않는다),
 *  예시 모드는 예시 할 일(그때만 받는다) */
function useCrewTasks(c) {
  const live = useTasks(c.space).rows;
  const [sample, setSample] = useState(null);
  useEffect(() => { if (getMode() === 'sample') import('../data/calendar-sample.js').then((m) => setSample(m.SAMPLE_TASKS)).catch(() => {}); }, []);
  return sample ?? live ?? EMPTY;
}

const Fact = ({ k, children }) => (children ? <div className="fact"><span className="dim">{t(k)}</span><span>{children}</span></div> : null);
const None = ({ k }) => <p className="dim small crewd-none">{t(k)}</p>;
function Sec({ title, n, more, children }) {
  return <section className="crewd-sec"><h3 className="crewd-h">{title}{n > 0 && <span className="dim">{n}</span>}{more}</h3>{children}</section>;
}
const SHOW = 5; // 칸마다 먼저 보이는 건수 — 나머지는 '모두 보기'(그 화면의 이 에이전트 폴더)

/** 맡긴 일의 최근 답 — 오피스 안에서 답을 볼 곳(10/5 연결성). 내 에이전트의 개인 1:1(메신저 에이전트 탭과 같은 방, 오피스 맡기기도 여기로 보낸다)에서
 *  최근 글 5개를 상세를 열 때 한 번 읽는다. 부하: 상세를 열 때만 읽기 2(방 찾기 1 + 글 1), 쓰기 0 — 방이 없으면 만들지 않는다. 주기 읽기 없음.
 *  개인 행이 없는 에이전트(옛 본체·남의 에이전트)는 칸을 그리지 않는다(조직 1:1은 메신저에서) */
function useRecentReplies(c, enabled) {
  const crews = useStore((s) => s.crews);
  const row = useMemo(() => (enabled ? crews.find((x) => x.personal && (x.id === c.id || (c.agent != null && x.agent === c.agent))) ?? null : null), [crews, c.id, c.agent, enabled]);
  const twin = row?.id ?? null, bot = row?.hosting === 'bot'; // 봇 쌍둥이는 준비됐을 때만 개인 1:1로 맡긴다(crew-assign.js) — 안내는 개인 공간이라고 단정하지 않는다
  const [rows, setRows] = useState(undefined), [again, setAgain] = useState(0);
  useEffect(() => {
    if (!twin || getMode() !== 'signedIn') return undefined;
    let live = true; setRows(undefined);
    (async () => {
      const sb = await getClient();
      const ch = await sb.from('msgr_channels').select('id').eq('personal_pair', `crew:${twin}`).maybeSingle();
      if (ch.error) throw ch.error;
      if (!ch.data) return [];
      const m = await sb.from('msgr_messages').select('id, author_kind, body, created_at').eq('channel_id', ch.data.id).is('deleted_at', null).order('id', { ascending: false }).limit(SHOW);
      if (m.error) throw m.error;
      return m.data ?? [];
    })().then((r) => { if (live) setRows(replyLines(r)); }, () => { if (live) setRows('fail'); });
    return () => { live = false; };
  }, [twin, again]);
  return { twin, bot, rows, retry: () => setAgain((n) => n + 1) };
}

function CrewBody({ crew: c, space, close }) {
  const work = useStore((s) => s.work), approvals = useStore((s) => s.approvals), decisions = useStore((s) => s.decisions);
  const outputs = useStore((s) => s.outputs), journal = useStore((s) => s.journal);
  const tasks = useCrewTasks(c);
  // 내 공간에서는 같은 에이전트의 행(조직마다·개인 공간) 기록을 한곳에 — 개인 방 산출물·다른 조직의 결재도 보인다. 조직 공간은 그 조직 행만
  const rowsAll = useStore((s) => s.crews);
  const ids = useMemo(() => detailIds(c, rowsAll, space, ME.id), [rowsAll, c, space]);
  const mine = useMemo(() => crewWork(ids, { work, tasks }), [ids, work, tasks]);
  const rec = useMemo(() => crewRecords(ids, { approvals, decisions, outputs, journal }, SHOW), [ids, approvals, decisions, outputs, journal]);
  const access = crewAccess(c, ME.id, getMode());
  const replies = useRecentReplies(c, access === 'direct');
  const home = c.space ?? space; // 크루가 사는 조직(예시 크루는 공간이 없어 지금 공간)
  const go = (path) => { close(); navigate(path); };
  const all = (view) => <button type="button" className="link-btn" onClick={() => go(`${baseOf(home)}/${view}?folder=${encodeURIComponent(c.id)}`)}>{t('crewd.more')}</button>;
  const at = (x) => baseOf(x.space ?? home);
  const taskAt = (x) => baseOf('org' in x ? x.org ?? 'me' : home); // 예시 할 일은 org(공간 키)를 갖고, 서버 할 일은 이 조직 것
  const job = jobOf(c);
  return <div className="crewd">
    <div className="ap-who"><Face id={c.id} size={40} /><div><b>{c.name}</b>{job && <small className="dim">{job}</small>}</div><Status c={c} /></div>
    <div className="crewd-act">
      {access === 'direct' ? <>
        <button type="button" className="btn primary" onClick={() => setUi({ crew: null, assign: { space: home, crew: c.id, items: [] } })}><Icon name="hand" size={14} />{t('crewd.assign')}</button>
        {c.on === false && <p className="dim small crewd-note"><Icon name="info" size={13} />{t('crew.offNote')}</p>}{/* 꺼진 에이전트(메신저와 같은 90초 기준, CX-06) */}
        {/* 메신저는 특정 대화를 여는 주소를 받지 않는다(로그인 콜백만) — 받는 곳(랜딩)으로 가는 단추를 둔다(CX-02) */}
        <p className="dim small crewd-note">{t(replies.twin && !replies.bot ? 'crewd.replyPersonal' : 'crewd.reply', { crew: c.name })} <button type="button" className="link-btn small" onClick={() => openExternal(FAMILY.messenger)}>{t('msgr.get')}</button></p>
      </> : <p className="dim small crewd-note"><Icon name="info" size={13} />{access === 'off' ? t('crewd.off') : t('crew.viaChannel', { crew: c.name })}</p>}
    </div>
    {replies.twin && getMode() === 'signedIn' && <Sec title={t('crewd.replies')}>
      {replies.rows === undefined ? <p className="dim small" role="status">{t('biz.loading')}</p>
        : replies.rows === 'fail' ? <LoadFail small onRetry={replies.retry} />
          : !replies.rows.length ? <None k="crewd.repliesNone" />
            : replies.rows.map((m) => <div key={m.id} className="rec-row crewd-reply"><Icon name={m.who === 'crew' ? 'hand' : 'person'} size={14} className="dim" /><span className="rec-text">{m.text}</span><small className="rec-when">{ago(m.at)}</small></div>)}
    </Sec>}
    <Sec title={t('crewd.info')}>
      <div className="crewd-facts">
        <Fact k="crewd.f.job">{job}</Fact><Fact k="crewd.f.dept">{c.dept}</Fact><Fact k="crewd.f.owner">{ownerOf(c, space)}</Fact>
        <Fact k="crewd.f.status"><Status c={c} /></Fact><Fact k="crewd.f.org">{c.space === 'me' ? t('space.me') : c.space && SPACES.find((s) => s.key === c.space)?.name}</Fact>
      </div>
      <p className="dim small crewd-none">{t('crewd.editIn')}</p>
    </Sec>
    <Sec title={t('crewd.work')} n={mine.runs.length + mine.tasks.length} more={mine.runs.length > 0 && all('work')}>
      {!mine.runs.length && !mine.tasks.length ? <None k="crewd.workNone" /> : <>
        {mine.runs.map((w) => <button key={w.id} type="button" className="rec-row" onClick={() => go(`${at(w)}/work?open=${w.id}`)}>
          <Icon name="run" size={14} className="dim" /><span className="rec-text">{w.goal}</span><span className={`badge ${w.status === 'blocked' ? 'warn' : 'ok'}`}>{t(`status.${w.status}`)}</span><small className="rec-when">{ago(w.started)}</small></button>)}
        {mine.tasks.length > 0 && <p className="crewd-sub">{t('crewd.tasks')}</p>}
        {mine.tasks.map((x) => <button key={x.id} type="button" className="rec-row" onClick={() => go(`${taskAt(x)}/tasks?open=${x.id}`)}>
          <Icon name="todo" size={14} className="dim" /><span className="rec-text">{x.title}</span>{x.due_on && <small className="rec-when">{t('crewd.due', { d: x.due_on })}</small>}</button>)}
      </>}
    </Sec>
    <Sec title={t('crewd.journal')} more={rec.journal.length > 0 && all('journal')}>
      {rec.journal.length ? rec.journal.map((e, i) => <button key={`${e.day}|${e.time}|${i}`} type="button" className="rec-row" onClick={() => go(`${at(e)}/journal?folder=${encodeURIComponent(c.id)}`)}>
        <span className="rec-text">{e.text}</span><small className="rec-when">{`${e.day.slice(5)} ${e.time}`}</small></button>) : <None k="crewd.journalNone" />}
    </Sec>
    <Sec title={t('crewd.approvals')} n={rec.approvals.length} more={rec.approvals.length > SHOW && all('approvals')}>
      {rec.approvals.length ? rec.approvals.slice(0, SHOW).map((a) => <button key={a.id} type="button" className="rec-row" onClick={() => go(`${at(a)}/approvals?open=${a.id}`)}>
        <Icon name="stamp" size={14} className="dim" /><span className="rec-text">{a.head || a.plain}</span>{a.risk === 'high' && <span className="badge warn">{t('risk.high')}</span>}<small className="rec-when">{ago(a.at)}</small></button>) : <None k="crewd.approvalsNone" />}
    </Sec>
    <Sec title={t('crewd.decisions')} more={rec.decisions.length > 0 && all('decisions')}>
      {rec.decisions.length ? rec.decisions.map((d) => <button key={d.id} type="button" className="rec-row" onClick={() => go(`${at(d)}/decisions?open=${d.id}`)}>
        <Icon name="check" size={14} className="dim" /><span className="rec-text">{d.plain}</span><span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span><small className="rec-when">{ago(d.at)}</small></button>) : <None k="crewd.decisionsNone" />}
    </Sec>
    <Sec title={t('crewd.outputs')} more={rec.outputs.length > 0 && all('outputs')}>
      {rec.outputs.length ? rec.outputs.map((f) => <button key={f.id} type="button" className="rec-row" onClick={() => go(`${at(f)}/outputs?open=${f.id}`)}>
        <Icon name="file" size={14} className="dim" /><span className="rec-text">{f.name}</span><small className="rec-when"><span className="mono">{fmtBytes(f.bytes)}</span> · {ago(f.at)}</small></button>) : <None k="crewd.outputsNone" />}
    </Sec>
  </div>;
}
