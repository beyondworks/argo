// 모듈 배치 — 노션식 블록 흐름(9차, 유건 10/2 확정). 줄(row) → 열(column, 폭 = 24분의 몇) → 모듈(위아래 순서). 줄에 열이 하나면 전체 폭, 한 줄 최대 4열.
// 저장값은 항목 배열 그대로: r = 줄 순서, c = 줄 안 열 순서, cw = 열 폭(1~24), 열 안 위아래는 배열 순서. 옛 필드(size·span·x·y·t·h)도 같이 쓴다(옛 앱 호환).
// 줄·열이 없는 배치(옛 배치·5~7차 x·y·t 저장값)는 그릴 때 지금 화면 모양에서 줄·열을 만든다(저장하지 않는다). 좁은 폭은 줄→열→위아래 순으로 한 줄에 하나.
export const SIZES = ['s', 'm', 'l', 'full'];
export const SPAN = { s: 4, m: 6, l: 8, full: 12 };
// 가장자리 끌기(유건 10/1): 폭은 열 수(span 1~12, 끌기 전 단계는 baseSize), 높이는 px(h, 120~1200) — 없으면 크기 단계·내용대로
// span은 같이 쓴 size(가장 가까운 단계)와 맞을 때만 — 옛 탭의 '크기' 메뉴가 size만 바꾸면 남은 span보다 그 size가 이긴다(검수 10/1)
export const spanOf = (it) => (Number.isInteger(it.span) && it.span > 0 && it.span < 13 && it.size === sizeForSpan(it.span) ? it.span : SPAN[it.size] ?? 6);
export const heightOf = (it) => (Number.isInteger(it.h) && it.h >= 120 && it.h <= 1200 ? it.h : 0);
/** 자유 격자 자리 — x = 시작 열(0~11), y = 위에서부터 순서. 둘 다 있어야 자리로 읽는다(옛 앱이 저장한 값에는 없다) */
export const hasXY = (it) => Number.isInteger(it.x) && it.x >= 0 && it.x < 12 && Number.isInteger(it.y) && it.y >= 0;
/** 세로 위치 t(7차, 유건 10/2) — 격자 위쪽에서 px. 자리(x·y)가 있을 때만 읽는다. 없으면(옛 배치·5·6차 저장값) 세로 중력으로 쌓는다 */
export const tOf = (it) => (hasXY(it) && Number.isInteger(it.t) && it.t >= 0 ? it.t : undefined);
/** 줄·열 자리(9차) — r = 줄 순서, c = 줄 안 열 순서(0~3). 둘 다 있어야 자리로 읽는다. cw = 열 폭(24분의 몇, 1~24) */
export const hasRC = (it) => Number.isInteger(it.r) && it.r >= 0 && Number.isInteger(it.c) && it.c >= 0 && it.c < 4;
const cwOf = (it) => (Number.isInteger(it.cw) && it.cw > 0 && it.cw < 25 ? it.cw : 0);
/** 모듈이 허용하는 열 범위 — 1/3을 허용하면 3열부터, 아니면 가장 작은 단계부터(현황 8열) */
/** 모듈 최소 높이(카드 전체, px) — 120, 등록부에 본문 최소(minBody)가 있으면 머리 높이 + 그 값(8px 단위 올림) */
export const minHeight = (mod, head = 42) => Math.max(120, Math.ceil((head + (mod?.minBody ?? 0)) / 8) * 8);
export const spanRange = (sizes) => [Math.min(...sizes.map((s) => (s === 's' ? 3 : SPAN[s]))), Math.max(...sizes.map((s) => SPAN[s]))];

/** 열 수 → 가장 가까운 크기 단계 */
export function sizeForSpan(cols) {
  let best = 's';
  for (const s of SIZES) if (Math.abs(SPAN[s] - cols) < Math.abs(SPAN[best] - cols)) best = s;
  return best;
}

/**
 * 저장된 배치 + 모듈 등록부 → 실제로 그릴 배치.
 * - 등록부에 없는 모듈(삭제·이름 바뀜)은 버린다.
 * - 이 공간에서 쓸 수 없는 모듈은 버린다.
 * - 크기가 등록부가 허용하지 않는 값이면 기본 크기로.
 * - 배치에 처음 나타난 새 모듈은 끝에 숨김으로 붙인다(사용자가 고른 화면을 새 모듈이 밀어내지 않게).
 * - 저장된 배치가 없으면 등록부의 기본 배치.
 */
