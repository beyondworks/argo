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
import { crewsIn, approvalsIn, useStore, childrenOf, createPage, saveNav } from '../core/store.js';
import { readNav } from '../core/nav-model.js';
import { setUi } from '../core/ui-state.js';
import { baseOf, pageMenu, crewMenu, mod } from '../core/commands.js';
import { dragHasFiles, filesFromTransfer } from '../core/files.js';
import { groupCrews, isMine } from '../core/crew-list.js';
import { showToast } from './Overlay.jsx';
import { SPACES, ME, canManage, getMode } from '../core/session.js';
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

const saveFail = () => showToast(t('nav.saveFail'));
/** 메뉴 한 줄 — 끌어서 순서 바꾸기, 우클릭으로 숨기기(홈은 숨길 수 없다). 사람마다 저장(유건 9/30) */
function NavRow({ id, kind, def }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `nav:${id}`, data: { kind: 'nav', id, group: 'nav', navKind: kind, label: def.label } });
  const { onTouchStart, ...mouse } = listeners ?? {}; // 터치는 길게 누르기 = 메뉴
  const menu = menuProps(() => [
    id === 'home' ? { heading: t('nav.homeFixed') } : { label: t('nav.hide'), icon: 'x', run: () => { if (saveNav({ hide: id }, kind) === false) saveFail(); } },
  ]);
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={isDragging ? 'dragging' : ''} {...attributes} {...mergeHandlers(mouse, menu)} role="none">
    <NavItem {...def} />
  </div>;
}

/** 칸(메뉴·페이지·에이전트) — 제목을 끌거나 우클릭 위·아래로 순서를 바꾼다. 메뉴 칸은 제목이 없어 놓일 자리만 된다 */
function NavSection({ id, kind, order, children, head }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: `sec:${id}`, data: { kind: 'navsec', id, group: 'navsec', navKind: kind, label: t(`nav.sec.${id}`) } });
  const i = order.indexOf(id);
  const move = (to) => { if (saveNav({ section: [id, order[to]] }, kind) === false) saveFail(); };
  const menu = menuProps(() => [
    { label: t('nav.secUp'), disabled: i <= 0, run: () => move(i - 1) },
    { label: t('nav.secDown'), disabled: i >= order.length - 1, run: () => move(i + 1) },
  ]);
  const { onTouchStart, ...mouse } = listeners ?? {};
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={`side-sec${isDragging ? ' dragging' : ''}`}>
    {head && head({ handle: { ref: setActivatorNodeRef, ...attributes, ...mergeHandlers(mouse, menu) } })}
    {children}
  </div>;
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

/** 크루 한 줄 — 바깥은 같은 묶음 안 순서 바꾸기(끌기), 안쪽 버튼은 메일·페이지를 끌어다 놓으면 맡기기(9/30: 두 영역을 나눈다).
 *  아래 작은 글씨는 주인(내 크루·회사·주인 이름), 직무·부서는 마우스를 올리면 툴팁으로. 쓸 수 없는 크루는 누르면 이유만 알린다. */
