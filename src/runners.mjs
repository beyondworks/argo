// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { paths } from './workspace.mjs';

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
      { id: '', label: '' }, // 기본 — UI가 i18n 라벨을 붙인다
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  codex: {
    name: 'Codex', kind: 'cli',
    models: [
      { id: '', label: '' }, // 기본 = 계정 기본 모델 — 계정 세대별 지원 모델이 달라 기본값이 가장 안전
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
      { id: '', label: '' },
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
      { id: '', label: '' }, // 기본 = glm-5.2 (chat에서 보정)
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
    const CODEX_HOME = cred?.home === 'clean' ? await codexHomeClean() : await codexHome();
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
// 시크릿이므로 (a) API 응답·로그엔 마스킹만, (b) 동기화 제외(sync EXCLUDE에 .secrets.json 포함됨).
const secretsFile = (wsId) => join(paths(wsId).root, '.secrets.json');

// 러너별 지원 인증 방식. apikey=붙여넣기(4러너 공통), oauth=붙여넣기 토큰(claude) 또는 호스트 로그인(codex/gemini).
// glm은 Anthropic 호환 토큰(사실상 apikey)만.
// connect: 벤더 CLI의 브라우저 로그인을 서버가 대신 실행할 수 있는 러너(로컬/데스크톱 전용).
//   bin/loginArgs=로그인 실행, statusArgs=읽기전용 상태확인, ok=로그인됨 판정 정규식.
//   codex만 spawn 가능한 login이 있다. claude는 이 CLI에 login 서브커맨드가 없어(구독은 키체인)
//   oauthPasteable 토큰 붙여넣기로, gemini는 CLI 설치 후 로그인 안내로 대체한다.
export const RUNNER_AUTH = {
  claude: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-ant-', oauthPasteable: true, oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', keyUrl: 'https://console.anthropic.com/settings/keys' },
  codex: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-', oauthPasteable: false, keyUrl: 'https://platform.openai.com/api-keys', connect: { bin: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'], ok: /Logged in/i } },
  gemini: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://aistudio.google.com/apikey' },
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
    return cred.type === 'apikey' ? { env: { OPENAI_API_KEY: v }, home: 'clean' } : null; // oauth는 호스트 로그인 사용(null)
  }
  if (runner === 'gemini') {
    return cred.type === 'apikey' ? { env: { GEMINI_API_KEY: v } } : null; // oauth는 호스트 로그인
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
  const out = {};
  for (const [id, meta] of Object.entries(RUNNER_AUTH)) {
    const cred = secrets.runners?.[id];
    out[id] = {
      methods: meta.methods,
      oauthPasteable: !!meta.oauthPasteable,
      connectable: !!meta.connect, // Connect 버튼(CLI 브라우저 로그인 대행) 지원 여부 — codex
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
