// 화면 초안의 상태 저장소 — 모든 변경은 즉시 화면에 반영되고 뒤에서 저장된다(저장 버튼 없음).
// 단계 S: 이 기기(localStorage)에만. P0에서 같은 액션 이름을 유지한 채 보낼 목록 + Supabase로 바꾼다.
import { useSyncExternalStore } from 'react';
import * as S from '../data/sample.js';
import { persist, restore, scopedStorageKey, getStorageScope, setLegacyRecovery } from './save.js';
import { t } from './i18n.js';
import { queue } from './sync.js';
import { between } from './position.js';
import { SPACES, ME } from './session.js';
import { writeNav, readNav, readFav, writeFav } from './nav-model.js';
import { usable, isMine } from './crew-list.js';

const KEY = 'argo-office-draft-v1';
const fresh = () => ({ pages: S.PAGES.map((p, i) => ({ ...p, position: p.position ?? String.fromCharCode(97 + Math.floor(i / 10)) + (i % 10 + 1) })), mails: S.MAILS, mailAccounts: [], approvals: S.APPROVALS, decisions: S.DECISIONS, work: S.WORK, crews: S.CREWS, outputs: S.OUTPUTS, journal: S.JOURNAL, docs: [], layouts: {}, trash: [], todosDone: {} });
const empty = () => ({ pages: [], mails: [], mailAccounts: [], approvals: [], decisions: [], work: [], crews: [], outputs: [], journal: [], docs: [], layouts: {}, trash: [], todosDone: {} });
let state = fresh();
let draftScope = null;
const listeners = new Set();

export function activateDraftScope(uid) {
  draftScope = uid;
  setLegacyRecovery({ draft: restore(KEY, null) !== null });
  state = { ...(uid === 'sample' ? fresh() : empty()), ...(uid ? restore(scopedStorageKey(KEY, uid), {}) : {}) };
  listeners.forEach((listener) => listener());
}

export const getState = () => state;
/** 화면에 먼저 반영하고(한 프레임 안), 서버로 보낼 변경(ops: [key, payload][])을 보낼 목록에 넣는다. */
export function update(fn, ops = []) {
  const owner = draftScope;
  // Auth can switch before the old editor unmounts. Never adopt its draft into the next account.
  if (!owner || owner !== getStorageScope()) return false;
  state = { ...state, ...fn(state) };
  persist(scopedStorageKey(KEY, owner), state);
  for (const [key, payload] of ops) queue(key, payload);
  listeners.forEach((l) => l());
  return true;
}
/** 선택자는 state의 참조를 그대로 돌려줘야 한다(새 배열을 만들면 매번 다시 그린다) — 파생은 컴포넌트의 useMemo에서 */
export const useStore = (sel) => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));

const uid = () => (crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nowIso = () => new Date().toISOString();

/* ── 페이지 ── */
// 서버로 가는 변경 종류(key가 다르면 합쳐지지 않는다): 만들기 page-create:id / 저장 page:id / 이동 order:id / 휴지통 trash:id / 비공개 restricted:id.
// 저장은 보내는 순간의 최신 제목·본문과 서버가 아는 버전으로 간다(core/transport.js) — 글자마다 불려도 마지막 값 하나.
const byPos = (a, b) => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0);
export const crewName = (id) => state.crews.find((c) => c.id === id)?.name ?? '';
/** 공간의 크루 — 내 공간은 내 크루(모든 조직), 조직은 그 조직 크루. 예시 크루(공간·주인 없음)는 어디서나 */
export const crewsIn = (crews, space, me) => crews.filter((c) => (space === 'me' ? !c.owner || c.owner === me : !c.space || c.space === space));
/** 결재 — 내 공간은 내가 결정할 수 있는 것만(모든 조직), 조직 공간은 그 조직 전부 */
export const approvalsIn = (space) => (a) => (space === 'me' || a.space === space) && (space !== 'me' || a.canDecide !== false);
export const childrenOf = (pages, space, parent) => pages.filter((p) => !p.template && p.space === space && (p.parent ?? null) === (parent ?? null)).sort(byPos); // 템플릿은 트리에 안 섞는다
const descendants = (pages, id) => { const out = []; const walk = (pid) => pages.filter((p) => p.parent === pid).sort(byPos).forEach((c) => { out.push(c.id); walk(c.id); }); walk(id); return out; };
const lastPos = (pages, space, parent) => childrenOf(pages, space, parent).at(-1)?.position ?? null;

