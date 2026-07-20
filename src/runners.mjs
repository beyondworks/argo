// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).
import { access, copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { WS_ROOT, paths } from './workspace.mjs';
import { monthCostByRunner } from './usage.mjs'; // usage는 workspace만 의존 — 순환 없음

const execP = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);

/** execFile + stdin 즉시 닫기 — CLI가 stdin을 물고 대기하는 행을 차단한다(코덱스 300초 행의 원인). */
function exec(cmd, args, opts) {
  const p = execP(cmd, args, opts);
  p.child.stdin?.end();
  return p;
}

/* ─── GUI 기동 PATH 보강 ───
   데스크톱(tauri sidecar)은 GUI 최소 PATH(/usr/bin:/bin:…)로 뜬다 — homebrew/npm 전역으로 설치한
   codex/gemini CLI를 감지(detectRunners)도 실행(externalExec)도 못 한다(실사용 신고 2026-07-19:
   "codex 연결됨인데 안 됨" = hostInstalled 오탐 + spawn ENOENT의 뿌리). 터미널 기동(웹 dev/상주)은
   이미 PATH에 있어 no-op. ① 표준 경로 정적 병합(동기) ② macOS는 로그인 셸 PATH 1회 캡처(비동기,
   VS Code 방식). Windows는 GUI PATH = 사용자 PATH라 불필요(구분자 ';'라 병합도 건너뛴다). */
const mergePath = (dirs) => {
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean);
  const add = dirs.filter((d) => d.startsWith('/') && !cur.includes(d));
  if (add.length) process.env.PATH = [...cur, ...add].join(':');
};
if (process.platform !== 'win32') {
  mergePath(['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin')]);
}
let cliPathP = null; // 프로세스당 1회 — 실패해도 정적 병합만으로 진행(설치 후엔 앱 재시작 안내가 관례)
function ensureCliPath() {
  if (process.platform !== 'darwin') return Promise.resolve();
  // 플래그는 분리해 전달 — fish 등 결합 단축(-ilc)을 거부하는 셸에서도 동작(zsh/bash/fish/sh 공통)
  return (cliPathP ??= execP(process.env.SHELL?.trim() || '/bin/zsh', ['-i', '-l', '-c', 'echo "::ARGO_PATH::$PATH::ARGO_PATH::"'], { timeout: 5000 })
    .then(({ stdout }) => {
      // rc 파일이 stdout에 내는 잡음과 분리하기 위해 마커 사이만 취한다
      const m = String(stdout).match(/::ARGO_PATH::(.*?)::ARGO_PATH::/s);
      if (m) mergePath(m[1].split(':').map((s) => s.trim()).filter(Boolean));
    }, () => { /* 셸 실패·타임아웃 — 정적 병합으로 충분한 환경이 대부분 */ }));
}

/* ─── 서버 시크릿 세척 (P1-6) ───
   테넌트 에이전트가 spawn하는 자식(외부 러너 CLI·SDK가 띄우는 Bash/MCP)에 크로스테넌트 크라운주얼이
   상속되면, 프롬프트 인젝션이 `printenv` 한 번으로 그 값을 유출할 수 있다. SUPABASE_SERVICE_ROLE_KEY는
   RLS를 우회해 모든 테넌트 데이터를 여는 열쇠라 유출 = 전면 침해. 자식 env에서 제거한다.
   러너 자신의 모델 키(ANTHROPIC/GLM/OPENAI/GEMINI)는 러너 동작에 필요하므로 보존(denylist).
   ⚠ 방어심층이지 완전한 경계가 아니다 — 자식이 /proc/<ppid>/environ으로 부모 워커 env를 직접 읽을 수 있다.
      근본 해법은 서비스 키를 에이전트 워커 밖 별도 신뢰 서비스로 분리하는 것(로드맵). 론칭 전 키 회전 권장. */
const EXPLICIT_SERVER_SECRETS = new Set(['SUPABASE_SERVICE_ROLE_KEY']);
const SERVER_SECRET_RE = /(SERVICE_ROLE|_SECRET$|_SECRET_|DATABASE_URL|PRIVATE_KEY|WEBHOOK_SECRET|SESSION_SECRET|JWT_SECRET)/i;
export const isServerSecretKey = (k) => EXPLICIT_SERVER_SECRETS.has(k) || SERVER_SECRET_RE.test(k);
/** 제공사 인증 변수 소유권 — 어느 러너가 어떤 인증 env를 정당하게 쓰는가.
    실행 러너 외 제공사 키가 자식(외부 CLI·SDK가 띄우는 Bash/MCP)에 상속되면, 러너 하나가 프롬프트
    인젝션에 뚫릴 때 printenv 한 번으로 '다른' 제공사 자격까지 한꺼번에 유출된다(감사 2026-07-20 —
    크로스 러너 폭발 반경). ANTHROPIC_AUTH_TOKEN은 Anthropic 호환 프로토콜 공용(claude·glm·kimi). */
const PROVIDER_AUTH_OWNERS = {
  ANTHROPIC_API_KEY: ['claude'],
  CLAUDE_CODE_OAUTH_TOKEN: ['claude'],
  ANTHROPIC_AUTH_TOKEN: ['claude', 'glm', 'kimi'],
  OPENAI_API_KEY: ['codex'],
  GEMINI_API_KEY: ['gemini'],
  GOOGLE_API_KEY: ['gemini'],
  GLM_API_KEY: ['glm'],
  KIMI_API_KEY: ['kimi'],
};
/** 서버 시크릿(+실행 러너 외 제공사 키)을 제거한 env 사본. runner 미지정 = 서버 시크릿만(기존 동작).
    runner 지정 = 그 러너 소유가 아닌 제공사 인증 변수도 제거 — 크로스 러너 키 상속 차단. (export: 회귀 테스트용) */
export function scrubServerSecrets(env = process.env, runner = null) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (isServerSecretKey(k)) continue;
    if (runner && PROVIDER_AUTH_OWNERS[k] && !PROVIDER_AUTH_OWNERS[k].includes(runner)) continue;
    out[k] = v;
  }
  return out;
}

/** 키 형태 마스킹(방어심층) — 에러·로그에 실릴 문자열에서 벤더 키 패턴을 가린다.
    chat.mjs SDK 실패 경로와 아래 apiError(외부 CLI 실패 경로)가 공유 — 한쪽만 마스킹하면
    CLI stderr의 키 조각이 동기화되는 이벤트 로그(events.jsonl)에 영속된다(감사 2026-07-20). */
export const maskKeyLike = (s) => String(s).replace(/\b(sk-ant-[\w-]+|sk-[\w-]{16,}|AIza[\w-]{20,})\b/g, 'sk-***');

/** 실패 출력에서 API 에러 메시지만 뽑는다 — 이벤트 로그에 명령·프롬프트 전문을 흘리지 않는다.
    키 패턴은 마스킹(벤더 401 바디의 "Incorrect API key provided: sk-…" 류가 그대로 영속되지 않게). */
function apiError(e) {
  const raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  // 구글이 개인 무료 OAuth(Code Assist for individuals)를 신형 CLI에서 차단(실측 2026-07-20:
  // 번들판 0.36~0.51 전부 IneligibleTierError, 구형 0.21만 통과 — 서버측 판정이라 버전 고정 우회는 시한부).
  // 영어 스택트레이스 대신 대안이 담긴 안내로 번역한다.
  if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(raw)) {
    return new Error('구글이 Gemini 개인 OAuth(무료 Code Assist) 지원을 최신 CLI에서 중단했습니다. '
      + '설정 → AI 연결에서 Gemini를 API 키로 다시 연결해 주세요(Google AI Studio에서 무료 발급). '
      + 'Google policy now blocks personal OAuth on current Gemini CLI — reconnect Gemini with an API key.');
  }
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return new Error(maskKeyLike(m ? m[1] : `러너 실행 실패 (exit ${e.code ?? '?'}): ${String(e.stderr ?? e.message).replace(/\s+/g, ' ').slice(-160)}`));
}

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

