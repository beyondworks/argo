// 명령 등록부 — ⌘K·우클릭·단축키가 같은 정의를 쓴다(이름·단축키·실행을 한곳에). 권한이 없으면 목록에 넣지 않는다.
import { navigate } from './router.jsx';
import { t, setLang, getLang } from './i18n.js';
import { THEMES, SHELLS, applyTheme, applyShell, isFullWidth, toggleWidth } from './theme.js';
import { createPage, duplicatePage, trashPage, archiveMail, setMail, setRestricted, getState, isFav, toggleFav } from './store.js';
import { setUi } from './ui-state.js';
import { showToast } from '../ui/Overlay.jsx';
import { loadPageContent } from './pull.js';
import { canManage, ME, getMode } from './session.js';
import { pinCrew, canPin } from './crew-prefs.js';
import { isMine, usable } from './crew-list.js';
import { publicWebUrl, openExternal } from './platform.js';

export const baseOf = (space) => (space === 'me' || space === 'shared' ? '/me' : `/o/${space}`); // shared = 남의 내 공간 페이지를 공유받은 것
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? '⌘' : 'Ctrl+';

export function globalCommands(space) {
  const base = baseOf(space);
  return [
    canManage(space) && { id: 'newPage', label: t('cmd.newPage'), icon: 'plus', shortcut: `${mod}⌥N`, run: () => navigate(`${base}/p/${createPage(space)}`) },
    { id: 'home', label: t('cmd.goHome'), icon: 'home', run: () => navigate(base) },
    space === 'me' ? { id: 'mail', label: t('cmd.goMail'), icon: 'mail', run: () => navigate('/me/mail') } : { id: 'approvals', label: t('cmd.goApprovals'), icon: 'stamp', run: () => navigate(`${base}/approvals`) },
    // 새 메일 — 좁은 폭에서도 갈 길(OFC-01). 보낼 수 있는 계정이 있을 때만(메일 화면의 단추와 같은 조건)
    space === 'me' && (getMode() === 'sample' || getState().mailAccounts.some((a) => a.status === 'ok')) && { id: 'newMail', label: t('cmd.newMail'), icon: 'draft', run: () => { navigate('/me/mail'); setUi({ compose: { mode: 'new' } }); } },
    { id: 'sidebar', label: t('cmd.toggleSidebar'), icon: 'sidebar', shortcut: `${mod}\\`, run: () => document.documentElement.classList.toggle('nav-collapsed') },
    { id: 'width', label: t(isFullWidth() ? 'width.center' : 'width.full'), icon: 'width', run: toggleWidth },
    { id: 'lang', label: t('cmd.toggleLang'), icon: 'globe', shortcut: `${mod}/`, run: () => setLang(getLang() === 'ko' ? 'en' : 'ko') },
    ...THEMES.map((th) => ({ id: `theme-${th}`, label: t('cmd.theme', { name: t(`theme.${th}`) }), icon: 'layout', run: () => { applyTheme(th); import('./custom-theme.js').then((m) => m.refreshCustom()); } })),
    ...SHELLS.map((sh) => ({ id: `shell-${sh}`, label: t('cmd.shell', { name: t(`shell.${sh}`) }), icon: 'layout', run: () => { applyShell(sh); import('./custom-theme.js').then((m) => m.refreshCustom()); } })),
    { id: 'settings', label: t('cmd.settings'), icon: 'gear', run: () => navigate(`${base}/settings`) },
  ].filter(Boolean);
}

/** 템플릿으로 저장 = 지금 모습의 사본을 템플릿으로(유건 9/27). 조직 템플릿은 관리자만 — 아니면 '내 것'으로 */
async function saveAsTemplate(page) {
  if (page.content === undefined) { try { await loadPageContent(page.id); } catch { showToast(t('load.readFail')); return; } } // 본문 없이 빈 템플릿을 만들지 않는다
  const cur = getState().pages.find((p) => p.id === page.id) ?? page;
  const space = page.space !== 'me' && page.space !== 'shared' && canManage(page.space) ? page.space : 'me';
  createPage(space, null, { title: cur.title, content: cur.content, template: true });
  showToast(t(space === 'me' ? 'page.templateSavedMine' : 'page.templateSaved'));
}

async function copyLink(path) {
  const url = publicWebUrl(path);
  try { await navigator.clipboard.writeText(url); showToast(t('page.linkCopied')); } catch { showToast(url); }
}

/* ── 대상별 우클릭 메뉴 ── */
/** 즐겨찾기에 추가/빼기(유건 9/30 #7) — 좌측 패널 맨 위 칸, 사람마다 계정에 저장 */
const favItem = (kind, id) => ({ label: t(isFav(kind, id) ? 'fav.remove' : 'fav.add'), icon: 'star', run: () => { if (toggleFav(kind, id) === false) showToast(t('crew.saveFail')); } });

