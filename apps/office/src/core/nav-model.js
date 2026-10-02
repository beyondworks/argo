import { BUSINESS_MODULES } from './module-registry.js';

// 좌측 메뉴·업무 탭 순서(유건 9/30: "메뉴가 하드코딩이면 모듈식이 아니다") — 사람마다 저장한다(office_user_layouts nav:me · biztabs:me).
// 메뉴는 내 공간·조직 공간 목록이 달라도 순서·숨김은 한 목록으로 둔다. 홈은 숨길 수 없고, 설정·휴지통은 아래 고정 칸이라 목록에 없다.
export const NAV = {
  me: ['home', 'calendar', 'business', 'mail', 'approvals', 'shared', 'knowhow', 'tools'],
  org: ['home', 'calendar', 'business', 'work', 'approvals', 'decisions', 'outputs', 'journal', 'docs', 'people', 'company', 'perf', 'knowhow', 'tools'],
};
export const SECTIONS = ['menu', 'pages', 'crews'];
// 공간 주소 뒤에 붙는 화면(App.jsx route가 같은 목록을 쓴다) — 메뉴 이름 사전은 nav.<화면>, 아이콘은 NAV_ICON
export const VIEWS = ['calendar', 'mail', 'shared', 'work', 'approvals', 'decisions', 'outputs', 'journal', 'docs', 'people', 'company', 'perf', 'knowhow', 'tools', 'trash', 'settings'];
export const NAV_ICON = { home: 'home', calendar: 'calendar', business: 'chart', mail: 'mail', work: 'run', approvals: 'stamp', decisions: 'check', outputs: 'file', journal: 'book', docs: 'doc', people: 'person', company: 'building', perf: 'target', shared: 'share', knowhow: 'book', tools: 'box', trash: 'trash', settings: 'gear' };
const LOCKED = new Set(['home']);
// 두 목록을 합친 기본 순서 — 어느 공간에서 걸러 내도 그 공간의 기본 순서가 나온다(테스트가 잠근다)
const ALL = ['home', 'calendar', 'business', 'mail', 'work', 'approvals', 'decisions', 'outputs', 'journal', 'docs', 'people', 'company', 'perf', 'shared', 'knowhow', 'tools'];

/** a를 b 자리로 옮긴 새 배열 — 같은 자리·없는 id면 그대로 */
export function moveId(list, a, b) {
  const from = list.indexOf(a), to = list.indexOf(b);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/** 저장값에 있는 순서 먼저(아는 id·처음 한 번만), 나머지는 기본 순서대로 뒤에 */
const ordered = (defaults, ids) => [...new Set([...ids.filter((id) => defaults.includes(id)), ...defaults])];

/** 메뉴 순서 — 저장값 순서를 지키고, 저장한 뒤에 새로 생긴 메뉴(예: 일정)는 기본 순서에서 바로 앞 메뉴 뒤에 끼운다(맨 아래로 밀리지 않게) */
function placeNew(defaults, ids) {
  const out = [...new Set(ids.filter((id) => defaults.includes(id)))];
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    const prev = defaults.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
  });
  return out;
}

/** 저장값(items) → 이 공간(kind: 'me'|'org')에 보일 메뉴·숨긴 메뉴·칸 순서 */
export function readNav(items = [], kind = 'org') {
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x.id === 'string') : [];
  const order = placeNew(ALL, list.map((x) => x.id));
  const hiddenAll = new Set(list.filter((x) => x.hidden && !LOCKED.has(x.id) && ALL.includes(x.id)).map((x) => x.id));
  const here = order.filter((id) => NAV[kind].includes(id));
  return {
    order, hiddenAll,
    shown: here.filter((id) => !hiddenAll.has(id)),
    hidden: here.filter((id) => hiddenAll.has(id)),
    sections: ordered(SECTIONS, list.map((x) => x.id).filter((id) => id.startsWith('sec:')).map((id) => id.slice(4))),
  };
}

/** 바꾼 뒤 저장할 items — op: { move: [a, b] } | { hide: id } | { show: id } | { section: [a, b] } */
export function writeNav(state, op) {
  let { order, sections } = state;
  const hidden = new Set(state.hiddenAll);
  if (op.move) order = moveId(order, ...op.move);
  if (op.hide && !LOCKED.has(op.hide)) hidden.add(op.hide);
  if (op.show) hidden.delete(op.show);
  if (op.section) sections = moveId(sections, ...op.section);
  return [...order.map((id) => (hidden.has(id) ? { id, hidden: true } : { id })), ...sections.map((s) => ({ id: `sec:${s}` }))];
}