/** 러너별 모델 카탈로그 — id '' = 그 러너의 기본 모델. 라벨은 고유명사라 언어 공통. */
export const RUNNERS = {
  claude: {
    name: 'Claude Code', kind: 'sdk',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  codex: {
    name: 'Codex', kind: 'cli',
    models: [
      // GPT-5.6 패밀리(2026-07-09) — Sol(플래그십)·Terra(중간)·Luna(경량). sol id는 로컬 codex 설정으로 실증
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
  },
  gemini: {
    name: 'Gemini', kind: 'cli',
    models: [
      // 실측(2026-07-19): OAuth(Code Assist) 경로 실턴 통과 = 2.5 Pro/Flash. 3.x id는 실존하나
      // (gemini-cli 공식 문서 get-started/gemini-3) Google AI Ultra 구독·유료 계정에만 개방 —
      // 무료 로그인 계정은 "Requested entity was not found"로 턴이 죽는다(실사용 신고 재현·원인 확정).
      // 카탈로그 규칙: 실행 경로 실턴 통과 id만 — 문서만 보고 추가 금지. 단, 접근권 게이트 모델은
      // gated:true(모델 메뉴 배지 표시) + 채팅 런타임 강등 가드(chat.mjs GATED_MODEL_ERR_RE —
      // 기본 모델 1회 자동 재시도) 전제로 허용한다. 첫 항목은 무권한 계정도 도는 모델일 것
      // (러너 전환 시 models[0]이 기본 선택되므로 게이트 모델을 앞에 두면 무료 계정이 이유 없이 죽는다).
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', gated: true },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', gated: true },
    ],
  },
  kimi: {
    name: 'Kimi', kind: 'sdk-compat',
    models: [
      // platform.kimi.ai 모델 문서(2026-07 확인) — K3가 플래그십(1M 컨텍스트), K2.7-code는 코딩 특화
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    ],
  },
  glm: {
    name: 'GLM', kind: 'sdk-compat',
    models: [
      // docs.z.ai(2026-06-13 출시) — 5.2가 플래그십(1M 컨텍스트)
      { id: 'glm-5.2', label: 'GLM-5.2' },
      { id: 'glm-5.1', label: 'GLM-5.1' },
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
    ],
  },
};

/** "이 컴퓨터 로그인 사용" 옵트인 허용 여부 — runnerStatus·저장(PUT) 라우트가 공유(단일 판정).
    codex/gemini(파일 자격)는 환경 무관. claude(키체인)는 SDK가 키체인을 열 수 있는 non-standalone에서만
    — 데스크톱 번들(ARGO_STANDALONE)은 재서명 node가 키체인에 막혀 회귀를 내므로 제외(setup-token이 정식). */
export const hostOptInAllowed = (runner) =>
  !!RUNNER_AUTH[runner]?.hostUsable
  && !process.env.ARGO_TENANT_OWNER // 다중테넌트 호스팅에선 운영자 CLI 로그인을 테넌트가 빌리지 못하게(setupOneClick과 대칭, 검수 LOW)
  && (runner !== 'claude' || process.env.ARGO_STANDALONE !== '1');

export const GLM_DEFAULT_MODEL = 'glm-5.2';
export const KIMI_DEFAULT_MODEL = 'kimi-k3';
/** Kimi(Moonshot) — GLM과 동일한 Anthropic 호환 엔드포인트 방식(SDK가 그대로 탄다).
    베이스: api.moonshot.ai/anthropic (Claude Code 연동 공식 경로, 2026-07 문서 확인). */
export const kimiEnv = () => ({
  ...scrubServerSecrets(process.env, 'kimi'),
  ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic',
  ANTHROPIC_AUTH_TOKEN: process.env.KIMI_API_KEY ?? '',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', // claude 분기와 대칭 — Anthropic 구독 토큰이 제3자 향 턴에 남지 않게(감사 2026-07-20)
});
export const glmEnv = () => ({
  ...scrubServerSecrets(process.env, 'glm'),
  ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: process.env.GLM_API_KEY ?? '',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', // claude 분기와 대칭(감사 2026-07-20)
});

/** 설치·인증 감지 — 각 CLI의 로그인 산출물(OAuth 크리덴셜 파일)을 본다. 60초 캐시.
    force=true는 캐시 우회 — host 옵트인 클릭처럼 "지금 이 순간"의 로그인 검증이 목적인 경로용
    (감사 2026-07-20: 방금 `codex login`을 마친 사용자가 페이지 로드 때 예열된 authed:false 캐시에
    최대 60초간 오거절되던 함정 — 신선도가 정확성보다 싼 캐시를 검증 경로에 쓰면 안 된다). */
let cache = null;
let cacheAt = 0;
export async function detectRunners(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  await ensureCliPath(); // GUI 기동 PATH 보강 — homebrew/npm 전역 CLI 오탐 방지
  const home = homedir();
  const [codexV, codexManaged, geminiV, geminiManaged, codexAuth, geminiAuth, claudeCredFile, claudeCfgLogin] = await Promise.all([
    exec('codex', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(codexManagedBin()),    // 관리본(자동 조달)도 설치로 취급 — PATH 없이도 돈다
    exec('gemini', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(geminiManagedEntry()),
    exists(join(home, '.codex', 'auth.json')),
    exists(join(home, '.gemini', 'oauth_creds.json')),
    // 리눅스 — 파일 보관(macOS도 키체인 불가 환경은 이 파일 폴백이라 무시하면 역회귀).
    // ⚠ 스테일 잔재가 authed 오탐을 낼 수 있다(실사용 2026-07-19: 죽은 Claude 흔적이 유효한 Codex를
    // 밀어내고 "Not logged in"으로 턴 사망) — 그 케이스는 chat/runOneShot의 인증 오류 자가 치유
    // (다른 가용 러너 1회 재시도)가 회수한다. 감지 단계에서 유효성까지는 판정하지 않는다.
    exists(join(home, '.claude', '.credentials.json')),
    // macOS/Windows — OAuth 토큰은 키체인/OS 보관이라 .claude.json의 로그인 계정 기록(oauthAccount)으로
    // 판정한다. 파일 존재만으론 안 됨: 로그인 없이 CLI가 실행만 돼도(번들 SDK 포함) 생성된다 — 미로그인
    // 기기가 설정에서 "연결중 · 이 컴퓨터 로그인"으로 오표시되고 턴은 Not logged in으로 죽던 원인.
    readFile(join(home, '.claude.json'), 'utf8')
      .then((s) => !!JSON.parse(s)?.oauthAccount?.accountUuid, () => false),
  ]);
  const claudeCred = claudeCredFile || claudeCfgLogin;
  cache = {
    claude: { installed: true, authed: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || claudeCred) },
    codex: { installed: !!codexV || codexManaged, authed: (!!codexV || codexManaged) && codexAuth }, // gemini와 대칭 — 관리본도 로그인 파일을 상속해 돈다
    gemini: { installed: !!geminiV || geminiManaged, authed: (!!geminiV || geminiManaged) && (geminiAuth || !!process.env.GEMINI_API_KEY) },
    glm: { installed: true, authed: !!process.env.GLM_API_KEY },
    kimi: { installed: true, authed: !!process.env.KIMI_API_KEY }, // env 주입 = 운영자 명시 옵트인(glm 관례)
  };
  cacheAt = Date.now();
  return cache;
}

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

/** codex 격리홈 — 'clean'이면 auth.json 심링크 없이(회사 API키 모드), 아니면 호스트 로그인 상속. */
async function codexHomeClean() {
  const dir = join(homedir(), '.argo', 'codex-home-apikey');
  await mkdir(dir, { recursive: true });
  if (!(await exists(join(dir, 'config.toml')))) {
    await writeFile(join(dir, 'config.toml'), '# Argo API키 모드 — 계정 로그인 미상속\n').catch(() => {});
  }
  return dir;
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
export const codexSandboxArgs = (caps) => [
  ...(caps?.fs ? ['-c', 'sandbox_workspace_write.writable_roots=["/"]'] : []),
  ...(caps?.browser ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
];

/** 외부 CLI 러너 1턴 — 워크스페이스를 cwd로, 프롬프트 하나로 실행하고 마지막 응답을 받는다.
    cred = runnerCredEnv 결과({ env, home }) — 회사 자격이 있으면 그 env를 주입(API키/OAuth). 없으면 호스트 로그인.
    caps = 회사 로컬 능력({ fs, browser, shell }) — 사장이 켠 능력을 codex 샌드박스에 반영(codexSandboxArgs). */
export async function externalExec({ runner, model, cwd, prompt, timeoutMs = 300_000, cred = null, signal = null, caps = null }) {
  await ensureCliPath(); // GUI 기동 PATH 보강 — 아래 env 스냅샷(scrubServerSecrets)보다 먼저
  if (runner === 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'argo-codex-'));
    const out = join(dir, 'last.txt');
    // 회사 API키 모드면 깨끗한 홈(계정 OAuth 무시), 아니면 호스트 로그인 상속
    const CODEX_HOME = cred?.home === 'clean' ? await codexHomeClean()
      : cred?.home ? cred.home // 회사 OAuth 격리 홈(웹 브리지)
      : await codexHome();     // 호스트 로그인 상속
    const cmd = await codexCmd(); // PATH 설치본 > 관리본 > 즉석 조달 — 사용자 설치 없이도 돈다
    try {
      await exec(cmd.file, [
        ...cmd.args,
        'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
        ...codexSandboxArgs(caps),
        '--output-last-message', out,
        ...(model ? ['-m', model] : []),
        '--', prompt, // 프롬프트가 '---'(카드 frontmatter)로 시작해도 플래그로 오해하지 않도록
      ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env, 'codex'), ...(cred?.env ?? {}), CODEX_HOME } })
        .catch((e) => { throw apiError(e); });
      return (await readFile(out, 'utf8')).trim();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (runner === 'gemini') {
    // 회사/host 자격이면 격리 HOME — 이번 턴 settings.json(인증 방식 + caps 도구 게이팅)을 매 턴 쓴다.
    // (자격 없는 경로는 명시 연결 원칙상 도달 안 하지만, 도달 시 호스트 HOME으로 폴백 — 도구 게이팅 없음)
    if (cred?.home && cred?.authType) await writeGeminiTurnSettings(cred.home, cred.authType, caps);
    const cmd = await geminiCmd(); // PATH 설치본 > 관리본 > 즉석 조달 — 사용자 설치 없이도 돈다
    const { stdout } = await exec(cmd.file, [
      ...cmd.args,
      '-p', prompt,
      ...(model ? ['-m', model] : []),
      '--approval-mode', 'auto_edit', // 편집류만 자동 승인 — 셸 등은 비대화 모드에서 실행되지 않는다
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env, 'gemini'), ...(cred?.env ?? {}) } })
      .catch((e) => { throw apiError(e); });
    return stdout
      .replace(/^(Loaded cached credentials\.|Data collection is .*|\[STARTUP\].*|\[dotenv.*)\s*$/gim, '')
      .trim();
  }
  throw new Error(`알 수 없는 외부 러너: ${runner}`);
}

// ── 회사별 러너 자격(BYOK/BYOA) — 일반 사용자가 호스트 CLI 로그인 없이도 어떤 러너든 굴리게 한다.
// 회사 루트 .secrets.json의 runners.{id} = { type:'apikey'|'oauth', value } 에 보관.
// 시크릿이므로 (a) API 응답·로그엔 마스킹만, (b) cryptoOn이면 봉투 암호문으로 동기화됨(secretbox).
/** 계정 스코프 — 회사 생성 전(온보딩)에 연결한 러너 자격의 저장 대상. **사용자별로 격리**한다.
    파일: WS_ROOT/.account-secrets-{uid}.json (uid = 인증 사용자 id, 로컬 무인증 모드는 'local').
    .sync-credentials.json과 같은 계층 — 워크스페이스 동기화 제외, 기기 로컬.
    격리 불변식: 회사 자격(회사 .secrets.json)은 guardCompany의 ownerId로 교차접근이 막히지만
    계정 자격은 회사 이전 스코프라 그 가드가 없다. 그래서 파일 자체를 uid로 나눠, 공유 WS_ROOT +
    다중 쿠키 사용자 배포(AUTH_ON·非TENANT·기기세션 없음)에서도 A의 자격이 B에게 시드되지 않게 한다.
    '@'는 paths()의 wsId 검증(WS_ID_RE)을 통과하지 않아 일반 워크스페이스와 충돌하지 않는다. */
const ACCOUNT_PREFIX = '@account:';
/** uid를 파일명 안전 형태로 — supabase user.id(UUID)·'local'만 허용, 이상값은 'local'로 격리(경로 탈출 차단). */
const safeUid = (uid) => (/^[a-z0-9-]{1,64}$/.test(String(uid ?? '').toLowerCase()) ? String(uid).toLowerCase() : 'local');
/** 계정 스코프 토큰 — 라우트가 currentUser().id(또는 로컬 'local')로 만들어 저장/조회 함수에 wsId 자리로 넘긴다. */
export const accountScope = (uid) => `${ACCOUNT_PREFIX}${safeUid(uid)}`;
const isAccountScope = (wsId) => typeof wsId === 'string' && wsId.startsWith(ACCOUNT_PREFIX);
const secretsFile = (wsId) => {
  if (isAccountScope(wsId)) {
    const uid = safeUid(wsId.slice(ACCOUNT_PREFIX.length)); // accountScope를 안 거친 직접 호출도 재검증
    return join(WS_ROOT, `.account-secrets-${uid}.json`);
  }
  return join(paths(wsId).root, '.secrets.json');
};

// 러너별 지원 인증 방식. apikey=붙여넣기(4러너 공통), oauth=붙여넣기 토큰(claude) 또는 호스트 로그인(codex/gemini).
// glm은 Anthropic 호환 토큰(사실상 apikey)만.
// connect: 벤더 CLI의 브라우저 로그인을 서버가 대신 실행할 수 있는 러너(로컬/데스크톱 전용).
//   bin/loginArgs=로그인 실행, statusArgs=읽기전용 상태확인, ok=로그인됨 판정 정규식.
//   codex만 spawn 가능한 login이 있다. claude는 이 CLI에 login 서브커맨드가 없어(구독은 키체인)
//   oauthPasteable 토큰 붙여넣기로, gemini는 CLI 설치 후 로그인 안내로 대체한다.
export const RUNNER_AUTH = {
  // claude 웹 브리지(webConnect)는 철회(2026-07-18) — 구세대 엔드포인트 교환이 러너가 거절하는
  // 비 oat01 토큰을 저장해 "연결됨인데 전 턴 401"을 만들었다(실측). CLAUDE_CODE_OAUTH_TOKEN은
  // 공식 규격상 `claude setup-token`으로만 발급 — UI는 붙여넣기 안내로 일원화(WEB_OAUTH 주석 참조).
  // claude hostUsable: "이 컴퓨터 로그인 사용" 옵트인 지원. 단 codex/gemini(파일 자격)와 달리 claude는
  // 키체인 보관이라, SDK가 그 키체인을 열 수 있는 환경에서만 유효하다 — 일반 node(상주/웹/dev)에서는
  // SDK query()가 호스트 Claude Code 로그인으로 인증됨을 실측(2026-07-19). 데스크톱 번들(ARGO_STANDALONE)의
  // 재서명 node는 키체인 ACL이 막아 "Not logged in" 회귀를 낸 전례가 있어, claude host는 non-standalone에서만
  // 노출한다(claudeHostAllowed). 데스크톱은 setup-token 원클릭이 정식 경로.
  claude: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-ant-', oauthPrefix: 'sk-ant-oat01-', oauthPasteable: true, oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', hostUsable: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  codex: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-', oauthPasteable: false, webConnect: true, hostUsable: true, keyUrl: 'https://platform.openai.com/api-keys', connect: { bin: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'], ok: /Logged in/i } },
  gemini: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, webConnect: true, hostUsable: true, keyUrl: 'https://aistudio.google.com/apikey' },
  glm: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  kimi: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://platform.moonshot.ai/console/api-keys' }, // 접두사 무차단(GLM 관례) — 리전·미래 키 형식 변화에 저장이 막히지 않게, 판정은 verifyRunnerCred가
};

