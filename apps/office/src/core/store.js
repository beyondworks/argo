// 화면 초안의 상태 저장소 — 모든 변경은 즉시 화면에 반영되고 뒤에서 저장된다(저장 버튼 없음).
// 단계 S: 이 기기(localStorage)에만. P0에서 같은 액션 이름을 유지한 채 보낼 목록 + Supabase로 바꾼다.
import { useSyncExternalStore } from 'react';
import * as S from '../data/sample.js';
import { persist, restore } from './save.js';
import { t } from './i18n.js';

const KEY = 'argo-office-draft-v1';
const fresh = () => ({ pages: S.PAGES, mails: S.MAILS, approvals: S.APPROVALS, decisions: S.DECISIONS, work: S.WORK, layouts: {}, trash: [], todosDone: {} });
let state = { ...fresh(), ...restore(KEY, {}) };
const listeners = new Set();

export const getState = () => state;
export function update(fn) {
  state = { ...state, ...fn(state) };
  listeners.forEach((l) => l());
  persist(KEY, state);
}
/** 선택자는 state의 참조를 그대로 돌려줘야 한다(새 배열을 만들면 매번 다시 그린다) — 파생은 컴포넌트의 useMemo에서 */
export const useStore = (sel) => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));

const uid = () => (crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nowIso = () => new Date().toISOString();

/* ── 페이지 ── */
export const childrenOf = (pages, space, parent) => pages.filter((p) => p.space === space && (p.parent ?? null) === (parent ?? null));
const descendants = (pages, id) => { const out = []; const walk = (pid) => pages.filter((p) => p.parent === pid).forEach((c) => { out.push(c.id); walk(c.id); }); walk(id); return out; };

export function createPage(space, parent = null, from = null) {
  const id = uid();
  const page = { id, space, parent, title: from?.title ?? '', icon: 'doc', updated: nowIso(), content: from?.content ?? { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] } };
  update((s) => ({ pages: [...s.pages, page] }));
  return id;
}
export const savePage = (id, patch) => update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch, updated: nowIso() } : p)) }));

/** 복제 — 하위 페이지까지. 공유·비공개 설정은 따라가지 않는다(유건 확정 2026-09-26). */
export function duplicatePage(id) {
  const s = getState();
  const ids = [id, ...descendants(s.pages, id)];
  const map = new Map(ids.map((x) => [x, uid()]));
  const copies = ids.map((x) => { const p = s.pages.find((q) => q.id === x); return { ...p, id: map.get(x), parent: x === id ? p.parent : map.get(p.parent), restricted: false, title: x === id ? t('page.copyTitle', { title: p.title || t('page.untitled') }) : p.title, updated: nowIso() }; });
  update((st) => ({ pages: [...st.pages, ...copies] }));
  return map.get(id);
}
/** 휴지통 — 하위 페이지째 옮긴다. 30일 뒤 영구 삭제는 서버 cron(P1). */
export function trashPage(id) {
  const s = getState();
  const ids = new Set([id, ...descendants(s.pages, id)]);
  const moved = s.pages.filter((p) => ids.has(p.id)).map((p) => ({ ...p, trashedAt: nowIso() }));
  update((st) => ({ pages: st.pages.filter((p) => !ids.has(p.id)), trash: [...moved, ...st.trash] }));
  return () => restorePage(id);
}
export function restorePage(id) {
  const s = getState();
  const root = s.trash.find((p) => p.id === id);
  if (!root) return;
  const ids = new Set([id, ...descendants(s.trash, id)]);
  const back = s.trash.filter((p) => ids.has(p.id)).map(({ trashedAt, ...p }) => p);
  update((st) => ({ trash: st.trash.filter((p) => !ids.has(p.id)), pages: [...st.pages, ...back] }));
}
/** 같은 부모 안에서 순서 바꾸기 — 배열 순서가 곧 표시 순서(P1에서 분수 인덱스로) */
export function reorderPage(id, overId) {
  update((s) => {
    const a = s.pages.findIndex((p) => p.id === id), b = s.pages.findIndex((p) => p.id === overId);
    if (a < 0 || b < 0 || s.pages[a].parent !== s.pages[b].parent) return {};
    const next = s.pages.slice(); const [x] = next.splice(a, 1); next.splice(b, 0, x);
    return { pages: next };
  });
}

/* ── 메일 ── */
export const setMail = (id, patch) => update((s) => ({ mails: s.mails.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
export function archiveMail(id) {
  const prev = getState().mails.find((m) => m.id === id)?.folder;
  setMail(id, { folder: 'archive' });
  return () => setMail(id, { folder: prev });
}

/* ── 결재 ── */
export function decide(id, result, by) {
  const ap = getState().approvals.find((a) => a.id === id);
  if (!ap) return;
  update((s) => ({ approvals: s.approvals.filter((a) => a.id !== id), decisions: [{ id: `d-${id}`, space: ap.space, crew: ap.crew, plain: ap.plain, result, by, at: nowIso() }, ...s.decisions] }));
}

/* ── 배치 ── */
export const saveLayout = (key, items) => update((s) => ({ layouts: { ...s.layouts, [key]: { items } } }));
export const toggleTodo = (key) => update((s) => ({ todosDone: { ...s.todosDone, [key]: !s.todosDone[key] } }));

/* ── 크루에게 맡기기(초안: 진행 중인 일에 한 줄 추가) ── */
export function assign({ space, crew, goal }) {
  update((s) => ({ work: [{ id: uid(), space, goal, lead: crew, status: 'running', started: nowIso(), steps: '0/…', channel: 'DM' }, ...s.work] }));
}
export const resetDraft = () => { state = fresh(); listeners.forEach((l) => l()); persist(KEY, state, 0); };
