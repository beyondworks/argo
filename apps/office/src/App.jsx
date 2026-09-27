// 앱 셸 — 사이드바 · 헤더(경로·저장 상태·페이지 동작) · 내용. 끌어다 놓기는 한 DndContext가 전부 받는다
// (메일을 사이드바 크루에게, 모듈을 격자 안에서, 페이지를 트리 안에서).
import { useEffect, useState } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, pointerWithin, closestCenter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Sidebar } from './ui/Sidebar.jsx';
import { Icon } from './ui/Icon.jsx';
import { Face } from './ui/Face.jsx';
import { MenuHost, openMenu } from './ui/Menu.jsx';
import { ToastHost } from './ui/Overlay.jsx';
import { Palette } from './ui/Palette.jsx';
import { ShareDialog, AssignSheet, HistorySheet } from './ui/Dialogs.jsx';
import { Home, useHomeLayout, layoutKey } from './pages/Home.jsx';
import { Mail, Compose } from './pages/Mail.jsx';
import { PageView } from './pages/PageView.jsx';
import { Approvals, Work, Decisions, Outputs, Journal } from './pages/Records.jsx';
import { Settings, Trash, Shared, PublicPage } from './pages/Misc.jsx';
import { useUrl, match, navigate, Link } from './core/router.jsx';
import { t, useLang, setLang, getLang } from './core/i18n.js';
import { useSaveStatus } from './core/save.js';
import { useStore, saveLayout, reorderPage, createPage, getState } from './core/store.js';
import { useUi, setUi } from './core/ui-state.js';
import { baseOf, pageMenu, itemsFromDrag } from './core/commands.js';
import { move } from './core/layout.js';
import { PEOPLE } from './data/sample.js';
import { SPACES, ME, useSession, canManage } from './core/session.js';
import { pullLayouts, pullPages, pullBoard } from './core/pull.js';
import { flushNow } from './core/sync.js';
import { Login } from './pages/Login.jsx';

function route(path) {
  let m;
  if ((m = match('/s/:id', path))) return { space: null, view: 'public', id: m.id };
  const me = path === '/me' || path.startsWith('/me/');
  const org = !me && match('/o/:org', path.split('/').slice(0, 3).join('/'));
  const space = me ? 'me' : org && SPACES.some((s) => s.key === org.org) ? org.org : null;
  if (!space) return { redirect: '/me' };
  const rest = path.slice(baseOf(space).length) || '/';
  if (rest === '/') return { space, view: 'home' };
  if ((m = match('/p/:id', rest))) return { space, view: 'page', id: m.id };
  if (space === 'me' && (m = match('/mail/:id', rest))) return { space, view: 'mail', id: m.id };
  const simple = { '/mail': 'mail', '/shared': 'shared', '/work': 'work', '/approvals': 'approvals', '/decisions': 'decisions', '/outputs': 'outputs', '/journal': 'journal', '/trash': 'trash', '/settings': 'settings' };
  return simple[rest] ? { space, view: simple[rest] } : { redirect: baseOf(space) };
}

function SaveStatus() {
  const saved = useSaveStatus();
  const s = useUi().conflict ? 'unsaved' : saved;
  return <span className={`save-status ${s}`} role="status" aria-live="polite">{(s === 'offline' || s === 'unsaved') && <span className="dot ask" />}{t(`save.${s}`)}</span>;
}

function Header({ r, page }) {
  const sp = SPACES.find((s) => s.key === r.space);
  const crumb = r.view === 'page' ? (page?.title || t('page.untitled')) : t({ home: 'nav.home', mail: 'nav.mail', shared: 'nav.shared', work: 'nav.work', approvals: 'nav.approvals', decisions: 'nav.decisions', outputs: 'nav.outputs', journal: 'nav.journal', trash: 'nav.trash', settings: 'nav.settings' }[r.view]);
  return (
    <header className="topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label={t('nav.open')} onClick={() => setUi({ navOpen: true })}><Icon name="menu" /></button>
      <button type="button" className="icon-btn collapse-toggle" aria-label={t('nav.collapse')} onClick={() => document.documentElement.classList.toggle('nav-collapsed')}><Icon name="sidebar" /></button>
      <nav className="crumbs" aria-label="breadcrumb"><Link to={baseOf(r.space)}>{sp.kind === 'me' ? t('space.me') : sp.name}</Link><Icon name="chevron" size={12} className="dim" /><span className="crumb-cur">{crumb}</span></nav>
      <div className="top-right">
        <span className="draft-badge">{t('draft.badge')}</span>
        <SaveStatus />
        {r.view === 'page' && page && <>
          {useSession() === 'sample' && <span className="presence" title={t('page.viewing', { n: 2 })}><span className="avatar sm">{ME.name[0]}</span><span className="avatar sm alt">{PEOPLE[0].name[0]}</span></span>}
          <button type="button" className="btn sm" onClick={() => setUi({ share: page.id })}><Icon name="share" size={14} />{t('page.share')}</button>
          <button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => openMenu(e, [...pageMenu(page), { sep: true }, { label: t('page.history'), icon: 'history', run: () => setUi({ history: page.id }) }], { anchor: e.currentTarget })}><Icon name="dots" /></button>
        </>}
      </div>
    </header>
  );
}

function DragChip({ data }) {
  if (!data) return null;
  const icon = { mail: 'mail', page: 'doc', file: 'file', record: 'run', module: 'layout' }[data.kind] ?? 'doc';
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
  const homeItems = useHomeLayout(r.space ?? 'me');
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

  if (r.view === 'public') return <><PublicPage id={r.id} /><ToastHost /></>;
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
    } else if (a.kind === 'module' && o.kind === 'module' && a.id !== o.id) {
      const visible = homeItems.filter((i) => !i.hidden);
      const from = visible.findIndex((i) => i.id === a.id), to = visible.findIndex((i) => i.id === o.id);
      saveLayout(layoutKey(r.space), [...move(visible, from, to), ...homeItems.filter((i) => i.hidden)]);
    } else if (a.kind === 'page' && o.kind === 'page' && a.id !== o.id) reorderPage(a.id, o.id);
  };

  const params = new URLSearchParams(query ?? '');
  const views = {
    home: <Home space={r.space} />, mail: <Mail id={r.id} />, page: <PageView id={r.id} />, shared: <Shared />,
    work: <Work space={r.space} />, approvals: <Approvals space={r.space} openId={params.get('open')} />, decisions: <Decisions space={r.space} />,
    outputs: <Outputs space={r.space} />, journal: <Journal space={r.space} />, trash: <Trash space={r.space} />, settings: <Settings />,
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={({ active }) => setDragging(active.data.current)} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className={`shell${ui.navOpen ? ' nav-open' : ''}${dragging ? ` is-dragging drag-${dragging.kind}` : ''}`}>
        <Sidebar space={r.space} path={path} />
        <div className="nav-scrim" onClick={() => setUi({ navOpen: false })} />
        <main className="main">
          <Header r={r} page={page} />
          <div className={`content view-${r.view}`}>{views[r.view]}</div>
        </main>
      </div>
      <DragOverlay dropAnimation={null}>{dragging && dragging.kind !== 'module' ? <DragChip data={dragging} /> : null}</DragOverlay>
      <Palette open={ui.palette} onClose={() => setUi({ palette: false })} space={r.space} />
      <ShareDialog />
      <AssignSheet />
      <HistorySheet />
      <Compose />
      <MenuHost />
      <ToastHost />
    </DndContext>
  );
}
