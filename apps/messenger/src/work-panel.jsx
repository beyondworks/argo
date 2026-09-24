import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DangerModal, Markdown } from '@argo/ui';
import { supabase } from './supabase.js';
import { I } from './icons.jsx';
import './work-panel.css';

// Poll only the visible tab: four list reads/minute, plus four small capability reads for team work. Hidden windows pause;
// errors back off to two minutes and old servers stop until focus/manual refresh.
const POLL_MS = 15_000;
const TERMINAL = new Set(['completed', 'cancelled']);
const stamp = (value, lang) => value ? new Date(value).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const checked = async (request) => { const { data, error } = await request; if (error) throw error; return data; };
export const missingSchema = (error) => /PGRST20[245]|42P01|42703|42883/.test(error?.code ?? '') || /schema cache|does not exist|Could not find the (table|function)/i.test(error?.message ?? '');
const errorText = (error, t) => {
  const message = error?.message ?? '';
  if (missingSchema(error)) return t('work.error.upgrade');
  if (/no_available_lead/i.test(message)) return t('work.error.offline');
  if (/no_eligible|invalid_crew|crew_not|lead_not/i.test(message)) return t('work.error.crew');
  if (/permission_revoked/i.test(message)) return t('automation.error.revoked');
  if (/denied|forbidden|permission|not_allowed|row.level security|not_member/i.test(message)) return t('work.error.denied');
  if (/bad_goal|bad_instruction|request_conflict/i.test(message)) return t('work.error.input');
  if (/timezone|schedule|invalid_time|weekdays|interval/i.test(message)) return t('work.error.schedule');
  return t('work.error.connection');
};

function useRows(table, channelId, enabled, capabilityIds = '') {
  const [state, setState] = useState({ rows: null, error: null, hasMore: false });
  const [page, setPage] = useState(0);
  const revision = useRef(0);
  const failures = useRef(0);
  const missing = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++revision.current;
    try {
      const fields = table === 'msgr_automations'
        ? 'id,channel_id,crew_id,created_by,title,prompt,schedule,enabled,next_run_at,last_run_at,last_status,notification_route_ids'
        : 'id,channel_id,created_by,goal,completion_criteria,lead_crew_id,root_message_id,status,result,created_at';
      const readPage = async (columns) => {
        let query = supabase.from(table).select(columns).eq('channel_id', channelId);
        if (table === 'msgr_automations') query = query.is('deleted_at', null);
        return checked(query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * 25, page * 25 + 25));
      };
      const read = async () => {
        try { return await readPage(fields); } catch (error) {
          // Keep existing schedules readable on older servers; notification edits still require the new RPC.
          if (table !== 'msgr_automations' || !missingSchema(error)) throw error;
          return readPage(fields.replace(',notification_route_ids', ''));
        }
      };
      const [rows, capabilities] = await Promise.all([
        read(),
        table === 'msgr_work_runs' && capabilityIds ? checked(supabase.from('msgr_crews').select('id,work_protocol').in('id', capabilityIds.split(','))) : [],
      ]);
      if (request === revision.current) { failures.current = 0; missing.current = false; setState({ rows: (rows ?? []).slice(0, 25), error: null, hasMore: (rows ?? []).length > 25, capabilities }); }
    } catch (error) { if (request === revision.current) {
      failures.current++; missing.current = missingSchema(error);
      setState((old) => ({ ...old, error }));
    } }
  }, [table, channelId, enabled, page, capabilityIds]);
  useEffect(() => {
    if (!enabled) return;
    let active = true; let timer;
    const poll = async () => { if (document.visibilityState !== 'hidden' && !missing.current) await refresh(); if (active) timer = setTimeout(poll, Math.min(120_000, POLL_MS * 2 ** Math.min(failures.current, 3))); };
    missing.current = false; poll();
    const wake = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { active = false; clearTimeout(timer); revision.current++; window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [refresh, enabled]);
  return { ...state, refresh, page, setPage };
}

/** 업무 > 자동화 1단계 — Argo PC 루틴 미러(msgr_crew_routines). 1:1 방은 그 에이전트의 루틴 전부, 채널은 결과가
    그 채널로 가는 루틴만(channel_id 일치). RLS가 이미 소유자 행만 보여주므로 여기서는 범위만 고른다. */
function useCrewRoutines(channel, crews, enabled) {
  const [state, setState] = useState({ rows: null, error: null });
  const revision = useRef(0);
  const isDm = channel.kind === 'dm';
  const dmCrewId = isDm ? (crews[0]?.id ?? null) : null;
  const scopeKey = isDm ? `dm:${dmCrewId ?? ''}` : `ch:${channel.id}`;
  const refresh = useCallback(async () => {
    if (!enabled || (isDm && !dmCrewId)) { setState({ rows: [], error: null }); return; }
    const request = ++revision.current;
    try {
      let query = supabase.from('msgr_crew_routines').select('id,crew_id,title,prompt,schedule,enabled,channel_id,updated_at').order('title', { ascending: true });
      query = isDm ? query.eq('crew_id', dmCrewId) : query.eq('channel_id', channel.id);
      const rows = await checked(query);
      const ids = (rows ?? []).map((r) => r.id);
      const edits = ids.length ? await checked(supabase.from('msgr_crew_routine_edits').select('routine_id,status,op,error,created_at').in('routine_id', ids).neq('status', 'applied').order('created_at', { ascending: false })) : [];
      if (request !== revision.current) return;
      const latest = new Map();
      for (const e of edits ?? []) if (!latest.has(e.routine_id)) latest.set(e.routine_id, e);
      setState({ rows: (rows ?? []).map((r) => ({ ...r, pendingEdit: latest.get(r.id) ?? null })), error: null });
    } catch (error) { if (request === revision.current) setState((old) => ({ ...old, error })); }
  }, [enabled, isDm, dmCrewId, channel.id]);
  useEffect(() => {
    if (!enabled) return;
    let active = true; let timer;
    const poll = async () => { if (document.visibilityState !== 'hidden') await refresh(); if (active) timer = setTimeout(poll, POLL_MS); };
    poll();
    return () => { active = false; clearTimeout(timer); revision.current++; };
  }, [refresh, enabled, scopeKey]);
  return { ...state, refresh };
}

function CrewSelect({ crews, value, onChange, automatic, t, disabled }) {
  return <label className="work-field"><span>{t(automatic ? 'work.lead' : 'automation.crew')}</span>
    <select className="msgr-select" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} required={!automatic}>
      <option value="">{t(automatic ? 'work.lead.auto' : 'automation.crew.pick')}</option>
      {crews.map((crew) => <option key={crew.id} value={crew.id}>{crew.display_name}{Date.now() - Date.parse(crew.last_seen_at ?? 0) > 90_000 ? ` · ${t('work.crew.offline')}` : ''}</option>)}
    </select>
  </label>;
}

