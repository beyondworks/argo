// 사이드바 — 공간 전환기 · 검색 · 즐겨찾기 · 메뉴 · 페이지 트리(끌어서 순서 바꾸기) · 크루(끌어다 놓으면 맡기기) · 휴지통·설정.
import { useMemo, useState } from 'react';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable, useDndContext } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { openMenu, menuProps, mergeHandlers } from './Menu.jsx';
import { Link, navigate } from '../core/router.jsx';
import { t, useLang } from '../core/i18n.js';
import { crewsIn, approvalsIn, useStore, childrenOf, createPage, saveNav, favOf, saveFav, isFav, toggleFav } from '../core/store.js';
import { readNav, routeInfo, favTarget, routeLabelKey, routeIcon, favKey, NAV_ICON } from '../core/nav-model.js';
import { setUi } from '../core/ui-state.js';
import { baseOf, pageMenu, crewMenu, mod } from '../core/commands.js';
import { dragHasFiles, filesFromTransfer } from '../core/files.js';
import { groupCrews, isMine } from '../core/crew-list.js';
import { showToast } from './Overlay.jsx';
import { SPACES, ME, canManage, getMode } from '../core/session.js';
import { restore, persist, scopedStorageKey } from '../core/save.js';

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
/** 메뉴 한 줄 — 끌어서 순서 바꾸기, 우클릭으로 즐겨찾기·숨기기(홈은 숨길 수 없다). 사람마다 저장(유건 9/30·10/1) */
function NavRow({ id, kind, def }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `nav:${id}`, data: { kind: 'nav', id, group: 'nav', navKind: kind, label: def.label } });
  const { onTouchStart, ...mouse } = listeners ?? {}; // 터치는 길게 누르기 = 메뉴
  const menu = menuProps(() => { const f = favTarget(def.to); return [
    f && { label: t(isFav(f.kind, f.id) ? 'fav.remove' : 'fav.add'), icon: 'star', run: () => { if (toggleFav(f.kind, f.id) === false) saveFail(); } },
    id === 'home' ? { heading: t('nav.homeFixed') } : { label: t('nav.hide'), icon: 'x', run: () => { if (saveNav({ hide: id }, kind) === false) saveFail(); } },
  ].filter(Boolean); });
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
 *  아래 작은 글씨는 주인(내 크루·회사·주인 이름), 직무·부서는 마우스를 올리면 툴팁으로. 쓸 수 없는(꺼진) 크루는 목록에 싣지 않는다(유건 9/30 #9). */
function CrewRow({ crew, space, group, order, mode, movable }) {
  const sort = useSortable({ id: `crewsort:${crew.id}`, disabled: !movable, data: { kind: 'crew', id: crew.id, group, order, mode, label: crew.name } });
  // 오피스 맡기기는 크루와의 1:1 대화로 간다 — 메신저 규칙상 1:1은 내 크루만(회사·동료 크루는 채널에서 @이름으로). 예시 모드는 모두 받는다
  const direct = getMode() !== 'signedIn' || isMine(crew, ME.id);
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
  const open = () => (direct ? setUi({ assign: { space, crew: crew.id, items: [] } }) : showToast(t('crew.viaChannel', { crew: crew.name })));
  return (
    <div ref={sort.setNodeRef} style={{ transform: CSS.Translate.toString(sort.transform), transition: sort.transition }} className={`crew-row${can ? ' drop-ok' : ''}${isOver || fileOver ? ' drop-over' : ''}${sort.isDragging ? ' dragging' : ''}`}
      {...sortAttrs} {...mergeHandlers(dragListeners, menu)}
      onDragOver={(e) => { if (direct && dragHasFiles(e.dataTransfer)) { e.preventDefault(); setFileOver(true); } }} onDragLeave={() => setFileOver(false)}
      onDrop={(e) => { e.preventDefault(); setFileOver(false); const files = filesFromTransfer(e.dataTransfer); if (direct && files.length) setUi({ assign: { space, crew: crew.id, items: files.map((f, i) => ({ kind: 'file', id: `drop-${i}`, label: f.name })) } }); }}>
      <button ref={setNodeRef} type="button" className="crew-btn" onClick={open} title={isOver || fileOver ? t('crew.drop', { crew: crew.name }) : tip}>
        <Face id={crew.id} size={18} />
        <span className="nav-label"><span className="crew-name">{crew.name}</span><small>{isMine(crew, ME.id) ? crew.role : owner}</small></span>{/* 오피스에는 내 크루만 — 작은 글씨는 부서(없으면 직무) */}
        <span className={`dot ${crew.status}`} aria-label={t(`crew.status.${crew.status}`)} />
      </button>
    </div>
  );
}

const FOLD_KEY = 'argo-office-crew-fold';

/** 좌측 크루 목록(유건 9/30 #6): 고정 → 내 에이전트 두 묶음(고정한 크루는 내 에이전트에서 빠진다). 쓸 수 없는(꺼진) 크루는 보이지 않는다(#9).
 *  고정·순서는 메신저 레일과 같은 저장소(계정), 접힘·검색은 이 기기에서만. 주인별·부서별·일하는 중만 필터는 뺐다 */
function CrewSection({ space, crews, handle }) {
  const [fold, setFold] = useState(() => restore(FOLD_KEY, {}));
  const [query, setQuery] = useState(null); // null = 검색칸 닫힘
  const { groups } = useMemo(() => groupCrews(crews, { me: ME.id, query: query ?? '' }), [crews, query]);
  const toggle = (key) => setFold((f) => { const next = { ...f, [key]: !f[key] }; persist(FOLD_KEY, next); return next; });
  return <>
    <div className="nav-section">
      <span className="sec-handle" {...handle}>{t('nav.crews')}</span>
      <button type="button" className="icon-btn sm" aria-label={t('crew.search')} aria-pressed={query != null} onClick={() => setQuery((q) => (q == null ? '' : null))}><Icon name="search" size={14} /></button>
    </div>
    {query != null && <input className="crew-search" autoFocus value={query} placeholder={t('crew.search')} aria-label={t('crew.search')} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(null); }} />}
    <div className="crews">
      {groups.map((g) => {
        const mode = g.key === 'pinned' ? 'pin' : 'sort', order = g.crews.map((c) => c.id), label = t(`crew.group.${g.key}`);
        return <div key={g.key} className="crew-group" role="group" aria-label={label}>
          <button type="button" className="crew-group-head" aria-expanded={!fold[g.key] || !!query} onClick={() => toggle(g.key)}><Icon name={fold[g.key] && !query ? 'chevron' : 'caret'} size={12} /><span>{label}</span><small>{g.crews.length}</small></button>
          {(!fold[g.key] || query) && <SortableContext items={order.map((id) => `crewsort:${id}`)} strategy={verticalListSortingStrategy}>
            {g.crews.map((c) => <CrewRow key={c.id} crew={c} space={space} group={`${space}|${g.key}`} order={order} mode={mode} movable={g.movable} />)}
          </SortableContext>}
        </div>;
      })}
      {!groups.length && <p className="crew-empty">{t('crew.none')}</p>}
    </div>
  </>;
}

