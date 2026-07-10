'use client';
// 루틴 — 크루에게 반복 지시를 예약하고, 원클릭으로 즉시 실행한다.
// 템플릿 원클릭 생성 → 폼 프리필. 실행 결과는 vault 기억으로 남는다.
import { use, useEffect, useState } from 'react';
import { Icon, Avatar, Spinner, Skeleton, api, imeGuard, timeAgo } from '../../../ui';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const TEMPLATES = [
  { title: '매일 아침 브리핑', prompt: '회사 기억(vault)을 훑고, 오늘 우리가 신경 써야 할 것 3가지를 근거 기록과 함께 브리핑해줘.', schedule: { type: 'daily', time: '09:00' } },
  { title: '주간 콘텐츠 초안', prompt: '이번 주에 낼 콘텐츠(뉴스레터/블로그) 초안 아웃라인을 회사 기억의 톤에 맞춰 잡아줘.', schedule: { type: 'weekly', time: '10:00', dow: 1 } },
  { title: '기억 정리 노트', prompt: '최근 기억을 훑고 재사용 가치가 있는 인사이트를 vault/notes/에 지식 노트로 정리해줘.', schedule: { type: 'daily', time: '18:00' } },
];

function scheduleLabel(s) {
  return s.type === 'weekly' ? `매주 ${DOW[s.dow ?? 1]} ${s.time}` : `매일 ${s.time}`;
}

