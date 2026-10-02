// 모듈 맞춤(유건 10/1 밤 6차 확정, 9차 줄 단위) — 높이만 맞춘다(열·폭은 그대로). '모듈 맞춤' 단추를 누를 때만 받는다(첫 화면 밖).
// 줄 목록 = layout.js layoutRows. nat = 스크롤바가 생기지 않는 내용 높이, min = 모듈 최소 높이.
import { share, heightOf } from './layout.js';
import { settle } from './block-move.js';

/** 모듈마다 맞춘 높이 — 줄마다 열 아래 끝을 맞춘다. 모듈 하나짜리 열('1')이 기준(사용자가 정한 높이와 내용 높이 중 큰 값, 여럿이면 그중 가장 큰 값),
 *  '1'이 없으면(n:m) 내용 높이 합이 가장 큰 열. 여러 모듈 열은 기준 높이(틈 빼고)를 내용 높이 비율로 나눈다(최소 높이는 지킨다).
 *  열이 하나인 줄(전체 폭)은 내용 높이 — 쌓이지 않는 모듈은 null(내용대로, 정한 높이 없음), stack(id) = 쌓이는 모듈은 내용 높이를 정해 둔다 */
export function fitHeights(rows, nat, min, stack, gap, own = {}) {
  const out = new Map(), sum = (col, f) => col.ids.reduce((s, id) => s + f[id], 0) + gap * (col.ids.length - 1);
  for (const row of rows) {
    if (row.length < 2) { for (const id of row[0].ids) out.set(id, stack(id) ? nat[id] : null); continue; }
    const ones = row.filter((col) => col.ids.length === 1);
    // '1'은 사용자가 정한 높이(own)가 있으면 그것이 기준 — 늘려 둔 캘린더를 줄이지 않는다. 정한 적 없거나 스크롤바가 생기는 높이면 내용 높이(유건 10/2)
    const ref = ones.length ? Math.max(...ones.map(({ ids: [id] }) => Math.max(own[id] || 0, nat[id]))) : Math.max(...row.map((col) => sum(col, nat)));
    const top = Math.max(ref, ...row.map((col) => sum(col, min)));
    for (const col of row) {
      if (col.ids.length === 1) out.set(col.ids[0], top);
      else share(top - gap * (col.ids.length - 1), col.ids.map((id) => nat[id]), col.ids.map((id) => min[id])).forEach((h, i) => out.set(col.ids[i], h));
    }
  }
  return out;
}

/** 배치 전체를 맞춘다 — 돌려주는 값 = 저장할 항목(줄·열과 옛 필드 포함), 높이가 이미 맞아 있으면 null(저장하지 않는다 — 줄·열 필드만 생기는 것은 바뀐 게 아니다) */
export function fitLayout(items, { rows, nat, min, stack, gap, modOf }) {
  const hs = fitHeights(rows, nat, min, stack, gap, Object.fromEntries(items.map((it) => [it.id, heightOf(it)])));
  if (items.every((it) => !hs.has(it.id) || (hs.get(it.id) ?? 0) === heightOf(it))) return null;
  const next = items.map((it) => { if (!hs.has(it.id)) return it; const { h: _, ...rest } = it, v = hs.get(it.id); return v == null ? rest : { ...rest, h: v }; });
  return settle(next, rows, (id) => hs.get(id) ?? nat[id], gap, modOf);
}
