// Codex 러너 — 격리 홈·CLI 자동 조달·샌드박스/추론 강도 인자·auth 반입/회수·턴 config.
// (runners.mjs 관심사 분리 2026-07-28)

import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, exists } from './shared.mjs';
import { openRoots } from '../workroots.mjs'; // 파일 반경 단일 진실 — gemini·antigravity와 같은 계산(러너 중립성)

/** Argo 전용 CODEX_HOME — 사용자 전역 config(커스텀 에이전트·모델 핀)와 격리하고 auth만 빌린다.
    (전역 config의 spawn_agent 커스텀 스키마가 신형 모델의 예약 도구와 충돌하는 사례 확인) */
async function codexHome() {
  const dir = join(homedir(), '.argo', 'codex-home');
  await mkdir(dir, { recursive: true });
  if (!(await exists(join(dir, 'auth.json')))) {
    await symlink(join(homedir(), '.codex', 'auth.json'), join(dir, 'auth.json')).catch(() => {});
  }
  if (!(await exists(join(dir, 'config.toml')))) {
    await writeFile(join(dir, 'config.toml'), '# Argo 격리 codex 설정 — 계정 기본값 사용\n').catch(() => {});
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

/** 능력 → codex 샌드박스 매핑(순수) — SDK 러너의 권한 게이트(permission-gate)를 근사한다.
    fs ON = 워크스페이스 밖 쓰기 허용(읽기는 workspace-write가 원래 전역), browser ON = 네트워크 허용.
    ⚠ 등가는 아니다(검수 MEDIUM 2026-07-19): codex는 셸 실행이 도구와 분리되지 않아 shell 능력을
    따로 막을 수 없고, fs/browser를 켜면 그 셸 명령 전체에 밖 쓰기/네트워크가 열린다 — SDK처럼
    도구(Write/Edit·WebFetch) 단위가 아니라 프로세스 단위 허용이다. 사용자 본인 데스크톱에서
    사장이 명시적으로 켠 토글 뒤라 수용하되, 이 비대칭을 아는 상태로 유지·변경할 것.
    키·-c 오버라이드는 codex-cli 0.144.1 바이너리에서 실측 확인(sandbox_workspace_write.*) —
    미래 codex가 키를 거부하면 fs/browser 켠 턴만 실패한다(기본은 빈 배열이라 무영향).
    실사용 신고 대응(2026-07-19): 사장이 fs를 켜도 "읽기전용이라 불가"로 막히던 외부 자료 가져오기.
    (export: 회귀 테스트용) */
export const codexSandboxArgs = (caps, workRoots = []) => {
  // fs 능력 — 이전엔 "/"(루트 전체)를 열어 실행 중인 Argo 앱 코드까지 쓰기 가능했다(실사용 신고
  // 2026-07-22 크리티컬). 홈 디렉토리로 좁힌다 — 사용자 문서 접근(fs 능력의 목적)은 유지되고
  // /Applications의 앱 본체는 샌드박스 밖이 된다. (홈 안의 Argo 데이터는 프로세스 단위 샌드박스의
  // 한계로 완전 차단 불가 — commonDirectives 금지 지시가 2차 방어. SDK 러너는 게이트가 하드 차단.)
  // workRoots — 사장이 지정한 외부 작업 폴더(workroots.mjs, 신고 11건 해소 2026-07-27). fs와
  // 독립으로 열린다: "홈 전부"가 아니라 "이 폴더만"이 더 좁은 위임이다. 등록 시점에 금지 구역이
  // 검증돼 있다(validateWorkRoot).
  // 경로는 TOML 문자열로 직렬화한다 — Windows 홈(C:\Users\...)의 역슬래시가 이스케이프로 해석돼
  // 값이 깨지던 실사용 신고(2026-07-25). JSON.stringify가 TOML 기본 문자열 규칙과 호환(따옴표·역슬래시 이스케이프).
  const roots = openRoots(caps, workRoots);
  return [
    ...(roots.length ? ['-c', `sandbox_workspace_write.writable_roots=[${roots.map((r) => JSON.stringify(r)).join(',')}]`] : []),
    ...(caps?.browser ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
  ];
};

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

/** 능력 매핑을 codex config.toml에 매 턴 써넣는다 — `-c` CLI 오버라이드의 버전-안정 대체(주 경로).
    실사용 신고(2026-07-22, 김남): caps를 다 켜도 codex 크루만 "로컬능력 권한 실패", 사용자가 config.toml을
    수동 수정해 해결. 원인 = `-c sandbox_workspace_write.*` 오버라이드 키 경로가 codex 버전마다 갈려
    거부/무시됨. config.toml의 [sandbox_workspace_write] 섹션은 안정 인터페이스라 버전 불문 먹는다.
    Argo 관리 config.toml(코멘트 전용)을 통째로 다시 써 파싱 불필요. writable_roots=홈(앱 본체 보호 유지). */
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

export async function writeCodexTurnConfig(home, caps, workRoots = []) {
  const lines = ['# Argo 관리 codex 설정 — 매 턴 능력(fs/browser)·지정 작업 폴더에서 재생성됩니다.'];
  // fs=홈(앱 본체는 밖) + 사장이 지정한 외부 작업 폴더(fs와 독립 — codexSandboxArgs와 동일 규칙)
  const roots = openRoots(caps, workRoots);
  if (roots.length || caps?.browser) {
    lines.push('[sandbox_workspace_write]');
    // JSON.stringify — Windows 역슬래시 이스케이프(위 codexSandboxArgs와 동일 규칙, 신고 2026-07-25)
    if (roots.length) lines.push(`writable_roots = [${roots.map((r) => JSON.stringify(r)).join(', ')}]`);
    if (caps?.browser) lines.push('network_access = true');
  }
  await writeFile(join(home, 'config.toml'), lines.join('\n') + '\n').catch(() => { /* 실패해도 -c 폴백이 있다 */ });
}

export { codexHome, codexManagedBin, codexCmd }; // 러너 모듈 내부 공용(facade 미노출 — externalExec·detectRunners가 쓴다)