export default function Routines({ params }) {
  const { ws } = use(params);
  const [routines, setRoutines] = useState(null);
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState(null); // {agentSlug,title,prompt,type,time,dow}
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [runTarget, setRunTarget] = useState(null); // 실행 팝업 대상 루틴

  function load() {
    api(`/api/companies/${ws}/routines`).then((d) => setRoutines(d.routines)).catch(() => setRoutines([]));
    api(`/api/companies/${ws}`).then((d) => setAgents(d.agents)).catch(() => {});
  }
  useEffect(load, [ws]);

  function openForm(tpl) {
    setForm({
      agentSlug: agents[0]?.slug ?? '',
      title: tpl?.title ?? '',
      prompt: tpl?.prompt ?? '',
      type: tpl?.schedule?.type ?? 'daily',
      time: tpl?.schedule?.time ?? '09:00',
      dow: tpl?.schedule?.dow ?? 1,
    });
  }

  async function create(e) {
    e.preventDefault();
    if (saving || !form) return;
    setSaving(true); setError('');
    try {
      await api(`/api/companies/${ws}/routines`, {
        agentSlug: form.agentSlug, title: form.title, prompt: form.prompt,
        schedule: { type: form.type, time: form.time, dow: Number(form.dow) },
      });
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

  async function remove(r) {
    if (!window.confirm(`루틴 "${r.title}"을 삭제할까요?`)) return;
    await fetch(`/api/companies/${ws}/routines?id=${r.id}`, { method: 'DELETE' });
    load();
  }

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">Routines · 크루의 반복 항해 — 예약 시각에 자동 실행</span>
        <button className="btn sm" onClick={() => openForm()}>
          <Icon name="plus" size={13} /> 직접 만들기
        </button>
      </div>

      {/* 템플릿 — 원클릭 생성 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        {TEMPLATES.map((t) => (
          <button key={t.title} className="card card-i" style={{ padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6 }} onClick={() => openForm(t)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{t.title}</span>
              <span className="chip">{scheduleLabel(t.schedule)}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{t.prompt.slice(0, 64)}…</span>
            <span className="microlabel" style={{ marginTop: 4 }}>+ 원클릭 생성</span>
          </button>
        ))}
      </div>

      {/* 생성 폼 */}
      {form && (
        <form onSubmit={create} className="card fade-up" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="card-title">루틴 만들기</span>
            <button type="button" className="btn sm" onClick={() => setForm(null)}>닫기</button>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">Crew</span>
              <select value={form.agentSlug} onChange={(e) => setForm({ ...form, agentSlug: e.target.value })} style={selStyle}>
                {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} — {a.role}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">Cycle</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={selStyle}>
                <option value="daily">매일</option>
                <option value="weekly">매주</option>
              </select>
            </label>
            {form.type === 'weekly' && (
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="microlabel">Day</span>
                <select value={form.dow} onChange={(e) => setForm({ ...form, dow: e.target.value })} style={selStyle}>
                  {DOW.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
                </select>
              </label>
            )}
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="microlabel">Time</span>
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} style={selStyle} />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 180 }}>
              <span className="microlabel">Title</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="루틴 이름" style={selStyle} {...imeGuard} />
            </label>
          </div>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="크루에게 반복 지시할 내용"
            style={{ width: '100%', minHeight: 90, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', outline: 'none', fontSize: 13, lineHeight: 1.65 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary sm" disabled={saving || !form.title.trim() || !form.prompt.trim() || !form.agentSlug}>
              {saving ? <Spinner size={12} /> : '루틴 생성'}
            </button>
            {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
          </div>
        </form>
      )}

      {/* 루틴 표 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="clock" size={14} />등록된 루틴</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{routines?.filter((r) => r.enabled).length ?? 0} 가동</span>
        </div>
        {routines === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={80} /></div>
        ) : routines.length === 0 ? (
          <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
            아직 루틴이 없습니다. 위 템플릿을 눌러 하나 만들어보세요.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Title</th><th style={{ width: 130 }}>Crew</th><th style={{ width: 120 }}>Schedule</th><th style={{ width: 170 }}>Last Run</th><th style={{ width: 84 }}>State</th><th style={{ width: 130 }} /></tr>
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
                  <td className="mono" style={{ fontSize: 11.5 }}>{scheduleLabel(r.schedule)}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                    {r.lastRun ? (
                      <span title={r.lastResult}>
                        {timeAgo(r.lastRun)} {r.lastOk === false ? <span style={{ color: 'var(--danger)' }}>실패</span> : '성공'}
                      </span>
                    ) : <span style={{ color: 'var(--fg-3)' }}>—</span>}
                  </td>
                  <td>
                    <button className={`pill${r.enabled ? ' ok' : ''}`} onClick={() => toggle(r)} style={{ cursor: 'pointer' }}>
                      <span className="dot" />{r.enabled ? '가동' : '정지'}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="btn sm" onClick={() => setRunTarget(r)}><Icon name="play" size={12} /> 실행</button>
                      <button className="btn sm btn-icon" style={{ width: 28 }} onClick={() => remove(r)} aria-label="삭제"><Icon name="trash" size={13} /></button>
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(37,39,30,0.25)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={running ? undefined : onClose}>
      <div className="card fade-up" style={{ width: 'min(560px, 100%)', maxHeight: '80vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title"><Icon name="play" size={13} />{routine.title}</span>
          <button className="btn sm" onClick={onClose} disabled={running}>닫기</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip"><span className="dot" />{crewName}</span>
            <span className="chip">예약 {scheduleLabel(routine.schedule)}</span>
            {routine.lastRun && <span className="chip">마지막 {timeAgo(routine.lastRun)}</span>}
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', background: 'var(--card-2)', borderRadius: 10, padding: '10px 14px' }}>{routine.prompt}</p>
          {!result && (
            <button className="btn btn-primary" onClick={runNow} disabled={running} style={{ justifySelf: 'start' }}>
              {running ? <><Spinner /> 실행 중 — 결과는 기억에도 남습니다</> : '지금 즉시 실행'}
            </button>
          )}
          {error && <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>}
          {result && (
            <div className="card" style={{ background: 'var(--card-2)', padding: '12px 16px' }}>
              <div className="microlabel" style={{ marginBottom: 6 }}>Result · 기억에 기록됨</div>
              <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.65, maxHeight: 240, overflowY: 'auto' }}>{result}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
