// 모듈 배치 — "순서 + 크기 단계" 격자(유건 확정 2026-09-26). 자유 좌표를 쓰지 않아 빈칸·겹침이 원천적으로 없고,
// 좁은 폭에서는 같은 순서로 한 줄이 된다. 저장된 배치와 등록부를 합치는 규칙은 순수 함수로 두고 테스트로 잠근다.
export const SIZES = ['s', 'm', 'l', 'full'];
export const SPAN = { s: 4, m: 6, l: 8, full: 12 };

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
    return defaults.filter((d) => usable.has(d.id)).map((d) => ({ id: d.id, size: d.size, hidden: false }));
  }
  const seen = new Set();
  const items = [];
  for (const it of saved.items) {
    const mod = usable.get(it.id);
    if (!mod || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({ id: it.id, size: mod.sizes.includes(it.size) ? it.size : mod.defaultSize, hidden: !!it.hidden, ...(it.cfg ? { cfg: it.cfg } : {}) });
  }
  // 새로 생긴 모듈은 숨긴 채 뒤에 — intro: 'top'인 것만 맨 위에 보이게(유건 9/27: 현황 카드). 한 번 저장된 뒤엔 사용자 선택을 따른다.
  for (const [id, mod] of usable) if (!seen.has(id)) {
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

/**
 * 한 줄에 붙은 두 모듈의 경계를 함께 움직인다(노션 열 방식). 두 폭의 합은 유지하고, 둘 다 허용된 크기 단계인
 * 조합 중 끄는 위치(targetSpan 열)에 가장 가까운 것을 고른다 — 끝까지 당겨도 옆 모듈을 밀어내지 않는다(유건 2026-09-26).
 */
export function linkedResize(size, partner, targetSpan, sizes, partnerSizes) {
  const total = SPAN[size] + SPAN[partner];
  let best = [size, partner];
  for (const s of sizes) {
    const p = SIZES.find((x) => SPAN[x] === total - SPAN[s]);
    if (!p || !partnerSizes.includes(p)) continue;
    if (Math.abs(SPAN[s] - targetSpan) < Math.abs(SPAN[best[0]] - targetSpan)) best = [s, p];
  }
  return best;
}

/** 보이는 모듈을 줄로 나눈다 — CSS 격자 자동 배치(dense 없음)와 같은 규칙: 남은 열에 안 들어가면 다음 줄. */
export function rowsOf(items) {
  const rows = [];
  let used = 12;
  for (const it of items) {
    const span = SPAN[it.size];
    if (used + span > 12) { rows.push([]); used = 0; }
    rows.at(-1).push(it); used += span;
  }
  return rows;
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
      version: r.version, updated: r.updated_at, owner: r.owner_user_id, template: !!r.is_template, content: m && m.version === r.version ? m.content : undefined };
    if (r.archived_at) trash.push({ ...row, trashedAt: r.archived_at }); else pages.push(row);
  }
  for (const p of local) if (!seen.has(p.id) && keep(p.id)) (p.trashedAt ? trash : pages).push(p); // 아직 서버에 없는(또는 스냅숏 뒤에 생긴) 새 페이지
  return { pages, trash };
}
