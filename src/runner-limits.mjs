// 러너 잔여 한도(K91, 유건 지시 2026-09-22) — 금액 표시가 과금 오해를 불러 걷어내고, 대신 구독 계정의 사용 한도 창(5시간·7일 등)을
// 크루 입력줄 게이지로 보인다(K92). 지금 가진 자격으로 얻을 수 있는 세 러너만 다룬다:
//  · Claude 구독 OAuth — SDK 스트림의 rate_limit_event(unifiedWindows). API 키 턴엔 이 이벤트가 오지 않는다(가짜 엔드포인트 실측).
//  · Codex ChatGPT 로그인(기본 CLI exec 경로) — 턴 홈 rollout의 마지막 token_count.rate_limits(agentpulse CodexRollout.swift와 같은 읽기).
//  · GLM 코딩 플랜 API 키 — 아래 readGlmQuota(조회형, 저장 안 함).
// 뺀 러너(2026-09-22 조사): Kimi API 키는 금액 잔고뿐(창은 Kimi Code 로그인 전용), Gemini는 API 키 종량제라 창이 없고,
// Antigravity는 한도가 agy 내부 API에만 있어 로그인 토큰을 꺼내 써야 한다(계정 제재 위험) — 셋 다 게이지 없음.
// 같은 계정을 여러 회사가 공유하므로 회사 폴더가 아니라 WS_ROOT에 계정 지문(credHash) 키로 둔다 — 토큰·계정 id 원문은 남기지 않는다.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { WS_ROOT } from './workspace.mjs';
import { credHash } from './runners/shared.mjs';
import { loadSecrets, credType } from './runners/creds.mjs';
import { parseCodexAuth, accountIdOf } from './runners/codex-oauth.mjs';

const FILE = () => join(WS_ROOT, '.runner-limits.json');

/** Claude 계정 키 — 턴 env의 구독 토큰 지문, 토큰이 없으면 이 컴퓨터 로그인(host). */
const claudeKey = (env) => `claude:${env?.CLAUDE_CODE_OAUTH_TOKEN ? credHash(env.CLAUDE_CODE_OAUTH_TOKEN) : 'host'}`;
/** Codex 계정 키 — auth.json의 ChatGPT 계정 id 지문. API 키 auth.json(tokens 없음)은 null(표시 안 함). */
const codexKey = (authText) => { const acct = accountIdOf(parseCodexAuth(authText)); return acct ? `codex:${credHash(acct)}` : null; };

async function save(key, windows) {
  if (!key || !windows.length) return;
  const all = await readJson(FILE(), {}).catch(() => ({})); // 손상은 빈 상태로 — 다음 턴이 다시 채운다
  all[key] = { at: Date.now(), windows };
  await writeJsonAtomic(FILE(), all);
}

/** SDK rate_limit_event → 저장. utilization은 0~1 비율이다 — SDK가 anthropic-ratelimit-unified-5h-utilization 헤더 값을
    그대로 싣는다(가짜 엔드포인트 실측: 헤더 0.42 → utilization 0.42). 그래서 ×100 한 가지로 정한다. */
export async function recordClaudeLimits(env, info) {
  const w = info?.unifiedWindows ?? {};
  const windows = [['five_hour', 300], ['seven_day', 10080]].flatMap(([k, mins]) => (Number.isFinite(w[k]?.utilization)
    ? [{ mins, pct: Math.round(w[k].utilization * 100), resetsAt: Number(w[k].resetsAt) || null }] : []));
  await save(claudeKey(env), windows);
}

