// Gemini 러너 — CLI 자동 조달·격리 턴 홈·턴 settings(도구 게이팅)·OAuth 프로브.
// (runners.mjs 관심사 분리 2026-07-28)

import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, exists, homeEnv, scrubServerSecrets, seedAuthFile } from './shared.mjs';
import { openRoots } from '../workroots.mjs'; // 파일 반경 단일 진실(codex·gemini·antigravity 공유)

/* ─── Gemini CLI 자동 조달 — "구독 연결 = 바로 사용"의 본체 (실사용 신고 2026-07-20) ───
   Gemini 러너는 벤더 CLI로 실행되는데, 지금까지는 사용자가 직접 설치해야 했다 — OAuth로
   "연결됨"인데 크루 영입은 "러너 없음"이 되는 모순의 뿌리. @google/gemini-cli는 의존성 0의
   단일 번들 JS(bundle/gemini.js, node>=20)라서 npm 없이도 레지스트리 타르볼을 받아
   우리 node(process.execPath)로 그대로 실행할 수 있다(0.51.0 실측: --version 부팅,
   -p/--approval-mode 플래그 현행 호출과 일치). PATH 설치본이 있으면 그것을 우선한다. */
const GEMINI_TOOL_DIR = join(homedir(), '.argo', 'tools', 'gemini-cli');
const geminiManagedEntry = () => join(GEMINI_TOOL_DIR, 'package', 'bundle', 'gemini.js');
let geminiProvisioning = null; // 단일 비행 — 연결 직후 워밍업과 첫 턴이 겹쳐도 다운로드는 1회

