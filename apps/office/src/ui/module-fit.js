// '모듈 맞춤'(유건 10/1 밤 6차) — 누를 때 받는 지연 모듈. 화면에서 지금 높이와 내용 높이(스크롤바가 생기지 않는 높이)를 재고, 계산은 core/fit.js.
import { minHeight, colMin, layoutRows } from '../core/layout.js';
import { fitLayout } from '../core/fit.js';
import { t, registerDict } from '../core/i18n.js';
import { showToast } from './Overlay.jsx';
import { FIT_DICT } from './grid-i18n.js';

registerDict(FIT_DICT);

/** 홈 '모듈 맞춤' 단추 — wrap = 격자를 담은 화면, save = 배치 저장(실패하면 저장 쪽이 알린다). 한 번 저장(layout.set 1회), 이미 맞으면 저장하지 않는다 */
export function run(wrap, items, modOf, save) {
  const next = fit(wrap.querySelector('.grid'), items, modOf);
  if (!next) showToast(t('home.fitSame'));
  else if (save(next)) showToast(t('home.fitDone'));
}

/** grid = 홈 격자(.grid), items = 저장할 항목 전부(숨김 포함), modOf = 등록부 정의. 돌려주는 값 = 저장할 항목, 이미 맞아 있으면 null */
export function fit(grid, items, modOf) {
  const cards = [...grid.children].filter((node) => node.dataset.mod), cur = {}, nat = {}, min = {}, stack = new Set(), byId = new Map(items.map((it) => [it.id, it]));
  for (const node of cards) cur[node.dataset.mod] = node.offsetHeight;
  // 줄 목록 = 지금 그린 그대로(줄·열이 없는 옛 배치는 지금 높이로 만든다 — ModuleGrid와 같은 계산)
  const gap = parseFloat(getComputedStyle(grid).rowGap) || 12, visible = items.filter((it) => !it.hidden && cur[it.id] != null);
  const rows = layoutRows(visible, (it) => cur[it.id], gap, (id) => colMin(modOf(byId.get(id))));
  // 내용 높이 — 정한 높이·고정 높이를 잠깐 풀고 잰 뒤 바로 되돌린다(한 번에 읽고 써서 화면에는 그려지지 않는다)
  const classes = cards.map((node) => node.className);
  for (const node of cards) node.classList.remove('sized-h', 'own-h', 'fixed-h');
  for (const node of cards) {
    const id = node.dataset.mod, mod = modOf(byId.get(id));
    min[id] = minHeight(mod, node.firstElementChild.offsetHeight);
    nat[id] = Math.min(1200, Math.max(min[id], node.offsetHeight));
    if (mod.stack) stack.add(id);
  }
  cards.forEach((node, i) => { node.className = classes[i]; });
  return fitLayout(items, { rows, nat, min, stack: (id) => stack.has(id), gap, modOf });
}
