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
const errorText = (error, t) => {
  const message = error?.message ?? '';
  if (/PGRST20[25]|42P01|42883/.test(error?.code ?? '') || /schema cache|does not exist|Could not find the (table|function)/i.test(message)) return t('work.error.upgrade');
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
        ? 'id,channel_id,crew_id,created_by,title,prompt,schedule,enabled,next_run_at,last_run_at,last_status'
        : 'id,channel_id,created_by,goal,completion_criteria,lead_crew_id,root_message_id,status,result,created_at';
      let query = supabase.from(table).select(fields).eq('channel_id', channelId);
      if (table === 'msgr_automations') query = query.is('deleted_at', null);
      const [rows, capabilities] = await Promise.all([
        checked(query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * 25, page * 25 + 25)),
        table === 'msgr_work_runs' && capabilityIds ? checked(supabase.from('msgr_crews').select('id,work_protocol').in('id', capabilityIds.split(','))) : [],
      ]);
      if (request === revision.current) { failures.current = 0; missing.current = false; setState({ rows: (rows ?? []).slice(0, 25), error: null, hasMore: (rows ?? []).length > 25, capabilities }); }
    } catch (error) { if (request === revision.current) {
      failures.current++; missing.current = /PGRST20[25]|42P01|42883/.test(error?.code ?? '') || /schema cache|does not exist|Could not find the (table|function)/i.test(error?.message ?? '');
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

function CrewSelect({ crews, value, onChange, automatic, t, disabled }) {
  return <label className="work-field"><span>{t(automatic ? 'work.lead' : 'automation.crew')}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} required={!automatic}>
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
export function WorkPanel({ channel, uid, isAdmin, locked, crews, t, lang, onClose }) {
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
      if (mounted.current) { done?.(data); await Promise.all([work.refresh(), automations.refresh()]); }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  };
  const keydown = (event) => {
    if (event.key === 'Escape' && !deleting) { event.preventDefault(); event.stopPropagation(); if (!actionLock.current) closeRef.current(); }
    if (event.key !== 'Tab') return;
    const scope = deleting ? document.querySelector('.msgr-work-overlay .msgr-action-dialog') : dialog.current;
    const buttons = [...scope.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((item) => item.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className="shell msgr-work-overlay" onKeyDown={keydown} onClick={(event) => { if (event.target === event.currentTarget && !busy && !deleting) onClose(); }}>
    <section className="msgr-work-panel" ref={dialog} role="dialog" aria-modal="true" aria-label={t('work.title')} inert={deleting ? true : undefined}>
      <header className="work-header"><div><h2>{t('work.title')}</h2><p>{channel.name}</p></div><button className="btn sm" disabled={busy} onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
      <div className="work-tabs" role="tablist" aria-label={t('work.title')}>{['team', 'automations'].map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} aria-controls={`work-view-${key}`} id={`work-tab-${key}`} tabIndex={tab === key ? 0 : -1} disabled={busy} onClick={() => { setTab(key); setError(null); setNotice(''); }} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'team' : event.key === 'End' ? 'automations' : key === 'team' ? 'automations' : 'team'; setTab(next); event.currentTarget.parentElement.querySelector(`#work-tab-${next}`)?.focus(); } }}>{t(`work.tab.${key}`)}</button>)}</div>
      <div className="work-scroll" role="tabpanel" id={`work-view-${tab}`} aria-labelledby={`work-tab-${tab}`}>
        {locked && <p className="work-notice" role="status">{t('org.locked.short')}</p>}
        {error && <p className="work-notice error" role="alert">{errorText(error, t)}</p>}
        {notice && <p className="work-notice" role="status">{notice}</p>}
        {tab === 'team' ? <TeamWork key="team" work={work} channel={channel} crews={eligible.filter((crew) => crew.hosting === 'bot' || (work.capabilities ?? []).some((row) => row.id === crew.id && row.work_protocol >= 1))} uid={uid} isAdmin={isAdmin} disabled={busy || locked} busy={busy} act={act} t={t} lang={lang} />
          : <Automations key="automations" source={automations} channel={channel} crews={eligible} uid={uid} disabled={busy || locked} busy={busy} act={act} t={t} lang={lang} setDeleting={setDeleting} setNotice={setNotice} />}
      </div>
    </section>
    {deleting && <div className="msgr-action-dialog" role="dialog" aria-modal="true" aria-label={t('automation.delete')}><DangerModal title={t('automation.delete')} description={<>{t('automation.delete.note')}{error && <span className="work-notice error" role="alert">{errorText(error, t)}</span>}</>} requireText={deleting.title} confirmLabel={t('automation.delete')} busy={busy} onClose={() => { if (!busy) { setDeleting(null); setError(null); } }} onConfirm={() => act(() => checked(supabase.rpc('msgr_automation_delete', { automation: deleting.id })), () => { setDeleting(null); setNotice(t('automation.deleted')); })} /></div>}
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
      {run.result && <div className="work-result"><Markdown text={run.result} /></div>}
      <div className="work-actions"><button className="btn sm" disabled={!run.root_message_id} onClick={() => setThread({ root: run.root_message_id, workId: run.id, label: run.goal })}>{t('work.discussion')}</button>
        {!TERMINAL.has(run.status) && (run.created_by === uid || isAdmin) && <button className="btn sm" disabled={disabled} onClick={() => act(() => checked(supabase.rpc('msgr_work_cancel', { p_run: run.id })))}>{t('work.cancel')}</button>}</div>
      {run.status === 'blocked' && (run.created_by === uid || isAdmin) && <ResumeWork run={run} disabled={disabled} act={act} t={t} />}
      {!TERMINAL.has(run.status) && <p className="work-note">{t('work.cancel.note')}</p>}
    </article>)}
    <Pages source={work} disabled={busy} t={t} />
  </>;
}

