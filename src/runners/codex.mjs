// Codex 러너 — 격리 홈·CLI 자동 조달·샌드박스/추론 강도 인자·auth 반입/회수·턴 config.
// (runners.mjs 관심사 분리 2026-07-28)

import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, exists } from './shared.mjs';

/** Argo 전용 CODEX_HOME — 사용자 전역 config(커스텀 에이전트·모델 핀)와 격리하고 auth만 빌린다.
    (전역 config의 spawn_agent 커스텀 스키마가 신형 모델의 예약 도구와 충돌하는 사례 확인) */
async function codexHome() {
  const dir = join(homedir(), '.argo', 'codex-home');
  await mkdir(dir, { recursive: true, mode: 0o700 }); // 턴 홈(mkdtemp·0700)과 같은 등급 — 여기엔 auth.json 심링크가 산다
  if (!(await exists(join(dir, 'auth.json')))) {
    await symlink(join(homedir(), '.codex', 'auth.json'), join(dir, 'auth.json')).catch(() => {});
  }
  if (!(await exists(join(dir, 'config.toml')))) {
    await writeFile(join(dir, 'config.toml'), '# Argo 격리 codex 설정 — 계정 기본값 사용\n', { mode: 0o600 }).catch(() => {});
  }
  return dir;
}

/* ─── Codex CLI 자동 조달 — gemini와 같은 원리, 배포처만 다르다 ───
   npm 래퍼(@openai/codex)의 플랫폼 바이너리 패키지는 공개 레지스트리 packument가 404라(실측)
   레지스트리 경로가 못 쓰인다. 정본 배포처는 GitHub 릴리스의 플랫폼별 단일 바이너리 타르볼
   (rust-v* 태그, 실측: codex-aarch64-apple-darwin.tar.gz → 압축 해제 후 --version 부팅 확인). */
const CODEX_TOOL_DIR = join(homedir(), '.argo', 'tools', 'codex-cli');
const CODEX_BIN = process.platform === 'win32' ? 'codex.exe' : 'codex';
const codexManagedBin = () => join(CODEX_TOOL_DIR, CODEX_BIN);
/** 플랫폼 → 릴리스 자산 이름. 래퍼 bin/codex.js의 트리플 표와 동일 매핑. */
function codexAssetName() {
  const triple = {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
  }[`${process.platform}-${process.arch}`];
  if (!triple) return null;
  return process.platform === 'win32' ? `codex-${triple}.exe.tar.gz` : `codex-${triple}.tar.gz`;
}
let codexProvisioning = null; // 단일 비행 — ~100MB 다운로드 중복 방지

