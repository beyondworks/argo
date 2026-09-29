// argo CLI 환경 — src 모듈을 불러오기 **전에** 적용해야 한다(workspace.mjs의 WS_ROOT가 불러오는 순간 고정된다).
// 이 파일은 src의 다른 모듈을 import하지 않는다.
// 설정 파일 ~/.argo/cli.json: { root, lang, ws, supabase: { url, anonKey }, chromePath }.
// Supabase는 공개 설정(URL·anon 키)만 읽는다 — 서비스 키 등 비밀값은 읽지도 넣지도 않는다(CLI는 사용자 기기 세션으로만 동작).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

export const cliHome = (env = process.env) => env.ARGO_CLI_HOME || join(homedir(), '.argo');
export const configFile = (env = process.env) => join(cliHome(env), 'cli.json');

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
export const readConfig = (env = process.env) => readJson(configFile(env)) ?? {};
export function writeConfig(patch, env = process.env) {
  const next = { ...readConfig(env), ...patch };
  mkdirSync(cliHome(env), { recursive: true });
  writeFileSync(configFile(env), JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(configFile(env), 0o600); // mode 옵션은 새 파일에만 적용된다 — 이미 있던 느슨한 권한도 바로잡는다
  return next;
}

/** .env 파일에서 Supabase **공개** 설정 두 개만 꺼낸다(순수에 가깝게 — 다른 줄은 보지도 않는다). 레포에서 개발할 때용. */
export function publicSupabaseFromDotenv(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const pick = (...keys) => {
    for (const k of keys) { const m = text.match(new RegExp(`^${k}=(.*)$`, 'm')); if (m) return m[1].trim().replace(/^["']|["']$/g, ''); }
    return '';
  };
  const url = pick('NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL');
  const anonKey = pick('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
  return url && anonKey ? { url, anonKey } : null;
}

/** process.env에 CLI 기본값을 채운다. 반환: 설정 파일 내용. repoRoot = 이 CLI가 든 레포(또는 배포물) 루트. */
export function applyCliEnv({ repoRoot, env = process.env, platform = process.platform } = {}) {
  const cfg = readConfig(env);
  if (!env.ARGO_ROOT) env.ARGO_ROOT = cfg.root || join(cliHome(env), 'workspaces');
  // 공개 설정 우선순위: 환경변수 > cli.json > 배포물에 구운 argo-public.json > 레포 .env.local(개발)
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const src = [cfg.supabase, readJson(join(repoRoot, 'bin', 'argo-public.json')), publicSupabaseFromDotenv(join(repoRoot, '.env.local'))]
      .find((x) => x?.url && x?.anonKey);
    if (src) { env.NEXT_PUBLIC_SUPABASE_URL ||= src.url; env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= src.anonKey; }
  }
  if (cfg.chromePath && !env.ARGO_CHROME_PATH) env.ARGO_CHROME_PATH = cfg.chromePath;
  // 화면 없는 리눅스(서버) — 크루 브라우저는 헤드리스로(사람 로그인 넘기기는 불가라고 도구가 정직하게 알린다)
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && env.ARGO_BROWSER_HEADLESS === undefined) env.ARGO_BROWSER_HEADLESS = '1';
  return cfg;
}

export const cliLang = (cfg = {}, env = process.env) => (cfg.lang === 'en' || cfg.lang === 'ko' ? cfg.lang : /^ko/i.test(env.LANG ?? env.LC_ALL ?? '') ? 'ko' : 'en');
