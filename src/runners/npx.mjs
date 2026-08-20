// npm(npx) 즉석 조달 — npx 계열 MCP를 **시스템 node/npm 없이** 돌린다(유건 지시 2026-08-21).
// 배경: MCP 카탈로그·사용자 정의가 `npx -y <pkg>`인데 앱 번들 노드에는 npm이 없어, 시스템에 npm이
// 없는 기기에서는 commandExists 게이트가 npx MCP를 전부 걸러냈다(조용한 기능 부재).
// npm을 devDependency로 싣는 방식은 기각 — 16MB + 취약 transitive(high 4종)가 audit 0건 레포에
// 유입된다. 대신 codex/gemini CLI와 같은 조달 패턴: 레지스트리 latest 메타 → 타르볼 sha512 대조 →
// 부팅 검증 → 원자적 채택. 실행은 우리 노드(process.execPath) + npx-cli.js라 시스템 설치가 전혀
// 필요 없고, 설치본 용량도 늘지 않는다.
import { mkdtemp, mkdir, rm, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, exists } from './shared.mjs';
import { commandExists } from './codex.mjs';

// 위협모델 명시(분리 검수 2026-08-21 MED-4): 호스팅(서비스 키 워커) 문맥에서도 이 조달이 돈다 —
// 단 대상은 safeMcpServersForRuntime을 **이미 통과한**(카탈로그 검증 command) 서버뿐이고, 내려받는
// 것은 npm 공식 레지스트리의 npm 자체(sha512 대조)다. 임의 command 차단 게이트를 우회하지 않는다.
const NPM_TOOL_DIR = join(homedir(), '.argo', 'tools', 'npm');
export const managedNpxEntry = () => join(NPM_TOOL_DIR, 'package', 'bin', 'npx-cli.js');

let npmProvisioning = null;
export async function provisionNpx() {
  if (await exists(managedNpxEntry())) return managedNpxEntry();
  if (npmProvisioning) return npmProvisioning;
  npmProvisioning = (async () => {
    if (await exists(managedNpxEntry())) return managedNpxEntry(); // TOCTOU 재확인(gemini 조달 M-1과 동일)
    const meta = await fetch('https://registry.npmjs.org/npm/latest', { signal: AbortSignal.timeout(15_000) }).then((r) => {
      if (!r.ok) throw new Error(`레지스트리 응답 ${r.status}`);
      return r.json();
    });
    const tmp = await mkdtemp(join(tmpdir(), 'argo-npm-'));
    try {
      const tar = join(tmp, 'pkg.tgz');
      const buf = Buffer.from(await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(180_000) }).then((r) => {
        if (!r.ok) throw new Error(`타르볼 다운로드 실패 ${r.status}`);
        return r.arrayBuffer();
      }));
      // 무결성 대조 — npm install과 동일 수준(sha512). integrity 부재(구식 레지스트리)면 검증 없이 진행.
      const integ = String(meta.dist?.integrity ?? '');
      if (integ.startsWith('sha512-')) {
        const got = createHash('sha512').update(buf).digest('base64');
        if (got !== integ.slice(7)) throw new Error('타르볼 무결성 불일치 — 다운로드가 손상됐거나 변조됐습니다');
      }
      await writeFile(tar, buf);
      await exec('tar', ['-xzf', tar, '-C', tmp]); // macOS/리눅스 기본, Windows 10+ 내장 tar
      // 부팅 검증 후 원자적 채택 — 반쯤 풀린 트리가 '설치됨'으로 잡히지 않게(gemini와 동일)
      const entry = join(tmp, 'package', 'bin', 'npx-cli.js');
      const v = (await exec(process.execPath, [entry, '--version'], { timeout: 30_000 })).stdout.trim();
      if (!v) throw new Error('내려받은 npm(npx)이 부팅하지 않습니다');
      await rm(NPM_TOOL_DIR, { recursive: true, force: true });
      await mkdir(NPM_TOOL_DIR, { recursive: true });
      await rename(join(tmp, 'package'), join(NPM_TOOL_DIR, 'package')).catch(async (e) => {
        if (e?.code !== 'EXDEV') throw e; // 크로스 디바이스 rename 불가 폴백
        await exec('tar', ['-xzf', tar, '-C', NPM_TOOL_DIR]);
      });
      return managedNpxEntry();
    } finally {
      npmProvisioning = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return npmProvisioning;
}

/** MCP 서버 정의를 실행형으로 구체화 — SDK 턴·codex 주입 **양쪽이 이 하나를** 지난다(사본 금지,
    scopeServers와 같은 원칙).
    - command 'node' → 우리 노드(process.execPath). PATH 선두 통일(shared.mjs)과 이중이지만
      명시가 결정적이다 — env를 갈아끼우는 러너(codex config.toml)에서도 안 흔들린다.
    - command 'npx' → 시스템 npx가 있으면 그대로(사용자 npm 캐시 존중), 없으면 관리본을 조달해
      [우리 노드, npx-cli.js, ...원래 args]로 재작성. 조달 실패(오프라인 등)는 원형 유지 —
      commandExists 게이트가 기존대로 정직하게 거른다(조용한 삭제 금지).
    - url/기타 command는 원형 그대로. 입력 맵은 불변(scopeServers 계약과 동일). */
export async function materializeMcpServers(servers, {
  hasSystemNpx = () => commandExists('npx'),
  provide = provisionNpx,
} = {}) {
  const out = {};
  for (const [name, def] of Object.entries(servers ?? {})) {
    if (!def || typeof def !== 'object' || !def.command) { out[name] = def; continue; }
    if (def.command === 'node') { out[name] = { ...def, command: process.execPath }; continue; }
    if (def.command === 'npx' && !hasSystemNpx()) {
      try {
        const entry = await provide();
        out[name] = { ...def, command: process.execPath, args: [entry, ...(def.args ?? [])] };
        continue;
      } catch (e) { console.warn(`[argo] npx 조달 실패 — ${name}은 시스템 npm 필요: ${String(e?.message ?? e)}`); }
    }
    out[name] = def;
  }
  return out;
}
