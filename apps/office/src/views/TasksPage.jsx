// 할 일 화면 — 왼쪽 메뉴 '할 일'(유건 10/4, 오피스 14차 트랙 T). 여러 보기(목록·칸반·표)를 할 일만 걸러 쓴다.
// 목록은 분류·상태·담당으로 묶고 묶음마다 끝낸 수/전체, 칸반은 상태(할 일·진행 중·보류·끝냄)·분류·담당·날짜 칸으로 끌어 바꾼다.
// 거르기: 상태·중요도·분류·맡은 사람·기간, 정렬: 기한·중요도·만든 날(빠른·늦은 순). 할 일을 누르면 오른쪽 할 일 패널.
// 주소: ?new=1(새 할 일 창 — ⌘K) · ?open=할 일 id(그 할 일 패널) · ?due=overdue|today(홈 '챙길 것'에서 — 내가 맡은 안 끝낸 일의 기한 지남·오늘 마감으로 거른다). 보기 설정은 사람마다 이 브라우저에(views/data.js).
// 부하: 할 일 읽기는 기존 저장소(공간마다 한 번), 분류는 공간마다 세션에 한 번. 폴링 없음.
import { useEffect, useMemo, useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { canManage, ME } from '../core/session.js';
import { navigate, useUrl } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { openMenu } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import * as V from './model.js';
import { useViewTasks, usePeople, makeCtx, readCfg, writeCfg, useTaskCategories, categoriesOf, useTaskLoad } from './data.js';
import { LoadFail } from '../ui/LoadFail.jsx';
import { ItemsView, useItemActions, filterMenu, filterCount, Dropdown } from './Board.jsx';
import TaskCategories from './TaskCategories.jsx';
import { kstDay } from '../core/task-model.js';
import { TASK_DICT } from '../pages/task-i18n.js';
import { VIEWS_DICT } from './views-i18n.js';
import './views.css';

registerDict({ ...TASK_DICT, ...VIEWS_DICT });
const VIEWS = ['list', 'kanban', 'table'];
const BASE = { view: 'list', group: 'status', sort: 'date', dir: 'asc', listGroup: 'none', filter: { kind: 'task' } };
const SORT_OPTS = ['date:asc', 'date:desc', 'priority:asc', 'priority:desc', 'created:desc', 'created:asc'];
const KANBAN_GROUPS = ['status', 'category', 'who', 'date'];

export default function TasksPage({ space }) {
  useLang();
  const today = kstDay();
  const [saved, setSaved] = useState(() => V.normalizeCfg(readCfg(`tasks:${space}`), BASE, VIEWS));
  const [temp, setTemp] = useState(null); // ?due 거르기 — 이 창에서만, 저장하지 않는다(OFC-15)
  const cfg = useMemo(() => V.shownCfg(saved, temp, BASE, VIEWS), [saved, temp]);
  const setCfg = (patch) => { const r = V.patchCfg(saved, temp, patch, { base: BASE, views: VIEWS, fixed: { kind: 'task' } }); setSaved(r.saved); setTemp(r.temp); writeCfg(`tasks:${space}`, r.saved); };
  const load = useTaskLoad(space);
  const [cats, setCats] = useState(false);
  const tasks = useViewTasks(space), people = usePeople(space);
  const spaces = useMemo(() => [space, ...new Set(tasks.map((x) => x.space))], [space, tasks]);
  const catVer = useTaskCategories(spaces);
  const ctx = useMemo(() => makeCtx(today, people), [today, people, catVer]);
  // 열린 할 일 전부 + 최근 30일에 끝낸 일(서버가 그만큼 준다) — 기한 없는 일·지난 일 포함, 취소한 일은 뺀다
  const items = useMemo(() => V.mergeItems([], tasks, { from: '0000-01-01', to: '9999-12-31', undated: true }), [tasks]);
  const own = categoriesOf(space).map((c) => c.name);
  // 분류 이름 — 이 공간 분류(관리 순서) 다음에, 개인 공간에 겹쳐 보이는 조직 할 일의 분류(이름순)
  const catNames = useMemo(() => [...own, ...[...new Set(items.map((x) => x.category).filter((n) => n && !own.includes(n)))].sort((a, b) => a.localeCompare(b, 'ko'))], [own.join('\n'), items]);
  const whoKeys = useMemo(() => [...new Set(items.map((x) => x.who).filter(Boolean))], [items]);
  const manageable = space === 'me' || canManage(space);
  const actions = useItemActions({ space, ctx, people, onOpen: (it) => actions.openTask(it), onNewEvent: () => navigate(`${baseOf(space)}/calendar?new=event`), onManageCats: manageable ? () => setCats(true) : undefined });

  // 주소로 온 요청 — ?new=1(새 할 일) · ?open=id(그 할 일 패널). 처리하면 주소에서 뺀다
  const [path, qs] = useUrl().split('?');
  const q = new URLSearchParams(qs ?? '');
  const wantNew = q.get('new'), wantOpen = q.get('open'), wantDue = q.get('due');
  const strip = (...keys) => { keys.forEach((k) => q.delete(k)); const rest = q.toString(); navigate(`${path}${rest ? `?${rest}` : ''}`, { replace: true }); };
  useEffect(() => { if (wantNew) { actions.newTask(); strip('new'); } }, [wantNew]);
  useEffect(() => { if (!wantOpen) return; const it = items.find((x) => x.id === wantOpen); if (it) { actions.openTask(it); strip('open'); } }, [wantOpen, items]);
  // 홈 '챙길 것'·메뉴 배지와 같은 할 일만(내가 맡은·안 끝낸·그 기한) — 이 창에서만 거르고 저장하지 않는다(사람이 거르기를 바꾸면 그때 저장된다)
  useEffect(() => { const f = V.dueFilter(saved.filter, wantDue, ME.id); if (!f) return; setTemp(f); strip('due'); }, [wantDue]);

  const open = items.filter((x) => !x.done).length, done = items.length - open;
  const nf = filterCount(cfg.filter, false);
  const fmenu = (e) => openMenu(e, filterMenu(cfg, setCfg, { whoKeys, categories: catNames, people, kinds: false, tasks: true }), { anchor: e.currentTarget });
  const opts = (list, key) => list.map((v) => ({ value: v, label: t(`${key}.${v}`) }));
  return <div className="page-wrap wide tk">
    <header className="page-title-row"><div><h1 className="page-h1">{t('tasks.title')}</h1><p className="dim" role="status">{load.waiting ? t('biz.loading') : load.failed && !items.length ? '' : t('tasks.count', { open, done })}</p></div></header>
    <div className="tk-bar">
      <span className="tk-tools">
        {cfg.view === 'list' && <Dropdown label={t('views.group')} value={cfg.listGroup} options={V.LIST_GROUPS.map((g) => ({ value: g, label: g === 'none' ? t('views.lg.none') : t(`views.g.${g}`) }))} onChange={(g) => setCfg({ listGroup: g })} />}
        {cfg.view === 'kanban' && <Dropdown label={t('views.group')} value={cfg.group} options={opts(KANBAN_GROUPS, 'views.g')} onChange={(g) => setCfg({ group: g })} />}
        <Dropdown label={t('views.sort')} value={`${cfg.sort}:${cfg.dir}`} options={SORT_OPTS.map((v) => ({ value: v, label: t(`tasks.sort.${v.replace(':', '.')}`) }))}
          onChange={(v) => { const [sort, dir] = v.split(':'); setCfg({ sort, dir }); }} />
        <button type="button" className={`btn sm vw-dd${nf ? ' on' : ''}`} aria-haspopup="menu" onClick={fmenu} onKeyDown={(e) => { if (e.key === 'ArrowDown') fmenu(e); }}>{nf ? t('views.filterOn', { n: nf }) : t('views.filter')}<Icon name="caret" size={12} /></button>
        <Dropdown label={t('views.view')} value={cfg.view} options={opts(VIEWS, 'views.v')} onChange={(v) => setCfg({ view: v })} />
        {manageable && <button type="button" className="btn sm" onClick={() => setCats(true)}><Icon name="tag" size={13} />{t('task.manageCats')}</button>}
        <button type="button" className="btn sm primary" onClick={() => actions.newTask()}><Icon name="plus" size={13} />{t('views.newTask')}</button>
      </span>
    </div>
    {load.failed && <LoadFail text={t(load.failed)} onRetry={load.retry} />}{/* 읽기 실패 — '할 일 없음'으로 보이지 않게(OFC-04). 받아 둔 조직 할 일은 아래에 그대로 */}
    {load.waiting ? <p className="vw-empty" role="status">{t('biz.loading')}</p>
      : !(load.failed && !items.length) && <ItemsView id={`tasks:${space}`} items={items} cfg={cfg} setCfg={setCfg} views={VIEWS} today={today} ctx={ctx} people={people} actions={actions} onOpen={(it) => actions.openTask(it)} tasks cats={catNames} />}
    {actions.dialogs}
    {cats && <TaskCategories space={space} onClose={() => setCats(false)} />}
  </div>;
}
