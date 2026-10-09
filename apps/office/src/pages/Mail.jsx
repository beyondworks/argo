// 메일(내 공간) — 계정·메일함 | 목록 | 본문(+ 일정). 본문은 메일 서버(Gmail)에 두고 볼 때 가져온다. 크루는 초안까지만 쓴다.
// 로그인 전(예시 모드)은 예시 메일, 로그인 뒤는 연결한 계정(Gmail·Google Workspace, 여러 개)의 메일. 예시 모드도 같은 흐름(가짜 발송·가짜 초안).
// 15차(유건 10/4 "동등 이상, 더 쉽게"): 별표·안 읽음 보기, 검색(여러 계정 합치기), 새로고침·더 보기, 마지막 메일함 기억, 보낸 사람 아바타,
//   자동 갱신(화면이 보이는 동안 바뀐 것만), 받는 사람·참조·정확한 날짜, 글자 본문 링크, 다시 시도·요청 제한 남은 시간,
//   서식 편집기(지연 로드)·첨부 고르기/빼기·원문 인용·전체 회신·전달(원문 첨부까지)·보내기 전 확인·큰 첨부는 문서함 링크,
//   초안 자동 저장(상태·시각, 한 번에 하나)·닫을 때 저장·새로고침 뒤 이어 쓰기·임시 보관함 고치기/보내기/삭제, 새 메일 알림, 메일 옆 일정.
// 규칙(순수 함수)은 mail-model.js, 상태·서버는 core/mail.js.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { desktopMailPending, cancelDesktopMail } from '../core/desktop-auth.js';
import { useDraggable } from '@dnd-kit/core';
import { Icon } from '../ui/Icon.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { Face } from '../ui/Face.jsx';
import { openMenu, menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { SplitHandle, useWidth } from '../ui/Split.jsx';
import { navigate } from '../core/router.jsx';
import { t, ago, useLang, getLang, registerDict } from '../core/i18n.js';
import { MAIL_DICT } from './mail-i18n.js';
import { useStore, setMail, archiveMail, getState } from '../core/store.js';
import { setUi, useUi, getUi } from '../core/ui-state.js';
import { mailMenu } from '../core/commands.js';
import { dragHasFiles, filesFromTransfer, fmtBytes, MAX_FILE } from '../core/files.js';
import { imeGuardWith } from '../core/ime.js';
import { ME, useSession } from '../core/session.js';
import { crewName } from './modules.jsx';
import { useSelection, selProps } from '../core/selection.js';
import { checkKeys, checkState } from '../ui/marquee-model.js';
import { Hide, HideIn } from '../business/Redact.jsx';
import { looksLikeAddr } from '../core/hide-all.js';
/** 목록 줄의 주소(받는 사람·이름 없는 보낸 사람) — 화면 전체 가리기 중 흐린다(제목·요약과 같은 흐림, 18차 검수 M2) */
const haAddr = (s) => <span className="ha">{s}</span>;
import {
  loadAccounts, pullMail, syncMail, readMail, finishConnect, mailConfig, refreshMail, hasMore, wantSync, lastSynced, subscribeSync, limitLeft, subscribeLimit, getLimitUntil,
  saveDraft, sendMail, sendDraft, deleteDraft, toggleStar, fileToPart, openAttachment, mailDoc, mailPaper, ATTACH_CAP,
  readSnap, saveSnap, clearSnap, readView, writeView, firstView, seedSample, notifyOn, subscribeNotify, hardFails, takeMailReturn } from '../core/mail.js';
import {
  VIEWS, inView, byDate, replySubject, forwardSubject, replyTo, replyAll, fmtExact, linkify, quoteBlock, forwardBlock, htmlToText, escapeHtml,
  splitAttachments, composeBody, isBlank, resumable, avatarOf, parseAddrs, SYNC_MAIL_MS, SYNC_WATCH_MS, attachSig, draftSavePlan,
} from './mail-model.js';
import { okAccount as ok, reconnect, copyAdminNote, DisconnectModal } from './MailAccounts.jsx';
import './mail.css';

// 메일함 주소(10/8) — 조직 공간 메뉴의 메일도 같은 내 개인 메일함이다. 지금 있는 공간의 메일 주소 안에서 움직인다(조직 공간에서 메일을 열어도 내 공간으로 넘어가지 않게)
const MAIL_PATH = /^\/(me|o\/[^/]+)\/mail(\/|$)/;
const mailHome = () => location.pathname.match(/^\/o\/[^/]+\/mail(?=\/|$)/)?.[0] ?? '/me/mail';

registerDict(MAIL_DICT);
const MailEditor = lazy(() => import('./MailEditor.jsx'));          // 서식 편집기 — 작성 창을 열 때만(tiptap)
const CalendarWidget = lazy(() => import('../views/CalendarWidget.jsx')); // 홈 캘린더 모듈 — 일정 단추를 누를 때만

const mailItems = (list) => list.map((m) => ({ kind: 'mail', id: m.id, label: m.subject }));
const domain = (addr) => String(addr ?? '').split('@')[1] ?? '';
const subscribeMailPending = (cb) => { window.addEventListener('office-mail-pending', cb); return () => window.removeEventListener('office-mail-pending', cb); };
const ICON = { inbox: 'inbox', unread: 'mail', starred: 'star', drafts: 'draft', sent: 'send', archive: 'archive' };
const viewName = (v) => t(v === 'unread' || v === 'starred' ? `mailx.${v}` : `mail.${v}`);
const subjectOf = (m) => (m?.subject?.trim() ? m.subject : t('mailx.noSubject'));
const isDraft = (m) => m?.folder === 'drafts';
const touchy = () => matchMedia('(hover: none)').matches; // 터치 기기 — 고르는 중에는 줄을 눌러도 열지 않고 넣고 뺀다
const clock = (ms) => new Date(ms).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ko-KR', { hour: 'numeric', minute: '2-digit' });

/** 요청 제한 남은 초 — 쉬는 동안만 1초마다 다시 그린다 */
function useLimit() {
  const until = useSyncExternalStore(subscribeLimit, getLimitUntil, () => 0);
  const [, tick] = useState(0);
  useEffect(() => { if (until <= Date.now()) return undefined; const id = setInterval(() => { tick((n) => n + 1); if (until <= Date.now()) clearInterval(id); }, 1000); return () => clearInterval(id); }, [until]);
  return limitLeft();
}

function Avatar({ name, addr }) {
  const a = avatarOf(name, addr);
  return <span className={`avatar mail-av tone-${a.tone}`} aria-hidden="true">{a.letter}</span>;
}

function MailRow({ m, active, tag, sel, group, onPick }) {
  // 고른 메일 중 하나를 끌면 고른 것 전부가 크루에게 간다(11차, items)
  const many = group.length > 1 && sel.has(m.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `mail:${m.id}`, data: { kind: 'mail', id: m.id, label: many ? t('sel.count', { n: group.length }) : m.subject, items: many ? group : undefined } });
  const { onTouchStart, ...mouse } = listeners ?? {};
  const draft = isDraft(m);
  const toLine = draft && m.to ? t('mailx.toLine', { to: '\n' }).split('\n') : null;
  const who = toLine ? <>{toLine[0]}{haAddr(m.to)}{toLine[1]}</> : draft ? t('mailx.toNone') : looksLikeAddr(m.from) ? haAddr(m.from) : m.from;
  const on = sel.has(m.id);
  return (
    <div className={`mail-item${m.starred ? ' starred' : ''}`}>
      {/* 고르기(유건 10/9 "이메일 일괄 선택") — 아바타 자리의 체크박스. ⇧ = 마지막으로 누른 줄부터 여기까지 */}
      <label className="mail-check"><input type="checkbox" checked={on} aria-label={t('mailx.pickOne', { subject: subjectOf(m) })} onChange={(e) => onPick(m.id, e.nativeEvent.shiftKey)} /></label>
      <button ref={setNodeRef} type="button" className={`mail-row${active ? ' active' : ''}${m.unread ? ' unread' : ''}${isDragging ? ' ghost' : ''}`}
        {...attributes} {...selProps(sel, m.id)} {...mergeHandlers(mouse, menuProps(() => mailMenu(m)))} role="option" aria-selected={active}
        onClick={() => { if (sel.size && touchy()) { onPick(m.id); return; } navigate(`${mailHome()}/${m.id}`); if (m.unread) setMail(m.id, { unread: false }); }}>
        <Avatar name={draft ? m.to : m.from} addr={draft ? parseAddrs(m.to)[0] : m.addr} />
        <span className="mail-from">{m.unread && <span className="dot mark" />}{who}{draft && <span className="badge">{t('mailx.draft')}</span>}</span>
        <span className="mail-time mono" title={fmtExact(m.at, getLang())}>{ago(m.at)}</span>
        <span className="mail-subject ha">{subjectOf(m)}</span>
        <span className="mail-snippet ha">{tag && <span className="mail-tag">{tag}</span>}{m.snippet ?? m.body?.[0]}</span>
        {m.note && <span className="mail-crew"><Face id={m.note.crew} size={14} />{t('mail.note', { crew: crewName(m.note.crew) })}</span>}
      </button>
      {!draft && <button type="button" className={`mail-star${m.starred ? ' on' : ''}`} aria-pressed={!!m.starred} aria-label={t(m.starred ? 'mailx.unstar' : 'mailx.star')} title={t(m.starred ? 'mailx.unstar' : 'mailx.star')}
        onClick={() => toggleStar(m)}><Icon name="star" size={14} /></button>}
    </div>
  );
}