export function pageMenu(page) {
  const base = baseOf(page.space);
  const canRestrict = page.space !== 'me' && canManage(page.space);
  const canTop = page.parent || canManage(page.space); // 위키 최상위에 만들기·복제는 관리자만(서버와 같은 기준)
  const canEdit = !page.template && (page.access === 'edit' || page.access === 'full' || (getMode() === 'sample' && page.space !== 'shared'));
  const tree = (fn) => () => import('../pages/tree-actions.jsx').then((m) => m[fn](page)); // 이름 바꾸기·옮기기 창은 누를 때 받는다(16차)
  return [
    { label: t('page.open'), icon: 'doc', run: () => navigate(`${base}/p/${page.id}`) },
    { label: t('page.openTab'), icon: 'share', run: () => openExternal(publicWebUrl(`${base}/p/${page.id}`)).catch(() => showToast(t('share.failed'))) },
    !page.template && favItem('page', page.id),
    { sep: true },
    canEdit && { label: t('page.rename'), icon: 'draft', run: tree('startRename') },
    canEdit && page.space !== 'shared' && { label: t('page.move'), icon: 'folder', run: tree('openMove') },
    { label: t('page.addChild'), icon: 'plus', run: () => navigate(`${base}/p/${createPage(page.space, page.id)}`) },
    canTop && { label: t('page.duplicate'), icon: 'copy', shortcut: `${mod}D`, run: () => { const id = duplicatePage(page.id); showToast(t('page.duplicated')); navigate(`${base}/p/${id}`); } },
    { label: t('page.copyLink'), icon: 'link', run: () => copyLink(`${base}/p/${page.id}`) },
    { label: t('page.asTemplate'), icon: 'template', run: () => saveAsTemplate(page) },
    !page.template && { label: t('page.toTask'), icon: 'todo', run: () => import('../views/task-new.jsx').then((m) => m.openTaskFromPage(page)) }, // 제목·본문 앞부분을 채운 새 할 일 창(유건 10/4) — 창 코드는 누를 때 받는다
    { sep: true },
    { label: t('page.share'), icon: 'share', run: () => setUi({ share: page.id }) },
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: page.space, items: [{ kind: 'page', id: page.id, label: page.title || t('page.untitled') }] } }) },
    canRestrict && { label: t('share.restrict'), icon: 'lock', checked: !!page.restricted, run: () => setRestricted(page.id, !page.restricted) },
    { sep: true },
    { label: t('page.trash'), icon: 'trash', danger: true, run: () => { const undo = trashPage(page.id); showToast(t('page.trashed'), { undo }); if (location.pathname.endsWith(page.id)) navigate(base); } },
  ];
}

export function mailMenu(mail) {
  return [
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: 'me', items: [{ kind: 'mail', id: mail.id, label: mail.subject }] } }) },
    { sep: true },
    { label: t('mail.reply'), icon: 'reply', shortcut: 'R', run: () => setUi({ compose: { mode: 'reply', of: mail.id } }) }, // 계정·스레드·인용은 작성 창이 원래 메일에서 채운다(15차)
    { label: t('mail.forward'), icon: 'send', run: () => setUi({ compose: { mode: 'forward', of: mail.id } }) },
    { label: mail.unread ? t('mail.markRead') : t('mail.markUnread'), icon: 'mail', run: () => setMail(mail.id, { unread: !mail.unread }) },
    { label: t('mail.archiveIt'), icon: 'archive', shortcut: 'E', run: () => { const undo = archiveMail(mail.id); showToast(t('mail.archived'), { undo }); } },
  ];
}

export function fileMenu(file) {
  return [
    { label: t('file.download'), icon: 'file', run: () => import('../pages/Records.jsx').then((m) => m.downloadOutput(file)) },
    { label: t('file.sendCrew'), icon: 'hand', run: () => setUi({ assign: { space: file.space, items: [{ kind: 'file', id: file.id, label: file.name }] } }) },
  ]; // '메신저에서 열기'는 뺐다(9/30) — 메신저에 대화·메시지로 바로 가는 주소가 아직 없어 누르면 아무 일도 없었다
}

export function recordMenu(rec, label) {
  return [
    { label: t('crew.assign'), icon: 'hand', run: () => setUi({ assign: { space: rec.space, items: [{ kind: 'record', id: rec.id, label }] } }) },
    { label: t('page.copyLink'), icon: 'link', run: () => copyLink(location.pathname) },
  ];
}

export function crewMenu(crew, space) {
  const ok = usable(crew) && (getMode() !== 'signedIn' || isMine(crew, ME.id)); // 좌측 목록은 쓸 수 있는 내 크루만 싣는다
  const home = crew.space ?? space; // 맡기기는 크루가 사는 조직으로 — 다른 조직 공간에서 연 즐겨찾기 크루가 맡기기 창 목록에서 빠지던 것(17차 A 검수 LOW-5)
  return [
    { label: t('crew.detail'), icon: 'info', run: () => setUi({ crew: { id: crew.id, space } }) }, // 에이전트 상세(17차) — 조직도의 남의 크루도 본다
    ok && { label: t('crew.assignTo', { crew: crew.name }), icon: 'hand', run: () => setUi({ assign: { space: home, crew: crew.id, items: [] } }) },
    { sep: true },
    ok && canPin(crew) && { label: t(crew.pinned ? 'crew.unpin' : 'crew.pin'), run: () => pinCrew(crew, !crew.pinned).catch(() => showToast(t('crew.saveFail'))) },
    ok && isMine(crew, ME.id) && favItem('crew', crew.id),
  ];
}

/** 드래그로 놓인 항목 → 맡기기 창의 항목 */
export function itemsFromDrag(data) {
  if (data.items?.length) return data.items; // 고른 것 여러 개를 같이 끌었다(11차)
  const s = getState();
  if (data.kind === 'mail') return [{ kind: 'mail', id: data.id, label: s.mails.find((m) => m.id === data.id)?.subject }];
  if (data.kind === 'page') return [{ kind: 'page', id: data.id, label: s.pages.find((p) => p.id === data.id)?.title || t('page.untitled') }];
  return [{ kind: data.kind, id: data.id, label: data.label }];
}