// 레거시 계정 파일(사용자 스코프 도입 전 무스코프 .account-secrets.json) → local 스코프로 1회 이관.
// accountScope('local') 로드 때만 트리거되므로 로컬 무인증 모드에서만 실행된다(인증 모드의 무스코프
// 파일은 소유자 불명이라 건드리지 않는다 — 그 경우 재연결 유도). 프로세스당 1회.
let legacyAccountMigrated = false;
async function migrateLegacyAccountFile() {
  if (legacyAccountMigrated) return;
  legacyAccountMigrated = true;
  const legacy = join(WS_ROOT, '.account-secrets.json');
  const scoped = join(WS_ROOT, '.account-secrets-local.json');
  if ((await exists(legacy)) && !(await exists(scoped))) await rename(legacy, scoped).catch(() => {});
}

async function loadSecrets(wsId) {
  if (wsId === accountScope('local')) await migrateLegacyAccountFile();
  // 자격(키·토큰)은 유실이 치명적 — 손상 시 조용히 호스트 계정으로 폴백(오과금)하지 않고
  // readJson이 .corrupt 백업 후 throw(1회 명시 실패 → 다음 로드는 빈 상태로 자가치유, UI엔 미연결로 노출)
  const s = await readJson(secretsFile(wsId), {});
  // 레거시 마이그레이션: 옛 { claude:"key" } → runners.claude.{apikey}
  if (typeof s.claude === 'string' && s.claude.trim() && !s.runners?.claude) {
    s.runners = { ...(s.runners ?? {}), claude: { type: 'apikey', value: s.claude.trim() } };
  }
  if (!s.runners) s.runners = {};
  return s;
}

/** 회사에 저장된 러너 자격 — { type, value } | null. */
/** 자격 type 정규화 — 'apikey' | 'oauth' | 'host'. host = "이 컴퓨터 CLI 로그인 사용" 명시 옵트인 마커
    (codex/gemini 전용 — 파일 기반 자격이라 앱이 읽을 수 있다. claude는 키체인이라 앱 접근이 불안정해 미제공).
    자동 스캐빈징 금지(유건 지시 2026-07-19): 호스트 로그인은 감지돼도 사장이 이 마커로 옵트인해야만 쓴다. */
const credType = (t) => (t === 'oauth' ? 'oauth' : t === 'host' ? 'host' : 'apikey');

export async function loadRunnerCred(wsId, runner) {
  const c = (await loadSecrets(wsId)).runners?.[runner];
  return c && typeof c.value === 'string' && c.value.trim() ? { type: credType(c.type), value: c.value.trim() } : null;
}