/** 즐겨찾기 한 줄 — 끌어서 순서, 우클릭은 그 페이지·에이전트의 메뉴(맨 위에 '즐겨찾기에서 빼기'가 있다). 화면(route)은 이름을 메뉴 사전으로 만들고 공간 이름을 작게 */
function FavRow({ fav, space, path }) {
  const key = favKey(fav);
  const page = useStore((s) => (fav.kind === 'page' ? s.pages.find((p) => p.id === fav.id) : null));
  const crew = useStore((s) => (fav.kind === 'crew' ? s.crews.find((c) => c.id === fav.id) : null));
  const r = fav.kind === 'route' && routeInfo(fav.id), sp = r && SPACES.find((x) => x.key === r.space);
  const label = page ? page.title || t('page.untitled') : r ? t(routeLabelKey(r)) : crew?.name;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `fav:${key}`, data: { kind: 'fav', id: key, group: 'fav', label } });
  const { onTouchStart, ...mouse } = listeners ?? {}; // 터치는 길게 누르기 = 메뉴
  const menu = menuProps(() => (page ? pageMenu(page) : crew ? crewMenu(crew, space) : [{ label: t('fav.remove'), icon: 'star', run: () => { if (saveFav({ remove: key }) === false) showToast(t('crew.saveFail')); } }]));
  const to = page ? `${baseOf(page.space)}/p/${page.id}` : r && fav.id;
  const inner = page ? <Icon name={page.restricted ? 'lock' : 'doc'} /> : r ? <Icon name={routeIcon(r)} /> : <Face id={crew.id} size={18} />;
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={isDragging ? 'dragging' : ''} {...attributes} {...mergeHandlers(mouse, menu)} role="none">
    {to ? <Link to={to} className={`nav-item${path === to ? ' active' : ''}`} aria-current={path === to ? 'page' : undefined} draggable={false}>{inner}<span className="nav-label">{label}</span>{sp && <small className="fav-space">{sp.kind === 'me' ? t('space.me') : sp.name}</small>}</Link>
      : <button type="button" className="nav-item" onClick={() => setUi({ assign: { space, crew: crew.id, items: [] } })}>{inner}<span className="nav-label">{label}</span></button>}
  </div>;
}

