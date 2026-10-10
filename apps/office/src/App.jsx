// 앱 셸 — 사이드바 · 헤더(경로·저장 상태·페이지 동작) · 내용. 끌어다 놓기는 한 DndContext가 전부 받는다
// (메일을 사이드바 크루에게, 페이지를 트리 안에서). 모듈 옮기기는 격자가 따로 맡는다(ui/module-move.js — 손을 뗄 때 놓기).
import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, pointerWithin, closestCenter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Sidebar } from './ui/Sidebar.jsx';
import { Icon } from './ui/Icon.jsx';
import { Face } from './ui/Face.jsx';
import { MenuHost, openMenu } from './ui/Menu.jsx';
import { ToastHost, showToast } from './ui/Overlay.jsx';
import { moveCrew } from './core/crew-prefs.js';
import { Home } from './pages/Home.jsx';
import { useUrl, match, navigate, Link } from './core/router.jsx';
import { t, useLang, setLang, getLang } from './core/i18n.js';
import { useSaveStatus, useLegacyRecovery } from './core/save.js';
import { useStore, reorderPage, createPage, getState, saveNav, saveFav, favOf, toggleFav } from './core/store.js';
import { VIEWS, favTarget } from './core/nav-model.js';
import { useUi, setUi } from './core/ui-state.js';
import { baseOf, pageMenu, itemsFromDrag, mod } from './core/commands.js';
import { useHideAll, toggleHideAll } from './core/hide-all.js';
import { useNewVersion } from './core/version-check.js';
import { isFullWidth, onWidth, toggleWidth } from './core/theme.js';
import { PEOPLE } from './data/sample.js';
import { SPACES, ME, useSession, canManage } from './core/session.js';
import { pullLayouts, pullPages, pullBoard } from './core/pull.js';
import { flushNow } from './core/sync.js';
import { refetchDue } from './core/refetch.js';
import { reloadOnce } from './core/chunk-reload.js';
import { SelectionHost } from './core/selection.js'; // 여러 개 고르기(11차) — 감지 코드만 첫 화면, 선택 상자·막대는 쓸 때 받는다