/** 글자 본문 — 주소(https://…)만 새 창 링크로. HTML을 끼워 넣지 않고 조각마다 그린다 */
function LinkedText({ text }) {
  const parts = useMemo(() => linkify(text), [text]);
  return <div className="reader-body mail-text ha">{parts.map((p, i) => (p.t === 'url' ? <a key={i} href={p.v} target="_blank" rel="noopener noreferrer">{p.v}</a> : p.v))}</div>;
}

const TR_ERR = { offline: 'tr.offline', no_subscription: 'tr.noSub', too_large: 'tr.tooLarge' };

/** 읽기 실패 — 사유, 요청 제한이면 남은 초, 다시 시도 */
function ReadFailed({ err, onRetry }) {
  const left = useLimit();
  const wait = err.code === 'rate_limited' && left > 0;
  return <div className="mail-fail" role="alert">
    <p>{t(wait ? 'mailx.readWait' : err.code === 'expired' ? 'mailx.readExpired' : err.status === 404 ? 'mailx.readGone' : 'mailc.readFailed', { n: left })}</p>
    {err.code !== 'expired' && err.status !== 404 && <button type="button" className="btn sm" disabled={wait} onClick={onRetry}><Icon name="refresh" size={13} />{wait ? t('mailx.sec', { n: left }) : t('mailx.retry')}</button>}
  </div>;
}

