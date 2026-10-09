// 할 일 표 칸(유건 10/9) — 상태·중요도는 값마다 색이 다른 뱃지, 분류·맡은 사람은 드롭다운, 시작일·기한은 날짜 고르기. 누르면 그 자리에서 바뀐다.
// 바꿀 수 없는 칸(권한·끝낸 일·개인 할 일의 맡은 사람)은 글자로만 보이고, 마우스를 올리면 이유가 보인다(할 일 패널의 잠금과 같은 규칙).
// 값 목록·권한·쓰기 계획은 cells.js(순수), 쓰기는 useItemActions의 setCell(Board.jsx — 한 건이라 먼저 화면에 반영하고 실패하면 되돌린다).
// 부하: 사람이 고를 때만 쓰기 한 번 + 그 공간 할 일 목록 다시 읽기 한 번(할 일 패널과 같다). 폴링 없음.
import { useRef } from 'react';
import { t } from '../core/i18n.js';
import { openMenu } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { fmtDay } from '../calendar/shared.js';
import * as C from './cells.js';
import { categoriesOf } from './data.js';

const LABEL = { status: 'views.th.status', priority: 'views.th.priority', category: 'views.category', assign: 'task.f.assignee', starts_on: 'views.th.start', due_on: 'views.th.due' };
const DAY = { starts_on: { month: 'short', day: 'numeric' }, due_on: { month: 'short', day: 'numeric', weekday: 'short' } };

/** 상태·중요도 뱃지 — 할 일 회색·진행 중 파랑·보류 주황·끝냄 초록, 중요도 높음 빨강·보통 회색·낮음 흐린 회색(views.css .tk-pill) */
export const Pill = ({ kind, value, children }) => <span className={`badge tk-pill ${kind === 'status' ? 'st' : 'pr'}-${value}`}>{children ?? (kind === 'status' ? t(`task.st.${value}`) : t(`task.pr.${value}`))}</span>;

const whoText = (it, people) => (!it.who ? t('views.none.who') : it.who === `p:${people.me}` ? t('views.me') : people.name(it.who));

/** 표 한 칸. it: 할 일 보기 항목, cell: cells.js CELLS 하나, actions: useItemActions 결과(setCell·manageCats·space) */
export function TaskCell({ it, cell, ctx, people, actions }) {
  const field = t(LABEL[cell]);
  if (cell === 'starts_on' || cell === 'due_on') return <DateCell it={it} cell={cell} field={field} why={C.cellWhyNot(it, cell, ctx)} actions={actions} />;
  const opts = C.cellOptions(it, cell, { categories: categoriesOf(it.space), people: people.list(it.space), nameOf: (id) => people.name(`p:${id}`) });
  const manage = cell === 'category' && actions.manageCats && it.space === actions.space; // 분류 관리는 보고 있는 공간의 분류만(할 일 패널과 같다)
  const why = C.cellWhyNot(it, cell, ctx) ?? (opts.length < 2 && !manage ? 'input' : null); // 고를 것이 하나뿐이면(직원이 나 혼자·분류 없음) 글자로
  const shown = cell === 'status' || cell === 'priority' ? <Pill kind={cell} value={it[cell]} />
    : cell === 'category' ? (it.category || <span className="dim">{t('task.uncategorized')}</span>) : whoText(it, people);
  if (why) return <span className="tk-cell-text" title={why === 'input' ? undefined : t(`views.why.${why}`)}>{shown}</span>;
  const name = (o) => (cell === 'status' || cell === 'priority' ? <Pill kind={cell} value={o.value} />
    : cell === 'category' ? o.name || t('task.uncategorized') : o.value === people.me ? t('task.me') : o.name || '?');
  const open = (e) => openMenu(e, [{ heading: field },
    ...opts.map((o) => ({ label: name(o), checked: o.checked, run: () => actions.setCell(it, cell, o.value) })),
    ...(manage ? [{ sep: true }, { label: t('task.manageCats'), icon: 'tag', run: actions.manageCats }] : []),
  ], { anchor: e.currentTarget });
  const value = cell === 'status' ? t(`task.st.${it.status}`) : cell === 'priority' ? t(`task.pr.${it.priority}`) : cell === 'category' ? it.category || t('task.uncategorized') : whoText(it, people);
  return <button type="button" className={`vw-ed tk-cell-btn${cell === 'status' || cell === 'priority' ? ' pill' : ''}`} aria-haspopup="menu" aria-label={t('tasks.cell', { field, value })} title={t('tasks.cell', { field, value })}
    onClick={open} onKeyDown={(e) => { if (e.key === 'ArrowDown') open(e); }}>
    {shown}<Icon name="caret" size={11} className="tk-caret" />
  </button>;
}

/** 시작일·기한 — 누르면 브라우저 날짜 고르기(보이지 않는 날짜 칸의 showPicker), 날짜가 있으면 옆 ×로 지운다. 시작일은 기한보다 늦게 못 고른다 */
function DateCell({ it, cell, field, why, actions }) {
  const ref = useRef(null);
  const value = cell === 'due_on' ? it.day : it.starts;
  const text = value ? fmtDay(value, DAY[cell]) : '';
  const shown = text || <span className="dim">—</span>;
  if (why) return <span className="tk-cell-text" title={t(`views.why.${why}`)}>{shown}</span>;
  const pick = (e) => {
    e.stopPropagation();
    const el = ref.current;
    try { el.showPicker(); } catch { el.focus(); el.click(); } // showPicker가 없는 옛 브라우저는 날짜 칸을 눌러 연다
  };
  const label = t('tasks.cell', { field, value: text || t('views.noDate') });
  return <span className="vw-ed tk-dcell">
    <button type="button" className="tk-cell-btn" aria-label={label} title={label} onClick={pick}>{shown}</button>
    {value && <button type="button" className="icon-btn tk-dcell-x" aria-label={t('tasks.clearDate', { field })} title={t('tasks.clearDate', { field })} onClick={(e) => { e.stopPropagation(); actions.setCell(it, cell, null); }}><Icon name="x" size={11} /></button>}
    <input ref={ref} type="date" className="tk-dcell-in" tabIndex={-1} aria-hidden="true" value={value ?? ''}
      min={cell === 'due_on' ? it.starts ?? undefined : undefined} max={cell === 'starts_on' ? it.day ?? undefined : undefined}
      onChange={(e) => actions.setCell(it, cell, e.target.value || null)} />
  </span>;
}
