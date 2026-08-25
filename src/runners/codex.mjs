// Codex 러너 — 격리 홈·CLI 자동 조달·샌드박스/추론 강도 인자·auth 반입/회수·턴 config.
// (runners.mjs 관심사 분리 2026-07-28)

import { readFile, copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const CODEX_HOST_BIN = process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
const codexManagedBin = () => join(CODEX_TOOL_DIR, CODEX_BIN);
const codexHostManagedBin = () => join(CODEX_TOOL_DIR, CODEX_HOST_BIN);
/** 조달 버전 핀 — `latest` 금지. code_mode_host 사고(2026-08-25): 미고정 latest가 벤더의 의미 변경
    (0.148+에서 host 없이는 도구 fail-closed)을 무통보로 전 사용자에게 실어 날랐다. 승격 절차:
    새 버전은 러너 계약 프로브(scripts/runner-contract-probe.mjs, 야간 CI) 통과 확인 후 이 상수만 올린다.
    (export: 회귀 테스트·계약 프로브용) */
export const CODEX_PIN = 'rust-v0.149.1';
export const codexAssetUrl = (asset) => `https://github.com/openai/codex/releases/download/${CODEX_PIN}/${asset}`;
/** 플랫폼 → 릴리스 자산 이름. 래퍼 bin/codex.js의 트리플 표와 동일 매핑. (export: 순수 — 회귀 테스트용) */
export function codexTripleFor(platform, arch) {
  return {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
  }[`${platform}-${arch}`] ?? null;
}
export const codexAssetNameFor = (platform, arch) => {
  const triple = codexTripleFor(platform, arch);
  return triple ? (platform === 'win32' ? `codex-${triple}.exe.tar.gz` : `codex-${triple}.tar.gz`) : null;
};
/** 형제 실행 파일 codex-code-mode-host의 릴리스 자산 — codex 0.147+가 도구 실행에 이 호스트를 스폰한다.
    없으면 0.147은 os error 2로 턴 사망, 0.148+는 도구만 조용히 잠긴다(fail-closed). 그래서 codex와
    **항상 함께** 조달한다. (export: 순수 — 회귀 테스트용) */
export const codexHostAssetNameFor = (platform, arch) => {
  const triple = codexTripleFor(platform, arch);
  return triple ? (platform === 'win32' ? `codex-code-mode-host-${triple}.exe.tar.gz` : `codex-code-mode-host-${triple}.tar.gz`) : null;
};
function codexAssetName() { return codexAssetNameFor(process.platform, process.arch); }
function codexHostAssetName() { return codexHostAssetNameFor(process.platform, process.arch); }
let codexProvisioning = null; // 단일 비행 — ~100MB 다운로드 중복 방지

/** 자산 하나 다운로드+해제 → tmp 안 실행 파일 경로. 파일명 = 자산명에서 .tar.gz만 뗀 것(실측). */
async function fetchCodexAsset(tmp, asset, fallbackName) {
  const buf = await fetch(codexAssetUrl(asset), { signal: AbortSignal.timeout(300_000) }).then((r) => {
    if (!r.ok) throw new Error(`바이너리 다운로드 실패 ${r.status} (${asset})`);
    return r.arrayBuffer();
  });
  const tar = join(tmp, `${asset}.tgz`);
  await writeFile(tar, Buffer.from(buf));
  await exec('tar', ['-xzf', tar, '-C', tmp]);
  const inner = join(tmp, asset.replace(/\.tar\.gz$/, ''));
  const src = (await exists(inner)) ? inner : join(tmp, fallbackName); // 미래 이름 변경 대비 폴백
  if (process.platform !== 'win32') await exec('chmod', ['+x', src]);
  return src;
}
async function adoptInto(dest, src) {
  await rename(src, dest).catch(async (e) => {
    if (e?.code !== 'EXDEV') throw e; // 크로스 디바이스 rename 불가 폴백
    await copyFile(src, dest);
    if (process.platform !== 'win32') await exec('chmod', ['+x', dest]);
  });
}

export async function provisionCodexCli({ force = false } = {}) {
  if (!force && await exists(codexManagedBin())) return codexManagedBin();
  if (codexProvisioning) return codexProvisioning;
  codexProvisioning = (async () => {
    // 파괴적 rm 전 재확인 — gemini와 동일한 TOCTOU 방어(릴리스 검수 M-1). codex는 ~100MB라 낭비가 더 크다
    if (!force && await exists(codexManagedBin())) return codexManagedBin();
    const asset = codexAssetName();
    const hostAsset = codexHostAssetName();
    if (!asset || !hostAsset) throw new Error(`미지원 플랫폼: ${process.platform}/${process.arch}`);
    const tmp = await mkdtemp(join(tmpdir(), 'argo-codex-cli-'));
    try {
      // codex와 형제 host를 **둘 다** 받고 검증이 끝난 뒤에만 기존 폴더를 교체한다 — 다운로드·검증
      // 실패 시 기존 설치본이 그대로 남는다(롤백 안전). 순서를 뒤집으면 실패가 곧 "설치본 소실"이 된다.
      const src = await fetchCodexAsset(tmp, asset, CODEX_BIN);
      const hostSrc = await fetchCodexAsset(tmp, hostAsset, CODEX_HOST_BIN);
      const v = (await exec(src, ['--version'], { timeout: 30_000 })).stdout.trim();
      if (!v) throw new Error('내려받은 Codex CLI가 부팅하지 않습니다');
      await rm(CODEX_TOOL_DIR, { recursive: true, force: true });
      await mkdir(CODEX_TOOL_DIR, { recursive: true });
      await adoptInto(codexManagedBin(), src);
      await adoptInto(codexHostManagedBin(), hostSrc);
      await writeFile(join(CODEX_TOOL_DIR, '.pin'), CODEX_PIN); // 승격 판정 스탬프 — codexCmd가 핀 불일치를 보고 재조달
      return codexManagedBin();
    } finally {
      codexProvisioning = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return codexProvisioning;
}

/** 업그레이드 보강 — v0.1.45 이전 관리본은 codex 단일 파일만 있다(host 부재 = 0.147 os error 2 /
    0.148+ 도구 잠김의 뿌리). 관리본을 쓸 때마다 host 부재를 감지해 host만 추가 조달한다.
    실패해도 턴은 계속(다음 사용 때 재시도) — 조달 불가 환경에서 턴까지 막지 않는다. */
let hostEnsuring = null;
async function ensureCodexHost() {
  if (await exists(codexHostManagedBin())) return true;
  if (hostEnsuring) return hostEnsuring;
  hostEnsuring = (async () => {
    const hostAsset = codexHostAssetName();
    if (!hostAsset) return false;
    const tmp = await mkdtemp(join(tmpdir(), 'argo-codex-host-'));
    try {
      const hostSrc = await fetchCodexAsset(tmp, hostAsset, CODEX_HOST_BIN);
      await adoptInto(codexHostManagedBin(), hostSrc);
      console.log('[argo] codex code-mode host 보강 조달 완료');
      return true;
    } catch (e) {
      console.warn('[argo] codex code-mode host 보강 조달 실패(다음 사용 때 재시도):', e?.message ?? e);
      return false;
    } finally {
      hostEnsuring = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return hostEnsuring;
}

/** 도구 잠김(L2 자가치유) 재조달 — 관리본을 핀 버전으로 강제 재설치. 1시간 스로틀(무한 재다운로드
    금지 — 유계 재시도 원칙). 반환: 실제로 재조달했으면 true. */
let lastReprovisionAt = 0;
export async function reprovisionCodexCli() {
  if (Date.now() - lastReprovisionAt < 60 * 60_000) return false;
  lastReprovisionAt = Date.now();
  await provisionCodexCli({ force: true });
  return true;
}

/** codex 실행 커맨드 해석 — **관리본(핀 버전) 우선**, PATH 설치본은 조달 실패 시 폴백.
    2026-08-25 반전: PATH 우선이던 시절엔 사용자 자체 설치 CLI의 자동 업데이트가 검증 없이 턴에
    유입됐다(code_mode_host 사고 계열). 로그인 자격은 HOME(~/.codex/auth.json) 공유라 어떤 버전으로
    로그인했든 관리본이 같은 자격을 읽는다. 첫 회 ~100MB는 연결 시 워밍업이 선다운로드. */
async function codexCmd() {
  // 이스케이프 해치 — 가짜 codex를 PATH에 꽂는 테스트 하네스·오프라인 환경 전용(관리본 우선을 끄면
  // 벤더 자동 업데이트 유입이 되살아나므로 일반 사용자용 설정으로 노출하지 않는다).
  if (process.env.ARGO_CODEX_PREFER_PATH === '1') {
    const onPath = await exec('codex', ['--version']).then(() => true, () => false);
    if (onPath) return { file: 'codex', args: [] };
  }
  if (await exists(codexManagedBin())) {
    // 핀 승격 — 스탬프(.pin)가 현재 핀과 다르면(구버전 관리본·v0.1.45 이전 무스탬프 포함) 핀 버전으로
    // 재조달한다. 실패하면 기존 관리본으로 턴은 계속(오프라인 방어) + host 보강만 시도.
    const stamp = await readFile(join(CODEX_TOOL_DIR, '.pin'), 'utf8').then((v) => v.trim(), () => '');
    if (stamp !== CODEX_PIN) {
      console.log(`[argo] codex 관리본 승격: ${stamp || '(무스탬프)'} → ${CODEX_PIN}`);
      await provisionCodexCli({ force: true }).catch(async (e) => {
        console.warn('[argo] codex 승격 실패 — 기존 관리본으로 계속:', e?.message ?? e);
        await ensureCodexHost(); // 최소한 host 부재(도구 잠김·os error 2)만이라도 막는다
      });
    }
    return { file: codexManagedBin(), args: [] };
  }
  try {
    return { file: await provisionCodexCli(), args: [] };
  } catch (e) {
    // 조달 불가(오프라인 등) — PATH 설치본 폴백. 미검증 버전임을 로그로 남긴다(정직 표기 계열).
    const onPath = await exec('codex', ['--version']).then(() => true, () => false);
    if (onPath) { console.warn('[argo] codex 관리본 조달 실패 — PATH 설치본으로 폴백(미검증 버전):', e?.message ?? e); return { file: 'codex', args: [] }; }
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
  // **벤더 기능 플래그를 여기에 강제로 쓰지 않는다**(설계 원칙, 2026-08-25 사고로 확립).
  // 전례: code_mode_host=false 강제(#279) — 0.147에선 폴백이었는데 0.148+에서 fail-closed(도구
  // 전면 잠김)로 의미가 바뀌어 모든 codex 크루의 셸·파일 도구가 조용히 전멸했다(윈도우 제보
  // 2026-08-25, 이 맥 3상태 재현). 형제 host는 이제 provisionCodexCli가 동반 조달한다. 이 파일의
  // 역할은 MCP 주입까지 — 그 이상을 쓰려면 벤더 버전 의미 변화까지 계약 프로브로 잠근 뒤에.
  const lines = [
    '# Argo 관리 codex 설정 — 매 턴 MCP 목록에서 재생성됩니다.',
    '',
  ];
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

/** 도구 잠김(실행기 자체 고장) 신호 — codex 0.148+ 실측 문구 3종(2026-08-25 이 맥 재현):
    "Code Mode is unavailable because code-mode host is disabled/failed to spawn … Code mode will fail closed".
    성공 턴의 stderr에도 실릴 수 있다(턴은 완주하되 도구만 잠김 — 제보의 형태). (export: 회귀 테스트용) */
export const CODEX_LOCKUP_RE = /Code Mode is unavailable|code-mode host is disabled|failed to spawn code-mode host/i;

export { codexHome, codexManagedBin, codexHostManagedBin, codexCmd }; // 러너 모듈 내부 공용(facade 미노출 — externalExec·detectRunners가 쓴다)