export function mergeLayout(saved, registry, space, defaults) {
  const usable = new Map(registry.filter((m) => m.spaces.includes(space)).map((m) => [m.id, m]));
  if (!saved?.items?.length) {
    const visible = defaults.filter((d) => usable.has(d.id)).map((d) => ({ id: d.id, size: d.size, hidden: false }));
    const included = new Set(visible.map((item) => item.id));
    return [...visible, ...[...usable.values()].filter((mod) => (!mod.repeatable || mod.anchor) && !included.has(mod.id)).map((mod) => ({ id: mod.id, size: mod.defaultSize, hidden: true }))];
  }
  const seen = new Set();
  const items = [];
  for (const it of saved.items) {
    const mod = usable.get(it.moduleId ?? it.id);
    if (!mod || seen.has(it.id)) continue;
    seen.add(it.id);
    const [lo, hi] = spanRange(mod.sizes), { span } = it;
    items.push({ id: it.id, ...(it.moduleId ? { moduleId: it.moduleId } : {}), size: mod.sizes.includes(it.size) ? it.size : mod.defaultSize, ...(Number.isInteger(span) && span >= lo && span <= hi ? { span, ...(mod.sizes.includes(it.baseSize) ? { baseSize: it.baseSize } : {}) } : {}), ...(heightOf(it) ? { h: it.h } : {}), ...(hasXY(it) ? { x: it.x, y: it.y, ...(tOf(it) != null ? { t: it.t } : {}) } : {}), ...(hasRC(it) ? { r: it.r, c: it.c, ...(cwOf(it) ? { cw: it.cw } : {}) } : {}), hidden: !!it.hidden, ...(it.cfg ? { cfg: it.cfg } : {}) });
  }
  // 새로 생긴 모듈은 숨긴 채 뒤에 — intro: 'top'인 것만 맨 위에 보이게(유건 9/27: 현황 카드). 한 번 저장된 뒤엔 사용자 선택을 따른다.
  for (const [id, mod] of usable) if ((!mod.repeatable || mod.anchor) && !items.some((item) => (item.moduleId ?? item.id) === id)) {
    if (mod.intro === 'top') items.unshift({ id, size: mod.defaultSize, hidden: false });
    else items.push({ id, size: mod.defaultSize, hidden: true });
  }
  return items;
}

