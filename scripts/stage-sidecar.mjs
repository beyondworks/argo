#!/usr/bin/env node
// 사이드카 스테이징 — tauri build 전에 실행. Next standalone 서버 + Node 런타임을
// src-tauri/ 아래로 복사해 번들에 내장할 준비를 한다(둘 다 gitignore — 빌드 산출물).
//   - src-tauri/binaries/node-<target-triple>   : Tauri 사이드카(externalBin)
//   - src-tauri/resources/server/               : standalone 서버 트리(resources)
// 사용: node scripts/stage-sidecar.mjs   (npm run build:standalone 이후, 또는 자체 빌드 포함)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAURI = join(ROOT, 'src-tauri');

// 1) target triple (사이드카 파일명 규약) — rustc -vV host
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n').find((l) => l.startsWith('host:')).split(' ')[1].trim();

// 2) Next standalone 빌드(없으면) — ARGO_STANDALONE=1
const standalone = join(ROOT, '.next', 'standalone');
if (!existsSync(join(standalone, 'server.js'))) {
  console.log('[stage] standalone 빌드…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ARGO_STANDALONE: '1' } });
}
// standalone엔 정적 자산이 안 들어오므로 직접 복사(Next 권장 절차)
cpSync(join(ROOT, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
cpSync(join(ROOT, 'public'), join(standalone, 'public'), { recursive: true });

// 3) server 리소스로 복사
const serverDest = join(TAURI, 'resources', 'server');
rmSync(serverDest, { recursive: true, force: true });
mkdirSync(dirname(serverDest), { recursive: true });
cpSync(standalone, serverDest, { recursive: true });

// 4) node 런타임을 사이드카로 복사
const binDir = join(TAURI, 'binaries');
mkdirSync(binDir, { recursive: true });
copyFileSync(process.execPath, join(binDir, `node-${triple}`));

console.log(`[stage] 완료 — triple=${triple}, server=${serverDest}, node=binaries/node-${triple}`);