function Reader({ m, onBack }) {
  const [c, setC] = useState(null), [err, setErr] = useState(null), [nonce, setNonce] = useState(0);
  const [ask, setAsk] = useState(null); // 임시 보관 메일 보내기·삭제 확인
  // 번역(버튼을 누를 때만) — { busy, done, total, subject, html, text }. 다른 메일로 가면 원문으로
  const [tr, setTr] = useState(null); const [showTr, setShowTr] = useState(false);
  const shown = useRef(m?.id); shown.current = m?.id;                                  // 번역 중에 다른 메일로 가면 늦게 온 결과를 버린다
  const stopTr = useRef(null);                                                          // 번역 중에 다른 메일로 가면 기기에 취소를 보낸다(남은 묶음이 구독 한도를 쓰지 않게)
  useEffect(() => {
    let live = true; setC(null); setErr(null); setTr(null); setShowTr(false);
    if (m) readMail(m).then((x) => live && setC(x), (e) => live && setErr({ code: e?.code, status: e?.status }));
    return () => { live = false; stopTr.current?.abort(); };
  }, [m?.id, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const translate = async () => {
    if (tr && !tr.busy) { setShowTr((v) => !v); return; }
    if (!c || tr?.busy) return;
    const id = m.id;
    setTr({ busy: true, done: 0, total: 0 }); setShowTr(true);
    try {
      const ac = new AbortController(); stopTr.current = ac;
      const { translateMail } = await import('../core/translate.js'); // 번역 버튼을 눌렀을 때만(첫 화면 150KB 상한, 유건 9/26)
      const out = await translateMail(m, c, { signal: ac.signal, onProgress: (p) => { if (shown.current === id) setTr((cur) => (cur?.busy ? { ...p, busy: true } : cur)); } });
      if (shown.current !== id) return;
      setTr(out);
      if (out.partial) showToast(t('tr.partial'));
    } catch (e) { if (shown.current !== id) return; setTr(null); setShowTr(false); if (e.code !== 'cancelled') showToast(t(TR_ERR[e.code] ?? 'tr.failed')); }
  };
  if (!m) return <div className="empty-state"><Icon name="mail" size={20} /><p>{t('mail.select')}</p></div>;
  const draft = isDraft(m), canDraft = !m.account || !!m.draftId; // 검색으로만 받은 초안은 초안 id가 없다 — 임시 보관함에서 열어야 고치고 보낸다
  const write = (mode) => setUi({ compose: { mode, of: m.id } });
  const doDraft = async () => {
    const kind = ask; setAsk(null);
    try {
      if (kind === 'send') { await sendDraft(m); showToast(t('mailc.sent')); } else { await deleteDraft(m); showToast(t('mailx.deleted')); }
      navigate(mailHome());
    } catch { showToast(t('mailx.failed')); }
  };
  const cc = c?.cc;
  return (
    <article className={`reader${m.account ? ' real' : ''} mail-reader-in`}>
      <header className="reader-head">
        <button type="button" className="icon-btn only-narrow" aria-label={t('mail.back')} onClick={onBack}><Icon name="back" /></button>
        <h2 className="ha">{showTr && tr?.subject ? tr.subject : subjectOf(m)}</h2>
        <div className="mail-meta">
          <Avatar name={draft ? m.to : m.from} addr={draft ? parseAddrs(m.to)[0] : m.addr} />
          <div className="mail-meta-main">
            {draft ? <div className="reader-meta"><b>{t('mailx.draft')}</b></div>
              : <div className="reader-meta"><b>{looksLikeAddr(m.from) ? <Hide k={`mail:addr:${m.addr}`}>{m.from}</Hide> : m.from}</b><span className="dim">&lt;<Hide k={`mail:addr:${m.addr}`}>{m.addr}</Hide>&gt;</span></div>}
            <dl className="mail-heads">
              {(m.to || draft) && <><dt>{t('mailx.to')}</dt><dd>{m.to ? <Hide k={`mail:to:${m.id}`}>{m.to}</Hide> : t('mailx.toNone')}</dd></>}
              {cc && <><dt>{t('mailx.cc')}</dt><dd><Hide k={`mail:cc:${m.id}`}>{cc}</Hide></dd></>}
            </dl>
          </div>
          <time className="dim small mail-date" dateTime={m.at} title={ago(m.at)}>{fmtExact(m.at, getLang())}</time>
        </div>
        <div className="reader-actions">
          {draft ? <>
            <button type="button" className="btn primary" disabled={!canDraft} onClick={() => write('draft')}><Icon name="draft" size={14} />{t('mailx.edit')}</button>
            <button type="button" className="btn" disabled={!m.to || !canDraft} onClick={() => setAsk('send')}><Icon name="send" size={14} />{t('mail.send')}</button>
            <button type="button" className="btn ghost" disabled={!canDraft} onClick={() => setAsk('delete')}><Icon name="trash" size={14} />{t('mailx.deleteDraft')}</button>
          </> : <>
            <button type="button" className="btn primary" onClick={() => setUi({ assign: { space: 'me', items: [{ kind: 'mail', id: m.id, label: m.subject }] } })}><Icon name="hand" size={14} />{t('crew.assign')}</button>
            <button type="button" className="btn" onClick={() => write('reply')}><Icon name="reply" size={14} />{t('mail.reply')}</button>
            <button type="button" className="btn" onClick={() => write('replyAll')}><Icon name="reply" size={14} />{t('mailx.replyAll')}</button>
            <button type="button" className="btn" onClick={() => write('forward')}><Icon name="send" size={14} />{t('mail.forward')}</button>
            {m.account && <button type="button" className={`btn${showTr && tr && !tr.busy ? ' on' : ''}`} disabled={!c || tr?.busy} aria-pressed={showTr && !!tr && !tr.busy} onClick={translate}>
              <Icon name="globe" size={14} />{tr?.busy ? t('tr.busy', { n: tr.done, t: tr.total || '…' }) : showTr && tr ? t('tr.original') : t('tr.translate')}
            </button>}
            <button type="button" className={`icon-btn mail-star-btn${m.starred ? ' on' : ''}`} aria-pressed={!!m.starred} aria-label={t(m.starred ? 'mailx.unstar' : 'mailx.star')} title={t(m.starred ? 'mailx.unstar' : 'mailx.star')} onClick={() => toggleStar(m)}><Icon name="star" /></button>
            {m.folder !== 'archive' && <button type="button" className="btn" onClick={() => { const undo = archiveMail(m.id); showToast(t('mail.archived'), { undo }); navigate(mailHome()); }}><Icon name="archive" size={14} />{t('mail.archiveIt')}</button>}
            <button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => openMenu(e, mailMenu(m), { anchor: e.currentTarget })}><Icon name="dots" /></button>
          </>}
        </div>
      </header>
      {m.note && (
        <section className="crew-note">
          <div className="crew-note-head"><Face id={m.note.crew} size={18} /><b>{t('mail.note', { crew: crewName(m.note.crew) })}</b></div>
          <p className="ha">{m.note.summary}</p>
          <ul className="ha">{m.note.todos.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      )}
      {err ? <ReadFailed err={err} onRetry={() => setNonce((n) => n + 1)} />
        : !c ? <p className="dim mail-loading">{t('mailc.loading')}</p>
          : <>
            {c.attachments.length > 0 && <div className="chips mail-atts">{c.attachments.map((a) => (
              <button key={a.id} type="button" className="chip" onClick={() => openAttachment(m, a).catch(() => showToast(t('mailc.readFailed')))}><Icon name="file" size={12} /><span className="ha">{a.name}</span><small className="mono">{fmtBytes(a.size)}</small></button>
            ))}</div>}
            {(showTr ? tr?.html : null) ?? c.html
              ? <div className="ha ha-box"><iframe className="mail-frame" title={subjectOf(m)} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={mailDoc((showTr ? tr?.html : null) ?? c.html, { paper: mailPaper() })} /></div>
              : <LinkedText text={(showTr ? tr?.text : null) ?? c.text ?? m.snippet ?? ''} />}
          </>}
      <Modal open={!!ask} onClose={() => setAsk(null)} title={t(ask === 'send' ? 'mailx.sendDraftTitle' : 'mailx.deleteTitle')}
        footer={<><button type="button" className="btn" onClick={() => setAsk(null)}>{t('cancel')}</button><button type="button" className={`btn ${ask === 'send' ? 'primary' : 'danger'}`} onClick={doDraft}>{t(ask === 'send' ? 'mail.send' : 'mailx.deleteDraft')}</button></>}>
        {ask === 'send' ? <p><HideIn text={t('mailx.toLine', { to: '\n' })} kind="contact">{m.to}</HideIn><br /><span className="dim ha">{subjectOf(m)}</span></p> : <p>{t('mailx.deleteBody')}</p>}
      </Modal>
    </article>
  );
}

/* ── 작성 창 ── */

/** 새 메일 알림 — 다른 화면에서도 오피스가 보이는 동안만(60초). 메일 화면은 자기 30초 주기를 쓴다(core/mail.js wantSync가 하나로 묶는다) */
function useMailWatch(mode) {
  const on = useSyncExternalStore(subscribeNotify, notifyOn, () => false);
  useEffect(() => (on && (mode === 'signedIn' || mode === 'sample') ? wantSync('watch', { ms: SYNC_WATCH_MS, notify: true }) : undefined), [on, mode]);
}

/** 작성 창 자리 — 앱에 늘 하나(App.jsx가 지연 로드해 붙인다). 새로고침 전에 쓰던 메일이 이 기기에 남아 있으면 이어서 연다 */
export function Compose() {
  useLang();
  const { compose } = useUi();
  const mode = useSession();
  useMailWatch(mode);
  const resumed = useRef(null);
  useEffect(() => {
    if ((mode !== 'signedIn' && mode !== 'sample') || resumed.current === mode) return;
    resumed.current = mode;
    const snap = readSnap();
    if (getUi().compose || !resumable(snap)) return;
    setUi({ compose: { mode: 'resume', snap } });
    showToast(t(snap.hadFiles ? 'mailx.resumedFiles' : 'mailx.resumed'));
  }, [mode]);
  // 새로 열 때마다(작성 내용 객체가 바뀔 때마다) 창을 새로 — 같은 창이 다시 그려질 때는 그대로
  const opened = useRef({ spec: null, n: 0 });
  if (compose && opened.current.spec !== compose) opened.current = { spec: compose, n: opened.current.n + 1 };
  return compose ? <ComposeWindow key={opened.current.n} spec={compose} real={mode === 'signedIn'} /> : null;
}

const TITLE = { new: 'mail.compose', reply: 'mailx.reply', replyAll: 'mailx.replyAll', forward: 'mailx.forward', draft: 'mailx.editDraft' };

function ComposeWindow({ spec, real }) {
  const accounts = useStore((s) => s.mailAccounts);
  const usable = useMemo(() => (accounts ?? []).filter(ok), [accounts]);
  const snap = spec.mode === 'resume' ? spec.snap : null;
  const kind = snap?.mode ?? spec.mode ?? 'new';
  const src = useMemo(() => (spec.of ? getState().mails.find((m) => m.id === spec.of) : null), [spec.of]);
  const [f, setF] = useState(() => ({
    from: snap?.account ?? spec.account ?? src?.account ?? usable[0]?.id ?? '',
    to: snap?.to ?? spec.to ?? (kind === 'reply' && src ? replyTo(src, usable.find((a) => a.id === src.account)?.address) : kind === 'draft' ? src?.to ?? '' : ''),
    cc: snap?.cc ?? '', subject: snap?.subject ?? spec.subject ?? (src ? (kind === 'forward' ? forwardSubject(src.subject) : kind === 'draft' ? src.subject ?? '' : replySubject(src.subject)) : ''),
    html: snap?.html ?? '',
  }));
  const [showCc, setShowCc] = useState(!!snap?.cc);
  const [ref, setRef] = useState(() => ({ // 스레드·원문 — 원래 메일을 읽은 뒤 채운다
    threadId: snap?.threadId ?? (kind === 'forward' ? null : src?.threadId ?? spec.threadId ?? null), inReplyTo: snap?.inReplyTo ?? null, references: snap?.references ?? null,
    draftId: snap?.draftId ?? (kind === 'draft' ? src?.draftId ?? null : null), quote: snap?.quote ?? null, carry: snap?.carry ?? [], carryFrom: snap?.carryFrom ?? null,
  }));
  const [quoteOn, setQuoteOn] = useState(snap?.quoteOn ?? true);
  const [ready, setReady] = useState(!src || !!snap || kind !== 'draft'); // 초안 고치기만 본문을 읽은 뒤 편집기를 연다(초안 본문이 편집기에 들어가야 한다) — 답장·전달의 원문은 편집기 밖에 따로
  const [files, setFiles] = useState([]), [over, setOver] = useState(false);
  const [save, setSave] = useState({ state: 'idle', at: null });
  const [step, setStep] = useState('edit'); // edit | confirm | discard | sending
  const [progress, setProgress] = useState(null), [failMsg, setFailMsg] = useState('');
  const input = useRef(null), uploaded = useRef(new Map()); // 보내다 실패해 다시 보낼 때 이미 문서함에 올린 큰 파일은 다시 올리지 않는다
  const dirty = useRef(!!snap?.dirty), saving = useRef(null), timer = useRef(null), closed = useRef(false);
  const savedSig = useRef(null); // 임시 보관함 초안에 지금 들어 있는 첨부(attachSig) — 모르면 null(다음 저장은 첨부까지)
  const latest = useRef(null);
  latest.current = { f, ref, quoteOn, files };

  // 원래 메일 읽기 — 답장(인용)·전체 회신(참조)·전달(인용·원문 첨부)·초안 고치기(본문·첨부)
  useEffect(() => {
    if (!src || snap) return undefined;
    let live = true;
    readMail(src).then((c) => {
      if (!live) return;
      const me = usable.find((a) => a.id === src.account)?.address ?? (src.account ? '' : ME.email);
      if (kind === 'draft') {
        setF((x) => ({ ...x, cc: c.cc ?? '', html: c.html ?? (c.text ? `<p>${escapeHtml(c.text).replace(/\n/g, '<br>')}</p>` : '') }));
        if (c.cc) setShowCc(true);
        setRef((r) => ({ ...r, threadId: src.threadId ?? null, inReplyTo: c.inReplyTo || null, references: c.references || null, quote: null, carry: c.attachments ?? [], carryFrom: src.account && c.attachments?.length ? { from: 'draft', id: src.draftId } : null }));
        savedSig.current = attachSig([], c.attachments ?? []); // 고칠 초안에는 이 첨부가 이미 있다 — 글만 고치면 첨부를 다시 올리지 않는다
      } else {
        if (kind === 'replyAll') { const r = replyAll(src, c.cc, me); setF((x) => ({ ...x, to: r.to, cc: r.cc })); if (r.cc) setShowCc(true); }
        const quote = kind === 'forward' ? forwardBlock(src, c, getLang()) : quoteBlock(src, c, getLang());
        setRef((r) => ({ ...r, inReplyTo: kind === 'forward' ? null : c.messageId || null, references: kind === 'forward' ? null : c.references || null, quote,
          carry: kind === 'forward' ? c.attachments ?? [] : [], carryFrom: kind === 'forward' && src.account && c.attachments?.length ? { from: 'message', id: src.gid } : null }));
      }
      setReady(true);
    }, () => { if (live) { setReady(true); showToast(t('mailc.readFailed')); } });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const split = useMemo(() => splitAttachments(files, ATTACH_CAP), [files]);
  const ownText = htmlToText(f.html).trim();
  const toList = parseAddrs(f.to), ccList = parseAddrs(f.cc);
  const hasBody = !!ownText || (kind === 'forward' && quoteOn && !!ref.quote);
  const toBad = !!f.to.trim() && !toList.length;
  const blocked = (real && !f.from) ? 'mailc.noAccount' : !toList.length ? (toBad ? 'mailx.badTo' : 'mailx.needTo') : !hasBody ? 'mailx.needBody' : null;

  /** 지금 내용으로 보낼(저장할) 메시지 — links: 문서함 링크(보낼 때만) */
  const message = async ({ links = [], attach = latest.current.files } = {}) => {
    const { f: v, ref: r, quoteOn: q } = latest.current;
    const body = composeBody({ html: v.html, quote: q ? r.quote : null, links }, getLang());
    return { account: v.from, from: usable.find((a) => a.id === v.from)?.address, to: v.to, cc: v.cc, subject: v.subject, text: body.text, html: body.html,
      threadId: r.threadId ?? undefined, inReplyTo: r.inReplyTo ?? undefined, references: r.references ?? undefined, draftId: r.draftId ?? undefined,
      attachments: await Promise.all(attach.map(fileToPart)), ...(r.carryFrom && r.carry.length ? { carry: r.carryFrom, keep: r.carry.map((a) => ({ name: a.name, size: a.size })) } : {}) };
  };
  const snapshot = () => {
    const { f: v, ref: r, quoteOn: q, files: fl } = latest.current;
    return { v: 1, at: Date.now(), mode: kind, of: spec.of ?? null, account: v.from, to: v.to, cc: v.cc, subject: v.subject, html: v.html, threadId: r.threadId, inReplyTo: r.inReplyTo,
      references: r.references, draftId: r.draftId, quote: r.quote, quoteOn: q, carry: r.carry, carryFrom: r.carryFrom, hadFiles: fl.length > 0, dirty: dirty.current };
  };
  /** 임시 보관함에 저장 — 한 번에 하나(겹치면 초안이 두 통 생긴다). 빈 메일은 저장하지 않는다. 성공 여부를 돌려준다.
   *  final: 닫을 때 — 첨부가 있으면 첨부까지 저장한다. 자동 저장은 첨부가 지난번 저장 그대로면 Gmail에 쓰지 않고 이 기기에만 남긴다(draftSavePlan) */
  const flushSave = useCallback(async (final = false) => {
    clearTimeout(timer.current);
    while (saving.current) await saving.current;
    if (!dirty.current) return true;
    const { f: v, ref: r } = latest.current;
    if (isBlank({ ...v, carry: r.carry, files: latest.current.files.length }) && !r.draftId) { dirty.current = false; return true; }
    if (real && !v.from) return false;
    const attach = splitAttachments(latest.current.files, ATTACH_CAP).attach; // 큰 파일(링크로 갈 것)은 보낼 때만 올린다
    const plan = draftSavePlan({ files: attach, carry: r.carry, savedSig: savedSig.current, final });
    if (plan.kind === 'local') { saveSnap(snapshot()); setSave({ state: 'local', at: Date.now() }); return true; } // 바뀐 것이 남았다(dirty) — 닫을 때 첨부까지 저장
    dirty.current = false;
    setSave({ state: 'saving', at: null });
    const run = (async () => {
      try {
        const out = await saveDraft(await message({ attach }));
        savedSig.current = plan.sig;
        const moved = (x) => ({ ...x, draftId: out.draftId ?? x.draftId, ...(x.carryFrom ? { carryFrom: { from: 'draft', id: out.draftId ?? x.draftId } } : {}) }); // 원문 첨부는 이제 초안에 있다 — 다음 저장은 초안에서 싣는다
        setRef(moved);
        latest.current.ref = moved(latest.current.ref); // 다시 그리기 전에 이어지는 저장·보내기도 새 값을 쓰게
        setSave({ state: 'saved', at: Date.now() });
        return true;
      } catch { dirty.current = true; setSave({ state: 'error', at: null }); return false; }
    })();
    saving.current = run;
    const okSave = await run;
    saving.current = null;
    if (!closed.current) saveSnap(snapshot());
    return okSave;
  }, [real]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 손댈 때마다 — 이 기기에 바로 남기고, 멈추면 임시 보관함에(첨부가 있으면 덜 자주) */
  const touch = () => {
    dirty.current = true;
    setTimeout(() => { if (!closed.current) saveSnap(snapshot()); }, 0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flushSave(); }, latest.current.files.length || latest.current.ref.carry.length ? 5000 : 1500);
  };
  const edit = (k) => (e) => { const val = e.target.value; setF((x) => ({ ...x, [k]: val })); touch(); };
  useEffect(() => { if (snap?.dirty) timer.current = setTimeout(() => { flushSave(); }, 1500); return () => clearTimeout(timer.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (step === 'confirm') document.querySelector('.modal [data-autofocus]')?.focus(); }, [step]); // 확인 단계에서는 보내기에 초점(Enter로 보낸다)

  const close = async () => {
    if (step === 'sending') return;
    closed.current = true;
    setUi({ compose: null });
    const had = !!latest.current.ref.draftId || dirty.current;
    const okSave = await flushSave(true); // 닫을 때는 첨부까지 임시 보관함에
    if (!okSave) { saveSnap({ ...snapshot(), dirty: true }); showToast(t('mailx.closedFailed')); return; }
    clearSnap();
    if (had && latest.current.ref.draftId) {
      showToast(t('mailx.closedSaved'));
      if (real && readView() === 'drafts' && MAIL_PATH.test(location.pathname)) pullMail('drafts').catch(() => {}); // 임시 보관함을 보고 있으면 방금 저장한 초안이 보이게
    }
  };
  const discard = async () => {
    closed.current = true; clearTimeout(timer.current);
    while (saving.current) await saving.current;
    setUi({ compose: null }); clearSnap();
    const id = latest.current.ref.draftId;
    if (id) await deleteDraft({ id: getState().mails.find((m) => m.draftId === id)?.id ?? `draft:${id}`, account: real ? latest.current.f.from : undefined, draftId: id }).catch(() => {});
    showToast(t('mailx.discarded'));
  };
  const add = (list) => {
    const okFiles = list.filter((x) => x.size <= MAX_FILE);
    if (okFiles.length < list.length) showToast(t('mailx.tooBigFile'));
    if (!okFiles.length) return;
    setFiles((cur) => [...cur, ...okFiles]); touch();
  };
  const removeFile = (i) => { setFiles((cur) => cur.filter((_, j) => j !== i)); touch(); };
  const removeCarry = (i) => { setRef((r) => ({ ...r, carry: r.carry.filter((_, j) => j !== i) })); touch(); };

  const send = async () => {
    setStep('sending'); setFailMsg('');
    clearTimeout(timer.current);
    while (saving.current) await saving.current; // 저장 중인 초안이 끝난 뒤 그 초안을 지우며 보낸다
    const { attach, link } = splitAttachments(latest.current.files, ATTACH_CAP);
    const links = [];
    if (link.length) {
      const [{ uploadOne }, { createLink, LINK_DAYS }, { FILES_DICT }] = await Promise.all([import('../files/api.js'), import('../files/links.js'), import('../files/files-i18n.js')]);
      registerDict(FILES_DICT); // 올리기 실패 이유 문구(문서함 사전)
      for (let i = 0; i < link.length; i++) {
        setProgress({ n: i + 1, t: link.length });
        if (uploaded.current.has(link[i])) { links.push(uploaded.current.get(link[i])); continue; }
        const up = await uploadOne('me', link[i], { source: 'mail', ocr: false }).catch(() => ({ ok: false, reason: 'request' }));
        if (!up.ok) { setProgress(null); setStep('edit'); setFailMsg(t('mailx.uploadFailed', { why: `${link[i].name}: ${t(`files.reason.${up.reason}`) !== `files.reason.${up.reason}` ? t(`files.reason.${up.reason}`) : t(`files.err.${up.reason}`)}` })); return; }
        try { const l = await createLink('me', up.file, { days: LINK_DAYS, source: 'mail' }); const one = { name: link[i].name, size: link[i].size, url: l.url }; uploaded.current.set(link[i], one); links.push(one); }
        catch { setProgress(null); setStep('edit'); setFailMsg(t('mailx.uploadFailed', { why: link[i].name })); return; }
      }
      setProgress(null);
    }
    try {
      await sendMail(await message({ links, attach }));
      closed.current = true; clearSnap(); setUi({ compose: null });
      showToast(links.length ? t('mailx.sentLinks', { n: links.length }) : t('mailc.sent'));
      if (real) pullMail('sent').catch(() => {}); // 보낸편지함에 바로 보이게(15차 C12)
    } catch { setStep('edit'); setFailMsg(t('mailc.sendFailed')); }
  };
  const toConfirm = () => { if (!blocked) setStep('confirm'); };

  const linkBytes = split.link.reduce((n, x) => n + x.size, 0);
  const status = save.state === 'saving' ? t('mailx.saving') : save.state === 'saved' ? t('mailx.savedAt', { time: clock(save.at) }) : save.state === 'local' ? t('mailx.savedLocal', { time: clock(save.at) }) : save.state === 'error' ? t('mailx.saveFailed') : '';
  const footer = step === 'confirm' || step === 'sending' ? <>
    <span className="dim small mail-sum">{[t('mailx.sum.to', { n: toList.length }), ccList.length && t('mailx.sum.cc', { n: ccList.length }),
      split.attach.length + ref.carry.length ? t('mailx.sum.att', { n: split.attach.length + ref.carry.length }) : !split.link.length && t('mailx.sum.noAtt'),
      split.link.length && t('mailx.sum.link', { n: split.link.length })].filter(Boolean).join(' · ')}</span>
    <button type="button" className="btn" disabled={step === 'sending'} onClick={() => setStep('edit')}>{t('mailx.back')}</button>
    <button type="button" className="btn primary" disabled={step === 'sending'} onClick={send} data-autofocus><Icon name="send" size={14} />{step === 'sending' ? (progress ? t('mailx.uploading', progress) : t('mailx.sending')) : t('mail.send')}</button>
  </> : step === 'discard' ? <>
    <button type="button" className="btn" onClick={() => setStep('edit')}>{t('mailx.back')}</button>
    <button type="button" className="btn danger" onClick={discard}>{t('mailx.discard')}</button>
  </> : <>
    <span className="dim small mail-save" role="status">{status}</span>
    {(ref.draftId || dirty.current) && <button type="button" className="btn ghost" onClick={() => setStep('discard')}><Icon name="trash" size={14} />{t('mailx.discard')}</button>}
    <button type="button" className="btn primary" disabled={!!blocked} title={blocked ? t(blocked) : undefined} onClick={toConfirm}><Icon name="send" size={14} />{t('mail.send')}</button>
  </>;
  return (
    <Modal open onClose={close} title={step === 'confirm' || step === 'sending' ? t('mailx.confirmTitle') : step === 'discard' ? t('mailx.discardTitle') : t(TITLE[kind] ?? 'mail.compose')} width={680} footer={footer}>
      {step === 'confirm' || step === 'sending' ? <div className="mail-confirm">
        <p><b>{f.subject.trim() || t('mailx.noSubject')}</b></p>
        <dl className="mail-heads"><dt>{t('mailx.to')}</dt><dd>{toList.join(', ')}</dd>{ccList.length > 0 && <><dt>{t('mailx.cc')}</dt><dd>{ccList.join(', ')}</dd></>}</dl>
        {split.link.length > 0 && <p className="dim small">{t('mailx.bigNote', { n: split.link.length, size: fmtBytes(linkBytes), days: 30 })}</p>}
      </div> : step === 'discard' ? <p>{t('mailx.discardBody')}</p> : (
        <div className={`compose mail-compose${over ? ' file-over' : ''}`} onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
          onDrop={(e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setOver(false); add(filesFromTransfer(e.dataTransfer)); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); toConfirm(); } }}>
          {real && usable.length > 1 && (
            <label className="field"><span>{t('mailc.from')}</span>
              <select value={f.from} onChange={edit('from')}>{usable.map((a) => <option key={a.id} value={a.id}>{a.address}</option>)}</select>
            </label>
          )}
          <label className="field"><span>{t('mail.to')}</span><span className="mail-to-row"><input value={f.to} onChange={edit('to')} {...imeGuardWith()} aria-invalid={toBad || undefined} />
            {!showCc && <button type="button" className="link-btn small" onClick={() => setShowCc(true)}>{t('mailx.addCc')}</button>}</span></label>
          {showCc && <label className="field"><span>{t('mailc.cc')}</span><input value={f.cc} onChange={edit('cc')} {...imeGuardWith()} /></label>}
          <label className="field"><span>{t('mail.subject')}</span><input value={f.subject} onChange={edit('subject')} {...imeGuardWith()} /></label>
          {ready ? <Suspense fallback={<div className="mail-editor loading" aria-busy="true" />}>
            <MailEditor initial={f.html} placeholder={t('mailx.placeholder')} autoFocus={kind !== 'new' && kind !== 'forward'} onSubmit={toConfirm}
              onChange={(html) => { setF((x) => ({ ...x, html })); touch(); }} />
          </Suspense> : <div className="mail-editor loading" aria-busy="true"><p className="dim small">{t('mailx.quoteLoading')}</p></div>}
          {(ref.quote || (src && !ready && kind !== 'draft')) && <div className="mail-quote">
            <div className="mail-quote-head"><span className="label">{t('mailx.quote')}</span>
              {ref.quote && <button type="button" className="link-btn small" onClick={() => { setQuoteOn((v) => !v); touch(); }}>{t(quoteOn ? 'mailx.quoteHide' : 'mailx.quoteShow')}</button>}</div>
            {!ref.quote ? <p className="dim small">{t('mailx.quoteLoading')}</p> : quoteOn && <pre className="mail-quote-body">{ref.quote.text}</pre>}
          </div>}
          <div className="mail-attach-row">
            <button type="button" className="btn sm" onClick={() => input.current?.click()}><Icon name="attach" size={13} />{t('mailx.attach')}</button>
            <span className="dim small">{t('mailx.attachHint')}</span>
            <input ref={input} type="file" multiple hidden onChange={(e) => { const l = [...e.target.files]; e.target.value = ''; add(l); }} />
          </div>
          {(files.length > 0 || ref.carry.length > 0) && <div className="chips mail-files">
            {ref.carry.map((a, i) => <span key={`c${i}`} className="chip"><Icon name="file" size={12} />{a.name}<small className="mono">{fmtBytes(a.size)}</small><span className="badge">{t('mailx.original')}</span>
              <button type="button" className="chip-x" aria-label={t('mailx.remove', { name: a.name })} onClick={() => removeCarry(i)}><Icon name="x" size={11} /></button></span>)}
            {files.map((x, i) => <span key={i} className="chip"><Icon name="file" size={12} />{x.name}<small className="mono">{fmtBytes(x.size)}</small>{split.link.includes(x) && <span className="badge">{t('mailx.asLink')}</span>}
              <button type="button" className="chip-x" aria-label={t('mailx.remove', { name: x.name })} onClick={() => removeFile(i)}><Icon name="x" size={11} /></button></span>)}
          </div>}
          {split.link.length > 0 && <p className="mail-note small" role="status"><Icon name="link" size={13} />{t('mailx.bigNote', { n: split.link.length, size: fmtBytes(linkBytes), days: 30 })}</p>}
          {failMsg && <p className="bizui-error small" role="alert">{failMsg}</p>}
          {over && <div className="drop-hint">{t('mail.dropHere')}</div>}
        </div>
      )}
    </Modal>
  );
}

/** 계정이 없을 때 — Google로 연결(로그인 → 권한 승인), 회사 계정이 막혔을 때의 안내문 */
function ConnectPanel() {
  const [cfg, setCfg] = useState(undefined), [again, setAgain] = useState(0);
  useEffect(() => { let live = true; mailConfig().then((c) => live && setCfg(c)); return () => { live = false; }; }, [again]);
  return (
    <div className="empty-state mail-connect">
      <Icon name="mail" size={22} />
      <h3>{t('mailc.title')}</h3>
      <p className="dim small">{t('mailc.sub')}</p>
      {cfg?.failed ? <LoadFail small onRetry={() => { setCfg(undefined); setAgain((n) => n + 1); }} /> : cfg !== undefined && (cfg?.google
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
      .then(async ({ address }) => { await loadAccounts(); showToast(t('mailc.connected', { addr: address })); navigate(takeMailReturn(), { replace: true }); })
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
          <button type="button" className="btn" onClick={() => navigate(takeMailReturn(), { replace: true })}>{t('mail.back')}</button>
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
            <span className={`dot ${ok(a) ? 'ok' : 'ask'}`} /><span className="ellip"><Hide k={`mail:acct:${a.address}`} focusable={false}>{a.address}</Hide></span>{a.hosted_domain && <small className="badge">{t('mailc.work')}</small>}
          </button>
          {!ok(a) && <button type="button" className="link-btn small" onClick={() => reconnect(a)}>{t('mailc.reconnect')}</button>}
          <button type="button" className="icon-btn sm" aria-label={t('more')} onClick={(e) => openMenu(e, menu(a), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
        </div>
      ))}
      <button type="button" className="nav-item dim" onClick={() => reconnect()}><Icon name="plus" /><span className="nav-label">{t('mailc.add')}</span></button>
      <DisconnectModal account={bye} onClose={() => setBye(null)} />
    </div>
  );
}

/** 메일 옆 일정 — 홈 캘린더 모듈을 그대로(다음 일정·오늘·달력). 보기는 이 기기에 기억한다 */
const CAL_VIEWS = [['next', 'mailx.calNext'], ['day', 'mailx.calDay'], ['mini', 'mailx.calMini']];
function CalendarAside({ onClose }) {
  const [view, setView] = useState(() => { try { return localStorage.getItem('argo-office-mail-cal') || 'next'; } catch { return 'next'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem('argo-office-mail-cal', v); } catch { /* 저장소 없음 */ } };
  return <aside className="mail-cal" aria-label={t('mailx.calendar')}>
    <div className="mail-cal-head"><b>{t('mailx.calendar')}</b>
      <div className="seg">{CAL_VIEWS.map(([v, k]) => <button key={v} type="button" className={`seg-btn${view === v ? ' on' : ''}`} aria-pressed={view === v} onClick={() => pickView(v)}>{t(k)}</button>)}</div>
      <button type="button" className="icon-btn sm" aria-label={t('mailx.calClose')} onClick={onClose}><Icon name="x" size={14} /></button></div>
    <div className="mail-cal-body"><Suspense fallback={<div className="skeleton-lines"><span /><span /><span /></div>}>
      <CalendarWidget key={view} space="me" item={{ id: `mail-cal-${view}`, cfg: { views: { view } } }} canEdit={false} />
    </Suspense></div>
  </aside>;
}

export function Mail({ id }) {
  const connecting = useSyncExternalStore(subscribeMailPending, desktopMailPending, () => false);
  useLang();
  const mode = useSession(), real = mode === 'signedIn';
  const mails = useStore((s) => s.mails);
  const accounts = useStore((s) => s.mailAccounts) ?? [];
  const [view, setViewState] = useState(() => firstView(VIEWS)); // 홈 '확인 못 함' 카드는 받은편지함으로 연다(?view=inbox, R3-L5)
  const setView = (v) => { setViewState(v); writeView(v); };
  const [pick, setPick] = useState('all');
  const [loading, setLoading] = useState(false), [moreBusy, setMoreBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [qInput, setQInput] = useState(''), [search, setSearch] = useState(null); // search: { q, ids, busy, some(일부 실패) }
  const [cal, setCal] = useState(() => { try { return localStorage.getItem('argo-office-mail-cal-open') === '1'; } catch { return false; } });
  const toggleCal = () => setCal((v) => { try { localStorage.setItem('argo-office-mail-cal-open', v ? '0' : '1'); } catch { /* 저장소 없음 */ } return !v; });
  const [listW, setListW] = useWidth('argo-office-mail-list', 360, 280, 560);
  const [ready, setReady] = useState(!real);
  const [failN, setFailN] = useState(0), [again, setAgain] = useState(0); // 메일을 못 받은 계정 수(만료 빼고) — 조용히 넘기지 않고 알린다(OFC-08)
  const inboxOk = useStore((s) => s.mailError === null);
  useEffect(() => { if (view === 'inbox' && inboxOk) setFailN(0); }, [view, inboxOk]); // 자동 갱신이 받은편지함을 다시 받아 회복하면 실패 띠도 내린다(R3-L5)
  const left = useLimit();
  useSyncExternalStore(subscribeSync, lastSynced, () => 0);
  const searchRef = useRef(null);
  useEffect(() => { if (real) loadAccounts().catch(() => {}).finally(() => setReady(true)); else seedSample(); }, [real]);
  const accKey = accounts.filter(ok).map((a) => a.id).join(',');
  useEffect(() => {
    if (!real || !accKey) return undefined;
    let live = true; setLoading(true);
    pullMail(view).then((r) => { if (live) setFailN(hardFails(r?.failed)); }, () => { if (live) setFailN(accounts.filter(ok).length); }).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [real, view, accKey, again]);
  // 자동 갱신 — 이 화면이 보이는 동안 30초마다 바뀐 것만(숨긴 탭은 멈춘다, core/mail.js)
  useEffect(() => wantSync('mail', { ms: SYNC_MAIL_MS, view }), [view]);

  const rows = useMemo(() => {
    if (search) return search.ids.map((x) => mails.find((m) => m.id === x)).filter((m) => m && m.folder !== 'trash' && (pick === 'all' || m.account === pick)).sort(byDate);
    return mails.filter((m) => inView(m, view, pick)).sort(byDate);
  }, [mails, view, pick, search]);
  const cur = mails.find((m) => m.id === id);
  useEffect(() => { if (cur?.unread) setMail(cur.id, { unread: false }); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async (raw) => {
    const q = raw.trim();
    if (!q) { setSearch(null); return; }
    setSearch({ q, ids: [], busy: true });
    try { const r = await pullMail(view, { q }); setSearch({ q, ids: r.ids, busy: false, some: r.failed?.length > 0, more: r.more }); }
    catch { setSearch({ q, ids: [], busy: false, some: true }); }
  };
  const clearSearch = () => { setQInput(''); setSearch(null); };
  const refresh = async () => {
    if (left > 0 || refreshing) return;
    setRefreshing(true);
    try {
      const before = getState().mails.length;
      if (search) { await syncMail({ view }).catch(() => {}); await runSearch(search.q); } else setFailN(hardFails((await refreshMail(view))?.failed)); // 새로고침이 되면 실패 띠도 맞춘다
      if (!search && getState().mails.length === before && !real) showToast(t('mailx.noNew'));
    }
    catch { showToast(t('mailx.failed')); } finally { setRefreshing(false); }
  };
  const more = async () => {
    setMoreBusy(true);
    try {
      const r = await pullMail(view, { more: true, ...(search ? { q: search.q } : {}) });
      if (search) setSearch((s) => ({ ...s, ids: [...new Set([...s.ids, ...r.ids])], more: r.more }));
    } catch { showToast(t('mailx.failed')); } finally { setMoreBusy(false); }
  };
  const canMore = real && (search ? search.more : hasMore(view));

  // 목록 키보드: j/k 이동, e 보관, r 답장, s 별표, / 검색(입력 중이 아닐 때만)
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || getUi().compose) return;
      const i = rows.findIndex((m) => m.id === id);
      if (e.key === 'j' || e.key === 'k') { const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))]; if (next) { navigate(`${mailHome()}/${next.id}`); if (next.unread) setMail(next.id, { unread: false }); } }
      if (e.key === 'e' && cur && cur.folder !== 'archive' && !isDraft(cur)) { const undo = archiveMail(cur.id); showToast(t('mail.archived'), { undo }); }
      if (e.key === 'r' && cur && !isDraft(cur)) setUi({ compose: { mode: 'reply', of: cur.id } });
      if (e.key === 's' && cur && !isDraft(cur)) toggleStar(cur);
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, id, cur]);
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v, mails.filter((m) => inView(m, v, pick) && (v === 'drafts' || v === 'starred' ? true : m.unread)).length])), [mails, pick]);
  // 여러 개 고르기(11차) — 메일 메뉴의 단일 동작(읽음·안 읽음·보관·맡기기)을 고른 메일 전부에. 보관은 토스트 '되돌리기' 한 번으로 전부
  const keys = useMemo(() => rows.map((m) => m.id), [rows]);
  const [sel, setSel] = useSelection('mail', { keys, actions: (picked) => {
    const list = rows.filter((m) => picked.includes(m.id)), done = (fn) => (_, clear) => { fn(); clear(); };
    const nonDrafts = list.filter((m) => !isDraft(m)); // 초안은 별표·보관이 없다(목록 줄·읽기 화면과 같은 규칙)
    return [
      list.some((m) => m.unread) && { label: t('mail.markRead'), icon: 'mail', run: done(() => list.forEach((m) => m.unread && setMail(m.id, { unread: false }))) },
      list.every((m) => !m.unread) && { label: t('mail.markUnread'), icon: 'mail', run: done(() => list.forEach((m) => setMail(m.id, { unread: true }))) },
      nonDrafts.length > 0 && !nonDrafts.every((m) => m.starred) && { label: t('mailx.star'), icon: 'star', run: done(() => nonDrafts.forEach((m) => !m.starred && toggleStar(m))) },
      list.every((m) => m.starred) && { label: t('mailx.unstar'), icon: 'star', run: done(() => list.forEach((m) => toggleStar(m))) },
      view !== 'archive' && nonDrafts.length > 0 && { label: t('mail.archiveIt'), icon: 'archive', run: done(() => { const undos = nonDrafts.map((m) => archiveMail(m.id)); showToast(t('sel.archived', { n: nonDrafts.length }), { undo: () => undos.forEach((u) => u?.()) }); if (nonDrafts.some((m) => m.id === id)) navigate(mailHome()); }) },
      { label: t('crew.assign'), icon: 'hand', run: done(() => setUi({ assign: { space: 'me', items: mailItems(list) } })) },
    ];
  } });
  const group = mailItems(rows.filter((m) => sel.has(m.id)));
  const anchor = useRef(null); // ⇧ + 체크박스 범위의 시작점 — 마지막으로 누른 줄
  const checkRow = (key, shift = false) => { setSel(checkKeys(sel, key, { keys, anchor: anchor.current, shift })); anchor.current = key; };
  const all = checkState(sel, keys), allLabel = t(all === 'all' ? 'mailx.selectNone' : 'mailx.selectAll');
  const multi = accounts.length > 1;
  const noAccounts = real && ready && !accounts.length;
  const expired = accounts.filter((a) => !ok(a));
  const pickView = (v) => { setView(v); clearSearch(); navigate(mailHome()); };
  const checked = lastSynced();
  return (
    <div className={`mail${cur ? ' has-reader' : ''}${cal ? ' with-cal' : ''}`} style={{ '--list-w': `${listW}px` }}>
      <aside className="mail-folders">
        <button type="button" className="btn primary block" disabled={real && !accounts.some(ok)} onClick={() => setUi({ compose: { mode: 'new' } })}><Icon name="draft" size={14} />{t('mail.compose')}</button>
        {real ? <AccountList accounts={accounts} pick={pick} setPick={setPick} /> : <div className="mail-account"><span className="dot ok" /><Hide k="mail:me">{ME.email}</Hide></div>}
        {VIEWS.map((v) => (
          <button key={v} type="button" className={`nav-item${view === v && !search ? ' active' : ''}`} aria-current={view === v && !search ? 'true' : undefined} onClick={() => pickView(v)}>
            <Icon name={ICON[v]} /><span className="nav-label">{viewName(v)}</span>{counts[v] > 0 && <span className={`nav-count${v === 'drafts' || v === 'starred' ? ' plain' : ''}`}>{counts[v]}</span>}
          </button>
        ))}
        <button type="button" className={`nav-item mail-cal-btn${cal ? ' active' : ''}`} aria-pressed={cal} onClick={toggleCal}><Icon name="calendar" /><span className="nav-label">{t('mailx.calendar')}</span></button>
      </aside>
      <section className={`mail-list${sel.size ? ' picking' : ''}`} role="listbox" aria-multiselectable="true" aria-label={search ? t('mailx.results', { n: rows.length }) : viewName(view)} data-sel-scope="mail">
        <div className="mail-tools">
          {rows.length > 0 && !noAccounts && <label className="mail-check-all" title={allLabel}>
            <input type="checkbox" checked={all === 'all'} ref={(el) => { if (el) el.indeterminate = all === 'some'; }} aria-label={allLabel} onChange={() => setSel(all === 'all' ? new Set() : new Set(keys))} /></label>}
          <select className="input mail-view-pick" value={view} aria-label={t('mailx.folders')} onChange={(e) => pickView(e.target.value)}>{VIEWS.map((v) => <option key={v} value={v}>{viewName(v)}</option>)}</select>
          <form className="search-field mail-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(qInput); }} title={t('mailx.searchHelp')}>
            <Icon name="search" size={14} />
            <input ref={searchRef} className="input" type="search" value={qInput} placeholder={t('mailx.search')} aria-label={t('mailx.search')}
              onChange={(e) => { setQInput(e.target.value); if (!e.target.value) setSearch(null); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); clearSearch(); e.currentTarget.blur(); } }} />
            {(qInput || search) && <button type="button" className="icon-btn sm" aria-label={t('mailx.clearSearch')} onClick={clearSearch}><Icon name="x" size={13} /></button>}
          </form>
          <button type="button" className={`icon-btn mail-refresh${refreshing ? ' spin' : ''}`} disabled={left > 0 || refreshing} onClick={refresh}
            aria-label={left > 0 ? t('mailx.wait', { n: left }) : t('mailx.refresh')} title={left > 0 ? t('mailx.wait', { n: left }) : checked ? `${t('mailx.refresh')} · ${t('mailx.checked', { when: ago(new Date(checked).toISOString()) })}` : t('mailx.refresh')}>
            {left > 0 ? <span className="mono small">{t('mailx.sec', { n: left })}</span> : <Icon name="refresh" size={15} />}</button>
          <button type="button" className={`icon-btn mail-cal-tool${cal ? ' on' : ''}`} aria-pressed={cal} aria-label={t('mailx.calendar')} title={t('mailx.calendar')} onClick={toggleCal}><Icon name="calendar" size={15} /></button>
          {/* 좁은 폭(1100px 이하)에서는 왼쪽 메일함 칸이 숨어 '새 메일'이 사라졌다(OFC-01) — 같은 동작을 도구 줄에 */}
          <button type="button" className="icon-btn mail-new-narrow" disabled={real && !accounts.some(ok)} aria-label={t('mail.compose')} title={t('mail.compose')} onClick={() => setUi({ compose: { mode: 'new' } })}><Icon name="draft" size={15} /></button>
        </div>
        {connecting && <div className="mail-banner" role="status">{t('desktop.mailWaiting')}<button className="btn sm" type="button" onClick={cancelDesktopMail}>{t('desktop.cancel')}</button></div>}
        {expired.length > 0 && <div className="mail-banner"><span className="dot ask" />{t('mailc.expired')}<button type="button" className="btn sm" onClick={() => reconnect(expired[0])}>{t('mailc.reconnect')}</button></div>}
        {left > 0 && <div className="mail-banner" role="status">{t('mailx.wait', { n: left })}</div>}
        {failN > 0 && rows.length > 0 && <div className="mail-banner" role="alert"><span className="dot ask" />{t('mailx.someFail', { n: failN })}<button type="button" className="btn sm" onClick={() => setAgain((n) => n + 1)}>{t('desktop.retry')}</button></div>}
        {search && <div className="mail-search-state" role="status">{search.busy ? t('mailx.searching') : t('mailx.results', { n: rows.length })}{search.some && !search.busy && <span className="dim"> · {t('mailx.searchSome')}</span>}</div>}
        {noAccounts ? <ConnectPanel />
          : rows.length ? rows.map((m) => <MailRow key={m.id} m={m} active={m.id === id} sel={sel} group={group} onPick={checkRow} tag={multi && pick === 'all' ? domain(accounts.find((a) => a.id === m.account)?.address) : null} />)
            : failN > 0 && !search && !loading ? <LoadFail onRetry={() => setAgain((n) => n + 1)} />
            : <div className="empty-state"><p>{search ? (search.busy ? t('mailx.searching') : t('mailx.noResults')) : t(loading || (real && !ready) ? 'mailc.loading' : 'mail.empty')}</p></div>}
        {canMore && rows.length > 0 && <div className="mail-more"><button type="button" className="btn sm" disabled={moreBusy} onClick={more}>{moreBusy ? t('mailx.loadingMore') : t('mailx.more')}</button></div>}
      </section>
      <SplitHandle width={listW} onChange={setListW} label={t('mod.resize')} />
      <section className="mail-reader"><Reader m={cur} onBack={() => navigate(mailHome())} /></section>
      {cal && <CalendarAside onClose={toggleCal} />}
    </div>
  );
}
