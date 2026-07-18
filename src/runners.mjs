// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
/** 서버 시크릿만 제거한 env 사본 — 러너 모델 키·운영 변수는 그대로 둔다. (export: 회귀 테스트용) */
export function scrubServerSecrets(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!isServerSecretKey(k)) out[k] = v;
  return out;
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
  ...scrubServerSecrets(process.env),
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
  const [codexV, geminiV, codexAuth, geminiAuth, claudeCredFile, claudeCfgLogin] = await Promise.all([
    exec('codex', ['--version']).then((r) => r.stdout.trim(), () => null),
    exec('gemini', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(join(home, '.codex', 'auth.json')),
    exists(join(home, '.gemini', 'oauth_creds.json')),
    exists(join(home, '.claude', '.credentials.json')), // 리눅스 — 파일 보관
    // macOS/Windows — OAuth 토큰은 키체인/OS 보관이라 .claude.json의 로그인 계정 기록(oauthAccount)으로
    // 판정한다. 파일 존재만으론 안 됨: 로그인 없이 CLI가 실행만 돼도(번들 SDK 포함) 생성된다 — 미로그인
    // 기기가 설정에서 "연결중 · 이 컴퓨터 로그인"으로 오표시되고 턴은 Not logged in으로 죽던 원인.
    readFile(join(home, '.claude.json'), 'utf8')
      .then((s) => !!JSON.parse(s)?.oauthAccount?.accountUuid, () => false),
  ]);
  const claudeCred = claudeCredFile || claudeCfgLogin;
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
export async function externalExec({ runner, model, cwd, prompt, timeoutMs = 300_000, cred = null, signal = null }) {
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
      ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env), ...(cred?.env ?? {}), CODEX_HOME } })
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
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env), ...(cred?.env ?? {}) } })
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
  claude: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-ant-', oauthPrefix: 'sk-ant-oat01-', oauthPasteable: true, oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', keyUrl: 'https://console.anthropic.com/settings/keys' },
  codex: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-', oauthPasteable: false, webConnect: true, keyUrl: 'https://platform.openai.com/api-keys', connect: { bin: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'], ok: /Logged in/i } },
  gemini: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, webConnect: true, keyUrl: 'https://aistudio.google.com/apikey' },
  glm: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
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
  // 격리 홈 리셋 — 재연결 시 이전 토큰 파일이 새 자격을 가리지 않게(runnerCredEnv가 재생성).
  // 계정 스코프엔 실행 홈이 없다(온보딩 저장용 — 실행은 회사 wsId로) — 스킵.
  if (!isAccountScope(wsId)) {
    if (runner === 'codex') await rm(join(homedir(), '.argo', `codex-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
    if (runner === 'gemini') await rm(join(homedir(), '.argo', `gemini-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
  }
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
    await mkdir(dir, { recursive: true, mode: 0o700 }); // OAuth 토큰 보관 — 소유자만
    if (!(await exists(join(dir, 'auth.json')))) await writeFile(join(dir, 'auth.json'), v, { mode: 0o600 });
    if (!(await exists(join(dir, 'config.toml')))) await writeFile(join(dir, 'config.toml'), '# Argo 회사 자격 codex 홈\n');
    return { env: {}, home: dir };
  }
  if (runner === 'gemini') {
    if (cred.type === 'apikey') return { env: { GEMINI_API_KEY: v } };
    // 회사 OAuth(웹 브리지) — oauth_creds.json을 회사별 격리 HOME의 .gemini에 풀어준다.
    const home = join(homedir(), '.argo', `gemini-home-${wsId}`);
    await mkdir(join(home, '.gemini'), { recursive: true, mode: 0o700 }); // OAuth 토큰 보관 — 소유자만
    if (!(await exists(join(home, '.gemini', 'oauth_creds.json')))) {
      await writeFile(join(home, '.gemini', 'oauth_creds.json'), v, { mode: 0o600 });
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
  // SDK가 띄우는 Bash/MCP 자식도 서버 시크릿(서비스 키)을 상속하지 않도록 항상 세척된 env를 준다(P1-6).
  // claude 호스트 폴백도 이제 null 대신 세척 env를 반환한다 — 러너 인증(ANTHROPIC_*)은 보존, 크라운주얼만 제거.
  if (cred) return { ...scrubServerSecrets(process.env), ...cred.env };
  if (runner === 'glm') return glmEnv(); // 회사 자격 없으면 호스트 GLM_API_KEY 폴백(glmEnv 자체가 세척됨)
  return scrubServerSecrets(process.env);
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
      company: cred?.value ? {
        connected: true,
        type: cred.type === 'oauth' ? 'oauth' : 'apikey',
        masked: maskCred(cred.value),
        // 저장 검증 도입 전(철회된 웹 브리지 등)에 들어온 무효 형식 토큰 — 카드가 "재연결 필요"를 보여준다
        ...(cred.type === 'oauth' && oauthFormatError(id, cred.value, 'ko') ? { invalid: true } : {}),
      } : { connected: false },
    };
  }
  return out;
}