function StateNotice({ rows, error, empty, refresh, t }) {
  if (error) return <div className="work-notice error" role="alert"><p>{errorText(error, t)}</p><button className="btn sm" onClick={refresh}>{t('work.retry')}</button></div>;
  if (rows === null) return <p className="work-note" role="status">{t('ui.loading')}</p>;
  if (!rows.length) return <p className="work-empty">{empty}</p>;
  return null;
}

/** Each panel reads the authenticated cloud directly; the phone never calls a desktop localhost. */
export function WorkPanel({ channel, uid, isAdmin, locked, crews, t, lang, onClose, sheet = false }) { // sheet: 데스크톱 — 채널 패널과 같은 시트(폭 380, 비킴 규칙 공유). 폰은 전체 화면 오버레이
  const [tab, setTab] = useState('team');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const dialog = useRef(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  // Channel scope is supplied by Shell. Assignment authorization remains on the server.
  const eligible = crews.filter((crew) => crew.status === 'active');
  const work = useRows('msgr_work_runs', channel.id, tab === 'team', eligible.map((crew) => crew.id).sort().join(','));
  const automations = useRows('msgr_automations', channel.id, tab === 'automations');
  const routines = useCrewRoutines(channel, eligible, tab === 'automations');
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);
  const act = async (operation, done) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const data = await operation();
      if (mounted.current) { done?.(data); await Promise.all([work.refresh(), automations.refresh(), routines.refresh()]); }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  };
  const keydown = (event) => {
    if (event.key === 'Escape' && !deleting) { event.preventDefault(); event.stopPropagation(); if (!actionLock.current) closeRef.current(); }
    if (event.key !== 'Tab' || (sheet && !deleting)) return; // 시트는 채널 패널처럼 초점을 가두지 않는다(비모달)
    const scope = deleting ? document.querySelector('.msgr-work-overlay .msgr-action-dialog') : dialog.current;
    const buttons = [...scope.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((item) => item.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const body = (<>
      <header className="work-header"><div><h2>{t('work.title')}</h2><p>{channel.name}</p></div><button className="btn sm" disabled={busy} onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
      <div className="work-tabs" role="tablist" aria-label={t('work.title')}>{['team', 'automations'].map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} aria-controls={`work-view-${key}`} id={`work-tab-${key}`} tabIndex={tab === key ? 0 : -1} disabled={busy} onClick={() => { setTab(key); setError(null); setNotice(''); }} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'team' : event.key === 'End' ? 'automations' : key === 'team' ? 'automations' : 'team'; setTab(next); event.currentTarget.parentElement.querySelector(`#work-tab-${next}`)?.focus(); } }}>{t(`work.tab.${key}`)}</button>)}</div>
      <div className="work-scroll" role="tabpanel" id={`work-view-${tab}`} aria-labelledby={`work-tab-${tab}`}>
        {locked && <p className="work-notice" role="status">{t('org.locked.short')}</p>}
        {error && <p className="work-notice error" role="alert">{errorText(error, t)}</p>}
        {notice && <p className="work-notice" role="status">{notice}</p>}
        {tab === 'team' ? <TeamWork key="team" work={work} channel={channel} crews={eligible.filter((crew) => crew.hosting === 'bot' || (work.capabilities ?? []).some((row) => row.id === crew.id && row.work_protocol >= 1))} uid={uid} isAdmin={isAdmin} disabled={busy || locked} busy={busy} act={act} t={t} lang={lang} />
          : <Automations key="automations" source={automations} routines={routines} channel={channel} crews={eligible} uid={uid} disabled={busy || locked} busy={busy} act={act} t={t} lang={lang} setDeleting={setDeleting} setNotice={setNotice} />}
      </div>
  </>);
  const confirm = deleting && <div className="msgr-action-dialog" role="dialog" aria-modal="true" aria-label={t('automation.delete')}><DangerModal title={t('automation.delete')} description={<>{t('automation.delete.note')}{error && <span className="work-notice error" role="alert">{errorText(error, t)}</span>}</>} requireText={deleting.title} confirmLabel={t('automation.delete')} busy={busy} onClose={() => { if (!busy) { setDeleting(null); setError(null); } }} onConfirm={() => act(() => checked(deleting.kind === 'routine' ? supabase.rpc('msgr_crew_routine_edit', { p_routine: deleting.id, p_op: 'delete' }) : supabase.rpc('msgr_automation_delete', { automation: deleting.id })), () => { setDeleting(null); setNotice(t(deleting.kind === 'routine' ? 'routine.delete.requested' : 'automation.deleted')); })} /></div>;
  if (sheet) return (<div className="msgr-sheetwrap">
    <div className="msgr-scrim clear" onClick={() => { if (!busy && !deleting) onClose(); }} />
    <aside className="msgr-crewsheet msgr-worksheet" ref={dialog} role="dialog" aria-label={t('work.title')} onKeyDown={keydown} inert={deleting ? true : undefined}>
{body}
    </aside>
    {deleting && createPortal(<div className="shell msgr-work-overlay msgr-work-confirm" onKeyDown={keydown}>{confirm}</div>, document.body)}
  </div>);
  return createPortal(<div className="shell msgr-work-overlay" onKeyDown={keydown} onClick={(event) => { if (event.target === event.currentTarget && !busy && !deleting) onClose(); }}>
    <section className="msgr-work-panel" ref={dialog} role="dialog" aria-modal="true" aria-label={t('work.title')} inert={deleting ? true : undefined}>
{body}
    </section>
    {deleting && confirm}
  </div>, document.body);
}

