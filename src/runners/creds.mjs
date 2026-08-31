// 러너 자격(BYOK/BYOA) — 회사·계정 스코프 저장/로드·시드·env 조립(sdkEnvFor)·자격 검증.
// (runners.mjs 관심사 분리 2026-07-28)

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonstore.mjs';
import { WS_ROOT, paths } from '../workspace.mjs';
import { exists, homeEnv, scrubServerSecrets, seedAuthFile } from './shared.mjs';
import { RUNNER_AUTH } from './catalog.mjs';
import { provisionCodexCli } from './codex.mjs';
import { provisionGeminiCli, geminiTurnHome } from './gemini.mjs';
import { grokAccessToken, grokExpired, grokNeedsRefresh, refreshGrokTokens } from './grok.mjs';

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
    (codex/gemini=파일 자격, antigravity=OS 키링이라 host 옵트인이 유일 경로, claude=키체인이라 non-standalone에서만 — RUNNER_AUTH.hostUsable·hostOptInAllowed 참조).
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

/** 러너 자격 제거 — 다른 러너는 유지. 격리 홈도 함께 지운다: 연결 해제 후에도 auth.json에 평문
    키가 0600으로 남아 있었다(검수 — env 주입 시절엔 apikey가 디스크에 자격 파일을 안 만들었으니
    auth.json 전환이 새로 연 표면). saveRunnerCred의 리셋과 대칭. */
