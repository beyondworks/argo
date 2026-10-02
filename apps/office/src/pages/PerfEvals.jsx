// 평가 레포트(트랙 C, 유건 10/2) — 인트라넷 인사고과 레포트(5항목 레이더·종합점수·총평·기간 업무내용·성과)를 성과 기록 안으로.
// 성과 기록 규칙을 지킨다: 추가만(고치기 = 새 판, 원래 판 남음), 사람 대상은 본인과 관리자만, 근거는 본인이 공유한 사본만.
// 인트라넷보다 나은 것: 근거(공유된 성과 기록 합계), 판 이력, 같은 대상·범위의 추이, 관리자 화면에서 바로 쓰기.
import { useId, useMemo, useState } from 'react';
import { t, getLang, registerDict, useLang } from '../core/i18n.js';
import { useEvals, evalWrite } from '../core/evals.js';
import { usePeople } from '../core/company.js';
import { useStore, crewsIn } from '../core/store.js';
import { ME } from '../core/session.js';
import { kstDay } from '../core/task-model.js';
import { periodRange, shiftAnchor, rate } from '../core/perf-model.js';
import { SCORE_KEYS, SCOPES, scoreTone, autoTotal, radarPoints, hasScores, versionsOf, subjectsOf, filterEvals, trendOf, trendPath, evalPayload } from '../core/eval-model.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Markdown } from '../ui/Markdown.jsx';
import { EVAL_DICT } from './eval-i18n.js';
import './company.css';
import { Hide } from '../business/Redact.jsx';

registerDict(EVAL_DICT);
const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const dayText = (d, o) => new Date(`${d}T00:00:00+09:00`).toLocaleDateString(locale(), { timeZone: 'Asia/Seoul', ...o });
const money = (n) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(n || 0));
export function periodText(e) {
  if (e.period_label) return e.period_label;
  if (e.scope === 'year') return dayText(e.period_from, { year: 'numeric' });
  if (e.scope === 'month') return dayText(e.period_from, { year: 'numeric', month: 'long' });
  return `${dayText(e.period_from, { month: 'short', day: 'numeric' })} – ${dayText(e.period_to, { month: 'short', day: 'numeric' })}`;
}
const authorText = (e) => t(e.author_kind === 'crew' ? 'ev.authorCrew' : e.author_kind === 'import' ? 'ev.authorImport' : 'ev.author', { name: e.author_name || '—' });

