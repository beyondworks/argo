'use client';
// 크루 신원 수정 모달 — 이름·역할·팀·러너·모델. 데크 크루 목록을 없애면서(유건 2026-08-21: "영입하면 왼쪽 목록에
// 생기니 데크 목록은 불필요, 편집은 각 크루 대화창의 '카드'에서") 대화창 카드 패널이 이 모달을 연다.
import { useEffect, useState } from 'react';
import { Spinner, useScrollLock, api, imeGuard } from '../../ui';
import { useLang } from '../../i18n';

/** 크루 신원 수정 — 이름·역할·팀. 슬러그·기록은 유지된다. */
export function CrewEditModal({ ws, agent, teams: teamsProp = null, onClose, onSaved }) {
  const { t } = useLang();
  useScrollLock();
  // runner '' = 미지정(자동) — 'claude' 기본값을 박으면 저장 시 자동 크루가 클로드 고정으로 둔갑한다(러너 오표시 계열)
  const [form, setForm] = useState({ name: agent.name, role: agent.role, team: agent.team || '', model: agent.model || '', runner: agent.runner || '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // 러너 카탈로그 + 로컬 인증 상태 — Claude Code 외에는 각 CLI의 OAuth 로그인(구독)을 빌린다
  const [runners, setRunners] = useState(null);
  useEffect(() => { api(`/api/runners?ws=${ws}`).then((d) => setRunners(d.runners)).catch(() => setRunners([])); }, [ws]);
  // 팀 자동완성 — 호출부가 안 넘기면 회사에서 직접 모은다(크루 대화창의 카드 패널은 크루 목록을 안 들고 있다)
  const [teamsFetched, setTeamsFetched] = useState([]);
  useEffect(() => {
    if (teamsProp) return;
    api(`/api/companies/${ws}?light=1`).then((d) => setTeamsFetched([...new Set((d.agents ?? []).map((x) => x.team).filter(Boolean))])).catch(() => {});
  }, [ws, teamsProp]);
  const teams = teamsProp ?? teamsFetched;
  const curRunner = runners?.find((r) => r.id === form.runner);
  const runnerLabel = (r) => r.name + (r.hidden ? ` — ${t('runner.retired')}` : r.authed ? '' : r.installed ? ` — ${t('runner.needLogin')}` : ` — ${t('runner.notInstalled')}`);
  // 숨김 러너(gemini)는 선택지에서 뺀다 — 현재 값일 때만 남겨 정직 표기(분리 검수 HIGH-2: 빠지면 브라우저가 첫 옵션 '자동'을 골라 오표시)
  const pickable = (runners ?? []).filter((r) => !r.hidden || r.id === form.runner);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(e) {
    e.preventDefault();
    if (saving || !form.name.trim()) return;
    setSaving(true); setErr('');
    try {
      const res = await fetch(`/api/companies/${ws}/agents/${agent.slug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onSaved();
    } catch (e2) {
      setErr(String(e2.message));
      setSaving(false);
    }
  }

  const field = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <form onSubmit={save} className="card fade-up" style={{ width: 'min(440px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{t('deck.editCrewInfo')}</span>
          <span className="microlabel">{agent.slug}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('deck.closeEsc')}</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldName')}</span>
            <input suppressHydrationWarning value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={field} {...imeGuard} autoFocus />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldRole')}</span>
            <input suppressHydrationWarning value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={field} {...imeGuard} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldTeamHint')}</span>
            <input suppressHydrationWarning value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} list="argo-teams-edit" style={field} {...imeGuard} />
            <datalist id="argo-teams-edit">
              {teams.map((tm) => <option key={tm} value={tm} />)}
            </datalist>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldRunnerHint')}</span>
            <select value={form.runner} style={field} disabled={runners === null}
              onChange={(e) => {
                const next = runners?.find((r) => r.id === e.target.value);
                // 러너를 바꾸면 그 러너의 첫 모델을 바로 선택 — "기본" 가짜 항목 없이 항상 실제 모델
                setForm({ ...form, runner: e.target.value, model: next?.models?.[0]?.id ?? '' });
              }}>
              {/* 로딩 폴백으로 가짜 Claude 항목을 만들지 않는다 — select 자체가 disabled(runners === null) */}
              <option value="">{t('runner.autoOption')}</option>
              {pickable.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.authed}>{runnerLabel(r)}</option>
              ))}
            </select>
            {curRunner && !curRunner.authed && (
              <span style={{ fontSize: 11.5, color: 'var(--warn)' }}>{t('runner.authHint', { name: curRunner.name })}</span>
            )}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldModelHint')}</span>
            {/* 현재 러너가 미연결(레거시)이면 모델 선택도 잠금 — 설정에서 연결 후 활성화 */}
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} style={field}
              disabled={curRunner && !curRunner.authed}>
              {!form.model && <option value="" disabled>—</option>}{/* 레거시 미선택 크루 표시용 */}
              {/* 현재 값 예외(분리 검수 HIGH-2): 목록에 없는 저장값(폐기·러너 불일치)을 첫 옵션으로 오표시하지 않고 그대로 보인다 —
                  숨김 러너와 같은 처방. 저장은 통과하고 실행 시 modelFallback 고지가 뜬다. */}
              {form.model && !(curRunner?.models ?? []).some((m) => m.id === form.model) && (
                <option value={form.model}>{form.model} — {t('deck.modelNotInList')}</option>
              )}
              {(curRunner?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label}{m.gated ? ` — ${t('runner.gatedBadge')}` : m.free ? ` — ${t('runner.freeBadge')}` : ''}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary sm" disabled={saving || !form.name.trim()}>
              {saving ? <Spinner size={12} /> : t('deck.save')}
            </button>
            <span className="metric-sub2">{t('deck.saveHint')}</span>
            {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
          </div>
        </div>
      </form>
    </div>
  );
}
