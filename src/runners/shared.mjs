// 러너 공용 조각 — exec 래퍼·서버 시크릿 세척·키 마스킹·자격 파일 시드·격리 홈 env.
// (runners.mjs 관심사 분리 2026-07-28 — 순환 방지 최하층: 형제 모듈을 임포트하지 않는다)

import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, delimiter } from 'node:path';
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

/* ─── 노드 단일화 (유건 지시 2026-08-20: "노드는 러너쪽이 아닌 아르고 노드로 통일") ───
   러너·MCP가 'node'를 이름으로 스폰하는 자리가 셋이다 — ① Claude SDK(sdk.mjs)가 cli.js를
   `executable:'node'`(이름, PATH 해석)로 스폰 ② MCP 서버 command:'node' ③ codex config.toml의
   node 명령. 셋 다 **사용자 PATH의 아무 node**(버전 불명·부재 가능)를 잡았다 — 시스템 노드가
   없으면 SDK 턴이 ENOENT로 죽고, 낡은 노드면 cli.js가 문법 오류로 죽는다.
   지금 이 서버를 돌리는 노드(process.execPath = 데스크톱이면 앱 번들의 사이드카 노드)의 디렉토리를
   PATH **맨 앞**에 꽂아, 'node' 이름 해석이 항상 아르고와 같은 노드로 떨어지게 한다.
   맨 앞인 이유: 시스템 노드가 있어도 버전을 우리가 검증한 번들 노드로 고정(통일이 목적, 감지 보강이
   아니다). npx는 별개 — 번들엔 npm이 없어 npx 계열 MCP는 여전히 시스템 설치가 필요하다(commandExists
   게이트가 부재를 걸러낸다). 상주/dev(시스템 노드 기동)에선 no-op이 아니라 **재정렬**이다(분리
   검수 LOW-1) — 그 노드의 디렉토리(homebrew·nvm bin 등)가 선두로 이동해 크루 셸의 다른 명령
   해석 순서도 바뀔 수 있다. 통일이 목적이므로 수용하되, 알고 유지한다. */
{
  const nodeDir = dirname(process.execPath);
  const cur = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (cur[0] !== nodeDir) process.env.PATH = [nodeDir, ...cur.filter((d) => d !== nodeDir)].join(delimiter);
}

const execP = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);

/** execFile + stdin 즉시 닫기 — CLI가 stdin을 물고 대기하는 행을 차단한다(코덱스 300초 행의 원인).
    windowsHide — Windows에서 사이드카는 CREATE_NO_WINDOW(콘솔 없음)로 떠서, 여기서 스폰하는
    콘솔 자식(codex.exe·node.exe 등)이 **새 콘솔 창을 할당**해 작업표시줄에 노드/터미널 아이콘이
    떴다(사용자 제보 2026-08-21 "앱 실행 직후부터" — 부팅 예열 detectRunners가 CLI 4종을 스폰한다).
    자식도 CREATE_NO_WINDOW로 떠야 그 손자(codex가 스폰하는 MCP node)까지 창 없이 이어진다. */
function exec(cmd, args, opts) {
  const p = execP(cmd, args, { windowsHide: true, ...opts });
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

/** 러너 프로세스가 **크래시로 죽었는가**(순수) — 벤더 거절이나 우리 로직 오류와 구분한다.
    실사용 신고 2026-08-02(Windows): "Claude Code process exited with code 3221225477".
    3221225477 = 0xC0000005 = 접근 위반. 네트워크·자격·크레딧과 무관한 **프로세스 강제 종료**인데,
    분류가 없어 "설정 → AI 연결을 확인하라"는 엉뚱한 안내로 나갔다. 사용자는 정상인 연결 화면을
    아무리 봐도 답을 못 찾는다(402를 따로 갈라낸 것과 같은 이유로 이것도 갈라야 한다).

    이 계열은 **재시도로 상당수 구제된다** — 크래시는 그 순간의 메모리·타이밍 상태에 좌우되고,
    자격이 잘못된 게 아니라서 같은 러너로 다시 걸면 대개 붙는다. 그래서 인증 실패(다른 러너로 갈아탐)와
    달리 **같은 러너 재시도**가 맞다. 벤더를 갈아타지 않으니 실과금 키로 넘어가는 문제도 없다.

    Windows는 NTSTATUS를 부호 없는 10진수로 준다. Unix는 신호로 죽으면 128+signal(SIGSEGV=139,
    SIGBUS=138, SIGABRT=134)이거나 SDK가 signal 이름을 그대로 싣는다. */
const WIN_CRASH_CODES = new Set([
  3221225477, // 0xC0000005 ACCESS_VIOLATION — 가장 흔하다(보안 프로그램 개입·네이티브 모듈 충돌)
  3221225725, // 0xC00000FD STACK_OVERFLOW
  3221226505, // 0xC0000409 STACK_BUFFER_OVERRUN
  3221225781, // 0xC0000135 DLL_NOT_FOUND — 런타임 의존 누락
  3221225786, // 0xC000013A CONTROL_C_EXIT
  3221225794, // 0xC0000142 DLL_INIT_FAILED
]);
export function isProcessCrash(msg) {
  const s = String(msg ?? '');
  const m = /exited with code (\d+)/i.exec(s);
  if (m && WIN_CRASH_CODES.has(Number(m[1]))) return true;
  if (m && [134, 138, 139].includes(Number(m[1]))) return true; // Unix 128+signal
  return /SIGSEGV|SIGBUS|SIGABRT|segmentation fault/i.test(s);
}

/** 크래시 실패의 사용자 안내(순수) — 이 계열에 "연결을 확인하라"고 하면 거짓 안내가 된다.
    실사용 신고 2026-08-02: 크레딧도 남고 연결도 정상인 사용자가 그 안내를 받고
    "러너 연결 정상인데 왜 계속 실패하죠?"라고 되물었다. 이미 우리가 재시도까지 해봤다는 사실과
    연결·잔액 문제가 아니라는 사실을 그대로 말한다. */
export function crashHint(lang = 'ko') {
  return lang === 'en'
    ? 'The AI program crashed on this computer — the OS terminated the process, Argo did not. This is not a connection or credit problem, and Argo already retried it. If it keeps happening, reinstalling the runner CLI usually fixes it; security software blocking the process is the other common cause.'
    : 'AI 프로그램이 이 컴퓨터에서 비정상 종료됐습니다 — Argo가 아니라 운영체제가 프로세스를 강제 종료했습니다. 연결이나 크레딧 문제가 아니며, Argo가 이미 다시 시도해 봤습니다. 계속 반복되면 러너 CLI 재설치로 해결되는 경우가 많고, 보안 프로그램이 프로세스를 막는 것도 흔한 원인입니다.';
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
