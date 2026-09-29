// 아르고 오피스 앱 아이콘 원본 생성기(유건 9/29 확정: 리넨 포스트잇 9장 + 연필 심볼). 출력 = src-tauri/icons/office/icon.svg
// 래스터(icns·png·ico·public/icon-*.png)는 Chrome으로 그린다 — 이 SVG는 mix-blend-mode·feDiffuseLighting을 써서 rsvg-convert로는 다르게 나온다.
// 아르고 오피스 로고 시안 4 — 시안 3 + 종이 질감·연필 심볼(유건 9/29)
// (시안 3 — 리넨 인쇄형(유건 9/29 선택). 포스트잇 9장이 아이콘을 꽉 채우고, 심볼은 메신저 앱과 같은 크기(원본 좌표 그대로).
// 바깥 모서리는 아이콘 곡률을 따라 잘리고, 9번째 장은 오른쪽 아래 모서리가 곡률 안쪽에서 말려 올라간다.
import { writeFileSync } from 'node:fs';
const out = new URL('../src-tauri/icons/office/', import.meta.url).pathname;
const SYMBOL = 'M477.057 628.072L440.789 770.352L404.561 628.224L262.241 591.804L404.408 555.423L440.789 413.256L477.209 555.575L619.337 591.804L477.057 628.072Z M787.403 551.11H785.64L511.548 481.243L440.789 204.737L370.106 480.947L95.9297 551.11H93.8965L348.011 111H533.288L787.403 551.11Z';
const NOTES = [ // 기울기(도)·어긋남(px)
  { r: -1.0, dx: -2, dy: 2 }, { r: 0.7, dx: 1, dy: -2 }, { r: -0.4, dx: 2, dy: 1 },
  { r: 0.9, dx: -3, dy: 0 }, { r: -0.5, dx: 0, dy: 1 }, { r: 1.2, dx: 2, dy: -2 },
  { r: -0.8, dx: -1, dy: 2 }, { r: 0.4, dx: 2, dy: 2 }, { r: -1.3, dx: 3, dy: 0 },
];
const M = 16, GAP = 14, CURL = 150; // 바깥 여백·간격·말린 모서리(아이콘 곡률 안쪽에 접힌 선이 오도록 크게)
const C = { bg: '#E9E6DF', noteTop: '#FFFEFA', note: '#F9F6EE', symbol: '#221F1C', flap: ['#E9E3D5', '#FFFFFC'], shadow: '#26241F' };

