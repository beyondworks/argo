// 러너 공용 조각 — exec 래퍼·서버 시크릿 세척·키 마스킹·자격 파일 시드·격리 홈 env.
// (runners.mjs 관심사 분리 2026-07-28 — 순환 방지 최하층: 형제 모듈을 임포트하지 않는다)

import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

/* ─── GUI 기동 PATH 보강 ───
   데스크톱(tauri sidecar)은 GUI 최소 PATH(/usr/bin:/bin:…)로 뜬다 — homebrew/npm 전역으로 설치한
   codex/gemini CLI를 감지(detectRunners)도 실행(externalExec)도 못 한다(실사용 신고 2026-07-19:
   "codex 연결됨인데 안 됨" = hostInstalled 오탐 + spawn ENOENT의 뿌리). 터미널 기동(웹 dev/상주)은
   이미 PATH에 있어 no-op. ① 표준 경로 정적 병합(동기) ② macOS는 로그인 셸 PATH 1회 캡처(비동기,
   VS Code 방식 — exec.mjs ensureCliPath). Windows는 GUI PATH = 사용자 PATH라 불필요(구분자 ';'라 병합도 건너뛴다).
   최하층(shared)에 두는 이유(분리 검수 LOW-1 2026-07-28): PATH에 의존하는 codexCmd·geminiCmd가
   각자 모듈로 갈라졌는데 정적 병합이 exec.mjs에만 있으면, 훗날 누가 하위 모듈을 직접 임포트할 때
   GUI 최소 PATH에서 설치본 감지가 조용히 실패한다(v0.1.12 실사고 계열). */
export const mergePath = (dirs) => {
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean);
  const add = dirs.filter((d) => d.startsWith('/') && !cur.includes(d));
  if (add.length) process.env.PATH = [...cur, ...add].join(':');
};
if (process.platform !== 'win32') {
  mergePath(['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin')]);
}

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
/** 제공사 인증 변수 소유권 — 어느 러너가 어떤 인증 env를 정당하게 쓰는가.
    실행 러너 외 제공사 키가 자식(외부 CLI·SDK가 띄우는 Bash/MCP)에 상속되면, 러너 하나가 프롬프트
    인젝션에 뚫릴 때 printenv 한 번으로 '다른' 제공사 자격까지 한꺼번에 유출된다(감사 2026-07-20 —
    크로스 러너 폭발 반경). ANTHROPIC_AUTH_TOKEN은 Anthropic 호환 프로토콜 공용(claude·glm·kimi). */
const PROVIDER_AUTH_OWNERS = {
  ANTHROPIC_API_KEY: ['claude'],
  CLAUDE_CODE_OAUTH_TOKEN: ['claude'],
  ANTHROPIC_AUTH_TOKEN: ['claude', 'glm', 'kimi'], // openrouter는 미등재 — cred.env가 항상 명시 세팅하므로 불필요하고, 등재하면 cred 없는 경로에서 호스트 Anthropic 토큰이 살아남는 이론적 구멍(검수 LOW, 호스트 스캐빈징 금지)
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

/** 격리 홈을 자식 프로세스에 알리는 env — **플랫폼별로 변수가 다르다**(순수).
    Node의 os.homedir()는 Windows에서 USERPROFILE을 보고 HOME은 무시한다. HOME만 주면 Windows에서
    gemini CLI가 진짜 사용자 홈(C:\Users\...\.gemini)을 읽어 인증 설정을 못 찾고 죽는다 —
    실사용 신고 2026-07-26: "러너 실행 실패 (exit 41): ...\.gemini\settings.json or specify one of
    the following environment variables before running: GEMINI_API_KEY". 리눅스·맥은 HOME 그대로.
    (export: 회귀 테스트용 — 순수 함수) */
export function homeEnv(home, platform = process.platform) {
  if (platform !== 'win32') return { HOME: home };
  // HOME도 함께 준다 — 일부 도구는 여전히 HOME을 본다(둘 다 같은 곳을 가리키게 해 분기 없음)
  const m = /^([A-Za-z]:)(.*)$/.exec(home);
  return { HOME: home, USERPROFILE: home, ...(m ? { HOMEDRIVE: m[1], HOMEPATH: m[2] } : {}) };
}

export { execP, exists, exec, seedAuthFile }; // 러너 모듈 내부 공용(facade 미노출)
