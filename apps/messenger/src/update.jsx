// 인앱 업데이트 — Tauri 데스크톱에서만(브라우저 dev에선 조용히 아무것도 안 한다). Argo 앱 use-app-update.js와 같은 계약:
// 켜질 때, 그리고 켜져 있는 동안 30분마다 + 창이 다시 포커스될 때 latest.json(릴리스 repo)과 대조(유건 결정, 2026-09-24) →
// 있으면 얇은 막대 → 설치 → 재시작. 실패는 막대에 문구로가 아니라 진단(diag)에만 조용히 남긴다 — 확인 실패가 매번 오류
// 막대를 띄우면(예: 기내 모드) 정상 사용을 방해한다. 중복 확인·재확인 판정은 update-schedule.mjs(순수 로직, 테스트로 잠금).
import { useEffect, useRef, useState } from 'react';

import { isDesktopTauri } from './platform.js';
import { pushDiag } from './diag.jsx';
import { shouldCheckDesktop, shouldShowVersion } from './update-schedule.mjs';
import { MOVE_REQUIRED, updateBarView, updateLocationIssue } from './update-location.mjs';
import { openExternalUrl } from './media-io.js';

const RELEASES_URL = 'https://github.com/beyondworks/argo-messenger/releases/latest';

export function useUpdate() {
  const [st, setSt] = useState({ phase: 'idle', version: '', error: '' }); // idle | available | installing | ready | error
  const [loc, setLoc] = useState(null); // 맥 설치 위치 문제 { issue, path } | null(문제 없음·옛 앱이라 모름) — src/update-location.mjs
  const ref = useRef({ lastCheckAt: null, dismissedVersion: null, phase: 'idle', busy: false, upd: null });
  // 확인마다 새로 생기는 Update는 Tauri Resource(백엔드 쪽에 열려 있는 자원)라 안 쓸 게 되면 close()로 정리한다 —
  // 안 그러면 확인이 반복될수록(30분마다) 예전 Update가 계속 열린 채로 쌓인다.
  const closeOld = (next) => { const old = ref.current.upd; if (old && old !== next) old.close?.().catch(() => {}); };
  useEffect(() => {
    if (!isDesktopTauri()) return undefined;
    let alive = true;
    const check = async (reason) => {
      const r = ref.current;
      if (r.busy || !shouldCheckDesktop({ phase: r.phase, now: Date.now(), lastCheckAt: r.lastCheckAt, reason })) return;
      r.busy = true;
      try {
        const upd = await (await import('@tauri-apps/plugin-updater')).check();
        r.lastCheckAt = Date.now();
        if (!alive) { upd?.close?.().catch(() => {}); return; }
        if (upd && shouldShowVersion(upd.version, r.dismissedVersion)) { closeOld(upd); r.phase = 'available'; r.upd = upd; setSt({ phase: 'available', version: upd.version, error: '', upd }); }
        else if (!upd && r.phase !== 'available') { closeOld(null); r.phase = 'idle'; r.upd = null; setSt((s) => (s.phase === 'available' ? s : { phase: 'idle', version: '', error: '' })); }
        else upd?.close?.().catch(() => {}); // 이미 알고 있는 버전 그대로 — 새로 받은 Update는 쓸 데가 없다
      } catch (e) {
        r.lastCheckAt = Date.now();
        // 침묵 금지 — 화면 막대는 매번 띄우지 않되(기내 모드 등 반복 실패로 방해받지 않게), 진단에는 남겨 설정→진단에서 확인 가능하게 한다.
        pushDiag('update-check', String(e?.message ?? e));
      } finally { r.busy = false; }
    };
    // 설치 위치(맥) — 켜질 때 한 번. DMG·다운로드 폴더에서 바로 열었거나 외장 디스크면 업데이트를 저장하지 못한다(고객 문의 2026-10-03·10-04)
    import('@tauri-apps/api/core').then((m) => m.invoke('update_location'))
      .then((facts) => { const issue = updateLocationIssue(facts); if (alive) setLoc(issue ? { issue, path: facts.path } : null); })
      .catch((e) => pushDiag('update-location', String(e?.message ?? e)));
    check('start');
    const onFocus = () => check('focus');
    const onVisibility = () => { if (document.visibilityState === 'visible') check('focus'); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => check('interval'), 5 * 60 * 1000); // 판정(shouldCheckDesktop)이 실제 30분 간격을 강제 — 짧게 돌며 포커스 놓친 시간도 따라잡는다
    return () => { alive = false; window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); clearInterval(timer); };
  }, []);
  const install = async () => {
    if (!st.upd || (loc && MOVE_REQUIRED.has(loc.issue))) return; // 옮기기 전에는 설치가 실패한다 — 막대가 옮기는 방법을 보인다
    ref.current.phase = 'installing';
    setSt((s) => ({ ...s, phase: 'installing' }));
    try { await st.upd.downloadAndInstall(); ref.current.phase = 'ready'; setSt((s) => ({ ...s, phase: 'ready' })); }
    catch (e) { ref.current.phase = 'error'; setSt((s) => ({ ...s, phase: 'error', error: String(e?.message ?? e) })); }
  };
  const relaunch = async () => { await (await import('@tauri-apps/plugin-process')).relaunch(); };
  const dismiss = () => {
    // "나중에" — 이 버전은 이번 실행 동안 다시 띄우지 않는다(다음 주기 확인에서 shouldShowVersion이 걸러냄). 더 새 버전이 나오면 다시 뜬다.
    if (st.phase === 'available' && st.version) ref.current.dismissedVersion = st.version;
    ref.current.upd?.close?.().catch(() => {}); // 더 안 쓸 Update 자원 정리
    ref.current.upd = null;
    ref.current.phase = 'idle';
    setSt({ phase: 'idle', version: '', error: '' });
  };
  return { ...st, issue: loc?.issue ?? null, path: loc?.path ?? null, install, relaunch, dismiss };
}

export function UpdateBar({ t }) {
  const u = useUpdate();
  const v = updateBarView({ phase: u.phase, issue: u.issue, error: u.error });
  if (v.mode === 'hidden') return null;
  return (
    <div className="msgr-updbar" role="status" data-update-mode={v.mode}>
      {v.mode === 'move' && <><span title={u.path || undefined}>{t(`upd.where.${v.reason}`, { v: u.version })}</span><button type="button" className="btn sm btn-primary" onClick={() => openExternalUrl(RELEASES_URL)}>{t('upd.where.download')}</button><button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button></>}
      {v.mode === 'install' && <><span>{t('upd.available', { v: u.version })}{v.reason === 'needs_admin' ? ` ${t('upd.where.needs_admin')}` : ''}</span><button type="button" className="btn sm btn-primary" onClick={u.install}>{t('upd.install')}</button><button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button></>}
      {v.mode === 'installing' && <span>{t('upd.installing')}</span>}
      {v.mode === 'ready' && <><span>{t('upd.ready')}</span><button type="button" className="btn sm btn-primary" onClick={u.relaunch}>{t('upd.restart')}</button></>}
      {v.mode === 'error' && <><span style={{ color: 'var(--danger)' }}>{t('upd.error')} {v.reason ? t(`upd.fail.${v.reason}`) : ''}{u.error && <small className="mono" style={{ display: 'block', color: 'var(--fg-3)', overflowWrap: 'anywhere' }}>{u.error}</small>}</span><button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button></>}
    </div>
  );
}
