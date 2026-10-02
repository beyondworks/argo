// 배치 되돌리기·다시 하기(유건 10/2 7차 4) — 레이아웃 키(홈·페이지 안 모듈·업무 대시보드)마다 메모리에 최근 50단계(새로고침하면 비운다).
// 사용자 동작으로 저장할 때만 쌓는다(서버에서 받아 온 값·다른 기기 변경은 쌓지 않는다). ⌘Z·Ctrl+Z = 되돌리기, ⇧⌘Z·Ctrl+Shift+Z·Ctrl+Y = 다시 하기.
// 입력칸·편집기(contenteditable)에 초점이 있으면 그쪽 실행 취소가 이긴다. 되돌린 결과도 그 격자의 저장 경로로 한 번 저장한다(layout.set 1회).
// 알림 문구는 처음 되돌릴 때 받는다(ui/layout-undo.js, 첫 화면 150KB 상한).
export const MAX_STEPS = 50;
/** stacks: 키 → { undo: [이전 항목들], redo: [] }, grids: 키 → 지금 화면에 있는 격자 { items(), apply(items) }, order: 마지막으로 바꾼 키가 뒤 */
export const H = { stacks: new Map(), grids: new Map(), order: [] };

export const touch = (key) => { H.order = [...H.order.filter((k) => k !== key), key]; };
const stack = (key) => { if (!H.stacks.has(key)) H.stacks.set(key, { undo: [], redo: [] }); return H.stacks.get(key); };

/** 저장에 성공한 사용자 동작 하나 — 바꾸기 전 항목을 쌓고 다시 하기는 비운다 */
export function record(key, before) {
  if (!Array.isArray(before)) return;
  const s = stack(key);
  s.undo.push(before); s.redo = [];
  if (s.undo.length > MAX_STEPS) s.undo.shift();
  touch(key);
}

/** ⌘Z가 고칠 격자 — 화면에 있고 되돌릴(다시 할) 단계가 있는 것 중 마지막으로 바꾼 것 */
export const target = (redo) => [...H.order].reverse().find((key) => H.grids.has(key) && H.stacks.get(key)?.[redo ? 'redo' : 'undo'].length);

const typing = (el) => el?.isContentEditable || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || (el?.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(el.type));
/** 키 → 'undo' | 'redo' | null. 끄는 중·글자 조합 중·입력칸에서는 null */
export function keyAction(e) {
  const k = e.key?.toLowerCase();
  if (e.defaultPrevented || e.isComposing || e.altKey || !(e.metaKey || e.ctrlKey) || typing(e.target) || globalThis.document?.body.matches('.module-moving, .edge-drag-x, .edge-drag-y')) return null;
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  return k === 'y' && e.ctrlKey && !e.shiftKey ? 'redo' : null;
}

let busy = false;
/** key 격자의 마지막 단계를 되돌린다(redo면 다시 한다) — 그 격자의 저장 경로로 한 번 저장하고, 지금 항목은 반대쪽으로 옮긴다.
 *  저장이 막히면(읽기 전용·저장 중·충돌) 단계는 그대로 남는다. 돌려주는 값 = 바꿨으면 true */
export async function step(key, redo) {
  const s = H.stacks.get(key), grid = H.grids.get(key), from = redo ? s?.redo : s?.undo;
  if (busy || !grid || !from?.length) return false;
  busy = true;
  try {
    const now = grid.items();
    if (await grid.apply(from.at(-1)) === false) return false;
    from.pop();
    const to = redo ? s.undo : s.redo;
    to.push(now); if (to.length > MAX_STEPS) to.shift();
    touch(key);
    return true;
  } finally { busy = false; }
}

let listening = false;
/** 격자가 화면에 붙을 때 — 그 격자를 되돌리기 대상으로 등록한다. 돌려주는 함수 = 뗄 때 */
export function attach(key, grid) {
  H.grids.set(key, grid);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('keydown', (e) => {
      const act = keyAction(e), key = act && target(act === 'redo');
      if (!key) return; // 되돌릴 것이 없으면 브라우저·다른 화면이 받는다
      e.preventDefault();
      step(key, act === 'redo').then((ok) => ok && import('../ui/layout-undo.js').then((m) => m.done(act === 'redo')), () => {});
    });
  }
  return () => { if (H.grids.get(key) === grid) H.grids.delete(key); };
}
