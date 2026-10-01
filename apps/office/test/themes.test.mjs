// 테마 = 앱 셸 × 색상 — 목록·첫 페인트·예전 테마 이어받기·사전·글자 대비를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, FAMILIES, EMUL, SHELLS, SHELL_OF } from '../src/core/theme.js';
import { SWATCH, COLOR_GROUPS } from '../src/pages/theme-picks.js';

const css = readFileSync(new URL('../src/themes.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/core/i18n.js', import.meta.url), 'utf8');
const NEW = ['cream', 'sand', 'peach', 'mist', 'glow', 'sage', 'ocean', 'rose', 'lavender', 'slate', 'ember'];
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
// 중첩(@media) 안의 규칙까지 모두 — [{ sel, decl }]
function rulesOf(src) {
  const out = []; const stack = []; let buf = '';
  for (const ch of strip(src)) {
    if (ch === '{') { const pre = buf.trim(); stack.push(pre.startsWith('@') ? null : { sel: pre, decl: '' }); buf = ''; continue; }
    if (ch === '}') { const top = stack.pop(); if (top) out.push({ sel: top.sel, decl: buf, nested: stack.includes(null) }); buf = ''; continue; }
    buf += ch;
  }
  return out;
}

// 이유: 이름이 한 곳에만 있으면 첫 페인트 스크립트가 모르는 테마로 보고 기본 테마로 깜빡인다.
test('테마 목록: 열세 가족 × (시스템·라이트·다크), 첫 페인트 정규식이 모두 받는다', () => {
  assert.equal(FAMILIES.length, 13);
  assert.equal(THEMES.length, FAMILIES.length * 3);
  for (const f of NEW) for (const s of ['', '-light', '-dark']) assert.ok(THEMES.includes(f + s), f + s);
  const re = new RegExp(html.match(/if \(\/(\^\(linen\|graphite[^/]*)\/\.test\(v\)\)/)[1]);
  for (const th of THEMES) assert.match(th, re, th);
  assert.doesNotMatch('cream-mid', re);
  const emul = new RegExp(html.match(/if \(\/(\^\(linen\|cream[^/]*)\/\.test\(th\)/)[1]);
  assert.deepEqual(THEMES.filter((th) => emul.test(th)), EMUL, '첫 페인트의 dark-emul 대상과 theme.js의 EMUL이 같아야 한다');
  const shellRe = new RegExp(html.match(/if \(!\/(\^\(plain[^/]*)\/\.test\(sh\)\)/)[1]);
  assert.deepEqual(SHELLS.filter((sh) => shellRe.test(sh)), SHELLS, '첫 페인트가 모든 셸을 받아야 한다');
  assert.doesNotMatch('flat', shellRe);
});

// 이유(유건 9/30 "앱쉘 선택 + 컬러 선택"): 셸이 없던 때 크림을 고른 사람은 셸을 따로 고르지 않아도 그때 모양(떠 있는 사이드바)을 그대로 받아야 한다.
test('예전 테마 이어받기: 셸 저장값이 없으면 색 가족의 옛 짝 셸 — theme.js와 첫 페인트가 같다', () => {
  assert.deepEqual(Object.keys(SHELL_OF), FAMILIES);
  for (const f of FAMILIES) assert.ok(SHELLS.includes(SHELL_OF[f]), f);
  const map = Function(`return ${html.match(/sh = (\{[^}]*\})\[th/)[1]}`)();
  for (const f of FAMILIES) assert.equal(map[f] ?? 'plain', SHELL_OF[f], f);
  assert.equal(SHELL_OF.cream, 'float'); assert.equal(SHELL_OF.linen, 'plain');
});

test('테마 이름: 색상·셸·모드·옛 테마 명령 이름이 모두 ko·en 사전에 있다', () => {
  const keys = [...THEMES.map((x) => `theme.${x}`), ...FAMILIES.map((x) => `color.${x}`), ...SHELLS.map((x) => `shell.${x}`), 'mode.system', 'mode.light', 'mode.dark'];
  for (const k of keys) {
    const m = i18n.match(new RegExp(`'${k.replace('.', '\\.')}': \\['([^']+)', '([^']+)'\\]`));
    assert.ok(m, `${k} 사전 항목 없음`);
    assert.match(m[1], /[가-힣]/, `${k} ko`);
    assert.doesNotMatch(m[2], /[가-힣]/, `${k} en`);
  }
});

// 이유: 기본 셸 + linen·graphite 화면은 한 픽셀도 바뀌면 안 된다 — 모양 규칙은 plain이 아닌 셸 아래에만, 색 규칙은 새 다섯 색 아래에만.
// 맨 앞 :root 기본값 블록은 base.css가 쓰지 않는 새 토큰(--frame·--t-*·--tile-*)만 정한다.
test('themes.css: 모든 규칙이 plain이 아닌 셸 또는 새 다섯 색 아래에만 있다', () => {
  // 설정 화면의 셸 견본(.shell-mini·.sm-*)은 고를 셸을 그려 보이는 곳이라 제외한다
  const baseApp = readFileSync(new URL('../src/base.css', import.meta.url), 'utf8').split('\n').filter((l) => !/^\.(shell-mini|sm-)/.test(l)).join('\n');
  const rules = rulesOf(css);
  assert.ok(rules.length > 80);
  for (const { sel, decl } of rules) for (const one of sel.split(/,(?![^()]*\))/)) {
    const s = one.trim();
    if (s === ':root') {
      for (const d of decl.matchAll(/--([a-z0-9-]+):/g)) {
        assert.match(d[1], /^(frame|t-|tile-)/, `기본값 블록의 토큰: --${d[1]}`);
        assert.doesNotMatch(baseApp, new RegExp(`var\\(--${d[1]}[,)]`), `base.css가 --${d[1]}을 쓰면 기본 화면이 바뀐다`);
      }
      continue;
    }
    assert.match(s, /^:root(:is\(\[data-(shell|theme)|\[data-(shell|theme|custom))/, `범위 밖 선택자: ${s.slice(0, 90)}`);
    assert.doesNotMatch(s, /plain|graphite/, s.slice(0, 90));
    if (/linen/.test(s)) assert.match(s, /data-shell='(panel|pill|glass)'/, `linen은 사이드바가 녹는 셸의 글자 색 보정에만: ${s.slice(0, 90)}`);
  }
});

// 이유(유건 9/30): 왼쪽 테두리 막대는 AI 티가 난다 — 활성 표시든 인용이든 쓰지 않는다.
test('왼쪽 테두리 막대 금지 — themes.css·base.css·페이지 css', () => {
  for (const f of ['../src/themes.css', '../src/base.css', '../src/business/business.css', '../src/pages/module-library.css', '../src/pages/perf.css']) {
    const body = strip(readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.doesNotMatch(body, /border-left\s*:|border-inline-start\s*:|inset\s+([2-9]|\d{2,})[\d.]*px\s+0\s+0\s/, f); // 1px은 서랍 가장자리 선이라 막대가 아니다
  }
});

test('themes.css: hover는 (hover: hover) 안에서만, transition: all 금지', () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /transition:\s*all/);
  let depth = 0, inHover = -1, buf = '';
  for (const ch of body) {
    if (ch === '{') { if (/@media[^{]*\(hover:\s*hover\)[^{]*$/.test(buf.split('}').at(-1))) inHover = depth; depth++; buf = ''; continue; }
    if (ch === '}') { depth--; if (depth === inHover) inHover = -1; buf = ''; continue; }
    buf += ch;
    if (inHover < 0 && buf.endsWith(':hover')) assert.fail(`(hover: hover) 밖의 :hover — ${buf.trim().slice(-80)}`);
  }
});

/* ── 글자 대비(WCAG): 본문 4.5:1 ── */
// 색 값은 tokens.css(linen·graphite) → base.css(표면 토큰 기본값·사이드바) → themes.css(셸 기본값·새 다섯 색) 순서로 쌓는다(뒤가 이긴다)
const tokensCss = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../src/base.css', import.meta.url), 'utf8');
const ALL = [...rulesOf(tokensCss), ...rulesOf(baseCss), ...rulesOf(css)];
function tokens(theme) {
  const isAuto = !/-(light|dark)$/.test(theme);
  const dark = theme.endsWith('-dark');
  const out = { __dark: dark }; // light-dark()를 고르는 기준(시스템 테마는 라이트로 잰다 — 다크는 -dark 이름으로 따로 잰다)
  for (const r of ALL) {
    const sel = r.sel;
    const fam = theme.replace(/-(light|dark)$/, '');
    // 표면 기본값(:root)·모양 블록(@family)과, 이 테마의 색 블록만 읽는다
    const base = sel.trim() === ':root';
    const shape = sel.trim() === `:root[data-theme^='${fam}']`;
    const color = dark
      ? sel.includes(`[data-theme='${fam}-dark']`)
      : sel.includes(`[data-theme='${fam}-light']`) || (isAuto && sel.includes(`[data-theme='${fam}']`) && !sel.includes('dark-emul'));
    const modeDark = dark && sel.includes("[data-theme$='-dark']"); // base.css 다크 표면(light-dark() 대신 모드별 블록)
    if (!base && !shape && !color && !modeDark) continue;
    for (const d of r.decl.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}
// 맨 바깥 쉼표에서 둘로 나눈다(괄호 안 쉼표는 건너뛴다)
const split2 = (x) => { let d = 0; for (let i = 0; i < x.length; i++) { const ch = x[i]; if (ch === '(') d++; else if (ch === ')') d--; else if (ch === ',' && !d) return [x.slice(0, i), x.slice(i + 1)]; } return null; };
// 값 풀기 — #hex · rgba() · rgb(r g b / a) · var(--x) · light-dark(라이트, 다크) · color-mix(in srgb, A N%, B|transparent)(알파를 곱해 섞는다 = 브라우저와 같은 계산)
function resolve(t, v, depth = 0) {
  v = (v ?? '').trim();
  assert.ok(depth < 12, `순환: ${v}`);
  const ld = v.match(/^light-dark\((.*)\)$/);
  if (ld) return resolve(t, split2(ld[1])[t.__dark ? 1 : 0], depth + 1);
  const sp = v.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/);
  if (sp) return { r: +sp[1], g: +sp[2], b: +sp[3], a: +sp[4] };
  const h = v.match(/^#([0-9a-f]{6})$/i);
  if (h) return { r: parseInt(h[1].slice(0, 2), 16), g: parseInt(h[1].slice(2, 4), 16), b: parseInt(h[1].slice(4), 16), a: 1 };
  const r = v.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/);
  if (r) return { r: +r[1], g: +r[2], b: +r[3], a: r[4] === undefined ? 1 : +r[4] };
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const va = v.match(/^var\(--([a-z0-9-]+)\)$/);
  if (va) return resolve(t, t[va[1]], depth + 1);
  const m = v.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/);
  if (m) {
    const [x, y, p] = [resolve(t, m[1], depth + 1), resolve(t, m[3], depth + 1), +m[2] / 100];
    const a = x.a * p + y.a * (1 - p);
    const ch = (k) => (a ? (x[k] * x.a * p + y[k] * y.a * (1 - p)) / a : 0);
    return { r: ch('r'), g: ch('g'), b: ch('b'), a };
  }
  return null;
}
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// 이유(유건 9/30 흰색 줄이기): 카드·버튼·메뉴 바탕이 반투명이라 글자 대비는 '밑바탕 위에 섞여 보이는 색'으로 잰다 —
// 캔버스 위 카드, 카드 위 작은 카드·입력칸, 본문 판(panel·pill·window) 위 카드, 떠 있는 층까지. 린넨·그래파이트도 같은 규칙.
const SEEN = (t, c) => {
  const bg = c('bg'), surface = over(c('surface'), bg), main = over(c('t-main-bg'), bg);
  return { bg, card: c('card'), surface, float: c('float'), 'lift on surface': over(c('lift'), surface), 'field on surface': over(c('field'), surface),
    'surface on surface': over(c('surface'), surface), main, 'surface on main': over(c('surface'), main) };
};
for (const fam of ['linen', 'graphite', ...NEW]) for (const mode of ['light', 'dark']) {
  const theme = `${fam}-${mode}`;
  test(`대비 4.5:1 — ${theme}`, () => {
    const t = tokens(theme);
    const c = (name) => { const v = resolve(t, t[name]); assert.ok(v, `${theme}: --${name} = ${t[name]}`); return v.a < 1 ? over(v, resolve(t, t.bg)) : v; };
    const raw = (name) => { const v = resolve(t, t[name]); assert.ok(v, `${theme}: --${name} = ${t[name]}`); return v; };
    const pairs = [];
    const seen = SEEN(t, raw);
    assert.equal(seen.float.a, 1, '떠 있는 층은 불투명해야 한다(뒤 글자가 비치면 못 읽는다)');
    for (const [where, bg] of Object.entries(seen)) for (const fg of ['fg', 'fg-2', 'fg-3']) pairs.push([`${fg} on ${where}`, ratio(c(fg), bg)]);
    // 상태 배지 글자(반투명 배지 배경을 표면 위에 올린 색) — 새 다섯 색만. linen·graphite는 메신저 생성 토큰(tokens.css)이라 여기서 고치지 않는다(9/30 기준 linen 3.2~4.4)
    if (NEW.includes(fam)) for (const base of ['card', 'surface', 'bg']) for (const k of ['ok', 'warn', 'danger']) pairs.push([`${k}/${k}-soft on ${base}`, ratio(c(k), over(raw(`${k}-soft`), seen[base]))]);
    pairs.push(['primary-fg/primary', ratio(c('primary-fg'), c('primary'))]);
    if (NEW.includes(fam)) {
      pairs.push(['mark-fg/mark', ratio(c('mark-fg'), c('mark'))]);
      for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) pairs.push([`${fg}/side-bg`, ratio(c(fg), c('side-bg'))]);
      pairs.push(['side-fg on side-active', ratio(c('side-fg'), over(raw('side-active'), c('side-bg')))]); // 선택된 메뉴(반투명 배경은 사이드바 위에 올린 색)
      for (const n of [1, 2, 3, 4, 5, 6]) for (const ink of ['tile-ink-2', 'tile-ink-3']) pairs.push([`${ink}/tile-${n}`, ratio(c(ink), c(`tile-${n}`))]);
    }
    const bad = pairs.filter(([, r]) => r < 4.5);
    assert.deepEqual(bad.map(([l, r]) => `${l} ${r.toFixed(2)}`), []);
  });
}

// 이유: 사이드바가 창 바탕에 녹는 셸(panel·pill·glass)은 사이드바 글자를 창 바탕(--bg) 위에 그린다.
// 보정 목록(linen·cream처럼 어두운 사이드바)에 없는 색은 사이드바 글자가 --bg 위에서도 읽혀야 한다.
test('녹는 사이드바 셸: 보정하지 않는 색은 사이드바 글자가 --bg 위에서도 4.5:1', () => {
  const [, shells, fix] = css.match(/:root:is\(((?:\[data-shell='[a-z]+'\](?:, )?)+)\):is\(([^)]*)\) \{\s*--side-bg: var\(--bg\)/);
  for (const sh of ['panel', 'pill', 'glass', 'liquid', 'neu']) assert.ok(shells.includes(`'${sh}'`), `사이드바가 바탕에 녹는 셸: ${sh}`);
  for (const fam of NEW) for (const mode of ['light', 'dark']) {
    const t = tokens(`${fam}-${mode}`);
    if (fix.includes(`'${fam}'`)) continue;
    for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) {
      const r = ratio(resolve(t, t[fg]), resolve(t, t.bg));
      assert.ok(r >= 4.5, `${fam}-${mode}: --${fg} ${t[fg]} / --bg ${t.bg} = ${r.toFixed(2)} — 보정 목록에 넣어야 한다`);
    }
  }
  assert.ok(fix.includes(`'linen'`));
});

/* ── 면 구분(유건 10/1 "카드·버튼 외곽선 빼고, 모드에 따라 경계 구분 가능하도록") ── */
// 경계선이 없으니 카드와 밑바탕은 면 색 차이로만 구분된다 — OKLab 명도(L, 0~1) 차이로 잰다. 기준은 눈으로 본 린넨 다크·미스트 라이트 화면에서 잡았다.
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const okL = ({ r, g, b }) => {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
};
export const EDGE_MIN = { card: 0.025, nested: 0.025, button: 0.025, panelCard: 0.02, laneCard: 0.015, lane: 0.012, float: 0.02 };
for (const fam of ['linen', 'graphite', ...NEW]) for (const mode of ['light', 'dark']) {
  const theme = `${fam}-${mode}`;
  test(`면 구분 — ${theme}: 카드·카드 안 카드·버튼·칸반·떠 있는 층이 선 없이 밑바탕과 갈린다`, () => {
    const t = tokens(theme);
    const raw = (name) => { const v = resolve(t, t[name]); assert.ok(v, `${theme}: --${name} = ${t[name]}`); return v; };
    const bg = raw('bg'), card = over(raw('surface'), bg), main = over(raw('t-main-bg'), bg), lane = over(raw('sunk'), bg);
    const d = {
      card: okL(card) - okL(bg),                               // 캔버스 위 카드(모듈·설정 카드·표·목록 카드형 줄)
      nested: okL(over(raw('lift'), card)) - okL(card),         // 카드 안 카드(현황 카드·거래처 칸)
      button: okL(over(raw('lift'), bg)) - okL(bg),             // 캔버스 위 버튼·입력(--lift)
      panelCard: okL(over(raw('surface'), main)) - okL(main),   // 본문 판(panel·pill·window 셸) 위 카드
      laneCard: okL(over(raw('surface'), lane)) - okL(lane),    // 칸반 칸 위 카드
      lane: okL(lane) - okL(bg),                                // 칸반 칸
      float: okL(raw('float')) - okL(bg),                       // 메뉴·모달
    };
    const weak = Object.entries(d).filter(([k, v]) => Math.abs(v) < EDGE_MIN[k] && !(k === 'float' && mode === 'light')).map(([k, v]) => `${k} ${v.toFixed(3)}`);
    assert.deepEqual(weak, [], '라이트의 떠 있는 층은 그림자(--shadow-float)가 가른다');
    // 다크는 떠 있는 것이 밝다(유건: "다크 모드는 카드가 바탕보다 살짝 밝게")
    if (mode === 'dark') for (const k of ['card', 'nested', 'button', 'panelCard', 'laneCard', 'float']) assert.ok(d[k] > 0, `${k} ${d[k].toFixed(3)}`);
  });
}

// 이유(10/1): 카드·버튼의 외곽선이 돌아오면 면 구분 규칙이 흐려진다 — 버튼은 --lift, 카드는 선 없이. 예외는 바탕이 투명한 테두리형(float 셸 버튼·추가 타일)뿐
test('카드·버튼에 외곽선(1px 테두리·테두리 그림자)이 없다', () => {
  const screen = ['../src/base.css', '../src/business/business.css', '../src/views/views.css', '../src/pages/perf.css', '../src/pages/module-library.css'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const cards = ['.btn', '.module', '.set-card', '.table-wrap', '.stat-card', '.list-row', '.ap-row', '.journal-entry', '.rec-row', '.vw-card', '.deal-card', '.mkt-card', '.mkt-summary', '.card-fields', '.card-empty', '.perf-goal', '.history-preview', '.tpl-item', '.private-block', '.modal', '.menu', '.palette', '.login-card', '.seg-btn.on', '.bizui-line', '.bizui-order-line'];
  for (const { sel, decl } of rulesOf(screen)) {
    if (!sel.split(',').some((x) => cards.includes(x.trim().replace(/:hover$/, '')))) continue;
    assert.doesNotMatch(decl, /(?:inset\s+)?0 0 0 1(?:\.5)?px|border:\s*1px solid/, `${sel.slice(0, 60)} → ${decl.trim().slice(0, 80)}`);
  }
  for (const k of ['t-card-edge', 't-tile-edge']) for (const m of strip(css).matchAll(new RegExp(`--${k}:\\s*([^;]+);`, 'g'))) assert.doesNotMatch(m[1], /0 0 0 1px/, `--${k}: ${m[1]}`);
});

/* ── 새 셸(유건 10/1): 리퀴드 글래스(liquid)·뉴모피즘(neu) ── */
// 그 셸의 토큰 — 색 토큰 위에 셸 블록(:root[data-shell='x'], 다크면 [data-theme$='-dark'] 블록)과 어두운 사이드바 보정을 얹는다. @media 안(투명도 줄이기 등)은 뺀다
function shellTokens(theme, shell) {
  const t = tokens(theme), dark = theme.endsWith('-dark'), fam = theme.replace(/-(light|dark)$/, '');
  for (const r of rulesOf(css)) {
    if (r.nested) continue;
    const sel = r.sel.trim();
    const mine = sel === `:root[data-shell='${shell}']` || sel === `:root[data-shell='${shell}'][data-theme]` || (dark && sel === `:root[data-shell='${shell}'][data-theme$='-dark']`);
    const fix = sel.startsWith(':root:is([data-shell=') && sel.includes(`'${shell}'`) && sel.includes(`[data-theme^='${fam}']`);
    if (mine || fix) for (const d of r.decl.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) t[d[1]] = d[2].trim();
  }
  return t;
}

test('새 셸 두 개와 새 색 여섯 개: 목록·짝 셸(plain)·견본·묶음', () => {
  for (const sh of ['liquid', 'neu']) assert.ok(SHELLS.includes(sh), sh);
  for (const f of ['sage', 'ocean', 'rose', 'lavender', 'slate', 'ember']) assert.equal(SHELL_OF[f], 'plain', f);
  // 이유(유건 10/1 "색 원 13개가 깔끔하게 — 필요하면 중성·따뜻함·차가움으로 묶음"): 묶음에 빠지거나 두 번 나오는 색이 없어야 한다
  assert.deepEqual(COLOR_GROUPS.flatMap(([, f]) => f).sort(), [...FAMILIES].sort());
  for (const f of FAMILIES) assert.equal(SWATCH[f]?.length, 3, `견본 ${f}`);
  const dict = readFileSync(new URL('../src/pages/custom-i18n.js', import.meta.url), 'utf8');
  for (const [g] of COLOR_GROUPS) assert.match(dict, new RegExp(`'colorgroup\\.${g}': \\['[^']*[가-힣][^']*', '[^가-힣']+'\\]`), g);
});

// 이유(유건 10/1 "레퍼런스 수준의 진짜 유리"): 흐림은 사파리·데스크톱 웹뷰를 위해 -webkit-와 함께. 흐림을 틀(.shell·.main·.content·.module·.side)에 직접 주면
// 그 안의 position:fixed 층(.vw-selbar·.vw-band·.drop-hint.page·.nav-scrim)이 화면 대신 그 틀을 기준으로 놓인다 — 틀은 ::before에만 준다(본문 위에 뜨는 포털 층은 직접 줘도 된다).
test('리퀴드 글래스: 흐림은 -webkit-와 함께, 틀에는 ::before에만, 투명도 줄이기는 불투명', () => {
  let n = 0;
  for (const r of rulesOf(css)) {
    if (!/(^|[^-])backdrop-filter\s*:/.test(r.decl)) continue;
    n++;
    assert.match(r.decl, /-webkit-backdrop-filter\s*:/, `-webkit- 없음: ${r.sel.slice(0, 80)}`);
    for (const one of r.sel.split(/,(?![^()]*\))/)) {
      const last = one.trim().split(/\s+(?![^()]*\))/).at(-1);
      if (!last.endsWith('::before')) assert.doesNotMatch(last, /\.(shell|main|content|module|side|grid|page-wrap)\b/, `틀에 직접 흐림: ${one.trim()}`);
    }
  }
  assert.ok(n >= 2, '흐림 규칙');
  const rt = css.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(rt, '투명도 줄이기 대체');
  assert.match(rt[1], /--t-lq-blur:\s*none/);
  for (const k of ['t-lq-win', 't-lq-side', 't-lq-card', 't-lq-card-hi', 't-lq-chip', 't-lq-pop']) assert.match(rt[1], new RegExp(`--${k}:\\s*var\\(--(bg|float|surface|card)\\)`), k);
});

// 이유(유건 10/1 "글자 대비 4.5:1 유지 — 흐린 배경 위 최악 경우 기준"): 유리는 뒤가 비친다. 뒤에 깔리는 큰 면은 바탕과 빛 덩어리(색 가족의 색) 셋이다 —
// 빛 덩어리 한가운데 위 창 유리, 그 위 카드·작은 칸·선택 알약·떠 있는 층, 사이드바 유리 위 메뉴 글자, 토스트까지 모든 색 × 라이트·다크로 잰다.
// (버튼처럼 작은 면은 흐림 반경보다 작아 뒤에서는 주변 색과 섞여 보인다 — 큰 면만 최악 경우로 본다)
for (const fam of FAMILIES) for (const mode of ['light', 'dark']) {
  const theme = `${fam}-${mode}`;
  test(`리퀴드 글래스 대비 4.5:1 — ${theme}`, () => {
    const t = shellTokens(theme, 'liquid');
    const raw = (n) => { const v = resolve(t, t[n]); assert.ok(v, `${theme}: --${n} = ${t[n]}`); return v; };
    const bg = raw('bg'), bad = [];
    const backs = { bg, ...Object.fromEntries(['t-glow-1', 't-glow-2', 't-glow-3'].map((g) => [g, over(raw(g), bg)])) };
    for (const [where, back] of Object.entries(backs)) {
      const win = over(raw('t-lq-win'), back), card = over(raw('t-lq-card'), win);
      const layers = { window: win, card, chip: over(raw('t-lq-chip'), card), pill: over(raw('t-lq-pill'), win), pop: over(raw('t-lq-pop'), win), 'pop on card': over(raw('t-lq-pop'), card) };
      for (const [k, b] of Object.entries(layers)) for (const fg of ['fg', 'fg-2', 'fg-3']) bad.push([`${fg} on ${k} @${where}`, ratio(raw(fg), b)]);
      const side = over(raw('t-lq-side'), win);
      for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) bad.push([`${fg} on side @${where}`, ratio(raw(fg), side)]);
      bad.push([`side-fg on side-active @${where}`, ratio(raw('side-fg'), over(raw('side-active'), side))]);
      bad.push([`primary-fg on toast @${where}`, ratio(raw('primary-fg'), over(raw('t-lq-toast'), win))]);
    }
    assert.deepEqual(bad.filter(([, r]) => r < 4.5).map(([l, r]) => `${l} ${r.toFixed(2)}`), []);
  });
}

// 이유(유건 10/1 "바탕과 같은 색의 면이 빛과 그늘로 솟아오름, 다크는 밝은 그림자 아주 약하게"): 빛·그늘이 바탕과 구분되지 않으면 그냥 평평한 화면이 된다.
for (const fam of FAMILIES) for (const mode of ['light', 'dark']) {
  const theme = `${fam}-${mode}`;
  test(`뉴모피즘 빛·그늘 — ${theme}: 같은 색 면이 솟고 파인 게 보인다`, () => {
    const t = shellTokens(theme, 'neu');
    const raw = (n) => { const v = resolve(t, t[n]); assert.ok(v, `${theme}: --${n} = ${t[n]}`); return v; };
    const bg = okL(raw('bg')), hi = okL(raw('t-neu-hi')) - bg, lo = bg - okL(raw('t-neu-lo'));
    if (mode === 'light') { assert.ok(hi >= 0.01, `빛 ${hi.toFixed(3)}`); assert.ok(lo >= 0.07, `그늘 ${lo.toFixed(3)}`); }
    else { assert.ok(hi > 0 && hi <= 0.05, `다크 빛은 아주 약하게 ${hi.toFixed(3)}`); assert.ok(lo >= 0.04, `그늘 ${lo.toFixed(3)}`); }
    // 사이드바 글자 — 뉴모피즘 사이드바는 바탕과 같은 색이다
    for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) assert.ok(ratio(raw(fg), raw('bg')) >= 4.5, `${fg} on bg`);
  });
}

test('뉴모피즘: 카드·버튼은 솟고, 활성 탭·선택 항목·입력칸·켜진 토글은 파이고, 외곽선 없이, 초점 링은 강조색', () => {
  const neu = rulesOf(css).filter((r) => r.sel.includes("[data-shell='neu']"));
  const declOf = (cls) => neu.filter((r) => r.sel.split(/,(?![^()]*\))/).some((x) => x.includes(cls))).map((r) => r.decl).join(';');
  for (const c of ['.module', '.set-card', '.btn', '.side', '.menu']) assert.match(declOf(c), /var\(--t-neu-(up|up-sm|pop)\)/, `솟음: ${c}`);
  for (const c of ['.tab.on', '.nav-item.active', '.seg-btn.on', '.input', "input[role='switch']", '.rec-row.on']) assert.match(declOf(c), /var\(--t-neu-in(-sm)?\)/, `파임: ${c}`);
  assert.match(css, /--t-neu-in:\s*inset/); assert.match(css, /--t-neu-in-sm:\s*inset/);
  for (const r of neu) assert.doesNotMatch(r.decl, /0 0 0 1px|border:\s*1px solid/, r.sel.slice(0, 60));
  assert.match(declOf('[data-theme]'), /--ring:\s*var\(--primary\)/);
});
