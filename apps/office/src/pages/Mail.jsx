// 메일(내 공간) — 계정·폴더 | 목록 | 본문. 본문은 메일 서버(Gmail)에 두고 볼 때 가져온다. 크루는 초안까지만 쓴다.
// 로그인 전(예시 모드)은 예시 메일, 로그인 뒤는 연결한 계정(Gmail·Google Workspace, 여러 개)의 메일.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { desktopMailPending, cancelDesktopMail } from '../core/desktop-auth.js';
import { useDraggable } from '@dnd-kit/core';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { openMenu, menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { SplitHandle, useWidth } from '../ui/Split.jsx';
import { navigate } from '../core/router.jsx';
import { t, ago, useLang } from '../core/i18n.js';
import { useStore, setMail, archiveMail } from '../core/store.js';
import { setUi, useUi } from '../core/ui-state.js';
import { mailMenu } from '../core/commands.js';
import { dragHasFiles, filesFromTransfer, fmtBytes, MAX_FILE } from '../core/files.js';
import { imeGuardWith } from '../core/ime.js';
import { MAIL_FOLDERS } from '../data/sample.js';
import { ME, useSession } from '../core/session.js';
import { crewName } from './modules.jsx';
import { translateMail } from '../core/translate.js';
import {
  loadAccounts, pullMail, readMail, connectGoogle, finishConnect, disconnectAccount, mailConfig, adminNote,
  saveDraft, sendMail, fileToPart, openAttachment, mailDoc, mailPaper, ATTACH_CAP,
} from '../core/mail.js';

const ok = (a) => a.status === 'ok';
const domain = (addr) => String(addr ?? '').split('@')[1] ?? '';
async function copyAdminNote() {
  await navigator.clipboard.writeText(adminNote(t, await mailConfig()));
  showToast(t('mailc.copied'));
}
const reconnect = (a) => connectGoogle(a?.address).catch((e) => { if (e.code !== 'cancelled') showToast(t(`mailc.err.${['not_configured', 'access_denied', 'state'].includes(e.code) ? e.code : e.code === 'expired' ? 'state' : 'other'}`)); });
const subscribeMailPending = (cb) => { window.addEventListener('office-mail-pending', cb); return () => window.removeEventListener('office-mail-pending', cb); };

function MailRow({ m, active, tag }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `mail:${m.id}`, data: { kind: 'mail', id: m.id, label: m.subject } });
  const { onTouchStart, ...mouse } = listeners ?? {};
  return (
    <button ref={setNodeRef} type="button" className={`mail-row${active ? ' active' : ''}${m.unread ? ' unread' : ''}${isDragging ? ' ghost' : ''}`}
      {...attributes} {...mergeHandlers(mouse, menuProps(() => mailMenu(m)))} role="option" aria-selected={active}
      onClick={() => { navigate(`/me/mail/${m.id}`); if (m.unread) setMail(m.id, { unread: false }); }}>
      <span className="mail-from">{m.unread && <span className="dot mark" />}{m.from}</span>
      <span className="mail-time mono">{ago(m.at)}</span>
      <span className="mail-subject">{m.subject}</span>
      <span className="mail-snippet">{tag && <span className="mail-tag">{tag}</span>}{m.snippet ?? m.body?.[0]}</span>
      {m.note && <span className="mail-crew"><Face id={m.note.crew} size={14} />{t('mail.note', { crew: crewName(m.note.crew) })}</span>}
    </button>
  );
}