const s = (882 - M * 2 - GAP * 2) / 3;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function strokes(angle, step, [w0, w1], [a0, a1]) {
  const th = angle * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux, cx = 441, cy = 441, L = 620;
  const out = [];
  for (let d = -L; d <= L; d += step * (0.75 + rnd() * 0.5)) {
    let t = -L + rnd() * 30;
    while (t < L) {
      const len = 90 + rnd() * 380, t2 = Math.min(L, t + len);
      const p = (k) => [cx + nx * d + ux * k, cy + ny * d + uy * k];
      const [x1, y1] = p(t), [x2, y2] = p(t2), bend = (rnd() - 0.5) * 7, [mx, my] = p((t + t2) / 2);
      out.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}Q${(mx + nx * bend).toFixed(1)} ${(my + ny * bend).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke-width="${(w0 + rnd() * (w1 - w0)).toFixed(2)}" stroke-opacity="${(a0 + rnd() * (a1 - a0)).toFixed(2)}"/>`);
      t = t2 + 4 + rnd() * 26;
    }
  }
  return out.join('');
}
const PENCIL = strokes(-38, 3.8, [1.8, 3.2], [0.62, 0.95]) + strokes(-60, 6.5, [1.2, 2.0], [0.3, 0.55]);
const notes = NOTES.map((n, i) => {
  const x = M + (i % 3) * (s + GAP), y = M + Math.floor(i / 3) * (s + GAP), X = x + s, Y = y + s, c = CURL;
  const t = `translate(${n.dx} ${n.dy}) rotate(${n.r} ${x + s / 2} ${y + s / 2})`;
  const body = i === 8 ? `M${x} ${y}H${X}V${Y - c}L${X - c} ${Y}H${x}Z` : `M${x} ${y}H${X}V${Y}H${x}Z`;
  const flap = i === 8 ? `M${X} ${Y - c}Q${X - c * 0.3} ${Y - c * 0.74} ${X - c * 0.84} ${Y - c * 0.84}Q${X - c * 0.74} ${Y - c * 0.3} ${X - c} ${Y}Z` : null;
  const lifted = i === 8 ? `M${X} ${Y - c}L${X} ${Y}L${X - c} ${Y}Z` : null;
  return { t, body, flap, lifted };
});
const f = notes[8];
const svg = `<svg width="882" height="882" viewBox="0 0 882 882" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="882" height="882" rx="180" fill="${C.bg}"/>
<g clip-path="url(#icon)">
${notes.map((n) => `<path d="${n.body}" transform="${n.t}" fill="url(#note)" filter="url(#lift)"/>`).join('\n')}
<rect width="882" height="882" filter="url(#paper)" clip-path="url(#notes)" style="mix-blend-mode:multiply"/>
<g clip-path="url(#notes)" style="mix-blend-mode:multiply"><g filter="url(#pencil)"><g clip-path="url(#sym)"><path d="${SYMBOL}" fill="${C.symbol}" fill-opacity="0.3"/><g stroke="${C.symbol}" stroke-linecap="round" fill="none">${PENCIL}</g></g><path d="${SYMBOL}" stroke="${C.symbol}" stroke-opacity="0.75" stroke-width="2.4" stroke-linejoin="round" fill="none"/></g></g>
<path d="${f.lifted}" transform="${f.t}" fill="${C.shadow}" opacity="0.16" filter="url(#soft)"/>
<path d="${f.flap}" transform="${f.t}" fill="url(#flap)" filter="url(#curl)"/>
</g>
<defs>
<clipPath id="icon"><rect x="${M}" y="${M}" width="${882 - M * 2}" height="${882 - M * 2}" rx="${180 - M}"/></clipPath>
<clipPath id="notes">${notes.map((n) => `<path d="${n.body}" transform="${n.t}"/>`).join('')}</clipPath>
<linearGradient id="note" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.noteTop}"/><stop offset="1" stop-color="${C.note}"/></linearGradient>
<clipPath id="sym"><path d="${SYMBOL}"/></clipPath>
<filter id="pencil" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="4" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" result="rough"/>
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="9" result="g"/>
<feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -2.2 0 0 0 1.95" result="tooth"/>
<feComposite in="rough" in2="tooth" operator="in"/>
</filter>
<filter id="paper" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="2" result="grain"/>
<feDiffuseLighting in="grain" surfaceScale="1.2" lighting-color="#ffffff" result="lit"><feDistantLight azimuth="235" elevation="58"/></feDiffuseLighting>
<feTurbulence type="fractalNoise" baseFrequency="0.012 0.35" numOctaves="2" seed="5" result="fiber"/>
<feColorMatrix in="fiber" type="matrix" values="0 0 0 0 0.62  0 0 0 0 0.58  0 0 0 0 0.5  -0.4 0 0 0 0.14" result="fibers"/>
<feColorMatrix in="lit" type="matrix" values="0.12 0 0 0 0.9  0 0.12 0 0 0.895  0 0 0.12 0 0.885  0 0 0 0 1" result="tone"/>
<feComposite in="fibers" in2="tone" operator="over"/>
</filter>
<linearGradient id="flap" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.flap[0]}"/><stop offset="1" stop-color="${C.flap[1]}"/></linearGradient>
<filter id="lift" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="${C.shadow}" flood-opacity="0.2"/></filter>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
<filter id="curl" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB"><feDropShadow dx="-4" dy="-4" stdDeviation="6" flood-color="${C.shadow}" flood-opacity="0.26"/></filter>
</defs>
</svg>
`;
writeFileSync(`${out}icon.svg`, svg);
console.log(`${out}icon.svg`);