function TeamWork({ work, channel, crews, uid, isAdmin, disabled, busy, act, t, lang }) {
  const [goal, setGoal] = useState('');
  const [completion, setCompletion] = useState('');
  const [lead, setLead] = useState('');
  const [thread, setThread] = useState(null);
  const request = useRef(null);
  const edit = (setter) => (value) => { setter(value); request.current = null; };
  const create = (event) => {
    event.preventDefault();
    if (!goal.trim() || disabled || !crews.length || work.error) return;
    request.current ??= crypto.randomUUID();
    act(() => checked(supabase.rpc('msgr_work_create', { p_channel: channel.id, p_request: request.current, p_goal: goal.trim(), p_completion: completion.trim(), p_lead: lead || null })), (row) => {
      setGoal(''); setCompletion(''); request.current = null; work.setPage(0); setThread({ root: row.root_message_id, workId: row.id, label: row.goal });
    });
  };
  return <>
    <p className="work-note">{t('work.intro')}</p>
    {work.rows !== null && !crews.length && <p className="work-notice">{t('work.noSupportedCrew')}</p>}
    <form className="work-form" onSubmit={create}>
      <label className="work-field"><span>{t('work.goal')}</span><textarea value={goal} onChange={(event) => edit(setGoal)(event.target.value)} placeholder={t('work.goal.placeholder')} required maxLength={6000} rows={3} disabled={disabled} /></label>
      <label className="work-field"><span>{t('work.completion')}</span><textarea value={completion} onChange={(event) => edit(setCompletion)(event.target.value)} placeholder={t('work.completion.placeholder')} maxLength={2000} rows={2} disabled={disabled} /></label>
      <CrewSelect crews={crews} value={lead} onChange={edit(setLead)} automatic t={t} disabled={disabled} />
      {lead && <p className="work-note">{t('work.lead.manual.note')}</p>}
      <button className="btn btn-primary" disabled={disabled || !goal.trim() || !crews.length || !!work.error || work.rows === null}>{busy ? t('work.saving') : t('work.start')}</button>
    </form>
    {thread && <Discussion channelId={channel.id} thread={thread} crews={crews} t={t} lang={lang} onClose={() => setThread(null)} />}
    <div className="work-section-heading"><h3>{t('work.recent')}</h3><button className="btn sm" onClick={work.refresh} disabled={busy}>{t('work.refresh')}</button></div>
    <StateNotice {...work} empty={t('work.empty')} t={t} />
    {(work.rows ?? []).map((run) => <article className="work-item" key={run.id}>
      <div className="work-item-top"><strong>{run.goal}</strong><span className={`work-status ${run.status}`}>{t(`work.status.${run.status}`)}</span></div>
      <p className="work-note">{crews.find((crew) => crew.id === run.lead_crew_id)?.display_name ?? t('work.crew.unavailable')} · {stamp(run.created_at, lang)}</p>
      {run.completion_criteria && <p className="work-text"><b>{t('work.completion')}: </b>{run.completion_criteria}</p>}
      {run.result !== null && run.result !== undefined ? <div className="work-result"><Markdown text={run.result} /></div> : run.status === 'blocked' && <div className="work-result">{t('work.result.stalled')}</div>}
      <div className="work-actions"><button className="btn sm" disabled={!run.root_message_id} onClick={() => setThread({ root: run.root_message_id, workId: run.id, label: run.goal })}>{t('work.discussion')}</button>
        {!TERMINAL.has(run.status) && (run.created_by === uid || isAdmin) && <button className="btn sm" disabled={disabled} onClick={() => act(() => checked(supabase.rpc('msgr_work_cancel', { p_run: run.id })))}>{t('work.cancel')}</button>}</div>
      {run.status === 'blocked' && (run.created_by === uid || isAdmin) && <ResumeWork run={run} disabled={disabled} act={act} t={t} />}
      {!TERMINAL.has(run.status) && <p className="work-note">{t('work.cancel.note')}</p>}
    </article>)}
    <Pages source={work} disabled={busy} t={t} />
  </>;
}

