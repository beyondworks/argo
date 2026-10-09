// 할 일 표에서 바로 바꾸기·캘린더에서 바로 끝내기(유건 10/9) 순수 계산 — 화면은 TaskCells.jsx·Calendar.jsx.
// 칸마다 바꿀 수 있는지(서버 office_task_write와 같은 판정, model.js whyNot), 고를 값 목록, 고른 값의 쓰기 계획만 정한다.
// 쓰기 계획은 할 일 패널과 같은 함수(planStatus·planField·planTaskCategory·planAssign)라 서버로 가는 요청 모양·기록·충돌 처리가 패널과 같다.
import * as V from './model.js';

/** 표에서 바꾸는 칸(제목은 누르면 할 일 패널) */
export const CELLS = ['status', 'priority', 'category', 'assign', 'starts_on', 'due_on'];
const OP = { status: 'status', priority: 'edit', category: 'category', assign: 'assign', starts_on: 'edit', due_on: 'date' };

/** 이 칸을 이 자리에서 바꿀 수 없는 이유(views.why.* 끝) — 되면 null. 끝낸 일은 상태(다시 열기)만 된다 */
export function cellWhyNot(it, cell, ctx) {
  if (!OP[cell]) return 'input';
  if (it.kind !== 'task') return 'eventPerm';
  return V.whyNot(it, OP[cell], ctx);
}

/** 고를 값 — [{ value, name, checked }]. name은 분류·사람 이름(상태·중요도는 화면이 사전으로 붙인다).
 *  분류·맡은 사람은 목록에 없는 지금 값(지워진 분류·나간 사람)도 남긴다 — 할 일 패널 select와 같다. 날짜 칸은 목록이 없다 */
export function cellOptions(it, cell, { categories = [], people = [], nameOf = () => '' } = {}) {
  if (cell === 'status') return [...V.STATUSES, 'done'].map((v) => ({ value: v, checked: it.status === v }));
  if (cell === 'priority') return V.PRIORITIES.map((v) => ({ value: v, checked: it.priority === v }));
  if (cell === 'category') {
    const cur = it.categoryId ?? null;
    const list = [{ value: null, name: '' }, ...categories.map((c) => ({ value: c.id, name: c.name }))];
    if (cur && !categories.some((c) => c.id === cur)) list.push({ value: cur, name: it.category || '' });
    return list.map((o) => ({ ...o, checked: o.value === cur }));
  }
  if (cell === 'assign') {
    const cur = it.src?.assignee ?? null;
    const list = people.filter((p) => p.role !== 'guest').map((p) => ({ value: p.user_id, name: p.name }));
    if (cur && !list.some((o) => o.value === cur)) list.push({ value: cur, name: nameOf(cur) });
    return list.map((o) => ({ ...o, checked: o.value === cur }));
  }
  return [];
}

/** 고른 값의 쓰기 계획 — { write } | { reason }. 같은 값이면 write: null.
 *  보류도 할 일 패널처럼 상태만 바꾼다(사유는 패널의 사유 칸 — askHoldReason이면 화면이 '사유 적기'로 연다) */
export function planCell(it, cell, value, ctx, { categories = [] } = {}) {
  if (cell === 'status') return V.planStatus(it, value, ctx);
  if (cell === 'priority') return V.planField(it, 'priority', value, ctx);
  if (cell === 'category') return V.planTaskCategory(it, value ?? null, categories.find((x) => x.id === value)?.name ?? '', ctx);
  if (cell === 'assign') return V.planAssign(it, value, ctx);
  if (cell === 'starts_on' || cell === 'due_on') return V.planField(it, cell, value || null, ctx);
  return { reason: 'input' };
}

/** 보류로 바꾼 뒤 사유를 적게 안내할까 — 보류가 아니던 일(끝낸 일 포함)을 보류로 바꿀 때만. 이미 보류면 사유는 패널에 그대로 있다 */
export const askHoldReason = (it, status) => it.kind === 'task' && status === 'hold' && it.status !== 'hold';

/** 캘린더 할 일 칩·하루 목록의 끝내기 단추 — 열린 일은 끝내기, 끝낸 일은 다시 열기(목록·표의 동그라미와 같은 계획) */
export const toggleDone = (it, ctx) => V.planDone(it, !it.done, ctx);

/** 할 일 패널 메모 칸 높이(px) — 처음 9줄 높이에서 시작해 글이 길면 글 높이만큼(유건 10/9: 4줄쯤만 보이고 스크롤됐다).
 *  scroll: 글 높이(scrollHeight + 위아래 테두리), line: 줄 높이(못 읽으면 21px). 18 = 안쪽 여백 8+8 + 테두리 1+1 */
export const NOTE_MIN_LINES = 9;
export const noteHeight = (scroll, line) => Math.max(scroll, NOTE_MIN_LINES * (line || 21) + 18);