export async function provisionCodexCli() {
  if (await exists(codexManagedBin())) return codexManagedBin();
  if (codexProvisioning) return codexProvisioning;
  codexProvisioning = (async () => {
    // 파괴적 rm 전 재확인 — gemini와 동일한 TOCTOU 방어(릴리스 검수 M-1). codex는 ~100MB라 낭비가 더 크다
    if (await exists(codexManagedBin())) return codexManagedBin();
    const asset = codexAssetName();
    if (!asset) throw new Error(`미지원 플랫폼: ${process.platform}/${process.arch}`);
    const tmp = await mkdtemp(join(tmpdir(), 'argo-codex-cli-'));
    try {
      // latest/download 리다이렉트 — API 레이트리밋·JSON 파싱 없이 항상 최신
      const url = `https://github.com/openai/codex/releases/latest/download/${asset}`;
      const buf = await fetch(url, { signal: AbortSignal.timeout(300_000) }).then((r) => {
        if (!r.ok) throw new Error(`바이너리 다운로드 실패 ${r.status}`);
        return r.arrayBuffer();
      });
      const tar = join(tmp, 'codex.tgz');
      await writeFile(tar, Buffer.from(buf));
      await exec('tar', ['-xzf', tar, '-C', tmp]);
      // 타르볼 안 파일명 = 자산명에서 .tar.gz만 뗀 것(실측) — 표준 이름(codex)으로 채택
      const inner = join(tmp, asset.replace(/\.tar\.gz$/, ''));
      const src = (await exists(inner)) ? inner : join(tmp, CODEX_BIN); // 미래 이름 변경 대비 폴백
      if (process.platform !== 'win32') await exec('chmod', ['+x', src]);
      const v = (await exec(src, ['--version'], { timeout: 30_000 })).stdout.trim();
      if (!v) throw new Error('내려받은 Codex CLI가 부팅하지 않습니다');
      await rm(CODEX_TOOL_DIR, { recursive: true, force: true });
      await mkdir(CODEX_TOOL_DIR, { recursive: true });
      await rename(src, codexManagedBin()).catch(async (e) => {
        if (e?.code !== 'EXDEV') throw e; // 크로스 디바이스 rename 불가 폴백
        await copyFile(src, codexManagedBin());
        if (process.platform !== 'win32') await exec('chmod', ['+x', codexManagedBin()]);
      });
      return codexManagedBin();
    } finally {
      codexProvisioning = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return codexProvisioning;
}

/** codex 실행 커맨드 해석 — PATH 설치본 > 관리본 > 즉석 조달(첫 회 ~100MB, 연결 시 워밍업이 선다운로드). */
async function codexCmd() {
  const onPath = await exec('codex', ['--version']).then(() => true, () => false);
  if (onPath) return { file: 'codex', args: [] };
  if (await exists(codexManagedBin())) return { file: codexManagedBin(), args: [] };
  try {
    return { file: await provisionCodexCli(), args: [] };
  } catch (e) {
    throw new Error(`Codex 실행기를 준비하지 못했습니다(네트워크 확인 후 재시도): ${String(e.message || e)}`);
  }
}

// codexSandboxArgs(능력→샌드박스 매핑)는 삭제됐다 — 유건 지시 2026-08-21 "샌드박스 없이":
// codex를 `--sandbox danger-full-access`로 돌리므로 writable_roots/network_access 오버라이드가
// 무의미해졌다. 역사: 2026-07-22 "/" 전체 개방 크리티컬 → 홈 한정으로 좁힘 → 그 홈 한정이
// "사용 권한이 없다" 차단(윈도우 쓰기 전멸 클러스터 포함)의 뿌리가 되어 지시로 되돌림.
// 프로세스 수준 방어가 사라졌음을 알고 유지한다 — 남는 방어는 프롬프트 금지 지시(2차)뿐이고,
// SDK 러너는 무관(canUseTool 게이트가 하드 차단).

/** 크루별 추론 강도 → codex CLI 인자(순수). codex도 강도를 지원한다 — `-c model_reasoning_effort=…`가
    인식되는 키임을 실측(2026-07-26, codex-cli 0.144.1: 미인식 키는 --strict-config에서 즉시 에러,
    이 키는 통과하고 low·high·xhigh 모두 실턴 성공). 'max'는 Claude 전용 명칭이라 xhigh로 사상한다.
    빈 값·미지원 값이면 인자를 넣지 않는다(모델 기본). (export: 회귀 테스트용 — 순수 함수) */
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
export function codexEffortArgs(effort) {
  const v = String(effort ?? '').trim().toLowerCase();
  const mapped = v === 'max' ? 'xhigh' : v;
  return CODEX_EFFORTS.includes(mapped) ? ['-c', `model_reasoning_effort=${mapped}`] : [];
}

/** 턴 전용 CODEX_HOME에 베이스의 auth.json을 반입한다 — 심링크 우선, 실패하면 **복사 폴백**.
    심링크는 Windows에서 권한(개발자 모드·관리자)이 없으면 EPERM으로 실패하는데, 예전엔 그 실패를
    조용히 삼켜 auth.json 없는 홈으로 실행 → codex가 401("Missing bearer or basic authentication
    in header")로 죽었다. OAuth를 정상 연결한 신규 설치 사용자가 크루 영입을 전혀 못 하던 신고
    (2026-07-26)의 근본 원인이다. 반환 handle을 턴 뒤 recoverCodexAuth에 넘겨 갱신 토큰을 회수한다.
    베이스 홈에 자격 파일이 없는 경우(호스트 미로그인 등)는 mode:'none'이 정상이다 — 던지지 않는다.
    (과거 'clean'+env키 모드 언급은 폐기 — codex CLI가 env 키를 안 읽어 apikey도 auth.json 경유다.) */
export async function importCodexAuth(baseHome, turnHome) {
  const src = join(baseHome, 'auth.json');
  const dst = join(turnHome, 'auth.json');
  try {
    await symlink(src, dst);
    return { mode: 'link', src, dst };
  } catch {
    try {
      await copyFile(src, dst);
      return { mode: 'copy', src, dst };
    } catch {
      return { mode: 'none', src, dst };
    }
  }
}

/** 복사 모드에서 CLI가 갱신한 토큰을 베이스로 되돌린다(임시 홈은 곧 삭제되므로 여기서만 회수 가능).
    심링크 모드는 원본을 직접 쓰므로 불필요. 실패는 무해 — 다음 턴이 기존 토큰으로 시작하고
    만료 시 재로그인 안내가 정상 경로로 나온다. 되돌렸으면 true. */
export async function recoverCodexAuth(handle) {
  if (handle?.mode !== 'copy') return false;
  const [a, b] = await Promise.all([stat(handle.dst).catch(() => null), stat(handle.src).catch(() => null)]);
  if (!a || !b || !(a.mtimeMs > b.mtimeMs)) return false;
  await copyFile(handle.dst, handle.src);
  return true;
}

/** 이 명령이 실제로 실행 가능한가 — codex config.toml에 못 도는 MCP를 실으면 턴 전체가 죽는다.
    절대/상대 경로는 파일 존재로, 이름만 있으면 PATH를 훑는다(윈도우는 PATHEXT 확장자까지). */
export function commandExists(cmd, env = process.env) {
  if (!cmd || typeof cmd !== 'string') return false;
  const c = cmd.trim();
  if (!c) return false;
  // '' 먼저 — 이름에 확장자가 이미 있거나(node.exe) 확장자 없는 실행 파일을 그대로 잡는다.
  // 이게 빠져 있어 Windows CI에서 전 케이스가 실패했다(자가 발견 2026-08-19): 확장자를 덧붙이기만
  // 하면 `node.exe` → `node.exe.EXE`를 찾게 되고, 게이트가 **모든 MCP를 조용히 제외**한다.
  const exts = process.platform === 'win32'
    ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  const hit = (base) => exts.some((e) => { try { return statSync(base + e).isFile(); } catch { return false; } });
  if (c.includes('/') || c.includes('\\')) return hit(c);
  const dirs = (env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  return dirs.some((d) => hit(join(d, c)));
}

export async function writeCodexTurnConfig(home, mcpServers = null) {
  const lines = ['# Argo 관리 codex 설정 — 매 턴 MCP 목록에서 재생성됩니다.'];
  // [sandbox_workspace_write] 섹션은 더 쓰지 않는다 — danger-full-access 전환(위 codexSandboxArgs
  // 삭제 주석)으로 샌드박스 오버라이드가 무의미해졌다. 이 파일의 남은 역할은 MCP 주입뿐.
  // 회사 MCP를 codex에 주입 — 러너 중립성(유건 지시 2026-07-30·08-08 "러너 상관 없이 모두 똑같아야").
  // config.toml [mcp_servers.이름] 형태를 codex가 받는다(codex mcp add 실프로브 확인).
  //
  // **실행 가능한 것만 쓴다**(자가 발견 2026-08-19): 전엔 codex에 MCP가 아예 없어 항상 돌았는데,
  // 주입을 켜면 서버 하나의 command가 깨져 있어도 codex가 기동에 실패해 **턴 전체가 죽는다** —
  // 없던 실패 모드를 내가 만든 것이다. 있는 명령만 싣고 나머지는 조용히 빼는 대신 로그로 남긴다
  // (안내는 상위 프롬프트가 connectedMcp 목록으로 하므로 화면이 거짓이 되지는 않는다).
  if (mcpServers && typeof mcpServers === 'object') {
    const skipped = [];
    const taken = new Set(); // 살균 후 키 충돌 방어 — 'my.tool'과 'my tool'이 함께 오면 [mcp_servers.my_tool]이
    // 두 번 찍혀 TOML 파싱이 깨지고, 이 함수가 피하려던 "턴 전체 사망"이 그대로 재현된다(분리 검수 2026-08-19 LOW).
    const collided = [];
    for (const [name, def] of Object.entries(mcpServers)) {
      if (!def || typeof def !== 'object') continue;
      const key = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (taken.has(key)) { collided.push(name); continue; }
      taken.add(key);
      if (def.url && !def.command) { lines.push(`[mcp_servers.${key}]`, `url = ${JSON.stringify(def.url)}`); continue; }
      if (typeof def.command !== 'string' || !def.command.trim() || !commandExists(def.command)) { skipped.push(name); continue; }
      lines.push(`[mcp_servers.${key}]`);
      lines.push(`command = ${JSON.stringify(def.command)}`);
      if (Array.isArray(def.args) && def.args.length) lines.push(`args = [${def.args.map((a) => JSON.stringify(String(a))).join(', ')}]`);
      if (def.env && typeof def.env === 'object') {
        lines.push(`[mcp_servers.${key}.env]`);
        for (const [k, v] of Object.entries(def.env)) lines.push(`${k} = ${JSON.stringify(String(v))}`);
      }
    }
    if (skipped.length) console.warn(`[argo] codex MCP 제외(실행 파일 없음): ${skipped.join(', ')}`);
    if (collided.length) console.warn(`[argo] codex MCP 제외(이름 충돌 — 살균 후 같은 키): ${collided.join(', ')}`);
  }
  // 0600 — 이 파일에는 MCP 서버의 env 토큰이 평문으로 실린다. mcp.json을 0600으로 쓰는 것과 같은 근거
  // (PR #258)인데 codex 쪽만 빠져 있어 같은 비밀이 더 느슨한 모드로 복제됐다(분리 검수 2026-08-19 MED-2).
  // ⚠ Windows는 POSIX 모드가 없어 이 방어가 적용되지 않는다(mcp.json과 같은 한계).
  await writeFile(join(home, 'config.toml'), lines.join('\n') + '\n', { mode: 0o600 }).catch(() => { /* 실패해도 -c 폴백이 있다 */ });
}

export { codexHome, codexManagedBin, codexCmd }; // 러너 모듈 내부 공용(facade 미노출 — externalExec·detectRunners가 쓴다)
