// macOS Dock 아이콘 억제 — 크루가 답변할 때마다 Dock에 node 아이콘이 쌓이던 현상의 처방.
//
// 원인(실측 2026-09-10): node는 `process.title` 대입 시 libuv의 uv_set_process_title을 부르고,
// 그 macOS 구현이 LSSetApplicationInformationItem을 호출한다 → 프로세스가 Launch Services에
// **앱으로 등록**되고 Dock 아이콘이 생긴다. A/B 재현: 같은 옵션으로 띄운 node 자식이 제목을
// 설정하지 않으면 lsappinfo 등록 0, 설정하면 즉시 등록. stdio·detached 조합은 무관했다
// (detached: true로 새 세션을 만들어도 등록된다 — 세션 분리로는 못 막는다).
//
// **적용 범위는 node로 실행되는 자식뿐이다.** 다른 런타임은 실측으로 갈라 두었다(분리 검수 HIGH-1):
//   · Bun: 제목을 설정해도 **등록되지 않는다**(bun -e A/B 실측). SDK가 띄우는 `claude`는 Bun
//     컴파일 단일 실행 파일이라 이 프리로드가 안 걸리지만, 애초에 아이콘을 만들지 않는다.
//   · codex(Rust)·기타 네이티브 바이너리: NODE_OPTIONS 무관. 등록 여부는 미검증.
// 크루 턴이 아이콘을 만드는 실제 주체는 회사에 연결된 stdio MCP 서버(npx·node)다 — npm이 자기
// 제목을 `npm exec …`로 바꾼다. 실측: `npx -y @modelcontextprotocol/server-memory` 1대 = 등록 1건.
//
// 처방: 자식들이 상속하는 NODE_OPTIONS에 프리로드를 걸어 제목 **setter만** 무력화한다. 읽기는
// 그대로라 ps·Activity Monitor 표시와 진단은 변하지 않는다. 러너 경로는 전부 세척된 process.env를
// 기반으로 env를 만들므로(creds.sdkEnvFor·exec·codex-appserver·engine의 shellEnv) 부팅 때 한 번
// 걸면 그 아래 node 자식이 모두 덮인다.
//
// ⚠ NODE_OPTIONS는 **모든** node 자식이 상속한다(크루가 Bash로 돌리는 명령 포함). 값이 조금이라도
// 깨지면 그 자식들이 전부 죽으므로, 채택 전에 **프로브 자식 1회**로 실제 유효성을 확인하고 통과할
// 때만 대입한다(파일 부재·따옴표 파손·권한·node 버전 거절을 한 검사로 덮는다 — 분리 검수 MEDIUM-2:
// 존재 확인만으로는 `"`·`\`가 든 홈 경로에서 나는 파손을 못 잡는다). 실패는 조용히 넘어간다 —
// 아이콘 억제가 크루 턴을 막는 것이 훨씬 나쁘다.
import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 프리로드 본문 — CJS여야 한다(--require는 ESM을 못 읽는다). darwin 밖에서는 아무것도 하지 않는다. */
const SHIM_SRC = `'use strict';
// Argo 자동 생성 — macOS Dock 아이콘 억제(src/no-dock.mjs). 직접 수정하지 마세요.
if (process.platform === 'darwin') {
  try {
    var cur = process.title;
    Object.defineProperty(process, 'title', {
      get: function () { return cur; },
      set: function () { /* 무시 — 대입이 Launch Services 등록(Dock 아이콘)을 만든다 */ },
      configurable: true,
      enumerable: true,
    });
  } catch (e) { /* 재정의 실패 — 원래 동작 유지 */ }
}
`;

/** 프리로드 경로 — codex CLI 조달과 같은 도구 디렉터리. ARGO_ROOT(회사 데이터)와 분리한다. */
export const noDockShimPath = () => join(homedir(), '.argo', 'tools', 'no-dock.cjs');

/** 시간 상한 — 응답 없는 네트워크 홈에서 부팅이 멈추지 않게(분리 검수 LOW-1). */
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 시간 초과(${ms}ms)`)), ms).unref?.()),
]);

/** 프리로드 파일 보장(멱등) — tmp에 쓰고 rename으로 갈아 끼운다. 동시 부팅이 겹쳐도 자식이 반쪽 파일을
    읽지 않는다(분리 검수 MEDIUM-4, 레포의 writeJsonAtomic과 같은 관례). 0600 — ~/.argo 산출물 관례. */
export async function ensureNoDockShim(path = noDockShimPath()) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, SHIM_SRC, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => { /* 파일시스템이 모드를 무시 — 내용이 본체다 */ });
  await rename(tmp, path);
  await access(path);
  return path;
}

/** NODE_OPTIONS 합성(순수) — 기존 값 보존, 같은 경로가 이미 있으면 그대로, 공백 경로는 따옴표.
    판정은 **경로 정확 일치**다(분리 검수 LOW-2: 파일명만 보면 다른 홈의 낡은 항목을 내 것으로 오인한다). */
export function withNoDock(prev, path) {
  const cur = String(prev ?? '').trim();
  const arg = /\s/.test(path) ? `"${path}"` : path;
  if (cur.includes(`--require ${arg}`)) return cur;
  return `--require ${arg}${cur ? ` ${cur}` : ''}`;
}

/** 프로브 — 합성한 NODE_OPTIONS로 빈 자식을 한 번 띄워 본다. exit 0일 때만 채택한다. */
export function probeNodeOptions(env, composed, { spawnFn = spawn, execPath = process.execPath } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const c = spawnFn(execPath, ['-e', ''], { stdio: 'ignore', env: { ...env, NODE_OPTIONS: composed } });
      c.on('error', () => finish(false));
      c.on('close', (code) => finish(code === 0));
    } catch { finish(false); }
  });
}

/** 부팅 시 1회 — 이후 spawn되는 node 자식이 상속한다. 반환: 건 경로 | null(비적용). */
export async function setupNoDock({
  env = process.env, platform = process.platform, path = noDockShimPath(), timeoutMs = 2000, probe = probeNodeOptions,
} = {}) {
  if (platform !== 'darwin') return null; // Dock이 없는 OS — 건드릴 이유가 없다
  try {
    const shim = await withTimeout(ensureNoDockShim(path), timeoutMs, '프리로드 파일 준비');
    const composed = withNoDock(env.NODE_OPTIONS, shim);
    if (composed === String(env.NODE_OPTIONS ?? '').trim()) return shim; // 이미 걸림(재부팅·중첩 실행)
    const ok = await withTimeout(probe(env, composed), timeoutMs, '프리로드 프로브');
    if (!ok) { // 파일이 사라졌거나 경로가 NODE_OPTIONS 문법을 깨뜨린다 — 걸면 모든 node 자식이 죽는다
      console.warn('[argo] Dock 아이콘 억제 프리로드 미적용 — 프로브 자식이 실패했습니다(경로:', shim, ')');
      return null;
    }
    env.NODE_OPTIONS = composed;
    return shim;
  } catch (e) {
    console.warn('[argo] Dock 아이콘 억제 프리로드 준비 실패(무시하고 계속):', e?.message ?? e);
    return null;
  }
}
