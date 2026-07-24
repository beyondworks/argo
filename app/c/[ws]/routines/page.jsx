'use client';
// 루틴 — 크루에게 반복 지시를 예약하고, 원클릭으로 즉시 실행한다.
// 템플릿 원클릭 생성 → 폼 프리필. 실행 결과는 vault 기억으로 남는다.
import { use, useEffect, useState } from 'react';
import { Icon, Avatar, Spinner, Skeleton, useScrollLock, ConfirmModal, api, imeGuard, timeAgo } from '../../../ui';
import { useLang } from '../../../i18n';

function scheduleLabel(s, t, DOW) {
  // 복수 시각·요일은 '·'로 이어 기존 라벨 템플릿에 그대로 태운다 (예: 매주 월·수 09:00·18:00)
  const time = (s.times?.length ? s.times : [s.time]).join('·');
  if (s.type !== 'weekly') return t('routines.scheduleDaily', { time });
  const dow = (s.dows?.length ? s.dows : [s.dow ?? 1]).map((d) => DOW[d]).join('·');
  return t('routines.scheduleWeekly', { dow, time });
}

export default function Routines({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const DOW = [t('routines.dow.sun'), t('routines.dow.mon'), t('routines.dow.tue'), t('routines.dow.wed'), t('routines.dow.thu'), t('routines.dow.fri'), t('routines.dow.sat')];
  const TEMPLATES = [
    { title: t('routines.template1.title'), prompt: t('routines.template1.prompt'), schedule: { type: 'daily', time: '09:00' } },
    { title: t('routines.template2.title'), prompt: t('routines.template2.prompt'), schedule: { type: 'weekly', time: '10:00', dow: 1 } },
    { title: t('routines.template3.title'), prompt: t('routines.template3.prompt'), schedule: { type: 'daily', time: '18:00' } },
  ];
  const [routines, setRoutines] = useState(null);
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState(null); // {agentSlug,title,prompt,type,time,dow}
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [runTarget, setRunTarget] = useState(null); // 실행 팝업 대상 루틴
  const [delTarget, setDelTarget] = useState(null); // 삭제 확인 모달 대상 루틴
  const [nlText, setNlText] = useState(''); // 자연어 한 줄 → 자동 설정 입력
  const [nlBusy, setNlBusy] = useState(false);
  const [newTime, setNewTime] = useState('09:00'); // 시각 추가 입력

  // 자연어 → 초안 — 러너가 해석해 폼을 채운다. 결과는 프리필일 뿐, 저장 전 사용자가 검토·수정한다.
  async function applyNl() {
    if (nlBusy || !nlText.trim()) return;
    setNlBusy(true); setError('');
    try {
      const d = await api(`/api/companies/${ws}/routines/parse`, { text: nlText });
      if (d.unsupported) { setError(t('routines.nlTrigger')); return; }
      setForm((f) => ({
        ...f,
        title: d.draft.title || f.title,
        prompt: d.draft.prompt || f.prompt,
        type: d.draft.schedule.type,
        times: d.draft.schedule.times,
        dows: d.draft.schedule.dows ?? f.dows,
        agentSlug: d.draft.agentSlug || f.agentSlug,
      }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setNlBusy(false);
    }
  }

  function load() {
    // 불러오기 실패(손상 등)를 '루틴 없음'([])으로 붕괴시키지 않는다 — 에러를 표시하고 목록은 미확정으로 둔다.
    api(`/api/companies/${ws}/routines`)
      .then((d) => { setRoutines(d.routines ?? []); setError(''); })
      .catch((e) => { setRoutines(null); setError(String(e?.message || '') || t('routines.loadFail')); });
    api(`/api/companies/${ws}`).then((d) => setAgents(d.agents)).catch(() => {});
  }
  useEffect(load, [ws]);

  function openForm(tpl) {
    setForm({
      id: null, // null = 생성, 값 있으면 수정 모드
      agentSlug: agents[0]?.slug ?? '',
      title: tpl?.title ?? '',
      prompt: tpl?.prompt ?? '',
      type: tpl?.schedule?.type ?? 'daily',
      times: tpl?.schedule?.times ?? [tpl?.schedule?.time ?? '09:00'],
      dows: tpl?.schedule?.dows ?? [tpl?.schedule?.dow ?? 1],
    });
  }

  // 기존 루틴을 같은 폼으로 편집 — 저장은 PUT(서버가 편집 가능 필드만 화이트리스트 검증)
  function openEdit(r) {
    setForm({
      id: r.id,
      agentSlug: r.agentSlug,
      title: r.title,
      prompt: r.prompt,
      type: r.schedule?.type ?? 'daily',
      times: r.schedule?.times ?? [r.schedule?.time ?? '09:00'],
      dows: r.schedule?.dows ?? [r.schedule?.dow ?? 1],
    });
  }

  async function submitForm(e) {
    e.preventDefault();
    if (saving || !form) return;
    setSaving(true); setError('');
    try {
      const body = {
        agentSlug: form.agentSlug, title: form.title, prompt: form.prompt,
        schedule: { type: form.type, times: form.times, dows: form.dows.map(Number) },
      };
      if (form.id) {
        const res = await fetch(`/api/companies/${ws}/routines`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: form.id, ...body }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || t('routines.saveFail'));
      } else {
        await api(`/api/companies/${ws}/routines`, body);
      }
      setForm(null);
      load();
    } catch (err) {
      setError(String(err.message));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r) {
    await fetch(`/api/companies/${ws}/routines`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: r.id, enabled: !r.enabled }),
    });
    load();
  }

  function remove(r) { setDelTarget(r); } // window.confirm(Tauri 무동작) 대신 인앱 ConfirmModal
  async function doRemove() {
    const r = delTarget;
    if (!r) return;
    setDelTarget(null); // 모달을 await 전에 닫아 확인 버튼 더블클릭(이중 DELETE) 차단
    await fetch(`/api/companies/${ws}/routines?id=${r.id}`, { method: 'DELETE' });
    load();
  }

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {delTarget && (
        <ConfirmModal
          title={t('routines.deleteTitle')}
          description={t('routines.deleteConfirm', { title: delTarget.title })}
          confirmLabel={t('common.delete')}
          tone="danger"
          onConfirm={doRemove}
          onClose={() => setDelTarget(null)}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">{t('routines.header')}</span>
        <button className="btn sm" onClick={() => openForm()}>
          <Icon name="plus" size={13} /> {t('routines.createDirect')}
        </button>
      </div>

      {/* 템플릿 — 원클릭 생성 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        {TEMPLATES.map((tpl) => (
          <button key={tpl.title} className="card card-i" style={{ padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6 }} onClick={() => openForm(tpl)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{tpl.title}</span>
              <span className="chip">{scheduleLabel(tpl.schedule, t, DOW)}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{tpl.prompt.slice(0, 64)}…</span>
            <span className="microlabel" style={{ marginTop: 4 }}>{t('routines.oneClick')}</span>
          </button>
        ))}
      </div>

      {/* 생성 폼 */}
      {form && (
        <form onSubmit={submitForm} className="card fade-up" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="card-title">{form.id ? t('routines.editTitle') : t('routines.createTitle')}</span>
            <button type="button" className="btn sm" onClick={() => setForm(null)}>{t('routines.close')}</button>
          </div>
          {/* 자연어 → 자동 설정 — 말로 쓰면 러너가 주기·시각·지시로 해석해 아래 폼을 채운다(저장 전 수정 가능) */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--card-2)', border: '1px dashed var(--border)', borderRadius: 12, padding: '10px 12px' }}>
            <textarea
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              placeholder={t('routines.nlPlaceholder')}
              rows={2}
              style={{ flex: 1, resize: 'vertical', background: 'transparent', border: 0, outline: 'none', fontSize: 12.5, lineHeight: 1.6, minHeight: 38, color: 'var(--fg)' }}
            />
            <button type="button" className="btn sm" disabled={nlBusy || !nlText.trim()} onClick={applyNl} style={{ flex: 'none' }}>
              {nlBusy ? <><Spinner size={11} /> {t('routines.nlParsing')}</> : <><Icon name="bolt" size={12} /> {t('routines.nlApply')}</>}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">{t('routines.crew')}</span>
              <select value={form.agentSlug} onChange={(e) => setForm({ ...form, agentSlug: e.target.value })} style={selStyle}>
                {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} — {a.role}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">{t('routines.cycle')}</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={selStyle}>
                <option value="daily">{t('routines.daily')}</option>
                <option value="weekly">{t('routines.weekly')}</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 180 }}>
              <span className="microlabel">{t('routines.title')}</span>
              <input suppressHydrationWarning value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('routines.titlePlaceholder')} style={selStyle} {...imeGuard} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {form.type === 'weekly' && (
              <div style={{ display: 'grid', gap: 4 }}>
                <span className="microlabel">{t('routines.day')}</span>
                {/* 요일 복수 선택 — 토글 칩. 최소 1개는 남긴다(저장 버튼 가드와 이중 방어) */}
                <div style={{ display: 'flex', gap: 4 }} role="group" aria-label={t('routines.day')}>
                  {DOW.map((d, i) => {
                    const on = form.dows.map(Number).includes(i);
                    return (
                      <button key={i} type="button" aria-pressed={on}
                        onClick={() => setForm((f) => {
                          const cur = new Set(f.dows.map(Number));
                          cur.has(i) ? cur.delete(i) : cur.add(i);
                          return { ...f, dows: [...cur].sort((a, b) => a - b) };
                        })}
                        className="chip"
                        style={{ cursor: 'pointer', minWidth: 34, justifyContent: 'center', ...(on ? { color: 'var(--primary-strong)', borderColor: 'var(--primary)', fontWeight: 700 } : { color: 'var(--fg-3)' }) }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">{t('routines.time')}</span>
              {/* 시각 복수 — 칩 목록 + 추가. 1개 남으면 삭제 버튼을 감춰 빈 스케줄을 막는다 */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {form.times.map((tm) => (
                  <span key={tm} className="chip mono" style={{ gap: 6 }}>
                    {tm}
                    {form.times.length > 1 && (
                      <button type="button" aria-label={`${tm} ${t('common.delete')}`}
                        onClick={() => setForm((f) => ({ ...f, times: f.times.filter((x) => x !== tm) }))}
                        style={{ border: 0, background: 'none', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 11, padding: 0 }}>✕</button>
                    )}
                  </span>
                ))}
                <input suppressHydrationWarning type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ ...selStyle, height: 28 }} />
                <button type="button" className="btn sm" disabled={form.times.length >= 8}
                  onClick={() => { if (/^\d{2}:\d{2}$/.test(newTime) && !form.times.includes(newTime)) setForm((f) => ({ ...f, times: [...f.times, newTime].sort() })); }}>
                  <Icon name="plus" size={11} /> {t('routines.addTime')}
                </button>
              </div>
            </div>
          </div>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder={t('routines.promptPlaceholder')}
            style={{ width: '100%', minHeight: 90, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', outline: 'none', fontSize: 13, lineHeight: 1.65 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary sm" disabled={saving || !form.title.trim() || !form.prompt.trim() || !form.agentSlug || form.times.length === 0 || (form.type === 'weekly' && form.dows.length === 0)}>
              {saving ? <Spinner size={12} /> : form.id ? t('routines.saveBtn') : t('routines.createBtn')}
            </button>
            {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
          </div>
        </form>
      )}

      {/* 루틴 표 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="clock" size={14} />{t('routines.registered')}</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{t('routines.active', { n: routines?.filter((r) => r.enabled).length ?? 0 })}</span>
        </div>
        {routines === null ? (
          error
            ? <div style={{ padding: '0 18px 18px', fontSize: 12.5, color: 'var(--danger)' }}>{t('routines.loadFail')}</div>
            : <div style={{ padding: '0 18px 18px' }}><Skeleton h={80} /></div>
        ) : routines.length === 0 ? (
          <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
            {t('routines.empty')}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>{t('routines.colTitle')}</th><th style={{ width: 130 }}>{t('routines.colCrew')}</th><th style={{ width: 120 }}>{t('routines.colSchedule')}</th><th style={{ width: 170 }}>{t('routines.colLastRun')}</th><th style={{ width: 84 }}>{t('routines.colState')}</th><th style={{ width: 164 }} /></tr>
            </thead>
            <tbody>
              {routines.map((r) => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td>
                    <span style={{ fontWeight: 650, display: 'block' }}>{r.title}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--fg-3)', display: 'block', maxWidth: 320, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.prompt}</span>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
                      <Avatar name={nameOf(r.agentSlug)} sm />{nameOf(r.agentSlug)}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{scheduleLabel(r.schedule, t, DOW)}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                    {r.lastRun ? (
                      <span title={r.lastResult}>
                        {timeAgo(r.lastRun, lang)} {r.lastOk === false ? <span style={{ color: 'var(--danger)' }}>{t('routines.fail')}</span> : t('routines.success')}
                      </span>
                    ) : <span style={{ color: 'var(--fg-3)' }}>—</span>}
                  </td>
                  <td>
                    <button className={`pill${r.enabled ? ' ok' : ''}`} onClick={() => toggle(r)} style={{ cursor: 'pointer' }}>
                      <span className="dot" />{r.enabled ? t('routines.on') : t('routines.off')}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="btn sm" onClick={() => setRunTarget(r)}><Icon name="play" size={12} /> {t('routines.run')}</button>
                      <button className="btn sm btn-icon" style={{ width: 28 }} onClick={() => openEdit(r)} aria-label={t('routines.editAria')}><Icon name="edit" size={13} /></button>
                      <button className="btn sm btn-icon" style={{ width: 28 }} onClick={() => remove(r)} aria-label={t('routines.deleteAria')}><Icon name="trash" size={13} /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {runTarget && (
        <RunPopup ws={ws} routine={runTarget} crewName={nameOf(runTarget.agentSlug)} onClose={() => { setRunTarget(null); load(); }} />
      )}
    </div>
  );
}

const selStyle = {
  height: 34, padding: '0 10px', background: 'var(--card-2)',
  border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13, color: 'var(--fg)',
};

/** 실행 팝업 — 예약 정보 확인 + 즉시 실행. */
function RunPopup({ ws, routine, crewName, onClose }) {
  const { t, lang } = useLang();
  useScrollLock();
  const DOW = [t('routines.dow.sun'), t('routines.dow.mon'), t('routines.dow.tue'), t('routines.dow.wed'), t('routines.dow.thu'), t('routines.dow.fri'), t('routines.dow.sat')];
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  async function runNow() {
    setRunning(true); setError('');
    try {
      const r = await api(`/api/companies/${ws}/routines/run`, { id: routine.id });
      setResult(r.reply);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={running ? undefined : onClose}>
      <div className="card fade-up" style={{ width: 'min(560px, 100%)', maxHeight: '80vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title"><Icon name="play" size={13} />{routine.title}</span>
          <button className="btn sm" onClick={onClose} disabled={running}>{t('routines.close')}</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip"><span className="dot" />{crewName}</span>
            <span className="chip">{t('routines.scheduled', { s: scheduleLabel(routine.schedule, t, DOW) })}</span>
            {routine.lastRun && <span className="chip">{t('routines.last', { t: timeAgo(routine.lastRun, lang) })}</span>}
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', background: 'var(--card-2)', borderRadius: 10, padding: '10px 14px' }}>{routine.prompt}</p>
          {!result && (
            <button className="btn btn-primary" onClick={runNow} disabled={running} style={{ justifySelf: 'start' }}>
              {running ? <><Spinner /> {t('routines.running')}</> : t('routines.runNow')}
            </button>
          )}
          {error && <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>}
          {result && (
            <div className="card" style={{ background: 'var(--card-2)', padding: '12px 16px' }}>
              <div className="microlabel" style={{ marginBottom: 6 }}>{t('routines.resultTitle')}</div>
              <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.65, maxHeight: 240, overflowY: 'auto' }}>{result}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
