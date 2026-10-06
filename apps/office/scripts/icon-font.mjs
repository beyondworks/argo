#!/usr/bin/env node
// 아이콘 글꼴 다시 만들기 — Google Material Symbols Outlined(Apache 2.0)에서 앱이 쓰는 글자만 뽑는다.
// 설정(유건 10/2 화면): Outlined · FILL 0(별 켜짐용으로 0~1만 남김) · wght 400 · GRAD 0 · opsz 20(앱 아이콘이 12~20px라 가장 가까운 광학 크기).
// 쓰는 법(fonttools 필요 — brew install fonttools):
//   curl -LO 'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.woff2'
//   curl -LO 'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints'
//   node scripts/icon-font.mjs <받은 .woff2> <받은 .codepoints>
// 결과: src/ui/symbols.woff2(글꼴) + src/ui/Icon.jsx의 글자표(GLYPHS) 갱신. 새 아이콘은 src/ui/icon-names.js에 한 줄 더하고 다시 돌린다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MATERIAL } from '../src/ui/icon-names.js';

const [font, cpFile] = process.argv.slice(2);
if (!font || !cpFile) { console.error('사용법: node scripts/icon-font.mjs <MaterialSymbolsOutlined.woff2> <….codepoints>'); process.exit(1); }
const cps = Object.fromEntries(readFileSync(cpFile, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/)));
const missing = Object.values(MATERIAL).filter((n) => !cps[n]);
if (missing.length) { console.error('Material Symbols에 없는 이름:', missing.join(', ')); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'argo-icons-'));
try {
  const inst = join(dir, 'inst.ttf'), out = new URL('../src/ui/symbols.woff2', import.meta.url).pathname;
  execFileSync('fonttools', ['varLib.instancer', font, 'FILL=0:1', 'wght=400', 'GRAD=0', 'opsz=20', '-o', inst], { stdio: 'inherit' });
  const unicodes = [...new Set(Object.values(MATERIAL).map((n) => `U+${cps[n]}`))].join(',');
  // 합자(GSUB)는 버린다 — 글자는 코드포인트로만 찍어서, 글꼴을 못 읽어도 'home' 같은 낱말이 화면에 새지 않는다
  execFileSync('pyftsubset', [inst, `--unicodes=${unicodes}`, '--layout-features=', '--flavor=woff2', '--glyph-names', '--no-hinting', '--desubroutinize', `--output-file=${out}`], { stdio: 'inherit' });
  const lines = Object.entries(MATERIAL).map(([k, n]) => `  ${/^[a-z]\w*$/i.test(k) ? k : `'${k}'`}: '\\u${cps[n]}',`).join('\n');
  const file = new URL('../src/ui/Icon.jsx', import.meta.url);
  const src = readFileSync(file, 'utf8');
  const next = src.replace(/(\/\/ <glyphs>)[\s\S]*?(\n\s*\/\/ <\/glyphs>)/, `$1\n${lines}$2`);
  if (!src.includes('// <glyphs>')) throw new Error('Icon.jsx에서 // <glyphs> 표시를 못 찾았다');
  writeFileSync(file, next);
  console.log(`글꼴 ${readFileSync(out).length} B · 글자 ${Object.keys(MATERIAL).length}개`);
} finally { rmSync(dir, { recursive: true, force: true }); }