function Automations({ source, routines, channel, crews, uid, disabled, busy, act, t, lang, setDeleting, setNotice }) {
  const [editing, setEditing] = useState(null);
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [history, setHistory] = useState(null);
  const runRequests = useRef(new Map());
  const bothLoaded = source.rows !== null && routines.rows !== null;
  const empty = bothLoaded && !source.rows.length && !(routines.rows ?? []).length;
  return <>
    <p className="work-note">{t('automation.intro')}</p>
    {source.rows !== null && !source.error && <SchedulerStatus t={t} />}
    <div className="work-section-heading"><h3>{t('work.tab.automations')}</h3><div className="work-actions"><button className="btn sm" onClick={() => { source.refresh(); routines.refresh(); }} disabled={busy}>{t('work.refresh')}</button><button className="btn btn-primary sm" disabled={disabled || !crews.length || !!source.error || source.rows === null} onClick={() => setEditing({})}>{t('automation.new')}</button></div></div>
    {!crews.length && <p className="work-notice">{t('work.noCrew')}</p>}
    {editing && <AutomationForm key={editing.id ?? 'new'} value={editing} crews={crews} channel={channel} t={t} disabled={disabled} act={act} onClose={() => setEditing(null)} onSaved={() => { if (!editing.id) source.setPage(0); setEditing(null); setNotice(t('automation.saved')); }} />}
    {editingRoutine && <RoutineForm key={editingRoutine.id} value={editingRoutine} t={t} disabled={disabled} act={act} onClose={() => setEditingRoutine(null)} onSaved={() => { setEditingRoutine(null); setNotice(t('automation.saved')); }} />}
    {source.error && <div className="work-notice error" role="alert"><p>{errorText(source.error, t)}</p><button className="btn sm" onClick={source.refresh}>{t('work.retry')}</button></div>}
    {source.rows === null && <p className="work-note" role="status">{t('ui.loading')}</p>}
    {empty && <p className="work-empty">{t('automation.empty')}</p>}
    {(source.rows ?? []).map((automation) => <article className="work-item" key={automation.id}>
      <div className="work-item-top"><span className="work-item-title"><strong>{automation.title}</strong><span className="work-source-badge">{t('automation.source.msgr')}</span></span><span className={`work-status ${automation.enabled ? 'running' : 'cancelled'}`}>{t(automation.enabled ? 'automation.enabled' : 'automation.paused')}</span></div>
      <p className="work-text">{automation.prompt}</p>
      <p className="work-note">{crews.find((crew) => crew.id === automation.crew_id)?.display_name ?? t('work.crew.unavailable')} · <Schedule schedule={automation.schedule} t={t} /></p>
      <p className="work-note">{t('automation.next')}: {automation.enabled ? stamp(automation.next_run_at, lang) : '—'} · {t('automation.last')}: {stamp(automation.last_run_at, lang)}</p>
      {automation.enabled && ['queued', 'running'].includes(automation.last_status) && <p className="work-note">{t('automation.running.note')}</p>}
      <div className="work-actions"><button className="btn sm" onClick={() => setHistory(history === automation.id ? null : automation.id)} aria-expanded={history === automation.id}>{t('automation.history')}</button>
        {automation.created_by === uid && <><button className="btn sm" disabled={disabled} onClick={() => setEditing(automation)}>{t('automation.edit')}</button><button className="btn sm" disabled={disabled} onClick={() => act(() => checked(supabase.rpc('msgr_automation_set_enabled', { automation: automation.id, enabled: !automation.enabled })))}>{t(automation.enabled ? 'automation.pause' : 'automation.resume')}</button><button className="btn sm" disabled={disabled} onClick={() => { if (!runRequests.current.has(automation.id)) runRequests.current.set(automation.id, crypto.randomUUID()); act(() => checked(supabase.rpc('msgr_automation_run_now', { automation: automation.id, request_id: runRequests.current.get(automation.id) })), () => { runRequests.current.delete(automation.id); setHistory(automation.id); setNotice(t('automation.run.requested')); }); }}>{t('automation.run')}</button><button className="btn sm work-danger" disabled={disabled} onClick={() => setDeleting(automation)}>{t('automation.delete')}</button></>}
      </div>
      {history === automation.id && <RunHistory automationId={automation.id} own={automation.created_by === uid} channelId={channel.id} crews={crews} t={t} lang={lang} />}
    </article>)}
    {routines.error && <div className="work-notice error" role="alert"><p>{missingSchema(routines.error) ? t('automation.notifications.upgrade') : errorText(routines.error, t)}</p><button className="btn sm" onClick={routines.refresh}>{t('work.retry')}</button></div>}
    {(routines.rows ?? []).map((routine) => <article className="work-item" key={routine.id}>
      <div className="work-item-top"><span className="work-item-title"><strong>{routine.title}</strong><span className="work-source-badge">{t('automation.source.argo')}</span></span><span className={`work-status ${routine.enabled ? 'running' : 'cancelled'}`}>{t(routine.enabled ? 'automation.enabled' : 'automation.paused')}</span></div>
      <p className="work-text">{routine.prompt}</p>
      <p className="work-note">{crews.find((crew) => crew.id === routine.crew_id)?.display_name ?? t('work.crew.unavailable')} · <RoutineSchedule schedule={routine.schedule} t={t} /></p>
      {routine.pendingEdit?.status === 'pending' && <p className="work-notice">{t('routine.pending')}</p>}
      {/* replaced = 메신저 쪽 자동 폴드(더 새 메신저 편집이 이걸 흡수, H3) — superseded = PC가 "로컬이 이 편집보다 나중"으로 판단해 버림(H1/H4). 원인이 다르므로 문구도 다르다(M3). */}
      {routine.pendingEdit?.status === 'replaced' && <p className="work-notice">{t('routine.replaced')}</p>}
      {routine.pendingEdit?.status === 'superseded' && <p className="work-notice">{t('routine.superseded')}</p>}
      {routine.pendingEdit?.status === 'failed' && <p className="work-notice error" role="alert">{t('routine.failed')}{routine.pendingEdit.error ? ` — ${routine.pendingEdit.error}` : ''}</p>}
      <div className="work-actions">
        {/* H3: 편집 폼의 초기값은 아직 반영 전인 대기 patch를 덮어써서 보여준다 — 소유자가 두 번째 수정을 시작할 때 낡은(적용 전) 값에서 출발하지 않게 */}
        <button className="btn sm" disabled={disabled} onClick={() => setEditingRoutine(routine.pendingEdit?.status === 'pending' && routine.pendingEdit.op === 'update' ? { ...routine, ...routine.pendingEdit.patch } : routine)}>{t('automation.edit')}</button>
        <button className="btn sm" disabled={disabled} onClick={() => act(() => checked(supabase.rpc('msgr_crew_routine_edit', { p_routine: routine.id, p_op: 'update', p_patch: { enabled: !routine.enabled } })), () => routines.refresh())}>{t(routine.enabled ? 'automation.pause' : 'automation.resume')}</button>
        <button className="btn sm work-danger" disabled={disabled} onClick={() => setDeleting({ ...routine, kind: 'routine' })}>{t('automation.delete')}</button>
      </div>
    </article>)}
    <Pages source={source} disabled={busy} t={t} />
  </>;
}

