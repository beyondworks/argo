// 여러 개 고르기(11차, 유건 10/2 — 노션·파일 탐색기처럼 어느 화면에서든 끌어 감싸 고르기). 첫 화면에는 이 작은 감지 코드만 둔다(150KB 상한):
// 화면마다 고를 수 있는 묶음(scope)을 등록하고(useSelection), 누른 채 4px 넘게 끌면 선택 상자 본체(ui/marquee.js)를 불러 넘긴다.
// 표시: 묶음 뿌리 = [data-sel-scope="id"], 항목 = [data-sel="key"]. 고른 것이 있으면 화면 아래 선택 막대(ui/SelectionBar.jsx, 지연 로드).
import { createElement, lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { typing } from './history.js';

const NONE = new Set();
/** id → { get(), set(Set), opts() } — 화면에 붙은 묶음만 */
export const SCOPES = new Map();
const subs = new Set();
let ver = 0;
export const emit = () => { ver++; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
/** 고른 칸(12차 — 표·카드의 가릴 수 있는 칸, [data-sel-cell]). 화면에 하나 — 줄 선택과 같이 있지 않는다(marquee.js가 비운다) */
export const CELLS = { keys: NONE };
/** 고른 것이 있는 묶음 id(칸이면 '__cells', 없으면 null) — 한 번에 한 묶음만 고른다(marquee.js가 다른 묶음을 비운다) */
export const activeScope = () => { if (CELLS.keys.size) return '__cells'; for (const [id, s] of SCOPES) if (s.get().size) return id; return null; };

/** 묶음 하나 — value/onChange를 주면 그 화면의 원래 선택 상태(체크박스 등)를 그대로 쓴다. keys = 지금 있는 항목(사라진 것은 고른 수에서 뺀다).
 *  actions(keys, clear) = 선택 막대에 보일 일괄 동작 [{ label, icon, run, danger }] — 그 화면에 이미 있는 단일 동작을 여러 개에 적용하는 것만 */
export function useSelection(id, opts = {}) {
  const { value, onChange, keys } = opts;
  const [own, setOwn] = useState(NONE);
  const raw = value ?? own, set = onChange ?? setOwn, list = keys?.join('\n');
  const sel = useMemo(() => { if (!keys) return raw; const ok = new Set(keys); const out = new Set([...raw].filter((k) => ok.has(k))); return out.size === raw.size ? raw : out; }, [raw, list]);
  const ref = useRef(null);
  ref.current = { ...opts, sel, set }; // actions·boxes(항목 상자를 직접 주는 묶음)·onEnd(끌기를 끝낸 뒤)
  useEffect(() => {
    if (!id) return undefined; // 묶음을 바깥(부모)이 등록하는 경우
    const s = { get: () => ref.current.sel, set: (v) => { ref.current.sel = v; ref.current.set(v); }, opts: () => ref.current }; // 다시 그리기 전에 연달아 바꿔도(⌘클릭 두 번) 앞 것을 잃지 않게
    SCOPES.set(id, s); emit();
    return () => { if (SCOPES.get(id) === s) SCOPES.delete(id); emit(); };
  }, [id]);
  useEffect(emit, [sel]);
  return [sel, set];
}

/** 항목 표시 — 고른 항목은 data-sel-on(선택 바탕·포커스 링 토큰, ui/selection.css) */
export const selProps = (sel, key) => ({ 'data-sel': key, 'data-sel-on': sel.has(key) ? '' : undefined });

/** 선택 막대 자리(앱에 하나) — 고른 것이 생길 때 막대를 받는다 */
const Bar = lazy(() => import('../ui/SelectionBar.jsx'));
export function SelectionHost() {
  useSyncExternalStore(subscribe, () => ver);
  const id = activeScope();
  return id ? createElement(Suspense, { fallback: null }, createElement(Bar, { id, scope: SCOPES.get(id) })) : null;
}

// ── 시작 규칙(노션식) — 입력칸·편집기·버튼·링크·선택칸·손잡이 위는 그 요소 본래 동작이 이긴다 ──
const CTRL = 'input, textarea, select, button, a[href], label, [role="button"], [role="checkbox"], [role="switch"], [role="slider"], [role="separator"], [role="textbox"]';
// 끌기가 원래 있는 곳 — 손잡이·열 경계선, 끌어 옮기는 항목(메일·산출물·칸반 카드, dnd-kit), 표 칸 고르기([data-sel-native])
const DRAG = '[draggable="true"], [aria-roledescription], .grip, .edge, .col-gap, [data-sel-native]';
/** 편집기 글 안 — 편집기 속 모듈(contenteditable=false 섬, 페이지 안 모듈)은 아니다 */
const editing = (el) => el.isContentEditable || (el.closest('[contenteditable]')?.getAttribute('contenteditable') ?? 'false') !== 'false';
/** 항목 안의 단추·링크(항목 자체가 아닌 것) — 그 위는 그 단추 차례. 항목 자체가 단추이거나 행 전체 열기 단추([data-sel-body])면 항목으로 본다 */
/** 페이지 본문 편집기([data-sel-blocks] 안)의 맨 위 블록 — 없으면 null */
export function blockOf(el) {
  const root = el?.closest?.('[data-sel-blocks] .ProseMirror');
  let n = el;
  while (root && n && n.parentElement !== root) n = n.parentElement;
  return root ? n : null;
}
const inner = (ctl, item) => ctl && ctl !== item && !ctl.matches('[data-sel-body]') && (!item || item.contains(ctl));
/** 누른 곳 → 'native'(본래 동작) | 'item'(항목 글자 위 — 처음 누른 항목 밖으로 나가면 선택 상자) | 'box'(바로 선택 상자) */
export function startKind(target) {
  if (!target?.closest || target.closest('[role="dialog"], .menu, .sel-bar') || target.closest(DRAG)) return 'native';
  if (editing(target)) return blockOf(target) && !target.closest(CTRL) ? 'item' : 'native'; // 페이지 본문(블록 묶음)은 글자 선택으로 시작 — 블록 밖으로 나가면 블록 고르기. 그 밖의 편집기·입력칸은 그대로
  const item = target.closest('[data-sel]');
  return inner(target.closest(CTRL), item) ? 'native' : item ? 'item' : 'box';
}
/** ⇧/⌘ + 클릭으로 더하고 뺄 항목 — 항목 안 링크·단추 위여도 고른다(새 탭·새 창으로 열지 않는다, 모듈 안이 거의 다 링크인 목록이라).
 *  입력칸·체크박스·스위치·손잡이·열 경계선 위면 null(그 요소 차례). 끌어 옮기는 항목(메일 등)도 고를 수 있다 */
const FORM = 'input, textarea, select, label, [role="checkbox"], [role="switch"], [role="slider"], .grip, .edge, .col-gap, [data-sel-native]';
export function clickItem(target) {
  const item = target?.closest?.('[data-sel]');
  return item && !editing(target) && !target.closest('.sel-bar') && !inner(target.closest(FORM), item) ? item : null;
}
const mods = (e) => e.shiftKey || e.metaKey || e.ctrlKey;
const wide = () => innerWidth > 720; // 좁은 폭·터치는 이번 범위 밖 — 기존 체크박스·메뉴 그대로

let M = null, loading = null, grabbed = false;
const load = () => (loading ??= import('../ui/marquee.js').then((m) => (M = m), (e) => { loading = null; throw e; }));
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', (e) => {
    if (e.button || e.pointerType !== 'mouse' || !wide() || !e.target.closest?.('.content') || startKind(e.target) === 'native') return;
    const d = { x: e.clientX, y: e.clientY, target: e.target, id: e.pointerId, shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey, up: false }; // ⇧ = 줄 통째, ⌘ = 영역 더하기(토글)
    const move = (ev) => { if (ev.pointerId !== d.id || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) return; removeEventListener('pointermove', move); load().then((m) => m.start(d, ev), () => {}); };
    const up = (ev) => { if (ev.pointerId !== d.id) return; d.up = true; removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  // 클릭 — ⇧/⌘ + 항목 = 하나 더하기·빼기(그 항목의 열기·새 탭보다 먼저), 빈 곳 한 번 = 선택 해제. 선택 상자를 끝낸 직후 클릭은 삼킨다
  addEventListener('click', (e) => {
    if (M?.swallow(e)) return;
    const item = mods(e) && wide() && e.target.closest?.('.content') && clickItem(e.target);
    if (item) { e.preventDefault(); e.stopPropagation(); const range = e.shiftKey && !(e.metaKey || e.ctrlKey); load().then((m) => (range ? m.range(item) : m.toggle(item)), () => {}); return; } // ⇧ = 마지막 것부터 여기까지, ⌘ = 하나 더하기·빼기
    if (M && !mods(e) && e.button === 0 && !grabbed) M.clickAway(e);
  }, true);
  // 손잡이·가장자리·열 경계선을 끌다 뗀 자리의 클릭(Esc로 취소한 뒤 포함)은 빈 곳 클릭이 아니다 — 고른 것을 지우지 않는다
  addEventListener('pointerdown', (e) => { grabbed = !!e.target.closest?.('.grip, .edge, .col-gap'); }, true);
  // ⌘A(입력칸 초점 없을 때) = 그 화면 전체 — 고를 것이 없는 화면은 브라우저 기본(글 전체 선택)
  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'a' || e.isComposing || typing(document.activeElement) || !wide() || !document.querySelector('.content [data-sel]') || document.querySelector('[role="dialog"]')) return;
    e.preventDefault(); load().then((m) => m.selectAll(), () => {});
  });
}
