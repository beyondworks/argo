// 홈 모듈 카드의 여러 보기 — '다가오는 일정'(일정 + 할 일 기한, 7일, 기본 목록)과 '할 일'(기본은 기존 할 일 목록) 카드.
// 카드 오른쪽 위 ⋯ 메뉴에서 보기를 고르고, 고른 보기는 그 카드 배치 저장값(모듈 설정 cfg.views)에 같이 저장된다(유건 9/30 명세 규칙 3·4).
// 배치를 바꿀 수 없는 사람(조직 홈의 직원)은 이번 화면에서만 바뀐다 — 조직 홈 배치는 관리자가 정한다.
import { useMemo, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { openMenu } from '../ui/Menu.jsx';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import * as M from '../calendar/model.js';
import * as V from './model.js';
import { useEvents } from '../calendar/api.js';
import { inSpace, calOf, pref } from '../calendar/shared.js';
import { MonthView, TimeGrid } from '../calendar/Calendar.jsx';
import { useViewTasks, usePeople, makeCtx } from './data.js';
import { ItemsView, useItemActions, viewMenu } from './Board.jsx';

const CARD_VIEWS = ['list', 'card', 'kanban', 'table', 'week', 'month'];
const NO_EVENTS = { events: [] };

export default function HomeView({ space, item, canEdit, setCfg, menu, mode, Default }) {
  useLang();
  const todos = mode === 'todos';
  const views = todos ? ['tasks', ...CARD_VIEWS] : CARD_VIEWS;
  const base = todos ? { view: 'tasks', filter: { kind: 'task' } } : { view: 'list' };
  const [local, setLocal] = useState(null);
  const cfg = V.normalizeCfg(local ?? item?.cfg?.views, base, views);
  const set = (patch) => {
    const next = V.normalizeCfg({ ...cfg, ...patch }, base, views);
    if (canEdit && setCfg) { setLocal(null); setCfg({ views: next }); } else setLocal(next);
  };
  if (menu) menu.current = () => [
    ...viewMenu(cfg, set, views),
    ...(!todos && cfg.view !== 'week' && cfg.view !== 'month' ? [{ heading: t('views.kind') }, ...V.KINDS.map((k) => ({ label: t(`views.k.${k}`), checked: cfg.filter.kind === k, run: () => set({ filter: { ...cfg.filter, kind: k } }) }))] : []),
    { sep: true },
  ];
  if (cfg.view === 'tasks') return <Default space={space} />;
  const calView = cfg.view === 'week' || cfg.view === 'month';
  const today = M.localDay(Date.now());
  const [from, to] = calView ? M.windowOf('month', today) : [today, M.addDays(today, 8)]; // 읽기 창은 달력 홈 카드와 같게(같은 창은 한 번만 읽는다)
  return todos ? <Card space={space} item={item} cfg={cfg} set={set} views={views} from={from} to={to} today={today} data={NO_EVENTS} todos />
    : <WithEvents from={from} to={to}>{(data) => <Card space={space} item={item} cfg={cfg} set={set} views={views} from={from} to={to} today={today} data={data} />}</WithEvents>;
}
function WithEvents({ from, to, children }) { return children(useEvents(from, to)); }

function Card({ space, item, cfg, set, views, from, to, today, data, todos = false }) {
  const tasks = useViewTasks(space), people = usePeople(space);
  const ctx = useMemo(() => makeCtx(today, people), [today, people]);
  const calView = cfg.view === 'week' || cfg.view === 'month';
  const base = baseOf(space);
  const occ = useMemo(() => {
    if (!data.events) return [];
    const off = new Set(pref(`off:${space}`, []));
    const lo = calView ? M.kstStart(from) : Date.now(), hi = M.kstStart(calView ? to : M.addDays(today, 7)); // 카드 목록은 지금부터 7일(끝난 일정은 빼고)
    return M.expand(inSpace(data.events, space), lo, hi).filter((o) => !off.has(calOf(o, space)));
  }, [data.events, space, calView, from, to, today]);
  const items = useMemo(() => {
    if (todos) { // 할 일 카드 — 열린 할 일 전부(기한 없음·지남 포함) + 최근 7일에 끝낸 것
      const recent = M.addDays(today, -7);
      return V.mergeItems([], tasks.filter((x) => !x.done_at || M.kstDay(x.done_at) >= recent), { from: '0000-01-01', to: '9999-12-31', undated: true });
    }
    return V.mergeItems(occ, tasks, { from: calView ? from : today, to: calView ? to : M.addDays(today, 7) });
  }, [todos, occ, tasks, calView, from, to, today]);
  const categories = useMemo(() => [...new Set(items.map((x) => x.category).filter(Boolean))].sort(), [items]);
  const openItem = (it) => (it.kind === 'task' ? navigate(`${baseOf(it.space)}?open=${it.id}`) : navigate(`${base}/calendar?day=${it.day}&open=${encodeURIComponent(it.key)}`));
  const actions = useItemActions({ space, ctx, people, categories, onOpen: openItem, onNewEvent: () => navigate(`${base}/calendar?new=event`) });
  if (!data.events && !todos) return <div className="mod-empty" role="status">{data.error ? t(data.error) : t('cal.loading')}</div>;
  if (calView) {
    const cal = items.map((it) => (it.kind === 'task' ? { kind: 'task', key: it.key, id: it.id, title: it.title, done: it.done, space: it.space, all_day: true, start: M.kstStart(it.day), end: M.kstStart(M.addDays(it.day, 1)), vi: it } : { ...it.src, vi: it }));
    const props = { items: cal, today, now: Date.now(), colorBy: pref('color', 'category'), holidays: true, phone: true,
      onOpen: (o) => openItem(o.vi), onMenu: (o) => actions.single(o.vi), onCreate: ({ day }) => navigate(`${base}/calendar?day=${day}&new=event`), onDay: (d) => navigate(`${base}/calendar?day=${d}`) };
    return <div className="cal-emb" onContextMenu={(e) => { if (!e.target.closest('.cal-chip, .cal-block')) openMenu(e, actions.empty(cfg, set, views)); }}>
      {cfg.view === 'month' ? <MonthView {...props} anchor={today} /> : <TimeGrid {...props} days={M.weekDays(today)} />}
      {actions.dialogs}
    </div>;
  }
  return <>
    <ItemsView id={`home:${space}:${item?.id ?? 'x'}`} items={items} cfg={cfg} setCfg={set} views={views} today={today} ctx={ctx} people={people} actions={actions} colorBy={pref('color', 'category')} compact onOpen={openItem} />
    {actions.dialogs}
  </>;
}