function Schedule({ schedule = {}, t }) {
  return <>{schedule.kind === 'interval' ? t('automation.every', { n: schedule.minutes }) : <>{t(`automation.kind.${schedule.kind}`)} {schedule.kind === 'weekly' ? (schedule.weekdays ?? []).map((day) => t(`automation.day.${day}`)).join(' · ') : ''} {schedule.time}</>} · {schedule.timezone}</>;
}

/** Argo 루틴 스케줄 표시 — 필드명이 자동화(kind/weekdays)와 다르다(type/dows, 0=일~6=토). times[]가 여럿이면 전부 보여준다. */
function RoutineSchedule({ schedule = {}, t }) {
  if (schedule.type === 'interval') return <>{t('automation.every', { n: schedule.everyMinutes })}</>;
  if (schedule.type === 'once') return <>{t('routine.kind.once')} {schedule.date} {schedule.time}</>;
  // L1: 옛 형식(dow 단수만 있고 dows 배열이 없는 아주 오래된 루틴)도 요일 하나로 보여준다.
  const dows = schedule.dows ?? (schedule.dow != null ? [schedule.dow] : []);
  return <>{t(`routine.kind.${schedule.type === 'weekly' ? 'weekly' : 'daily'}`)} {schedule.type === 'weekly' ? dows.map((day) => t(`routine.day.${day}`)).join(' · ') : ''} {(schedule.times ?? [schedule.time]).filter(Boolean).join(', ')} · {schedule.tz ?? ''}</>;
}

