// 아이콘 = Google Material Symbols(유건 10/2 "구글 아이콘팩으로 통일") — 코드가 부르는 아이콘 이름이 전부 글꼴에 있고,
// 글자표(Icon.jsx)·이름표(icon-names.js)·글꼴(symbols.woff2)이 서로 맞는지 잠근다. 빠진 이름은 화면에 빈 칸으로만 보여 눈으로 놓치기 쉽다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { MATERIAL } from '../src/ui/icon-names.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const walk = (d, re = /\.(m?js|jsx)$/) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p, re) : re.test(f) ? [p] : []; });
const files = walk(SRC).map((p) => ({ p: p.slice(SRC.length), s: readFileSync(p, 'utf8') }));

// 식에서 '결과'로 쓰이는 글자 상수만 — 비교 대상('task' === …)은 빼고 삼항 가지·객체 값·식 처음만 줍는다
const results = (expr) => [...expr.matchAll(/(?:^|[?:]\s*)'([\w]+)'/g)].map((m) => m[1]);
const braced = (s, i) => { let d = 0; for (let j = i; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) return s.slice(i + 1, j); } return ''; };

function usedNames() {
  const icon = new Map(), ficon = new Map();
  const add = (m, name, where) => { if (!m.has(name)) m.set(name, where); };
  for (const { p, s } of files) {
    if (p === 'ui/icon-names.js') continue;
    for (const m of s.matchAll(/<(F?Icon)\b[^>]*?\bname=(?:"(\w+)"|\{)/g)) {
      const into = m[1] === 'FIcon' ? ficon : icon;
      if (m[2]) add(into, m[2], p);
      else for (const n of results(braced(s, m.index + m[0].length - 1).trim())) add(into, n, p);
    }
    for (const m of s.matchAll(/\bicon="(\w+)"/g)) add(icon, m[1], p); // <NavItem icon="…"> · <Lock icon="…">
    for (const m of s.matchAll(/\bicon:\s*([^,}\n]+)/g)) for (const n of results(m[1].trim())) add(icon, n, p);
    for (const m of s.matchAll(/(?:\b(?:NAV_ICON|BUSINESS_ICONS|KIND_ICON|ICON)|const icon)\s*=\s*\{([^}]*)\}/g)) for (const n of results(m[1].replace(/,/g, ', :'))) add(icon, n, p);
  }
  return { icon, ficon };
}

// 같은 글자에 이름이 둘인 경우(codepoints 파일에 둘 다 e66d) — 글꼴에는 한 이름만 남는다
const ALIAS = { note: 'draft' };
// Drive.jsx의 ICON.mydrive는 Icon으로 가지 않고 FIcon('drive', 상표 그림)으로 그린다
const NOT_ICON = new Set(['drive']);

const glyphs = () => {
  const block = /<glyphs>\n([\s\S]*?)\n\s*\/\/ <\/glyphs>/.exec(readFileSync(join(SRC, 'ui/Icon.jsx'), 'utf8'));
  assert.ok(block, 'Icon.jsx에 // <glyphs> 표가 있어야 한다');
  return Object.fromEntries([...block[1].matchAll(/^\s*'?(\w+)'?: '\\u([0-9a-f]{4,5})',$/gm)].map((m) => [m[1], parseInt(m[2], 16)]));
};

test('코드가 부르는 아이콘 이름은 전부 아이콘 표(Material 이름)에 있다', () => {
  const { icon } = usedNames();
  assert.ok(icon.size >= 40, `찾은 이름이 너무 적다(${icon.size}) — 수집 정규식이 깨졌을 수 있다`);
  for (const must of ['home', 'plus', 'dots', 'chevron', 'gear', 'star', 'stamp', 'sign', 'hand', 'box']) assert.ok(icon.has(must), `수집 누락: ${must}`);
  const missing = [...icon].filter(([n]) => !(n in MATERIAL) && !NOT_ICON.has(n)).map(([n, p]) => `${n} (${p})`);
  assert.deepEqual(missing, [], '아이콘 표에 없는 이름 — src/ui/icon-names.js에 Material 이름을 더하고 scripts/icon-font.mjs를 다시 돌린다');
});

test('문서함 FIcon이 부르는 이름도 Material 아이콘으로 이어진다(Drive 상표만 그림)', () => {
  const { ficon } = usedNames();
  const map = /const NAME = \{([^}]*)\}/.exec(readFileSync(join(SRC, 'files/FIcon.jsx'), 'utf8'))[1];
  const names = Object.fromEntries([...map.matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
  for (const target of Object.values(names)) assert.ok(target in MATERIAL, `FIcon → ${target}`);
  for (const [n, p] of ficon) assert.ok(n === 'drive' || n in names, `FIcon 이름 ${n} (${p})`);
});

test('글자표(Icon.jsx) = 이름표(icon-names.js), 글꼴의 그 자리 글자 이름이 Material 이름과 같다', () => {
  const g = glyphs();
  assert.deepEqual(Object.keys(g).sort(), Object.keys(MATERIAL).sort(), 'Icon.jsx 글자표가 이름표와 다르다 — scripts/icon-font.mjs를 다시 돌린다');
  const font = fontkit.create(readFileSync(join(SRC, 'ui/symbols.woff2')));
  for (const [k, cp] of Object.entries(g)) {
    assert.ok(cp >= 0xe000 && cp <= 0xf8ff, `${k}: 사설 영역 밖 코드포인트`);
    const glyph = font.glyphForCodePoint(cp);
    assert.ok(glyph.id > 0, `${k}: 글꼴에 글자가 없다`);
    assert.equal(ALIAS[glyph.name] ?? glyph.name, MATERIAL[k], `${k}: 글꼴 글자 이름`);
  }
});

test('글꼴은 Outlined · wght 400 · GRAD 0 · opsz 20으로 고정, 채우기(FILL)만 0~1로 남긴다', () => {
  const font = fontkit.create(readFileSync(join(SRC, 'ui/symbols.woff2')));
  assert.deepEqual(Object.keys(font.variationAxes), ['FILL']);
  assert.equal(font.variationAxes.FILL.default, 0);
  assert.equal(font.variationAxes.FILL.max, 1);
  assert.match(font.familyName, /Material Symbols Outlined/);
});

test('아이콘 글꼴은 번들 파일로 싣는다 — 구글 글꼴 서버를 부르지 않고, 옛 SVG 선택자가 남지 않는다', () => {
  const css = readFileSync(join(SRC, 'base.css'), 'utf8');
  assert.match(css, /@font-face \{ font-family: 'Argo Symbols';[^}]*font-display: block;[^}]*url\('\.\/ui\/symbols\.woff2'\)/);
  const ico = /\n\.ico \{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const d of ["font-family: 'Argo Symbols'", 'width: 1em', 'height: 1em', 'line-height: 1', 'overflow: hidden']) assert.ok(ico.includes(d), `.ico에 ${d}`);
  const all = walk(SRC, /\.css$/).map((p) => readFileSync(p, 'utf8')).join('\n') + readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(all, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(all, /\.ico path|\.ico \{ fill|> svg \{/, '아이콘은 이제 글자다 — svg·path 선택자는 듣지 않는다');
});