/** 턴 뒤(임시 CODEX_HOME 삭제 전) rollout 끝 256KB에서 마지막 token_count.rate_limits → 저장. used_percent는 0~100. */
export async function recordCodexRollout(codexHome) {
  const key = codexKey(await readFile(join(codexHome, 'auth.json'), 'utf8').catch(() => ''));
  if (!key) return;
  const sessions = join(codexHome, 'sessions');
  let newest = null; // 턴 홈은 턴마다 새로 만든다 — rollout은 보통 하나, 여럿이면 가장 늦게 바뀐 것
  for (const rel of await readdir(sessions, { recursive: true }).catch(() => [])) {
    if (!/(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(rel)) continue;
    const s = await stat(join(sessions, rel)).catch(() => null);
    if (s && (!newest || s.mtimeMs > newest.mtimeMs)) newest = { file: join(sessions, rel), mtimeMs: s.mtimeMs, size: s.size };
  }
  if (!newest) return;
  const fh = await open(newest.file, 'r');
  let text;
  try {
    const len = Math.min(newest.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, newest.size - len);
    text = buf.toString('utf8');
  } finally { await fh.close(); }
  for (const line of text.split('\n').reverse()) {
    let o; try { o = JSON.parse(line); } catch { continue; } // 잘린 첫 줄·빈 줄
    const rl = o?.payload?.type === 'token_count' ? o.payload.rate_limits : null;
    if (!rl) continue;
    const windows = [rl.primary, rl.secondary].filter((x) => Number.isFinite(x?.used_percent) && Number.isFinite(x?.window_minutes))
      .map((x) => ({ mins: x.window_minutes, pct: Math.round(x.used_percent), resetsAt: Number(x.resets_at) || null }));
    return save(key, windows);
  }
}

/** 회사가 쓰는 자격의 계정 키로 저장값을 찾는다 — claude 구독 OAuth·codex ChatGPT 로그인(회사 자격 또는 host 마커)만.
    반환: [{ runner, ageMs, windows: [{ mins, pct, resetsInMs }] }]. 리셋이 지난 창은 뺀다(그 뒤 사용량은 모른다). */
export async function readRunnerLimits(wsId, now = Date.now()) {
  const runners = (await loadSecrets(wsId).catch(() => ({})))?.runners ?? {};
  const keys = [];
  const c = runners.claude?.value ? credType(runners.claude.type) : null;
  if (c === 'oauth') keys.push(['claude', claudeKey({ CLAUDE_CODE_OAUTH_TOKEN: runners.claude.value })]);
  if (c === 'host') keys.push(['claude', claudeKey(process.env)]); // sdkEnvFor host 폴백과 같은 env
  const x = runners.codex?.value ? credType(runners.codex.type) : null;
  if (x === 'oauth') keys.push(['codex', codexKey(runners.codex.value)]);
  if (x === 'host') keys.push(['codex', codexKey(await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8').catch(() => ''))]); // importCodexAuth(K26)와 같은 원본
  const glm = runners.glm?.value && credType(runners.glm.type) === 'apikey' ? await readGlmQuota(runners.glm.value, now) : null;
  if (!keys.length) return glm ? [glm] : [];
  const all = await readJson(FILE(), {}).catch(() => ({}));
  const stored = keys.flatMap(([runner, key]) => {
    const e = key ? all[key] : null;
    const windows = (e?.windows ?? []).filter((w) => !w.resetsAt || w.resetsAt * 1000 > now)
      .map((w) => ({ mins: w.mins, pct: w.pct, resetsInMs: w.resetsAt ? w.resetsAt * 1000 - now : null }));
    return windows.length ? [{ runner, ageMs: now - e.at, windows }] : [];
  });
  return glm ? [...stored, glm] : stored;
}

// GLM(Z.ai 코딩 플랜) — 턴을 기다리지 않고 조회한다. 공식 문서 없는 모니터 엔드포인트(opencode-glm-quota·onWatch 등이 같은 키로 사용):
// GET <GLM_BASE_URL의 origin>/api/monitor/usage/quota/limit, Authorization = 키 원문(Bearer 없음) → data.limits[]의
// TOKENS_LIMIT(unit 3=시간·6=주, number, percentage 0~100, nextResetTime ms). 턴이 가는 origin으로만 보낸다(키가 새 곳으로 나가지 않게).
// 종량제 키·실패·모양 불일치는 조용히 null(게이지 없음). ⚠ 실계정 미검증 — 가짜 서버 테스트만(test/runner-limits.test.mjs).
// ponytail: 프로세스 메모리 캐시 60초 — 사이드바 30초 폴이 매번 z.ai를 치지 않게. 여러 프로세스면 각자 캐시.
const glmCache = new Map();
const GLM_UNIT_MINS = { 3: 60, 6: 10080 };
async function readGlmQuota(key, now) {
  const id = credHash(key);
  const hit = glmCache.get(id);
  if (hit && now - hit.at < 60_000) return hit.v;
  let v = null;
  try {
    const origin = new URL(process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic').origin;
    const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, { headers: { Authorization: key, 'Accept-Language': 'en-US,en' }, signal: AbortSignal.timeout(2500) }); // 크루 화면 첫 조회가 이 응답을 기다린다 — 느린 z.ai가 화면을 오래 붙잡지 않게
    const limits = res.ok ? (await res.json())?.data?.limits : null;
    const windows = (Array.isArray(limits) ? limits : [])
      .filter((l) => l?.type === 'TOKENS_LIMIT' && GLM_UNIT_MINS[l.unit] && Number.isFinite(l.number) && Number.isFinite(l.percentage))
      .map((l) => ({ mins: GLM_UNIT_MINS[l.unit] * l.number, pct: Math.round(l.percentage), resetsInMs: Number.isFinite(l.nextResetTime) && l.nextResetTime > now ? l.nextResetTime - now : null }));
    v = windows.length ? { runner: 'glm', ageMs: 0, windows } : null;
  } catch { /* 네트워크·JSON 실패 — 게이지 없음 */ }
  glmCache.set(id, { at: now, v });
  return v;
}
