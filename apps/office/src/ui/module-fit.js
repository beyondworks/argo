// '모듈 맞춤'(유건 10/1 밤 6차) — 누를 때 받는 지연 모듈. 화면에서 지금 높이와 내용 높이(스크롤바가 생기지 않는 높이)를 재고, 계산은 core/fit.js.
import { minHeight } from '../core/layout.js';
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
  const cards = [...grid.children].filter((node) => node.dataset.mod), cur = {}, nat = {}, min = {}, stack = new Set();
  for (const node of cards) cur[node.dataset.mod] = node.offsetHeight;
  // 내용 높이 — 정한 높이·고정 높이·줄 높이 늘이기(옛 CSS 격자)를 잠깐 풀고 잰 뒤 바로 되돌린다(한 번에 읽고 써서 화면에는 그려지지 않는다)
  const classes = cards.map((node) => node.className);
  for (const node of cards) { node.classList.remove('sized-h', 'fixed-h'); node.style.alignSelf = 'start'; }
  for (const node of cards) {
    const id = node.dataset.mod, item = items.find((it) => it.id === id), mod = modOf(item);
    min[id] = minHeight(mod, node.firstElementChild.offsetHeight);
    nat[id] = Math.min(1200, Math.max(min[id], node.offsetHeight));
    if (mod.stack) stack.add(id);
  }
  cards.forEach((node, i) => { node.className = classes[i]; node.style.alignSelf = ''; });
  return fitLayout(items, { cur, nat, min, stack: (id) => stack.has(id), gap: parseFloat(getComputedStyle(grid).rowGap) || 12 });
}