export default function PerfEvals({ space, manager, openId }) {
  useLang();
  const ev = useEvals(space);
  const [scope, setScope] = useState('all'), [subject, setSubject] = useState('all'), [open, setOpen] = useState(openId ?? null), [form, setForm] = useState(null);
  const all = ev.data?.evals ?? [];
  const isManager = manager && ev.data?.role === 'manager';
  const subjects = useMemo(() => subjectsOf(all, locale()), [all]);
  const list = useMemo(() => filterEvals(all, { scope, subject }), [all, scope, subject]);
  const cur = open && all.find((e) => e.id === open);
  const newVersion = (e) => { setOpen(null); setForm({ id: crypto.randomUUID(), replaces: e.id, base: e, title: e.title, ...Object.fromEntries(SCORE_KEYS.map((k) => [k, e[k] ?? ''])), total: '', review: e.review, work: e.work, achievements: e.achievements }); };
  return <>
    <div className="perf-bar">
      <div className="seg" role="tablist">{['all', ...SCOPES].map((s) => <button key={s} type="button" role="tab" aria-selected={scope === s} className={`seg-btn${scope === s ? ' on' : ''}`} onClick={() => setScope(s)}>{t(`ev.scope.${s}`)}</button>)}</div>
      {subjects.length > 1 && <select className="input ev-subject" value={subject} aria-label={t('ev.subject.all')} onChange={(e) => setSubject(e.target.value)}>
        <option value="all">{t('ev.subject.all')}</option>{subjects.map((s) => <option key={s.key} value={s.key}>{s.name} · {t(`ev.type.${s.type}`)}</option>)}</select>}
      {isManager && <button type="button" className="btn primary sm push" onClick={() => setForm({ id: crypto.randomUUID(), subject_kind: 'person', subject_user: '', subject_name: '', subject_type: 'staff', scope: 'month', anchor: shiftAnchor('month', kstDay(), -1), title: '', review: '', work: '', achievements: '', total: '' })}><Icon name="plus" size={13} />{t('ev.new')}</button>}
    </div>
    <p className="dim small">{t(isManager ? 'ev.hint' : 'ev.hintMember')}</p>
    {ev.error && <p className="biz-error" role="alert">{t(ev.error)}</p>}
    {!ev.data ? <p className="dim small" role="status">{ev.loading ? t('ev.loading') : ''}</p>
      : !list.length ? <div className="empty-state"><Icon name="target" size={20} /><p>{t(all.length ? 'ev.emptyFilter' : 'ev.empty')}</p>{isManager && !all.length && <p className="dim small">{t('ev.emptyManager')}</p>}</div>
        : <div className="ev-grid">{list.map((e) => <EvalCard key={e.id} e={e} onOpen={() => setOpen(e.id)} />)}</div>}
    {cur && <Detail e={cur} all={all} manager={isManager} onClose={() => setOpen(null)} onPick={setOpen} onNewVersion={newVersion} />}
    {form && <EvalForm space={space} form={form} setForm={setForm} onSaved={(id) => { setForm(null); ev.reload(); setOpen(id); showToast(t('ev.saved')); }} />}
  </>;
}

function EvalCard({ e, onOpen }) {
  return <button type="button" className="ev-card" onClick={onOpen}>
    <span className="ev-card-head"><strong>{e.title}</strong><span className="badge">{t(`ev.scope.${e.scope}`)}</span></span>
    <span className="ev-meta"><span className="badge">{t(`ev.type.${e.subject_type}`)}</span><Icon name={e.subject_kind === 'crew' ? 'hand' : 'person'} size={12} />{e.subject_name}</span>
    <span className="ev-foot"><span><Icon name="calendar" size={12} /> {periodText(e)}</span><span className={`ev-total tone-${scoreTone(e.total)}`}>{e.total ?? '—'}</span></span>
    <span className="ev-foot"><span>{authorText(e)}</span>{e.replaces && <span>{t('ev.versionN', { n: 2 })}+</span>}</span>
  </button>;
}

export function Radar({ e, size = 280 }) {
  const c = size / 2, r = size / 2 - 26;
  const ring = (f) => radarPoints(Object.fromEntries(SCORE_KEYS.map((k) => [k, f * 100])), r, c, c).map((p) => p.join(',')).join(' ');
  const tips = radarPoints(Object.fromEntries(SCORE_KEYS.map((k) => [k, 100])), r, c, c);
  const area = radarPoints(e, r, c, c).map((p) => p.join(',')).join(' ');
  if (!hasScores(e)) return <p className="mod-empty">{t('ev.noScores')}</p>;
  return <svg className="ev-radar" viewBox={`-56 -6 ${size + 112} ${size + 12}`} role="img" aria-label={SCORE_KEYS.map((k) => `${t(`ev.s.${k}`)} ${e[k] ?? '—'}`).join(', ')}>
    {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} className="grid" points={ring(f)} />)}
    {tips.map(([x, y], i) => <line key={i} className="axis" x1={c} y1={c} x2={x} y2={y} />)}
    <polygon className="area" points={area} />
    {tips.map(([x, y], i) => { const dx = x - c, dy = y - c; const lx = c + dx * 1.14, ly = c + dy * 1.14 + 4; return <text key={i} x={lx} y={ly} textAnchor={Math.abs(dx) < 4 ? 'middle' : dx > 0 ? 'start' : 'end'}>{t(`ev.s.${SCORE_KEYS[i]}`)}</text>; })}
  </svg>;
}