/** 러너 자격 저장 — 원자적. 다른 러너·필드는 보존. 레거시 claude 필드는 정리. */
export async function saveRunnerCred(wsId, runner, type, value) {
  if (!RUNNER_AUTH[runner]) throw new Error('알 수 없는 러너');
  const s = await loadSecrets(wsId);
  const { claude, ...rest } = s; // 레거시 평문 필드 제거
  rest.runners = { ...rest.runners, [runner]: { type: credType(type), value: String(value).trim() } };
  await writeJsonAtomic(secretsFile(wsId), rest);
  // 격리 홈 리셋 — 재연결 시 이전 토큰 파일이 새 자격을 가리지 않게(runnerCredEnv가 재생성).
  // 계정 스코프엔 실행 홈이 없다(온보딩 저장용 — 실행은 회사 wsId로) — 스킵.
  if (!isAccountScope(wsId)) {
    if (runner === 'codex') await rm(join(homedir(), '.argo', `codex-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
    if (runner === 'gemini') await rm(join(homedir(), '.argo', `gemini-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
  }
  // 연결 즉시 실행기 워밍업 — 첫 턴이 다운로드를 기다리지 않게(백그라운드, 실패는 턴 시점 조달이 재시도).
  // 모든 연결 경로(회사 키·계정 키·웹 브리지)가 이 함수를 지나므로 여기가 단일 관문이다.
  if (runner === 'gemini') provisionGeminiCli().catch(() => {});
  if (runner === 'codex') provisionCodexCli().catch(() => {}); // ~100MB — 연결 시점에 미리 받아 첫 턴 대기 제거
}

/** 러너 자격 제거 — 다른 러너는 유지. */
export async function clearRunnerCred(wsId, runner) {
  const s = await loadSecrets(wsId);
  const { claude, ...rest } = s;
  if (rest.runners) delete rest.runners[runner];
  await writeJsonAtomic(secretsFile(wsId), rest);
}

/** 온보딩 시드 — 회사 생성 전 그 사용자의 계정 스코프에 연결한 자격을 새 회사로 복사한다.
    uid = 회사를 만든 사용자(로컬 모드 'local'). 계정 자격은 남겨 다음 회사도 시드받는다(온보딩 1회 = 전 회사 혜택).
    회사에 이미 있는 러너는 덮지 않는다. */
export async function seedRunnerCreds(wsId, uid) {
  const acct = await loadSecrets(accountScope(uid)).catch(() => ({ runners: {} }));
  let seeded = 0;
  for (const [id, c] of Object.entries(acct.runners ?? {})) {
    if (!RUNNER_AUTH[id] || typeof c?.value !== 'string' || !c.value.trim()) continue;
    if (await loadRunnerCred(wsId, id)) continue;
    await saveRunnerCred(wsId, id, c.type, c.value);
    seeded += 1;
  }
  return seeded;
}

/** 마스킹 — 접두사만(보안 규칙). 평문은 어디에도 남기지 않는다. */
export const maskCred = (v) => (v ? `${v.slice(0, 6)}***` : '');

/** 격리 홈 자격 파일 시드 — "어느 원본으로 시드했나"를 마커(.argo-seed-<name>)에 해시로 남겨,
    원본이 바뀌면(타 기기 재연결이 동기화로 도착, 호스트 재로그인 등) 파일을 재시드한다.
    write-if-absent만으로는 동기화된 새 자격이 영영 주입되지 않았다(감사 2026-07-20: 기기 B가 죽은
    토큰으로 계속 실행되는데 UI는 '연결됨'). CLI가 갱신해 쓴 토큰은 원본이 그대로인 한 보존된다
    (마커는 원본 해시 — 갱신 보존이라는 write-if-absent의 원래 목적 유지).
    adopt=true: 마커 없는 기존 홈은 현재 파일을 그대로 채택하고 마커만 기록(마이그레이션 —
    회전됐을 수 있는 갱신 토큰을 구본으로 덮어 단일 기기 사용자를 깨지 않기 위함. 이미 갭이
    발현된 홈은 재연결 1회로 해소). host 모드는 adopt=false — 호스트가 항상 단일 진실. */
async function seedAuthFile(dir, name, content, { adopt = true } = {}) {
  const file = join(dir, name);
  const marker = join(dir, `.argo-seed-${name}`);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 32);
  const cur = await readFile(marker, 'utf8').catch(() => null);
  const has = await exists(file);
  if (cur === hash && has) return false;
  if (adopt && cur === null && has) { await writeFile(marker, hash, { mode: 0o600 }); return false; }
  await writeFile(file, content, { mode: 0o600 });
  await writeFile(marker, hash, { mode: 0o600 });
  return true;
}

/** 붙여넣은 자격 정규화 — 키·토큰은 공백·개행을 절대 포함하지 않으므로 내부 혼입분을 제거한다.
    터미널 80칸에서 108자 setup-token은 줄바꿈돼 보이고, 복사 방식에 따라 개행이 값에 섞인다
    (실사용 2026-07-20 신고: 접두사는 멀쩡해 형식검사를 통과 → 검증만 거절 → '저장만'이 깨진 토큰을
    '연결됨'으로 저장 → 전 턴 API 오류). 유효 토큰의 검증 통과는 실측 확인(키체인 토큰 200).
    JSON 블롭('{' 시작 — codex/gemini oauth 내부 형식)은 trim만(문자열 값 보존). (export: 회귀 테스트용) */
export const normalizePastedCred = (value) => {
  const s = String(value ?? '').trim();
  return s.startsWith('{') ? s : s.replace(/\s+/g, '');
};

/** 러너 실행에 주입할 env(부분) — 회사 자격이 있으면 러너 종류에 맞는 변수로. 없으면 null(호스트 자격 폴백=회귀 0).
    반환: { env, home } — env=주입 변수 dict, home=codex 격리홈 오버라이드('clean'=계정 로그인 무시하고 API키 사용). */
export async function runnerCredEnv(wsId, runner) {
  const cred = await loadRunnerCred(wsId, runner);
  if (!cred) return null;
  // gemini는 host 옵트인도 격리 HOME으로 실행한다(아래 geminiTurnHome) — codex(CODEX_HOME)·SDK(settingSources:[])와
  // 달리 gemini는 HOME 전역 config(GEMINI.md·save_memory·전 도구)를 상속해 테넌트 격리가 없었다. host는 로그인만 빌리고
  // 나머지는 격리한다. 그래서 아래 일반 host→null 분기보다 먼저 처리한다.
  if (runner === 'gemini') {
    const g = await geminiTurnHome(wsId, cred);
    if (!g) return null; // host인데 호스트 로그인이 없음 — 폴백 없음(명시 연결 원칙)
    return { env: { HOME: g.home, ...g.env }, home: g.home, authType: g.authType };
  }
  // host 마커 — 이 컴퓨터 CLI 로그인 경로(codexHome 상속 등)를 명시 옵트인으로 사용. env 주입 없음.
  if (cred.type === 'host') return null;
  const v = cred.value;
  if (runner === 'claude') {
    return cred.type === 'oauth'
      ? { env: { CLAUDE_CODE_OAUTH_TOKEN: v, ANTHROPIC_API_KEY: '' } }
      : { env: { ANTHROPIC_API_KEY: v, CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'glm') {
    // CLAUDE_CODE_OAUTH_TOKEN 명시 소거 — claude 분기와 대칭. Anthropic 구독 토큰이 제3자(z.ai) 향
    // 턴 env에 남으면 자식 프로세스에서 열람 가능(감사 2026-07-20 — scrub 러너 인자와 벨트앤서스펜더).
    return { env: { ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'kimi') {
    return { env: { ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'codex') {
    // apikey면 계정 OAuth를 무시하고 OPENAI_API_KEY로 — 격리홈을 '깨끗한' 것으로 써 auth.json 상속 차단.
    if (cred.type === 'apikey') return { env: { OPENAI_API_KEY: v }, home: 'clean' };
    // 회사 OAuth(웹 브리지) — 저장된 auth.json을 회사별 격리 CODEX_HOME에 풀어 CLI가 읽게 한다.
    // CLI가 토큰을 갱신하면 이 파일에 다시 쓴다(다음 턴도 같은 홈을 쓰므로 이어진다).
    const dir = join(homedir(), '.argo', `codex-home-${wsId}`);
    await mkdir(dir, { recursive: true, mode: 0o700 }); // OAuth 토큰 보관 — 소유자만
    await seedAuthFile(dir, 'auth.json', v); // 저장 자격이 바뀌면(동기화 포함) 재시드 — CLI 갱신분은 보존
    if (!(await exists(join(dir, 'config.toml')))) await writeFile(join(dir, 'config.toml'), '# Argo 회사 자격 codex 홈\n');
    return { env: {}, home: dir };
  }
  return null;
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
    return { home, authType: 'oauth-personal', env: {} };
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
    return { home, authType: 'oauth-personal', env: {} };
  }
  // OAuth 파일은 없지만 호스트에 GEMINI_API_KEY env가 있으면 그 키로 — 격리 HOME + api-key 인증 고정.
  if (process.env.GEMINI_API_KEY) return { home, authType: 'gemini-api-key', env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY } };
  return null; // 진짜 미로그인 — 옵트인 무효(폴백 안 함, 명시 연결 원칙)
}

/** gemini 격리 HOME에 이번 턴 settings.json을 쓴다 — 인증 방식 고정 + caps 기반 도구 게이팅.
    매 턴 덮어쓴다(caps가 턴마다 다를 수 있음). 워크스페이스 GEMINI.md·전역 도구 상속을 이 파일이 차단한다. */
async function writeGeminiTurnSettings(home, authType, caps) {
  const exclude = [];
  if (!caps?.browser) exclude.push('google_web_search', 'web_fetch'); // 웹 능력 OFF면 검색·페치 차단(광고·실행 방지)
  // 셸은 caps 무관 항상 제외 — 비대화 --approval-mode auto_edit에서 셸은 어차피 승인 불가로 실행이 안 되는데,
  // 도구만 보이면 크루가 시도→실패를 반복한다(할루시네이션 유도). yolo 승격은 gemini에 샌드박스가 없어 금지.
  exclude.push('run_shell_command');
  exclude.push('save_memory'); // 기억은 vault가 단일 진실 — gemini 병행 기억(GEMINI.md) 차단
  await writeFile(join(home, '.gemini', 'settings.json'),
    // folderTrust off — 신형 CLI(0.51 실측)가 headless에서 미신뢰 폴더를 exit 55로 거절한다.
    // 격리 홈 + 워크스페이스 한정 실행이라 폴더 신뢰 게이트는 우리 쪽 권한 모델(caps)이 대신한다.
    // 구버전(0.21 실측)은 이 키를 무해하게 무시한다.
    JSON.stringify({ security: { auth: { selectedType: authType }, folderTrust: { enabled: false } }, tools: { exclude } }));
}

/** Claude/GLM(SDK) 러너용 완전 env — 회사 자격 우선, 없으면 기존 폴백(glm은 호스트 GLM_API_KEY, claude는 CLI/env). */
export async function sdkEnvFor(wsId, runner) {
  const cred = await runnerCredEnv(wsId, runner);
  // SDK가 띄우는 Bash/MCP 자식도 서버 시크릿(서비스 키)을 상속하지 않도록 항상 세척된 env를 준다(P1-6).
  // claude 호스트 폴백도 이제 null 대신 세척 env를 반환한다 — 러너 인증(ANTHROPIC_*)은 보존, 크라운주얼만 제거.
  // runner 인자 = 실행 러너 외 제공사 키도 제거(크로스 러너 유출 차단, 감사 2026-07-20).
  if (cred) return { ...scrubServerSecrets(process.env, runner), ...cred.env };
  if (runner === 'glm') return glmEnv(); // 회사 자격 없으면 호스트 GLM_API_KEY 폴백(glmEnv 자체가 세척됨)
  if (runner === 'kimi') return kimiEnv(); // 동일 — 호스트 KIMI_API_KEY 폴백(env 주입 = 명시 옵트인)
  return scrubServerSecrets(process.env, runner);
}

/** OAuth 연결 시작 — 벤더 CLI의 브라우저 로그인을 서버가 대신 실행한다(서버가 사용자 PC에 있는
    로컬/데스크톱 전용). detached spawn이라 서버 응답을 막지 않고, CLI가 시스템 브라우저를 연다.
    완료는 runnerLoginStatus 폴링으로 감지. runner는 RUNNER_AUTH 화이트리스트 + 고정 인자라 인젝션 없음. */
export async function startRunnerLogin(runner) {
  const c = RUNNER_AUTH[runner]?.connect;
  if (!c) return { ok: false, reason: 'unsupported' }; // claude(토큰 붙여넣기)·glm(API키)
  const host = await detectRunners();
  if (!host[runner]?.installed) return { ok: false, reason: 'not-installed' }; // gemini 등 미설치
  try {
    const child = spawn(c.bin, c.loginArgs, { detached: true, stdio: 'ignore' });
    child.unref(); // 서버와 독립 실행 — 브라우저 로그인이 끝날 때까지 서버를 막지 않는다
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', message: String(e.message || e) };
  }
}

/* ─── 러너 OAuth 웹 브리지(공통) — "버튼 클릭 = 로그인 페이지" ───
   각 CLI가 내부에서 쓰는 표준 PKCE 플로우를 서버가 직접 수행한다(CLI는 TTY/localhost 콜백
   요구로 headless 대행 불가 — 실측). client id들은 각 CLI에 내장된 공개 상수
   (installed app의 client_secret은 시크릿으로 취급되지 않음 — Google 문서).
   흐름: 서버가 verifier/challenge 생성 → 인증 URL을 UI에 반환(사용자 기기에서 열림) →
   승인 후 받은 코드(claude: code#state 표시 / codex·gemini: localhost로 리다이렉트된 주소 전체)를
   UI에 붙여넣으면 서버가 토큰으로 교환 → 회사 자격으로 저장 → 암호화 동기화로 전 기기 전파. */
// claude는 WEB_OAUTH에서 제외(2026-07-18 철회). 이전 브리지(authorize=claude.ai/oauth/authorize,
// token=console.anthropic.com/v1/oauth/token, client 9d1c250a-…, scopes 'org:create_api_key
// user:profile user:inference')는 교환엔 성공하지만 러너(SDK)가 401로 거절하는 비 sk-ant-oat01
// 토큰(92자)을 반환했다 — "연결됨" 표시 후 전 턴 실패(실측, 장기 미궁 "러너 연결해도 대화 안 됨"의 원인).
// 현행 Claude Code CLI 바이너리 상수 실측: TOKEN_URL=platform.claude.com/v1/oauth/token,
// authorize=claude.com/cai/oauth/authorize·platform.claude.com/oauth/authorize,
// API_KEY_URL=api.anthropic.com/api/oauth/claude_cli/create_api_key(교환 후 후속 발급 단계),
// ROLES_URL=…/claude_cli/roles — 전혀 다른 세대의 미공개 플로우다. 역공학 재현은 다음 개편 때
// 같은 조용한 파손을 재발시키므로, 공식 발급 경로(claude setup-token) 붙여넣기로 일원화한다.
const WEB_OAUTH = {
  codex: {
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // Codex CLI 공개 클라이언트 id
    redirect: 'http://localhost:1455/auth/callback', // CLI 등록 콜백 — 사용자는 리다이렉트된 주소를 붙여넣는다
    scopes: 'openid profile email offline_access',
  },
  gemini: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com', // gemini-cli 공개
    clientSecret: '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', // installed app 공개 상수 — 시크릿 아님(Google 문서)
    redirect: 'http://localhost:45289/oauth2callback',
    scopes: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    extra: { access_type: 'offline', prompt: 'consent' }, // refresh_token 확보
  },
};
const webAuthState = (globalThis.__argoWebAuth ??= {}); // { [runner]: { verifier, state, ts } }
const webAuthListeners = (globalThis.__argoWebAuthSrv ??= {}); // { [runner]: http.Server } — 1회용 콜백 리스너

/** 로컬 콜백 리스너 — 승인 후 브라우저가 돌아오는 localhost 콜백을 서버가 직접 받아 자동 교환한다.
    이전엔 "사이트에 연결할 수 없음" 오류 화면이 뜨고 사용자가 그 주소를 복사해 붙여넣어야 했다
    (실사용 신고 2026-07-19: 오류로 읽혀 연결 실패로 인지). 리스너가 받으면 복사 단계 자체가 없어지고
    브라우저에는 "연결되었습니다" 페이지가 뜬다. 포트 선점 실패(벤더 CLI 로그인 동시 실행 등)나
    호스팅 워커(사용자 기기가 아님)에선 조용히 건너뛴다 — 기존 붙여넣기 폴백이 그대로 동작한다. */
function startWebAuthListener(runner, wsId, cfg) {
  // 호스팅 가드 없음(2026-07-19 수정): 서비스 키를 가진 상주 웹(:3001)도 사용자 본인 맥이라 리스너가
  // 꺼지면 자동 연결이 안 됐다(실사용 신고 — 격리 dev에선 켜져서 검증이 또 가려짐). 원격 호스팅에서도
  // 리스너는 워커 루프백에서 놀다 TTL로 닫힐 뿐 무해하고, 위조 코드는 PKCE 교환이 차단한다(검수 확인).
  // 알려진 한계: webAuthState/리스너가 러너 단위 전역이라 다중 테넌트 동시 연결은 마지막 시작이 이긴다(기존과 동일).
  try { webAuthListeners[runner]?.close(); } catch { /* 이전 리스너 정리 */ }
  const target = new URL(cfg.redirect);
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>Argo</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh"><div style="text-align:center"><h2>${title}</h2><p style="color:#666">${body}</p></div>`;
  const srv = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, cfg.redirect);
      if (u.pathname !== target.pathname || !u.searchParams.get('code')) { res.statusCode = 404; res.end(); return; }
      const r = await submitRunnerWebAuth(wsId, runner, u.toString()); // 기존 검증 경로 그대로(state/verifier 확인 포함)
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(r.ok
        ? page('연결되었습니다', '이 창을 닫고 Argo로 돌아가세요 — 화면에 곧 "연결됨"이 표시됩니다.')
        : page('연결에 실패했습니다', 'Argo로 돌아가 다시 시도하거나, 이 페이지 주소를 복사해 붙여넣어 주세요.'));
      if (r.ok) { try { srv.close(); } catch { /* 이미 닫힘 */ } delete webAuthListeners[runner]; }
    } catch { res.statusCode = 500; res.end(); }
  });
  srv.on('error', () => { delete webAuthListeners[runner]; /* EADDRINUSE 등 — 붙여넣기 폴백 */ });
  srv.listen(Number(target.port), '127.0.0.1');
  webAuthListeners[runner] = srv;
  const ttl = setTimeout(() => { try { srv.close(); } catch { /* 이미 닫힘 */ } delete webAuthListeners[runner]; }, 10 * 60_000);
  ttl.unref?.();
}

