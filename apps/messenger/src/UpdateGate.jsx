// 업데이트 필요 전체 화면 — 서버 최소 버전에 걸린 앱은 다른 기능 없이 이 안내와 [업데이트]만 보인다(판정·표지는 update-gate.mjs).
// 셸을 올리지 않으므로 Supabase 주기 요청은 0이다. 켤 때 최소 버전을 한 번만 다시 묻는다(서버가 값을 낮췄으면 onClear로 셸로 돌아간다).
import { useEffect, useState } from 'react';

import { useUpdate } from './update.jsx';
import { openExternalUrl } from './media-io.js';
import { markAppReady } from './splash.js';
import { isDesktopTauri, isIos, isAndroid } from './platform.js';
import { clearUpdateGate, recheckVerdict, updateAction, MSGR_RELEASES_URL } from './update-gate.mjs';

export function UpdateGate({ t, client, appVersion, storage, onClear }) {
  const u = useUpdate();
  const [min, setMin] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { markAppReady(); }, []); // 스플래시 준비 신호 — 셸을 올리지 않으므로 이 화면이 대신 낸다(빠지면 스플래시가 안내를 덮는다)
  useEffect(() => {
    let live = true;
    Promise.resolve(client?.rpc?.('argo_min_app_version', { p_app: 'messenger' })).then((r) => r ?? { error: true }, () => ({ error: true })).then((r) => {
      if (!live) return;
      if (recheckVerdict(r, appVersion) === 'clear') { clearUpdateGate(storage); onClear?.(); return; }
      if (typeof r?.data === 'string') setMin(r.data.trim());
    });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const action = updateAction({ desktop: isDesktopTauri(), ios: isIos, android: isAndroid });
  const busy = u.phase === 'installing';
  const onUpdate = async () => {
    if (u.phase === 'ready') { await u.relaunch(); return; }
    if (action.kind === 'open') { openExternalUrl(action.url); return; }
    if (u.phase !== 'available' || u.issue) { setFailed(true); openExternalUrl(MSGR_RELEASES_URL); return; } // 앱 안 업데이트를 못 찾았거나 옮겨야 하는 위치 — 설치 파일로
    await u.install();
  };
  const showFail = failed || u.phase === 'error';
  return (
    <div className="ap-center" data-update-gate>
      <div className="ap-gate" role="alertdialog" aria-modal="true" aria-labelledby="msgr-update-gate-title">
        <h1 id="msgr-update-gate-title">{t('gate.update.title')}</h1>
        <p>{min ? t('gate.update.body', { v: appVersion, min }) : t('gate.update.bodyNoMin', { v: appVersion })}</p>
        <p className="ap-muted">{t('gate.update.safe')}</p>
        <button type="button" className="btn btn-primary" onClick={onUpdate} disabled={busy}>
          {busy ? t('upd.installing') : u.phase === 'ready' ? t('upd.restart') : t('gate.update.button')}
        </button>
        {showFail && <p className="ap-muted">{t('gate.update.failed')} <a href={MSGR_RELEASES_URL} onClick={(e) => { e.preventDefault(); openExternalUrl(MSGR_RELEASES_URL); }}>{t('gate.update.download')}</a></p>}
      </div>
    </div>
  );
}