/** 실제 메일 본문 — 격리된 틀(sandbox, 스크립트 없음)에 넣고 바깥 이미지는 누를 때만 */
function MailBody({ m, tr }) {
  const [c, setC] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => { let live = true; setC(null); setErr(false); readMail(m).then((x) => live && setC(x), () => live && setErr(true)); return () => { live = false; }; }, [m.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <p className="dim">{t('mailc.readFailed')}</p>;
  if (!c) return <p className="dim">{t('mailc.loading')}</p>;
  return (
    <>
      {c.attachments.length > 0 && <div className="chips mail-atts">{c.attachments.map((a) => (
        <button key={a.id} type="button" className="chip" onClick={() => openAttachment(m, a).catch(() => showToast(t('mailc.readFailed')))}><Icon name="file" size={12} />{a.name}<small className="mono">{fmtBytes(a.size)}</small></button>
      ))}</div>}
      {c.html ? (
        <iframe className="mail-frame" title={m.subject} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={mailDoc(tr?.html ?? c.html, { paper: mailPaper() })} />
      ) : <div className="reader-body mail-text">{tr?.text ?? c.text ?? m.snippet}</div>}
    </>
  );
}

const TR_ERR = { offline: 'tr.offline', no_subscription: 'tr.noSub', too_large: 'tr.tooLarge' };

function Reader({ m, onBack }) {
  const [c, setC] = useState(null);
  // 번역(버튼을 누를 때만) — { busy, done, total, subject, html, text }. 다른 메일로 가면 원문으로
  const [tr, setTr] = useState(null); const [showTr, setShowTr] = useState(false);
  const shown = useRef(m?.id); shown.current = m?.id;                                  // 번역 중에 다른 메일로 가면 늦게 온 결과를 버린다
  const stopTr = useRef(null);                                                          // 번역 중에 다른 메일로 가면 기기에 취소를 보낸다(남은 묶음이 구독 한도를 쓰지 않게)
  useEffect(() => { let live = true; setC(null); setTr(null); setShowTr(false); if (m?.account) readMail(m).then((x) => live && setC(x), () => {}); return () => { live = false; stopTr.current?.abort(); }; }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const translate = async () => {
    if (tr && !tr.busy) { setShowTr((v) => !v); return; }
    if (!c || tr?.busy) return;
    const id = m.id;
    setTr({ busy: true, done: 0, total: 0 }); setShowTr(true);
    try {
      const ac = new AbortController(); stopTr.current = ac;
      const out = await translateMail(m, c, { signal: ac.signal, onProgress: (p) => { if (shown.current === id) setTr((cur) => (cur?.busy ? { ...p, busy: true } : cur)); } });
      if (shown.current !== id) return;
      setTr(out);
      if (out.partial) showToast(t('tr.partial'));
    } catch (e) { if (shown.current !== id) return; setTr(null); setShowTr(false); if (e.code !== 'cancelled') showToast(t(TR_ERR[e.code] ?? 'tr.failed')); }
  };
  if (!m) return <div className="empty-state"><Icon name="mail" size={20} /><p>{t('mail.select')}</p></div>;
  const reply = () => setUi({ compose: { to: m.addr, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, account: m.account, threadId: m.threadId, inReplyTo: c?.messageId, references: c?.references } });
  return (
    <article className={`reader${m.account ? ' real' : ''}`}>
      <header className="reader-head">
        <button type="button" className="icon-btn only-narrow" aria-label={t('mail.back')} onClick={onBack}><Icon name="back" /></button>
        <h2>{showTr && tr?.subject ? tr.subject : m.subject}</h2>
        <div className="reader-meta"><b>{m.from}</b><span className="dim">&lt;{m.addr}&gt;</span><span className="dim mono">{ago(m.at)}</span></div>
        <div className="reader-actions">
          <button type="button" className="btn primary" onClick={() => setUi({ assign: { space: 'me', items: [{ kind: 'mail', id: m.id, label: m.subject }] } })}><Icon name="hand" size={14} />{t('crew.assign')}</button>
          <button type="button" className="btn" onClick={reply}><Icon name="reply" size={14} />{t('mail.reply')}</button>
          {m.account && <button type="button" className={`btn${showTr && tr && !tr.busy ? ' on' : ''}`} disabled={!c || tr?.busy} aria-pressed={showTr && !!tr && !tr.busy} onClick={translate}>
            <Icon name="globe" size={14} />{tr?.busy ? t('tr.busy', { n: tr.done, t: tr.total || '…' }) : showTr && tr ? t('tr.original') : t('tr.translate')}
          </button>}
          {m.folder !== 'archive' && <button type="button" className="btn" onClick={() => { const undo = archiveMail(m.id); showToast(t('mail.archived'), { undo }); navigate('/me/mail'); }}><Icon name="archive" size={14} />{t('mail.archiveIt')}</button>}
          <button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => openMenu(e, mailMenu(m), { anchor: e.currentTarget })}><Icon name="dots" /></button>
        </div>
      </header>
      {m.note && (
        <section className="crew-note">
          <div className="crew-note-head"><Face id={m.note.crew} size={18} /><b>{t('mail.note', { crew: crewName(m.note.crew) })}</b></div>
          <p>{m.note.summary}</p>
          <ul>{m.note.todos.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      )}
      {m.account ? <MailBody m={m} tr={showTr ? tr : null} /> : <div className="reader-body">{m.body.map((p, i) => <p key={i}>{p}</p>)}</div>}
    </article>
  );
}

export function Compose() {
  useLang();
  const { compose } = useUi();
  const real = useSession() === 'signedIn';
  const accounts = useStore((s) => s.mailAccounts);
  const usable = useMemo(() => (accounts ?? []).filter(ok), [accounts]);
  const [to, setTo] = useState(''); const [cc, setCc] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [from, setFrom] = useState(''); const [files, setFiles] = useState([]); const [over, setOver] = useState(false);
  const [saved, setSaved] = useState(false); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  const draft = useRef(null); const pending = useRef(null);
  useEffect(() => {
    if (!compose) return;
    setTo(compose.to ?? ''); setCc(''); setSubject(compose.subject ?? ''); setBody(''); setFiles([]); setSaved(false); setDirty(false);
    setFrom(compose.account ?? usable[0]?.id ?? ''); draft.current = null;
  }, [compose]); // eslint-disable-line react-hooks/exhaustive-deps
  const msg = () => ({ account: from, threadId: compose?.threadId, inReplyTo: compose?.inReplyTo, references: compose?.references, to, cc, subject, text: body, from: usable.find((a) => a.id === from)?.address });
  // 초안 자동 저장: 손댄 뒤 2초 멈추면, 바뀐 것이 있을 때만(임시 보관함에 한 통 — 같은 초안을 고친다)
  useEffect(() => {
    if (!compose || !dirty) return;
    if (!real) { const id = setTimeout(() => setSaved(true), 1200); return () => clearTimeout(id); }
    if (!from || !(to || subject || body)) return;
    const id = setTimeout(async () => {
      pending.current = saveDraft({ ...msg(), draftId: draft.current?.account === from ? draft.current.id : undefined })
        .then((r) => { draft.current = { id: r.draftId, account: from }; setSaved(true); }, () => {});
    }, 2000);
    return () => clearTimeout(id);
  }, [compose, dirty, to, cc, subject, body, from]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => setUi({ compose: null });
  const edit = (fn) => (e) => { fn(e.target.value); setDirty(true); setSaved(false); };
  const add = (list) => {
    const okFiles = list.filter((f) => f.size <= MAX_FILE);
    if (okFiles.length < list.length) showToast(t('page.tooBig'));
    setFiles((cur) => [...cur, ...okFiles]);
  };
  const send = async () => {
    if (!real) { close(); showToast(t('mail.send')); return; }
    if (!from) { showToast(t('mailc.noAccount')); return; }
    if (files.reduce((n, f) => n + f.size, 0) > ATTACH_CAP) { showToast(t('mailc.tooBig')); return; }
    setBusy(true);
    try {
      await pending.current;                                                         // 저장 중인 초안이 있으면 끝난 뒤 그 초안을 지우며 보낸다
      await sendMail({ ...msg(), draftId: draft.current?.account === from ? draft.current.id : undefined, attachments: await Promise.all(files.map(fileToPart)) });
      close(); showToast(t('mailc.sent'));
    } catch { showToast(t('mailc.sendFailed')); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!compose} onClose={close} title={t('mail.compose')} width={620}
      footer={<><span className="dim small">{saved ? t('mail.draftSaved') : ''}</span><button type="button" className="btn primary" disabled={busy || !to.trim()} onClick={send}><Icon name="send" size={14} />{t('mail.send')}</button></>}>
      <div className={`compose${over ? ' file-over' : ''}`} onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(filesFromTransfer(e.dataTransfer)); }}>
        {real && usable.length > 1 && (
          <label className="field"><span>{t('mailc.from')}</span>
            <select value={from} onChange={edit(setFrom)}>{usable.map((a) => <option key={a.id} value={a.id}>{a.address}</option>)}</select>
          </label>
        )}
        <label className="field"><span>{t('mail.to')}</span><input value={to} onChange={edit(setTo)} {...imeGuardWith()} /></label>
        {real && <label className="field"><span>{t('mailc.cc')}</span><input value={cc} onChange={edit(setCc)} {...imeGuardWith()} /></label>}
        <label className="field"><span>{t('mail.subject')}</span><input value={subject} onChange={edit(setSubject)} {...imeGuardWith()} /></label>
        <textarea className="compose-body" value={body} onChange={edit(setBody)} rows={10} />
        {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip"><Icon name="file" size={12} />{f.name}<small className="mono">{fmtBytes(f.size)}</small></span>)}</div>}
        {over && <div className="drop-hint">{t('mail.dropHere')}</div>}
      </div>
    </Modal>
  );
}

/** 계정이 없을 때 — Google로 연결(로그인 → 권한 승인), 회사 계정이 막혔을 때의 안내문 */
function ConnectPanel() {
  const [cfg, setCfg] = useState(undefined);
  useEffect(() => { let live = true; mailConfig().then((c) => live && setCfg(c)); return () => { live = false; }; }, []);
  return (
    <div className="empty-state mail-connect">
      <Icon name="mail" size={22} />
      <h3>{t('mailc.title')}</h3>
      <p className="dim small">{t('mailc.sub')}</p>
      {cfg !== undefined && (cfg?.google
        ? <button type="button" className="btn primary" onClick={() => reconnect()}>{t('mailc.google')}</button>
        : <p className="dim small">{t('mailc.notConfigured')}</p>)}
      {cfg?.google && <button type="button" className="link-btn small" onClick={copyAdminNote}>{t('mailc.blockedQ')} {t('mailc.copyAdmin')}</button>}
    </div>
  );
}

/** Google이 돌려보내는 자리(/me/mail/connect?code&state 또는 ?error) — 서버가 토큰을 받아 봉인·저장 */
export function MailConnect({ query }) {
  useLang();
  const mode = useSession();
  const [error, setError] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    if (mode !== 'signedIn' || started.current) return;
    started.current = true;
    const q = new URLSearchParams(query ?? '');
    if (q.get('error')) { setError(q.get('error')); return; }
    finishConnect(q.get('code'), q.get('state'))
      .then(async ({ address }) => { await loadAccounts(); showToast(t('mailc.connected', { addr: address })); navigate('/me/mail', { replace: true }); })
      .catch((e) => setError(e.code));
  }, [mode, query]);
  const known = ['access_denied', 'admin_policy_enforced', 'scopes', 'state', 'not_configured'];
  return (
    <div className="empty-state mail-connect">
      <Icon name="mail" size={22} />
      {!error ? <p>{t('mailc.connecting')}</p> : <>
        <p>{t(`mailc.err.${known.includes(error) ? error : 'other'}`)}</p>
        <div className="row-gap">
          <button type="button" className="btn primary" onClick={() => reconnect()}>{t('mailc.reconnect')}</button>
          <button type="button" className="btn" onClick={() => navigate('/me/mail', { replace: true })}>{t('mail.back')}</button>
        </div>
        <button type="button" className="link-btn small" onClick={copyAdminNote}>{t('mailc.copyAdmin')}</button>
      </>}
    </div>
  );
}