function CrewRow({ crew, space, group, order, mode, blocked, movable }) {
  const sort = useSortable({ id: `crewsort:${crew.id}`, disabled: blocked || !movable, data: { kind: 'crew', id: crew.id, group, order, mode, label: crew.name } });
  // 오피스 맡기기는 크루와의 1:1 대화로 간다 — 메신저 규칙상 1:1은 내 크루만(회사·동료 크루는 채널에서 @이름으로). 예시 모드는 모두 받는다
  const direct = !blocked && (getMode() !== 'signedIn' || isMine(crew, ME.id));
  const { setNodeRef, isOver } = useDroppable({ id: `crew:${crew.id}`, disabled: !direct, data: { accepts: ACCEPTS, crew: crew.id } });
  const { active } = useDndContext();
  const [fileOver, setFileOver] = useState(false);
  const can = direct && active && ACCEPTS.includes(active.data.current?.kind);
  const owner = crew.company ? t('crew.owner.company') : isMine(crew, ME.id) ? t('crew.owner.me') : crew.ownerName || t('crew.owner.unknown');
  const job = crew.job || (crew.dept ? '' : crew.role); // 예시 데이터는 role 하나뿐
  const tip = [job ? t('crew.tip.job', { job }) : t('crew.tip.noJob'), crew.dept && t('crew.tip.dept', { dept: crew.dept }), t('crew.tip.owner', { name: isMine(crew, ME.id) ? ME.name : owner })].filter(Boolean).join('\n');
  // 터치는 길게 누르기 = 메뉴(트리와 같은 규칙). 키보드는 끌기를 시작하지 않는다 — Enter·Space는 맡기기(검수 MEDIUM-1), 순서는 마우스로
  const { onTouchStart, onKeyDown, ...dragListeners } = sort.listeners ?? {};
  const { role, tabIndex, ...sortAttrs } = sort.attributes ?? {}; // 줄 자체는 초점을 받지 않는다(안쪽 버튼 하나만)
  const menu = menuProps(() => crewMenu(crew, space));
  const open = () => (blocked ? showToast(t(`crew.deny.${['crew_allow', 'inactive'].includes(crew.access) ? crew.access : 'other'}`))
    : direct ? setUi({ assign: { space, crew: crew.id, items: [] } }) : showToast(t('crew.viaChannel', { crew: crew.name })));
  return (
    <div ref={sort.setNodeRef} style={{ transform: CSS.Translate.toString(sort.transform), transition: sort.transition }} className={`crew-row${blocked ? ' blocked' : ''}${can ? ' drop-ok' : ''}${isOver || fileOver ? ' drop-over' : ''}${sort.isDragging ? ' dragging' : ''}`}
      {...(blocked ? {} : sortAttrs)} {...mergeHandlers(blocked ? {} : dragListeners, menu)} /* 쓸 수 없는 줄은 끌 수 없지만 눌러서 이유를 본다(aria-disabled를 붙이지 않는다) */
      onDragOver={(e) => { if (direct && dragHasFiles(e.dataTransfer)) { e.preventDefault(); setFileOver(true); } }} onDragLeave={() => setFileOver(false)}
      onDrop={(e) => { e.preventDefault(); setFileOver(false); const files = filesFromTransfer(e.dataTransfer); if (direct && files.length) setUi({ assign: { space, crew: crew.id, items: files.map((f, i) => ({ kind: 'file', id: `drop-${i}`, label: f.name })) } }); }}>
      <button ref={setNodeRef} type="button" className="crew-btn" onClick={open} title={isOver || fileOver ? t('crew.drop', { crew: crew.name }) : tip}>
        <Face id={crew.id} size={18} />
        <span className="nav-label"><span className="crew-name">{crew.name}</span><small>{isMine(crew, ME.id) ? crew.role : owner}</small></span>{/* 오피스에는 내 크루만 — 작은 글씨는 부서(없으면 직무) */}
        {!blocked && <span className={`dot ${crew.status}`} aria-label={t(`crew.status.${crew.status}`)} />}
      </button>
    </div>
  );
}

const VIEW_KEY = 'argo-office-crew-view', FOLD_KEY = 'argo-office-crew-fold';

/** 좌측 크루 목록(유건 9/30): 고정 → 내 크루 → 회사 크루 → 동료 크루(또는 부서별), 쓸 수 없는 크루는 맨 아래 접힌 칸.
 *  고정·순서는 메신저 레일과 같은 저장소, 묶기 기준·접힘·검색은 이 기기에서만(보기 편의). */
