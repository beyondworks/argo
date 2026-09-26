// 메일(내 공간) — 폴더 | 목록 | 본문. 본문은 원래 메일 서버에 두고 필요할 때 불러온다(P3: IMAP). 크루는 초안까지만 쓴다.
import { useEffect, useMemo, useState } from 'react';
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
import { ME } from '../core/session.js';
import { crewName } from './modules.jsx';

function MailRow({ m, active }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `mail:${m.id}`, data: { kind: 'mail', id: m.id, label: m.subject } });
  const { onTouchStart, ...mouse } = listeners ?? {};
  return (
    <button ref={setNodeRef} type="button" className={`mail-row${active ? ' active' : ''}${m.unread ? ' unread' : ''}${isDragging ? ' ghost' : ''}`}
      {...attributes} {...mergeHandlers(mouse, menuProps(() => mailMenu(m)))} role="option" aria-selected={active}
      onClick={() => { navigate(`/me/mail/${m.id}`); if (m.unread) setMail(m.id, { unread: false }); }}>
      <span className="mail-from">{m.unread && <span className="dot mark" />}{m.from}</span>
      <span className="mail-time mono">{ago(m.at)}</span>
      <span className="mail-subject">{m.subject}</span>
      <span className="mail-snippet">{m.body[0]}</span>
      {m.note && <span className="mail-crew"><Face id={m.note.crew} size={14} />{t('mail.note', { crew: crewName(m.note.crew) })}</span>}
    </button>
  );
}

function Reader({ m, onBack }) {
  if (!m) return <div className="empty-state"><Icon name="mail" size={20} /><p>{t('mail.select')}</p></div>;
  return (
    <article className="reader">
      <header className="reader-head">
        <button type="button" className="icon-btn only-narrow" aria-label={t('mail.back')} onClick={onBack}><Icon name="back" /></button>
        <h2>{m.subject}</h2>
        <div className="reader-meta"><b>{m.from}</b><span className="dim">&lt;{m.addr}&gt;</span><span className="dim mono">{ago(m.at)}</span></div>
        <div className="reader-actions">
          <button type="button" className="btn primary" onClick={() => setUi({ assign: { space: 'me', items: [{ kind: 'mail', id: m.id, label: m.subject }] } })}><Icon name="hand" size={14} />{t('crew.assign')}</button>
          <button type="button" className="btn" onClick={() => setUi({ compose: { to: m.addr, subject: `Re: ${m.subject}` } })}><Icon name="reply" size={14} />{t('mail.reply')}</button>
          <button type="button" className="btn" onClick={() => { const undo = archiveMail(m.id); showToast(t('mail.archived'), { undo }); navigate('/me/mail'); }}><Icon name="archive" size={14} />{t('mail.archiveIt')}</button>
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
      <div className="blocked-note"><Icon name="lock" size={12} />{t('mail.imagesBlocked')}</div>
      <div className="reader-body">{m.body.map((p, i) => <p key={i}>{p}</p>)}</div>
    </article>
  );
}

export function Compose() {
  useLang();
  const { compose } = useUi();
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [files, setFiles] = useState([]); const [over, setOver] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => { if (compose) { setTo(compose.to ?? ''); setSubject(compose.subject ?? ''); setBody(''); setFiles([]); setSaved(false); } }, [compose]);
  useEffect(() => { if (!compose || !body) return; const id = setTimeout(() => setSaved(true), 1200); return () => clearTimeout(id); }, [compose, body, to, subject]);
  const close = () => setUi({ compose: null });
  const add = (list) => {
    const ok = list.filter((f) => f.size <= MAX_FILE);
    if (ok.length < list.length) showToast(t('page.tooBig'));
    setFiles((cur) => [...cur, ...ok.map((f) => ({ name: f.name, size: f.size }))]);
  };
  return (
    <Modal open={!!compose} onClose={close} title={t('mail.compose')} width={620}
      footer={<><span className="dim small">{saved ? t('mail.draftSaved') : ''}</span><button type="button" className="btn primary" onClick={() => { close(); showToast(t('mail.send')); }}><Icon name="send" size={14} />{t('mail.send')}</button></>}>
      <div className={`compose${over ? ' file-over' : ''}`} onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(filesFromTransfer(e.dataTransfer)); }}>
        <label className="field"><span>{t('mail.to')}</span><input value={to} onChange={(e) => setTo(e.target.value)} {...imeGuardWith()} /></label>
        <label className="field"><span>{t('mail.subject')}</span><input value={subject} onChange={(e) => setSubject(e.target.value)} {...imeGuardWith()} /></label>
        <textarea className="compose-body" value={body} onChange={(e) => { setBody(e.target.value); setSaved(false); }} rows={10} />
        {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip"><Icon name="file" size={12} />{f.name}<small className="mono">{fmtBytes(f.size)}</small></span>)}</div>}
        {over && <div className="drop-hint">{t('mail.dropHere')}</div>}
      </div>
    </Modal>
  );
}

export function Mail({ id }) {
  useLang();
  const mails = useStore((s) => s.mails);
  const [folder, setFolder] = useState('inbox');
  const [listW, setListW] = useWidth('argo-office-mail-list', 360, 280, 560);
  const rows = useMemo(() => mails.filter((m) => m.folder === folder).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [mails, folder]);
  const cur = mails.find((m) => m.id === id);
  useEffect(() => { if (cur?.unread) setMail(cur.id, { unread: false }); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 목록 키보드: j/k 이동, e 보관, r 답장(입력 중이 아닐 때만)
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      const i = rows.findIndex((m) => m.id === id);
      if (e.key === 'j' || e.key === 'k') { const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))]; if (next) { navigate(`/me/mail/${next.id}`); if (next.unread) setMail(next.id, { unread: false }); } }
      if (e.key === 'e' && cur) { const undo = archiveMail(cur.id); showToast(t('mail.archived'), { undo }); }
      if (e.key === 'r' && cur) setUi({ compose: { to: cur.addr, subject: `Re: ${cur.subject}` } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, id, cur]);
  const counts = useMemo(() => Object.fromEntries(MAIL_FOLDERS.map((f) => [f.id, mails.filter((m) => m.folder === f.id && m.unread).length])), [mails]);
  return (
    <div className={`mail${cur ? ' has-reader' : ''}`} style={{ '--list-w': `${listW}px` }}>
      <aside className="mail-folders">
        <button type="button" className="btn primary block" onClick={() => setUi({ compose: {} })}><Icon name="draft" size={14} />{t('mail.compose')}</button>
        <div className="mail-account"><span className="dot ok" />{ME.email}</div>
        {MAIL_FOLDERS.map((f) => (
          <button key={f.id} type="button" className={`nav-item${folder === f.id ? ' active' : ''}`} onClick={() => { setFolder(f.id); navigate('/me/mail'); }}>
            <Icon name={{ inbox: 'inbox', drafts: 'draft', sent: 'send', archive: 'archive' }[f.id]} /><span className="nav-label">{t(f.name)}</span>{counts[f.id] > 0 && <span className="nav-count">{counts[f.id]}</span>}
          </button>
        ))}
      </aside>
      <section className="mail-list" role="listbox" aria-label={t(`mail.${folder}`)}>
        {rows.length ? rows.map((m) => <MailRow key={m.id} m={m} active={m.id === id} />) : <div className="empty-state"><p>{t('mail.empty')}</p></div>}
      </section>
      <SplitHandle width={listW} onChange={setListW} label={t('mod.resize')} />
      <section className="mail-reader"><Reader m={cur} onBack={() => navigate('/me/mail')} /></section>
    </div>
  );
}