function AutomationForm({ value, crews, channel, t, disabled, act, onClose, onSaved }) {
  const [title, setTitle] = useState(value.title ?? '');
  const [prompt, setPrompt] = useState(value.prompt ?? '');
  const [crew, setCrew] = useState(value.crew_id ?? '');
  const [kind, setKind] = useState(value.schedule?.kind ?? 'daily');
  const [timezone, setTimezone] = useState(value.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [time, setTime] = useState(value.schedule?.time ?? '09:00');
  const [minutes, setMinutes] = useState(value.schedule?.minutes ?? 60);
  const [weekdays, setWeekdays] = useState(value.schedule?.weekdays ?? [1, 2, 3, 4, 5]);
  const [invalid, setInvalid] = useState(false);
  const [routeIds, setRouteIds] = useState(value.notification_route_ids ?? []);
  const [routes, setRoutes] = useState(null);
  const [routesError, setRoutesError] = useState(null);
  const [routeRevision, setRouteRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setRoutes(null); setRoutesError(null);
    checked(supabase.rpc('msgr_notification_routes_list')).then((rows) => { if (active) setRoutes(rows ?? []); }, (error) => { if (active) setRoutesError(error); });
    return () => { active = false; };
  }, [routeRevision]);
  const form = useRef(null);
  const createRequest = useRef(null);
  useEffect(() => { form.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const save = (event) => {
    event.preventDefault();
    if (disabled || routes === null || routesError) return;
    let validZone = true; try { new Intl.DateTimeFormat('en', { timeZone: timezone.trim() }).format(); } catch { validZone = false; }
    if (!validZone || (kind === 'weekly' && !weekdays.length) || (kind === 'interval' && (!Number.isInteger(Number(minutes)) || Number(minutes) < 5 || Number(minutes) > 10080))) { setInvalid(true); return; }
    setInvalid(false);
    const schedule = { kind, timezone: timezone.trim(), ...(kind === 'interval' ? { minutes: Number(minutes) } : { time }), ...(kind === 'weekly' ? { weekdays } : {}) };
    const fingerprint = JSON.stringify([channel.id, crew, title.trim(), prompt.trim(), schedule, [...routeIds].sort()]);
    if (!createRequest.current || createRequest.current.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
    act(() => checked(supabase.rpc('msgr_automation_save_with_notifications', { automation: value.id ?? null, channel: channel.id, crew, title: title.trim(), prompt: prompt.trim(), schedule, request_id: value.id ? null : createRequest.current.id, notification_route_ids: [...routeIds].sort() })), onSaved);
  };
  return <form className="work-form work-editor" onSubmit={save} ref={form}>
    <h3>{t(value.id ? 'automation.edit' : 'automation.new')}</h3>
    <label className="work-field"><span>{t('automation.name')}</span><input value={title} required maxLength={120} onChange={(event) => setTitle(event.target.value)} disabled={disabled} /></label>
    <label className="work-field"><span>{t('automation.prompt')}</span><textarea value={prompt} required maxLength={18000} rows={3} onChange={(event) => setPrompt(event.target.value)} disabled={disabled} /></label>
    <CrewSelect crews={crews} value={crew} onChange={setCrew} t={t} disabled={disabled} />
    <div className="work-grid"><label className="work-field"><span>{t('automation.repeat')}</span><select value={kind} onChange={(event) => setKind(event.target.value)} disabled={disabled}>{['daily', 'weekly', 'interval'].map((key) => <option key={key} value={key}>{t(`automation.kind.${key}`)}</option>)}</select></label>
      {kind === 'interval' ? <label className="work-field"><span>{t('automation.minutes')}</span><input type="number" min="5" max="10080" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} required disabled={disabled} /></label> : <label className="work-field"><span>{t('automation.time')}</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required disabled={disabled} /></label>}</div>
    {kind === 'weekly' && <fieldset className="work-days"><legend>{t('automation.days')}</legend>{[1, 2, 3, 4, 5, 6, 7].map((day) => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} disabled={disabled} onChange={(event) => setWeekdays((current) => event.target.checked ? [...current, day].sort() : current.filter((value) => value !== day))} />{t(`automation.day.${day}`)}</label>)}</fieldset>}
    <label className="work-field"><span>{t('automation.timezone')}</span><input list="work-timezones" value={timezone} onChange={(event) => setTimezone(event.target.value)} required spellCheck={false} disabled={disabled} /><datalist id="work-timezones">{['Asia/Seoul', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'UTC'].map((zone) => <option key={zone}>{zone}</option>)}</datalist></label>
    <p className="work-note">{t('automation.timezone.note')}</p>
    <fieldset className="work-notification-routes"><legend>{t('automation.notifications.title')}</legend>
      <p className="work-note">{t('automation.notifications.note')}</p>
      <label className="work-notification-route"><input type="checkbox" checked disabled /><span><strong>{t('automation.notifications.messenger')}</strong><small>{channel.name}</small></span></label>
      {routesError ? <div className="work-notice error" role="alert"><p>{missingSchema(routesError) ? t('automation.notifications.upgrade') : errorText(routesError, t)}</p><button type="button" className="btn sm" disabled={disabled} onClick={() => setRouteRevision((old) => old + 1)}>{t('work.retry')}</button></div>
        : routes === null ? <p className="work-note" role="status">{t('ui.loading')}</p>
        : <>{routes.map((route) => <label className="work-notification-route" key={route.id}><input type="checkbox" checked={routeIds.includes(route.id)} disabled={disabled} onChange={(event) => setRouteIds((old) => event.target.checked ? [...old, route.id] : old.filter((id) => id !== route.id))} /><span><strong>{t(`automation.notifications.${route.kind}`)} · {route.label}</strong><small>{route.ws_id}{!route.ready ? ` · ${t('automation.notifications.offline')}` : ''}</small></span></label>)}
          {!routes.length && <p className="work-note">{t('automation.notifications.empty')}</p>}
          {routeIds.filter((id) => !routes.some((route) => route.id === id)).map((id) => <label className="work-notification-route" key={id}><input type="checkbox" checked disabled={disabled} onChange={() => setRouteIds((old) => old.filter((value) => value !== id))} /><span>{t('automation.notifications.unavailable')}</span></label>)}
        </>}
      <p className="work-note">{t('automation.notifications.device')}</p>
    </fieldset>
    {invalid && <p className="work-notice error" role="alert">{t('work.error.schedule')}</p>}
    <div className="work-actions"><button className="btn btn-primary" disabled={disabled || routes === null || !!routesError || !title.trim() || !prompt.trim() || !crew}>{t('ui.save')}</button><button type="button" className="btn" disabled={disabled} onClick={onClose}>{t('ui.cancel')}</button></div>
  </form>;
}

/** Argo 루틴 편집 — 메신저에서 건 수정은 즉시 반영되지 않고 msgr_crew_routine_edit로 '반영 대기'에 쌓인다(PC가 켜지면 drain이 가져가 적용).
    스케줄은 단일 시각의 daily/weekly/interval만 편집 가능 — 하루 여러 시각(times[]가 2개 이상)이거나 once(1회 예약)는 제목·지시만 편집하고
    스케줄은 읽기전용으로 둔다(첫 시각만 고쳐 나머지 시각을 지우는 사고를 원천 차단 — 유건 지시). */
function RoutineForm({ value, t, disabled, act, onClose, onSaved }) {
  const schedule = value.schedule ?? {};
  const editableSchedule = schedule.type === 'interval' || ((schedule.type ?? 'daily') !== 'once' && (schedule.times?.length ?? 1) <= 1);
  const [title, setTitle] = useState(value.title ?? '');
  const [prompt, setPrompt] = useState(value.prompt ?? '');
  const [type, setType] = useState(schedule.type === 'weekly' ? 'weekly' : schedule.type === 'interval' ? 'interval' : 'daily');
  const [time, setTime] = useState(schedule.time ?? '09:00');
  const [minutes, setMinutes] = useState(schedule.everyMinutes ?? 60);
  const [dows, setDows] = useState(schedule.dows ?? (schedule.dow != null ? [schedule.dow] : [1, 2, 3, 4, 5])); // L1: dow만 있는 옛 형식도 dows로 해석
  const [invalid, setInvalid] = useState(false);
  const originalSchedule = useRef(schedule.type === 'interval' ? JSON.stringify({ type: 'interval', everyMinutes: schedule.everyMinutes })
    // L1: 원본 비교도 같은 dow→dows 승격을 거쳐야 한다 — 안 그러면 옛 형식 루틴은 아무것도 안 바꿔도 스케줄이 "바뀐 것"으로 잡혀 덮어써진다
    : JSON.stringify({ type: schedule.type ?? 'daily', time: schedule.time, ...((schedule.type ?? 'daily') === 'weekly' ? { dows: schedule.dows ?? (schedule.dow != null ? [schedule.dow] : undefined) } : {}) }));
  const form = useRef(null);
  useEffect(() => { form.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const save = (event) => {
    event.preventDefault();
    if (disabled || !title.trim() || !prompt.trim()) return;
    if (editableSchedule && type === 'interval' && (!Number.isInteger(Number(minutes)) || Number(minutes) < 10 || Number(minutes) > 1440)) { setInvalid(true); return; }
    if (editableSchedule && type === 'weekly' && !dows.length) { setInvalid(true); return; }
    setInvalid(false);
    const patch = {};
    if (title.trim() !== value.title) patch.title = title.trim();
    if (prompt.trim() !== value.prompt) patch.prompt = prompt.trim();
    if (editableSchedule) {
      const next = type === 'interval' ? { type: 'interval', everyMinutes: Number(minutes) } : { type, time, ...(type === 'weekly' ? { dows } : {}) };
      if (JSON.stringify(next) !== originalSchedule.current) patch.schedule = { ...next, tz: schedule.tz };
    }
    if (!Object.keys(patch).length) { onClose(); return; }
    act(() => checked(supabase.rpc('msgr_crew_routine_edit', { p_routine: value.id, p_op: 'update', p_patch: patch })), onSaved);
  };
  return <form className="work-form work-editor" onSubmit={save} ref={form}>
    <h3>{t('automation.edit')}</h3>
    <label className="work-field"><span>{t('automation.name')}</span><input value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} disabled={disabled} /></label>
    <label className="work-field"><span>{t('automation.prompt')}</span><textarea value={prompt} required maxLength={18000} rows={3} onChange={(event) => setPrompt(event.target.value)} disabled={disabled} /></label>
    {editableSchedule ? <>
      <div className="work-grid"><label className="work-field"><span>{t('automation.repeat')}</span><select value={type} onChange={(event) => setType(event.target.value)} disabled={disabled}>{['daily', 'weekly', 'interval'].map((key) => <option key={key} value={key}>{t(`routine.kind.${key}`)}</option>)}</select></label>
        {type === 'interval' ? <label className="work-field"><span>{t('automation.minutes')}</span><input type="number" min="10" max="1440" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} required disabled={disabled} /></label> : <label className="work-field"><span>{t('automation.time')}</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required disabled={disabled} /></label>}</div>
      {type === 'weekly' && <fieldset className="work-days"><legend>{t('automation.days')}</legend>{[0, 1, 2, 3, 4, 5, 6].map((day) => <label key={day}><input type="checkbox" checked={dows.includes(day)} disabled={disabled} onChange={(event) => setDows((current) => event.target.checked ? [...current, day].sort() : current.filter((v) => v !== day))} />{t(`routine.day.${day}`)}</label>)}</fieldset>}
      {/* L2: 반복 종류를 바꾸면 Argo 쪽 루프·검증 설정(interval 전용)이 초기화된다 — 메신저는 그 설정을 못 보므로 경고만 */}
      {type !== (schedule.type ?? 'daily') && <p className="work-note">{t('routine.kind.change.warning')}</p>}
    </> : <p className="work-note">{t('routine.schedule.readonly')} <RoutineSchedule schedule={schedule} t={t} /></p>}
    {invalid && <p className="work-notice error" role="alert">{t('work.error.schedule')}</p>}
    <div className="work-actions"><button className="btn btn-primary" disabled={disabled || !title.trim() || !prompt.trim()}>{t('ui.save')}</button><button type="button" className="btn" disabled={disabled} onClick={onClose}>{t('ui.cancel')}</button></div>
  </form>;
}

function RunHistory({ automationId, own, channelId, crews, t, lang }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [deliveryError, setDeliveryError] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [thread, setThread] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; let sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const runs = await checked(supabase.from('msgr_automation_runs').select('*').eq('automation_id', automationId).order('created_at', { ascending: false }).limit(20));
        if (!active || sequence !== request) return;
        setRows(runs ?? []); setError(null);
        if (own && runs?.some((run) => run.notification_route_ids?.length)) {
          try {
            const [result, destinations] = await Promise.all([
              checked(supabase.from('msgr_notification_deliveries').select('id,run_id,route_id,status,finished_at').in('run_id', runs.map((run) => run.id))),
              checked(supabase.rpc('msgr_notification_routes_list')),
            ]);
            if (active && sequence === request) { setDeliveries(result ?? []); setRoutes(destinations ?? []); setDeliveryError(null); }
          } catch (failure) { if (active && sequence === request) setDeliveryError(failure); }
        } else { setDeliveries([]); setDeliveryError(null); }
      } catch (failure) { if (active && sequence === request) setError(failure); }
    };
    load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [automationId, own, revision]);
  return <div className="work-history"><div className="work-section-heading"><h3>{t('automation.history')}</h3><button type="button" className="btn sm" onClick={() => setRevision((value) => value + 1)}>{t('work.refresh')}</button></div><StateNotice rows={rows} error={error} empty={t('automation.history.empty')} refresh={() => setRevision((value) => value + 1)} t={t} />
    {(rows ?? []).map((run) => <div className="work-history-row" key={run.id}><div><span>{stamp(run.created_at, lang)} · {t(`automation.trigger.${run.trigger}`)}</span><p>{t(`automation.run.${run.status}`)}</p>{run.error && <p className="work-notice error">{errorText({ message: run.error }, t)}</p>}{own && run.notification_route_ids?.length > 0 && <div className="work-delivery-status">
        <strong>{t('automation.notifications.delivery')}</strong>
        {deliveryError ? <p role="status">{t('automation.notifications.deliveryError')}</p> : run.notification_route_ids.map((id) => {
          const delivery = deliveries.find((row) => row.run_id === run.id && row.route_id === id);
          const route = routes.find((row) => row.id === id);
          return <p key={id}>{route ? `${t(`automation.notifications.${route.kind}`)} · ${route.label} (${route.ws_id})` : t('automation.notifications.external')} — {t(`automation.delivery.${delivery?.status ?? 'pending'}`)}</p>;
        })}
      </div>}</div>{run.message_id && <button className="btn sm" onClick={() => setThread({ root: run.message_id, label: t('automation.history') })}>{t('work.discussion')}</button>}</div>)}
    {thread && <Discussion channelId={channelId} thread={thread} crews={crews} t={t} lang={lang} onClose={() => setThread(null)} />}
  </div>;
}