function AccountList({ accounts, pick, setPick }) {
  const [bye, setBye] = useState(null);
  const menu = (a) => [
    ...(ok(a) ? [] : [{ label: t('mailc.reconnect'), icon: 'mail', run: () => reconnect(a) }]),
    { label: t('mailc.disconnect'), icon: 'x', run: () => setBye(a) },
  ];
  return (
    <div className="mail-accounts">
      {accounts.length > 1 && <button type="button" className={`nav-item${pick === 'all' ? ' active' : ''}`} onClick={() => setPick('all')}><span className="nav-label">{t('mailc.all')}</span></button>}
      {accounts.map((a) => (
        <div key={a.id} className={`mail-account${pick === a.id ? ' active' : ''}`} {...menuProps(() => menu(a))}>
          <button type="button" className="mail-account-name" onClick={() => setPick(accounts.length > 1 ? a.id : 'all')} title={a.address}>
            <span className={`dot ${ok(a) ? 'ok' : 'ask'}`} /><span className="ellip">{a.address}</span>{a.hosted_domain && <small className="badge">{t('mailc.work')}</small>}
          </button>
          {!ok(a) && <button type="button" className="link-btn small" onClick={() => reconnect(a)}>{t('mailc.reconnect')}</button>}
          <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(a), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
        </div>
      ))}
      <button type="button" className="nav-item dim" onClick={() => reconnect()}><Icon name="plus" /><span className="nav-label">{t('mailc.add')}</span></button>
      <Modal open={!!bye} onClose={() => setBye(null)} title={t('mailc.disconnectTitle', { addr: bye?.address ?? '' })}
        footer={<><button type="button" className="btn" onClick={() => setBye(null)}>{t('cancel')}</button>
          <button type="button" className="btn danger" onClick={async () => { const a = bye; setBye(null); try { await disconnectAccount(a.id); showToast(t('mailc.disconnected')); } catch { showToast(t('mailc.err.other')); } }}>{t('mailc.disconnect')}</button></>}>
        <p>{t('mailc.disconnectBody')}</p>
      </Modal>
    </div>
  );
}

