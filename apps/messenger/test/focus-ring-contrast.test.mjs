// 초점 링 대비(D34) — 테마마다 본문·레일·카드 바탕 모두 3:1 이상(WCAG 1.4.11). 바탕 색은 ego 실측값(픽스처, 2026-09-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const L = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const focusOf = (sel) => { const m = css.match(new RegExp(`${sel.replace(/[[\]'().]/g, '\\$&')}[^{]*\\{ --msgr-focus: (#[0-9a-f]{6}); \\}`)); assert.ok(m, sel); return hex(m[1]); };
const BG = { // 본문·레일·카드
  light: { argo: [[245, 240, 227], [245, 240, 227], [252, 250, 242]], linen: [[233, 230, 223], [31, 30, 27], [251, 250, 247]], graphite: [[250, 250, 250], [240, 240, 240], [255, 255, 255]] },
  dark: { argo: [[28, 24, 19], [28, 24, 19], [38, 33, 26]], linen: [[31, 30, 27], [23, 22, 20], [42, 41, 38]], graphite: [[32, 32, 32], [29, 29, 29], [37, 37, 37]] },
};

test('테마별 --msgr-focus는 세 바탕 모두 3:1 이상', () => {
  for (const fam of ['argo', 'linen', 'graphite']) {
    for (const [mode, sel] of [['light', `:root[data-theme='${fam}-light']`], ['dark', `:root[data-theme='${fam}-dark']`]]) {
      const c = focusOf(sel);
      for (const bg of BG[mode][fam]) assert.ok(ratio(c, bg) >= 3, `${sel} vs ${bg}: ${ratio(c, bg).toFixed(2)}`);
    }
  }
});

test('메신저 초점 링은 모두 --msgr-focus — 반투명 --ring을 쓰지 않고, 전역 :focus-visible도 덮는다', () => {
  assert.doesNotMatch(css, /var\(--ring\)/);
  assert.match(css, /\.argo-messenger :focus-visible \{ outline-color: var\(--msgr-focus\); \}/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme\]\) \{ --msgr-focus: #c6a052; \}/, '테마 미지정 + OS 어둡게');
});
