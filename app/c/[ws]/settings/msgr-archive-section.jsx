'use client';
// 설정 '메신저 연결' 카드 안의 메신저 기록 옮기기 영역(0.1.113) — 진행률·완료(위치)·실패와 다시 받기. 판정은 msgr-archive-view.mjs.
// 조회: 화면을 열 때 한 번(서버가 중단 스위치를 10분에 한 번만 읽는다) + 받는 중일 때만 2초마다 로컬 상태 파일. 주기 호출은 없다.
import { useCallback, useEffect, useState } from 'react';
import { useLang } from '../../../i18n';
import { Spinner, api, isTauriApp } from '../../../ui';
import { archiveView, archiveLabelKey } from './msgr-archive-view.mjs';

export default function MsgrArchiveSection({ ws, onState }) {
  const { t } = useLang();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => api(`/api/companies/${ws}/msgr-archive`).then((d) => { setSt(d); onState?.(d); }).catch(() => {}), [ws, onState]);
  useEffect(() => { load(); }, [load]);
  const view = archiveView(st);
  useEffect(() => {
    if (!view.polling) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [view.polling, load]);
  if (!view.show) return null;
  async function start() {
    if (busy) return;
    setBusy(true); setErr('');
    try { const d = await api(`/api/companies/${ws}/msgr-archive`, { action: 'start' }); setSt((s) => ({ ...s, ...d })); }
    catch { setErr(t('settings.msgrArchive.err')); }
    finally { setBusy(false); }
  }
  async function openFolder() {
    if (!st?.dir) return;
    await import('@tauri-apps/plugin-opener').then((m) => m.revealItemInDir(`${st.dir}/README.md`)).catch(() => {});
  }
  const p = view.progress;
  return (
    <section className="msgr-runtime" aria-live="polite" style={{ display: 'grid', gap: 6 }}>
      <span className="microlabel">{t('settings.msgrArchive.title')}</span>
      <p style={{ margin: 0 }}>{t(archiveLabelKey(view.phase), p)}</p>
      {view.phase === 'running' && <Spinner size={12} />}
      {st?.dir && (view.phase === 'done' || view.phase === 'partial') && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-2)' }}>{t('settings.msgrArchive.where')} <span className="mono" style={{ overflowWrap: 'anywhere', color: 'var(--fg-1)' }}>{st.dir}</span></p>
      )}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)' }}>{t('settings.msgrArchive.private')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {view.retry && (
          <button type="button" className="btn sm" disabled={busy} onClick={start}>{busy ? <Spinner size={12} /> : t(view.phase === 'none' ? 'settings.msgrArchive.start' : 'settings.msgrArchive.retry')}</button>
        )}
        {st?.dir && isTauriApp() && (view.phase === 'done' || view.phase === 'partial') && (
          <button type="button" className="btn sm" onClick={openFolder}>{t('settings.msgrArchive.open')}</button>
        )}
      </div>
      {err && <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>{err}</p>}
    </section>
  );
}
