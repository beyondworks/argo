// 홈 '캘린더' 모듈(위젯) 순수 계산 — 유건 10/1 4차 명세 B절.
// 보기 9가지(목록·카드·칸반·표·주·월·미니 달력·오늘 시간표·다음 일정), 디자인 3가지(미니멀·강조·기본), 위젯마다 따로 정하는 색 기준·보여 줄 것.
// 위젯 설정은 모듈 배치 항목의 cfg.cal에 저장한다. 사용자가 고르지 않은 값은 캘린더 페이지 설정(색 기준·끈 캘린더)을 따른다.
import * as M from './model.js';

export const WIDGET_VIEWS = ['list', 'card', 'kanban', 'table', 'week', 'month', 'mini', 'day', 'next'];
/** 디자인이 모양을 바꾸는 보기 — 나머지(목록·카드·칸반·표·오늘 시간표·다음 일정)는 기존 모양 */
export const DESIGNED = ['week', 'month', 'mini'];
/** 위·아래로 옮길 수 있는 보기(‹ 오늘 ›) — 옮긴 자리는 저장하지 않는다 */
export const NAVIGABLE = DESIGNED;
export const DESIGNS = ['minimal', 'accent', 'basic'];
export const COLOR_BY = ['category', 'person', 'agent'];
export const SHOWS = ['org', 'me', 'tasks', 'holidays'];

/** 저장값(cfg.cal) → 아는 값만. 고르지 않은 칸은 비워 둔다(= 페이지 설정을 따른다) */
export function normalizeWidget(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}, s = r.show && typeof r.show === 'object' ? r.show : {};
  const out = {};
  if (DESIGNS.includes(r.design)) out.design = r.design;
  if (COLOR_BY.includes(r.color)) out.color = r.color;
  const show = {};
  for (const k of SHOWS) if (typeof s[k] === 'boolean') show[k] = s[k];
  if (Object.keys(show).length) out.show = show;
  return out;
}

/** 캘린더 페이지 설정 → 위젯 기본값. off: 페이지에서 끈 것(캘린더 id·'tasks'·'holidays'), orgIds: 개인 공간에서 보이는 조직 캘린더 id */
export function pageDefaults({ color = 'category', off = [], space, orgIds = [] }) {
  const has = (k) => off.includes(k);
  return {
    color: COLOR_BY.includes(color) ? color : 'category',
    show: {
      me: !has(space === 'me' ? 'me' : 'mine'),
      org: space === 'me' ? orgIds.length === 0 || orgIds.some((id) => !has(id)) : !has('others'),
      tasks: !has('tasks'),
      holidays: !has('holidays'),
    },
  };
}

/** 위젯이 실제로 쓸 값 — own: 위젯이 직접 정한 보여 줄 것(나머지는 페이지를 캘린더 단위로 따른다) */
export function resolveWidget(raw, page) {
  const n = normalizeWidget(raw);
  return { design: n.design ?? 'minimal', color: n.color ?? page.color, show: { ...page.show, ...n.show }, own: n.show ?? {} };
}

/** 설정 창에서 저장 — 페이지 기본값과 같은 값은 적지 않는다(그 칸은 계속 페이지를 따른다). 디자인은 그대로 둔다 */
export function widgetPatch(raw, { color, show }, page) {
  const n = normalizeWidget(raw), out = {};
  if (n.design) out.design = n.design;
  if (COLOR_BY.includes(color) && color !== page.color) out.color = color;
  const diff = {};
  for (const k of SHOWS) if (typeof show?.[k] === 'boolean' && show[k] !== page.show[k]) diff[k] = show[k];
  if (Object.keys(diff).length) out.show = diff;
  return out;
}

/** 이 일정이 '내 일정'인지 '조직 일정'인지 — 개인 공간은 조직 캘린더면 조직, 조직 공간은 내가 주인·참석이면 내 일정 */
export const sourceOf = (e, space, me) => (space === 'me' ? (e.org_id ? 'org' : 'me') : e.owner === me || e.attendees?.includes(me) ? 'me' : 'org');

/** 일정 거르기 — 위젯이 직접 정한 값이 있으면 그것, 없으면 페이지에서 끈 캘린더(calKey: 페이지 캘린더 구분)를 따른다 */
export function keepEvent(e, { space, me, own = {}, off = [], calKey }) {
  const src = sourceOf(e, space, me);
  return typeof own[src] === 'boolean' ? own[src] : !off.includes(calKey);
}

