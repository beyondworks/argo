// 레퍼런스 테마 다섯 가족(cream·sand·peach·mist·glow) — 목록·첫 페인트·사전·글자 대비를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, FAMILIES, EMUL } from '../src/core/theme.js';

const css = readFileSync(new URL('../src/themes.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/core/i18n.js', import.meta.url), 'utf8');
const NEW = ['cream', 'sand', 'peach', 'mist', 'glow'];
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
// 중첩(@media) 안의 규칙까지 모두 — [{ sel, decl }]
function rulesOf(src) {
  const out = []; const stack = []; let buf = '';
  for (const ch of strip(src)) {
    if (ch === '{') { const pre = buf.trim(); stack.push(pre.startsWith('@') ? null : { sel: pre, decl: '' }); buf = ''; continue; }
    if (ch === '}') { const top = stack.pop(); if (top) out.push({ sel: top.sel, decl: buf }); buf = ''; continue; }
    buf += ch;
  }
  return out;
}

// 이유: 이름이 한 곳에만 있으면 첫 페인트 스크립트가 모르는 테마로 보고 기본 테마로 깜빡인다.
test('테마 목록: 일곱 가족 × (시스템·라이트·다크), 첫 페인트 정규식이 모두 받는다', () => {
  assert.equal(THEMES.length, FAMILIES.length * 3);
  for (const f of NEW) for (const s of ['', '-light', '-dark']) assert.ok(THEMES.includes(f + s), f + s);
  const re = new RegExp(html.match(/if \(\/(\^\(linen\|graphite[^/]*)\/\.test\(v\)\)/)[1]);
  for (const th of THEMES) assert.match(th, re, th);
  assert.doesNotMatch('cream-mid', re);
  const emul = new RegExp(html.match(/if \(\/(\^\(linen\|cream[^/]*)\/\.test\(th\)/)[1]);
  assert.deepEqual(THEMES.filter((th) => emul.test(th)), EMUL, '첫 페인트의 dark-emul 대상과 theme.js의 EMUL이 같아야 한다');
});

test('테마 이름: 모든 테마가 ko·en 사전에 있다', () => {
  for (const th of THEMES) {
    const m = i18n.match(new RegExp(`'theme\\.${th}': \\['([^']+)', '([^']+)'\\]`));
    assert.ok(m, `theme.${th} 사전 항목 없음`);
    assert.match(m[1], /[가-힣]/, `theme.${th} ko`);
    assert.doesNotMatch(m[2], /[가-힣]/, `theme.${th} en`);
  }
});

// 이유: linen·graphite 화면은 한 픽셀도 바뀌면 안 된다 — 모든 규칙이 새 가족의 data-theme 아래에만 있어야 한다.
test('themes.css: 모든 규칙이 새 다섯 가족의 data-theme 아래에만 있다', () => {
  const rules = rulesOf(css).map((r) => r.sel);
  assert.ok(rules.length > 100);
  for (const sel of rules) for (const one of sel.split(/,(?![^()]*\))/)) {
    const s = one.trim();
    if (/^\.mini\[data-pv\]|^\[data-pv=/.test(s)) continue; // 설정 화면 미리보기 — data-pv 값으로 가족을 고른다
    assert.match(s, /^:root(:is\(|\[data-theme)/, `범위 밖 선택자: ${s.slice(0, 90)}`);
    assert.doesNotMatch(s, /linen|graphite/, s.slice(0, 90));
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
function tokens(theme) {
  const isAuto = !/-(light|dark)$/.test(theme);
  const dark = theme.endsWith('-dark');
  const out = {};
  for (const r of rulesOf(css)) {
    const sel = r.sel;
    const fam = theme.replace(/-(light|dark)$/, '');
    // 모양 블록(@family)과, 이 테마의 색 블록만 읽는다
    const shape = sel.trim() === `:root[data-theme^='${fam}']`;
    const color = dark
      ? sel.includes(`[data-theme='${fam}-dark']`)
      : sel.includes(`[data-theme='${fam}-light']`) || (isAuto && sel.includes(`[data-theme='${fam}']`) && !sel.includes('dark-emul'));
    if (!shape && !color) continue;
    for (const d of r.decl.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}
const rgba = (v) => {
  const h = v.match(/^#([0-9a-f]{6})$/i);
  if (h) return { r: parseInt(h[1].slice(0, 2), 16), g: parseInt(h[1].slice(2, 4), 16), b: parseInt(h[1].slice(4), 16), a: 1 };
  const r = v.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/);
  return r ? { r: +r[1], g: +r[2], b: +r[3], a: r[4] === undefined ? 1 : +r[4] } : null;
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const fam of NEW) for (const mode of ['light', 'dark']) {
  const theme = `${fam}-${mode}`;
  test(`대비 4.5:1 — ${theme}`, () => {
    const t = tokens(theme);
    const c = (name) => { const v = rgba(t[name] ?? ''); assert.ok(v, `${theme}: --${name} = ${t[name]}`); return v; };
    const pairs = [];
    const on = (fg, bg, label = `${fg}/${bg}`) => pairs.push([label, ratio(c(fg), c(bg))]);
    for (const bg of ['bg', 'card', 'surface']) for (const fg of ['fg', 'fg-2', 'fg-3']) on(fg, bg);
    on('primary-fg', 'primary'); on('mark-fg', 'mark');
    for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) on(fg, 'side-bg');
    pairs.push(['side-fg on side-active', ratio(c('side-fg'), over(c('side-active'), c('side-bg')))]); // 선택된 메뉴(반투명 배경은 사이드바 위에 올린 색)
    if (fam === 'cream') on('side-mark', 'side-bg'); // cream은 선택된 메뉴 글자가 side-mark 색
    for (const n of [1, 2, 3, 4, 5, 6]) for (const ink of ['tile-ink-2', 'tile-ink-3']) on(ink, `tile-${n}`);
    // 상태 글자: 반투명 배지 배경을 카드 위에 올린 색 위에서
    for (const base of ['card', 'surface', 'bg']) for (const k of ['ok', 'warn', 'danger']) pairs.push([`${k}/${k}-soft on ${base}`, ratio(c(k), over(c(`${k}-soft`), c(base)))]);
    pairs.push(['fg on mark(배지 글자)', ratio(c('fg'), c('mark'))]);
    const bad = pairs.filter(([l, r]) => r < 4.5 && !l.startsWith('fg on mark'));
    assert.deepEqual(bad.map(([l, r]) => `${l} ${r.toFixed(2)}`), []);
  });
}
