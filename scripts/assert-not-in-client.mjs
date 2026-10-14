#!/usr/bin/env node
// 클라이언트 번들 유출 검사 — 서버 전용 값(환경변수 이름으로 받는다)이 브라우저로 가는 파일(.next/static 등)에 그대로 들어 있으면 실패한다.
// 사용: node scripts/assert-not-in-client.mjs <폴더> [환경변수 이름 …]   (이름 기본: src/server-baked-env.mjs BAKED_ENV_NAMES)
// 값이 비어 있으면 그 이름은 건너뛴다(시크릿 없는 빌드). 출력은 이름과 파일 경로뿐 — 값은 내지 않는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BAKED_ENV_NAMES } from '../src/server-baked-env.mjs';

export function findInDir(dir, needle) {
  const hits = [];
  const buf = Buffer.from(needle);
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size > 0 && readFileSync(p).includes(buf)) hits.push(p);
    }
  })(dir);
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('assert-not-in-client.mjs')) {
  const [dir, ...names] = process.argv.slice(2);
  if (!dir) { console.error('사용: node scripts/assert-not-in-client.mjs <폴더> [환경변수 이름 …]'); process.exit(2); }
  let bad = 0; let checked = 0;
  for (const n of names.length ? names : BAKED_ENV_NAMES) {
    const v = process.env[n]?.trim();
    if (!v) { console.log(`[assert-not-in-client] ${n}: 값 없음 — 건너뜀`); continue; }
    checked++;
    const hits = findInDir(dir, v);
    if (hits.length) { bad++; console.error(`[assert-not-in-client] ${n}의 값이 클라이언트 파일에 있습니다 — 배포 차단:\n${hits.join('\n')}`); }
    else console.log(`[assert-not-in-client] ${n}: ${dir}에 없음`);
  }
  if (bad) process.exit(1);
  console.log(`[assert-not-in-client] 통과(검사한 이름 ${checked}개)`);
}
