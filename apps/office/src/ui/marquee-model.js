// 선택 상자 계산(11차) — 화면 없이 시험한다(test/select.test.mjs). 화면 쪽은 marquee.js
/** 사각형 { l, t, r, b }에 걸친 항목 key — boxes = [{ key, left, top, right, bottom }] */
export const hits = (rect, boxes) => boxes.filter((b) => b.left < rect.r && b.right > rect.l && b.top < rect.b && b.bottom > rect.t).map((b) => b.key);
/** 새 선택 — 'xor'(⌘ 끌기, 12차) = 끌기 전 선택에서 걸친 것을 뒤집는다(이미 고른 것 위면 빠진다), true = 더하기, 아니면 걸친 것만 */
export const combine = (base, keys, mode) => {
  if (mode !== 'xor') return new Set(mode ? [...base, ...keys] : keys);
  const out = new Set(base);
  for (const k of keys) if (base.has(k)) out.delete(k); else out.add(k);
  return out;
};
/** 그리는 사각형을 묶음(표·목록) 상자 안으로 — 선택은 그대로, 보이는 막대만 */
export const clampRect = (r, b) => ({ l: Math.max(r.l, b.left), t: Math.max(r.t, b.top), r: Math.min(r.r, b.right), b: Math.min(r.b, b.bottom) });
/** ⇧ 클릭 범위 — 화면 순서 keys에서 from부터 to까지(어느 쪽이 먼저든) */
export const rangeKeys = (keys, from, to) => { const a = keys.indexOf(from), b = keys.indexOf(to); return a < 0 || b < 0 ? [to] : keys.slice(Math.min(a, b), Math.max(a, b) + 1); };
/** 체크박스로 고르기(10/9, 메일) — ⇧면 anchor부터 key까지를 key가 바뀔 상태로(Gmail 관례), 아니면 key 하나만 넣고 뺀다 */
export const checkKeys = (sel, key, { keys, anchor, shift = false }) => {
  const on = !sel.has(key), next = new Set(sel);
  for (const k of shift && anchor != null ? rangeKeys(keys, anchor, key) : [key]) if (on) next.add(k); else next.delete(k);
  return next;
};
/** 전체 선택 칸 — 지금 목록 keys 기준 'all' | 'some' | 'none' */
export const checkState = (sel, keys) => { const n = keys.filter((k) => sel.has(k)).length; return !n ? 'none' : n === keys.length ? 'all' : 'some'; };
export const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
/** 두 점이 만드는 사각형 */
export const rectOf = (a, b) => ({ l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) });
const inside = (box, p) => p.x >= box.left && p.x < box.right && p.y >= box.top && p.y < box.bottom;
/** 묶음 사슬(안쪽부터) 중 포인터가 들어 있는 가장 안쪽 — 없으면 맨 바깥(사슬 끝) */
export const pickRoot = (rootBoxes, p) => { const i = rootBoxes.findIndex((b) => inside(b, p)); return i < 0 ? rootBoxes.length - 1 : i; };

/** 무엇을 고르나(12차) — ⇧ = 줄(행·카드·모듈) 통째, 모듈·블록 화면(units)은 칸이 없어 늘 줄(모듈·블록), 그 밖에 가릴 수 있는 칸이 있으면 기본은 칸 */
export const dragMode = ({ shift, units, hasCells }) => (shift || units || !hasCells ? 'rows' : 'cells');
