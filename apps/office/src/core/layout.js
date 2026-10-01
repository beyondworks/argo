// 모듈 배치 — 12열 자유 격자(유건 10/1 저녁 확정, iOS 위젯·Grafana 방식). 모듈마다 시작 열 x·폭(열 수)·높이(px 또는 내용대로)·
// 순서 y를 따로 갖고, 빈 곳이 있으면 위로 붙는다(세로 중력, 겹침 없음). 자리(x·y)가 없는 옛 저장값은 예전 그대로 "순서 + 열 수 + 줄 높이 공유"로 그린다.
// 좁은 폭에서는 y→x 순서로 한 줄이 된다. 저장된 배치와 등록부를 합치는 규칙은 순수 함수로 두고 테스트로 잠근다.
export const SIZES = ['s', 'm', 'l', 'full'];
export const SPAN = { s: 4, m: 6, l: 8, full: 12 };
// 가장자리 끌기(유건 10/1): 폭은 열 수(span 1~12, 끌기 전 단계는 baseSize), 높이는 px(h, 120~1200) — 없으면 크기 단계·내용대로
// span은 같이 쓴 size(가장 가까운 단계)와 맞을 때만 — 옛 탭의 '크기' 메뉴가 size만 바꾸면 남은 span보다 그 size가 이긴다(검수 10/1)
export const spanOf = (it) => (Number.isInteger(it.span) && it.span > 0 && it.span < 13 && it.size === sizeForSpan(it.span) ? it.span : SPAN[it.size] ?? 6);
export const heightOf = (it) => (Number.isInteger(it.h) && it.h >= 120 && it.h <= 1200 ? it.h : 0);
/** 자유 격자 자리 — x = 시작 열(0~11), y = 위에서부터 순서. 둘 다 있어야 자리로 읽는다(옛 앱이 저장한 값에는 없다) */
export const hasXY = (it) => Number.isInteger(it.x) && it.x >= 0 && it.x < 12 && Number.isInteger(it.y) && it.y >= 0;
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
    // 기본 배치가 자리(x·y)·폭·높이를 주면 그대로 쓴다(체험판 기본 배치) — 운영 기본값은 id·size만 준다
    const visible = defaults.filter((d) => usable.has(d.id)).map(({ id, size, span, h, x, y, cfg }) => ({ id, size, ...(span ? { span } : {}), ...(h ? { h } : {}), ...(hasXY({ x, y }) ? { x, y } : {}), hidden: false, ...(cfg ? { cfg } : {}) }));
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
    items.push({ id: it.id, ...(it.moduleId ? { moduleId: it.moduleId } : {}), size: mod.sizes.includes(it.size) ? it.size : mod.defaultSize, ...(Number.isInteger(span) && span >= lo && span <= hi ? { span, ...(mod.sizes.includes(it.baseSize) ? { baseSize: it.baseSize } : {}) } : {}), ...(heightOf(it) ? { h: it.h } : {}), ...(hasXY(it) ? { x: it.x, y: it.y } : {}), hidden: !!it.hidden, ...(it.cfg ? { cfg: it.cfg } : {}) });
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

/** 모듈마다 줄 정보 — h: 같은 줄이 같이 쓰는 높이(정해진 것 중 가장 큰 값, 0 = 내용대로), min: 줄 최소 높이(줄 모듈 최소 중 가장 큰 값), first: 줄 첫 모듈 */
export const rowInfo = (items, modOf) => new Map(rowsOf(items).flatMap((row) => {
  const h = Math.max(...row.map(heightOf)), min = Math.max(...row.map((it) => minHeight(modOf(it))));
  return row.map((it, i) => [it.id, { h, min, first: !i }]);
}));

/** 자유 격자 그리는 순서 — 자리(x·y)가 있는 모듈은 y→x, 없는 모듈(새로 넣은 것·옛 앱이 저장한 것)은 그 뒤에 옛 규칙(남은 열에 안 들어가면 다음 줄)으로 열을 정한다 */
export function freeOrder(items) {
  let used = 12;
  return [...items.filter(hasXY).sort((a, b) => a.y - b.y || a.x - b.x).map((it) => ({ it, x: it.x })),
    ...items.filter((it) => !hasXY(it)).map((it) => { const w = spanOf(it); if (used + w > 12) used = 0; used += w; return { it, x: used - w }; })];
}

/** 세로 중력 — 순서대로 상자({ x, w, h })를 자기 열(x~x+w) 위 가장 낮은 바닥에 붙인다. 겹치지 않고, 위가 비면 올라간다. 상자마다 top을 붙여 돌려준다 */
export function pack(list, gap) {
  const floor = Array(12).fill(0);
  return list.map((b) => {
    const x = Math.max(0, Math.min(b.x, 12 - b.w)), top = Math.max(...floor.slice(x, x + b.w));
    floor.fill(top + b.h + gap, x, x + b.w);
    return { ...b, x, top };
  });
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