/** 즐겨찾기에 넣을 수 있는 화면 주소 → { space, view, tab } — 홈·메뉴 화면·업무 탭(모듈 보관함 포함). 페이지·메일 한 통·모르는 주소는 null */
export function routeInfo(path) {
  const m = typeof path === 'string' && /^\/(?:me|o\/([^/]+))(\/[^?#]*)?$/.exec(path);
  if (!m) return null;
  const space = m[1] ?? 'me', rest = m[2] ?? '';
  if (!rest) return { space, view: 'home' };
  if (rest === '/business') return { space, view: 'business' };
  const tab = /^\/business\/([a-z]+)$/.exec(rest)?.[1];
  if (tab) return tab === 'library' || BUSINESS_MODULES.some((x) => x.businessTab === tab) ? { space, view: 'business', tab } : null;
  return VIEWS.includes(rest.slice(1)) ? { space, view: rest.slice(1) } : null;
}
/** 즐겨찾기에 넣을 수 없는 화면(유건 10/1 5차) — 홈·설정·휴지통·모듈 보관함은 늘 같은 자리(맨 위·맨 아래 고정 칸)에 있어 즐겨찾기 대상이 아니다 */
export const favable = (r) => !!r && r.view !== 'home' && r.view !== 'settings' && r.view !== 'trash' && !(r.view === 'business' && r.tab === 'library');
/** 지금 보고 있는 화면의 즐겨찾기 대상 — 위키 페이지는 'page'(원래 종류), 그 밖의 화면은 'route'(주소). 이름은 저장하지 않고 그릴 때 사전으로 만든다. 넣을 수 없는 화면은 null(☆·우클릭 메뉴가 안 나온다) */
export function favTarget(path) {
  const page = /^\/(?:me|o\/[^/]+)\/p\/([^/?#]+)$/.exec(path ?? '')?.[1];
  return page ? { kind: 'page', id: page } : favable(routeInfo(path)) ? { kind: 'route', id: path } : null;
}
/** 화면 즐겨찾기의 이름 사전 키·아이콘 */
export const routeLabelKey = (r) => (r.tab ? (r.tab === 'library' ? 'library.title' : `bizui.${r.tab}`) : `nav.${r.view}`);
export const routeIcon = (r) => (r.tab ? (r.tab === 'library' ? 'layout' : BUSINESS_MODULES.find((x) => x.businessTab === r.tab).icon) : NAV_ICON[r.view]);

/** 즐겨찾기(유건 9/30 #7) — 페이지·에이전트·화면(route, 10/1)을 사람마다 한 목록(office_user_layouts fav:me). alive(x)가 아닌 항목(휴지통·권한 없음)은 숨기고,
 *  writeFav는 보이는 목록에서 새로 쓰므로 다음 저장 때 저장값에서도 빠진다(넣을 수 없는 화면 — 홈·설정·휴지통·모듈 보관함 — 도 같은 길로 빠진다). 16KB 행 한도 안에 들게 FAV_MAX개까지 */
export const FAV_MAX = 100;
export const favKey = (x) => `${x.kind}:${x.id}`;
export function readFav(items, alive) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((x) => x && ['page', 'crew', 'route'].includes(x.kind) && typeof x.id === 'string' && (x.kind !== 'route' || favable(routeInfo(x.id))) && !seen.has(favKey(x)) && seen.add(favKey(x)) && alive(x)).map(({ kind, id }) => ({ kind, id }));
}
/** op: { add: {kind, id} } | { remove: key } | { move: [key, key] } */
export function writeFav(list, op) {
  let next = list.filter((x) => favKey(x) !== op.remove);
  if (op.add && next.length < FAV_MAX && !next.some((x) => favKey(x) === favKey(op.add))) next = [...next, { kind: op.add.kind, id: op.add.id }];
  if (op.move) { const keys = moveId(next.map(favKey), ...op.move); next = keys.map((k) => next.find((x) => favKey(x) === k)); }
  return next;
}
