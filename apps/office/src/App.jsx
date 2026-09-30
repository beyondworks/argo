// 앱 셸 — 사이드바 · 헤더(경로·저장 상태·페이지 동작) · 내용. 끌어다 놓기는 한 DndContext가 전부 받는다
// (메일을 사이드바 크루에게, 모듈을 격자 안에서, 페이지를 트리 안에서).
import { lazy, Suspense, useEffect, useState } from 'react';
import { DndContext, DragOverlay, MeasuringStrategy, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, pointerWithin, closestCenter } from '@dnd-kit/core';
import { moduleKeyboardCoordinates } from './core/module-keyboard.js';
import { Sidebar } from './ui/Sidebar.jsx';
import { Icon } from './ui/Icon.jsx';
import { Face } from './ui/Face.jsx';
import { MenuHost, openMenu } from './ui/Menu.jsx';
import { ToastHost, showToast } from './ui/Overlay.jsx';
import { moveCrew } from './core/crew-prefs.js';
import { Palette } from './ui/Palette.jsx';
import { Home } from './pages/Home.jsx';
import { useUrl, match, navigate, Link } from './core/router.jsx';
import { t, useLang, setLang, getLang } from './core/i18n.js';
import { useSaveStatus, useLegacyRecovery } from './core/save.js';
import { useStore, reorderPage, createPage, getState, saveNav, saveTabs } from './core/store.js';
import { moveId } from './core/nav-model.js';
import { useUi, setUi } from './core/ui-state.js';
import { baseOf, pageMenu, itemsFromDrag } from './core/commands.js';
import { PEOPLE } from './data/sample.js';
import { SPACES, ME, useSession, canManage } from './core/session.js';
import { pullLayouts, pullPages, pullBoard } from './core/pull.js';
import { flushNow } from './core/sync.js';
import { Login } from './pages/Login.jsx';
import { loadAccounts, pullMail } from './core/mail.js';

const BusinessPage = lazy(() => import('./business/BusinessPage.jsx'));
// 공유·맡기기·이력 창은 첫 화면 묶음에서 떼어 첫 화면 뒤에 따로 받는다(9/30 크루 목록 정리로 150KB 초과분 회수)
const ShareDialog = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.ShareDialog })));
const AssignSheet = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.AssignSheet })));
const HistorySheet = lazy(() => import('./ui/Dialogs.jsx').then((m) => ({ default: m.HistorySheet })));
const ModuleLibrary = lazy(() => import('./pages/ModuleLibrary.jsx'));
const Perf = lazy(() => import('./pages/Perf.jsx')); // 성과 기록(유건 9/29)
const Assets = lazy(() => import('./pages/Assets.jsx')); // 노하우·업무 세트(유건 9/29)
const Tools = lazy(() => import('./pages/Tools.jsx')); // 도구함(유건 9/29)
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

function route(path) {
  let m;
  if ((m = match('/s/:id', path))) return { space: null, view: 'public', id: m.id };
  const me = path === '/me' || path.startsWith('/me/');
  const org = !me && match('/o/:org', path.split('/').slice(0, 3).join('/'));
  const space = me ? 'me' : org && SPACES.some((s) => s.key === org.org) ? org.org : null;
  if (!space) return { redirect: '/me' };
  const rest = path.slice(baseOf(space).length) || '/';
  if (rest === '/') return { space, view: 'home' };
  if ((m = match('/business/:tab', rest))) return { space, view: 'business', tab: m.tab };
  if ((m = match('/p/:id', rest))) return { space, view: 'page', id: m.id };
  if (space === 'me' && rest === '/mail/connect') return { space, view: 'mailConnect' };             // Google 권한 승인 뒤 돌아오는 자리
  if (space === 'me' && (m = match('/mail/:id', rest))) return { space, view: 'mail', id: m.id };
  const simple = { '/mail': 'mail', '/shared': 'shared', '/work': 'work', '/approvals': 'approvals', '/decisions': 'decisions', '/outputs': 'outputs', '/journal': 'journal', '/docs': 'docs', '/perf': 'perf', '/knowhow': 'knowhow', '/tools': 'tools', '/trash': 'trash', '/settings': 'settings' };
  return simple[rest] ? { space, view: simple[rest] } : { redirect: baseOf(space) };
}

function SaveStatus() {
  const saved = useSaveStatus();
  const s = useUi().conflict ? 'unsaved' : saved;
  return <span className={`save-status ${s}`} role="status" aria-live="polite">{(s === 'offline' || s === 'unsaved') && <span className="dot ask" />}{t(`save.${s}`)}</span>;
}

