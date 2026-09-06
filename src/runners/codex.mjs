// Codex 러너 — 격리 홈·CLI 자동 조달·샌드박스/추론 강도 인자·auth 반입/회수·턴 config.
// (runners.mjs 관심사 분리 2026-07-28)

import { readFile, copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exec, exists } from './shared.mjs';
import { withDirLock } from '../mutex.mjs';

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
    새 버전은 러너 계약 프로브(scripts/runner-contract-probe.mjs — PR3에서 추가 예정, 그 전엔 수동 프로브) 통과 확인 후 이 상수만 올린다.
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

// 크로스 프로세스 뮤텍스 — 상주(:3001)·사이드카·CLI가 동시에 조달하면 한쪽 rm이 다른 쪽 채택본을
// 지운다(분리 검수 MEDIUM-1). 인프로세스 단일 비행(codexProvisioning)은 프로세스 경계를 못 넘으므로
// mkdir 락(쪽지 선점과 같은 프리미티브 — rename 승자 가정이 윈도우에서 깨졌던 전례)으로 감싼다.
const CODEX_LOCK_DIR = `${CODEX_TOOL_DIR}.lockd`;
const LOCK_STALE_MS = 15 * 60_000; // 다운로드 최장(자산별 300s×2) + 여유
async function withCodexLock(fn) {
  // **부모 먼저 만든다**(C1 회귀 수정 2026-08-26): CODEX_TOOL_DIR 생성은 락 안(fn)에 있으므로, 락
  // 디렉터리의 부모(~/.argo/tools)가 없으면 mkdir(lock)이 ENOENT로 실패하고 아래 catch가 그걸 "보유자
  // 있음"으로 오해해 120초 헛돈 뒤 거짓 문구로 죽는다 — gemini·npx를 먼저 안 써본 신규 기기에서 codex가
  // 영구 불능이 됐다(실측: 신규 기기 120,122ms → 이 한 줄로 3ms). 자기 부모를 락 밖에서 확보한다.
  await mkdir(dirname(CODEX_LOCK_DIR), { recursive: true }).catch(() => {});
  const t0 = Date.now();
  for (;;) {
    try { await mkdir(CODEX_LOCK_DIR, { recursive: false }); break; } catch (e) {
      // **EEXIST만 "보유자 있음"**(C1): 그 밖의 실패(EACCES·EPERM — 윈도우 안티바이러스가 락 생성을
      // 막는 경우 등)를 대기로 뭉개면 여기서도 120초 거짓말이 난다. 원인 그대로 즉시 드러낸다.
      if (e?.code && e.code !== 'EEXIST') throw new Error(`codex 조달 락을 만들지 못했습니다(${e.code}): ${dirname(CODEX_LOCK_DIR)} 쓰기 권한을 확인해 주세요`);
      // 보유자 있음 — 오래된 잔재(크래시)면 회수, 아니면 대기. 최대 2분 후엔 관망 포기(기존 설치본으로 진행).
      const st = await stat(CODEX_LOCK_DIR).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await rm(CODEX_LOCK_DIR, { recursive: true, force: true }).catch(() => {}); continue; }
      if (Date.now() - t0 > 120_000) throw new Error('codex 조달이 다른 프로세스에서 진행 중입니다 — 잠시 후 다시 시도해 주세요');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  try { return await fn(); } finally { await rm(CODEX_LOCK_DIR, { recursive: true, force: true }).catch(() => {}); }
}

export async function provisionCodexCli({ force = false } = {}) {
  if (!force && await exists(codexManagedBin())) return codexManagedBin();
  if (codexProvisioning) return codexProvisioning;
  codexProvisioning = (async () => withCodexLock(async () => {
    // 락 획득 후 재확인 — 다른 프로세스가 방금 조달을 끝냈을 수 있다(TOCTOU 방어, 릴리스 검수 M-1 계열).
    if (!force && await exists(codexManagedBin())) return codexManagedBin();
    if (force && await exists(codexManagedBin())) {
      const stamp = await readFile(join(CODEX_TOOL_DIR, '.pin'), 'utf8').then((v) => v.trim(), () => '');
      if (stamp === CODEX_PIN) return codexManagedBin(); // 경합 상대가 이미 같은 핀으로 교체 완료
    }
    const asset = codexAssetName();
    const hostAsset = codexHostAssetName();
    if (!asset || !hostAsset) throw new Error(`미지원 플랫폼: ${process.platform}/${process.arch}`);
    const tmp = await mkdtemp(join(tmpdir(), 'argo-codex-cli-'));
    try {
      // codex와 형제 host를 **둘 다** 받고 검증이 끝난 뒤에만 기존 파일을 교체한다 — 다운로드·검증
      // 실패 시 기존 설치본이 그대로 남는다(롤백 안전). 순서를 뒤집으면 실패가 곧 "설치본 소실"이 된다.
      const src = await fetchCodexAsset(tmp, asset, CODEX_BIN);
      const hostSrc = await fetchCodexAsset(tmp, hostAsset, CODEX_HOST_BIN);
      const v = (await exec(src, ['--version'], { timeout: 30_000 })).stdout.trim();
      if (!v) throw new Error('내려받은 Codex CLI가 부팅하지 않습니다');
      // host는 --version 계약이 미확인이라 크기 하한으로 손상만 거른다(정상 ~57MB, 절단 다운로드 방어)
      const hs = await stat(hostSrc);
      if (hs.size < 5_000_000) throw new Error(`내려받은 code-mode host가 손상됐습니다(${hs.size}B)`);
      // 부분 삭제 안전 교체(분리 검수 MEDIUM-1 윈도우 시나리오): 디렉터리 통삭제 대신 파일 단위로,
      // ① 스탬프 먼저 무효화(크래시 시 상태 = "구버전 + 무스탬프" → 스로틀 승격 재시도로 일관)
      // ② codex 교체가 실패하면(EBUSY 등) 구 설치본을 그대로 두고 중단 — "host만 지워진" 사고 상태를 만들지 않는다.
      await mkdir(CODEX_TOOL_DIR, { recursive: true });
      await rm(join(CODEX_TOOL_DIR, '.pin'), { force: true }).catch(() => {});
      await rm(codexManagedBin(), { force: true });
      await adoptInto(codexManagedBin(), src);
      await rm(codexHostManagedBin(), { force: true });
      await adoptInto(codexHostManagedBin(), hostSrc);
      // 스탬프는 마지막 — 실패해도 설치는 유효(무스탬프 = 다음 승격 시도가 스로틀 안에서 복구)
      await writeFile(join(CODEX_TOOL_DIR, '.pin'), CODEX_PIN).catch((e) => console.warn('[argo] codex .pin 기록 실패(무해 — 승격 재시도로 복구):', e?.message ?? e));
      return codexManagedBin();
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }))().finally(() => { codexProvisioning = null; });
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
    // 실패 스로틀 공유(.attempt-at) — 오프라인에서 턴마다 host 다운로드를 다시 시도하지 않는다
    const last = Number(await readFile(ATTEMPT_STAMP(), 'utf8').catch(() => '0')) || 0;
    if (Date.now() - last < 60 * 60_000) return false;
    const tmp = await mkdtemp(join(tmpdir(), 'argo-codex-host-'));
    try {
      const hostSrc = await fetchCodexAsset(tmp, hostAsset, CODEX_HOST_BIN);
      await adoptInto(codexHostManagedBin(), hostSrc);
      console.log('[argo] codex code-mode host 보강 조달 완료');
      return true;
    } catch (e) {
      console.warn('[argo] codex code-mode host 보강 조달 실패(다음 사용 때 재시도):', e?.message ?? e);
      await writeFile(ATTEMPT_STAMP(), String(Date.now())).catch(() => {}); // 실패 스로틀 각인
      return false;
    } finally {
      hostEnsuring = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return hostEnsuring;
}

/** 도구 잠김(L2 자가치유)·핀 승격 공용 재조달 — 관리본을 핀 버전으로 강제 재설치. 스로틀은
    **디스크 스탬프**(.attempt-at): 상주·사이드카·CLI가 프로세스마다 1시간을 따로 갖거나 재시작마다
    리셋되지 않게(분리 검수 MEDIUM-2·HIGH — 조달 실패 상태에서 턴마다 ~125MB 재다운로드 방지).
    반환: 실제로 재조달했으면 true, 스로틀에 걸렸으면 false. */
const ATTEMPT_STAMP = () => join(CODEX_TOOL_DIR, '.attempt-at');
export async function reprovisionCodexCli() {
  const last = Number(await readFile(ATTEMPT_STAMP(), 'utf8').catch(() => '0')) || 0;
  if (Date.now() - last < 60 * 60_000) return false;
  await mkdir(CODEX_TOOL_DIR, { recursive: true }).catch(() => {});
  await writeFile(ATTEMPT_STAMP(), String(Date.now())).catch(() => {}); // 시도 자체를 기록 — 실패 루프 방지가 목적
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
      // 승격도 스로틀 재조달을 탄다(분리 검수 HIGH) — 실패 상태에서 턴마다 ~125MB를 다시 받지 않게.
      // 스로틀에 걸리거나 실패하면 기존 관리본으로 턴은 계속(오프라인 방어) + host 부재만이라도 보강.
      const done = await reprovisionCodexCli().then((v) => { if (v) console.log(`[argo] codex 관리본 승격: ${stamp || '(무스탬프)'} → ${CODEX_PIN}`); return v; })
        .catch((e) => { console.warn('[argo] codex 승격 실패 — 기존 관리본으로 계속:', e?.message ?? e); return false; });
      if (!done) await ensureCodexHost();
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
  // 크로스 프로세스 잠금(불변식 B) — 복사 폴백(Windows 심링크 EPERM)에서 병렬 턴 둘이 각자 회전한 사본을
  // 되돌리면 나중 쓰기가 앞 쓰기의 회전 토큰을 지운다("refresh token already used" 실측 2건과 같은 클래스).
  // mtime 비교와 복사를 같은 락 안에서 한다 — 비교만 밖에서 하면 TOCTOU.
  return withDirLock(`${handle.src}.lockd`, async () => {
    const [a, b] = await Promise.all([stat(handle.dst).catch(() => null), stat(handle.src).catch(() => null)]);
    if (!a || !b || !(a.mtimeMs > b.mtimeMs)) return false;
    await copyFile(handle.dst, handle.src);
    return true;
  });
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

/** 도구 잠김(실행기 자체 고장) 신호 — codex 0.148+의 벤더 경고 줄(2026-08-25 이 맥 재현):
    "warning: Code Mode is unavailable because code-mode host is disabled / failed to spawn … fail closed".
    성공 턴의 stderr에도 실린다(턴은 완주하되 도구만 잠김 — 제보의 형태).
    **줄머리 `warning:` 앵커 필수**(분리 검수 CRITICAL 실증): codex exec는 대화 내용을 stderr에 옮겨
    적으므로, 사용자가 "이 경고 왜 떠?"라고 문구를 인용만 해도 비앵커 패턴은 잠김으로 오분류해
    재조달+러너 교체까지 태운다(#286 CLI 미발견 오분류와 같은 계열). (export: 회귀 테스트용) */
export const CODEX_LOCKUP_RE = /^warning: Code Mode is unavailable\b.*(?:code-mode host is disabled|failed to spawn code-mode host|fail closed)/im;

export { codexHome, codexManagedBin, codexHostManagedBin, codexCmd }; // 러너 모듈 내부 공용(facade 미노출 — externalExec·detectRunners가 쓴다)