function Trend({ points, current }) {
  const W = 420, H = 80, xy = trendPath(points, W, H, 10);
  if (points.length < 2) return null;
  return <div className="ev-box"><span className="label">{t('ev.trend')}</span>
    <svg className="ev-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={points.map((p) => `${p.from} ${p.total}`).join(', ')}>
      <line className="base" x1="0" x2={W} y1={H - 6} y2={H - 6} />
      <polyline points={xy.map((p) => p.join(',')).join(' ')} />
      {xy.map(([x, y], i) => <g key={points[i].id}><circle className={points[i].id === current ? 'on' : ''} cx={x} cy={y} r="3.2"><title>{`${points[i].from} · ${points[i].total}`}</title></circle>
        <text x={x} y={y - 7} textAnchor={i === 0 ? 'start' : i === xy.length - 1 ? 'end' : 'middle'}>{points[i].total}</text></g>)}
    </svg></div>;
}

function Basis({ b }) {
  if (!b?.totals) return <p className="dim small">{t('ev.basisNone')}</p>;
  const s = b.totals, on = rate(s.tasks_on_time, s.tasks_due);
  return <div className="ev-box"><span className="label">{t('ev.basis')} · {b.period}</span>
    <div className="ev-basis"><span>{t('ev.b.contract')} <b><Hide k="eval:contract">{money(s.contract)}</Hide></b></span><span>{t('ev.b.paid')} <b><Hide k="eval:paid">{money(s.paid)}</Hide></b></span>
      <span>{t('ev.b.done')} <b>{s.tasks_done ?? 0}</b></span><span>{t('ev.b.onTime')} <b>{on == null ? '—' : `${on}%`}</b></span>
      <span>{t('ev.b.approvals')} <b>{s.approvals ?? 0}</b></span><span>{t('ev.b.pages')} <b>{s.pages ?? 0}</b></span></div></div>;
}