const BusinessPage = lazy(() => import('./business/BusinessPage.jsx'));
const Login = lazy(() => import('./pages/Login.jsx').then((m) => ({ default: m.Login }))); // 로그인한 사람의 첫 화면에는 필요 없다 — 첫 화면 JS 상한(150,000B) 자리(10/10)
// ⌘K 창은 열 때만 받는다(첫 화면 150KB 상한 — 9/30 오른쪽 패널·결재 카드 버튼을 붙이며 옮김)
const Palette = lazy(() => import('./ui/Palette.jsx').then((m) => ({ default: m.Palette })));
// 공유·맡기기·이력 창은 첫 화면 묶음에서 떼어 첫 화면 뒤에 따로 받는다(9/30 크루 목록 정리로 150KB 초과분 회수)
const ShareDialog = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.ShareDialog })));
const AssignSheet = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.AssignSheet })));
const HistorySheet = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.HistorySheet })));
const ModuleLibrary = lazy(() => import('./pages/ModuleLibrary.jsx'));
const Perf = lazy(() => import('./pages/Perf.jsx')); // 성과 기록(유건 9/29)
const Assets = lazy(() => import('./pages/Assets.jsx')); // 노하우·업무 세트(유건 9/29)
const Tools = lazy(() => import('./pages/Tools.jsx')); // 도구함(유건 9/29)
const Calendar = lazy(() => import('./calendar/Calendar.jsx')); // 일정(유건 9/30)
const Tasks = lazy(() => import('./views/TasksPage.jsx')); // 할 일 화면(유건 10/4)
const WorkStatus = lazy(() => import('./pages/WorkStatus.jsx')); // 업무 현황(유건 10/8 — 조직 공간)
const Contracts = lazy(() => import('./docs/DocsPage.jsx')); // 견적·계약·전자서명(10/2 인트라넷 이식)
const SignPage = lazy(() => import('./docs/SignPage.jsx')); // 서명 링크(로그인 없음)
const FileLink = lazy(() => import('./files/LinkPage.jsx')); // 문서함 공유 링크(로그인 없음, 15차)
const Files = lazy(() => import('./files/FilesPage.jsx')); // 문서함·구글 드라이브(유건 10/2)
const DriveConnect = lazy(() => import('./files/FilesPage.jsx').then((m) => ({ default: m.DriveConnect })));
const Briefings = lazy(() => import('./pages/Briefings.jsx')); // 브리핑(유건 10/5 — 내 공간)
const Company = lazy(() => import('./pages/Company.jsx')); // 회사 정보(유건 10/2 트랙 C)
const People = lazy(() => import('./pages/People.jsx')); // 직원 명부(유건 10/2 트랙 C)
// 에이전트 조직도·에이전트 상세(17차 A) — 한 청크. 상세는 열 때만 받는다(첫 화면에는 여는 단추만)
const CrewOrg = lazy(() => import('./pages/Crews.jsx'));
const CrewSheet = lazy(() => import('./pages/Crews.jsx').then((m) => ({ default: m.CrewSheet })));
// 메일 화면은 메일을 열 때만 필요하다 — 첫 화면 JS 150KB 상한(할 일 화면을 붙이며 넘은 0.1KB를 여기서 되찾는다)
const Mail = lazy(() => import('./pages/Mail.jsx').then((m) => ({ default: m.Mail })));
const MailConnect = lazy(() => import('./pages/Mail.jsx').then((m) => ({ default: m.MailConnect })));
const Compose = lazy(() => import('./pages/Mail.jsx').then((m) => ({ default: m.Compose })));
// 기본 화면(홈·메일)이 아닌 화면은 쓸 때만 불러온다(첫 화면 150KB 상한, 유건 9/26) — DocView는 core/ui로 옮겨 Records/Dialogs가 공용으로 정적으로 쓴다.
const PageView = lazy(() => import('./pages/PageView.jsx').then((m) => ({ default: m.PageView })));
const Approvals = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Approvals })));
const Work = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Work })));
const Decisions = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Decisions })));
const Outputs = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Outputs })));
const Journal = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Journal })));
const Docs = lazy(() => import('./pages/Records.jsx').then((m) => ({ default: m.Docs })));
const Settings = lazy(() => import('./pages/Misc.jsx').then((m) => ({ default: m.Settings })));
const Trash = lazy(() => import('./pages/Misc.jsx').then((m) => ({ default: m.Trash })));
const Shared = lazy(() => import('./pages/Misc.jsx').then((m) => ({ default: m.Shared })));
const PublicPage = lazy(() => import('./pages/Misc.jsx').then((m) => ({ default: m.PublicPage })));

/** 지연 로드 자리 — 화면 파일을 못 받아도(배포 뒤 옛 탭·개발 서버 504) 앱 전체가 하얘지지 않는다. 파일 실패면 한 번 새로 불러오고,
 *  그래도 안 되면 안내를 둔다(quiet = 창처럼 안 보여도 되는 자리는 비운다). reset이 바뀌면(다른 화면으로 가면) 다시 그려 본다 */
class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { let s; try { s = sessionStorage; } catch {} if (reloadOnce(error, s)) location.reload(); }
  componentDidUpdate(prev) { if (prev.reset !== this.props.reset && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return this.props.quiet ? null : <div className="empty-state" role="alert"><p>{t('load.fail')}</p><button type="button" className="btn" onClick={() => location.reload()}>{t('load.retry')}</button></div>;
  }
}
/** 앱을 여는 동안(OFC-07) — 빈 바탕 대신 앱 표시와 진행 표시, 8초가 지나도 그대로면 '연결이 느립니다 · 다시 시도'(새로고침). screen = 화면 조각을 받는 동안(본문 자리) */
function Boot({ screen = false }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(id); }, []);
  return <div className={screen ? 'boot screen' : 'boot'} role="status" aria-busy="true" aria-label={t('login.loading')}>
    {!screen && <img className="login-mark" src="/icon-192.png" alt="" />}<span className="boot-spin" />
    {slow && <p className="dim small">{t('boot.slow')} <button type="button" className="link-btn" onClick={() => location.reload()}>{t('desktop.retry')}</button></p>}
  </div>;
}
const Lazy = ({ fallback = <Boot screen />, quiet, reset, children }) => <Boundary quiet={quiet} reset={reset}><Suspense fallback={fallback}>{children}</Suspense></Boundary>;

