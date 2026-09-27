// 사이드바 — 공간 전환기 · 검색 · 메뉴 · 페이지 트리(끌어서 순서 바꾸기) · 크루(끌어다 놓으면 맡기기) · 휴지통·설정.
import { useMemo, useState } from 'react';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable, useDndContext } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { openMenu, menuProps, mergeHandlers } from './Menu.jsx';
import { Link, navigate } from '../core/router.jsx';
import { t, useLang } from '../core/i18n.js';
import { crewsIn, approvalsIn, useStore, childrenOf, createPage } from '../core/store.js';
import { setUi } from '../core/ui-state.js';
import { baseOf, pageMenu, crewMenu, mod } from '../core/commands.js';
import { dragHasFiles, filesFromTransfer } from '../core/files.js';
import { SPACES, ME, canManage } from '../core/session.js';
import { restore, persist } from '../core/save.js';

const ACCEPTS = ['mail', 'page', 'file', 'record'];

function SpaceMark({ space, size = 22 }) {
  if (space.kind === 'me') return <span className="space-mark me" style={{ width: size, height: size }}>{ME.name.slice(0, 1)}</span>;
  return <span className="space-mark" style={{ width: size, height: size }}>{space.mark}</span>;
}

function SpaceSwitcher({ space }) {
  const cur = SPACES.find((s) => s.key === space) ?? SPACES[0];
  const open = (e) => openMenu(e, [
    { heading: t('space.switch') },
    ...SPACES.map((s) => ({ label: s.kind === 'me' ? t('space.me') : s.name, face: <SpaceMark space={s} size={16} />, checked: s.key === space, run: () => navigate(baseOf(s.key)) })),
  ], { anchor: e.currentTarget });
  return (
    <button type="button" className="space-switch" onClick={open} aria-haspopup="menu">
      <SpaceMark space={cur} />
      <span className="space-name"><b>{cur.kind === 'me' ? t('space.me') : cur.name}</b><small>{cur.kind === 'me' ? ME.email : [t(`space.role.${cur.role}`), cur.members != null && t('space.members', { n: cur.members })].filter(Boolean).join(' · ')}</small></span>
      <Icon name="caret" size={14} />
    </button>
  );
}

function NavItem({ to, icon, label, count, active }) {
  return (
    <Link to={to} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} /><span className="nav-label">{label}</span>{count > 0 && <span className="nav-count">{count}</span>}
    </Link>
  );
}