export async function provisionGeminiCli() {
  if (await exists(geminiManagedEntry())) return geminiManagedEntry();
  if (geminiProvisioning) return geminiProvisioning;
  geminiProvisioning = (async () => {
    // 파괴적 rm 전 재확인 — exists(258행)가 이전 조달의 rename 직전에 false를 읽고 finally의
    // null 대입 뒤에 도착하면 정상 설치본을 지우고 재다운로드하는 TOCTOU가 있다(릴리스 검수 M-1)
    if (await exists(geminiManagedEntry())) return geminiManagedEntry();
    const meta = await fetch('https://registry.npmjs.org/@google/gemini-cli/latest', { signal: AbortSignal.timeout(15_000) }).then((r) => {
      if (!r.ok) throw new Error(`레지스트리 응답 ${r.status}`);
      return r.json();
    });
    const tmp = await mkdtemp(join(tmpdir(), 'argo-gemini-cli-'));
    try {
      const tar = join(tmp, 'pkg.tgz');
      const buf = Buffer.from(await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(180_000) }).then((r) => {
        if (!r.ok) throw new Error(`타르볼 다운로드 실패 ${r.status}`);
        return r.arrayBuffer();
      }));
      // 무결성 대조 — 레지스트리가 주는 sha512(integrity)와 다운로드 바이트를 대조(공급망, 릴리스 검수 M-4).
      // npm install이 하는 검증과 동일 수준. integrity 필드가 없으면(구식 레지스트리) 검증 없이 진행.
      const integ = String(meta.dist?.integrity ?? '');
      if (integ.startsWith('sha512-')) {
        const got = createHash('sha512').update(buf).digest('base64');
        if (got !== integ.slice(7)) throw new Error('타르볼 무결성 불일치 — 다운로드가 손상됐거나 변조됐습니다');
      }
      await writeFile(tar, buf);
      await exec('tar', ['-xzf', tar, '-C', tmp]); // macOS/리눅스 기본, Windows 10+ 내장 tar
      // 부팅 검증 후 원자적 채택 — 반쯤 풀린 트리가 '설치됨'으로 잡히지 않게
      const entry = join(tmp, 'package', 'bundle', 'gemini.js');
      const v = (await exec(process.execPath, [entry, '--version'], { timeout: 30_000 })).stdout.trim();
      if (!v) throw new Error('내려받은 Gemini CLI가 부팅하지 않습니다');
      await rm(GEMINI_TOOL_DIR, { recursive: true, force: true });
      await mkdir(GEMINI_TOOL_DIR, { recursive: true }); // rename 대상의 부모 — 누락 시 ENOENT(격리 HOME 실검증에서 실측)
      await rename(join(tmp, 'package'), join(GEMINI_TOOL_DIR, 'package')).catch(async (e) => {
        // 크로스 디바이스(tmp가 다른 볼륨) rename 불가 폴백
        if (e?.code !== 'EXDEV') throw e;
        await mkdir(GEMINI_TOOL_DIR, { recursive: true });
        await exec('tar', ['-xzf', tar, '-C', GEMINI_TOOL_DIR]);
      });
      return geminiManagedEntry();
    } finally {
      geminiProvisioning = null;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return geminiProvisioning;
}

/** gemini 실행 커맨드 해석 — PATH 설치본 > 관리본 > 즉석 조달. 실패 시 사람이 읽는 원인으로. */
async function geminiCmd() {
  const onPath = await exec('gemini', ['--version']).then(() => true, () => false);
  if (onPath) return { file: 'gemini', args: [] };
  if (await exists(geminiManagedEntry())) return { file: process.execPath, args: [geminiManagedEntry()] };
  try {
    return { file: process.execPath, args: [await provisionGeminiCli()] };
  } catch (e) {
    throw new Error(`Gemini 실행기를 준비하지 못했습니다(네트워크 확인 후 재시도): ${String(e.message || e)}`);
  }
}

/** gemini 턴용 격리 HOME 준비 — 세 자격 모드 공통. 반환 { home, authType, env } | null.
    settings.json(도구 게이팅 포함)은 turn마다 caps가 바뀌므로 externalExec가 매 턴 쓴다(여기선 자격만 시드).
    - apikey: 격리 HOME + GEMINI_API_KEY. authType=gemini-api-key로 고정 → 호스트 oauth로 조용히 새지 않음(스캐빈징 차단).
    - oauth(웹 브리지): 회사 oauth_creds.json을 격리 HOME에 푼다. CLI가 갱신 토큰을 여기 다시 쓴다(다음 턴 이어짐).
    - host(이 컴퓨터 로그인): 호스트 ~/.gemini의 로그인 파일만 격리 HOME으로 복사 — 로그인은 빌리되 config·기억·도구는 격리. */
async function geminiTurnHome(wsId, cred) {
  const home = join(homedir(), '.argo', `gemini-home-${wsId}`);
  const gdir = join(home, '.gemini');
  await mkdir(gdir, { recursive: true, mode: 0o700 }); // 자격 보관 — 소유자만
  if (cred.type === 'apikey') return { home, authType: 'gemini-api-key', env: { GEMINI_API_KEY: cred.value } };
  if (cred.type === 'oauth') {
    await seedAuthFile(gdir, 'oauth_creds.json', cred.value); // 저장 자격 변경(동기화 포함) 시 재시드 — CLI 갱신분은 보존
    return { home, authType: 'oauth-personal', env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } }; // API키 명시 소거 — 호스트 env 키가 OAuth를 누르지 않게(claude/codex 대칭, 신고 2026-07-24)
  }
  // host — 이 컴퓨터 로그인을 빌리되 격리 HOME에서 실행. detectRunners가 authed로 인정하는 두 경로를
  // 모두 격리한다(둘 다 안 잡으면 검수 HIGH: env키 경로가 무격리 호스트 HOME으로 새 도구 게이팅 우회).
  const hostG = join(homedir(), '.gemini');
  const hostCreds = await readFile(join(hostG, 'oauth_creds.json'), 'utf8').catch(() => null);
  if (hostCreds) {
    // "이 컴퓨터 로그인 사용"의 의미 그대로 — 호스트 로그인이 바뀌면(재로그인·계정 교체·철회 후 재발급)
    // 격리 사본을 따라간다. 1회 복사 동결은 철회된 옛 계정 스냅샷으로 계속 실행하면서 UI만 '연결됨'이던
    // 감사 결함(2026-07-20, codex 심링크와 비대칭). adopt=false — 호스트가 항상 단일 진실이라
    // 기존 동결 사본도 첫 턴에 즉시 해동된다. CLI가 격리 사본에 쓴 갱신은 호스트가 그대로인 한 보존.
    const reseeded = await seedAuthFile(gdir, 'oauth_creds.json', hostCreds, { adopt: false });
    // google_accounts.json은 있으면 함께(계정 식별) — 없어도 로그인은 동작
    if ((reseeded || !(await exists(join(gdir, 'google_accounts.json')))) && (await exists(join(hostG, 'google_accounts.json')))) {
      await copyFile(join(hostG, 'google_accounts.json'), join(gdir, 'google_accounts.json')).catch(() => {});
    }
    return { home, authType: 'oauth-personal', env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } }; // API키 명시 소거 — 호스트 env 키가 OAuth를 누르지 않게(claude/codex 대칭, 신고 2026-07-24)
  }
  // OAuth 파일은 없지만 호스트에 GEMINI_API_KEY env가 있으면 그 키로 — 격리 HOME + api-key 인증 고정.
  if (process.env.GEMINI_API_KEY) return { home, authType: 'gemini-api-key', env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY } };
  return null; // 진짜 미로그인 — 옵트인 무효(폴백 안 함, 명시 연결 원칙)
}

/** gemini 격리 HOME에 이번 턴 settings.json을 쓴다 — 인증 방식 고정 + caps 기반 도구 게이팅.
    매 턴 덮어쓴다(caps가 턴마다 다를 수 있음). 워크스페이스 GEMINI.md·전역 도구 상속을 이 파일이 차단한다. */
