// 커맨더(⌘K) 명령 — 새 일정 · 새 할 일 · 할 일 보기 · 일정 보기 전환(목록·카드·칸반·표·주·월). 명령 창을 열 때 따로 받는다(첫 화면 150KB 상한).
// 실행은 화면 주소로 간다(?new=·?view=) — 일정 화면(calendar/Calendar.jsx)·할 일 화면(views/TasksPage.jsx)이 받아서 처리하고 주소에서 뺀다.
import { t, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { isFav, toggleFav, getState } from '../core/store.js';
import { favTarget } from '../core/nav-model.js';
import { showToast } from '../ui/Overlay.jsx';
import { VIEWS_DICT } from './views-i18n.js';

registerDict(VIEWS_DICT);
export function viewCommands(space) {
  if (!space || space === 'shared') return [];
  const cal = `${baseOf(space)}/calendar`;
  // 지금 화면을 즐겨찾기에 넣고 빼기(상단 ☆와 같은 대상) — 템플릿 페이지는 우클릭 메뉴처럼 뺀다
  const fav = favTarget(location.pathname), tpl = fav?.kind === 'page' && getState().pages.find((p) => p.id === fav.id)?.template;
  return [
    fav && !tpl && { id: 'fav', label: t(isFav(fav.kind, fav.id) ? 'fav.remove' : 'fav.add'), icon: 'star', run: () => { if (toggleFav(fav.kind, fav.id) === false) showToast(t('crew.saveFail')); } },
    { id: 'newEvent', label: t('views.cmd.newEvent'), icon: 'calendar', run: () => navigate(`${cal}?new=event`) },
    { id: 'newTask', label: t('views.cmd.newTask'), icon: 'check', run: () => navigate(`${baseOf(space)}/tasks?new=1`) }, // 할 일 화면(유건 10/4)에서 새 할 일 창
    { id: 'tasks', label: t('views.cmd.tasks'), icon: 'todo', run: () => navigate(`${baseOf(space)}/tasks`) },
    ...['list', 'card', 'kanban', 'table', 'week', 'month'].map((v) => ({ id: `view-${v}`, label: t('views.cmd.view', { name: t(`views.v.${v}`) }), icon: 'layout', run: () => navigate(`${cal}?view=${v}`) })),
  ].filter(Boolean);
}