export function createPage(space, parent = null, from = null) {
  const id = uid();
  const s = getState();
  const parentPage = s.pages.find((page) => page.id === parent);
  const page = { id, space, parent, owner: parentPage?.owner ?? getStorageScope(), access: 'full', orgId: parentPage?.orgId ?? SPACES.find((entry) => entry.key === space && entry.kind === 'org')?.id ?? null, position: between(lastPos(s.pages, space, parent), null), title: from?.title ?? '', icon: 'doc', updated: nowIso(), version: 1, fresh: true, ...(from?.template ? { template: true } : {}),
    content: from?.content ?? { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] } };
  update((st) => ({ pages: [...st.pages, page] }), [[`page-create:${id}`, { type: 'page.create', id }]]);
  return id;
}
export function savePage(id, patch) {
  update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch, updated: nowIso() } : p)) }), [[`page:${id}`, { type: 'page.save', id }]]);
}
export const setRestricted = (id, on) => update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, restricted: on } : p)) }), [[`restricted:${id}`, { type: 'page.restricted', id, on }]]);

/** 복제 — 하위 페이지까지. 공유·비공개 설정은 따라가지 않는다(유건 확정 2026-09-26). 서버에는 사본마다 "만들기"로 간다(부모 먼저). */
export function duplicatePage(id) {
  const s = getState();
  const ids = [id, ...descendants(s.pages, id)];
  const map = new Map(ids.map((x) => [x, uid()]));
  const src = s.pages.find((q) => q.id === id);
  const next = s.pages.filter((q) => q.space === src.space && (q.parent ?? null) === (src.parent ?? null) && (q.position ?? '') > (src.position ?? '')).sort(byPos)[0];
  const copies = ids.map((x) => { const p = s.pages.find((q) => q.id === x); return { ...p, id: map.get(x), parent: x === id ? p.parent : map.get(p.parent), restricted: false, template: false, version: 1, fresh: true,
    position: x === id ? between(src.position ?? null, next?.position ?? null) : p.position, title: x === id ? t('page.copyTitle', { title: p.title || t('page.untitled') }) : p.title, updated: nowIso() }; });
  update((st) => ({ pages: [...st.pages, ...copies] }), copies.map((c) => [`page-create:${c.id}`, { type: 'page.create', id: c.id }]));
  return map.get(id);
}
/** 휴지통 — 하위 페이지째 옮긴다. 30일 뒤 영구 삭제는 서버가 정리한다. */
export function trashPage(id) {
  const s = getState();
  const ids = new Set([id, ...descendants(s.pages, id)]);
  const moved = s.pages.filter((p) => ids.has(p.id)).map((p) => ({ ...p, trashedAt: nowIso() }));
  update((st) => ({ pages: st.pages.filter((p) => !ids.has(p.id)), trash: [...moved, ...st.trash] }), [[`trash:${id}`, { type: 'page.archive', id }]]);
  return () => restorePage(id);
}
export function restorePage(id) {
  const s = getState();
  const root = s.trash.find((p) => p.id === id);
  if (!root) return;
  const ids = new Set([id, ...descendants(s.trash, id)]);
  const back = s.trash.filter((p) => ids.has(p.id)).map(({ trashedAt, ...p }) => p);
  update((st) => ({ trash: st.trash.filter((p) => !ids.has(p.id)), pages: [...st.pages, ...back] }), [[`trash:${id}`, { type: 'page.restore', id }]]);
}
/** 같은 부모 안에서 overId 자리로 옮긴다 — 옮긴 페이지의 순서 값 하나만 바뀐다 */
export function reorderPage(id, overId) {
  const s = getState();
  const me = s.pages.find((p) => p.id === id), over = s.pages.find((p) => p.id === overId);
  if (!me || !over || (me.parent ?? null) !== (over.parent ?? null) || me.space !== over.space) return;
  const sib = childrenOf(s.pages, me.space, me.parent).filter((p) => p.id !== id);
  const i = sib.findIndex((p) => p.id === overId);
  const down = (me.position ?? '') < (over.position ?? '');
  const [lo, hi] = down ? [sib[i], sib[i + 1]] : [sib[i - 1], sib[i]];
  const position = between(lo?.position ?? null, hi?.position ?? null);
  update((st) => ({ pages: st.pages.map((p) => (p.id === id ? { ...p, position } : p)) }), [[`order:${id}`, { type: 'page.move', id }]]);
}