async function writeGeminiTurnSettings(home, authType, caps, workRoots = []) {
  const exclude = [];
  if (!caps?.browser) exclude.push('google_web_search', 'web_fetch'); // 웹 능력 OFF면 검색·페치 차단(광고·실행 방지)
  // 셸은 caps 무관 항상 제외 — 비대화 --approval-mode auto_edit에서 셸은 어차피 승인 불가로 실행이 안 되는데,
  // 도구만 보이면 크루가 시도→실패를 반복한다(할루시네이션 유도). yolo 승격은 gemini에 샌드박스가 없어 금지.
  exclude.push('run_shell_command');
  exclude.push('save_memory'); // 기억은 vault가 단일 진실 — gemini 병행 기억(GEMINI.md) 차단
  const roots = openRoots(caps, workRoots); // codex writable_roots와 같은 계산(러너 중립성 단일 진실)
  await writeFile(join(home, '.gemini', 'settings.json'),
    // folderTrust off — 신형 CLI(0.51 실측)가 headless에서 미신뢰 폴더를 exit 55로 거절한다.
    // 격리 홈 + 워크스페이스 한정 실행이라 폴더 신뢰 게이트는 우리 쪽 권한 모델(caps)이 대신한다.
    // 구버전(0.21 실측)은 이 키를 무해하게 무시한다.
    // context.includeDirectories — 크루의 파일 반경(홈 + 지정 작업 폴더). **이게 없으면 gemini 크루의
    // 책상은 회사 폴더 하나**다: 벤더 도구(write-file·read-file)가 workspace 밖 경로를 거부해, codex
    // 크루는 되는 지시가 gemini 크루만 "허용된 작업 디렉토리 외부"로 거절된다(라이브 재현 2026-07-30).
    // 설정 파일로 넣는 이유: `--include-directories` CLI 플래그는 0.21.2의 `-p`(비대화) 실행에서
    // 워크스페이스에 반영되지 않음을 실측했다(직접 넘겨도 workspace가 cwd 하나뿐). 벤더는 두 출처를
    // 합치므로(config.js: settings.context.includeDirectories ∪ argv) 설정 쪽이 확실하다.
    JSON.stringify({
      security: { auth: { selectedType: authType }, folderTrust: { enabled: false } },
      tools: { exclude },
      ...(roots.length ? { context: { includeDirectories: roots } } : {}),
    }));
}

/** gemini OAuth 자격을 실제 실행기(geminiCmd 해석 결과)로 초소형 1콜 검증 — "연결됨인데 첫 사용 실패" 차단.
    구글이 개인 무료 OAuth를 신형 CLI에서 거절(IneligibleTier)하므로 저장 전에 관문에서 잡는다
    (실사용 신고 2026-07-20: 로그인 인증은 '연결됨' → 크루 영입에서야 오류. 안내문만으론 관문 위반).
    반환 { ok: true | false(부적격 확정) | null(판정 불가 — 오프라인 등, 기존 verifyRunnerCred 관용과 동일) }. */
export async function probeGeminiOAuth(credsJson) {
  let home = null;
  try {
    home = await mkdtemp(join(tmpdir(), 'argo-gemini-probe-'));
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), credsJson, { mode: 0o600 });
    await writeGeminiTurnSettings(home, 'oauth-personal', null);
    const cmd = await geminiCmd(); // 실제 턴과 같은 해석(PATH>관리본>조달) — 프로브=런타임 동일 경로
    const r = await exec(cmd.file, [...cmd.args, '-p', 'reply with exactly: ok', '--approval-mode', 'auto_edit'], {
      timeout: 90_000, maxBuffer: 8e6,
      // 호스트에 API 키 env가 있으면 oauth 대신 그 키로 성공해 오탐 통과 — 이 프로브는 oauth만 본다
      env: { ...scrubServerSecrets(process.env, 'gemini'), ...homeEnv(home), GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
    }).then(
      (x) => ({ out: `${x.stdout}\n${x.stderr}`, failed: false }),
      (e) => ({ out: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`, failed: true }),
    );
    if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(r.out)) return { ok: false, reason: 'ineligible' };
    return r.failed ? { ok: null } : { ok: true };
  } catch {
    return { ok: null }; // 프로브 자체 실패(조달 불가 등) — 확정 불가는 관용(첫 턴이 정직한 안내로 받는다)
  } finally {
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/** 호스트 ~/.gemini 로그인의 사용 가능성 프로브 — "이 컴퓨터 로그인 사용" 옵트인 관문용. */
export async function probeGeminiHostOAuth() {
  const creds = await readFile(join(homedir(), '.gemini', 'oauth_creds.json'), 'utf8').catch(() => null);
  if (!creds) return { ok: null }; // 자격 부재 판정은 기존 detect가 담당
  return probeGeminiOAuth(creds);
}

export { geminiManagedEntry, geminiCmd, geminiTurnHome, writeGeminiTurnSettings }; // 러너 모듈 내부 공용(facade 미노출)
