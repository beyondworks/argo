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
import { baseOf, pageMenu, itemsFromDrag } from './core/commands.js';
import { isFullWidth, onWidth, toggleWidth } from './core/theme.js';
import { PEOPLE } from './data/sample.js';
import { SPACES, ME, useSession, canManage } from './core/session.js';
import { pullLayouts, pullPages, pullBoard } from './core/pull.js';
import { flushNow } from './core/sync.js';
import { Login } from './pages/Login.jsx';
import { loadAccounts, pullMail } from './core/mail.js';
import { reloadOnce } from './core/chunk-reload.js';
import { SelectionHost } from './core/selection.js'; // 여러 개 고르기(11차) — 감지 코드만 첫 화면, 선택 상자·막대는 쓸 때 받는다

const BusinessPage = lazy(() => import('./business/BusinessPage.jsx'));
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
const Contracts = lazy(() => import('./docs/DocsPage.jsx')); // 견적·계약·전자서명(10/2 인트라넷 이식)
const SignPage = lazy(() => import('./docs/SignPage.jsx')); // 서명 링크(로그인 없음)
const Files = lazy(() => import('./files/FilesPage.jsx')); // 문서함·구글 드라이브(유건 10/2)
const DriveConnect = lazy(() => import('./files/FilesPage.jsx').then((m) => ({ default: m.DriveConnect })));
const Company = lazy(() => import('./pages/Company.jsx')); // 회사 정보(유건 10/2 트랙 C)
const People = lazy(() => import('./pages/People.jsx')); // 직원 명부(유건 10/2 트랙 C)
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
const Lazy = ({ fallback = <div className="boot" aria-busy="true" />, quiet, reset, children }) => <Boundary quiet={quiet} reset={reset}><Suspense fallback={fallback}>{children}</Suspense></Boundary>;

