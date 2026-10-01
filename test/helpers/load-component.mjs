// 컴포넌트·진입 파일을 그대로 변환해(JSX) mini-react(test/helpers/mini-react.mjs) 위에서 돌릴 수 있게 불러온다.
// 번들러 없이: 파일 하나를 Babel(Next에 들어 있는 사본 — 루트에 esbuild가 없다)로 JSX만 바꾸고, import 이름을 바꿔 끼운다.
//  - 'react'·'react/jsx-runtime' → mini-react
//  - stubs: { 모듈 이름: 소스 문자열 } → data: 모듈(화면 부품·네트워크 같은 바깥 의존을 대신)
//  - real: [파일 경로] → 실제 파일(테스트가 직접 import한 것과 **같은 인스턴스**)
//  - define: { 'process.env.X': 'JS 식' } → 소스 치환
// 스텁도 real도 아닌 의존이 있으면 시끄럽게 실패한다(조용히 빠지는 배선이 없게).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/core');
const presetReact = require('next/dist/compiled/babel/preset-react');
const MINI = pathToFileURL(fileURLToPath(new URL('./mini-react.mjs', import.meta.url))).href;
const dataUrl = (src) => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;

export async function loadComponent(entry, { stubs = {}, real = [], define = {} } = {}) {
  const realAbs = new Set(real.map((p) => resolve(p)));
  let src = readFileSync(entry, 'utf8');
  for (const [k, v] of Object.entries(define)) src = src.split(k).join(v);
  const map = (spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime') return MINI;
    if (spec in stubs) return dataUrl(stubs[spec]);
    const abs = resolve(dirname(entry), spec);
    for (const r of realAbs) if (abs === r) return pathToFileURL(r).href;
    throw new Error(`스텁 없는 의존: ${spec} (from ${entry})`);
  };
  const rewrite = () => ({
    visitor: {
      'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(p) { if (p.node.source) p.node.source.value = map(p.node.source.value); },
      CallExpression(p) {
        const [arg] = p.node.arguments;
        if (p.node.callee.type === 'Import' && arg?.type === 'StringLiteral') arg.value = map(arg.value);
      },
    },
  });
  const out = babel.transformSync(src, {
    filename: entry, babelrc: false, configFile: false, sourceType: 'module',
    presets: [[presetReact, { runtime: 'automatic' }]], plugins: [rewrite],
  });
  return import(dataUrl(out.code));
}
