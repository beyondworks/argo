// 테마 토큰 생성 — 정본을 손으로 옮겨 적지 않는다(한쪽만 고쳐지는 사고 방지).
// linen = 메신저 apps/messenger/design/tokens.css, graphite = 본체 app/globals.css. 오피스는 이 둘만 쓴다.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = new URL('../../../', import.meta.url);
const linen = readFileSync(new URL('apps/messenger/design/tokens.css', root), 'utf8');
const globals = readFileSync(new URL('app/globals.css', root), 'utf8');

// 선언부만 남긴다(주석·규칙 밖 내용 제거) — 토큰(--x)과 color-scheme 줄만.
const decls = (body) => body.replace(/\/\*[\s\S]*?\*\//g, '').split(';').map((s) => s.trim())
  .filter((s) => s.startsWith('--') || s.startsWith('color-scheme')).map((s) => `  ${s};`).join('\n');

export function graphiteBlocks(css) {
  const re = /:root\[data-theme='(graphite(?:-light|-dark)?)'\]\s*\{([^{}]*)\}/g;
  const mediaAt = css.indexOf("@media (prefers-color-scheme: dark) {\n  :root[data-theme='graphite']");
  const out = {};
  for (const m of css.matchAll(re)) {
    const key = m[1] === 'graphite' && mediaAt >= 0 && m.index > mediaAt && !out.auto ? 'auto' : m[1];
    if (!out[key]) out[key] = decls(m[2]);
  }
  for (const k of ['graphite', 'auto', 'graphite-light', 'graphite-dark']) if (!out[k]) throw new Error(`graphite 블록 없음: ${k}`);
  return out;
}

export function build() {
const g = graphiteBlocks(globals);
const css = `/* 생성 파일 — 직접 고치지 말 것. npm run tokens (scripts/gen-tokens.mjs) */
${linen.replace(/@font-face[^}]*\}\n?/, '')}
:root[data-theme='graphite'], :root[data-theme='graphite-light'] {
${g.graphite}
}
@media (prefers-color-scheme: dark) {
  :root[data-theme='graphite'] {
${g.auto}
  }
}
:root[data-theme='graphite-dark'] {
${g['graphite-dark']}
}
`;
return css;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../src/tokens.css', import.meta.url), build());
  console.log('tokens.css 생성');
}
