// 빌드 전 에셋 검사 — 코드가 참조하는 /assets 파일이 public에 없으면 빌드를 멈춘다(npm prebuild).
// 2026-09-25~29 운영 사고: webp·mp4가 없는 사본에서 배포되어 히어로·도판·데모가 전부 404였다.
// 어떤 경로(로컬 CLI·Git 연동)로 배포하든 빠진 에셋이 있으면 운영에 올라가기 전에 실패하게 한다.
// ponytail: 고정 문자열만 확인할 수 있다 — 템플릿(`${}`)으로 만든 /assets 경로는 확인할 수 없어 실패로 알린다.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIRS = ['app', 'components', 'lib'];
// 확장자가 있는 문자열·url() 참조만 본다 — 주석 속 폴더 경로(/assets/hero/seq 등)는 대상이 아니다
const REF = /['"`(](\/assets\/[^'"`\s()$?#]+\.[a-z0-9]{2,5})(?:[?#][^'"`\s)]*)?['"`)]/gi;
const DYNAMIC = /`[^`]*\/assets\/[^`]*\$\{/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(jsx?|mjs|tsx?|css)$/.test(name)) yield p;
  }
}

const refs = new Map();
const dynamic = [];
for (const d of SRC_DIRS) {
  const dir = join(root, d);
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(root.length + 1);
    for (const [, ref] of src.matchAll(REF)) if (!refs.has(ref)) refs.set(ref, rel);
    if (DYNAMIC.test(src)) dynamic.push(rel);
    DYNAMIC.lastIndex = 0;
  }
}
const missing = [...refs].filter(([ref]) => !existsSync(join(root, 'public', decodeURI(ref))));

if (missing.length || dynamic.length) {
  if (missing.length) {
    console.error(`[check-assets] public에 없는 에셋 ${missing.length}/${refs.size}개 — 빌드를 멈춥니다:`);
    for (const [ref, file] of missing) console.error(`  ${ref}  (${file})`);
  }
  for (const file of dynamic) {
    console.error(`[check-assets] ${file}: 템플릿으로 만든 /assets 경로는 확인할 수 없습니다 — 고정 문자열로 적어 주세요.`);
  }
  process.exit(1);
}
console.log(`[check-assets] 참조 에셋 ${refs.size}개 모두 있음`);