function Discussion({ channelId, thread, crews, t, lang, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const heading = useRef(null);
  useEffect(() => { heading.current?.scrollIntoView({ block: 'start' }); }, [thread.root]);
  useEffect(() => {
    let active = true; let sequence = 0; setRows(null); setError(null);
    const load = async () => { const request = ++sequence; try {
      const messages = await checked(supabase.from('msgr_messages').select('id,body,author_kind,crew_id,created_at').eq('channel_id', channelId).is('deleted_at', null).or(`id.eq.${thread.root},thread_root.eq.${thread.root}`).order('id', { ascending: false }).limit(100));
      if (active && sequence === request) { setRows((messages ?? []).reverse()); setError(null); }
    } catch (failure) { if (active && sequence === request) setError(failure); } };
    load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, POLL_MS); return () => { active = false; clearInterval(timer); };
  }, [channelId, thread.root, revision]);
  return <section className="work-discussion" aria-label={t('work.discussion')}><div className="work-section-heading" ref={heading}><h3>{t('work.discussion')}</h3><button className="btn sm" onClick={onClose}>{t('ui.close')}</button></div>
    <p className="work-note">{thread.label}</p><StateNotice rows={rows} error={error} empty={t('work.discussion.empty')} refresh={() => setRevision((value) => value + 1)} t={t} />
    {(rows ?? []).map((message) => <article className="work-discussion-message" key={message.id}><p className="work-note"><b>{message.author_kind === 'crew' ? crews.find((crew) => crew.id === message.crew_id)?.display_name ?? t('work.crew.unavailable') : t('work.request')}</b> · {stamp(message.created_at, lang)}</p><Markdown text={message.body} /></article>)}
    {rows?.length === 100 && <p className="work-note">{t('work.discussion.limit')}</p>}
  </section>;
}