function route(path) {
  let m;
  if ((m = match('/s/:id', path))) return { space: null, view: 'public', id: m.id };
  if ((m = match('/sign/:token', path))) return { space: null, view: 'sign', token: m.token };
  if (match('/f', path)) return { space: null, view: 'fileLink' }; // 공유 링크 /f#<토큰> — 토큰은 화면이 주소 조각에서 읽는다(서버 접근 기록에 남지 않게)
  const me = path === '/me' || path.startsWith('/me/');
  const org = !me && match('/o/:org', path.split('/').slice(0, 3).join('/'));
  const space = me ? 'me' : org && SPACES.some((s) => s.key === org.org) ? org.org : null;
  if (!space) return { redirect: '/me', lost: !!org }; // lost = 없는 조직 주소 — 왜 옮겼는지 알린다(UX-O05)
  const rest = path.slice(baseOf(space).length) || '/';
  if (rest === '/') return { space, view: 'home' };
  if (rest === '/business') return { space, view: 'business', tab: null }; // 탭 없이 오면 업무 화면이 보이는 첫 탭을 고른다(분석을 숨긴 사람)
  if ((m = match('/business/:tab', rest))) return { space, view: 'business', tab: m.tab };
  if ((m = match('/p/:id', rest))) return { space, view: 'page', id: m.id };
  if (space === 'me' && rest === '/files/connect') return { space, view: 'filesConnect' };             // 구글 드라이브 권한 승인 뒤
  if (space === 'me' && rest === '/mail/connect') return { space, view: 'mailConnect' };             // Google 권한 승인 뒤 돌아오는 자리
  if ((m = match('/mail/:id', rest))) return { space, view: 'mail', id: m.id }; // 조직 공간 메일(10/8)도 같은 내 개인 메일함
  return VIEWS.includes(rest.slice(1)) ? { space, view: rest.slice(1) } : { redirect: baseOf(space), lost: true };
}

function SaveStatus() {
  const saved = useSaveStatus();
  const s = useUi().conflict ? 'unsaved' : saved;
  return <span className={`save-status ${s}`} role="status" aria-live="polite">{(s === 'offline' || s === 'unsaved') && <span className="dot ask" />}{t(`save.${s}`)}</span>;
}

/** 가운데 보기 ⇄ 전체 너비(유건 9/30) — 폭 제한이 없는 화면(설정·휴지통·모듈 보관함·메일)에서는 숨긴다 */
function WidthToggle() {
  const full = useSyncExternalStore(onWidth, isFullWidth);
  const label = t(full ? 'width.center' : 'width.full');
  return <button type="button" className="icon-btn width-toggle" aria-pressed={full} aria-label={label} title={label} onClick={toggleWidth}><Icon name="width" /></button>;
}

/** 지금 화면을 즐겨찾기에 넣고 빼기(유건 10/1 "좌측 패널에 즐겨찾는 페이지") — 위키 페이지는 페이지로, 그 밖의 화면은 주소로. 템플릿·메일 한 통처럼 대상이 없으면 숨긴다 */
function FavToggle({ path, page }) {
  const target = page?.template ? null : favTarget(path);
  const on = useStore((s) => !!target && favOf(s).some((x) => x.kind === target.kind && x.id === target.id));
  if (!target) return null;
  const label = t(on ? 'fav.remove' : 'fav.add');
  return <button type="button" className="icon-btn fav-toggle" aria-pressed={on} aria-label={label} title={label} onClick={() => { if (toggleFav(target.kind, target.id) === false) showToast(t('crew.saveFail')); }}><Icon name="star" /></button>;
}

/** 화면 전체 가리기(18차, 유건 결정 4) — 회의·화면 공유 전에 한 번에. 켜면 '가리는 중' 알약으로 바뀐다. 단축키 ⌘⇧H(아래 onKey) */
/** 새 버전 안내(유건 10/4) — 누르면 편집기의 입력 대기(0.8초)가 저장 목록에 들어가길 기다리고 보낸 뒤 새로고침한다 */
function NewVersionBar() {
  const fresh = useNewVersion();
  const [busy, setBusy] = useState(false);
  if (!fresh) return null;
  const reload = async () => { setBusy(true); await new Promise((r) => setTimeout(r, 1000)); try { await flushNow(); } catch { /* 못 보낸 것은 저장 목록(IndexedDB)에 남아 새로고침 뒤 다시 보낸다 */ } location.reload(); };
  return <div className="toast ver-bar" role="status"><span>{t('ver.new')}</span><button type="button" className="toast-undo" disabled={busy} onClick={reload}>{t(busy ? 'ver.saving' : 'ver.reload')}</button></div>;
}