/** 턴에 실제로 쓸 러너 결정 — 크루의 러너가 미가용(회사 자격도 호스트 자격도 없음)이면 가용한
    러너로 폴백한다. 어떤 러너든 하나만 연결돼 있으면 모든 크루가 응답하게 하는 관문.
    가용 = 회사 자격(BYOK/OAuth) 또는 호스트 자격(CLI 로그인·env). 반환 { runner, fellBack, available }. */
export async function resolveRunner(wsId, want) {
  const st = await runnerStatus(wsId);
  // 외부 CLI 러너(codex/gemini)는 실행 주체가 벤더 CLI라, 회사 자격(OAuth/키)이 있어도 이 컴퓨터에
  // CLI가 없으면 spawn ENOENT로 죽는다 — 자격만 보고 가용 판정하면 안 된다(웹 브리지로 연결한 새 기기 사례).
  // claude/glm은 번들 SDK CLI로 실행되므로 호스트 설치 불필요.
  const executable = (id) => (id === 'codex' || id === 'gemini' ? !!st[id]?.hostInstalled : true);
  const usable = (id) => !!st[id] && executable(id) && (st[id].company.connected || st[id].hostAuthed);
  if (usable(want)) return { runner: want, fellBack: false, available: true };
  for (const id of Object.keys(RUNNER_AUTH)) {
    if (usable(id)) return { runner: id, fellBack: true, available: true };
  }
  // 아무 러너도 없음 — 호출부가 안내 에러를 만든다(원래 러너 반환은 에러 문구용).
  // credButNoCli: 자격은 연결했는데 벤더 CLI가 없어 못 쓰는 러너 — "연결했는데 왜 안 되냐"에 정확히 답하기 위한 재료.
  const credButNoCli = Object.keys(RUNNER_AUTH).filter((id) => st[id]?.company.connected && !executable(id));
  return { runner: want, fellBack: false, available: false, credButNoCli };
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
      // Bearer OAuth를 명시적으로 검증한다. 유효 토큰의 200 응답은 실토큰 부재로 미실측 —
      // verify는 '검증 후 저장' 버튼의 opt-in 경로라, 만에 하나 오탐이 있어도 일반 저장은 막지 않는다.
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { authorization: `Bearer ${v}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
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

/* ─── Claude 원클릭 연결 — 공식 `claude setup-token`을 서버가 PTY로 대행(로컬/데스크톱 전용) ───
   왜 이 방식인가: 웹 브리지(구세대 엔드포인트 재현)는 러너가 거절하는 토큰을 저장해 철회했다
   (WEB_OAUTH 주석). setup-token은 CLAUDE_CODE_OAUTH_TOKEN의 유일한 공식 발급 경로라, 명령을
   그대로 대행하면 내부 플로우가 개편돼도 안전하다. 실측(2026-07-18): 비TTY에선 조용히 종료하므로
   script(1)로 PTY를 입힌다. PTY에선 코드 프롬프트 없이 브라우저를 열어 승인을 자동 수신하고,
   완료 시 stdout의 sk-ant-oat01- 토큰을 형식 검증 후 회사 자격으로 저장한다(터미널 불필요).
   기존 수동 붙여넣기 경로는 그대로 유지 — 이 대행이 실패하는 환경의 폴백이다(회귀 없음). */
const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000; // 브라우저 승인 대기 상한

/** PTY 출력에서 setup-token의 최종 토큰 추출(순수) — ANSI 제거 후 첫 매치. (export: 회귀 테스트용) */
export function extractSetupToken(text) {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  return clean.match(/sk-ant-oat01-[A-Za-z0-9_-]{16,}/)?.[0] ?? null;
}

/** setup-token을 실행할 claude CLI 경로 — env 오버라이드 → PATH. 없으면 null(수동 붙여넣기 안내). */
async function resolveClaudeCli() {
  if (process.env.CLAUDE_CLI?.trim()) return process.env.CLAUDE_CLI.trim();
  try { const r = await exec('which', ['claude']); const p = r.stdout.trim(); if (p) return p; } catch { /* 미설치 */ }
  return null;
}

const setupState = (globalThis.__argoSetupToken ??= {}); // wsId → { status: running|saved|failed, error, ts }

export function setupTokenStatus(wsId) {
  const s = setupState[wsId];
  return s ? { status: s.status, error: s.error ?? '' } : { status: 'idle' };
}

export async function startClaudeSetupToken(wsId) {
  // 호스팅 워커에선 금지 — 사용자 브라우저가 없는 곳에서 프로세스만 남는다(로컬/데스크톱 전용).
  if (process.env.ARGO_TENANT_OWNER || process.env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, reason: 'hosted' };
  if (process.platform === 'win32') return { ok: false, reason: 'unsupported-platform' }; // script(1) 부재 — 후속(node-pty 검토)
  if (setupState[wsId]?.status === 'running') return { ok: false, reason: 'busy' };
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
  setupState[wsId] = { status: 'running', ts: Date.now() };
  let buf = '';
  let done = false;
  const finish = (status, error = '') => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    setupState[wsId] = { status, error, ts: Date.now() };
    try { child.kill(); } catch { /* 이미 종료 */ }
  };
  const timer = setTimeout(() => finish('failed', '승인 대기 시간(10분)이 지났습니다 — 다시 시도하거나 토큰을 직접 붙여넣어 주세요'), SETUP_TOKEN_TIMEOUT_MS);
  timer.unref?.();
  const onData = (d) => {
    if (done) return;
    buf = (buf + d.toString()).slice(-20_000); // 꼬리만 유지 — 토큰은 마지막에 출력된다
    const token = extractSetupToken(buf);
    if (!token) return;
    // 토큰 감지 즉시 선점 — setup-token은 토큰 출력 직후 종료하므로, 비동기 저장이 끝나기 전의
    // 정상 exit가 finish('failed')로 덮으면 "저장됐는데 실패 표시"가 된다(검수 MEDIUM: 저장-exit 레이스).
    // done을 먼저 잠그고 저장 결과가 최종 상태를 정한다(그동안 상태는 running 유지 — UI는 진행 중 표시).
    done = true;
    clearTimeout(timer);
    // 토큰 평문은 저장 외 어디에도 남기지 않는다(로그·상태 객체 금지)
    saveRunnerCred(wsId, 'claude', 'oauth', token)
      .then(() => { setupState[wsId] = { status: 'saved', ts: Date.now() }; })
      .catch((e) => { setupState[wsId] = { status: 'failed', error: String(e.message || e).slice(0, 160), ts: Date.now() }; })
      .finally(() => { try { child.kill(); } catch { /* 이미 종료 */ } });
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
