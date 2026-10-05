// 홈 모듈 카드의 여러 보기 — '할 일'(기본은 기존 할 일 목록) 카드. '캘린더' 카드는 CalendarWidget.jsx(유건 10/1 4차 B절)가 그린다.
// 카드 오른쪽 위 ⋯ 메뉴에서 보기를 고르고, 고른 보기는 그 카드 배치 저장값(모듈 설정 cfg.views)에 같이 저장된다(유건 9/30 명세 규칙 3·4).
// 배치를 바꿀 수 없는 사람(조직 홈의 직원)은 이번 화면에서만 바뀐다 — 조직 홈 배치는 관리자가 정한다.
import { useLayoutEffect, useMemo, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { openMenu, fromInside } from '../ui/Menu.jsx';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import * as M from '../calendar/model.js';
import * as V from './model.js';
import { pref } from '../calendar/shared.js';
import { MonthView, TimeGrid } from '../calendar/Calendar.jsx';
import { useViewTasks, usePeople, makeCtx } from './data.js';
import { ItemsView, useItemActions, viewMenu } from './Board.jsx';
import CalendarWidget from './CalendarWidget.jsx';

const CARD_VIEWS = ['list', 'card', 'kanban', 'table', 'week', 'month'];

export default function HomeView(props) {
  return props.mode === 'calendar' ? <CalendarWidget {...props} /> : <TodosView {...props} />;
}

function TodosView({ space, item, canEdit, setCfg, menu, Default, onSub }) {
  useLang();
  const views = ['tasks', ...CARD_VIEWS];
  const base = { view: 'tasks', filter: { kind: 'task' } };
  const [local, setLocal] = useState(null);
  const cfg = V.normalizeCfg(local ?? item?.cfg?.views, base, views);
  const set = (patch) => {
    const next = V.normalizeCfg({ ...cfg, ...patch }, base, views);
    if (canEdit && setCfg) { setLocal(null); setCfg({ views: next }); } else setLocal(next);
  };
  useLayoutEffect(() => { onSub?.(cfg.view === 'tasks' ? t('views.v.tasksShort') : t(`views.v.${cfg.view}`)); }); // 머리에 지금 보기 이름("할 일 · 월") — 같은 모듈을 여러 개 놓았을 때 구분(유건 10/1 5차)
  if (menu) menu.current = () => [...viewMenu(cfg, set, views), { sep: true }];
  if (cfg.view === 'tasks') return <Default space={space} />;
  const calView = cfg.view === 'week' || cfg.view === 'month';
  const today = M.localDay(Date.now());
  const [from, to] = calView ? M.windowOf('month', today) : [today, M.addDays(today, 8)];
  return <Card space={space} item={item} cfg={cfg} set={set} views={views} from={from} to={to} today={today} />;
}

function Card({ space, item, cfg, set, views, from, to, today }) {
  const tasks = useViewTasks(space), people = usePeople(space);
  const ctx = useMemo(() => makeCtx(today, people), [today, people]);
  const calView = cfg.view === 'week' || cfg.view === 'month';
  const base = baseOf(space);
  // 할 일 카드 — 열린 할 일 전부(기한 없음·지남 포함) + 최근 7일에 끝낸 것
  const items = useMemo(() => {
    const recent = M.addDays(today, -7);
    return V.mergeItems([], tasks.filter((x) => !x.done_at || M.kstDay(x.done_at) >= recent), { from: '0000-01-01', to: '9999-12-31', undated: true });
  }, [tasks, today]);
  const openItem = (it) => actions.openTask(it); // 할 일을 누르면 그 자리에서 오른쪽 할 일 패널(유건 10/4)
  const actions = useItemActions({ space, ctx, people, categories: [], onOpen: openItem, onNewEvent: () => navigate(`${base}/calendar?new=event`) });
  if (calView) {
    const cal = items.filter((it) => it.day).map((it) => ({ kind: 'task', key: it.key, id: it.id, title: it.title, done: it.done, space: it.space, all_day: true, start: M.kstStart(it.day), end: M.kstStart(M.addDays(it.day, 1)), vi: it })); // 기한 없는 할 일은 먼저 거른다 — 날짜 계산(addDays)이 오류를 내 홈 전체가 멈췄다(유건 10/2)
    const props = { items: cal, today, now: Date.now(), colorBy: pref('color', 'category'), holidays: true, phone: true,
      onOpen: (o) => openItem(o.vi), onMenu: (o) => actions.single(o.vi), onCreate: ({ day }) => navigate(`${base}/calendar?day=${day}&new=event`), onDay: (d) => navigate(`${base}/calendar?day=${d}`) };
    return <div className="cal-emb" onContextMenu={(e) => { if (fromInside(e) && !e.target.closest('.cal-chip, .cal-block')) openMenu(e, actions.empty(cfg, set, views)); }}>
      {cfg.view === 'month' ? <MonthView {...props} anchor={today} /> : <TimeGrid {...props} days={M.weekDays(today)} />}
      {actions.dialogs}
    </div>;
  }
  return <>
    <ItemsView id={`home:${space}:${item?.id ?? 'x'}`} items={items} cfg={cfg} setCfg={set} views={views} today={today} ctx={ctx} people={people} actions={actions} colorBy={pref('color', 'category')} compact onOpen={openItem} />
    {actions.dialogs}
  </>;
}