export function move(list, from, to) {
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** 보이는 모듈을 줄로 나눈다 — CSS 격자 자동 배치(dense 없음)와 같은 규칙: 남은 열에 안 들어가면 다음 줄. */
export function rowsOf(items) {
  const rows = [];
  let used = 12;
  for (const it of items) {
    const span = spanOf(it);
    if (used + span > 12) { rows.push([]); used = 0; }
    rows.at(-1).push(it); used += span;
  }
  return rows;
}

/** 5~7차 자유 격자 그리는 순서(9차는 줄·열로 바꿀 때만 쓴다) — 자리(x·y)가 있는 모듈은 t→x(t가 없으면 y→x, t 있는 모듈 뒤), 없는 모듈(새로 넣은 것·옛 앱이 저장한 것)은 그 뒤에 옛 규칙(남은 열에 안 들어가면 다음 줄)으로 열을 정한다 */
export function freeOrder(items) {
  let used = 12;
  return [...items.filter(hasXY).sort((a, b) => (tOf(a) ?? Infinity) - (tOf(b) ?? Infinity) || a.y - b.y || a.x - b.x).map((it) => ({ it, x: it.x })),
    ...items.filter((it) => !hasXY(it)).map((it) => { const w = spanOf(it); if (used + w > 12) used = 0; used += w; return { it, x: used - w }; })];
}

/** 5~7차 쌓기(9차는 줄·열로 바꿀 때만 쓴다) — 순서대로 상자({ x, w, h, t? })를 놓는다. top = max(t, 자기 열(x~x+w)에 앞서 놓인 모듈 아래 끝 + 틈). 겹치면 아래로 밀리고 겹치지 않는다.
 *  t가 없으면 0 — 위가 비면 올라간다(세로 중력, 5·6차). t가 있으면 그 높이에 그대로(빈칸 허용, 7차). 상자마다 top을 붙여 돌려준다 */
export function pack(list, gap) {
  const floor = Array(12).fill(0);
  return list.map((b) => {
    const x = Math.max(0, Math.min(b.x, 12 - b.w)), top = Math.max(b.t ?? 0, ...floor.slice(x, x + b.w));
    floor.fill(top + b.h + gap, x, x + b.w);
    return { ...b, x, top };
  });
}

/** total을 weights 비율대로 나눈다 — 각자 최소(mins) 밑으로는 안 내려가고(모자라면 최소로 묶고 나머지를 다시 비율로), 정수 합 = total */
export function share(total, weights, mins) {
  const out = weights.map(() => 0);
  let rest = weights.map((_, i) => i), left = total;
  for (let low = [0]; low.length && rest.length;) {
    const sum = rest.reduce((s, i) => s + weights[i], 0);
    low = rest.filter((i) => (left * weights[i]) / sum < mins[i]);
    for (const i of low) { out[i] = mins[i]; left -= mins[i]; }
    rest = rest.filter((i) => !low.includes(i));
  }
  const sum = rest.reduce((s, i) => s + weights[i], 0), raw = rest.map((i) => (left * weights[i]) / sum);
  rest.forEach((i, k) => { out[i] = Math.floor(raw[k]); });
  let extra = left - rest.reduce((s, i) => s + out[i], 0);
  for (const k of raw.map((v, k) => k).sort((a, b) => (raw[b] % 1) - (raw[a] % 1) || a - b)) if (extra-- > 0) out[rest[k]] += 1;
  return out;
}

/** 모듈이 차지할 수 있는 가장 좁은 열 폭(24분의 몇) — 지금 열 범위의 최소 열 수 기준(현황 16, 보통 6) */
export const colMin = (mod) => 2 * spanRange(mod.sizes)[0];

/** 줄 목록 정리 — 빈 열은 빼고, 열이 하나 남은 줄은 모듈마다 전체 폭 한 줄로(노션처럼 열이 없는 블록), 4열을 넘는 열은 아래 줄로.
 *  열 폭은 비율(w)을 24로 나눈다 — 모듈 최소 폭 밑으로는 안 내려간다(최소 합이 24를 넘으면 비율대로). minOf(id) = 그 모듈 최소 폭 */
export function tidy(rows, minOf) {
  const out = [], alone = (col) => col.ids.forEach((id) => out.push([{ w: 24, ids: [id] }]));
  for (const row of rows) {
    const cols = row.filter((col) => col.ids.length);
    if (cols.length < 2) { cols.forEach(alone); continue; }
    const keep = cols.slice(0, 4), mins = keep.map((col) => Math.max(...col.ids.map(minOf))), fits = mins.reduce((a, b) => a + b) <= 24;
    const ws = share(24, keep.map((col) => col.w || 24 / keep.length), fits ? mins : mins.map(() => 1));
    out.push(keep.map((col, i) => ({ w: ws[i], ids: col.ids })));
    cols.slice(4).forEach(alone);
  }
  return out;
}

const cross = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
/** 이어지는 것끼리 묶는다(합집합 찾기) — 묶음은 목록 순서, 묶음 안도 목록 순서 */
function groups(list, join) {
  const up = list.map((_, i) => i), root = (i) => (up[i] === i ? i : (up[i] = root(up[i])));
  list.forEach((a, i) => list.forEach((b, j) => { if (j > i && join(a, b)) up[root(i)] = root(j); }));
  return [...new Set(list.map((_, i) => root(i)))].map((k) => list.filter((_, i) => root(i) === k));
}

/**
 * 보이는 모듈 → 줄 목록 [[{ w, ids }]] (열 폭 w = 24분의 몇, ids = 위에서부터).
 * - 줄·열(r·c)이 있는 배치: 그대로. 줄·열이 없는 모듈(새로 넣은 것·옛 앱이 저장한 것)은 맨 아래에 한 줄씩.
 * - 5~7차 배치(x·y·t): 그 차수 규칙으로 쌓은 화면 모양에서 — 세로로 48px 이상 겹치는 묶음이 한 줄, 그 안에서 열 범위가 겹치는 모듈끼리 한 열(폭 = 열 범위).
 * - 옛 배치(자리 없음): CSS 격자 줄 그대로, 모듈마다 한 열(폭 = 열 수).
 * hOf(item) = 지금 높이(정한 높이·고정 높이·화면에서 잰 내용 높이), minOf(id) = 최소 폭
 */
export function layoutRows(items, hOf, gap, minOf) {
  let rows;
  if (items.some(hasRC)) {
    const by = new Map(), tail = [];
    for (const it of items) {
      if (!hasRC(it)) { tail.push([{ w: 24, ids: [it.id] }]); continue; }
      const row = by.get(it.r) ?? by.set(it.r, new Map()).get(it.r), col = row.get(it.c) ?? row.set(it.c, { w: 0, ids: [] }).get(it.c);
      col.w ||= cwOf(it); col.ids.push(it.id);
    }
    const sorted = (map) => [...map].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    rows = [...sorted(by).map(sorted), ...tail];
  } else if (items.some(hasXY)) {
    const boxes = pack(freeOrder(items).map(({ it, x }) => ({ id: it.id, x, w: spanOf(it), h: hOf(it), t: tOf(it) })), gap).sort((a, b) => a.top - b.top || a.x - b.x);
    rows = groups(boxes, (a, b) => !cross(a, b) && Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top) >= 48)
      .map((band) => groups(band, cross).map((col) => { const l = Math.min(...col.map((b) => b.x)); return { l, w: Math.max(...col.map((b) => b.x + b.w)) - l, ids: col.map((b) => b.id) }; }).sort((a, b) => a.l - b.l));
  } else rows = rowsOf(items).map((row) => row.map((it) => ({ w: spanOf(it), ids: [it.id] })));
  return tidy(rows, minOf);
}

