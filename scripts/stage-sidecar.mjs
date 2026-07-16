#!/usr/bin/env node
// 사이드카 스테이징 — tauri build 전에 실행. Next standalone 서버 + Node 런타임을
// src-tauri/ 아래로 복사해 번들에 내장할 준비를 한다(둘 다 gitignore — 빌드 산출물).
//   - src-tauri/binaries/node-<target-triple>   : Tauri 사이드카(externalBin)
//   - src-tauri/resources/server/               : standalone 서버 트리(resources)
// 사용: node scripts/stage-sidecar.mjs   (npm run build:standalone 이후, 또는 자체 빌드 포함)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
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
  // Windows: npm은 npm.cmd라 shell 없이는 spawn ENOENT (v0.1.0 CI 실측)
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ARGO_STANDALONE: '1' } });
}
// standalone엔 정적 자산이 안 들어오므로 직접 복사(Next 권장 절차)
cpSync(join(ROOT, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
cpSync(join(ROOT, 'public'), join(standalone, 'public'), { recursive: true });

// 3) server 리소스로 복사
const serverDest = join(TAURI, 'resources', 'server');
rmSync(serverDest, { recursive: true, force: true });
mkdirSync(dirname(serverDest), { recursive: true });
cpSync(standalone, serverDest, { recursive: true });

// 3.4) Claude Agent SDK 네이티브 CLI 보장 — 플랫폼 패키지(claude-agent-sdk-<os>-<arch>)는 동적 로드라
// standalone 추적에서 누락된다(실측: Windows에서 "Native CLI binary for win32-x64 not found"로 크루 턴 전멸).
// 실제 node_modules의 @anthropic-ai 스코프를 통째로 덮어쓴다 — 각 빌드 러너 OS가 자기 플랫폼 패키지를 가진다.
{
  const scopeSrc = join(ROOT, 'node_modules', '@anthropic-ai');
  const scopeDest = join(serverDest, 'node_modules', '@anthropic-ai');
  rmSync(scopeDest, { recursive: true, force: true });
  cpSync(scopeSrc, scopeDest, { recursive: true });
  const native = readdirSync(scopeSrc).find((n) => n.startsWith('claude-agent-sdk-'));
  if (!native || !existsSync(join(scopeDest, native))) {
    console.error('[stage] Claude Agent SDK 플랫폼 CLI 패키지 없음 — 크루 턴이 전부 실패한다. npm ci 상태 확인');
    process.exit(1);
  }
  console.log(`[stage] SDK 네이티브 CLI 포함: ${native}`);
}

// 3.5) 시크릿·개발자 데이터·런타임 잔재 제거 (배포 아티팩트 유출 차단 — 가장 중요)
//   standalone/사본에 workspaces(회사 데이터·봇 토큰·.secrets.json)나 캐시가 섞여 들어오면
//   설치본 압축해제로 누구나 추출 가능. 여기서 물리적으로 지운다.
for (const junk of ['workspaces', '.next/cache', '.device-id']) {
  rmSync(join(serverDest, junk), { recursive: true, force: true });
}
// 안전 가드 — 시크릿류 파일이 하나라도 남으면 스테이징 실패(배포 차단)
const leaks = [];
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
    if (/^(connections\.json|\.secrets\.json)$/.test(e.name) || e.name.endsWith('.env') || e.name.endsWith('.env.local')) leaks.push(p);
  }
})(serverDest);
if (leaks.length) { console.error('[stage] 시크릿 파일 잔존 — 배포 차단:\n' + leaks.join('\n')); process.exit(1); }

// 4) node 런타임을 사이드카로 복사 — Windows는 .exe 확장자 필수(Tauri가 node-<triple>.exe를 찾는다)
const binDir = join(TAURI, 'binaries');
mkdirSync(binDir, { recursive: true });
const nodeExt = process.platform === 'win32' ? '.exe' : '';
copyFileSync(process.execPath, join(binDir, `node-${triple}${nodeExt}`));

console.log(`[stage] 완료 — triple=${triple}, server=${serverDest}, node=binaries/node-${triple}${nodeExt} (시크릿 스캔 통과)`);
