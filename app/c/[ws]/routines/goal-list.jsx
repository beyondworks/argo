'use client';
// 루틴 화면 "내 하트비트 → 목표 하트비트" — 목표 하트비트 목록(목표·상태·다음 확인·기한·최근 메모)과 일시 정지·다시 켜기·끄기.
// 만들기는 에이전트가 한다(대화에서 goal_heartbeat) — 이 화면에는 만들기 칸이 없다. 엔진: src/goal-heartbeat.mjs, API: /api/companies/[ws]/goals.
import { useEffect, useState } from 'react';
import { Icon, Skeleton, ConfirmModal, api, timeAgo } from '../../../ui';
import { useLang } from '../../../i18n';

const ENDED = ['done', 'blocked', 'expired', 'failed', 'stopped'];
const fmt = (iso, lang, tz) => {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '—';
  try { return d.toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR', { ...(tz ? { timeZone: tz } : {}), month: lang === 'en' ? 'short' : 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return d.toLocaleString(); }
};

export default function GoalList({ ws, nameOf = (s) => s }) {
  const { t, lang } = useLang();
  const [goals, setGoals] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [stopTarget, setStopTarget] = useState(null);
  const [showEnded, setShowEnded] = useState(false);

  function load() {
    api(`/api/companies/${ws}/goals`).then((d) => { setGoals(d.goals ?? []); setError(''); }).catch((e) => { setGoals(null); setError(String(e?.message || '') || t('goals.loadFail')); });
  }
  useEffect(load, [ws]);

  async function act(g, op) {
    if (busy) return;
    setBusy(g.id); setError('');
    try { const d = await api(`/api/companies/${ws}/goals`, { id: g.id, op }); setGoals(d.goals ?? []); }
    catch (e) { setError(String(e?.message || '') || t('goals.actFail')); }
    finally { setBusy(''); setStopTarget(null); }
  }

  const live = (goals ?? []).filter((g) => !ENDED.includes(g.view));
  const ended = (goals ?? []).filter((g) => ENDED.includes(g.view)).sort((a, b) => Date.parse(b.endedAt ?? 0) - Date.parse(a.endedAt ?? 0));
  const chip = (v) => {
    const color = v === 'active' ? 'var(--primary-strong)' : v === 'done' ? 'var(--ok, var(--fg-2))' : ['blocked', 'failed'].includes(v) ? 'var(--danger)' : 'var(--fg-3)';
    return <span className="chip" style={{ color, borderColor: color, textTransform: 'none', fontSize: 10.5, padding: '0 7px', minHeight: 20 }}>{t(`goals.view.${v}`)}</span>;
  };
  const row = (g) => (
    <li key={g.id} data-goal={g.id} style={{ display: 'grid', gap: 4, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontWeight: 650, fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{g.title}</span>
        {chip(g.view)}
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{nameOf(g.agentSlug)}</span>
        <span style={{ flex: 1 }} />
        {g.view === 'active' && <button className="btn sm" disabled={!!busy} onClick={() => act(g, 'pause')}>{t('goals.pause')}</button>}
        {g.view === 'paused' && <button className="btn sm" disabled={!!busy} onClick={() => act(g, 'resume')}>{t('goals.resume')}</button>}
        {(g.view === 'active' || g.view === 'paused') && <button className="btn sm" disabled={!!busy} onClick={() => setStopTarget(g)}>{t('goals.stop')}</button>}
      </div>
      <span style={{ fontSize: 12, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{g.goal}</span>
      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', overflowWrap: 'anywhere' }}>{t('goals.doneWhen', { v: g.doneWhen })}</span>
      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {g.view === 'active' && <span>{t('goals.next', { v: fmt(g.nextAt, lang, g.tz) })}</span>}
        <span>{ENDED.includes(g.view) && g.endedAt ? t('goals.ended', { v: fmt(g.endedAt, lang, g.tz) }) : t('goals.deadline', { v: fmt(g.deadline, lang, g.tz) })}</span>
        <span>{t('goals.every', { n: g.everyMinutes })}</span>
        <span>{t('goals.runs', { n: g.runs })}</span>
        {g.lastRun && <span>{t('goals.last', { v: timeAgo(g.lastRun, lang) })}</span>}
      </span>
      {(g.result || g.note) && (
        <span style={{ fontSize: 12, color: 'var(--fg-2)', background: 'var(--card-2)', borderRadius: 8, padding: '6px 10px', overflowWrap: 'anywhere' }}>
          {g.result ? t('goals.result', { v: g.result }) : t('goals.note', { v: g.note.text })}
        </span>
      )}
    </li>
  );

  return (
    <div className="card" data-testid="goal-list" style={{ minWidth: 0 }}>
      {stopTarget && (
        <ConfirmModal title={t('goals.stopTitle')} description={t('goals.stopConfirm', { title: stopTarget.title })} confirmLabel={t('goals.stop')} tone="danger"
          busy={busy === stopTarget.id} onConfirm={() => act(stopTarget, 'stop')} onClose={() => setStopTarget(null)} />
      )}
      <div className="card-head" style={{ flexWrap: 'wrap', rowGap: 6 }}>{/* 위 '내 하트비트' 칸(heartbeat-card.jsx)과 같은 머리 모양 */}
        <span className="card-title"><Icon name="check" size={14} />{t('goals.title')}</span>
        <span className="chip" style={{ textTransform: 'none', fontSize: 10.5, minHeight: 20 }}>{t('goals.chip')}</span>
        <span className="rule" />
        <span className="pill"><span className="dot" />{t('goals.liveCount', { n: live.filter((g) => g.view === 'active').length })}</span>
      </div>
      <div style={{ padding: '0 20px 18px' }}>
        <p style={{ margin: '0 0 6px', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>{t('goals.hint')}</p>
        {error && <p role="alert" style={{ margin: '4px 0', fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>}
        {goals === null ? (!error && <Skeleton h={48} />)
          : !live.length && !ended.length ? <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--fg-3)' }}>{t('goals.empty')}</p>
            : (
              <>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{live.map(row)}</ul>
                {ended.length > 0 && (
                  <>
                    <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setShowEnded((v) => !v)} aria-expanded={showEnded}>
                      {t(showEnded ? 'goals.hideEnded' : 'goals.showEnded', { n: ended.length })}
                    </button>
                    {showEnded && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{ended.map(row)}</ul>}
                  </>
                )}
              </>
            )}
      </div>
    </div>
  );
}