function Automations({ source, channel, crews, uid, disabled, busy, act, t, lang, setDeleting, setNotice }) {
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);
  const runRequests = useRef(new Map());
  return <>
    <p className="work-note">{t('automation.intro')}</p>
    {source.rows !== null && !source.error && <SchedulerStatus t={t} />}
    <div className="work-section-heading"><h3>{t('work.tab.automations')}</h3><div className="work-actions"><button className="btn sm" onClick={source.refresh} disabled={busy}>{t('work.refresh')}</button><button className="btn btn-primary sm" disabled={disabled || !crews.length || !!source.error || source.rows === null} onClick={() => setEditing({})}>{t('automation.new')}</button></div></div>
    {!crews.length && <p className="work-notice">{t('work.noCrew')}</p>}
    {editing && <AutomationForm key={editing.id ?? 'new'} value={editing} crews={crews} channel={channel} t={t} disabled={disabled} act={act} onClose={() => setEditing(null)} onSaved={() => { if (!editing.id) source.setPage(0); setEditing(null); setNotice(t('automation.saved')); }} />}
    <StateNotice {...source} empty={t('automation.empty')} t={t} />
    {(source.rows ?? []).map((automation) => <article className="work-item" key={automation.id}>
      <div className="work-item-top"><strong>{automation.title}</strong><span className={`work-status ${automation.enabled ? 'running' : 'cancelled'}`}>{t(automation.enabled ? 'automation.enabled' : 'automation.paused')}</span></div>
      <p className="work-text">{automation.prompt}</p>
      <p className="work-note">{crews.find((crew) => crew.id === automation.crew_id)?.display_name ?? t('work.crew.unavailable')} · <Schedule schedule={automation.schedule} t={t} /></p>
      <p className="work-note">{t('automation.next')}: {automation.enabled ? stamp(automation.next_run_at, lang) : '—'} · {t('automation.last')}: {stamp(automation.last_run_at, lang)}</p>
      {automation.enabled && ['queued', 'running'].includes(automation.last_status) && <p className="work-note">{t('automation.running.note')}</p>}
      <div className="work-actions"><button className="btn sm" onClick={() => setHistory(history === automation.id ? null : automation.id)} aria-expanded={history === automation.id}>{t('automation.history')}</button>
        {automation.created_by === uid && <><button className="btn sm" disabled={disabled} onClick={() => setEditing(automation)}>{t('automation.edit')}</button><button className="btn sm" disabled={disabled} onClick={() => act(() => checked(supabase.rpc('msgr_automation_set_enabled', { automation: automation.id, enabled: !automation.enabled })))}>{t(automation.enabled ? 'automation.pause' : 'automation.resume')}</button><button className="btn sm" disabled={disabled} onClick={() => { if (!runRequests.current.has(automation.id)) runRequests.current.set(automation.id, crypto.randomUUID()); act(() => checked(supabase.rpc('msgr_automation_run_now', { automation: automation.id, request_id: runRequests.current.get(automation.id) })), () => { runRequests.current.delete(automation.id); setHistory(automation.id); setNotice(t('automation.run.requested')); }); }}>{t('automation.run')}</button><button className="btn sm work-danger" disabled={disabled} onClick={() => setDeleting(automation)}>{t('automation.delete')}</button></>}
      </div>
      {history === automation.id && <RunHistory automationId={automation.id} channelId={channel.id} crews={crews} t={t} lang={lang} />}
    </article>)}
    <Pages source={source} disabled={busy} t={t} />
  </>;
}

