#!/usr/bin/env node
// 셀프호스트 서버 타르볼 스테이징 — CLI 설치 트랙(배포 전략 2026-07-20)의 빌드 산출물.
// stage-sidecar.mjs와 같은 조립 절차(standalone + static/public + SDK 네이티브 + 시크릿 스캔)를
// 따르되, Tauri 리소스 대신 dist-server/argo-server-<버전>-<플랫폼>.tar.gz 를 만든다.
// ⚠ 절차를 바꾸면 stage-sidecar.mjs도 함께 — 두 스크립트는 같은 서버 트리 계약을 공유한다.
//   의도된 비대칭 하나(2026-08-21): sidecar 쪽의 Dock 아이콘 방지 심(server.js 세터 무력화)은
//   여기 적용하지 않는다 — 이 타르볼은 리눅스 systemd 경로(install.sh)라 Dock이 없고, 맥에서
//   수동 `node server.js`로 띄우는 경우만 아이콘이 남는다(수용).
// Supabase env 없이 빌드하면 로컬 모드(무인증 단일 사용자) 서버가 된다 — 셀프호스트 1차 기본.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const PLATFORM = `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;

// 1) Next standalone 빌드(없으면)
const standalone = join(ROOT, '.next', 'standalone');
if (!existsSync(join(standalone, 'server.js'))) {
  console.log('[stage-server] standalone 빌드…');
  // ARGO_STANDALONE=1은 빌드 시 output:'standalone'을 켜는 스위치일 뿐(next.config.mjs) —
  // 런타임 동작(원클릭 게이트 등)은 실행 env가 결정하며 install.sh는 이 변수를 설정하지 않는다.
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ARGO_STANDALONE: '1' } });
}
cpSync(join(ROOT, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
cpSync(join(ROOT, 'public'), join(standalone, 'public'), { recursive: true });

// 2) dist-server/로 조립
const dist = join(ROOT, 'dist-server');
const tree = join(dist, 'argo-server');
rmSync(dist, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
cpSync(standalone, tree, { recursive: true });

// 3) Claude Agent SDK 네이티브 CLI 보장 — standalone 추적 누락 대비(stage-sidecar 3.4와 동일 근거)
{
  const scopeSrc = join(ROOT, 'node_modules', '@anthropic-ai');
  const scopeDest = join(tree, 'node_modules', '@anthropic-ai');
  rmSync(scopeDest, { recursive: true, force: true });
  cpSync(scopeSrc, scopeDest, { recursive: true });
  const native = readdirSync(scopeSrc).find((n) => n.startsWith('claude-agent-sdk-'));
  if (!native || !existsSync(join(scopeDest, native))) {
    console.error('[stage-server] SDK 플랫폼 CLI 패키지 없음 — 크루 턴이 전부 실패한다. npm ci 상태 확인');
    process.exit(1);
  }
  console.log(`[stage-server] SDK 네이티브 CLI 포함: ${native} (타르볼은 이 플랫폼 전용)`);
}

// 4) 시크릿·개발자 데이터 제거 + 유출 가드(stage-sidecar 3.5와 동일 — 배포 차단이 최우선)
// 내부 문서·규약은 제품이 아니다 — 실사고 2026-08-19: 고객 맥의 코딩 에이전트가 번들 안
// docs/의 QA 백로그를 읽어 내부 지표(제보자·사용자 규모)를 그대로 보고했다. 게다가
// security-encryption-roadmap(미암호화 목록)·runner-isolation-limits(격리 구멍)는 공격 지도다.
// 런타임은 docs/를 읽지 않는다(확인) — LICENSE.md만 남긴다(법적 고지).
const INTERNAL = ['docs', 'CLAUDE.md', 'AGENTS.md', 'PRODUCT-SPEC.md'];
// 셀프호스트 타르볼만의 예외 — docs/selfhost.md는 설치·보안 기본값 안내서라 **사용자향**이다.
// docs를 통째로 지우면 이것까지 사라진다(자가 발견 2026-08-19: 내부 문서 제거의 부수 피해).
const KEEP = [['docs', 'selfhost.md']];
for (const junk of ['workspaces', '.next/cache', '.device-id', ...INTERNAL]) {
  rmSync(join(tree, junk), { recursive: true, force: true });
}
for (const seg of KEEP) {
  const src = join(ROOT, ...seg);
  if (existsSync(src)) { mkdirSync(join(tree, seg[0]), { recursive: true }); cpSync(src, join(tree, ...seg)); }
}
// 제거가 조용히 실패하면(경로 변경 등) 다음 릴리스가 내부 문서를 다시 싣는다 — 배포를 막는다.
for (const f of INTERNAL.filter((x) => x !== 'docs')) {
  if (existsSync(join(tree, f))) { console.error(`[stage-server] 내부 문서 잔존 — 배포 차단: ${f}`); process.exit(1); }
}
{
  const left = existsSync(join(tree, 'docs')) ? readdirSync(join(tree, 'docs')) : [];
  const extra = left.filter((n) => n !== 'selfhost.md');
  if (extra.length) { console.error('[stage-server] 내부 문서 잔존 — 배포 차단: docs/' + extra.join(', docs/')); process.exit(1); }
}
const leaks = [];
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
    if (/(^|\.)((account-)?secrets(-[\w-]+)?|sync-credentials|connections|mcp)\.json$/.test(e.name) || /\.env(\..+)?$/.test(e.name)) leaks.push(p);
  }
})(tree);
if (leaks.length) { console.error('[stage-server] 시크릿 파일 잔존 — 배포 차단:\n' + leaks.join('\n')); process.exit(1); }

// 5) 타르볼 — 최상위 디렉터리 argo-server/ 로 통일(install.sh가 이 이름을 전제)
const tarName = `argo-server-${VERSION}-${PLATFORM}.tar.gz`;
execFileSync('tar', ['-czf', join(dist, tarName), '-C', dist, 'argo-server'], { stdio: 'inherit' });
console.log(`[stage-server] 완료 — dist-server/${tarName} (시크릿 스캔 통과)`);