export async function clearRunnerCred(wsId, runner) {
  const s = await loadSecrets(wsId);
  const { claude, ...rest } = s;
  if (rest.runners) delete rest.runners[runner];
  await writeJsonAtomic(secretsFile(wsId), rest);
  if (!isAccountScope(wsId)) {
    if (runner === 'codex') await rm(join(homedir(), '.argo', `codex-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
    if (runner === 'gemini') await rm(join(homedir(), '.argo', `gemini-home-${wsId}`), { recursive: true, force: true }).catch(() => {});
  }
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
    반환: { env, home } — env=주입 변수 dict, home=회사 자격 격리 홈 경로(codex는 apikey·oauth 모두
    auth.json 경유 — env 키 주입('clean')은 CLI가 안 읽어 폐기 2026-07-26). */
export async function runnerCredEnv(wsId, runner) {
  const cred = await loadRunnerCred(wsId, runner);
  if (!cred) return null;
  // gemini는 host 옵트인도 격리 HOME으로 실행한다(아래 geminiTurnHome) — codex(CODEX_HOME)·SDK(settingSources:[])와
  // 달리 gemini는 HOME 전역 config(GEMINI.md·save_memory·전 도구)를 상속해 테넌트 격리가 없었다. host는 로그인만 빌리고
  // 나머지는 격리한다. 그래서 아래 일반 host→null 분기보다 먼저 처리한다.
  if (runner === 'gemini') {
    const g = await geminiTurnHome(wsId, cred);
    if (!g) return null; // host인데 호스트 로그인이 없음 — 폴백 없음(명시 연결 원칙)
    return { env: { ...homeEnv(g.home), ...g.env }, home: g.home, authType: g.authType };
  }
  // host 마커 — 이 컴퓨터 CLI 로그인 경로(codexHome 상속 등)를 명시 옵트인으로 사용. env 주입 없음.
  if (cred.type === 'host') return null;
  const v = cred.value;
  if (runner === 'claude') {
    // ANTHROPIC_BASE_URL 고정 — glm·kimi·openrouter·grok는 cred.env에서 base를 항상 명시하는데
    // claude만 빠져 호스트 env의 ANTHROPIC_BASE_URL을 상속했다(검수 D5: 회사 API 키가 제3자
    // 프록시로 나가는 표면 + verify는 api.anthropic.com 고정이라 "검증 초록·턴은 딴 곳"). 오버라이드가
    // 필요하면 ARGO_CLAUDE_BASE_URL로만(호스트 잡음과 분리).
    const base = process.env.ARGO_CLAUDE_BASE_URL || 'https://api.anthropic.com';
    return cred.type === 'oauth'
      ? { env: { ANTHROPIC_BASE_URL: base, CLAUDE_CODE_OAUTH_TOKEN: v, ANTHROPIC_API_KEY: '' } }
      : { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: v, CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'glm') {
    // CLAUDE_CODE_OAUTH_TOKEN 명시 소거 — claude 분기와 대칭. Anthropic 구독 토큰이 제3자(z.ai) 향
    // 턴 env에 남으면 자식 프로세스에서 열람 가능(감사 2026-07-20 — scrub 러너 인자와 벨트앤서스펜더).
    return { env: { ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'kimi') {
    return { env: { ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'openrouter') {
    // GLM·Kimi와 동일한 Anthropic 호환 패턴 — BYOK 계열 일반화(설계 2026-07-27).
    // 배관 실측(2026-07-27): 스모크 8/8(tool_use 왕복) + CLI 실요청 65KB(베타 9종·스트리밍) 수용 확인.
    // 출력 상한은 기본으로 걸지 않는다(검수 MEDIUM-2: 다른 러너엔 없는 상한 = 러너 차등 + 긴 답변
    // 절단이 "AI가 대충 답함"으로 읽힘). OpenRouter는 선불제로 max_tokens 선언분만큼 잔액을
    // 선검사(실측 402)하지만, 저잔액은 402 안내문(chat.mjs·oneshot)이 원인·충전처를 알려준다.
    // 운영자가 원하면 env로만 상한 선언(OPENROUTER_MAX_OUTPUT_TOKENS).
    return { env: {
      ANTHROPIC_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: v, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      ...(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.OPENROUTER_MAX_OUTPUT_TOKENS } : {}),
    } };
  }
  if (runner === 'grok') {
    // xAI Anthropic 호환 배관 — GLM·Kimi와 같은 형태(근거·실측은 grok.mjs 머리 주석).
    // BYOK는 키 그대로, BYOA(기기 코드)는 저장된 JSON에서 access_token을 꺼내 같은 자리에 싣는다.
    // **여기가 갱신 지점이다**: 턴 직전이라 만료를 가장 늦게, 가장 확실하게 판정한다.
    let tok = v;
    if (cred.type === 'oauth') {
      let cur = v;
      if (grokNeedsRefresh(cur)) {
        const next = await refreshGrokOnce(wsId, cur);
        if (next) cur = next;
      }
      // 만료 자격 게이트(P0, 2026-08-31) — 갱신 실패여도 **아직 만료 전**(여유 5분 창)이면 쓰던
      // 토큰으로 진행한다(일시적 네트워크 장애가 연결 해제로 둔갑하지 않게 — 기존 원칙 유지, 자격도
      // 안 지운다). 단 **갱신 후에도 만료 상태**(갱신 실패·갱신 불가 포함)면 다르다: 보내봤자 xAI가
      // 400을 주고(실측 2026-08-31 — "제공자가 401을 준다"던 옛 전제는 xAI에 거짓), 그 400은 SDK가
      // 성공 답변으로 삼키기까지 한다. 턴 전에 명시적으로 끊고 표면(chat.mjs)이 authExpired로
      // 사용자 언어 안내를 그린다. 만료시각 없는 구형 값은 grokExpired가 false라 이 게이트를 안 탄다.
      if (grokExpired(cur)) {
        throw Object.assign(new Error('grok token expired and refresh failed'), { authExpired: 'grok' });
      }
      tok = grokAccessToken(cur);
    }
    return { env: { ANTHROPIC_BASE_URL: process.env.GROK_BASE_URL || 'https://api.x.ai', ANTHROPIC_AUTH_TOKEN: tok, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } };
  }
  if (runner === 'codex') {
    // apikey·oauth 모두 격리 CODEX_HOME의 auth.json으로 — codex CLI(0.144 실측)는 env OPENAI_API_KEY를
    // 더는 인정하지 않는다. 이전의 env 주입(home:'clean')은 저장 검증(OpenAI 직접 호출)만 통과하고
    // 모든 턴이 "Missing bearer or basic authentication in header" 401이었다(실사용 신고 2026-07-26,
    // 이 맥 재현: env 가짜키 → Missing bearer / auth.json 가짜키 → Incorrect API key = 키가 전달됨).
    // apikey ↔ oauth 전환 시 잔재 상속은 saveRunnerCred가 자격 변경마다 격리 홈을 리셋해 차단한다.
    const dir = join(homedir(), '.argo', `codex-home-${wsId}`);
    await mkdir(dir, { recursive: true, mode: 0o700 }); // 자격 보관 — 소유자만
    // apikey는 codex auth.json의 API 키 형식으로 포장, oauth는 저장된 auth.json 원문 그대로.
    const authJson = cred.type === 'apikey' ? JSON.stringify({ OPENAI_API_KEY: v, tokens: null }) : v;
    // adopt는 oauth에만 — 마커 없는 기존 파일 채택은 CLI가 회전시킨 토큰 보존이 목적이다. apikey는
    // CLI가 갱신할 게 없어 채택할 이유가 없고, 채택하면 rm 실패로 남은 옛 OAuth 잔재가 새 키를 영영
    // 밀어내며 UI만 "연결됨"이 된다(검수 재현 — 2026-07-20 "죽은 자격으로 도는데 연결됨" 계열).
    await seedAuthFile(dir, 'auth.json', authJson, { adopt: cred.type !== 'apikey' }); // 자격 변경(동기화 포함) 시 재시드

    if (!(await exists(join(dir, 'config.toml')))) await writeFile(join(dir, 'config.toml'), '# Argo 회사 자격 codex 홈\n');
    // OPENAI_API_KEY 명시 소거(claude OAuth 대칭) — 호스트/프로세스 env에 API 키가 있으면 미래 CLI가
    // auth.json보다 그 키를 우선할 수 있어 무효·타계정 키로 턴이 실패한다("api키 설정값 우선" 신고 2026-07-24).
    // scrubServerSecrets는 이 키를 codex 소유라 남겨두므로, 여기서 빈 값으로 덮어 auth.json 경로를 보장한다.
    return { env: { OPENAI_API_KEY: '' }, home: dir };
  }
  return null;
}

/* Grok 토큰 갱신은 **한 번에 하나만** 돈다(wsId 단위 in-flight 락).
   병렬 턴(루틴 + 메신저 수신 + 위임 팬아웃은 이 제품에서 흔하다)이 동시에 만료 임박을 보면
   같은 refresh_token으로 각자 교환을 시도한다. 제공자가 RT를 회전시키면 두 번째는 소비된 RT로
   실패하고, 더 나쁜 순서에서는 뒤늦은 저장이 이미 무효화된 RT를 덮어써 **이후 모든 갱신이 영구
   실패**한다("잘 되다가 어느 날부터 grok만 전부 401"). 레포 선례 = devicesession.mjs의 단일 소유자 회전.
   (xAI의 RT 회전 여부는 미검증 — 회전하지 않더라도 이 락은 중복 호출만 줄일 뿐 해가 없다.) */
const grokRefreshing = (globalThis.__argoGrokRefresh ??= new Map()); // wsId → Promise<string|null>
function refreshGrokOnce(wsId, stored) {
  const inflight = grokRefreshing.get(wsId);
  if (inflight) return inflight;
  const p = (async () => {
    const next = await refreshGrokTokens(stored);
    if (next) await saveRunnerCred(wsId, 'grok', 'oauth', next);
    return next;
  })().finally(() => { grokRefreshing.delete(wsId); });
  grokRefreshing.set(wsId, p);
  return p;
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
  const env = scrubServerSecrets(process.env, runner);
  // claude 호스트 폴백 결정론화(2R 검수 HIGH-2): 구독 토큰과 API 키 env가 공존하면 SDK가 뭘
  // 쓰는지는 SDK 내부 소관이라 판정(billedByType)과 어긋날 수 있다 — 구독 토큰이 있으면 API
  // 키를 소거해 실행을 구독으로 확정한다(한쪽 소거 패턴은 #83과 동일, 방향은 사용자 유리).
  if (runner === 'claude' && env.CLAUDE_CODE_OAUTH_TOKEN) env.ANTHROPIC_API_KEY = '';
  return env;
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
      // 턴과 같은 base(runnerCredEnv의 ARGO_CLAUDE_BASE_URL 고정과 대칭) — 검증=실행 동일 경로 원칙
      const cbase = process.env.ARGO_CLAUDE_BASE_URL || 'https://api.anthropic.com';
      const r = await fetch(`${cbase}/v1/models?limit=1`, { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
      return { ok: !(r.status === 401 || r.status === 403) };
    }
    if (runner === 'claude' && type === 'oauth') {
      // CLAUDE_CODE_OAUTH_TOKEN 검증 — Bearer + oauth 베타 헤더. 실측(2026-07-18): 무효 토큰에
      // 401 {"type":"authentication_error","message":"OAuth access token is invalid."} — 엔드포인트가
      // Bearer OAuth를 명시적으로 검증한다. 유효 토큰의 200 통과도 실측 확인(2026-07-20, 키체인
      // 실토큰 — oauth 베타 헤더 유무 모두 200). 이제 검증은 저장의 필수 관문이라(무검증 '저장만'
      // 제거) 오탐이 곧 저장 차단이지만, 원클릭(setup-token)도 같은 호출로 게이트해 왔고 양방향
      // 실측이 갖춰져 오탐 위험은 근거 있이 낮다.
      const cbase2 = process.env.ARGO_CLAUDE_BASE_URL || 'https://api.anthropic.com';
      const r = await fetch(`${cbase2}/v1/models?limit=1`, { headers: { authorization: `Bearer ${v}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
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
    if (runner === 'grok') {
      // ponytail: /v1/messages 최소 호출로 **실대화 가능 여부**까지 확인(유건 제보 2026-08-08:
      // /v1/models는 통과하지만 /v1/messages에서 403 — 표준 SuperGrok이 API 미허용).
      // max_tokens:1 + 짧은 프롬프트로 비용 최소화(프로브 목적). 403 = 등급/크레딧 문제로 분류.
      const base = process.env.GROK_BASE_URL || 'https://api.x.ai';
      const tok = type === 'oauth' ? grokAccessToken(v) : v;
      const r = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'grok-4.5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 401) return { ok: false };
      if (r.status === 403) {
        // 403 = 등급 제한(Heavy-only) 또는 크레딧 소진. 사용자에게 사유를 갈라 안내할 수 있도록
        // body에서 코드를 꺼내 본다 — 꺼내지 못해도 ok:false는 확정(연결 거부).
        const body = await r.text().catch(() => '');
        const isCredit = /insufficient.*(credit|balance|fund)|credit.*exhaust/i.test(body);
        return { ok: false, reason: isCredit ? 'credit' : 'tier' };
      }
      if (r.status === 400) {
        // **xAI는 잘못된 키에 400을 준다**(실측 2026-08-26: {"code":"invalid-argument","error":"Incorrect
        // API key provided..."}). 401만 거부하면 "not even a key"까지 통과해 거짓 초록불이 된다
        // (gemini 400 API_KEY_INVALID·glm 200바디와 **같은 계열의 세 번째 구멍** — 불변식 전수 수색
        // 누락, invariant-change-sweep 위반). 단 "Model not found"는 키가 아니라 모델 문제 →
        // 키는 유효로 본다(카탈로그 모델 오류 시 유효 키 오거절 방지, gemini 400 처리와 같은 원칙).
        const body = await r.text().catch(() => '');
        if (/model not found/i.test(body)) return { ok: true }; // 모델 문제 ≠ 키 무효
        // "invalid-argument"는 xAI의 제네릭 400 코드다 — Model not found도 같은 코드를 달고 온다(위
        // 분기가 그 증거). 코드가 아니라 **인증 특정 문구**로만 무효 판정해야 유효 키의 비인증 400을
        // 오거절하지 않는다(적대 검수 2026-08-26 권고 — 무효 키 바디는 "Incorrect API key"를 담는다).
        if (/incorrect api key|invalid[ _-]*api[ _-]*key|api[ _-]*key[ _-]*(?:invalid|not valid)|"code"\s*:\s*"unauthenticated|bad[ _-]*credentials/i.test(body)) return { ok: false };
        return { ok: true }; // 그 밖의 400(요청 형식 등)은 인증과 무관 — 유효로 본다
      }
      return { ok: true }; // 200·기타 4xx는 인증+등급 통과
    }
    if (runner === 'openrouter') {
      // GET /api/v1/key = 키 자체 조회(잔액·한도) — 무효 키는 401. 모델 목록(공개)과 달리 키 유효성을 직접 판정한다.
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(10_000) });
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

// ── 하위호환 얇은 래퍼 (기존 호출부 유지) ──
export const loadClaudeKey = async (wsId) => (await loadRunnerCred(wsId, 'claude'))?.value ?? null;
export const maskClaudeKey = maskCred;
export const claudeEnvFor = (wsId) => sdkEnvFor(wsId, 'claude');

export { loadSecrets, credType }; // 러너 모듈 내부 공용(facade 미노출 — runnerStatus가 쓴다)