export function startRunnerWebAuth(runner, wsId = null) {
  const cfg = WEB_OAUTH[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // state는 verifier와 무관한 별도 난수여야 한다. verifier를 state로 실으면(과거 설계) 사용자가
  // 붙여넣기 폴백에서 복사·공유하는 리다이렉트 주소에 code+verifier가 함께 실려, 그 주소만으로
  // 제3자가 어디서든 토큰 교환을 완료할 수 있다 — PKCE가 막으려던 코드 탈취의 재개방(감사 HIGH 2026-07-20).
  // verifier는 서버 메모리에만 두고, state는 submitRunnerWebAuth가 대조하는 1회용 CSRF 난수로만 쓴다.
  const state = randomBytes(16).toString('base64url');
  webAuthState[runner] = { verifier, state, ts: Date.now() };
  if (wsId) startWebAuthListener(runner, wsId, cfg); // 자동 수신 — 실패해도 붙여넣기 폴백 유지
  // 사용자가 브라우저에서 승인하는 동안 실행기를 미리 조달 — 저장 관문 프로브(probeGeminiOAuth)가 안 기다리게
  if (runner === 'gemini') provisionGeminiCli().catch(() => {});
  const u = new URL(cfg.authorize);
  for (const [k, v] of Object.entries(cfg.extra ?? {})) u.searchParams.set(k, v);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirect);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return { ok: true, url: u.toString() };
}