/** 제목 줄을 숨기는 위젯 — 미니멀·강조 디자인의 주·월·미니 보기 */
export const isBare = (view, design) => DESIGNED.includes(view) && design !== 'basic';

/** 보기별로 서버에서 읽을 한국 날짜 창 [from, to) — 보이는 범위를 덮는다. 주·월·미니는 그달 격자 창(캘린더 페이지와 같은 창이라 다시 받지 않는다) */
export function readWindow(view, anchor, today) {
  if (DESIGNED.includes(view)) return M.windowOf('month', anchor);
  if (view === 'day') return M.windowOf('month', today);
  if (view === 'next') return M.windowOf('list', today);
  return [today, M.addDays(today, 8)];
}

/** ‹ › 한 번에 옮기는 양 — 주는 7일, 월·미니는 한 달(그달 1일) */
export function navShift(view, anchor, dir) {
  if (view === 'week') return M.addDays(anchor, 7 * dir);
  return M.addMonths(anchor, dir);
}

/** 그달 날짜가 하나라도 있는 주만(4~6주) — 각 주는 월~일 7일 */
export function monthWeeks(anchor) {
  const grid = M.monthGrid(anchor), cur = M.monthOf(anchor), out = [];
  for (let i = 0; i < 6; i++) { const w = grid.slice(i * 7, i * 7 + 7); if (w.some((d) => M.monthOf(d) === cur)) out.push(w); }
  return out;
}

/** 이번 달 진행 막대(강조 디자인) — 주마다 채운 비율. 지난 주는 1, 오늘이 든 주는 지난 날 수/7(오늘 포함), 올 주는 0 */
export function monthProgress(today) {
  return monthWeeks(today).map((w) => (today > w[6] ? 1 : today < w[0] ? 0 : (M.dayDiff(w[0], today) + 1) / 7));
}

const isBarItem = (o) => o.kind === 'task' || M.isBar(o);
/** 날짜별 항목 — days: 날짜들, items: 달력 항목(회차·할 일 기한). 여러 날 걸친 것은 걸친 날마다. 같은 날은 종일·할 일 먼저, 그다음 시작 시각순 */
export function dayBuckets(days, items) {
  const out = new Map(days.map((d) => [d, []]));
  for (const o of items) {
    const [a, b] = M.spanOf(o);
    for (const d of days) if (d >= a && d <= b) out.get(d).push(o);
  }
  for (const list of out.values()) list.sort((x, y) => isBarItem(y) - isBarItem(x) || x.start - y.start || x.title.localeCompare(y.title));
  return out;
}

/** 다음 일정 하나 — 지금 진행 중인 시간 일정이 먼저, 없으면 가장 먼저 시작할 일정. 이미 시작한 종일 일정은 '다음'이 아니다.
 *  rest: 그다음 일정 n개(아직 시작하지 않은 것). 할 일은 넣지 않는다 */
export function nextUp(items, now, n = 3) {
  const list = items.filter((o) => o.kind !== 'task' && o.end > now).sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  const main = list.find((o) => !o.all_day && o.start <= now) ?? list.find((o) => o.start > now) ?? null;
  if (!main) return { main: null, live: false, rest: [] };
  return { main, live: main.start <= now, rest: list.filter((o) => o !== main && o.start > now).slice(0, n) };
}

const MIN = 60e3, HOUR = 60 * MIN;
/** 남은 시간 글자 재료 — 1시간 안은 분, 같은 날은 시간(반올림), 내일, 그 뒤는 날 수(브라우저 날짜 기준) */
export function untilParts(now, at) {
  const d = at - now;
  if (d < HOUR) return { unit: 'min', n: Math.max(1, Math.ceil(d / MIN)) };
  const gap = M.dayDiff(M.localDay(now), M.localDay(at));
  if (gap <= 0) return { unit: 'hour', n: Math.max(1, Math.round(d / HOUR)) };
  if (gap === 1) return { unit: 'tomorrow', n: 1 };
  return { unit: 'day', n: gap };
}
/** 진행 중 일정의 남은 시간 — 1시간 안은 분, 그 뒤는 시간(반올림) */
export function leftParts(now, end) {
  const d = Math.max(0, end - now);
  return d < HOUR ? { unit: 'min', n: Math.max(1, Math.ceil(d / MIN)) } : { unit: 'hour', n: Math.round(d / HOUR) };
}
