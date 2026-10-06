#!/usr/bin/env node
// argo CLI 단독 설치 자산(맥·윈도우, 2026-10-06 유건 승인) — 앱 없이 `curl … | bash`(install.sh 맥 갈래)·`irm … | iex`(install.ps1)로 설치한다.
// 트리는 앱의 server 폴더와 같은 구조다(bin/argo.mjs, 윈도우 bin/busybox64u.exe — shell-backend.mjs가 argo.mjs 옆에서 busybox를 찾는다).
// node를 같이 담는다(빌드 러너의 고정 node 22) — 단독 설치 사용자는 node가 없을 수 있다. Claude Agent SDK 네이티브 CLI가 플랫폼별이라 자산도 플랫폼별이다.
// 사용: node scripts/stage-cli-dist.mjs <출력 폴더>   → argo-cli-<버전>-<플랫폼>.tar.gz(맥)·.zip(윈도우) + .sha256
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageCli } from './stage-cli.mjs';

/** 플랫폼 이름 — 설치 스크립트가 같은 이름으로 자산을 고른다(install.sh 맥 갈래·install.ps1). 지원하지 않으면 null. */
export function cliPlatform(platform = process.platform, arch = process.arch) {
  return ({ 'darwin-arm64': 'macos-arm64', 'darwin-x64': 'macos-x64', 'win32-x64': 'windows-x64' })[`${platform}-${arch}`] ?? null;
}
export const cliAssetName = (version, plat) => `argo-cli-${version}-${plat}.${plat.startsWith('windows') ? 'zip' : 'tar.gz'}`;

/** work/argo-cli → out(맥 tar.gz·윈도우 zip). 형식(머리 바이트)과 윈도우는 사용자 설치와 같은 Expand-Archive로 풀리는지까지 확인한다.
    test/install-ps1.test.mjs가 윈도우 CI에서 같은 함수로 자산을 만든다 — 발행 빌드에서만 도는 경로를 PR CI에서도 실행하려고. */
export function packCli(work, out, win = process.platform === 'win32') {
  const name = basename(out);
  // 윈도우는 시스템 tar.exe(bsdtar)를 절대 경로로 — CI의 bash 단계는 PATH 앞에 Git의 GNU tar가 있어, 'D:\…'를 원격 호스트로 읽거나
  // -a를 무시하고 이름만 .zip인 tar를 만든다(검수 #843 HIGH-1). bsdtar는 -a로 확장자에 맞춰 zip을 만든다.
  const tar = win ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, win ? ['-a', '-cf', out, '-C', work, 'argo-cli'] : ['-czf', out, '-C', work, 'argo-cli'], { stdio: 'inherit' });
  const magic = readFileSync(out).subarray(0, 4).toString('hex');
  if (win ? magic !== '504b0304' : !magic.startsWith('1f8b')) { throw new Error(`[stage-cli-dist] ${name}이 ${win ? 'zip' : 'gzip'}이 아닙니다(머리 ${magic})`); }
  if (win) { // 사용자 설치와 같은 방법(Expand-Archive)으로 풀리는지
    const probe = join(work, 'expand-probe');
    const r2 = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${out.replaceAll("'", "''")}' -DestinationPath '${probe.replaceAll("'", "''")}'`], { encoding: 'utf8' });
    if (r2.status !== 0 || !existsSync(join(probe, 'argo-cli', 'node.exe')) || !existsSync(join(probe, 'argo-cli', 'bin', 'argo.mjs'))) { throw new Error(`[stage-cli-dist] Expand-Archive로 풀리지 않습니다\n${r2.stdout}\n${r2.stderr}`); }
    rmSync(probe, { recursive: true, force: true });
  }
}

async function main(outDir) {
  const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  const plat = cliPlatform();
  if (!plat) { console.error(`[stage-cli-dist] 단독 CLI 자산을 만들지 않는 플랫폼입니다: ${process.platform}-${process.arch}`); process.exit(1); }
  const win = process.platform === 'win32';
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'argo-cli-dist-'));
  const tree = join(work, 'argo-cli');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'package.json'), `${JSON.stringify({ name: 'argo', version, private: true, type: 'module' }, null, 2)}\n`);
  // Claude Agent SDK 스코프 전체(플랫폼 네이티브 CLI 포함) — stage-server 3·stage-sidecar 3.4와 같은 근거
  const scopeSrc = join(ROOT, 'node_modules', '@anthropic-ai');
  cpSync(scopeSrc, join(tree, 'node_modules', '@anthropic-ai'), { recursive: true });
  const native = readdirSync(scopeSrc).find((n) => n.startsWith('claude-agent-sdk-'));
  if (!native) { console.error('[stage-cli-dist] SDK 플랫폼 CLI 패키지 없음 — 크루 턴이 전부 실패한다. npm ci 상태 확인'); process.exit(1); }
  const staged = stageCli({ root: ROOT, tree });
  if (!staged.publicConfig) console.warn('[stage-cli-dist] 공개 설정(ARGO_CLI_SUPABASE_*)이 없어 bin/argo-public.json을 만들지 않았습니다 — 로그인이 안 되는 자산입니다');
  if (win) {
    const { fetchBusybox } = await import('./fetch-busybox.mjs');
    await fetchBusybox(join(tree, 'bin'));
    copyFileSync(join(ROOT, 'vendor', 'busybox-w32-LICENSE'), join(tree, 'bin', 'busybox-w32-LICENSE'));
    copyFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), join(tree, 'THIRD-PARTY-NOTICES.md'));
  }
  const nodeName = win ? 'node.exe' : 'node';
  copyFileSync(process.execPath, join(tree, nodeName));
  if (!win) chmodSync(join(tree, nodeName), 0o755);
  // 담은 node로 실제로 실행되는지 — 빈 홈에서 `argo status`(앱 모드 아님)
  const home = join(work, 'home'); mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_CLI_HOME: join(home, '.argo'), ARGO_CLI_APP: '0' };
  const r = spawnSync(join(tree, nodeName), [join(tree, 'bin', 'argo.mjs'), 'status'], { cwd: home, env, encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) { console.error(`[stage-cli-dist] 적재한 트리에서 argo status 실패(${r.status})\n${r.stdout}\n${r.stderr}`); process.exit(1); }
  rmSync(home, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const name = cliAssetName(version, plat);
  const out = join(outDir, name);
  rmSync(out, { force: true });
  packCli(work, out, win);
  const sum = createHash('sha256').update(readFileSync(out)).digest('hex');
  writeFileSync(`${out}.sha256`, `${sum}  ${name}\n`);
  rmSync(work, { recursive: true, force: true });
  console.log(`[stage-cli-dist] ${name} sha256=${sum} (SDK ${native}, node ${process.version})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir) { console.error('사용: node scripts/stage-cli-dist.mjs <출력 폴더>'); process.exit(1); }
  if (existsSync(outDir) === false) mkdirSync(outDir, { recursive: true });
  await main(resolve(outDir));
}
