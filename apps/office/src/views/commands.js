// 커맨더(⌘K) 명령 — 새 일정 · 새 할 일 · 일정 보기 전환(목록·카드·칸반·표·주·월). 명령 창을 열 때 따로 받는다(첫 화면 150KB 상한).
// 실행은 일정 화면 주소로 간다(?new=·?view=) — 일정 화면이 받아서 처리하고 주소에서 뺀다(calendar/Calendar.jsx).
import { t, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { VIEWS_DICT } from './views-i18n.js';

registerDict(VIEWS_DICT);
export function viewCommands(space) {
  if (!space || space === 'shared') return [];
  const cal = `${baseOf(space)}/calendar`;
  return [
    { id: 'newEvent', label: t('views.cmd.newEvent'), icon: 'calendar', run: () => navigate(`${cal}?new=event`) },
    { id: 'newTask', label: t('views.cmd.newTask'), icon: 'check', run: () => navigate(`${cal}?new=task`) },
    ...['list', 'card', 'kanban', 'table', 'week', 'month'].map((v) => ({ id: `view-${v}`, label: t('views.cmd.view', { name: t(`views.v.${v}`) }), icon: 'layout', run: () => navigate(`${cal}?view=${v}`) })),
  ];
}