/* ── 메일 ── */
export const setMail = (id, patch) => update((s) => ({ mails: s.mails.map((m) => (m.id === id ? { ...m, ...patch } : m)) }), [[`mail:${id}`, { type: 'mail.flag', id, patch }]]);
export function archiveMail(id) {
  const prev = getState().mails.find((m) => m.id === id)?.folder;
  setMail(id, { folder: 'archive' });
  return () => setMail(id, { folder: prev });
}

/* ── 결재 ── */
export function decide(id, result, by) {
  const ap = getState().approvals.find((a) => a.id === id);
  if (!ap) return;
  update((s) => ({ approvals: s.approvals.filter((a) => a.id !== id), decisions: [{ id: `d-${id}`, space: ap.space, crew: ap.crew, plain: ap.plain, result, by, at: nowIso() }, ...s.decisions] }), [[`approval:${id}`, { type: 'approval.decide', id, result }]]);
}

/* ── 배치 ── */
/** 좌측 메뉴 순서·숨김·칸 순서(사람마다, nav-model.js) — 저장할 수 없는 상태면 false */
export const saveNav = (op, kind) => saveLayout('nav:me', writeNav(readNav(state.layouts['nav:me']?.items, kind), op));
/** 즐겨찾기(fav:me) — 보이는 것만: 휴지통·권한 없는 페이지, 꺼졌거나 내 것이 아닌 에이전트는 숨긴다(오피스 크루 목록과 같은 기준) */
export const favOf = (s) => readFav(s.layouts['fav:me']?.items, (x) => (x.kind === 'page' ? s.pages.some((p) => p.id === x.id && !p.template) : s.crews.some((c) => c.id === x.id && usable(c) && isMine(c, ME.id))));
export const isFav = (kind, id) => favOf(state).some((x) => x.kind === kind && x.id === id);
export const saveFav = (op) => saveLayout('fav:me', writeFav(favOf(state), op));
export const toggleFav = (kind, id) => saveFav(isFav(kind, id) ? { remove: `${kind}:${id}` } : { add: { kind, id } });
export const saveTabs = (order) => saveLayout('biztabs:me', order.map((id) => ({ id })));
export const saveLayout = (key, items) => {
  const current = state.layouts[key];
  if (getStorageScope() !== 'sample' && (!Number.isInteger(current?.version) || current?.conflict)) return false;
  update((s) => ({ layouts: { ...s.layouts, [key]: { ...current, items } } }), [[`layout:${key}`, { type: 'layout.set', key, items }]]);
  return true;
};
// 할 일은 지금 예시 데이터(크루 메모)에만 있다 — 서버 저장은 크루 메모가 생길 때 함께(유건 9/29). 보내지 않을 변경을 전송 목록에 넣지 않는다
export const toggleTodo = (key) => update((s) => ({ todosDone: { ...s.todosDone, [key]: !s.todosDone[key] } }));

/* ── 크루에게 맡기기 ── */
// 예시 데이터는 화면에서만(진행 중인 일에 한 줄). 로그인 상태는 크루와의 1:1 대화에 글을 보낸다 — 성공 여부는 전송이 끝난 뒤에만 알린다(transport crew.assign).
// '진행 중인 일'에는 가짜 행을 넣지 않는다 — 크루가 실제로 일을 시작하면 서버 기록(msgr_work_runs)이 거기에 뜬다.
export function assign({ space, crew, goal }) {
  const row = { id: uid(), space, goal, lead: crew, status: 'running', started: nowIso(), steps: '0/…', channel: 'DM' };
  update((s) => ({ work: [row, ...s.work] }));
}
export function sendToCrew({ orgId, crewId, crewName, body, meta }) {
  const clientId = uid();
  update(() => ({}), [[`assign:${clientId}`, { type: 'crew.assign', orgId, crewId, crewName, body, meta, clientId }]]);
}
export const resetDraft = () => { state = getStorageScope() === 'sample' ? fresh() : empty(); listeners.forEach((l) => l()); persist(scopedStorageKey(KEY), state, 0); };
