// 빌드 전 에셋 검사 — 코드가 참조하는 /assets 파일이 public에 없으면 빌드를 멈춘다.
// 2026-09-25~29 운영 사고: webp·mp4가 없는 사본에서 배포되어 히어로·도판·데모가 전부 404였다.
// 어떤 경로(로컬 CLI·Git 연동)로 배포하든 빠진 에셋이 있으면 운영에 올라가기 전에 실패하게 한다.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIRS = ['app', 'components', 'lib'];
// 확장자가 있는 문자열 리터럴만 본다 — 주석 속 폴더 경로(/assets/hero/seq 등)는 대상이 아니다
const REF = /['"`](\/assets\/[^'"`\s$]+\.(?:webp|png|jpe?g|gif|avif|svg|mp4|webm))['"`]/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(jsx?|mjs)$/.test(name)) yield p;
  }
}

export function findMissing(base = root) {
  const refs = new Map();
  for (const d of SRC_DIRS) {
    const dir = join(base, d);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      for (const [, ref] of readFileSync(file, 'utf8').matchAll(REF)) {
        if (!refs.has(ref)) refs.set(ref, file.slice(base.length + 1));
      }
    }
  }
  const missing = [...refs].filter(([ref]) => !existsSync(join(base, 'public', ref)));
  return { total: refs.size, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { total, missing } = findMissing();
  if (missing.length) {
    console.error(`[check-assets] public에 없는 에셋 ${missing.length}/${total}개 — 빌드를 멈춥니다:`);
    for (const [ref, file] of missing) console.error(`  ${ref}  (${file})`);
    process.exit(1);
  }
  console.log(`[check-assets] 참조 에셋 ${total}개 모두 있음`);
}