function route(path) {
  let m;
  if ((m = match('/s/:id', path))) return { space: null, view: 'public', id: m.id };
  if ((m = match('/sign/:token', path))) return { space: null, view: 'sign', token: m.token };
  const me = path === '/me' || path.startsWith('/me/');
  const org = !me && match('/o/:org', path.split('/').slice(0, 3).join('/'));
  const space = me ? 'me' : org && SPACES.some((s) => s.key === org.org) ? org.org : null;
  if (!space) return { redirect: '/me' };
  const rest = path.slice(baseOf(space).length) || '/';
  if (rest === '/') return { space, view: 'home' };
  if (rest === '/business') return { space, view: 'business', tab: null }; // 탭 없이 오면 업무 화면이 보이는 첫 탭을 고른다(분석을 숨긴 사람)
  if ((m = match('/business/:tab', rest))) return { space, view: 'business', tab: m.tab };
  if ((m = match('/p/:id', rest))) return { space, view: 'page', id: m.id };
  if (space === 'me' && rest === '/files/connect') return { space, view: 'filesConnect' };             // 구글 드라이브 권한 승인 뒤
  if (space === 'me' && rest === '/mail/connect') return { space, view: 'mailConnect' };             // Google 권한 승인 뒤 돌아오는 자리
  if (space === 'me' && (m = match('/mail/:id', rest))) return { space, view: 'mail', id: m.id };
  return VIEWS.includes(rest.slice(1)) ? { space, view: rest.slice(1) } : { redirect: baseOf(space) };
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

function Header({ r, page, path }) {
  const mode = useSession();
  const sp = SPACES.find((s) => s.key === r.space);
  const crumb = r.view === 'page' ? (page?.title || t('page.untitled')) : r.view === 'business' && r.tab === 'library' ? t('library.title') : t(`nav.${r.view === 'mailConnect' ? 'mail' : r.view === 'filesConnect' ? 'files' : r.view}`);
  return (
    <header className="topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label={t('nav.open')} onClick={() => setUi({ navOpen: true })}><Icon name="menu" /></button>
      <button type="button" className="icon-btn collapse-toggle" aria-label={t('nav.collapse')} onClick={() => document.documentElement.classList.toggle('nav-collapsed')}><Icon name="sidebar" /></button>
      <nav className="crumbs" aria-label="breadcrumb"><Link to={baseOf(r.space)}>{sp.kind === 'me' ? t('space.me') : sp.name}</Link><Icon name="chevron" size={12} className="dim" /><span className="crumb-cur">{crumb}</span></nav>
      <div className="top-right">
        {mode === 'sample' && <span className="draft-badge">{t('draft.badge')}</span>}
        <SaveStatus />
        <FavToggle path={path} page={page} />
        {!['settings', 'trash', 'mail', 'mailConnect'].includes(r.view) && r.tab !== 'library' && <WidthToggle />}
        {r.view === 'page' && page && <>
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

  useEffect(() => { if (r.redirect && mode !== 'loading') navigate(r.redirect, { replace: true }); }, [r.redirect, mode]);
  useEffect(() => {
    if (mode !== 'signedIn') return;
    flushNow(); // 로그인 확인 전에 미뤄 둔 변경을 바로 보낸다
    pullLayouts().catch((e) => console.warn('[office] layout pull failed', e?.message));
    pullPages().catch((e) => console.warn('[office] page pull failed', e?.message));
    pullBoard().catch((e) => console.warn('[office] board pull failed', e?.message));
    loadAccounts().then(() => pullMail('inbox')).catch((e) => console.warn('[office] mail pull failed', e?.message)); // 예시 메일을 치우고 연결한 계정의 받은편지함
    // 기록판은 실시간 방송 대신 탭으로 돌아올 때 다시 읽는다(최대 1분에 한 번 — 읽기만)
    let last = Date.now();
    const onShow = () => { if (document.hidden || Date.now() - last < 60_000) return; last = Date.now(); pullBoard().catch(() => {}); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [mode]);
  useEffect(() => { setUi({ navOpen: false }); }, [path]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'k') { e.preventDefault(); setUi((u) => ({ palette: !u.palette })); }
      else if (cmd && e.key === '\\') { e.preventDefault(); document.documentElement.classList.toggle('nav-collapsed'); }
      else if (cmd && e.key === '/') { e.preventDefault(); setLang(getLang() === 'ko' ? 'en' : 'ko'); }
      else if (cmd && e.altKey && e.code === 'KeyN' && r.space && canManage(r.space)) { e.preventDefault(); navigate(`${baseOf(r.space)}/p/${createPage(r.space)}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r.space]);

  if (r.view === 'public') return <><Lazy fallback={<div className="public" aria-busy="true" />}><PublicPage id={r.id} /></Lazy><ToastHost /></>;
  if (r.view === 'sign') return <><Lazy fallback={<div className="boot" aria-busy="true" />}><SignPage token={r.token} /></Lazy><ToastHost /></>;
  if (mode === 'loading') return <div className="boot" aria-busy="true" />;
  if (mode === 'signedOut') return <Login />;
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
    business: <Lazy reset={path}>{r.tab === 'library' ? <ModuleLibrary key={r.space} space={r.space} targetId={params.get('target')} /> : <BusinessPage key={r.space} space={r.space} tab={r.tab} openId={params.get('open')} />}</Lazy>,
    home: <Home space={r.space} />, contracts: <Contracts key={r.space} space={r.space} params={params} />, files: <Files key={r.space} space={r.space} query={query} />, filesConnect: <DriveConnect query={query} />, calendar: <Calendar key={r.space} space={r.space} day={params.get('day')} />, mail: <Mail id={r.id} />, mailConnect: <MailConnect query={query} />, page: <PageView id={r.id} />, shared: <Shared />,
    work: <Work space={r.space} openId={params.get('open')} />, approvals: <Approvals space={r.space} openId={params.get('open')} folder={params.get('folder')} />, decisions: <Decisions space={r.space} openId={params.get('open')} folder={params.get('folder')} />,
    outputs: <Outputs space={r.space} openId={params.get('open')} folder={params.get('folder')} />, journal: <Journal space={r.space} folder={params.get('folder')} />, docs: <Docs space={r.space} openId={params.get('open')} />, perf: <Perf space={r.space} tab={params.get('tab')} />, people: <People key={r.space} space={r.space} />, company: <Company key={r.space} space={r.space} />, knowhow: <Assets space={r.space} />, tools: <Tools space={r.space} />, trash: <Trash space={r.space} />, settings: <Settings />,
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={({ active }) => setDragging(active.data.current)} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className={`shell${ui.navOpen ? ' nav-open' : ''}${dragging ? ` is-dragging drag-${dragging.kind}` : ''}`}>
        <Sidebar space={r.space} path={path} />
        <div className="nav-scrim" onClick={() => setUi({ navOpen: false })} />
        <main className="main">
          <Header r={r} page={page} path={path} />
          <div className={`content view-${r.view}`}><LegacyRecoveryNotice /><Lazy reset={path}>{views[r.view]}</Lazy></div>
        </main>
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <DragChip data={dragging} /> : null}</DragOverlay>
      {ui.palette && <Lazy fallback={null} quiet><Palette open onClose={() => setUi({ palette: false })} space={r.space} /></Lazy>}
      <Lazy fallback={null} quiet><ShareDialog /><AssignSheet /><HistorySheet /></Lazy>
      <Lazy fallback={null} quiet><Compose /></Lazy>
      <Lazy fallback={null} quiet reset={path}><SelectionHost /></Lazy>
      <MenuHost />
      <ToastHost />
    </DndContext>
  );
}