function Detail({ e, all, manager, onClose, onPick, onNewVersion }) {
  const versions = versionsOf(all, e.id);
  const trend = trendOf(all, e);
  return <Modal open width={860} title={e.title} onClose={onClose} footer={<>
    {manager && !e.replaced_by && <button type="button" className="btn" onClick={() => onNewVersion(e)}><Icon name="draft" size={13} />{t('ev.newVersion')}</button>}
    <span className="spacer" /><button type="button" className="btn primary" onClick={onClose}>{t('ev.close')}</button></>}>
    <div className="ev-detail">
      <div className="ev-meta"><span className="badge">{t(`ev.scope.${e.scope}`)}</span><span className="badge">{t(`ev.type.${e.subject_type}`)}</span><strong>{e.subject_name}</strong><span>· {periodText(e)}</span>
        {e.replaced_by && <button type="button" className="badge late link-btn" onClick={() => onPick(e.replaced_by)}>{t('ev.replaced')}</button>}</div>
      {versions.length > 1 && <div className="ev-versions" role="group" aria-label={t('ev.versions')}>{versions.map((v, i) => <button key={v.id} type="button" className={`btn sm${v.id === e.id ? ' primary' : ''}`} aria-pressed={v.id === e.id} onClick={() => onPick(v.id)}>{t('ev.versionN', { n: i + 1 })}{!v.replaced_by ? ` · ${t('ev.current')}` : ''}</button>)}</div>}
      <div className="ev-top">
        <div><span className="dim small">{t('ev.total')}</span><div className={`ev-total big tone-${scoreTone(e.total)}`}>{e.total ?? '—'}{e.total != null && <small>{t('ev.outOf')}</small>}</div>
          <dl className="ev-scores">{SCORE_KEYS.map((k) => <div key={k}><dt>{t(`ev.s.${k}`)}</dt><dd>{e[k] ?? '—'}</dd></div>)}</dl></div>
        <Radar e={e} />
      </div>
      <Basis b={e.basis} />
      <Trend points={trend} current={e.id} />
      {e.review && <div className="ev-box"><span className="label">{t('ev.review')}</span><Markdown text={e.review} /></div>}
      {e.work && <div className="ev-box"><span className="label">{t(`ev.work.${e.scope}`)}</span><Markdown text={e.work} /></div>}
      {e.achievements && <div className="ev-box"><span className="label">{t(`ev.ach.${e.scope}`)}</span><Markdown text={e.achievements} /></div>}
      <div className="ev-foot"><span>{authorText(e)}</span><span>{t('ev.created', { date: new Date(e.created_at).toLocaleString(locale(), { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) })}</span></div>
    </div>
  </Modal>;
}

function EvalForm({ space, form, setForm, onSaved }) {
  const formId = useId(), crewList = useId();
  const people = usePeople(space).data?.people ?? [];
  const crews = crewsIn(useStore((s) => s.crews), space, ME.id);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm({ ...form, ...patch });
  const locked = !!form.replaces;
  const period = locked ? { from: form.base.period_from, to: form.base.period_to } : periodRange(form.scope, form.anchor);
  const subjectName = locked ? form.base.subject_name : form.subject_kind === 'crew' ? form.subject_name : people.find((p) => p.user_id === form.subject_user)?.name ?? '';
  const avg = autoTotal(form);
  const defaultTitle = subjectName ? t('ev.defaultTitle', { name: subjectName, period: periodText({ scope: locked ? form.base.scope : form.scope, period_from: period.from, period_to: period.to }) }) : '';
  const payload = evalPayload({ ...form, title: form.title || defaultTitle }, period);
  const submit = async (e) => {
    e.preventDefault();
    if (!payload || busy) return;
    setBusy(true);
    try { const r = await evalWrite(space, payload); onSaved(r?.eval?.id ?? payload.id); } catch (err) { showToast(t(err.message)); } finally { setBusy(false); }
  };
  const accounts = people.filter((p) => p.user_id && p.status === 'active');
  return <Modal open width={720} title={t(locked ? 'ev.newVersion' : 'ev.new')} onClose={() => setForm(null)} footer={<>
    <span className="dim small">{t('ev.f.final')}</span><span className="spacer" />
    <button type="button" className="btn" onClick={() => setForm(null)}>{t('ev.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={!payload || busy}>{t('ev.save')}</button></>}>
    <form id={formId} className="perf-form ev-form" onSubmit={submit}>
      {locked ? <p className="dim small">{t('ev.f.locked')} — {form.base.subject_name} · {periodText(form.base)}</p> : <>
        <div className="ev-form-row">
          <label className="field-block"><span className="label">{t('ev.f.subject')}</span>
            <select className="input" value={form.subject_kind} onChange={(e) => set({ subject_kind: e.target.value })}><option value="person">{t('ev.f.kind.person')}</option><option value="crew">{t('ev.f.kind.crew')}</option></select></label>
          {form.subject_kind === 'person' ? <>
            <label className="field-block"><span className="label">{t('ev.f.person')}</span>
              <select className="input" value={form.subject_user} onChange={(e) => set({ subject_user: e.target.value })} data-autofocus><option value="" disabled>{t('ev.f.person')}</option>
                {accounts.map((p) => <option key={p.user_id} value={p.user_id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}</select></label>
            <label className="field-block"><span className="label">{t('ev.f.type')}</span>
              <select className="input" value={form.subject_type} onChange={(e) => set({ subject_type: e.target.value })}><option value="staff">{t('ev.type.staff')}</option><option value="ceo">{t('ev.type.ceo')}</option></select></label>
          </> : <label className="field-block"><span className="label">{t('ev.f.crew')}</span>
            <input className="input" list={crewList} maxLength={100} value={form.subject_name} onChange={(e) => set({ subject_name: e.target.value })} />
            <datalist id={crewList}>{crews.map((c) => <option key={c.id} value={c.name} />)}</datalist></label>}
        </div>
        <div className="ev-form-row">
          <label className="field-block"><span className="label">{t('ev.f.scope')}</span>
            <select className="input" value={form.scope} onChange={(e) => set({ scope: e.target.value })}>{SCOPES.map((s) => <option key={s} value={s}>{t(`ev.scope.${s}`)}</option>)}</select></label>
          <label className="field-block"><span className="label">{t('ev.f.anchor')} · {periodText({ scope: form.scope, period_from: period.from, period_to: period.to })}</span>
            {form.scope === 'month' ? <input className="input" type="month" value={form.anchor.slice(0, 7)} onChange={(e) => e.target.value && set({ anchor: `${e.target.value}-01` })} />
              : form.scope === 'year' ? <input className="input" type="number" min="2000" max="2100" value={form.anchor.slice(0, 4)} onChange={(e) => /^\d{4}$/.test(e.target.value) && set({ anchor: `${e.target.value}-01-01` })} />
                : <input className="input" type="date" value={form.anchor} onChange={(e) => e.target.value && set({ anchor: e.target.value })} />}</label>
        </div>
      </>}
      <label className="field-block"><span className="label">{t('ev.f.title')}</span><input className="input" maxLength={200} value={form.title} placeholder={defaultTitle} onChange={(e) => set({ title: e.target.value })} /></label>
      <div className="field-block"><span className="label">{t('ev.f.scores')}</span>
        <div className="scores">{SCORE_KEYS.map((k) => <label key={k} className="field-block"><span className="dim small">{t(`ev.s.${k}`)}</span>
          <input className="input" type="number" min="0" max="100" step="1" inputMode="numeric" value={form[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} /></label>)}
          <label className="field-block"><span className="dim small">{avg == null ? t('ev.f.totalNone') : t('ev.f.total', { n: avg })}</span>
            <input className="input" type="number" min="0" max="100" step="1" inputMode="numeric" value={form.total ?? ''} placeholder={avg ?? ''} onChange={(e) => set({ total: e.target.value })} /></label></div></div>
      <label className="field-block"><span className="label">{t('ev.f.review')}</span><textarea className="input" rows={6} maxLength={20000} value={form.review} onChange={(e) => set({ review: e.target.value })} /></label>
      <div className="ev-form-row">
        <label className="field-block"><span className="label">{t('ev.f.work')}</span><textarea className="input" rows={4} maxLength={20000} value={form.work} onChange={(e) => set({ work: e.target.value })} /></label>
        <label className="field-block"><span className="label">{t('ev.f.ach')}</span><textarea className="input" rows={4} maxLength={20000} value={form.achievements} onChange={(e) => set({ achievements: e.target.value })} /></label>
      </div>
    </form>
  </Modal>;
}

/** 내 기록(월간·연간)에 붙는 한 줄 — 이 기간 평가 레포트가 있으면 종합점수와 '자세히' */
export function EvalStrip({ space, from, to, onOpen, user = ME.id }) {
  useLang();
  const ev = useEvals(space);
  const mine = (ev.data?.evals ?? []).filter((e) => !e.replaced_by && e.subject_user === user && e.period_from === from && e.period_to === to);
  if (!mine.length) return null;
  return <section className="module" aria-label={t('ev.strip')}>
    <header className="module-head"><Icon name="target" size={15} /><h3>{t('ev.strip')}</h3></header>
    <ul className="perf-days">{mine.map((e) => <li key={e.id} className="perf-item"><span className="badge">{t(`ev.scope.${e.scope}`)}</span>
      <span className="perf-item-main">{e.title}<small className="dim"> · {authorText(e)}</small></span>
      <strong className={`ev-total tone-${scoreTone(e.total)}`}>{e.total ?? '—'}</strong>
      <button type="button" className="btn ghost sm" onClick={() => onOpen(e.id)}>{t('ev.open')}</button></li>)}</ul>
  </section>;
}
