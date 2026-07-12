// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonLenient, writeJsonAtomic } from './jsonstore.mjs';
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
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    ],
  },
  gemini: {
    name: 'Gemini', kind: 'cli',
    models: [
      { id: '', label: '' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  glm: {
    name: 'GLM', kind: 'sdk-compat',
    models: [
      { id: '', label: '' }, // 기본 = glm-4.6 (chat에서 보정)
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
    ],
  },
};

export const GLM_DEFAULT_MODEL = 'glm-4.6';
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

/** 외부 CLI 러너 1턴 — 워크스페이스를 cwd로, 프롬프트 하나로 실행하고 마지막 응답을 받는다. */
export async function externalExec({ runner, model, cwd, prompt, timeoutMs = 300_000 }) {
  if (runner === 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'argo-codex-'));
    const out = join(dir, 'last.txt');
    try {
      await exec('codex', [
        'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
        '--output-last-message', out,
        ...(model ? ['-m', model] : []),
        '--', prompt, // 프롬프트가 '---'(카드 frontmatter)로 시작해도 플래그로 오해하지 않도록
      ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, env: { ...process.env, CODEX_HOME: await codexHome() } })
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
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6 })
      .catch((e) => { throw apiError(e); });
    return stdout
      .replace(/^(Loaded cached credentials\.|Data collection is .*|\[STARTUP\].*|\[dotenv.*)\s*$/gim, '')
      .trim();
  }
  throw new Error(`알 수 없는 외부 러너: ${runner}`);
}

// ── 회사 Claude 키(BYOK) — 일반 사용자가 Claude Code 없이도 크루를 굴리게 하는 자격 저장소.
// 회사 루트 .secrets.json에 보관. 시크릿이므로 (a) API 응답·로그엔 마스킹만, (b) 동기화 제외 대상.
// 주의: sync EXCLUDE에 '.secrets.json' 추가 필요 — 현재 미포함이면 시크릿이 기기 간 복제된다(sync.mjs는 이 작업 범위 밖).
const secretsFile = (wsId) => join(paths(wsId).root, '.secrets.json');

/** 회사 Claude API 키 로드 — 없으면 null. */
export async function loadClaudeKey(wsId) {
  const s = await readJsonLenient(secretsFile(wsId), {}).catch(() => ({}));
  const k = s?.claude;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

/** 회사 Claude API 키 저장 — 원자적 쓰기. 다른 시크릿 필드는 보존. */
export async function saveClaudeKey(wsId, key) {
  const s = await readJsonLenient(secretsFile(wsId), {}).catch(() => ({}));
  await writeJsonAtomic(secretsFile(wsId), { ...s, claude: String(key).trim() });
}

/** 회사 Claude API 키 제거 — 파일의 다른 시크릿은 유지. */
export async function clearClaudeKey(wsId) {
  const s = await readJsonLenient(secretsFile(wsId), {}).catch(() => ({}));
  const { claude, ...rest } = s;
  await writeJsonAtomic(secretsFile(wsId), rest);
}

/** 마스킹 — 접두사만 노출(보안 규칙). 평문은 답변·로그 어디에도 남기지 않는다. */
export function maskClaudeKey(key) {
  return key ? `${key.slice(0, 6)}***` : '';
}

/** SDK env 주입값 — 회사 키가 있으면 ANTHROPIC_API_KEY로 넣고, 없으면 null(기존 CLI/env 자격으로 폴백 — 회귀 0). */
export async function claudeEnvFor(wsId) {
  const key = await loadClaudeKey(wsId);
  return key ? { ...process.env, ANTHROPIC_API_KEY: key } : null;
}

/** 키 인증 확인 — Anthropic models 엔드포인트로 저비용 검증(토큰 미소모).
    반환: { ok:true } 통과 · { ok:false } 인증 거부(401/403) · { ok:null } 네트워크 불가(판정 보류). */
export async function verifyClaudeKey(key) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: null };
  }
}
