// 인앱 업데이트 — Tauri 데스크톱에서만(브라우저 dev에선 조용히 아무것도 안 한다). Argo 앱 use-app-update.js와 같은 계약:
// 켜질 때 한 번 latest.json(릴리스 repo)과 대조 → 있으면 얇은 막대 → 설치 → 재시작. 실패는 막대에 문구로(침묵 금지).
import { useEffect, useState } from 'react';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useUpdate() {
  const [st, setSt] = useState({ phase: 'idle', version: '', error: '' }); // idle | available | installing | ready | error
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    (async () => {
      try {
        const upd = await (await import('@tauri-apps/plugin-updater')).check();
        if (alive && upd) setSt({ phase: 'available', version: upd.version, error: '', upd });
      } catch (e) { if (alive) setSt({ phase: 'error', version: '', error: String(e?.message ?? e) }); }
    })();
    return () => { alive = false; };
  }, []);
  const install = async () => {
    if (!st.upd) return;
    setSt((s) => ({ ...s, phase: 'installing' }));
    try { await st.upd.downloadAndInstall(); setSt((s) => ({ ...s, phase: 'ready' })); }
    catch (e) { setSt((s) => ({ ...s, phase: 'error', error: String(e?.message ?? e) })); }
  };
  const relaunch = async () => { await (await import('@tauri-apps/plugin-process')).relaunch(); };
  const dismiss = () => setSt({ phase: 'idle', version: '', error: '' });
  return { ...st, install, relaunch, dismiss };
}

export function UpdateBar({ t }) {
  const u = useUpdate();
  if (u.phase === 'idle') return null;
  return (
    <div className="msgr-updbar" role="status">
      {u.phase === 'available' && <><span>{t('upd.available', { v: u.version })}</span><button type="button" className="btn sm btn-primary" onClick={u.install}>{t('upd.install')}</button><button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button></>}
      {u.phase === 'installing' && <span>{t('upd.installing')}</span>}
      {u.phase === 'ready' && <><span>{t('upd.ready')}</span><button type="button" className="btn sm btn-primary" onClick={u.relaunch}>{t('upd.restart')}</button></>}
      {u.phase === 'error' && <><span style={{ color: 'var(--danger)' }}>{t('upd.error')} {u.error}</span><button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button></>}
    </div>
  );
}
