// 오른쪽 패널 폭 규칙(유건 9/30 #8) — 순수 함수. 화면은 ui/Panel.jsx, 규칙은 test/panel-model.test.mjs.
export const PANEL_MIN = 360, PANEL_DEFAULT = 520, PANEL_ROOM = 240, PANEL_STEP = 40; // ROOM: 넓혀도 뒤 화면이 이만큼은 보이게

/** 폭을 [최소, 창 폭 − ROOM] 안으로. 숫자가 아니면 기본 폭 */
export function clampWidth(width, viewport) {
  const max = Math.max(PANEL_MIN, viewport - PANEL_ROOM);
  const w = Number(width);
  return Math.round(Math.min(max, Math.max(PANEL_MIN, Number.isFinite(w) && w > 0 ? w : PANEL_DEFAULT)));
}

/** 손잡이 키 — 패널이 오른쪽에 붙어 있어 ←는 넓게, →는 좁게, Home은 최소, End는 최대. 다른 키는 null */
export function widthForKey(key, width, viewport) {
  const next = { ArrowLeft: width + PANEL_STEP, ArrowRight: width - PANEL_STEP, Home: PANEL_MIN, End: Infinity }[key];
  return next === undefined ? null : clampWidth(next === Infinity ? viewport : next, viewport);
}

/** 기억해 둔 값(JSON 문자열) → { width, full }. 예전 옆 패널(Peek)의 폭이 있으면 이어받는다 */
export function readPref(raw, legacy) {
  const parse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const p = parse(raw), old = parse(legacy);
  return { width: Number(p.width) || Number(old.width) || PANEL_DEFAULT, full: p.full === true };
}

/** 가장 넓힐 수 있는 폭(손잡이 aria-valuemax) */
export const maxWidth = (viewport) => Math.max(PANEL_MIN, viewport - PANEL_ROOM);
