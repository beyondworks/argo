// 표 여러 칸 고르기(유건 9/29) — 칸을 누른 채 다른 칸까지 끌면 두 칸이 만드는 사각형을 고르고, 우클릭으로 한 번에 가리기·해제.

/** 시작 칸과 끝 칸 사이의 모든 칸 [줄, 열] — 위에서 아래, 왼쪽에서 오른쪽 순서 */
export function cellsInBox([r1, c1], [r2, c2]) {
  const cells = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r += 1) for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c += 1) cells.push([r, c]);
  return cells;
}

/** 한 번의 쓰기(redact.bulk)에 넣을 칸 — 상태가 바뀌는 칸만 */
export const bulkRedact = (rows, fields, cells, on) => cells
  .filter(([r]) => rows[r])
  .filter(([r, c]) => (rows[r].redacted ?? []).includes(fields[c]) !== on)
  .map(([r, c]) => ({ entity: 'customer', id: rows[r].id, field: fields[c], on }));

/** 새 거래처는 계좌·사업자번호를 가린 채로 시작(유건 9/29 기본 가림 — 이관과 같다). 고치는 거래처는 그대로 */
export const NEW_CUSTOMER_REDACT = ['account', 'biz_no'];
export const redactDefaults = (kind, value) => (kind === 'customer' && !value.id ? { redacted: [...NEW_CUSTOMER_REDACT] } : {});

/** 값 하나 가림(Redact.jsx)의 손동작 — 화면 없이 시험한다. state = { on, onToggle, disabled, focusable, picked, defer }, peek = 지금 잠깐 보는 중.
 *  우클릭 = 가리기·해제 메뉴(여러 칸·여러 행을 고른 상태면 표·목록이 한 번에 여는 메뉴에 맡긴다 — picked·defer), 왼쪽 버튼을 누르고 있는 동안만 보기,
 *  키보드: 메뉴 키(Shift+F10·ContextMenu)로 메뉴, 가린 값은 Enter로 잠깐 보기(초점이 떠나면 다시 가림) */
export function redactHandlers({ on, onToggle, disabled, focusable = true, picked, defer, mode = REVEAL_MODE }, setPeek, open) {
  const menu = (event) => {
    if (disabled || !onToggle || picked || defer) return;
    open(event, [{ label: on ? 'bizui.unredact' : 'bizui.redact', icon: on ? 'eye' : 'eyeOff', run: onToggle }]);
  };
  const hide = () => setPeek(false);
  return {
    onContextMenu: menu,
    ...(focusable && onToggle && !disabled ? { tabIndex: 0, onBlur: hide, onKeyDown: (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { menu(event); return; }
      if (on && event.key === 'Enter') { event.preventDefault(); setPeek((v) => !v); }
    } } : {}),
    // 'toggle'(눌러서 열어 두기)은 누를 때마다 열고 닫는다 — 떼거나 벗어나도 그대로
    ...(on && mode === 'toggle' ? { onPointerDown: (event) => { if (event.button === 0) setPeek((v) => !v); } } : {}),
    ...(on && mode !== 'toggle' ? { onPointerDown: (event) => { if (event.button === 0) setPeek(true); }, onPointerUp: hide, onPointerLeave: hide, onPointerCancel: hide } : {}),
  };
}

/** 고른 것들의 가림 상태 — any: 하나라도 가림, all: 전부 가림(가릴 수 있는 것이 없으면 둘 다 false). hidden(x) = 그 항목이 가려졌나 */
export function redactState(list, hidden) {
  const n = list.filter(hidden).length;
  return { any: n > 0, all: list.length > 0 && n === list.length };
}
/** 고른 행 전체 가리기·해제(11차) — 그 행에서 가릴 수 있는 칸(fields) 전부. 바뀌는 칸만 보낸다(되돌리기는 반대 값으로 같은 칸) */
export const bulkRedactRows = (rows, fields, ids, on) => {
  const pick = new Set(ids), cells = [];
  rows.forEach((row, r) => { if (pick.has(row.id)) fields.forEach((_, c) => cells.push([r, c])); });
  return bulkRedact(rows, fields, cells, on);
};

// ── 칸 고르기(12차, 유건 10/2 — 공용 선택 상자와 하나로) ──
// 표 칸을 눌러 끄는 따로 된 고르기는 없앴다 — 기본 끌기가 사각형에 걸친 칸([data-sel-cell])을 고른다(ui/marquee.js). 여기에는 칸 목록과 쓰기 계획만 둔다.
/** 화면에 있는 가릴 수 있는 칸 — key → { on(), set(on), batch?, item? }. Redact가 붙을 때 넣고 떨어질 때 뺀다.
 *  batch = 같은 쓰기를 한 번에 보내는 함수(거래처 표 redact.bulk), item = 그 쓰기에 넣을 칸 하나 */
export const CELL_REG = new Map();
/** 칸 여러 개를 on으로 — 쓰기 묶음(batch)마다 한 번, 나머지는 칸마다 set. 돌려주는 값 = 실행할 일 목록(이미 그 상태인 칸은 뺀다) */
export function cellPlan(cells, on) {
  const jobs = [], batches = new Map();
  for (const c of cells) {
    if (c.on() === on) continue;
    if (c.batch) { if (!batches.has(c.batch)) batches.set(c.batch, []); batches.get(c.batch).push({ ...c.item, on }); }
    else jobs.push(() => c.set(on));
  }
  for (const [send, items] of batches) jobs.push(() => send(items));
  return jobs;
}

/** 가린 값을 여는 방식 — 'hold' = 누르고 있는 동안만 보기(지금), 'toggle' = 눌러서 열어 두기(참고 영상). 메인 세션이 유건님께 확인한 뒤 이 한 줄만 바꾼다 */
export const REVEAL_MODE = 'hold';
