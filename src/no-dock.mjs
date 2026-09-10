// macOS Dock 아이콘 억제 — 크루가 답변할 때마다 Dock에 node 아이콘이 쌓이던 현상의 처방.
//
// 원인(실측 2026-09-10): node는 `process.title` 대입 시 libuv의 uv_set_process_title을 부르고,
// 그 macOS 구현이 LSSetApplicationInformationItem을 호출한다 → 프로세스가 Launch Services에
// **앱으로 등록**되고 Dock 아이콘이 생긴다. A/B 재현: 같은 옵션으로 띄운 node 자식이 title을
// 설정하지 않으면 lsappinfo 등록 0, 설정하면 즉시 등록. stdio·detached 조합은 무관했다.
//
// 크루 턴은 자식 프로세스를 여럿 띄운다 — SDK가 부르는 CLI, 회사에 연결된 stdio MCP 서버(npx·node).
// npm은 자기 제목을 `npm exec …`로 바꾸고 Next는 `next-server (vX)`로 바꾼다. 그래서 **턴마다**
// 아이콘이 늘었다. 실측: `npx -y @modelcontextprotocol/server-memory` 한 대만 띄워도 등록 1건.
//
// 처방: 자식들이 상속하는 NODE_OPTIONS에 프리로드를 걸어 title **setter만** 무력화한다. 읽기는
// 그대로라 ps·Activity Monitor 표시와 진단은 변하지 않는다. 러너 경로는 전부
// scrubServerSecrets(process.env)를 기반으로 env를 만들므로(creds.sdkEnvFor·exec·codex-appserver)
// 부팅 때 한 번 걸면 SDK·네이티브·CLI 자식이 모두 덮인다.
//
// ⚠ NODE_OPTIONS는 **모든** node 자식이 상속한다(크루가 Bash로 돌리는 명령 포함). 프리로드 파일이
// 없으면 그 자식들이 전부 죽으므로, 파일을 쓰고 **존재를 확인한 뒤에만** env를 건드린다. 실패는
// 조용히 넘어간다 — 아이콘 억제가 크루 턴을 막는 것이 훨씬 나쁘다.
import { access, mkdir, writeFile } from 'node:fs/promises';
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

/** 프리로드 파일 보장(멱등) — 내용이 고정이라 매 부팅 덮어써도 무해하다. 존재 확인까지 하고 경로를 돌려준다. */
export async function ensureNoDockShim(path = noDockShimPath()) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SHIM_SRC, 'utf8');
  await access(path); // 여기서 던지면 호출부가 env를 건드리지 않는다(없는 파일을 걸면 node 자식이 전멸)
  return path;
}

/** NODE_OPTIONS 합성(순수) — 기존 값 보존, 중복 부착 방지, 공백 경로는 따옴표(node가 공백으로 토큰을 가른다). */
export function withNoDock(prev, path) {
  const cur = String(prev ?? '').trim();
  if (cur.includes('no-dock.cjs')) return cur; // 이미 걸림(재부팅·중첩 실행)
  const arg = /\s/.test(path) ? `"${path}"` : path;
  return `--require ${arg}${cur ? ` ${cur}` : ''}`;
}

/** 부팅 시 1회 — 이후 spawn되는 node 자식이 상속한다. 반환: 건 경로 | null(비적용). */
export async function setupNoDock({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null; // Dock이 없는 OS — 건드릴 이유가 없다
  try {
    const path = await ensureNoDockShim();
    env.NODE_OPTIONS = withNoDock(env.NODE_OPTIONS, path);
    return path;
  } catch (e) {
    console.warn('[argo] Dock 아이콘 억제 프리로드 준비 실패(무시하고 계속):', e?.message ?? e);
    return null;
  }
}