function ResumeWork({ run, disabled, act, t }) {
  const [instruction, setInstruction] = useState('');
  const request = useRef(null);
  return <form className="work-form" onSubmit={(event) => {
    event.preventDefault(); if (!instruction.trim() || disabled) return;
    request.current ??= crypto.randomUUID();
    act(() => checked(supabase.rpc('msgr_work_resume', { p_run: run.id, p_request: request.current, p_instruction: instruction.trim() })), () => { setInstruction(''); request.current = null; });
  }}><label className="work-field"><span>{t('work.resume')}</span><textarea rows={2} required maxLength={6000} value={instruction} placeholder={t('work.resume.placeholder')} disabled={disabled} onChange={(event) => { setInstruction(event.target.value); request.current = null; }} /></label><button className="btn sm" disabled={disabled || !instruction.trim()}>{t('work.resume')}</button></form>;
}

function SchedulerStatus({ t }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let active = true;
    const load = async () => { try { const row = await checked(supabase.rpc('msgr_automation_scheduler_status')); if (active) setStatus(row); } catch { if (active) setStatus({ server_active: false }); } };
    load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, 30_000); return () => { active = false; clearInterval(timer); };
  }, []);
  return <p className="work-notice" role="status">{t(status === null ? 'automation.scheduler.checking' : status.server_active ? 'automation.scheduler.active' : 'automation.scheduler.inactive')}</p>;
}

function Pages({ source, disabled, t }) {
  if (source.page === 0 && !source.hasMore) return null;
  return <nav className="work-actions work-pagination" aria-label={t('work.pages')}><button className="btn sm" disabled={disabled || source.page === 0} onClick={() => source.setPage((page) => page - 1)}>{t('work.previous')}</button><span className="work-note">{t('work.page', { n: source.page + 1 })}</span><button className="btn sm" disabled={disabled || !source.hasMore} onClick={() => source.setPage((page) => page + 1)}>{t('work.next')}</button></nav>;
}
