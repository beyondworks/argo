// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { paths } from './workspace.mjs';
import { monthCostByRunner } from './usage.mjs'; // usage는 workspace만 의존 — 순환 없음

const execP = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);

/** execFile + stdin 즉시 닫기 — CLI가 stdin을 물고 대기하는 행을 차단한다(코덱스 300초 행의 원인). */
function exec(cmd, args, opts) {
  const p = execP(cmd, args, opts);
  p.child.stdin?.end();
  return p;
}

/** 실패 출력에서 API 에러 메시지만 뽑는다 — 이벤트 로그에 명령·프롬프트 전문을 흘리지 않는다. */
function apiError(e) {
  const raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return new Error(m ? m[1] : `러너 실행 실패 (exit ${e.code ?? '?'}): ${String(e.stderr ?? e.message).replace(/\s+/g, ' ').slice(-160)}`);
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
      // ai.google.dev 모델 문서(2026-07) — 3.5 Flash가 GA 최신, 3.1 Pro는 프리뷰
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
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

export const GLM_DEFAULT_MODEL = 'glm-5.2';
export const glmEnv = () => ({
  ...process.env,
  ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: process.env.GLM_API_KEY ?? '',
  ANTHROPIC_API_KEY: '',
});

/** 설치·인증 감지 — 각 CLI의 로그인 산출물(OAuth 크리덴셜 파일)을 본다. 60초 캐시. */
let cache = null;
let cacheAt = 0;
export async function detectRunners() {
  if (cache && Date.now() - cacheAt < 60_000) return cache;
  const home = homedir();
  const [codexV, geminiV, codexAuth, geminiAuth, claudeCredFile, claudeCfg] = await Promise.all([
    exec('codex', ['--version']).then((r) => r.stdout.trim(), () => null),
    exec('gemini', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(join(home, '.codex', 'auth.json')),
    exists(join(home, '.gemini', 'oauth_creds.json')),
    exists(join(home, '.claude', '.credentials.json')), // 리눅스 — 파일 보관
    exists(join(home, '.claude.json')),                 // macOS — OAuth는 키체인, 로그인 흔적은 이 파일
  ]);
  const claudeCred = claudeCredFile || claudeCfg;
  cache = {
    claude: { installed: true, authed: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || claudeCred) },
    codex: { installed: !!codexV, authed: !!codexV && codexAuth },
    gemini: { installed: !!geminiV, authed: !!geminiV && (geminiAuth || !!process.env.GEMINI_API_KEY) },
    glm: { installed: true, authed: !!process.env.GLM_API_KEY },
  };
  cacheAt = Date.now();
  return cache;
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

/** 외부 CLI 러너 1턴 — 워크스페이스를 cwd로, 프롬프트 하나로 실행하고 마지막 응답을 받는다.
    cred = runnerCredEnv 결과({ env, home }) — 회사 자격이 있으면 그 env를 주입(API키/OAuth). 없으면 호스트 로그인. */
export async function externalExec({ runner, model, cwd, prompt, timeoutMs = 300_000, cred = null }) {
  if (runner === 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'argo-codex-'));
    const out = join(dir, 'last.txt');
    // 회사 API키 모드면 깨끗한 홈(계정 OAuth 무시), 아니면 호스트 로그인 상속
    const CODEX_HOME = cred?.home === 'clean' ? await codexHomeClean()
      : cred?.home ? cred.home // 회사 OAuth 격리 홈(웹 브리지)
      : await codexHome();     // 호스트 로그인 상속
    try {
      await exec('codex', [
        'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
        '--output-last-message', out,
        ...(model ? ['-m', model] : []),
        '--', prompt, // 프롬프트가 '---'(카드 frontmatter)로 시작해도 플래그로 오해하지 않도록
      ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, env: { ...process.env, ...(cred?.env ?? {}), CODEX_HOME } })
        .catch((e) => { throw apiError(e); });
      return (await readFile(out, 'utf8')).trim();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (runner === 'gemini') {
    const { stdout } = await exec('gemini', [
      '-p', prompt,
      ...(model ? ['-m', model] : []),
      '--approval-mode', 'auto_edit', // 편집류만 자동 승인 — 셸 등은 비대화 모드에서 실행되지 않는다
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, env: { ...process.env, ...(cred?.env ?? {}) } })
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
const secretsFile = (wsId) => join(paths(wsId).root, '.secrets.json');

// 러너별 지원 인증 방식. apikey=붙여넣기(4러너 공통), oauth=붙여넣기 토큰(claude) 또는 호스트 로그인(codex/gemini).
// glm은 Anthropic 호환 토큰(사실상 apikey)만.
// connect: 벤더 CLI의 브라우저 로그인을 서버가 대신 실행할 수 있는 러너(로컬/데스크톱 전용).
//   bin/loginArgs=로그인 실행, statusArgs=읽기전용 상태확인, ok=로그인됨 판정 정규식.
//   codex만 spawn 가능한 login이 있다. claude는 이 CLI에 login 서브커맨드가 없어(구독은 키체인)
//   oauthPasteable 토큰 붙여넣기로, gemini는 CLI 설치 후 로그인 안내로 대체한다.
export const RUNNER_AUTH = {
  claude: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-ant-', oauthPasteable: true, webConnect: true, oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', keyUrl: 'https://console.anthropic.com/settings/keys' },
  codex: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-', oauthPasteable: false, webConnect: true, keyUrl: 'https://platform.openai.com/api-keys', connect: { bin: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'], ok: /Logged in/i } },
  gemini: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, webConnect: true, keyUrl: 'https://aistudio.google.com/apikey' },
  glm: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
};

async function loadSecrets(wsId) {
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
export async function loadRunnerCred(wsId, runner) {
  const c = (await loadSecrets(wsId)).runners?.[runner];
  return c && typeof c.value === 'string' && c.value.trim() ? { type: c.type === 'oauth' ? 'oauth' : 'apikey', value: c.value.trim() } : null;
}

/** 러너 자격 저장 — 원자적. 다른 러너·필드는 보존. 레거시 claude 필드는 정리. */
export async function saveRunnerCred(wsId, runner, type, value) {
  if (!RUNNER_AUTH[runner]) throw new Error('알 수 없는 러너');
  const s = await loadSecrets(wsId);
  const { claude, ...rest } = s; // 레거시 평문 필드 제거
  rest.runners = { ...rest.runners, [runner]: { type: type === 'oauth' ? 'oauth' : 'apikey', value: String(value).trim() } };
  await writeJsonAtomic(secretsFile(wsId), rest);
  // 격리 홈 리셋 — 재연결 시 이전 토큰 파일이 새 자격을 가리지 않게(runnerCredEnv가 재생성)
  if (runner === 'codex') await rm(join(homedir(), '.argo', `codex-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
  if (runner === 'gemini') await rm(join(homedir(), '.argo', `gemini-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
}

/** 러너 자격 제거 — 다른 러너는 유지. */
export async function clearRunnerCred(wsId, runner) {
  const s = await loadSecrets(wsId);
  const { claude, ...rest } = s;
  if (rest.runners) delete rest.runners[runner];
  await writeJsonAtomic(secretsFile(wsId), rest);
}

/** 마스킹 — 접두사만(보안 규칙). 평문은 어디에도 남기지 않는다. */
export const maskCred = (v) => (v ? `${v.slice(0, 6)}***` : '');

/** 러너 실행에 주입할 env(부분) — 회사 자격이 있으면 러너 종류에 맞는 변수로. 없으면 null(호스트 자격 폴백=회귀 0).
    반환: { env, home } — env=주입 변수 dict, home=codex 격리홈 오버라이드('clean'=계정 로그인 무시하고 API키 사용). */
export async function runnerCredEnv(wsId, runner) {
  const cred = await loadRunnerCred(wsId, runner);
  if (!cred) return null;
  const v = cred.value;
  if (runner === 'claude') {
    return cred.type === 'oauth'
      ? { env: { CLAUDE_CODE_OAUTH_TOKEN: v, ANTHROPIC_API_KEY: '' } }
      : { env: { ANTHROPIC_API_KEY: v, CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'glm') {
    return { env: { ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '' } };
  }
  if (runner === 'codex') {
    // apikey면 계정 OAuth를 무시하고 OPENAI_API_KEY로 — 격리홈을 '깨끗한' 것으로 써 auth.json 상속 차단.
    if (cred.type === 'apikey') return { env: { OPENAI_API_KEY: v }, home: 'clean' };
    // 회사 OAuth(웹 브리지) — 저장된 auth.json을 회사별 격리 CODEX_HOME에 풀어 CLI가 읽게 한다.
    // CLI가 토큰을 갱신하면 이 파일에 다시 쓴다(다음 턴도 같은 홈을 쓰므로 이어진다).
    const dir = join(homedir(), '.argo', `codex-home-${wsId}`);
    await mkdir(dir, { recursive: true });
    if (!(await exists(join(dir, 'auth.json')))) await writeFile(join(dir, 'auth.json'), v);
    if (!(await exists(join(dir, 'config.toml')))) await writeFile(join(dir, 'config.toml'), '# Argo 회사 자격 codex 홈\n');
    return { env: {}, home: dir };
  }
  if (runner === 'gemini') {
    if (cred.type === 'apikey') return { env: { GEMINI_API_KEY: v } };
    // 회사 OAuth(웹 브리지) — oauth_creds.json을 회사별 격리 HOME의 .gemini에 풀어준다.
    const home = join(homedir(), '.argo', `gemini-home-${wsId}`);
    await mkdir(join(home, '.gemini'), { recursive: true });
    if (!(await exists(join(home, '.gemini', 'oauth_creds.json')))) {
      await writeFile(join(home, '.gemini', 'oauth_creds.json'), v);
    }
    if (!(await exists(join(home, '.gemini', 'settings.json')))) {
      await writeFile(join(home, '.gemini', 'settings.json'), JSON.stringify({ selectedAuthType: 'oauth-personal' }));
    }
    return { env: { HOME: home } };
  }
  return null;
}

/** Claude/GLM(SDK) 러너용 완전 env — 회사 자격 우선, 없으면 기존 폴백(glm은 호스트 GLM_API_KEY, claude는 CLI/env). */
export async function sdkEnvFor(wsId, runner) {
  const cred = await runnerCredEnv(wsId, runner);
  if (cred) return { ...process.env, ...cred.env };
  if (runner === 'glm') return glmEnv(); // 회사 자격 없으면 호스트 GLM_API_KEY 폴백
  return null; // claude: 회사 자격 없으면 null → 기존 CLI/env 자격
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
const WEB_OAUTH = {
  claude: {
    authorize: 'https://claude.ai/oauth/authorize',
    token: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude Code 공개 클라이언트 id
    redirect: 'https://console.anthropic.com/oauth/code/callback',
    scopes: 'org:create_api_key user:profile user:inference',
    jsonBody: true, // Anthropic 토큰 엔드포인트는 JSON
    extra: { code: 'true' },
  },
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
const webAuthState = (globalThis.__argoWebAuth ??= {}); // { [runner]: { verifier, ts } }

export function startRunnerWebAuth(runner) {
  const cfg = WEB_OAUTH[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  webAuthState[runner] = { verifier, ts: Date.now() };
  const u = new URL(cfg.authorize);
  for (const [k, v] of Object.entries(cfg.extra ?? {})) u.searchParams.set(k, v);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirect);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', verifier);
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

export async function submitRunnerWebAuth(wsId, runner, pasted) {
  const cfg = WEB_OAUTH[runner];
  const st = webAuthState[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  if (!st?.verifier) return { ok: false, reason: 'no-session' };
  if (Date.now() - st.ts > 10 * 60_000) return { ok: false, reason: 'expired' }; // 10분 — 다시 시작
  const { code, state } = extractAuthCode(pasted);
  if (!code) return { ok: false, reason: 'no-code' };
  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirect,
    code_verifier: st.verifier,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
    ...(runner === 'claude' ? { state: state || st.verifier } : {}),
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
  if (runner === 'claude') {
    if (!d.access_token) return { ok: false, reason: 'no-token' };
    await saveRunnerCred(wsId, 'claude', 'oauth', d.access_token);
  } else if (runner === 'codex') {
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
    // gemini CLI의 oauth_creds.json 형식 그대로 저장
    await saveRunnerCred(wsId, 'gemini', 'oauth', JSON.stringify({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      scope: d.scope ?? cfg.scopes,
      token_type: d.token_type ?? 'Bearer',
      ...(d.id_token ? { id_token: d.id_token } : {}),
      expiry_date: Date.now() + (d.expires_in ?? 3600) * 1000,
    }));
  }
  webAuthState[runner] = null; // 세션 종료 — verifier 재사용 금지
  return { ok: true };
}

/** OAuth 연결 상태 — 벤더 CLI status를 읽기전용으로 확인(폴링용). */
export async function runnerLoginStatus(runner) {
  const c = RUNNER_AUTH[runner]?.connect;
  if (!c) return { supported: false, authed: false };
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
      month: usage[id] ?? null, // 이번 달 사용량(턴·비용) — 러너 카드에 "보이는 상태"
      methods: meta.methods,
      oauthPasteable: !!meta.oauthPasteable,
      connectable: !!meta.connect, // Connect 버튼(CLI 브라우저 로그인 대행) 지원 여부 — codex
      webConnect: !!meta.webConnect, // 웹 브리지(로그인 URL 표시 + 코드 입력) — claude
      keyUrl: meta.keyUrl,
      hostInstalled: host[id]?.installed ?? false,
      hostAuthed: host[id]?.authed ?? false, // 호스트 CLI 로그인/env (OAuth 폴백 경로)
      company: cred?.value ? { connected: true, type: cred.type === 'oauth' ? 'oauth' : 'apikey', masked: maskCred(cred.value) } : { connected: false },
    };
  }
  return out;
}

/** 자격 인증 확인 — 러너별 저비용 검증. { ok:true|false|null }(null=네트워크 불가, 형식만으로 저장 허용). */
export async function verifyRunnerCred(runner, type, value) {
  const v = String(value).trim();
  try {
    if (runner === 'claude' && type === 'apikey') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'glm') {
      const base = process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic';
      const r = await fetch(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': v, authorization: `Bearer ${v}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'codex' && type === 'apikey') {
      const r = await fetch('https://api.openai.com/v1/models?limit=1', { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'gemini' && type === 'apikey') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}&pageSize=1`, { signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    return { ok: null }; // oauth 토큰·미지원 조합은 형식 검증만
  } catch {
    return { ok: null };
  }
}

// ── 하위호환 얇은 래퍼 (기존 호출부 유지) ──
export const loadClaudeKey = async (wsId) => (await loadRunnerCred(wsId, 'claude'))?.value ?? null;
export const maskClaudeKey = maskCred;
export const claudeEnvFor = (wsId) => sdkEnvFor(wsId, 'claude');