/** 좌측 패널 맨 위 즐겨찾기(유건 9/30 #7, 10/1 "안 보인다") — 모든 공간에서 같은 목록(계정에 저장). 비어 있어도 칸과 안내 한 줄을 보이고,
 *  제목을 눌러 접는다(접힘은 사람마다 이 기기에) */
const FAV_FOLD = 'argo-office-fav-fold';
function FavSection({ space, path }) {
  const layouts = useStore((s) => s.layouts), pages = useStore((s) => s.pages), crews = useStore((s) => s.crews);
  const favs = useMemo(() => favOf({ layouts, pages, crews }), [layouts, pages, crews]);
  const [fold, setFold] = useState(() => restore(scopedStorageKey(FAV_FOLD), false));
  const flip = () => setFold((f) => { persist(scopedStorageKey(FAV_FOLD), !f); return !f; });
  return <div className="side-sec fav-sec">
    <div className="nav-section"><button type="button" className="sec-fold" aria-expanded={!fold} onClick={flip}>{t('fav.title')}<Icon name={fold ? 'chevron' : 'caret'} size={12} /></button></div>
    {!fold && (favs.length ? <div className="nav-group"><SortableContext items={favs.map((x) => `fav:${favKey(x)}`)} strategy={verticalListSortingStrategy}>
      {favs.map((x) => <FavRow key={favKey(x)} fav={x} space={space} path={path} />)}
    </SortableContext></div> : <p className="crew-empty">{t('fav.empty')}</p>)}
  </div>;
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
    home: { to: base, icon: NAV_ICON.home, label: t('nav.home'), active: at(base) },
    calendar: { to: `${base}/calendar`, icon: NAV_ICON.calendar, label: t('nav.calendar'), active: at(`${base}/calendar`) },
    business: { to: `${base}/business`, icon: NAV_ICON.business, label: t('nav.business'), active: (path === `${base}/business` || path.startsWith(`${base}/business/`)) && !path.startsWith(`${base}/business/library`) },
    contracts: { to: `${base}/contracts`, icon: NAV_ICON.contracts, label: t('nav.contracts'), active: at(`${base}/contracts`) },
    files: { to: `${base}/files`, icon: NAV_ICON.files, label: t('nav.files'), active: path === `${base}/files` || path.startsWith(`${base}/files/`) },
    mail: { to: '/me/mail', icon: NAV_ICON.mail, label: t('nav.mail'), count: unread, active: path.startsWith('/me/mail') },
    work: { to: `${base}/work`, icon: NAV_ICON.work, label: t('nav.work'), active: at(`${base}/work`) },
    approvals: { to: `${base}/approvals`, icon: NAV_ICON.approvals, label: t('nav.approvals'), count: pendingHere, active: at(`${base}/approvals`) },
    decisions: { to: `${base}/decisions`, icon: NAV_ICON.decisions, label: t('nav.decisions'), active: at(`${base}/decisions`) },
    outputs: { to: `${base}/outputs`, icon: NAV_ICON.outputs, label: t('nav.outputs'), active: at(`${base}/outputs`) },
    journal: { to: `${base}/journal`, icon: NAV_ICON.journal, label: t('nav.journal'), active: at(`${base}/journal`) },
    docs: { to: `${base}/docs`, icon: NAV_ICON.docs, label: t('nav.docs'), active: at(`${base}/docs`) },
    perf: { to: `${base}/perf`, icon: NAV_ICON.perf, label: t('nav.perf'), active: at(`${base}/perf`) },
    shared: { to: '/me/shared', icon: NAV_ICON.shared, label: t('nav.shared'), active: at('/me/shared') },
    knowhow: { to: `${base}/knowhow`, icon: NAV_ICON.knowhow, label: t('nav.knowhow'), active: at(`${base}/knowhow`) },
    tools: { to: `${base}/tools`, icon: NAV_ICON.tools, label: t('nav.tools'), active: at(`${base}/tools`) },
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
        <FavSection space={space} path={path} />
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