function Header({ r, page }) {
  const mode = useSession();
  const sp = SPACES.find((s) => s.key === r.space);
  const crumb = r.view === 'page' ? (page?.title || t('page.untitled')) : r.view === 'business' && r.tab === 'library' ? t('library.title') : t({ business: 'nav.business', home: 'nav.home', mail: 'nav.mail', mailConnect: 'nav.mail', shared: 'nav.shared', work: 'nav.work', approvals: 'nav.approvals', decisions: 'nav.decisions', outputs: 'nav.outputs', journal: 'nav.journal', docs: 'nav.docs', perf: 'nav.perf', knowhow: 'nav.knowhow', tools: 'nav.tools', trash: 'nav.trash', settings: 'nav.settings' }[r.view]);
  return (
    <header className="topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label={t('nav.open')} onClick={() => setUi({ navOpen: true })}><Icon name="menu" /></button>
      <button type="button" className="icon-btn collapse-toggle" aria-label={t('nav.collapse')} onClick={() => document.documentElement.classList.toggle('nav-collapsed')}><Icon name="sidebar" /></button>
      <nav className="crumbs" aria-label="breadcrumb"><Link to={baseOf(r.space)}>{sp.kind === 'me' ? t('space.me') : sp.name}</Link><Icon name="chevron" size={12} className="dim" /><span className="crumb-cur">{crumb}</span></nav>
      <div className="top-right">
        {mode === 'sample' && <span className="draft-badge">{t('draft.badge')}</span>}
        <SaveStatus />
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
  const icon = { mail: 'mail', page: 'doc', file: 'file', record: 'run', module: 'layout', crew: 'hand', nav: 'grip', navsec: 'grip', biztab: 'grip' }[data.kind] ?? 'doc';
  return <div className="drag-chip"><Icon name={icon} size={14} /><span>{data.label || t('page.untitled')}</span></div>;
}

/** 끄는 종류를 받는 곳만 후보로 — 크루 같은 드롭 대상은 포인터가 들어갔을 때, 같은 목록 안 정렬은 가장 가까운 것 */
const collision = (args) => {
  const a = args.active.data.current ?? {};
  const targets = args.droppableContainers.filter((c) => { const d = c.data.current ?? {}; return d.accepts ? d.accepts.includes(a.kind) : d.kind === a.kind && d.group === a.group; });
  const within = pointerWithin({ ...args, droppableContainers: targets.filter((c) => a.kind === 'module' || c.data.current?.accepts) });
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
    useSensor(KeyboardSensor, { coordinateGetter: moduleKeyboardCoordinates }),
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

  if (r.view === 'public') return <><Suspense fallback={<div className="public" aria-busy="true" />}><PublicPage id={r.id} /></Suspense><ToastHost /></>;
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
    else if (a.kind === 'biztab' && o.kind === 'biztab' && a.id !== o.id) { if (saveTabs(moveId(a.order, a.id, o.id)) === false) showToast(t('nav.saveFail')); }
  };

  const params = new URLSearchParams(query ?? '');
  const views = {
    business: <Suspense fallback={<div className="boot" aria-busy="true" />}>{r.tab === 'library' ? <ModuleLibrary key={r.space} space={r.space} targetId={params.get('target')} /> : <BusinessPage key={r.space} space={r.space} tab={r.tab} openId={params.get('open')} />}</Suspense>,
    home: <Home space={r.space} />, mail: <Mail id={r.id} />, mailConnect: <MailConnect query={query} />, page: <PageView id={r.id} />, shared: <Shared />,
    work: <Work space={r.space} openId={params.get('open')} />, approvals: <Approvals space={r.space} openId={params.get('open')} />, decisions: <Decisions space={r.space} openId={params.get('open')} />,
    outputs: <Outputs space={r.space} openId={params.get('open')} />, journal: <Journal space={r.space} />, docs: <Docs space={r.space} openId={params.get('open')} />, perf: <Perf space={r.space} />, knowhow: <Assets space={r.space} />, tools: <Tools space={r.space} />, trash: <Trash space={r.space} />, settings: <Settings />,
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} measuring={{ droppable: { strategy: dragging?.kind === 'module' ? MeasuringStrategy.Always : MeasuringStrategy.WhileDragging } }} onDragStart={({ active }) => setDragging(active.data.current)} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className={`shell${ui.navOpen ? ' nav-open' : ''}${dragging ? ` is-dragging drag-${dragging.kind}` : ''}`}>
        <Sidebar space={r.space} path={path} />
        <div className="nav-scrim" onClick={() => setUi({ navOpen: false })} />
        <main className="main">
          <Header r={r} page={page} />
          <div className={`content view-${r.view}`}><LegacyRecoveryNotice /><Suspense fallback={<div className="boot" aria-busy="true" />}>{views[r.view]}</Suspense></div>
        </main>
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <DragChip data={dragging} /> : null}</DragOverlay>
      <Palette open={ui.palette} onClose={() => setUi({ palette: false })} space={r.space} />
      <Suspense fallback={null}><ShareDialog /><AssignSheet /><HistorySheet /></Suspense>
      <Suspense fallback={null}><Compose /></Suspense>
      <MenuHost />
      <ToastHost />
    </DndContext>
  );
}
