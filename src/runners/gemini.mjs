// Gemini 러너 — CLI 자동 조달·격리 턴 홈·턴 settings(도구 게이팅)·OAuth 프로브.
// (runners.mjs 관심사 분리 2026-07-28)

import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, exists, homeEnv, scrubServerSecrets, seedAuthFile } from './shared.mjs';
import { openRoots } from '../workroots.mjs';
import { commandExists } from './codex.mjs'; // MCP command 실재 검사 — codex와 같은 규칙(러너 중립성) // 파일 반경 단일 진실(codex·gemini·antigravity 공유)

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
/** 회사 MCP → gemini settings.json `mcpServers` — 실프로브(0.21.2 `gemini mcp list`, 2026-08-21): 격리 HOME의
    settings.json에서 stdio({command,args,env})·http({httpUrl}) 둘 다 읽는다. 실행 파일 없는 command는
    codex와 같은 규칙으로 뺀다(있는 것만 싣고 로그). 비대화(-p) 턴에서 도구가 실제 호출되는지는 이 맥의
    gemini 계정 제약(GOOGLE_CLOUD_PROJECT 요구)으로 라이브 미확인 — 설정 해석까지가 실측이다. */
export function geminiMcpServers(mcpServers) {
  const out = {}; const skipped = [];
  for (const [name, def] of Object.entries(mcpServers ?? {})) {
    if (!def || typeof def !== 'object') continue;
    if (def.url && !def.command) { out[name] = { httpUrl: def.url, ...(def.headers ? { headers: def.headers } : {}) }; continue; }
    if (typeof def.command !== 'string' || !def.command.trim() || !commandExists(def.command)) { skipped.push(name); continue; }
    out[name] = { command: def.command, ...(Array.isArray(def.args) && def.args.length ? { args: def.args.map(String) } : {}), ...(def.env && typeof def.env === 'object' ? { env: def.env } : {}) };
  }
  if (skipped.length) console.warn(`[argo] gemini MCP 제외(실행 파일 없음): ${skipped.join(', ')}`);
  return out;
}

async function writeGeminiTurnSettings(home, authType, caps, workRoots = [], mcpServers = null) {
  const exclude = [];
  if (!caps?.browser) exclude.push('google_web_search', 'web_fetch'); // 웹 능력 OFF면 검색·페치 차단(광고·실행 방지)
  // 셸 제외를 해제했다(유건 지시 2026-08-21 "샌드박스 없이, 다른 러너도 동일하게") — 호출이
  // --approval-mode yolo로 바뀌어 "비대화에서 어차피 실행 불가"라는 제외 근거가 사라졌다.
  // fail-closed 유지(분리 검수 MED-2: 이 조건이 `caps && caps.shell === false`였을 땐 caps 미전달이
  // 셸 개방이라, 바로 아래 agy의 `caps?.shell ? [] : ['--sandbox']`와 정반대 방향이었다): caps가
  // 없거나 shell이 꺼져 있으면 감춘다. 실채팅·oneshot은 전권 caps를 명시 전달하므로 셸이 열리고,
  // caps를 안 넘기는 내부 프로브(probeGeminiOAuth)만 닫힌 채 남는다 — 의도.
  if (!caps || caps.shell === false) exclude.push('run_shell_command');
  exclude.push('save_memory'); // 기억은 vault가 단일 진실 — gemini 병행 기억(GEMINI.md) 차단
  const roots = openRoots(caps, workRoots); // codex writable_roots와 같은 계산(러너 중립성 단일 진실)
  await writeFile(join(home, '.gemini', 'settings.json'),
    // folderTrust off — 신형 CLI(0.51 실측)가 headless에서 미신뢰 폴더를 exit 55로 거절한다.
    // 격리 홈 + 워크스페이스 한정 실행이라 폴더 신뢰 게이트는 우리 쪽 권한 모델(caps)이 대신한다.
    // 구버전(0.21 실측)은 이 키를 무해하게 무시한다.
    // context.includeDirectories — 크루의 파일 반경(홈 + 지정 작업 폴더). **이게 없으면 gemini 크루의
    // 책상은 회사 폴더 하나**다: 벤더 도구(write-file·read-file)가 workspace 밖 경로를 거부해, codex
    // 크루는 되는 지시가 gemini 크루만 "허용된 작업 디렉토리 외부"로 거절된다(라이브 재현 2026-07-30).
    // 한계(정직 표기 — 검수 실증): 0.21.2는 settings·플래그 **두 채널 다 비대화(-p)에서 미적용**이다
    // — 합쳐진 값이 pendingIncludeDirectories에 갇히고 소비처가 대화형 UI 훅 하나뿐(useIncludeDirsTrust).
    // 상위 버전은 소스상 적용(addDirectories) 예상이나 개인 OAuth 차단(IneligibleTier)으로 라이브 미확인.
    // 그래도 이 채널을 쓰는 이유: 플래그와 달리 배열이라 콤마 폴더가 안 깨지고, 적용되는 버전에서
    // 반경이 열리며, 막히는 버전엔 프롬프트 캐비앗·거부 안내가 정직하게 받친다.
    JSON.stringify({
      security: { auth: { selectedType: authType }, folderTrust: { enabled: false } },
      tools: { exclude },
      ...(roots.length ? { context: { includeDirectories: roots } } : {}),
      ...(mcpServers ? { mcpServers: geminiMcpServers(mcpServers) } : {}),
    }), { mode: 0o600 }); // MCP env 토큰이 평문으로 실린다 — codex config.toml과 같은 근거
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
  const base = await probeGeminiOAuth(creds);
  if (base.ok === false) return base;
  // 구독 사용 가능성(#373 검수 HIGH-1) — 개인 OAuth 폐기와 별개로 라이선스 차단 계정을 관문에서 잡는다.
  // 호스트 파일이 만료면 판정 불가(ok:null 관용) — 기존과 동일.
  const sub = await probeGeminiSubscription(creds);
  if (sub.ok === false && sub.reason === 'gemini-license') return sub;
  return base;
}

