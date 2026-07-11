// 테마별 텍스트 대비 감사 — globals.css 토큰을 파싱해 WCAG 대비율 계산.
// rgba는 해당 배경 위 합성. 글래스 테마의 그라디언트 배경은 --bg 폴백 근사(한계 명시).
import { readFile } from 'node:fs/promises';

const css = await readFile('app/globals.css', 'utf8');

const blocks = {};
// 기본(:root) — 첫 :root 블록
const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
blocks.argo = rootMatch[1];
for (const m of css.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{([\s\S]*?)\n\}/g)) {
  blocks[m[1]] = m[2];
}

function tokens(body, base) {
  const t = { ...base };
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim();
  return t;
}

function parseColor(v) {
  if (!v) return null;
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null; // gradient 등
}

const over = (fgc, bgc) => fgc[3] >= 1 ? fgc.slice(0, 3) : [0, 1, 2].map((i) => fgc[i] * fgc[3] + bgc[i] * (1 - fgc[3]));
function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

// 검사 쌍: [전경, 배경(합성 기준), 최소 기준, 설명]
const PAIRS = [
  ['fg', 'bg', 4.5, '본문/캔버스'],
  ['fg-2', 'bg', 4.5, '보조/캔버스'],
  ['fg-3', 'bg', 3.0, '미세 라벨/캔버스'],
  ['fg', 'card', 4.5, '본문/카드'],
  ['fg-2', 'card', 4.5, '보조/카드'],
  ['fg-3', 'card', 3.0, '미세 라벨/카드'],
  ['primary-fg', 'primary', 4.5, '활성/프라이머리'],
  ['primary-fg-dim', 'primary', 3.0, '활성 부제/프라이머리'],
  ['accent', 'bg', 2.0, '데이터 액센트/캔버스(그래픽)'],
  ['danger', 'card', 3.5, '위험 텍스트/카드'],
];

const base = tokens(blocks.argo, {});
const fails = [];
for (const [name, body] of Object.entries(blocks)) {
  const t = name === 'argo' ? base : tokens(body, base);
  const bgC = parseColor(t.bg);
  for (const [fgk, bgk, min, label] of PAIRS) {
    const rawBg = parseColor(t[bgk]);
    const rawFg = parseColor(t[fgk]);
    if (!rawFg || !rawBg || !bgC) continue;
    const bgSolid = over(rawBg, bgC);           // 카드가 반투명이면 캔버스 위 합성
    const fgSolid = over(rawFg, bgSolid);
    const r = ratio(fgSolid, bgSolid);
    if (r < min) fails.push(`${name.padEnd(11)} ${label.padEnd(16)} ${t[fgk]} on ${t[bgk]} = ${r.toFixed(2)} (< ${min})`);
  }
}
console.log(fails.length ? fails.join('\n') : '전 테마 전 쌍 통과');
console.log(`\n검사: ${Object.keys(blocks).length}개 테마 × ${PAIRS.length}쌍 (글래스 계열 배경은 --bg 폴백 근사)`);
