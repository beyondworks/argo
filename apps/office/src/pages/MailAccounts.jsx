// 메일 계정 연결·다시 연결·연결 해제 — 메일 화면 왼쪽 목록과 설정 화면이 같이 쓴다(설정 칸이 예시 그대로 남아 있던 결함, 10/4 PARITY-ALL).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { t, useLang, registerDict } from '../core/i18n.js';
import { MAIL_DICT } from './mail-i18n.js';
import { useStore } from '../core/store.js';
import { ME, useSession } from '../core/session.js';
import { Hide } from '../business/Redact.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { loadAccounts, connectGoogle, disconnectAccount, mailConfig, adminNote, notifyOn, setNotifyOn, subscribeNotify } from '../core/mail.js';

registerDict(MAIL_DICT);

export const okAccount = (a) => a.status === 'ok';

export async function copyAdminNote() {
  await navigator.clipboard.writeText(adminNote(t, await mailConfig()));
  showToast(t('mailc.copied'));
}

export const reconnect = (a) => connectGoogle(a?.address).catch((e) => { if (e.code !== 'cancelled') showToast(t(`mailc.err.${['not_configured', 'access_denied', 'state'].includes(e.code) ? e.code : e.code === 'expired' ? 'state' : 'other'}`)); });

/** 연결 해제 확인 — account가 있을 때만 열린다 */
export function DisconnectModal({ account, onClose }) {
  const bye = async () => { const a = account; onClose(); try { await disconnectAccount(a.id); showToast(t('mailc.disconnected')); } catch { showToast(t('mailc.err.other')); } };
  return <Modal open={!!account} onClose={onClose} title={t('mailc.disconnectTitle', { addr: account?.address ?? '' })}
    footer={<><button type="button" className="btn" onClick={onClose}>{t('cancel')}</button><button type="button" className="btn danger" onClick={bye}>{t('mailc.disconnect')}</button></>}>
    <p>{t('mailc.disconnectBody')}</p>
  </Modal>;
}

/** 설정 화면의 '알림' 칸(15차, 유건 결정 3) — 새 메일 알림 켜기·끄기(이 기기)와 시험 알림. 처음 켤 때만 권한을 묻는다.
 *  알림은 오피스가 열려 있는 동안 자동 갱신이 새 메일을 받았을 때만 나간다(앱이 닫혀 있을 때의 푸시는 하지 않는다) */
export function MailNotifySettings() {
  useLang();
  const mode = useSession();
  const on = useSyncExternalStore(subscribeNotify, notifyOn, () => false);
  const [perm, setPerm] = useState(null), [busy, setBusy] = useState(false);
  const notify = () => import('../core/mail-notify.js');
  useEffect(() => { notify().then((m) => setPerm(m.notifyPermission())).catch(() => setPerm('unsupported')); }, [on]);
  const toggle = async () => {
    if (on) { setNotifyOn(false); showToast(t('notify.off')); return; }
    setBusy(true);
    try {
      const m = await notify();
      const p = await m.askPermission();
      setPerm(p);
      if (p === 'granted') { setNotifyOn(true); showToast(t('notify.on')); } else showToast(t(p === 'unsupported' ? 'notify.unsupported' : 'notify.denied'));
    } finally { setBusy(false); }
  };
  const test = async () => { const m = await notify(); if (!m.showNotify({ title: t('notify.testTitle'), body: t('notify.testBody') })) showToast(t(m.notifyPermission() === 'unsupported' ? 'notify.unsupported' : 'notify.denied')); };
  return <>
    <label className="person"><input type="checkbox" role="switch" checked={on} disabled={busy} onChange={toggle} /><span className="person-main"><b>{t('notify.mail')}</b><small>{t('notify.mailHelp')}</small></span></label>
    {perm === 'denied' && <p className="dim small">{t('notify.denied')}</p>}
    {perm === 'unsupported' && <p className="dim small">{t('notify.unsupported')}</p>}
    {mode === 'sample' && on && <p className="dim small">{t('notify.sample')}</p>}
    <div className="set-actions"><button type="button" className="btn sm" disabled={perm !== 'granted'} onClick={test}>{t('notify.test')}</button></div>
  </>;
}

/** 설정 화면의 '메일 계정' 칸 — 실제로 연결된 계정과 상태, 다시 연결·해제·추가. 로그인 전에는 예시 계정이라고만 알린다 */
export function MailAccountsSettings() {
  useLang();
  const real = useSession() === 'signedIn';
  const accounts = useStore((s) => s.mailAccounts) ?? [];
  const [ready, setReady] = useState(false), [cfg, setCfg] = useState(undefined), [bye, setBye] = useState(null), [again, setAgain] = useState(0);
  useEffect(() => {
    if (!real) return;
    let live = true;
    loadAccounts().catch(() => {}).finally(() => live && setReady(true));
    mailConfig().then((c) => live && setCfg(c));
    return () => { live = false; };
  }, [real, again]);
  if (!real) return <>
    <div className="person"><span className="dot ok" /><span className="person-main"><b><Hide k="mail:me">{ME.email}</Hide></b><small>{t('mailc.sampleAccount')}</small></span></div>
    <p className="dim small">{t('mailc.sampleNote')}</p>
  </>;
  return <>
    {ready && !accounts.length && <p className="dim small">{t('mailc.none')} {t('mailc.sub')}</p>}
    {accounts.map((a) => <div key={a.id} className="person">
      <span className={`dot ${okAccount(a) ? 'ok' : 'ask'}`} />
      <span className="person-main"><b><Hide k={`mail:acct:${a.address}`}>{a.address}</Hide></b>
        <small>{[t(okAccount(a) ? 'mailc.statusOk' : 'mailc.statusExpired'), a.hosted_domain && t('mailc.workAccount')].filter(Boolean).join(' · ')}</small></span>
      {!okAccount(a) && <button type="button" className="btn sm primary" onClick={() => reconnect(a)}>{t('mailc.reconnect')}</button>}
      <button type="button" className="btn sm ghost" onClick={() => setBye(a)}>{t('mailc.disconnect')}</button>
    </div>)}
    {cfg?.failed ? <LoadFail small onRetry={() => { setCfg(undefined); setAgain((n) => n + 1); }} /> : cfg !== undefined && (cfg?.google
      ? <div className="set-actions"><button type="button" className="btn sm" onClick={() => reconnect()}><Icon name="plus" size={13} />{t(accounts.length ? 'mailc.add' : 'mailc.google')}</button>
        <button type="button" className="link-btn small" onClick={copyAdminNote}>{t('mailc.blockedQ')} {t('mailc.copyAdmin')}</button></div>
      : <p className="dim small">{t('mailc.notConfigured')}</p>)}
    <DisconnectModal account={bye} onClose={() => setBye(null)} />
  </>;
}
