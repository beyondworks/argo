// 표면·둥글기·본문 폭(유건 9/30 UX 2차 2·3·4번) — 화면 css에 순백 바탕·카드색 직접 쓰기·제멋대로 둥글기가 다시 생기지 않게 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WIDTH_KEY, SHELLS } from '../src/core/theme.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
// 설정 화면의 셸 견본(.shell-mini·.sm-*)은 고를 셸을 그려 보이는 그림이라 뺀다
const SCREEN = ['../src/base.css', '../src/business/business.css', '../src/views/views.css', '../src/calendar/calendar.css', '../src/pages/perf.css', '../src/pages/module-library.css'];
const screen = (f) => strip(read(f)).split('\n').filter((l) => !/^\.(shell-mini|sm-)/.test(l)).join('\n');
const rules = (src) => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), decl: m[2] }));

// 이유(2번): 테마마다 --card가 순백인 곳이 있다 — 화면이 --card·#fff를 바탕으로 쓰면 그 테마에서 흰 카드가 튄다.
// 바탕은 base.css의 --surface·--lift·--field·--float(카드색을 섞은 값)만 쓴다. 토큰 정의(:root)는 예외.
test('화면 css: 순백·--card를 바탕으로 쓰지 않는다', () => {
  for (const f of SCREEN) for (const { sel, decl } of rules(screen(f))) {
    if (sel === ':root') continue;
    for (const d of decl.matchAll(/(?:background(?:-color)?|fill|stroke)\s*:\s*([^;]+)/g)) {
      assert.doesNotMatch(d[1], /#fff\b|#ffffff|\bwhite\b|var\(--card\)/i, `${f} ${sel.slice(0, 60)} → ${d[1]}`);
    }
  }
});

// 이유(2번): 색 블록이 --surface·--lift를 단색으로 다시 정하면 반투명 규칙이 그 테마에서만 풀린다(9/30 이전 mist는 --surface: #ffffff).
test('themes.css 색 블록은 표면 토큰을 정하지 않는다 — --card·--bg만 정하고 섞기는 base.css가', () => {
  const colors = rules(strip(read('../src/themes.css'))).filter((r) => /data-theme='/.test(r.sel));
  assert.ok(colors.length >= 10);
  for (const { sel, decl } of colors) assert.doesNotMatch(decl, /--(surface|lift|field|float|t-card-bg|t-main-bg|t-panel-bg)\s*:/, sel.slice(0, 60));
  assert.doesNotMatch(strip(read('../src/tokens.css')), /--(surface|lift|field|float)\s*:/);
});

// 이유(3번): 둥글기는 두 단 — 큰 틀 --rs, 그 안의 작은 카드·줄 --rc. 셸·커스텀 둥글기가 값을 바꾸므로 8px 이상 고정값은 쓰지 않는다
// (원·알약 999px/50%와 8px 미만의 배지·칩·손잡이는 예외).
test('화면 css: 8px 이상 둥글기는 토큰(--rs·--rc)으로', () => {
  for (const f of SCREEN) for (const m of screen(f).matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
      const n = +px[1];
      assert.ok(n < 8 || n === 999 || /calc\(var\(--r[sc]\)/.test(m[1]), `${f}: border-radius ${m[1]}`);
    }
  }
});

const radiusOf = (cls) => {
  const all = SCREEN.flatMap((f) => rules(screen(f)));
  const hit = all.filter(({ sel }) => sel.split(',').some((s) => s.trim() === cls)).map(({ decl }) => decl.match(/border-radius\s*:\s*([^;]+)/)?.[1]).filter(Boolean);
  assert.ok(hit.length, `${cls} 규칙 없음`);
  return hit.at(-1).trim();
};
// 이유(유건 10/1 "카드 모서리 둥근값 통일"): 9/30에 틀(--rs)과 그 안 카드(--rc)를 두 단으로 나눴더니 홈 모듈(12px)과 현황 카드(8px)가 서로 달라 보였다.
// 카드류는 모두 --rs 하나, --rc는 버튼·입력·배지·칩·탭·메뉴 항목 같은 작은 조작 요소만. 카드류에 --rc(또는 고정값)가 오면 실패한다.
const CARDS = ['.module', '.set-card', '.table-wrap', '.stat-card', '.vw-lane', '.vw-card', '.vw-kcard', '.deal-lane', '.deal-card', '.mkt-card', '.mkt-summary', '.card-fields', '.card-empty',
  '.list-row', '.ap-row', '.journal-entry', '.rec-row', '.perf-goal', '.perf-thread li', '.history-preview', '.tpl-item', '.private-block', '.conflict', '.bizui-line', '.bizui-order-line', '.bizui-balances',
  '.modal', '.menu', '.palette', '.info-pop', '.mention-list', '.vw-selbar', '.login-card'];
// 이유(유건 10/1 5차 "둥글기 통일"): 사이드바 줄(선택된 메뉴 줄 배경)은 셸·카드와 같은 곡선 — 작은 조작 요소(--rc)가 아니라 카드 둥글기 --rs를 쓴다.
const SIDE_ROWS = ['.space-switch', '.search-btn', '.nav-item', '.tree-row', '.crew-search', '.crew-row', '.crew-btn'];
const CONTROLS = ['.btn', '.icon-btn', '.input', '.seg', '.menu-item', '.palette-row', '.fold-item', '.cal-row', '.vw-row', '.mod-row'];
test('카드류는 --rs 하나, --rc는 작은 조작 요소만', () => {
  for (const c of CARDS) assert.equal(radiusOf(c), 'var(--rs)', c);
  for (const c of CONTROLS.filter((x) => x !== '.fold-item')) assert.equal(radiusOf(c), 'var(--rc)', c);
  for (const c of SIDE_ROWS) assert.equal(radiusOf(c), 'var(--rs)', c);
  // 카드류 규칙 어디에도(여러 선택자를 묶은 규칙 포함) --rc가 없다
  for (const f of SCREEN) for (const { sel, decl } of rules(screen(f))) {
    if (sel.split(',').some((s) => CARDS.includes(s.trim()))) assert.doesNotMatch(decl, /border-radius\s*:[^;]*--rc/, `${f} ${sel}`);
  }
  // 셸이 현황 카드·메뉴만 따로 둥글리던 토큰(--t-tile-r·--t-pop-r)이 돌아오지 않게
  const themes = read('../src/themes.css');
  assert.doesNotMatch(themes, /\.stat-card[^{]*\{[^}]*border-radius/);
  assert.doesNotMatch(themes, /--t-(tile|pop)-r/);
  assert.match(themes, /:is\(\.menu, \.palette\) \{ border-radius: var\(--rs\); \}/);
});

// 이유(유건 10/1 5차): 어느 셸이든 선택된 메뉴 줄 둥글기 = 그 셸의 카드 둥글기. 셸 블록이 --rs를 정하고 --t-nav-r를 그 값으로 두는지(화면에서 getComputedStyle로도 쟀다).
test('셸마다 사이드바 줄 둥글기(--t-nav-r)는 그 셸의 --rs', () => {
  const themes = rules(strip(read('../src/themes.css')));
  const shells = SHELLS.filter((x) => x !== 'plain');
  assert.equal(shells.length, 7);
  for (const shell of shells) {
    const block = themes.find((r) => r.sel === `:root[data-shell='${shell}']`);
    assert.ok(block, shell);
    assert.match(block.decl, /--rs:\s*\d+px/, `${shell} --rs`);
    assert.match(block.decl, /--t-nav-r:\s*var\(--rs\)\s*;/, `${shell} --t-nav-r`);
  }
});

// 이유(4번): 전체 너비는 사람마다 한 번 정하면 모든 페이지에 — 첫 페인트와 전환 버튼이 같은 키를 봐야 새로고침에 깜빡이지 않는다.
test('전체 너비: 첫 페인트 키 = theme.js 키, 설정·휴지통·모듈 보관함은 가운데 그대로', () => {
  assert.ok(read('../index.html').includes(`localStorage.getItem('${WIDTH_KEY}') === 'full'`));
  const rule = strip(read('../src/base.css')).split('\n').find((l) => l.startsWith('html.full-width'));
  assert.ok(rule, 'html.full-width 규칙');
  assert.match(rule, /\.content:not\(\.view-settings, \.view-trash\) \.page-wrap:not\(\.module-library-page\)/);
  assert.match(rule, /max-width: none/);
  assert.match(read('../src/core/commands.js'), /id: 'width'.*run: toggleWidth/, '⌘K 명령');
  const i18n = read('../src/core/i18n.js');
  for (const k of ['width.full', 'width.center']) assert.match(i18n, new RegExp(`'${k}': \\['[^']*[가-힣][^']*', '[^가-힣']+'\\]`), k);
});
