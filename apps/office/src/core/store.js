// 화면 초안의 상태 저장소 — 모든 변경은 즉시 화면에 반영되고 뒤에서 저장된다(저장 버튼 없음).
// 단계 S: 이 기기(localStorage)에만. P0에서 같은 액션 이름을 유지한 채 보낼 목록 + Supabase로 바꾼다.
import { useSyncExternalStore } from 'react';
import * as S from '../data/sample.js';
import { persist, restore } from './save.js';
import { t } from './i18n.js';
import { queue } from './sync.js';
import { between } from './position.js';

const KEY = 'argo-office-draft-v1';
const fresh = () => ({ pages: S.PAGES.map((p, i) => ({ ...p, position: p.position ?? String.fromCharCode(97 + Math.floor(i / 10)) + (i % 10 + 1) })), mails: S.MAILS, approvals: S.APPROVALS, decisions: S.DECISIONS, work: S.WORK, layouts: {}, trash: [], todosDone: {} });
let state = { ...fresh(), ...restore(KEY, {}) };
const listeners = new Set();

export const getState = () => state;
/** 화면에 먼저 반영하고(한 프레임 안), 서버로 보낼 변경(ops: [key, payload][])을 보낼 목록에 넣는다. */
export function update(fn, ops = []) {
  state = { ...state, ...fn(state) };
  listeners.forEach((l) => l());
  persist(KEY, state);
  for (const [key, payload] of ops) queue(key, payload);
}
/** 선택자는 state의 참조를 그대로 돌려줘야 한다(새 배열을 만들면 매번 다시 그린다) — 파생은 컴포넌트의 useMemo에서 */
export const useStore = (sel) => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));

const uid = () => (crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nowIso = () => new Date().toISOString();

/* ── 페이지 ── */
// 서버로 가는 변경 종류(key가 다르면 합쳐지지 않는다): 만들기 page-create:id / 저장 page:id / 이동 order:id / 휴지통 trash:id / 비공개 restricted:id.
// 저장은 보내는 순간의 최신 제목·본문과 서버가 아는 버전으로 간다(core/transport.js) — 글자마다 불려도 마지막 값 하나.
const byPos = (a, b) => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0);
export const childrenOf = (pages, space, parent) => pages.filter((p) => p.space === space && (p.parent ?? null) === (parent ?? null)).sort(byPos);
const descendants = (pages, id) => { const out = []; const walk = (pid) => pages.filter((p) => p.parent === pid).sort(byPos).forEach((c) => { out.push(c.id); walk(c.id); }); walk(id); return out; };
const lastPos = (pages, space, parent) => childrenOf(pages, space, parent).at(-1)?.position ?? null;

export function createPage(space, parent = null, from = null) {
  const id = uid();
  const s = getState();
  const page = { id, space, parent, position: between(lastPos(s.pages, space, parent), null), title: from?.title ?? '', icon: 'doc', updated: nowIso(), version: 1, fresh: true,
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
  const copies = ids.map((x) => { const p = s.pages.find((q) => q.id === x); return { ...p, id: map.get(x), parent: x === id ? p.parent : map.get(p.parent), restricted: false, version: 1, fresh: true,
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
export const saveLayout = (key, items) => update((s) => ({ layouts: { ...s.layouts, [key]: { items } } }), [[`layout:${key}`, { type: 'layout.set', key, items }]]);
export const toggleTodo = (key) => update((s) => ({ todosDone: { ...s.todosDone, [key]: !s.todosDone[key] } }), [[`todo:${key}`, { type: 'todo.toggle', key, done: !state.todosDone[key] }]]);

/* ── 크루에게 맡기기(초안: 진행 중인 일에 한 줄 추가) ── */
export function assign({ space, crew, goal }) {
  const row = { id: uid(), space, goal, lead: crew, status: 'running', started: nowIso(), steps: '0/…', channel: 'DM' };
  update((s) => ({ work: [row, ...s.work] }), [[`assign:${row.id}`, { type: 'crew.assign', row }]]);
}
export const resetDraft = () => { state = fresh(); listeners.forEach((l) => l()); persist(KEY, state, 0); };
