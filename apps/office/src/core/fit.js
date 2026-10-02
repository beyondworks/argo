// 모듈 맞춤(유건 10/1 밤 6차 확정) — 높이만 맞춘다(폭·열 위치는 그대로). '모듈 맞춤' 단추를 누를 때만 받는다(첫 화면 밖).
// 상자 = 지금 화면에 놓인 모듈 { id, x, w, top, h }(px). nat = 스크롤바가 생기지 않는 내용 높이, min = 모듈 최소 높이.
import { pack, freeOrder, spanOf, heightOf, tOf } from './layout.js';
import { settle } from './grid-move.js';

const cross = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;

/** 띠(세로로 겹치는 모듈 묶음)와 그 안의 열 묶음(열 범위가 겹치는 모듈끼리, 위→아래 순서)으로 나눈다.
 *  열이 다른 두 모듈이 세로로 48px(모듈 머리 높이쯤) 이상 겹치면 같은 띠(이어지는 것끼리 한 띠) — 몇 px만 걸친 모듈은 아래에 놓인 것이라 다음 띠다(refs6/5).
 *  한 열에 위아래로만 쌓인 모듈은 각자 띠(옆에 기준이 없다). 맞춘 뒤에는 띠마다 아래 끝이 같아 다시 나눠도 같다 */
export function bands(boxes) {
  const list = boxes.slice().sort((p, q) => p.top - q.top || p.x - q.x), up = list.map((_, i) => i);
  const root = (i) => (up[i] === i ? i : (up[i] = root(up[i])));
  const join = (a, b, ok) => { if (ok) up[root(a)] = root(b); };
  list.forEach((a, i) => list.forEach((b, j) => j > i && join(i, j, !cross(a, b) && Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top) >= 48)));
  const groups = (band) => { const g = band.map((_, i) => i); const r = (i) => (g[i] === i ? i : (g[i] = r(g[i])));
    band.forEach((a, i) => band.forEach((b, j) => { if (j > i && cross(a, b)) g[r(i)] = r(j); }));
    return [...new Set(band.map((_, i) => r(i)))].map((k) => band.filter((_, i) => r(i) === k)); };
  return [...new Set(list.map((_, i) => root(i)))].map((k) => groups(list.filter((_, i) => root(i) === k)));
}

/** total을 nats 비율대로 나눈다 — 각자 최소(mins) 밑으로는 안 내려가고(모자라면 최소로 묶고 나머지를 다시 비율로), 정수 합 = total */
export function share(total, nats, mins) {
  const out = nats.map(() => 0);
  let rest = nats.map((_, i) => i), left = total;
  for (let low = [0]; low.length && rest.length;) {
    const sum = rest.reduce((s, i) => s + nats[i], 0);
    low = rest.filter((i) => (left * nats[i]) / sum < mins[i]);
    for (const i of low) { out[i] = mins[i]; left -= mins[i]; }
    rest = rest.filter((i) => !low.includes(i));
  }
  const sum = rest.reduce((s, i) => s + nats[i], 0), raw = rest.map((i) => (left * nats[i]) / sum);
  rest.forEach((i, k) => { out[i] = Math.floor(raw[k]); });
  let extra = left - rest.reduce((s, i) => s + out[i], 0);
  for (const k of raw.map((v, k) => k).sort((a, b) => (raw[b] % 1) - (raw[a] % 1) || a - b)) if (extra-- > 0) out[rest[k]] += 1;
  return out;
}

/** 모듈마다 맞춘 높이 — 띠 안의 하나짜리 열 묶음('1')이 기준(사용자가 정한 높이와 내용 높이 중 큰 값, 여럿이면 그중 가장 큰 값), '1'이 없으면(n:m) 내용 높이 합이 가장 큰 묶음.
 *  n쪽은 기준 높이(틈 빼고)를 내용 높이 비율로 나눈다. 혼자인 띠는 내용 높이 — 쌓이지 않는 모듈은 null(내용대로, 정한 높이 없음).
 *  stack(id) = 쌓이는 모듈(정한 높이가 없으면 고정 높이로 그린다)이라 혼자여도 높이를 정해 둔다 */
export function fitHeights(boxes, nat, min, stack, gap, own = {}) {
  const out = new Map(), sum = (g, f) => g.reduce((s, m) => s + f[m.id], 0) + gap * (g.length - 1);
  for (const band of bands(boxes)) {
    // 혼자인 띠, 또는 열 묶음 안에 나란히 놓인 모듈이 있어 위아래로 나눌 수 없는 띠는 모듈마다 내용 높이
    if (band.length === 1 && band[0].length === 1 || band.some((g) => g.some((a) => g.some((b) => !cross(a, b))))) { for (const m of band.flat()) out.set(m.id, stack(m.id) ? nat[m.id] : null); continue; }
    const ones = band.filter((g) => g.length === 1);
    const ref = ones.length ? Math.max(...ones.map(([m]) => Math.max(own[m.id] || 0, nat[m.id]))) : Math.max(...band.map((g) => sum(g, nat))); // '1'은 사용자가 정한 높이(own)가 있으면 그것이 기준 — 늘려 둔 캘린더를 줄이지 않는다. 정한 적 없거나 스크롤바가 생기는 높이면 내용 높이(유건 10/2)
    const top = Math.max(ref, ...band.map((g) => sum(g, min)));
    for (const g of band) {
      if (g.length === 1) out.set(g[0].id, top);
      else share(top - gap * (g.length - 1), g.map((m) => nat[m.id]), g.map((m) => min[m.id])).forEach((h, i) => out.set(g[i].id, h));
    }
  }
  return out;
}

/** 배치 전체를 맞춘다. cur = 지금 화면 높이(띠 나누기), nat·min = 위와 같다. 돌려주는 값 = 저장할 항목, 이미 맞아 있으면 null(저장하지 않는다).
 *  자리(x·y)가 없는 옛 배치는 지금 자리로 x·y를 만든다(옛 규칙 순서·열). 숨긴 모듈은 그대로 뒤에.
 *  맞춤은 정리 동작이라 높이를 맞춘 뒤 세로 위치(t)를 중력으로 다시 계산해 위로 붙인다(빈칸 정리, 7차). t가 없던 배치(중력으로 그리던 것)는 t만 생겨서는 바뀐 게 아니다 */
export function fitLayout(items, { cur, nat, min, stack, gap }) {
  const order = freeOrder(items.filter((it) => !it.hidden)), boxOf = (it, x, h) => ({ id: it.id, x, w: spanOf(it), h });
  const hs = fitHeights(pack(order.map(({ it, x }) => boxOf(it, x, cur[it.id])), gap), nat, min, stack, gap, Object.fromEntries(order.map(({ it }) => [it.id, heightOf(it)])));
  const next = items.map((it) => { if (!hs.has(it.id)) return it; const { h, ...rest } = it, v = hs.get(it.id); return v == null ? rest : { ...rest, h: v }; });
  const placed = pack(order.map(({ it, x }) => boxOf(it, x, hs.get(it.id) ?? nat[it.id])), gap);
  const out = settle(next, placed), was = new Map(items.map((it) => [it.id, it]));
  return out.every((it) => it.hidden || (heightOf(it) === heightOf(was.get(it.id)) && it.x === was.get(it.id).x && it.y === was.get(it.id).y && (tOf(was.get(it.id)) == null || it.t === was.get(it.id).t))) ? null : out;
}