/** 줄 목록 → 자리. pos: id → { x, w(24분의 몇), top, h, o(좁은 폭 순서) }, lines: 줄마다 { top, h }, height = 전체 높이. hOf(id) = 높이 */
export function placeRows(rows, hOf, gap) {
  const pos = new Map(), lines = [];
  let top = 0, o = 0;
  for (const row of rows) {
    let x = 0, bottom = top;
    for (const col of row) {
      let y = top;
      for (const id of col.ids) { const h = hOf(id); pos.set(id, { x, w: col.w, top: y, h, o: o++ }); y += h + gap; }
      bottom = Math.max(bottom, y - gap); x += col.w;
    }
    lines.push({ top, h: bottom - top });
    top = bottom + gap;
  }
  return { pos, lines, height: Math.max(0, top - gap) };
}

/**
 * 서버 페이지 목록(본문 제외) + 이 기기 목록 → 화면 목록.
 * before = 목록을 요청할 때 보낼 것이 있던 id, pendingNow = 응답을 받은 지금 보낼 것이 있는 id — 둘 중 하나면 이 기기 값을 지킨다.
 * 응답은 요청 시점 스냅숏이라, 그 사이 끝난 쓰기(새 페이지·저장)를 모른다(9/27 실측: 새 페이지가 사라지고 입력이 유실).
 */
export function mergePages(rows, local, { before, pendingNow, spaceOf }) {
  const keep = (id) => before.has(id) || pendingNow.has(id);
  const mine = new Map(local.map((p) => [p.id, p]));
  const pages = [], trash = [], seen = new Set();
  for (const r of rows) {
    const space = spaceOf(r);
    if (!space) continue;
    seen.add(r.id);
    const m = mine.get(r.id);
    if (m && keep(r.id)) { (m.trashedAt ? trash : pages).push(m); continue; }
    const row = { id: r.id, space, parent: r.parent_id, position: r.position, title: r.title, icon: r.restricted ? 'lock' : 'doc', restricted: r.restricted, general: r.general,
      version: r.version, updated: r.updated_at, owner: r.owner_user_id, orgId: r.org_id, access: r.access, template: !!r.is_template, content: m && m.version === r.version ? m.content : undefined,
      loadedAt: m && m.version === r.version ? m.loadedAt : undefined };
    if (r.archived_at) trash.push({ ...row, trashedAt: r.archived_at }); else pages.push(row);
  }
  for (const p of local) if (!seen.has(p.id) && keep(p.id)) (p.trashedAt ? trash : pages).push(p); // 아직 서버에 없는(또는 스냅숏 뒤에 생긴) 새 페이지
  return { pages, trash };
}
