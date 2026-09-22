// 검수 K52·K56 — 외부 CLI 러너 턴(chat.mjs cliTurn 갈래)의 실패 표면. 실제 chat()을 돌리되 러너 해석·벤더 CLI 실행만 격리한다.
// K52: 턴 전 자격 게이트(runnerCredEnv — 실제 함수)가 끊은 authExpired 오류("… credential known-invalid since … — not started")에
//      CLI 갈래만 재연결 안내가 없어, 앱 채팅·텔레그램 회신(gateway.mjs '처리 실패: ${e.message}')에 내부 영문 원문만 갔다.
//      SDK 갈래는 같은 오류를 runnerAuthNotice로 대체한다(chat.mjs SDK catch의 authExpired 갈래).
// K56: CLI 빈 응답 오류 문구가 한국어로 고정돼 영어 회사에도 한국어로 나갔다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-surface-cli-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-surface-cli-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' }); // gemini API 키 자격 = CLI 턴
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in CLI surface test'); };
let execCalls = 0;
const wrappers = new Map();
for (const [relative, replacements] of [
  // 러너 해석은 이 기기의 CLI 설치 여부와 무관하게 gemini로 고정(제외 목록이 와도 같은 러너 → 자가치유 대상 없음).
  // runnerCredType·runnerCredEnv(턴 전 자격 게이트)는 실제 함수 그대로다.
  ['./runners.mjs', `
    export const resolveRunner = async () => ({ runner: 'gemini', available: true, fellBack: false });
    export const isBilledRunner = async () => false;
    export const externalExec = (...args) => globalThis.__argoSurfaceCliExec(...args);
  `],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};\n${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/\/src\/chat\.mjs$/.test(context.parentURL ?? '') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = realFetch; delete globalThis.__argoSurfaceCliExec; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { markRunnerAuthFail } = await import('../src/runner-health.mjs');
const { chat } = await import('../src/chat.mjs');
const KEY = `AIza${'x'.repeat(35)}`; // 형식만 맞춘 가짜 — 네트워크는 막혀 있다

async function company(ws, lang) {
  await createCompany(ws, '표면 CLI', 'owner', null, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'g.md'), '---\nname: 지\nrole: 검증\nrunner: gemini\n---\n검증용.\n');
  await saveRunnerCred(ws, 'gemini', 'apikey', KEY);
}

test('K52 턴 전 게이트가 끊은 CLI 턴은 내부 원문 대신 재연결 안내를 사용자에게 준다', async () => {
  const ws = 'surface-cli-auth';
  await company(ws, 'ko');
  await markRunnerAuthFail(ws, 'gemini', KEY); // 직전 턴·검진이 "이 자격은 인증 실패"로 확정한 상태
  execCalls = 0; globalThis.__argoSurfaceCliExec = async () => { execCalls += 1; return 'ran'; };
  let err = null;
  await chat(ws, 'g', '안녕', null, {}).catch((e) => { err = e; });
  assert.ok(err, '게이트가 턴을 끊어야 한다');
  assert.equal(execCalls, 0, '게이트는 벤더 CLI를 띄우기 전에 끊는다');
  assert.doesNotMatch(String(err.message), /known-invalid|not started/, `내부 원문이 사용자에게 갔다: ${err.message}`);
  assert.match(String(err.message), /설정 → AI 연결/, `할 일(재연결)이 안 보인다: ${err.message}`);
  assert.equal(err.failCode, 'auth_expired', '실패 코드는 그대로 실린다');
});

test('K56 CLI 빈 응답 오류는 회사 언어로 나간다(영어 회사)', async () => {
  const ws = 'surface-cli-empty-en';
  await company(ws, 'en');
  globalThis.__argoSurfaceCliExec = async () => '';
  let err = null;
  await chat(ws, 'g', 'hello', null, {}).catch((e) => { err = e; });
  assert.ok(err, '빈 응답은 실패여야 한다');
  assert.doesNotMatch(String(err.message), /[가-힣]/, `영어 회사에 한국어 오류가 나갔다: ${err.message}`);
  assert.match(String(err.message), /empty/i);
});
