// 테마 = 앱 셸 × 색상 — 목록·첫 페인트·예전 테마 이어받기·사전·글자 대비를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, FAMILIES, EMUL, SHELLS, SHELL_OF } from '../src/core/theme.js';

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
    assert.match(s, /^:root(:is\(\[data-(shell|theme)|\[data-(shell|theme))/, `범위 밖 선택자: ${s.slice(0, 90)}`);
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
    for (const n of [1, 2, 3, 4, 5, 6]) for (const ink of ['tile-ink-2', 'tile-ink-3']) on(ink, `tile-${n}`);
    // 상태 글자: 반투명 배지 배경을 카드 위에 올린 색 위에서
    for (const base of ['card', 'surface', 'bg']) for (const k of ['ok', 'warn', 'danger']) pairs.push([`${k}/${k}-soft on ${base}`, ratio(c(k), over(c(`${k}-soft`), c(base)))]);
    pairs.push(['fg on mark(배지 글자)', ratio(c('fg'), c('mark'))]);
    const bad = pairs.filter(([l, r]) => r < 4.5 && !l.startsWith('fg on mark'));
    assert.deepEqual(bad.map(([l, r]) => `${l} ${r.toFixed(2)}`), []);
  });
}

// 이유: 사이드바가 창 바탕에 녹는 셸(panel·pill·glass)은 사이드바 글자를 창 바탕(--bg) 위에 그린다.
// 보정 목록(linen·cream처럼 어두운 사이드바)에 없는 색은 사이드바 글자가 --bg 위에서도 읽혀야 한다.
test('녹는 사이드바 셸: 보정하지 않는 색은 사이드바 글자가 --bg 위에서도 4.5:1', () => {
  const fix = css.match(/:root:is\(\[data-shell='panel'\], \[data-shell='pill'\], \[data-shell='glass'\]\):is\(([^)]*)\) \{/)[1];
  for (const fam of NEW) for (const mode of ['light', 'dark']) {
    const t = tokens(`${fam}-${mode}`);
    if (fix.includes(`'${fam}'`)) continue;
    for (const fg of ['side-fg', 'side-fg-2', 'side-fg-3']) {
      const r = ratio(rgba(t[fg]), rgba(t.bg));
      assert.ok(r >= 4.5, `${fam}-${mode}: --${fg} ${t[fg]} / --bg ${t.bg} = ${r.toFixed(2)} — 보정 목록에 넣어야 한다`);
    }
  }
  assert.ok(fix.includes(`'linen'`));
});
