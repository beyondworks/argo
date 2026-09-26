// 명령 등록부 — ⌘K·우클릭·단축키가 같은 정의를 쓴다(이름·단축키·실행을 한곳에). 권한이 없으면 목록에 넣지 않는다.
import { navigate } from './router.jsx';
import { t, setLang, getLang } from './i18n.js';
import { THEMES, applyTheme } from './theme.js';
import { createPage, duplicatePage, trashPage, archiveMail, setMail, savePage, getState } from './store.js';
import { setUi } from './ui-state.js';
import { showToast } from '../ui/Overlay.jsx';
import { SPACES } from './session.js';

export const baseOf = (space) => (space === 'me' ? '/me' : `/o/${space}`);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? '⌘' : 'Ctrl+';

export function globalCommands(space) {
  const base = baseOf(space);
  return [
    { id: 'newPage', label: t('cmd.newPage'), icon: 'plus', shortcut: `${mod}⌥N`, run: () => navigate(`${base}/p/${createPage(space)}`) },
    { id: 'home', label: t('cmd.goHome'), icon: 'home', run: () => navigate(base) },
    space === 'me' ? { id: 'mail', label: t('cmd.goMail'), icon: 'mail', run: () => navigate('/me/mail') } : { id: 'approvals', label: t('cmd.goApprovals'), icon: 'stamp', run: () => navigate(`${base}/approvals`) },
    { id: 'sidebar', label: t('cmd.toggleSidebar'), icon: 'sidebar', shortcut: `${mod}\\`, run: () => document.documentElement.classList.toggle('nav-collapsed') },
    { id: 'lang', label: t('cmd.toggleLang'), icon: 'globe', shortcut: `${mod}/`, run: () => setLang(getLang() === 'ko' ? 'en' : 'ko') },
    ...THEMES.map((th) => ({ id: `theme-${th}`, label: t('cmd.theme', { name: t(`theme.${th}`) }), icon: 'layout', run: () => applyTheme(th) })),
    { id: 'settings', label: t('cmd.settings'), icon: 'gear', run: () => navigate(`${base}/settings`) },
  ];
}

async function copyLink(path) {
  try { await navigator.clipboard.writeText(location.origin + path); showToast(t('page.linkCopied')); } catch { showToast(location.origin + path); }
}

/* ── 대상별 우클릭 메뉴 ── */
export function pageMenu(page) {
  const base = baseOf(page.space);
  const org = SPACES.find((s) => s.key === page.space);
  const canRestrict = org?.kind === 'org' && (org.role === 'owner' || org.role === 'admin');
  return [
    { label: t('page.open'), icon: 'doc', run: () => navigate(`${base}/p/${page.id}`) },
    { label: t('page.openTab'), icon: 'share', run: () => window.open(`${base}/p/${page.id}`, '_blank', 'noopener') },
    { sep: true },
    { label: t('page.addChild'), icon: 'plus', run: () => navigate(`${base}/p/${createPage(page.space, page.id)}`) },
    { label: t('page.duplicate'), icon: 'copy', shortcut: `${mod}D`, run: () => { const id = duplicatePage(page.id); showToast(t('page.duplicated')); navigate(`${base}/p/${id}`); } },
    { label: t('page.copyLink'), icon: 'link', run: () => copyLink(`${base}/p/${page.id}`) },
    { label: t('page.asTemplate'), icon: 'template', run: () => showToast(t('page.templateSaved')) },
    { sep: true },
    { label: t('page.share'), icon: 'share', run: () => setUi({ share: page.id }) },
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: page.space, items: [{ kind: 'page', id: page.id, label: page.title || t('page.untitled') }] } }) },
    canRestrict && { label: t('share.restrict'), icon: 'lock', checked: !!page.restricted, run: () => savePage(page.id, { restricted: !page.restricted }) },
    { sep: true },
    { label: t('page.trash'), icon: 'trash', danger: true, run: () => { const undo = trashPage(page.id); showToast(t('page.trashed'), { undo }); if (location.pathname.endsWith(page.id)) navigate(base); } },
  ];
}

export function mailMenu(mail) {
  return [
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: 'me', items: [{ kind: 'mail', id: mail.id, label: mail.subject }] } }) },
    { sep: true },
    { label: t('mail.reply'), icon: 'reply', shortcut: 'R', run: () => setUi({ compose: { to: mail.addr, subject: `Re: ${mail.subject}` } }) },
    { label: t('mail.forward'), icon: 'send', run: () => setUi({ compose: { to: '', subject: `Fwd: ${mail.subject}` } }) },
    { label: mail.unread ? t('mail.markRead') : t('mail.markUnread'), icon: 'mail', run: () => setMail(mail.id, { unread: !mail.unread }) },
    { label: t('mail.archiveIt'), icon: 'archive', shortcut: 'E', run: () => { const undo = archiveMail(mail.id); showToast(t('mail.archived'), { undo }); } },
  ];
}

export function fileMenu(file) {
  return [
    { label: t('file.download'), icon: 'file', run: () => showToast(file.name) },
    { label: t('file.sendCrew'), icon: 'hand', run: () => setUi({ assign: { space: file.space, items: [{ kind: 'file', id: file.id, label: file.name }] } }) },
    { label: t('record.openMsgr'), icon: 'hash', run: () => showToast(t('record.openMsgr')) },
  ];
}

export function recordMenu(rec, label) {
  return [
    { label: t('record.openMsgr'), icon: 'hash', run: () => showToast(t('record.openMsgr')) },
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: rec.space, items: [{ kind: 'record', id: rec.id, label }] } }) },
    { label: t('page.copyLink'), icon: 'link', run: () => copyLink(location.pathname) },
  ];
}

export function crewMenu(crew, space) {
  return [
    { label: t('crew.assignTo', { crew: crew.name }), icon: 'hand', run: () => setUi({ assign: { space, crew: crew.id, items: [] } }) },
    { label: t('crew.dm'), icon: 'hash', run: () => showToast(t('record.openMsgr')) },
  ];
}

/** 드래그로 놓인 항목 → 맡기기 창의 항목 */
export function itemsFromDrag(data) {
  const s = getState();
  if (data.kind === 'mail') return [{ kind: 'mail', id: data.id, label: s.mails.find((m) => m.id === data.id)?.subject }];
  if (data.kind === 'page') return [{ kind: 'page', id: data.id, label: s.pages.find((p) => p.id === data.id)?.title || t('page.untitled') }];
  return [{ kind: data.kind, id: data.id, label: data.label }];
}