function CrewSection({ space, crews, handle }) {
  const [view, setView] = useState(() => ({ by: 'owner', working: false, ...restore(VIEW_KEY, {}) }));
  const [fold, setFold] = useState(() => restore(FOLD_KEY, { blocked: true }));
  const [query, setQuery] = useState(null); // null = 검색칸 닫힘
  const { groups, blocked } = useMemo(() => groupCrews(crews, { me: ME.id, by: view.by, query: query ?? '', working: view.working }), [crews, view, query]);
  const setV = (patch) => setView((v) => { const next = { ...v, ...patch }; persist(VIEW_KEY, next); return next; });
  const toggle = (key) => setFold((f) => { const next = { ...f, [key]: !f[key] }; persist(FOLD_KEY, next); return next; });
  const arrange = (e) => openMenu(e, [
    { label: t('crew.by.owner'), checked: view.by === 'owner', run: () => setV({ by: 'owner' }) },
    { label: t('crew.by.dept'), checked: view.by === 'dept', run: () => setV({ by: 'dept' }) },
    { sep: true },
    { label: t('crew.working'), checked: view.working, run: () => setV({ working: !view.working }) },
  ], { anchor: e.currentTarget });
  const label = (g) => (g.key.startsWith('dept:') ? g.label ?? t('crew.group.noDept') : t(`crew.group.${g.key}`));
  return <>
    <div className="nav-section">
      <span className="sec-handle" {...handle}>{t('nav.crews')}</span>
      <button type="button" className="icon-btn sm" aria-label={t('crew.search')} aria-pressed={query != null} onClick={() => setQuery((q) => (q == null ? '' : null))}><Icon name="search" size={14} /></button>
      <button type="button" className="icon-btn sm" aria-label={t('crew.arrange')} onClick={arrange}><Icon name="dots" size={14} /></button>
    </div>
    {query != null && <input className="crew-search" autoFocus value={query} placeholder={t('crew.search')} aria-label={t('crew.search')} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(null); }} />}
    <div className="crews">
      {groups.map((g) => {
        const mode = g.key === 'pinned' ? 'pin' : 'sort', order = g.crews.map((c) => c.id);
        return <div key={g.key} className="crew-group" role="group" aria-label={label(g)}>
          <button type="button" className="crew-group-head" aria-expanded={!fold[g.key]} onClick={() => toggle(g.key)}><Icon name={fold[g.key] ? 'chevron' : 'caret'} size={12} /><span>{label(g)}</span><small>{g.crews.length}</small></button>
          {!fold[g.key] && <SortableContext items={order.map((id) => `crewsort:${id}`)} strategy={verticalListSortingStrategy}>
            {g.crews.map((c) => <CrewRow key={c.id} crew={c} space={space} group={`${space}|${g.key}`} order={order} mode={mode} movable={g.movable} />)}
          </SortableContext>}
        </div>;
      })}
      {blocked.length > 0 && <div className="crew-group" role="group" aria-label={t('crew.blocked', { n: blocked.length })}>
        <button type="button" className="crew-group-head" aria-expanded={!fold.blocked} onClick={() => toggle('blocked')}><Icon name={fold.blocked ? 'chevron' : 'caret'} size={12} /><span>{t('crew.blocked', { n: blocked.length })}</span></button>
        {!fold.blocked && blocked.map((c) => <CrewRow key={c.id} crew={c} space={space} group="blocked" order={[]} mode="sort" blocked />)}
      </div>}
      {!groups.length && !blocked.length && <p className="crew-empty">{t('crew.none')}</p>}
    </div>
  </>;
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
  const kind = isMe ? 'me' : 'org';
  const nav = readNav(useStore((s) => s.layouts['nav:me']?.items), kind);
  const DEF = {
    home: { to: base, icon: 'home', label: t('nav.home'), active: at(base) },
    business: { to: `${base}/business/analytics`, icon: 'chart', label: t('nav.business'), active: path.startsWith(`${base}/business/`) && !path.startsWith(`${base}/business/library`) },
    mail: { to: '/me/mail', icon: 'mail', label: t('nav.mail'), count: unread, active: path.startsWith('/me/mail') },
    work: { to: `${base}/work`, icon: 'run', label: t('nav.work'), active: at(`${base}/work`) },
    approvals: { to: `${base}/approvals`, icon: 'stamp', label: t('nav.approvals'), count: pendingHere, active: at(`${base}/approvals`) },
    decisions: { to: `${base}/decisions`, icon: 'check', label: t('nav.decisions'), active: at(`${base}/decisions`) },
    outputs: { to: `${base}/outputs`, icon: 'file', label: t('nav.outputs'), active: at(`${base}/outputs`) },
    journal: { to: `${base}/journal`, icon: 'book', label: t('nav.journal'), active: at(`${base}/journal`) },
    docs: { to: `${base}/docs`, icon: 'doc', label: t('nav.docs'), active: at(`${base}/docs`) },
    perf: { to: `${base}/perf`, icon: 'target', label: t('nav.perf'), active: at(`${base}/perf`) },
    shared: { to: '/me/shared', icon: 'share', label: t('nav.shared'), active: at('/me/shared') },
    knowhow: { to: `${base}/knowhow`, icon: 'book', label: t('nav.knowhow'), active: at(`${base}/knowhow`) },
    tools: { to: `${base}/tools`, icon: 'box', label: t('nav.tools'), active: at(`${base}/tools`) },
  };
  const showHidden = (e) => openMenu(e, [{ heading: t('nav.hiddenHead') }, ...nav.hidden.map((id) => ({ label: DEF[id].label, icon: DEF[id].icon, run: () => { if (saveNav({ show: id }, kind) === false) saveFail(); } }))], { anchor: e.currentTarget });
  const sections = {
    menu: <NavSection key="menu" id="menu" kind={kind} order={nav.sections}>
      <div className="nav-group"><SortableContext items={nav.shown.map((id) => `nav:${id}`)} strategy={verticalListSortingStrategy}>
        {nav.shown.map((id) => <NavRow key={id} id={id} kind={kind} def={DEF[id]} />)}
      </SortableContext>
      {nav.hidden.length > 0 && <button type="button" className="nav-hidden" onClick={showHidden}><Icon name="chevron" size={12} />{t('nav.hiddenN', { n: nav.hidden.length })}</button>}</div>
    </NavSection>,
    pages: <NavSection key="pages" id="pages" kind={kind} order={nav.sections} head={({ handle }) => <div className="nav-section">
      <span className="sec-handle" {...handle}>{isMe ? t('nav.pages') : t('nav.wiki')}</span>
      {canManage(space) && <button type="button" className="icon-btn sm" aria-label={t('nav.newPage')} onClick={() => navigate(`${base}/p/${createPage(space)}`)}><Icon name="plus" size={14} /></button>}
    </div>}>
      <div className="tree" role="tree"><Tree space={space} path={path} openMap={openMap} onToggle={toggle} /></div>
    </NavSection>,
    crews: <NavSection key="crews" id="crews" kind={kind} order={nav.sections} head={({ handle }) => <CrewSection space={space} crews={crews} handle={handle} />} />,
  };
  return (
    <nav className="side" aria-label={t('app.name')}>
      <div className="side-top">
        <SpaceSwitcher space={space} />
        <button type="button" className="search-btn" onClick={() => setUi({ palette: true })}><Icon name="search" /><span>{t('nav.search')}</span><kbd>{mod}K</kbd></button>
      </div>
      <div className="side-scroll">
        <SortableContext items={nav.sections.map((id) => `sec:${id}`)} strategy={verticalListSortingStrategy}>{nav.sections.map((id) => sections[id])}</SortableContext>
      </div>
      <div className="side-dock">{/* 모듈 보관함은 패널 맨 아래, 휴지통 구분선 바로 위(유건 9/29) */}
        <NavItem to={`${base}/business/library`} icon="layout" label={t('library.title')} active={path.startsWith(`${base}/business/library`)} />
      </div>
      <div className="side-foot">
        <NavItem to={`${base}/trash`} icon="trash" label={t('nav.trash')} active={at(`${base}/trash`)} />
        <NavItem to={`${base}/settings`} icon="gear" label={t('nav.settings')} active={at(`${base}/settings`)} />
      </div>
    </nav>
  );
}