function PageRow({ page, depth, path, open, onToggle, hasKids }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `page:${page.id}`, disabled: !page.parent && !canManage(page.space), data: { kind: 'page', id: page.id, group: page.parent ?? 'root', label: page.title } });
  const { onTouchStart, ...mouseListeners } = listeners ?? {}; // 터치는 길게 누르기 = 메뉴(끌기는 메뉴 "이동"으로)
  const to = `${baseOf(page.space)}/p/${page.id}`;
  const menu = menuProps(() => pageMenu(page));
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, paddingLeft: 6 + depth * 14 }} className={`tree-row${path === to ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
      {...attributes} {...mergeHandlers(mouseListeners, menu)} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={path === to}>
      <button type="button" className={`tree-toggle${hasKids ? '' : ' leaf'}`} tabIndex={-1} aria-label={t('more')} onClick={(e) => { e.stopPropagation(); onToggle(page.id); }}>
        <Icon name={hasKids ? (open ? 'caret' : 'chevron') : (page.restricted ? 'lock' : 'doc')} size={14} />
      </button>
      <Link to={to} className="tree-label" draggable={false}>{page.title || t('page.untitled')}</Link>
      <button type="button" className="tree-more" tabIndex={-1} aria-label={t('more')} onClick={(e) => openMenu(e, pageMenu(page), { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
    </div>
  );
}

function Tree({ space, parent = null, depth = 0, path, openMap, onToggle }) {
  const pages = useStore((s) => s.pages);
  const kids = useMemo(() => childrenOf(pages, space, parent), [pages, space, parent]);
  if (!kids.length) return null;
  return (
    <SortableContext items={kids.map((p) => `page:${p.id}`)} strategy={verticalListSortingStrategy}>
      {kids.map((p) => {
        const hasKids = pages.some((q) => q.parent === p.id);
        const open = openMap[p.id] ?? depth === 0;
        return (
          <div key={p.id} role="group">
            <PageRow page={p} depth={depth} path={path} open={open} onToggle={onToggle} hasKids={hasKids} />
            {hasKids && open && <Tree space={space} parent={p.id} depth={depth + 1} path={path} openMap={openMap} onToggle={onToggle} />}
          </div>
        );
      })}
    </SortableContext>
  );
}

function CrewRow({ crew, space }) {
  const { setNodeRef, isOver } = useDroppable({ id: `crew:${crew.id}`, data: { accepts: ACCEPTS, crew: crew.id } });
  const { active } = useDndContext();
  const [fileOver, setFileOver] = useState(false);
  const can = active && ACCEPTS.includes(active.data.current?.kind);
  return (
    <div ref={setNodeRef} className={`crew-row${can ? ' drop-ok' : ''}${isOver || fileOver ? ' drop-over' : ''}`} {...menuProps(() => crewMenu(crew, space))}
      onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); setFileOver(true); } }} onDragLeave={() => setFileOver(false)}
      onDrop={(e) => { e.preventDefault(); setFileOver(false); const files = filesFromTransfer(e.dataTransfer); if (files.length) setUi({ assign: { space, crew: crew.id, items: files.map((f, i) => ({ kind: 'file', id: `drop-${i}`, label: f.name })) } }); }}
      title={isOver || fileOver ? t('crew.drop', { crew: crew.name }) : undefined}>
      <button type="button" className="crew-btn" onClick={() => setUi({ assign: { space, crew: crew.id, items: [] } })}>
        <Face id={crew.id} size={18} />
        <span className="nav-label">{crew.name}<small>{crew.role}</small></span>
        <span className={`dot ${crew.status}`} aria-label={t(`crew.status.${crew.status}`)} />
      </button>
    </div>
  );
}

export function Sidebar({ space, path }) {
  useLang();
  const approvals = useStore((s) => s.approvals);
  const mails = useStore((s) => s.mails);
  const [openMap, setOpenMap] = useState(() => restore('argo-office-tree', {}));
  const toggle = (id) => setOpenMap((m) => { const next = { ...m, [id]: !(m[id] ?? true) }; persist('argo-office-tree', next); return next; });
  const base = baseOf(space);
  const isMe = space === 'me';
  const pendingHere = approvals.filter(approvalsIn(space)).length;
  const crews = crewsIn(useStore((s) => s.crews), space, ME.id);
  const unread = mails.filter((m) => m.folder === 'inbox' && m.unread).length;
  const at = (p) => path === p;
  return (
    <nav className="side" aria-label={t('app.name')}>
      <div className="side-top">
        <SpaceSwitcher space={space} />
        <button type="button" className="search-btn" onClick={() => setUi({ palette: true })}><Icon name="search" /><span>{t('nav.search')}</span><kbd>{mod}K</kbd></button>
      </div>
      <div className="side-scroll">
        <div className="nav-group">
          <NavItem to={base} icon="home" label={t('nav.home')} active={at(base)} />
          {isMe ? <>
            <NavItem to="/me/mail" icon="mail" label={t('nav.mail')} count={unread} active={path.startsWith('/me/mail')} />
            <NavItem to={`${base}/approvals`} icon="stamp" label={t('nav.approvals')} count={pendingHere} active={at(`${base}/approvals`)} />
            <NavItem to="/me/shared" icon="share" label={t('nav.shared')} active={at('/me/shared')} />
          </> : <>
            <NavItem to={`${base}/work`} icon="run" label={t('nav.work')} active={at(`${base}/work`)} />
            <NavItem to={`${base}/approvals`} icon="stamp" label={t('nav.approvals')} count={pendingHere} active={at(`${base}/approvals`)} />
            <NavItem to={`${base}/decisions`} icon="check" label={t('nav.decisions')} active={at(`${base}/decisions`)} />
            <NavItem to={`${base}/outputs`} icon="file" label={t('nav.outputs')} active={at(`${base}/outputs`)} />
            <NavItem to={`${base}/journal`} icon="book" label={t('nav.journal')} active={at(`${base}/journal`)} />
          </>}
        </div>
        <div className="nav-section">
          <span>{isMe ? t('nav.pages') : t('nav.wiki')}</span>
          {canManage(space) && <button type="button" className="icon-btn sm" aria-label={t('nav.newPage')} onClick={() => navigate(`${base}/p/${createPage(space)}`)}><Icon name="plus" size={14} /></button>}
        </div>
        <div className="tree" role="tree"><Tree space={space} path={path} openMap={openMap} onToggle={toggle} /></div>
        <div className="nav-section"><span>{t('nav.crews')}</span></div>
        <div className="crews">{crews.map((c) => <CrewRow key={c.id} crew={c} space={space} />)}</div>
      </div>
      <div className="side-foot">
        <NavItem to={`${base}/trash`} icon="trash" label={t('nav.trash')} active={at(`${base}/trash`)} />
        <NavItem to={`${base}/settings`} icon="gear" label={t('nav.settings')} active={at(`${base}/settings`)} />
      </div>
    </nav>
  );
}
