// 폰(iOS·Android) 인앱 업데이트 안내 — 데스크톱 update.jsx와는 별도 표면(모바일 간섭 0 원칙, 2026-09-03 지시).
// 새 버전 판정 출처는 둘 다 GitHub 릴리스 메타(beyondworks/argo-messenger releases/latest) 하나 — Supabase 쓰기 0, 확인은 GitHub 호출만.
// 확인 시점: 시작·포그라운드 복귀·포그라운드 유지 중 30분 주기(update-schedule.mjs, 백그라운드 중엔 확인 안 함).
// Android: 앱이 APK를 직접 받아 설치 화면을 띄운다(같은 서명 겹쳐쓰기 = 데이터·로그인 유지) — 네이티브 plugin:apk-installer.
// iOS: TestFlight 앱을 열도록 안내만(스토어 심사 밖에서 앱이 스스로를 설치할 수 없다).
import { useEffect, useRef, useState } from 'react';

import { isMobileNative } from './platform.js';
import { observeMobileResume } from './mobile-lifecycle.mjs';
import { pushDiag } from './diag.jsx';
import { parseGithubRelease, pickAndroidAsset, isNewer } from './update-release.mjs';
import { shouldCheckMobile, shouldShowVersion } from './update-schedule.mjs';

const RELEASE_API = 'https://api.github.com/repos/beyondworks/argo-messenger/releases/latest';
const IOS_TESTFLIGHT_URL = 'itms-beta://'; // 앱 ID 없이도 TestFlight 앱 자체를 연다(설치된 빌드가 이미 TestFlight로 받은 것이므로 존재 보장)

async function currentVersion() {
  return (await import('@tauri-apps/api/app')).getVersion();
}

export function useMobileUpdate() {
  const [st, setSt] = useState({ phase: 'idle', version: '', error: '', progress: 0 }); // idle|available|downloading|permission|error
  const ref = useRef({ lastCheckAt: null, dismissedVersion: null, phase: 'idle', busy: false, release: null });

  useEffect(() => {
    if (!isMobileNative) return undefined;
    let alive = true;
    const check = async (reason) => {
      const r = ref.current;
      const foreground = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true;
      if (r.busy || r.phase !== 'idle' || !shouldCheckMobile({ reason, foreground, now: Date.now(), lastCheckAt: r.lastCheckAt })) return;
      r.busy = true;
      try {
        const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`github ${res.status}`);
        const parsed = parseGithubRelease(await res.json());
        r.lastCheckAt = Date.now();
        if (!alive || !parsed) return;
        const cur = await currentVersion();
        if (isNewer(parsed.version, cur) && shouldShowVersion(parsed.version, r.dismissedVersion)) {
          r.phase = 'available'; r.release = parsed;
          setSt({ phase: 'available', version: parsed.version, error: '', progress: 0 });
        }
      } catch (e) {
        r.lastCheckAt = Date.now();
        pushDiag('mobile-update-check', String(e?.message ?? e)); // 침묵 금지(진단에만) — 실패마다 막대를 띄우면 오프라인 중 방해
      } finally { r.busy = false; }
    };
    check('start');
    const stopResume = observeMobileResume(() => check('foreground'));
    const timer = setInterval(() => check('interval'), 5 * 60 * 1000); // shouldCheckMobile이 실제 30분 간격을 강제
    return () => { alive = false; stopResume(); clearInterval(timer); };
  }, []);

  const dismiss = () => {
    if (st.phase === 'available' && st.version) ref.current.dismissedVersion = st.version;
    ref.current.phase = 'idle';
    setSt({ phase: 'idle', version: '', error: '', progress: 0 });
  };

  const openTestFlight = async () => {
    try { await (await import('@tauri-apps/plugin-opener')).openUrl(IOS_TESTFLIGHT_URL); }
    catch (e) { setSt((s) => ({ ...s, phase: 'error', error: String(e?.message ?? e) })); }
  };

  const downloadAndInstall = async () => {
    const asset = pickAndroidAsset(ref.current.release?.assets);
    if (!asset) { ref.current.phase = 'error'; setSt((s) => ({ ...s, phase: 'error', error: 'no-apk-asset' })); return; }
    ref.current.phase = 'downloading';
    setSt((s) => ({ ...s, phase: 'downloading', progress: 0 }));
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const onEvent = new Channel();
      onEvent.onmessage = (e) => { if (typeof e?.progress === 'number') setSt((s) => (s.phase === 'downloading' ? { ...s, progress: e.progress } : s)); };
      await invoke('plugin:apk-installer|download_and_install', { url: asset.url, sha256: asset.sha256, onEvent });
      // 설치 화면이 뜬 뒤에는 앱이 백그라운드로 갈 수 있다 — 막대를 접어 둔다(재개해도 같은 버전이라 다시 안 뜬다)
      ref.current.phase = 'idle';
      setSt({ phase: 'idle', version: '', error: '', progress: 0 });
    } catch (e) {
      const message = String(e?.message ?? e);
      if (/PERMISSION_REQUIRED/.test(message)) { ref.current.phase = 'permission'; setSt((s) => ({ ...s, phase: 'permission', error: message })); }
      else { ref.current.phase = 'error'; setSt((s) => ({ ...s, phase: 'error', error: message })); }
    }
  };

  const openInstallSettings = async () => {
    try { const { invoke } = await import('@tauri-apps/api/core'); await invoke('plugin:apk-installer|open_unknown_sources_settings'); }
    catch (e) { setSt((s) => ({ ...s, phase: 'error', error: String(e?.message ?? e) })); }
  };

  const retry = () => { ref.current.phase = 'available'; setSt((s) => ({ ...s, phase: 'available', error: '' })); };

  return { ...st, dismiss, openTestFlight, downloadAndInstall, openInstallSettings, retry };
}

export function MobileUpdateBar({ t }) {
  const u = useMobileUpdate();
  if (!isMobileNative || u.phase === 'idle') return null;
  const isIos = import.meta.env.TAURI_ENV_PLATFORM === 'ios';
  return (
    <div className="msgr-updbar" role="status">
      {u.phase === 'available' && (
        <>
          <span>{t('upd.available', { v: u.version })}</span>
          {isIos
            ? <button type="button" className="btn sm btn-primary" onClick={u.openTestFlight}>{t('upd.mobile.testflight')}</button>
            : <button type="button" className="btn sm btn-primary" onClick={u.downloadAndInstall}>{t('upd.mobile.get')}</button>}
          <button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button>
        </>
      )}
      {u.phase === 'downloading' && <span>{t('upd.mobile.downloading', { pct: Math.round((u.progress ?? 0) * 100) })}</span>}
      {u.phase === 'permission' && (
        <>
          <span>{t('upd.mobile.permission')}</span>
          <button type="button" className="btn sm btn-primary" onClick={u.openInstallSettings}>{t('upd.mobile.openSettings')}</button>
          <button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button>
        </>
      )}
      {u.phase === 'error' && (
        <>
          <span style={{ color: 'var(--danger)' }}>{t('upd.error')} {u.error}</span>
          <button type="button" className="btn sm ghost" onClick={u.retry}>{t('upd.mobile.retry')}</button>
          <button type="button" className="btn sm ghost" onClick={u.dismiss}>{t('upd.later')}</button>
        </>
      )}
    </div>
  );
}