/** 붙여넣은 값에서 인증 코드 추출 — 전체 URL(localhost 콜백)·code#state·생 코드 모두 수용. */
function extractAuthCode(pasted) {
  const s = String(pasted).trim();
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      return { code: u.searchParams.get('code') ?? '', state: u.searchParams.get('state') ?? '' };
    } catch { /* URL 아님 — 아래로 */ }
  }
  const [code, state] = s.split('#');
  return { code, state: state ?? '' };
}

/** id_token(JWT) 페이로드 디코드 — 서명 검증 불필요(우리가 방금 토큰 엔드포인트에서 직접 받은 값). */
function jwtPayload(tok) {
  try {
    const p = String(tok).split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch { return {}; }
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
      env: { ...scrubServerSecrets(process.env, 'gemini'), HOME: home, GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
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

export async function submitRunnerWebAuth(wsId, runner, pasted) {
  const cfg = WEB_OAUTH[runner];
  const st = webAuthState[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  if (!st?.verifier) return { ok: false, reason: 'no-session' };
  if (Date.now() - st.ts > 10 * 60_000) return { ok: false, reason: 'expired' }; // 10분 — 다시 시작
  const { code, state } = extractAuthCode(pasted);
  if (!code) return { ok: false, reason: 'no-code' };
  // state 대조(CSRF·주소 위조 방어) — 발급 시 저장한 1회용 난수와 다르면 거절. 리스너·전체 URL 붙여넣기는
  // 벤더가 state를 항상 에코하므로 상시 대조되고, state 없는 생 코드 붙여넣기만 관용(PKCE 교환이 위조 코드 차단).
  if (state && st.state && state !== st.state) return { ok: false, reason: 'state-mismatch' };
  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirect,
    code_verifier: st.verifier,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  };
  let res;
  try {
    res = await fetch(cfg.token, {
      method: 'POST',
      headers: { 'content-type': cfg.jsonBody ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: cfg.jsonBody ? JSON.stringify(params) : new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e.message || e).slice(0, 120) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'exchange-failed', detail: `${res.status} ${body.slice(0, 160)}` };
  }
  const d = await res.json().catch(() => ({}));
  if (runner === 'codex') {
    if (!d.access_token || !d.refresh_token) return { ok: false, reason: 'no-token' };
    // codex CLI의 auth.json 형식 그대로 저장 — runnerCredEnv가 격리 CODEX_HOME에 풀어준다
    const accountId = jwtPayload(d.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
    await saveRunnerCred(wsId, 'codex', 'oauth', JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: d.id_token, access_token: d.access_token, refresh_token: d.refresh_token, account_id: accountId },
      last_refresh: new Date().toISOString(),
    }));
  } else if (runner === 'gemini') {
    if (!d.access_token || !d.refresh_token) return { ok: false, reason: 'no-token' };
    // gemini CLI의 oauth_creds.json 형식
    const credsJson = JSON.stringify({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      scope: d.scope ?? cfg.scopes,
      token_type: d.token_type ?? 'Bearer',
      ...(d.id_token ? { id_token: d.id_token } : {}),
      expiry_date: Date.now() + (d.expires_in ?? 3600) * 1000,
    });
    // 저장 전 실사용 프로브 — 부적격(구글 개인 OAuth 차단) 확정이면 '연결됨'을 만들지 않는다.
    // 안내문만 붙이고 저장을 통과시키면 사용자는 첫 크루 영입에서야 실패를 만난다(실사용 신고 2026-07-20).
    const probe = await probeGeminiOAuth(credsJson);
    if (probe.ok === false) {
      return {
        ok: false, reason: 'ineligible',
        detail: '로그인은 성공했지만 저장하지 않았습니다 — 구글이 이 계정의 Gemini 개인 OAuth(무료 Code Assist)를 최신 CLI에서 지원하지 않습니다. API 키 방식으로 연결해 주세요(Google AI Studio에서 무료 발급). Login succeeded but was not saved — Google no longer supports personal OAuth on the current Gemini CLI. Connect with an API key instead.',
      };
    }
    await saveRunnerCred(wsId, 'gemini', 'oauth', credsJson);
  }
  // 세션 종료 — verifier 재사용 금지. 완료 마커를 남겨 폴링(GET connect)이 "이번 브리지 세션이
  // 실제로 저장을 마쳤나"를 본다. 자격 존재만 보면 기존 자격 보유 러너의 재연결·방식 전환이
  // OAuth 승인 전에 2초 만에 거짓 '연결됨'이 된다(감사 2026-07-20 — 구독 전환했다고 믿는데 옛 키 과금).
  webAuthState[runner] = { saved: true, savedWs: wsId, ts: Date.now() };
  return { ok: true };
}

/** 웹 브리지 완료 여부(폴링용) — "이번 세션에서 이 스코프의 저장이 끝났나"만 true. 자격 존재와 무관. */
export function webAuthDone(runner, wsId) {
  const st = webAuthState[runner];
  return !!(st?.saved && st.savedWs === wsId);
}

/** OAuth 연결 상태 — 벤더 CLI status를 읽기전용으로 확인(폴링용). */
export async function runnerLoginStatus(runner) {
  const c = RUNNER_AUTH[runner]?.connect;
  if (!c) return { supported: false, authed: false };
  await ensureCliPath(); // GUI 기동 PATH 보강
  // codex login status는 "Logged in ..."을 stderr로 낸다 — stdout·stderr 둘 다 검사
  const r = await exec(c.bin, c.statusArgs).catch((e) => e); // 비영점 종료도 출력은 캡처됨
  return { supported: true, authed: !!r && c.ok.test(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

/** 러너별 회사+호스트 연결 상태 — 설정 UI·크루 카드가 먹는다. */
export async function runnerStatus(wsId) {
  const host = await detectRunners();
  const secrets = await loadSecrets(wsId);
  const usage = await monthCostByRunner(wsId).catch(() => ({})); // 표시용 — 실패해도 상태를 막지 않는다
  const out = {};
  for (const [id, meta] of Object.entries(RUNNER_AUTH)) {
    const cred = secrets.runners?.[id];
    out[id] = {
      name: RUNNERS[id]?.name ?? id, // 표시 이름의 단일 진실 — 클라 하드코딩('Claude Agent SDK' 명판 실사고 2026-07-20) 방지
      month: usage[id] ?? null, // 이번 달 사용량(턴·비용) — 러너 카드에 "보이는 상태"
      methods: meta.methods,
      oauthPasteable: !!meta.oauthPasteable,
      connectable: !!meta.connect, // Connect 버튼(CLI 브라우저 로그인 대행) 지원 여부 — codex
      webConnect: !!meta.webConnect, // 웹 브리지(로그인 URL 표시 + 코드 입력) — claude
      hostUsable: hostOptInAllowed(id), // "이 컴퓨터 로그인 사용" 옵트인 — claude는 non-standalone에서만(키체인)
      // claude 원클릭(setup-token)은 데스크톱 번들 사이드카에서만 완주 — 상주/웹은 붙여넣기가 정식 경로
      setupOneClick: id === 'claude' && process.env.ARGO_STANDALONE === '1',
      keyUrl: meta.keyUrl,
      hostInstalled: host[id]?.installed ?? false,
      hostAuthed: host[id]?.authed ?? false, // 호스트 CLI 로그인/env (OAuth 폴백 경로)
      company: cred?.value ? {
        connected: true,
        type: credType(cred.type),
        masked: cred.type === 'host' ? '' : maskCred(cred.value),
        // 저장 검증 도입 전(철회된 웹 브리지 등)에 들어온 무효 형식 토큰 — 카드가 "재연결 필요"를 보여준다
        ...(cred.type === 'oauth' && oauthFormatError(id, cred.value, 'ko') ? { invalid: true } : {}),
        // host 마커는 이 컴퓨터 CLI 로그인이 살아 있어야 유효 — 로그아웃·미설치면 "재연결 필요".
        // + 이 환경에서 host 옵트인이 허용되지 않으면(예: non-standalone에서 저장된 claude host 마커가
        //   동기화로 데스크톱 standalone에 넘어온 경우 — 재서명 node가 키체인에 막혀 "Not logged in")
        //   invalid로 표시해 pickRunner가 스킵하고 setup-token 재연결을 유도한다(검수 HIGH — 소비 측 대칭 게이트).
        ...(cred.type === 'host' && (!(host[id]?.installed && host[id]?.authed) || !hostOptInAllowed(id)) ? { invalid: true } : {}),
      } : { connected: false },
    };
  }
  return out;
}

/** 러너 선택(순수) — st = runnerStatus 결과. 반환 { runner, fellBack, available, credButNoCli? }.
    가용 = **사장이 명시적으로 연결한 자격(유효)뿐** — 호스트 로그인 흔적의 자동 사용(스캐빈징)은
    하지 않는다(유건 지시 2026-07-19: 감지는 안내로만, 연결은 사장이. 실사용: 스테일/키체인 접근 불가
    호스트 흔적이 '연결중'으로 오표시되고 유효한 Codex를 밀어내 턴 사망). 호스트 로그인을 쓰려면
    "이 컴퓨터 로그인 사용" 옵트인(host 타입 자격)으로 연결한다 — 그때부터 connected로 잡힌다.
    무효(invalid) 자격은 가용이 아니다(게이트 anyRunnerUsable과 판정 일치).
    want = 크루 지정 러너(null이면 무선호 — 첫 연결 러너를 대체 고지 없이 쓴다).
    exclude = 방금 인증 실패한 러너(자가 치유 재시도 시 제외). (export: 회귀 테스트용) */
export function pickRunner(st, want, exclude = null) {
  // 가용 = 연결(유효) 자격이 전부다. 예전엔 codex/gemini가 벤더 CLI 설치를 추가로 요구해
  // "OAuth 연결됨 + 크루 영입은 러너 없음" 모순(실사용 신고 2026-07-20)을 만들었다 — 이제 두 러너 모두
  // 자동 조달(provisionCodexCli/provisionGeminiCli — 턴 시점 자가 설치)이 있어 설치 게이트가 없다.
  // 조달 실패(오프라인 등)는 턴이 원인 문구로 실패한다 — 거짓 차단보다 정직한 실패가 낫다.
  const usable = (id) => !!st[id]?.company.connected && !st[id]?.company.invalid && id !== exclude;
  if (want && usable(want)) return { runner: want, fellBack: false, available: true };
  const ids = Object.keys(RUNNER_AUTH);
  const next = ids.find(usable);
  if (next) return { runner: next, fellBack: !!want, available: true }; // 무선호(want=null)는 대체가 아니다
  // 아무 러너도 없음 — 호출부가 안내 에러를 만든다(원래 러너 반환은 에러 문구용).
  // credButNoCli — 자동 조달 도입으로 "자격은 있는데 CLI가 없어 차단"이 사라져 항상 빈 배열이다.
  // 필드는 소비처(chat/oneshot의 안내 분기) 호환으로 유지 — 미래에 조달 불가 플랫폼이 생기면 되살린다.
  return { runner: want ?? 'claude', fellBack: false, available: false, credButNoCli: [] };
}

/** 턴에 실제로 쓸 러너 결정 — 크루의 러너가 미가용이면 가용한 러너로 폴백(pickRunner).
    어떤 러너든 하나만 연결돼 있으면 모든 크루가 응답하게 하는 관문. */
export async function resolveRunner(wsId, want, { exclude = null } = {}) {
  return pickRunner(await runnerStatus(wsId), want, exclude);
}

/** claude OAuth 토큰 형식 안내(순수) — 형식이 다른 값(웹 브리지 교환 산출물·setup-token 중간 인증
    코드 오입력)이 저장을 통과한 뒤 모든 턴이 401로만 드러나던 것을 저장 시점에 잡는다
    (실측 2026-07-18: 92자 비접두사 값 저장 → 전 턴 "401 Invalid authentication credentials").
    반환: null(정상) | 사용자 안내 문자열. (export: 회귀 테스트용) */
export function oauthFormatError(runner, value, lang = 'ko') {
  const prefix = RUNNER_AUTH[runner]?.oauthPrefix;
  if (!prefix || String(value ?? '').trim().startsWith(prefix)) return null;
  return lang === 'en'
    ? `That value isn't a Claude OAuth token. Run claude setup-token in your terminal and paste the token it prints at the end — it starts with ${prefix}. (The code shown in the browser is an intermediate value you paste into the terminal, not here.)`
    : `이 값은 Claude OAuth 토큰이 아닙니다. 터미널에서 claude setup-token 을 실행해 마지막에 출력되는 ${prefix} 로 시작하는 토큰을 붙여넣어 주세요. (브라우저에 표시되는 인증 코드는 터미널에 넣는 중간 단계 값이지, 여기 넣는 값이 아닙니다.)`;
}

/** HTTP 200인데 바디에 인증 실패가 담긴 응답(z.ai/GLM류) 감지 — 순수.
    유효 키의 정상 응답 바디는 success·code 필드가 없어 오탐하지 않는다(유효 키 오거절 방지가 최우선 제약). */
function bodyIndicatesAuthError(body) {
  try {
    const j = JSON.parse(body);
    if (!j || typeof j !== 'object') return false;
    // z.ai/GLM류는 인증 실패를 HTTP 200 바디의 code(401/403)로 알린다. success:false는 레이트리밋·계정정지
    // 등 비인증 실패에도 붙는 제네릭 플래그라 무효 판정 신호로 쓰지 않는다 — 유효 키 오거절 방지가 최우선(검수 HIGH).
    const code = j.code ?? j.error?.code;
    return code === 401 || code === 403 || code === '401' || code === '403';
  } catch { return false; }
}

/** 자격 인증 확인 — 러너별 저비용 검증. { ok:true|false|null }(null=네트워크 불가, 형식만으로 저장 허용). */
export async function verifyRunnerCred(runner, type, value) {
  const v = String(value).trim();
  try {
    if (runner === 'claude' && type === 'apikey') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'claude' && type === 'oauth') {
      // CLAUDE_CODE_OAUTH_TOKEN 검증 — Bearer + oauth 베타 헤더. 실측(2026-07-18): 무효 토큰에
      // 401 {"type":"authentication_error","message":"OAuth access token is invalid."} — 엔드포인트가
      // Bearer OAuth를 명시적으로 검증한다. 유효 토큰의 200 통과도 실측 확인(2026-07-20, 키체인
      // 실토큰 — oauth 베타 헤더 유무 모두 200). 이제 검증은 저장의 필수 관문이라(무검증 '저장만'
      // 제거) 오탐이 곧 저장 차단이지만, 원클릭(setup-token)도 같은 호출로 게이트해 왔고 양방향
      // 실측이 갖춰져 오탐 위험은 근거 있이 낮다.
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { authorization: `Bearer ${v}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'glm') {
      const base = process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic';
      const r = await fetch(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': v, authorization: `Bearer ${v}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) return { ok: false };
      // z.ai(GLM)는 무효 키에도 HTTP 200을 주고 바디에 인증 실패를 담는다({code:401,success:false}) — 실측 2026-07-20.
      // 상태코드만 보면 '연결됨'으로 저장돼 전 호출이 실패한다(거짓 연결). 바디 레벨 에러도 무효로 본다.
      if (bodyIndicatesAuthError(await r.text().catch(() => ''))) return { ok: false };
      return { ok: r.ok ? true : null };
    }
    if (runner === 'kimi') {
      const base = process.env.KIMI_OPENAI_BASE_URL || 'https://api.moonshot.ai/v1';
      const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'codex' && type === 'apikey') {
      const r = await fetch('https://api.openai.com/v1/models?limit=1', { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'gemini' && type === 'apikey') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}&pageSize=1`, { signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) return { ok: false };
      // Google Generative Language API는 무효 키에 HTTP 400 + reason:API_KEY_INVALID를 준다(401 아님) — 실측 2026-07-20.
      // 400을 무조건 무효로 몰면 키와 무관한 요청 오류까지 키 탓이 되므로, 키 무효 신호가 있을 때만 거절한다.
      if (r.status === 400) {
        const body = await r.text().catch(() => '');
        return /API_KEY_INVALID|API key not valid/i.test(body) ? { ok: false } : { ok: null };
      }
      return { ok: r.ok ? true : null };
    }
    return { ok: null }; // oauth 토큰·미지원 조합은 형식 검증만
  } catch {
    return { ok: null };
  }
}

/* ─── Claude 원클릭 연결 — 공식 `claude setup-token`을 서버가 PTY로 대행(로컬/데스크톱 전용) ───
   왜 이 방식인가: 웹 브리지(구세대 엔드포인트 재현)는 러너가 거절하는 토큰을 저장해 철회했다
   (WEB_OAUTH 주석). setup-token은 CLAUDE_CODE_OAUTH_TOKEN의 유일한 공식 발급 경로라, 명령을
   그대로 대행하면 내부 플로우가 개편돼도 안전하다. 실측(2026-07-18): 비TTY에선 조용히 종료하므로
   script(1)로 PTY를 입힌다. PTY에선 코드 프롬프트 없이 브라우저를 열어 승인을 자동 수신하고,
   완료 시 stdout의 sk-ant-oat01- 토큰을 형식 검증 후 회사 자격으로 저장한다(터미널 불필요).
   기존 수동 붙여넣기 경로는 그대로 유지 — 이 대행이 실패하는 환경의 폴백이다(회귀 없음). */
const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000; // 브라우저 승인 대기 상한

/** PTY 출력에서 setup-token의 최종 토큰 추출(순수) — ANSI 제거 후 매치.
    PTY(기본 80칸)가 긴 토큰을 줄바꿈으로 감싼다 — 토큰 문자 사이의 개행을 접합해 복원한다
    (실사고 2026-07-19 재현: 108자 토큰이 80자로 절단 저장 → '연결됨'인데 전 호출 인증 실패).
    접합이 뒤따르는 텍스트를 흡수하는 엣지에 대비해 [접합본, 원본] 두 후보를 반환하고,
    호출부(startClaudeSetupToken)가 저장 전 HTTP 검증으로 유효한 쪽만 저장한다.
    (export: 회귀 테스트용 — 첫 번째 후보가 기본값) */
export function extractSetupTokenCandidates(text) {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  const joined = clean.replace(/([A-Za-z0-9_-])\r?\n(?=[A-Za-z0-9_-])/g, '$1');
  const re = /sk-ant-oat01-[A-Za-z0-9_-]{16,}/;
  return [...new Set([joined.match(re)?.[0], clean.match(re)?.[0]].filter(Boolean))];
}
export function extractSetupToken(text) {
  return extractSetupTokenCandidates(text)[0] ?? null;
}

/** 내장 SDK 네이티브 claude CLI 경로 — 앱/서버가 이미 품고 있는 바이너리(stage-sidecar 3.4가 보장).
    실측: setup-token 서브커맨드 지원. 터미널 무경험 초보자도 설치 0으로 원클릭(브라우저 승인) 연결이
    되게 하는 핵심 폴백이다(유건 지시 2026-07-19: 초보자 여정에서 터미널 요구 제거).
    (export: 회귀 테스트용) */
export async function bundledClaudeCli() {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const p = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    if (await exists(p)) return p;
  } catch { /* 플랫폼 패키지 미포함 — 아래 null */ }
  return null;
}

/** setup-token을 실행할 claude CLI 경로 — env 오버라이드 → 호스트 PATH → 내장 SDK CLI 폴백.
    전부 없으면 null(수동 붙여넣기 안내). */
async function resolveClaudeCli() {
  if (process.env.CLAUDE_CLI?.trim()) return process.env.CLAUDE_CLI.trim();
  await ensureCliPath(); // GUI 기동 PATH 보강 — which가 로그인 셸 PATH를 본다
  try { const r = await exec('which', ['claude']); const p = r.stdout.trim(); if (p) return p; } catch { /* 미설치 */ }
  return bundledClaudeCli();
}

const setupState = (globalThis.__argoSetupToken ??= {}); // wsId → { status: running|saved|failed, error, ts }

export function setupTokenStatus(wsId) {
  const s = setupState[wsId];
  return s ? { status: s.status, error: s.error ?? '' } : { status: 'idle' };
}

export async function startClaudeSetupToken(wsId) {
  // 원클릭(setup-token PTY 대행)이 완주하려면 서버가 (a) 사용자 GUI 세션에서 브라우저를 열 수 있고
  // (b) setup-token의 localhost 콜백 리스너가 승인 시점까지 살아 있어야 한다. 이 둘이 성립하는 곳은
  // 데스크톱 번들 사이드카(ARGO_STANDALONE=1 — Tauri가 GUI·프로세스 수명을 관리)뿐이다.
  // 상주(launchd 백그라운드 데몬)·웹·dev는 브라우저를 못 열거나 콜백이 끊겨(승인 후 localhost:콜백이
  // ERR_CONNECTION_REFUSED — 실사용 신고 2026-07-19) 스피너만 돈다. 그 환경들은 원클릭을 열지 않고
  // 'manual'(터미널에서 claude setup-token 실행 → 토큰 붙여넣기)로 안내한다.
  // (앞선 #44의 loopback 판정은 이 완주 조건을 담지 못해 상주에서 스피너 함정을 만들었다 — standalone으로 교정.)
  // ARGO_TENANT_OWNER는 벨트앤서스펜더 하드 차단 — 누군가 호스팅 런타임에 실수로 ARGO_STANDALONE=1을
  // 넣어도(standalone 서버라 "필요해 보이는" 흔한 실수) 다중테넌트에선 원클릭이 재개방되지 않도록(검수 LOW).
  if (process.env.ARGO_TENANT_OWNER || process.env.ARGO_STANDALONE !== '1') return { ok: false, reason: 'manual' };
  if (process.platform === 'win32') return { ok: false, reason: 'unsupported-platform' }; // script(1) 부재 — 후속(node-pty 검토)
  // 재클릭 = 재시작 — 승인 없이 브라우저를 닫으면 이전 시도가 10분 타임아웃까지 'running'으로 잠겨
  // 모든 재클릭이 busy로 거절되고 브라우저가 다시는 안 열리던 함정 제거(실사용 신고 2026-07-20:
  // "인증을 취소했으면 처음부터 다시 시도할 수 있어야 한다"). 이전 시도는 죽이고 새로 연다.
  const prev = setupState[wsId];
  if (prev?.status === 'running') { try { prev.cancel?.(); } catch { /* 이미 종료 */ } }
  const cli = await resolveClaudeCli();
  if (!cli) return { ok: false, reason: 'no-cli' };
  // macOS script는 인자 배열(셸 미개입), linux(util-linux)는 -c 문자열이라 sh를 타므로
  // CLI 경로를 단일인용 이스케이프한다(공백 경로·메타문자 인젝션 차단 — env/PATH 유래 값).
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', cli, 'setup-token']
    : ['-qec', `'${cli.replace(/'/g, `'\\''`)}' setup-token`, '/dev/null'];
  let child;
  try {
    child = spawn('script', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', message: String(e.message || e) };
  }
  let buf = '';
  let done = false;
  let timer;
  const gen = (prev?.gen ?? 0) + 1; // 세대 — 구시도의 늦은 finish/저장이 새 시도 상태를 덮지 않게
  const cancel = () => { done = true; clearTimeout(timer); try { child.kill(); } catch { /* 이미 종료 */ } };
  // 슬롯의 세대가 내 것일 때만 기록 — 새 시도가 인수했거나 슬롯이 폐기(삭제)됐으면 늦은 결과는 버린다
  const commit = (next) => { if (setupState[wsId]?.gen !== gen) return; setupState[wsId] = { ...next, gen, cancel }; };
  const finish = (status, error = '') => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    commit({ status, error, ts: Date.now() });
    try { child.kill(); } catch { /* 이미 종료 */ }
  };
  timer = setTimeout(() => finish('failed', '승인 대기 시간(10분)이 지났습니다 — 다시 시도하거나 토큰을 직접 붙여넣어 주세요'), SETUP_TOKEN_TIMEOUT_MS);
  timer.unref?.();
  setupState[wsId] = { status: 'running', ts: Date.now(), gen, cancel };
  const onData = (d) => {
    if (done) return;
    buf = (buf + d.toString()).slice(-20_000); // 꼬리만 유지 — 토큰은 마지막에 출력된다
    const candidates = extractSetupTokenCandidates(buf);
    if (!candidates.length) return;
    // 토큰 감지 즉시 선점 — setup-token은 토큰 출력 직후 종료하므로, 비동기 저장이 끝나기 전의
    // 정상 exit가 finish('failed')로 덮으면 "저장됐는데 실패 표시"가 된다(검수 MEDIUM: 저장-exit 레이스).
    // done을 먼저 잠그고 저장 결과가 최종 상태를 정한다(그동안 상태는 running 유지 — UI는 진행 중 표시).
    done = true;
    clearTimeout(timer);
    try { child.kill(); } catch { /* 이미 종료 */ }
    // 저장 전 실검증(HTTP Bearer, verifyRunnerCred) — 잘린/무효 토큰이 '연결됨'으로 저장되는 것을
    // 원천 차단(실사고 2026-07-19: PTY 줄바꿈 절단 토큰 저장 → 연결됨 표시인데 전 호출 인증 실패).
    // 후보(접합본→원본) 중 검증을 통과한 것만 저장. 네트워크 불가(ok:null)는 첫 후보 관용 저장(오프라인 온보딩).
    // 토큰 평문은 저장 외 어디에도 남기지 않는다(로그·상태 객체 금지).
    (async () => {
      let chosen = null;
      let sawInvalid = false;
      let sawOffline = false;
      for (const t of candidates) {
        const v = await verifyRunnerCred('claude', 'oauth', t);
        if (v.ok === false) { sawInvalid = true; continue; }
        if (v.ok === true) { chosen = t; break; }
        sawOffline = true; // ok:null — 판정 불가. 확정하지 않고 다음 후보를 계속 본다(검수 LOW:
        // 첫 후보(접합본)가 흡수 오염본일 때 블립이 겹치면 오염 저장 — 관용은 아래에서 원본으로만)
      }
      // 관용 저장은 후보가 하나뿐일 때만 — 둘 이상인데 전부 판정 불가면 어느 쪽이 온전한지 알 수
      // 없으므로(줄바꿈 케이스에선 마지막=절단본!) 저장하지 않고 재시도를 유도한다(검수 LOW 반영).
      if (!chosen && sawOffline && !sawInvalid && candidates.length === 1) chosen = candidates[0];
      if (!chosen) {
        commit({ status: 'failed', error: sawInvalid ? '토큰 검증에 실패했습니다(잘려 읽혔거나 무효) — 다시 시도해 주세요' : '토큰을 읽지 못했습니다 — 다시 시도해 주세요', ts: Date.now() });
        return;
      }
      await saveRunnerCred(wsId, 'claude', 'oauth', chosen)
        .then(() => { commit({ status: 'saved', ts: Date.now() }); })
        .catch((e) => { commit({ status: 'failed', error: String(e.message || e).slice(0, 160), ts: Date.now() }); });
    })();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => finish('failed', '로그인이 완료되지 않았습니다 — 다시 시도하거나 토큰을 직접 붙여넣어 주세요'));
  child.on('error', (e) => finish('failed', String(e.message || e).slice(0, 160)));
  return { ok: true };
}

// ── 하위호환 얇은 래퍼 (기존 호출부 유지) ──
export const loadClaudeKey = async (wsId) => (await loadRunnerCred(wsId, 'claude'))?.value ?? null;
export const maskClaudeKey = maskCred;
export const claudeEnvFor = (wsId) => sdkEnvFor(wsId, 'claude');