function HideAllToggle() {
  const on = useHideAll();
  const label = t('hideAll.on'); // 켜짐은 같은 자리 눈 아이콘이 사선 그은 눈·붉은색으로만 바뀐다(유건 10/4 "가리는 중 UI 별로") — 상태는 눌림(aria-pressed)과 설명 글로
  return <button type="button" className={`icon-btn hide-all${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} title={`${on ? t('hideAll.state') : label} (${mod === '⌘' ? '⌘⇧H' : 'Ctrl+Shift+H'})`} onClick={() => toggleHideAll()}><Icon name={on ? 'eyeOff' : 'eye'} /></button>;
}

function Header({ r, page, path, missing }) {
  const mode = useSession();
  const sp = SPACES.find((s) => s.key === r.space);
  const gone = r.view === 'page' && mode !== 'loading' && (!page || missing === page.id); // 없는 페이지(목록에 있어도 서버에 없으면 — PageView가 ui.missingPage로 알린다) — '제목 없음·저장됨·별'을 보이지 않는다(UX-O05)
  const crumb = r.view === 'page' ? (gone ? '' : page?.title || t('page.untitled')) : r.view === 'business' && r.tab === 'library' ? t('library.title') : t(`nav.${r.view === 'mailConnect' ? 'mail' : r.view === 'filesConnect' ? 'files' : r.view}`);
  return (
    <header className="topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label={t('nav.open')} onClick={() => setUi({ navOpen: true })}><Icon name="menu" /></button>
      <button type="button" className="icon-btn collapse-toggle" aria-label={t('nav.collapse')} onClick={() => document.documentElement.classList.toggle('nav-collapsed')}><Icon name="sidebar" /></button>
      <nav className="crumbs" aria-label="breadcrumb"><Link to={baseOf(r.space)}>{sp.kind === 'me' ? t('space.me') : sp.name}</Link><Icon name="chevron" size={12} className="dim" /><span className="crumb-cur">{crumb}</span></nav>
      <div className="top-right">
        {mode === 'sample' && <span className="draft-badge">{t('draft.badge')}</span>}
        {!gone && <SaveStatus />}
        <HideAllToggle />
        {!gone && <FavToggle path={path} page={page} />}
        {!['settings', 'trash', 'mail', 'mailConnect'].includes(r.view) && r.tab !== 'library' && <WidthToggle />}
        {r.view === 'page' && page && !gone && <>
          {mode === 'sample' && <span className="presence" title={t('page.viewing', { n: 2 })}><span className="avatar sm">{ME.name[0]}</span><span className="avatar sm alt">{PEOPLE[0].name[0]}</span></span>}
          <button type="button" className="btn sm" onClick={() => setUi({ share: page.id })}><Icon name="share" size={14} />{t('page.share')}</button>
          <button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => openMenu(e, [...pageMenu(page), { sep: true }, { label: t('page.history'), icon: 'history', run: () => setUi({ history: page.id }) }], { anchor: e.currentTarget })}><Icon name="dots" /></button>
        </>}
      </div>
    </header>
  );
}

function LegacyRecoveryNotice() {
  const { draft, pending } = useLegacyRecovery();
  if (!draft && !pending) return null;
  return <div className="conflict" role="status"><div><p className="small">{t('recovery.preserved')}</p><p className="dim small">{t(draft ? 'recovery.draft' : 'recovery.pending', { n: pending })}</p></div></div>;
}

function DragChip({ data }) {
  if (!data) return null;
  const icon = { mail: 'mail', page: 'doc', file: 'file', record: 'run', crew: 'hand', nav: 'grip', navsec: 'grip', biztab: 'grip', fav: 'star' }[data.kind] ?? 'doc';
  return <div className="drag-chip"><Icon name={icon} size={14} /><span>{data.label || t('page.untitled')}</span></div>;
}

/** 끄는 종류를 받는 곳만 후보로 — 크루 같은 드롭 대상은 포인터가 들어갔을 때, 같은 목록 안 정렬은 가장 가까운 것 */
const collision = (args) => {
  const a = args.active.data.current ?? {};
  const targets = args.droppableContainers.filter((c) => { const d = c.data.current ?? {}; return d.accepts ? d.accepts.includes(a.kind) : d.kind === a.kind && d.group === a.group; });
  const within = pointerWithin({ ...args, droppableContainers: targets.filter((c) => c.data.current?.accepts) });
  if (within.length) return within;
  return closestCenter({ ...args, droppableContainers: targets.filter((c) => !c.data.current?.accepts) });
};

export default function App() {
  useLang();
  const mode = useSession();
  const url = useUrl();
  const [path, query] = url.split('?');
  const r = route(path);
  const ui = useUi();
  const page = useStore((s) => (r.view === 'page' ? s.pages.find((p) => p.id === r.id) : null));
  const [dragging, setDragging] = useState(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => { if (r.redirect && mode !== 'loading') { if (r.lost && mode === 'signedIn') showToast(t('nav.moved')); navigate(r.redirect, { replace: true }); } }, [r.redirect, mode]);
  useEffect(() => {
    if (mode !== 'signedIn') return;
    flushNow(); // 로그인 확인 전에 미뤄 둔 변경을 바로 보낸다
    pullLayouts().catch((e) => console.warn('[office] layout pull failed', e?.message));
    pullPages().catch((e) => console.warn('[office] page pull failed', e?.message));
    pullBoard().catch((e) => console.warn('[office] board pull failed', e?.message));
    import('./core/mail.js').then((m) => m.pullInbox()).catch((e) => console.warn('[office] mail pull failed', e?.message)); // 예시 메일을 치우고 연결한 계정의 받은편지함(메일 코드는 첫 화면 밖). 실패 표시는 core/mail.js가 쓴다(OFC-08)
    // 기록판은 실시간 방송 대신 탭으로 돌아오거나 창에 초점이 올 때 다시 읽는다(최대 1분에 한 번 — 읽기만). 같은 브라우저의 메신저 탭에서 결재하고 돌아와도 맞게(CX-10)
    let last = Date.now();
    const onShow = () => { if (!refetchDue({ hidden: document.hidden, now: Date.now(), last })) return; last = Date.now(); pullBoard().catch(() => {}); };
    document.addEventListener('visibilitychange', onShow); addEventListener('focus', onShow);
    return () => { document.removeEventListener('visibilitychange', onShow); removeEventListener('focus', onShow); };
  }, [mode]);
  useEffect(() => { setUi({ navOpen: false }); }, [path]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'k') { e.preventDefault(); setUi((u) => ({ palette: !u.palette })); }
      else if (cmd && e.key === '\\') { e.preventDefault(); document.documentElement.classList.toggle('nav-collapsed'); }
      else if (cmd && e.key === '/') { e.preventDefault(); setLang(getLang() === 'ko' ? 'en' : 'ko'); }
      // 화면 전체 가리기 ⌘⇧H(Ctrl+Shift+H) — 입력칸·편집기 안에서도(가려야 할 순간에 손이 거기 있다). 크롬의 ⌘⇧H(홈)는 예약 단축키가 아니라 여기서 막힌다.
      // 글자판과 무관하게 e.code(한글 입력 중에도), 누르고 있을 때 되풀이 신호는 무시
      else if (cmd && e.shiftKey && !e.altKey && e.code === 'KeyH' && !e.repeat) { e.preventDefault(); toggleHideAll(); }
      else if (cmd && e.altKey && e.code === 'KeyN' && r.space && canManage(r.space)) { e.preventDefault(); navigate(`${baseOf(r.space)}/p/${createPage(r.space)}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r.space]);

  if (r.view === 'public') return <><Lazy fallback={<div className="public" aria-busy="true" />}><PublicPage id={r.id} /></Lazy><ToastHost /></>;
  if (r.view === 'sign') return <><Lazy fallback={<Boot />}><SignPage token={r.token} /></Lazy><ToastHost /></>;
  if (r.view === 'fileLink') return <><Lazy fallback={<Boot />}><FileLink /></Lazy><ToastHost /></>;
  if (mode === 'loading') return <Boot />;
  if (mode === 'signedOut') return <Lazy fallback={<Boot />}><Login /></Lazy>;
  if (r.redirect) return null;

  const onDragEnd = ({ active, over }) => {
    setDragging(null);
    if (!over) return;
    const a = active.data.current, o = over.data.current ?? {};
    if (o.accepts?.includes(a.kind)) {
      const crew = getState().crews.find((c) => c.id === o.crew);
      setUi({ assign: { space: r.space, crew: crew.id, items: itemsFromDrag(a) } });
    } else if (a.kind === 'page' && o.kind === 'page' && a.id !== o.id) reorderPage(a.id, o.id);
    else if (a.kind === 'crew' && o.kind === 'crew' && a.group === o.group && a.id !== o.id) moveCrew(a.order, a.id, o.id, a.mode).catch(() => showToast(t('crew.saveFail')));
    else if ((a.kind === 'nav' || a.kind === 'navsec') && o.kind === a.kind && a.id !== o.id) { if (saveNav(a.kind === 'nav' ? { move: [a.id, o.id] } : { section: [a.id, o.id] }, a.navKind) === false) showToast(t('nav.saveFail')); }
    else if (a.kind === 'biztab' && o.kind === 'biztab' && a.id !== o.id) a.move(o.id); // 업무 탭 순서 — 저장·실패 안내는 업무 화면(BusinessPage)이 한다
    else if (a.kind === 'fav' && o.kind === 'fav' && a.id !== o.id) { if (saveFav({ move: [a.id, o.id] }) === false) showToast(t('nav.saveFail')); } // 즐겨찾기 안 순서(키 'page:id'·'crew:id')
  };

  const params = new URLSearchParams(query ?? '');
  const views = {
    business: <Lazy reset={path}>{r.tab === 'library' ? <ModuleLibrary key={r.space} space={r.space} targetId={params.get('target')} /> : <BusinessPage key={r.space} space={r.space} tab={r.tab} openId={params.get('open')} view={params.get('view')} />}</Lazy>,
    home: <Home space={r.space} />, contracts: <Contracts key={r.space} space={r.space} params={params} />, files: <Files key={r.space} space={r.space} query={query} />, filesConnect: <DriveConnect query={query} />, calendar: <Calendar key={r.space} space={r.space} day={params.get('day')} />, tasks: <Tasks key={r.space} space={r.space} />, status: <WorkStatus key={r.space} space={r.space} folder={params.get('folder')} />, mail: <Mail id={r.id} />, mailConnect: <MailConnect query={query} />, page: <PageView key={r.id} id={r.id} space={r.space} />, shared: <Shared />,
    work: <Work space={r.space} openId={params.get('open')} folder={params.get('folder')} />, agents: <CrewOrg space={r.space} />, approvals: <Approvals space={r.space} openId={params.get('open')} folder={params.get('folder')} />, decisions: <Decisions space={r.space} openId={params.get('open')} folder={params.get('folder')} />,
    outputs: <Outputs space={r.space} openId={params.get('open')} folder={params.get('folder')} />, journal: <Journal space={r.space} folder={params.get('folder')} />, docs: <Docs space={r.space} openId={params.get('open')} />, perf: <Perf space={r.space} tab={params.get('tab')} />, people: <People key={r.space} space={r.space} />, company: <Company key={r.space} space={r.space} />, briefings: <Briefings openId={params.get('open')} />, knowhow: <Assets space={r.space} />, tools: <Tools space={r.space} />, trash: <Trash space={r.space} />, settings: <Settings />,
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={({ active }) => setDragging(active.data.current)} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className={`shell${ui.navOpen ? ' nav-open' : ''}${dragging ? ` is-dragging drag-${dragging.kind}` : ''}`}>
        <Sidebar space={r.space} path={path} />
        <div className="nav-scrim" onClick={() => setUi({ navOpen: false })} />
        <main className="main">
          <Header r={r} page={page} path={path} missing={ui.missingPage} />
          <div className={`content view-${r.view}`}><LegacyRecoveryNotice /><Lazy reset={path}>{views[r.view]}</Lazy></div>
        </main>
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <DragChip data={dragging} /> : null}</DragOverlay>
      {ui.palette && <Lazy fallback={null} quiet><Palette open onClose={() => setUi({ palette: false })} space={r.space} /></Lazy>}
      {ui.crew && <Lazy fallback={null} quiet><CrewSheet /></Lazy>}
      <Lazy fallback={null} quiet><ShareDialog /><AssignSheet /><HistorySheet /></Lazy>
      <Lazy fallback={null} quiet><Compose /></Lazy>
      <Lazy fallback={null} quiet reset={path}><SelectionHost /></Lazy>
      <MenuHost />
      <NewVersionBar />
      <ToastHost />
    </DndContext>
  );
}