function Schedule({ schedule = {}, t }) {
  return <>{schedule.kind === 'interval' ? t('automation.every', { n: schedule.minutes }) : <>{t(`automation.kind.${schedule.kind}`)} {schedule.kind === 'weekly' ? (schedule.weekdays ?? []).map((day) => t(`automation.day.${day}`)).join(' · ') : ''} {schedule.time}</>} · {schedule.timezone}</>;
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
  const form = useRef(null);
  const createRequest = useRef(null);
  useEffect(() => { form.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const save = (event) => {
    event.preventDefault();
    let validZone = true; try { new Intl.DateTimeFormat('en', { timeZone: timezone.trim() }).format(); } catch { validZone = false; }
    if (!validZone || (kind === 'weekly' && !weekdays.length) || (kind === 'interval' && (!Number.isInteger(Number(minutes)) || Number(minutes) < 5 || Number(minutes) > 10080))) { setInvalid(true); return; }
    setInvalid(false);
    const schedule = { kind, timezone: timezone.trim(), ...(kind === 'interval' ? { minutes: Number(minutes) } : { time }), ...(kind === 'weekly' ? { weekdays } : {}) };
    const fingerprint = JSON.stringify([channel.id, crew, title.trim(), prompt.trim(), schedule]);
    if (!createRequest.current || createRequest.current.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
    act(() => checked(supabase.rpc('msgr_automation_save', { automation: value.id ?? null, channel: channel.id, crew, title: title.trim(), prompt: prompt.trim(), schedule, request_id: value.id ? null : createRequest.current.id })), onSaved);
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
    {invalid && <p className="work-notice error" role="alert">{t('work.error.schedule')}</p>}
    <div className="work-actions"><button className="btn btn-primary" disabled={disabled || !title.trim() || !prompt.trim() || !crew}>{t('ui.save')}</button><button type="button" className="btn" disabled={disabled} onClick={onClose}>{t('ui.cancel')}</button></div>
  </form>;
}

function RunHistory({ automationId, channelId, crews, t, lang }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [thread, setThread] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; let sequence = 0;
    const load = async () => { const request = ++sequence; try { const runs = await checked(supabase.from('msgr_automation_runs').select('*').eq('automation_id', automationId).order('created_at', { ascending: false }).limit(20)); if (active && sequence === request) { setRows(runs ?? []); setError(null); } } catch (failure) { if (active && sequence === request) setError(failure); } };
    load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [automationId, revision]);
  return <div className="work-history"><StateNotice rows={rows} error={error} empty={t('automation.history.empty')} refresh={() => setRevision((value) => value + 1)} t={t} />
    {(rows ?? []).map((run) => <div className="work-history-row" key={run.id}><div><span>{stamp(run.created_at, lang)} · {t(`automation.trigger.${run.trigger}`)}</span><p>{t(`automation.run.${run.status}`)}</p>{run.error && <p className="work-notice error">{errorText({ message: run.error }, t)}</p>}</div>{run.message_id && <button className="btn sm" onClick={() => setThread({ root: run.message_id, label: t('automation.history') })}>{t('work.discussion')}</button>}</div>)}
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
