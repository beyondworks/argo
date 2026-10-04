// 읽기 화면(src/ui/DocView.jsx)을 노드에서 그려 보는 도구 — DocView와 React를 한 덩어리로 묶어(esbuild) 그 안의 React로 그린다.
// DocView가 아이콘·사전·css를 들여오게 된 뒤(16차) 파일 하나만 바꿔 읽는 방식으로는 그릴 수 없어서 묶는다. css·글꼴은 빈 파일로.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

let cached = null;
/** → render(doc, { strip }) : 공개 화면처럼 article.prose 안에 그린 HTML. strip이면 공개 링크처럼 비공개·파일 블록을 먼저 뺀다(core/public-doc.js) */
export async function loadDocView() {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'office-docview-'));
  try {
    const out = join(dir, 'docview.mjs');
    buildSync({
      stdin: { contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { DocView } from './ui/DocView.jsx'; import { stripPublic } from './core/public-doc.js';
        export const render = (doc, { strip = false, wrap = true } = {}) => { const view = createElement(DocView, { doc: strip ? stripPublic(doc) : doc }); return renderToStaticMarkup(wrap ? createElement('article', { className: 'public-body prose' }, view) : view); };`,
      resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)), loader: 'jsx' },
      bundle: true, format: 'esm', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env': '{}' },
      loader: { '.css': 'empty', '.woff2': 'empty', '.js': 'jsx' },
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, // react-dom/server가 node 내장 모듈을 require한다
    });
    cached = (await import(pathToFileURL(out).href)).render;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return cached;
}