export function Mail({ id }) {
  const connecting = useSyncExternalStore(subscribeMailPending, desktopMailPending, () => false);
  useLang();
  const real = useSession() === 'signedIn';
  const mails = useStore((s) => s.mails);
  const accounts = useStore((s) => s.mailAccounts) ?? [];
  const [folder, setFolder] = useState('inbox');
  const [pick, setPick] = useState('all');
  const [loading, setLoading] = useState(false);
  const [listW, setListW] = useWidth('argo-office-mail-list', 360, 280, 560);
  const [ready, setReady] = useState(!real);
  useEffect(() => { if (real) loadAccounts().catch(() => {}).finally(() => setReady(true)); }, [real]);
  const accKey = accounts.filter(ok).map((a) => a.id).join(',');
  useEffect(() => {
    if (!real || !accKey) return;
    let live = true; setLoading(true);
    const run = () => pullMail(folder).catch(() => {}).finally(() => live && setLoading(false));
    run();
    let last = Date.now();
    const onShow = () => { if (document.hidden || Date.now() - last < 60_000) return; last = Date.now(); run(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { live = false; document.removeEventListener('visibilitychange', onShow); };
  }, [real, folder, accKey]);
  const inView = (m) => m.folder === folder && (pick === 'all' || m.account === pick);
  const rows = useMemo(() => mails.filter(inView).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [mails, folder, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = mails.find((m) => m.id === id);
  useEffect(() => { if (cur?.unread) setMail(cur.id, { unread: false }); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 목록 키보드: j/k 이동, e 보관, r 답장(입력 중이 아닐 때만)
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      const i = rows.findIndex((m) => m.id === id);
      if (e.key === 'j' || e.key === 'k') { const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))]; if (next) { navigate(`/me/mail/${next.id}`); if (next.unread) setMail(next.id, { unread: false }); } }
      if (e.key === 'e' && cur && cur.folder !== 'archive') { const undo = archiveMail(cur.id); showToast(t('mail.archived'), { undo }); }
      if (e.key === 'r' && cur) setUi({ compose: { to: cur.addr, subject: `Re: ${cur.subject}`, account: cur.account, threadId: cur.threadId } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, id, cur]);
  const counts = useMemo(() => Object.fromEntries(MAIL_FOLDERS.map((f) => [f.id, mails.filter((m) => m.folder === f.id && m.unread && (pick === 'all' || m.account === pick)).length])), [mails, pick]);
  const multi = accounts.length > 1;
  const noAccounts = real && ready && !accounts.length;
  const expired = accounts.filter((a) => !ok(a));
  return (
    <div className={`mail${cur ? ' has-reader' : ''}`} style={{ '--list-w': `${listW}px` }}>
      <aside className="mail-folders">
        <button type="button" className="btn primary block" disabled={real && !accounts.some(ok)} onClick={() => setUi({ compose: {} })}><Icon name="draft" size={14} />{t('mail.compose')}</button>
        {real ? <AccountList accounts={accounts} pick={pick} setPick={setPick} /> : <div className="mail-account"><span className="dot ok" />{ME.email}</div>}
        {MAIL_FOLDERS.map((f) => (
          <button key={f.id} type="button" className={`nav-item${folder === f.id ? ' active' : ''}`} onClick={() => { setFolder(f.id); navigate('/me/mail'); }}>
            <Icon name={{ inbox: 'inbox', drafts: 'draft', sent: 'send', archive: 'archive' }[f.id]} /><span className="nav-label">{t(f.name)}</span>{counts[f.id] > 0 && <span className="nav-count">{counts[f.id]}</span>}
          </button>
        ))}
      </aside>
      <section className="mail-list" role="listbox" aria-label={t(`mail.${folder}`)}>
        {connecting && <div className="mail-banner" role="status">{t('desktop.mailWaiting')}<button className="btn sm" type="button" onClick={cancelDesktopMail}>{t('desktop.cancel')}</button></div>}
        {expired.length > 0 && <div className="mail-banner"><span className="dot ask" />{t('mailc.expired')}<button type="button" className="btn sm" onClick={() => reconnect(expired[0])}>{t('mailc.reconnect')}</button></div>}
        {noAccounts ? <ConnectPanel />
          : rows.length ? rows.map((m) => <MailRow key={m.id} m={m} active={m.id === id} tag={multi && pick === 'all' ? domain(accounts.find((a) => a.id === m.account)?.address) : null} />)
          : <div className="empty-state"><p>{t(loading || (real && !ready) ? 'mailc.loading' : 'mail.empty')}</p></div>}
      </section>
      <SplitHandle width={listW} onChange={setListW} label={t('mod.resize')} />
      <section className="mail-reader"><Reader m={cur} onBack={() => navigate('/me/mail')} /></section>
    </div>
  );
}