export { geminiManagedEntry, geminiCmd, geminiTurnHome, writeGeminiTurnSettings }; // 러너 모듈 내부 공용(facade 미노출)

// ── cloudcode(Code Assist) 구독 프로브 — 연결 단계 사전 감지 (2026-08-31, 분리 검수 반영 개정) ──
// 배경: gemini oauth는 저장 관문이 개인 OAuth 폐기(probeGeminiOAuth)만 봐서, Code Assist를 쓸 수
// 없는 계정(워크스페이스 라이선스 없음 등)이 "연결됨"으로 저장되고 모든 턴이 벤더 403
// ("You do not have a valid license")으로만 죽었다(유건 제보 "Gemini 400" 계열 — 이 기기 실측).
// 판정은 loadCodeAssist **1콜·0토큰**: 검수(#373)가 라이브로 확인한 벤더 자기신호(ineligibleTiers)
// 를 쓴다 — 생성 호출·GCP 프로젝트 열람이 불필요하고(부작용·오귀속 제거), 프로젝트 선택에
// 의존하던 오거절 메커니즘(검수 #3)도 사라진다.
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com';
const CA_META = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
const CA_HEADERS = (tok) => ({
  Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json',
  'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1', 'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata': JSON.stringify(CA_META),
});

/** oauth_creds.json blob에서 유효 access_token을 꺼낸다(순수) — 만료·형식 불명은 null.
    갱신은 하지 않는다: 주 배선(웹 브리지 webauth.mjs)은 방금 교환한 신선 토큰이라 불필요하고,
    붙여넣기·API 경로의 만료 blob은 기존 관용(ok:null 저장)과 동일하게 둔다. 갱신이 필요해지면
    webauth.mjs의 gemini 클라이언트 상수(이미 추적됨)를 쓰면 된다 — gemini.mjs에 새 리터럴을
    추가하면 GitHub 푸시 보호가 base64까지 복호해 차단한다(2026-08-31 실측). */
export function geminiAccessToken(stored, now = Date.now()) {
  try {
    const d = JSON.parse(stored);
    const exp = Number(d?.expiry_date);
    if (d?.access_token && (!(exp > 0) || exp - now > 60_000)) return String(d.access_token);
    return null;
  } catch { return null; }
}

/** 구독(OAuth) 연결이 실제로 턴을 돌릴 수 있는가 — 연결 단계 판정(1콜·0토큰).
    반환 { ok: false, reason: 'auth' } 토큰 무효(401) /
        { ok: false, reason: 'gemini-license' } 이 계정의 구독 경로 성립 불가 확정 /
        { ok: null } 그 외 전부(관용 — 유효 자격 오거절 방지가 최우선 제약, glm verify 선례).
    'gemini-license' 확정 조건(둘 중 하나):
    · loadCodeAssist 403 + "valid license" 문구(관리자 미배정 라이선스 — 실측 생성 403과 같은 문구)
    · 200인데 관리형 프로젝트 없음 + free-tier가 UNSUPPORTED_CLIENT로 부적격 + free-tier 허용도
      없음 — 관리형 발급 경로가 벤더 단에서 막힌 형태(이 기기 라이브 실측 바디 그대로).
      free-tier가 allowedTiers에 있으면 미온보딩 개인 계정이므로 차단하지 않는다(오거절 방지). */
export async function probeGeminiSubscription(stored, fetchImpl = fetch) {
  try {
    const tok = geminiAccessToken(stored);
    if (!tok) return { ok: null };
    const lr = await fetchImpl(`${CODE_ASSIST}/v1internal:loadCodeAssist`, {
      method: 'POST', headers: CA_HEADERS(tok), body: JSON.stringify({ metadata: CA_META }),
      signal: AbortSignal.timeout(12_000),
    });
    if (lr.status === 401) return { ok: false, reason: 'auth' };
    if (lr.status === 403) {
      // 403은 인증 통과 후의 권한 오류다 — "재발급" 오안내 금지(검수 #2). 라이선스 문구일 때만 확정.
      const body = await lr.text().catch(() => '');
      return /valid license/i.test(body) ? { ok: false, reason: 'gemini-license' } : { ok: null };
    }
    if (!lr.ok) return { ok: null };
    const lb = await lr.json().catch(() => ({}));
    const project = typeof lb?.cloudaicompanionProject === 'string' ? lb.cloudaicompanionProject : lb?.cloudaicompanionProject?.id;
    if (project) return { ok: null }; // 관리형 프로젝트 보유 — 차단 근거 없음(생성 검증은 하지 않는다)
    const freeBlocked = (lb?.ineligibleTiers ?? []).some((t) => t?.tierId === 'free-tier' && t?.reasonCode === 'UNSUPPORTED_CLIENT');
    const freeAllowed = (lb?.allowedTiers ?? []).some((t) => t?.id === 'free-tier');
    if (freeBlocked && !freeAllowed) return { ok: false, reason: 'gemini-license' };
    return { ok: null };
  } catch { return { ok: null }; }
}
