// Kiro 러너 — kiro-cli(AWS Kiro CLI) 래핑. 실행 파일 해석·턴별 격리 에이전트 설정·최종 답변 추출.
// (codex/gemini/antigravity와 같은 CLI 래핑 계열 — 세 번째 배관을 만들지 않는다)
//
// 왜 CLI 래핑인가: kiro-cli의 자격은 AWS IAM Identity Center / Builder ID 로그인이고, 토큰은
// 로컬 데이터 저장소(macOS: ~/Library/Application Support/kiro-cli)에 있다. 붙여넣을 수 있는
// API 키 표면이 없으므로 codex·antigravity처럼 **호스트 로그인을 빌리는** 경로가 유일하다.
//
// 실측 기반(kiro-cli 2.17.0, macOS, 2026-08-12):
//  | 항목        | 실측                                                          |
//  |------------|---------------------------------------------------------------|
//  | 원샷        | `chat --no-interactive [--model] [--effort]` exit 0            |
//  | 데몬 스폰    | TTY 없음·stdin 닫힘·최소 env에서도 정상(상주 서비스 경로 확인)      |
//  | 모델 목록    | `chat --list-models --format json` → 19종                      |
//  | 자격 판정    | `whoami` → 로그인 "Logged in with IAM Identity Center"(exit 0) /
//  |            | 미로그인 "Not logged in"(exit 1)                               |
//  | 미로그인 턴  | 브라우저를 열려다 `error: OAuth error: Auth portal timed out`(exit 1) |
//  | 설정 격리    | `<cwd>/.kiro/agents/<name>.json` + `--agent <name>`로 전역 설정 차단 |

import { mkdir, writeFile, readdir, rm, rmdir, realpath } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, exists } from './shared.mjs';

/** 홈은 env로만(HOME/USERPROFILE) — node:os homedir()를 **동적 join**(map/flatMap 인자)에 쓰면 Next
    추적기가 빌드타임 부분평가로 홈 루트를 통글롭해 Windows 릴리스 빌드가 죽는다. 아래 하드 홈 목록이
    바로 그 동적 join이므로 permission-gate.mjs와 같은 방식을 쓴다(그 파일 헤더 주석의 불변식). */
const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? '';

/** 실행 중인 Argo 코드 루트 — src/runners/의 조부모. workroots.mjs·permission-gate.mjs의 APP_ROOT와
    같은 값(그 둘은 src/ 기준이라 '..' 한 번, 여기는 src/runners/라 두 번)이다. 인자로 주입할 수 있게
    기본값으로만 둔다 — 테스트가 임시 트리로 갈아끼울 수 있어야 경계 계산을 단위로 잠근다. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 공식 인스톨러 고정 경로 — GUI 최소 PATH(데스크톱 사이드카)에서 PATH 감지가 실패할 때의 폴백.
    상수 join이라 Next 추적기 문제(위 homeDir 주석)와 무관하지만, 홈 출처를 이 파일 안에서
    하나로 유지하려고 같은 헬퍼를 쓴다. */
const KIRO_LOCAL_BIN = () => join(homeDir(), '.local', 'bin', 'kiro-cli');

/** kiro-cli 실행 파일 — PATH 설치본 우선, 공식 인스톨러 고정 경로 폴백.
    codex/gemini와 달리 **자동 조달은 하지 않는다**(antigravity와 같은 판단): 공식 인스톨러가
    셸 프로파일을 수정하고 데스크톱 앱까지 함께 설치하는 부작용이 있어 명시 설치 안내가 정직하다. */
export async function kiroCmd() {
  const onPath = await exec('kiro-cli', ['--version']).then(() => true, () => false);
  if (onPath) return { file: 'kiro-cli', args: [] };
  const local = KIRO_LOCAL_BIN();
  if (await exists(local)) return { file: local, args: [] };
  // Windows 공식 설치 경로 후보 — PATH 미등록 GUI 기동 대비. 실기기 미검증(설계 문서에 명시).
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winBin = join(process.env.LOCALAPPDATA, 'kiro-cli', 'bin', 'kiro-cli.exe');
    if (await exists(winBin)) return { file: winBin, args: [] };
  }
  throw new Error('Kiro CLI(kiro-cli)가 설치되어 있지 않습니다. https://kiro.dev 에서 설치한 뒤 터미널에서 kiro-cli login 으로 로그인해 주세요. '
    + 'Kiro CLI (kiro-cli) is not installed — install it and run kiro-cli login, then retry.');
}

/* ─── 최종 답변 추출 ───
   kiro-cli에는 codex의 `--output-last-message` 같은 최종 메시지 분리 플래그가 없다. 대신 렌더러가
   **어시스턴트 메시지의 첫 줄에만 `> ` 접두사**를 붙인다(도구 추적 줄은 무접두사). 그래서 마지막
   `> ` 블록을 취하면 codex `--output-last-message`와 같은 의미가 된다 — 실측 6종(도구 사용 전후·
   여러 줄·마크다운 인용 포함)에서 정확히 일치.
   마크다운 인용(`> foo`)은 렌더러가 `│ `로 그려 접두사와 충돌하지 않는다(실측).
   ⚠ 알려진 한계(실증): 최종 답변 **2행 이후**의 코드블록에 `> `로 시작하는 줄이 있으면 그 줄을
     새 메시지 시작으로 오인해 앞부분이 절단된다(렌더 결과에는 코드펜스가 남지 않아 "코드블록 안"을
     판별할 수단이 없다). 근본 해법은 `kiro-cli acp`(JSON-RPC 구조화 스트림)로 옮기는 것 —
     docs/kiro-runner-design.md의 후속 항목. */
const ANSI_RE = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\[K/g;
/* 도구 추적 줄의 **머리** 패턴 — 이 줄에서 시작하는 텍스트는 답변이 아니라 CLI의 진행 표시다.
   실측된 형태(2026-08-12, 분리 검수 4·5라운드): 단건(`Reading file: …`), 배치(`Batch fs_read`,
   `↱ Operation 3: Reading file: …`), 쓰기(`I'll create the following file:`, `Creating:`, 번호 diff),
   거부(`Command fs_read is rejected because …` + 들여쓴 규칙 목록), 완료(` - Completed in …`). */
const TRACE_HEAD_RE = /^(?:\u21b1\s*)?(?:Operation \d+:\s*)?(?:Reading (?:file|directory|image)|Batch \w+|Creating:|Updating:|I['\u2019]ll (?:create|update) the following file:|Command \w+ is rejected|\s*[+-]\s{2,}\d+:|\s{2,}- \/\S*$| - Completed in)/;

/* 어시스턴트 메시지 시작 표지는 `> `인데, **줄머리에만 있는 게 아니다**(분리 검수 4·5라운드 실증):
   거부·배치 경로에서 kiro-cli가 다음 메시지를 추적 텍스트 **끝에 개행 없이** 붙인다.
     `Reading file: … (using tool: read)> 차단되었습니다…`
     `Reading directory: … (using tool: read, max depth: 0, …)> …`   ← 인자형
     `↱ Operation 3: Reading file: /x, all lines> …`                  ← (using tool:) 자체가 없다
   접합부 문자열을 열거하는 방식은 4라운드에 한 번 실패했다(형태가 더 있었다). 그래서 열거를 늘리는
   대신 **추적 줄을 먼저 분리**한다: 위 머리 패턴으로 식별된 줄에서만 첫 `> ` 앞을 잘라 개행을 넣는다.
   식별된 줄 안에서만 자르므로 산문의 `> `(비교 연산·인용)를 표지로 오인하지 않는다. */
const isTraceLine = (line) => TRACE_HEAD_RE.test(line) || line.includes('(using tool:');

function splitTraceGlue(plain) {
  return plain.split('\n').map((line) => {
    if (!isTraceLine(line)) return line;
    const i = line.indexOf('> ');
    return i === -1 ? line : `${line.slice(0, i)}\n${line.slice(i)}`;
  }).join('\n');
}

/** stdout → 최종 답변(순수). ANSI 제거 후 마지막 어시스턴트 블록만 남긴다.
    접두사가 아예 없으면(예상 외 형식·미래 렌더러 변경) **전문을 반환**한다 — 조용한 빈 답변보다
    잡음 섞인 답변이 낫다(gemini 스크럽이 통삭제로 정상 응답을 지웠던 계열의 반대 방향).
    (export: 회귀 테스트용 — 순수 함수) */
export function kiroScrub(stdout) {
  const lines = splitTraceGlue(String(stdout ?? '').replace(ANSI_RE, '')).split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) if (lines[i].startsWith('> ')) last = i;
  // 표지 부재(예상 외 형식·미래 렌더러 변경)면 전문을 쓴다 — 통삭제로 정상 응답을 지우는 방향
  // (gemini 스크럽 선례)은 피한다. 어느 쪽이든 아래에서 추적 줄을 걷어낸다.
  const picked = last < 0 ? lines : [lines[last].slice(2), ...lines.slice(last + 1)];
  // 추적 줄 제거를 **항상** 적용한다(분리 검수 5라운드 권고): 거부·배치 경로에서는 추적이 메시지
  // **뒤에도** 붙어(`Command fs_read is rejected …` + 규칙 목록) 표지 판정만으로는 답변에 남는다.
  // 그 잔재는 금지 파일의 전체 경로를 담고, 대화 정본(chats/)에 저장돼 다음 턴 맥락으로 재주입된다.
  return picked.filter((l) => !isTraceLine(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ─── 추론 강도 ───
   `--effort low|medium|high|xhigh|max`(도움말 실측). Argo effort 값과 이름이 같아 통과시키면 되고,
   모르는 값은 **넘기지 않는다** — CLI가 인자 오류로 죽으면 그 턴이 통째로 실패한다(codex와 같은 방어). */
export const KIRO_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** effort → 인자(순수). 빈 값·미지값은 빈 배열(러너 기본값). (export: 회귀 테스트용) */
export const kiroEffortArgs = (effort) => (KIRO_EFFORTS.includes(String(effort ?? '')) ? ['--effort', String(effort)] : []);

/* ─── 능력(caps) → 도구 목록 ───
   **경계가 증명된 도구만 준다**(fail-closed). deniedPaths는 `read`·`write`에만 서고, 다른 도구는
   같은 파일을 그냥 연다 — 실측(2026-08-12, 분리 검수 2라운드 CRITICAL):
     · `grep`  금고 `connections.json`·형제 회사·WS_ROOT 직속 도트의 **매치 줄 내용을 그대로 반환**.
               같은 턴·같은 설정에서 `read`로 같은 파일을 열면 정상 DENY된다(대조군) — 즉 경계가
               read/write 전용이다. grep·glob은 `toolsSettings` 키가 공식 스키마에 없어 막을 수도 없다.
     · `glob`  `~/.codex` 7,766개·`~/.claude` 527개 파일 열거 성공(경로 유출).
     · `shell` `cat <금고>`·`cat ../<타사>/notes.md`·`echo > usage.jsonl`(원장 개조) 전부 성공.
               `deniedCommands`(정규식)는 강제되지만(실측), 명령 문자열 정규식은 `$(…)`·`sh -c`·
               인터프리터 경유로 우회가 자유롭고 permission-gate처럼 **인자 경로를 판정하는 백스톱이
               없다**. `denyByDefault`는 문서에 있으나 무시된다(실측: 화이트리스트 밖 명령이 실행됨).
   그래서 이 러너의 도구는 read·write(+브라우저 능력 시 web_fetch)로 한정한다. 셸 부재는 이 레포에
   선례가 있다 — gemini CLI 러너도 비대화(`--approval-mode auto_edit`)에서 셸이 실행되지 않고
   (`externalExec` gemini 분기 주석) 그 상태로 운영된다.
   caps.shell이 켜져 있어도 이 러너는 셸을 주지 않는다 — UI가 정직 표기한다. */
const BASE_TOOLS = ['read', 'write'];

/** caps → { tools, allowedTools }(순수). allowedTools는 tools와 같게 준다 —
    비대화(`--no-interactive`)에서는 **포괄 신뢰가 없으면 도구 호출이 전부 거부**된다(실측:
    toolsSettings.allowedPaths만 두면 반경 안쪽 쓰기까지 거부). 경로 강제는 deniedPaths가 한다.
    fail-closed: caps 미전달(oneshot 등)이면 브라우저를 끈다.
    (export: 회귀 테스트용 — 순수 함수) */
export function kiroTools(caps) {
  const tools = [...BASE_TOOLS];
  // web_fetch는 사장이 브라우저 능력을 켠 경우만. 읽을 수 있는 데이터가 이미 deniedPaths로
  // 제한되므로 반출 범위도 그만큼 제한된다(URL 차단 규칙 web_fetch.blocked는 미검증 — 쓰지 않는다).
  if (caps?.browser) tools.push('web_fetch');
  return { tools, allowedTools: [...tools] };
}

/* ─── 불변 보안 경계 → deniedPaths ───
   kiro-cli의 비대화 권한 실측(2026-08-12) — 네 수단 중 강제력이 있는 것은 하나뿐이다:
    · `tools` 목록 제외 ............ 하드(도구 자체가 없다)
    · `allowedTools` ............... 포괄 자동 승인. 비대화에서 **필수**(없으면 전부 거부)
    · `toolsSettings.*.allowedPaths` 비대화에서 자동 승인을 주지 못한다 → 반경 안쪽까지 거부
    · `toolsSettings.*.deniedPaths`  **하드 차단. allowedTools보다 우선**(문서 신뢰 우선순위 1위, 실측 일치)
   즉 openRoots(홈+지정 폴더) 같은 **화이트리스트 의미를 직접 표현할 수 없다**(denyByDefault는
   shell 전용이고 write에서 무시됨, deny 글롭의 부정 패턴 `!`도 미지원 — 셋 다 실측 배제).
   그래서 이 러너의 집행은 **불변 경계 deny**로 한다: 지정으로도 열리지 않는 금지 구역
   (workroots.mjs "보안 경계(불변)")을 deny 목록으로 옮기고, caps.fs의 반경 차이는 UI가 정직
   표기한다(러너별 집행 강도 차이는 이 레포가 이미 채택한 방식 — workroots.mjs 러너별 집행 절).

   경계는 cwd에서 도출한다(permission-gate makeIsForbidden과 같은 계산 — 새 임포트 없이 정합):
     cwd = 회사 워크스페이스 루트,  dirname(cwd) = WS_ROOT(전 회사 데이터) */
const GLOB_ALL = '/**';

/* 하드 차단 목록은 permission-gate.mjs와 **같은 값**이다 — 같은 파일을 SDK 러너는 deny하고 kiro는
   allow하면 러너별로 판정이 갈린다(그 파일 헤더의 "도구별 판정이 갈린다" 원칙과 같은 클래스).
   한쪽을 고치면 다른 쪽도 고쳐야 한다 — test/kiro-runner.test.mjs가 두 목록의 정합을 잠근다. */
const HARD_HOME_PATHS = ['.argo', '.codex', '.claude', '.gemini', '.claude.json', '.mcp.json'];
/** 회사 금고 — 읽기·쓰기 모두 금지(자격·자가 승격의 본체). permission-gate WS_CONTROL_FILES와 동일. */
const WS_CONTROL_FILES = ['capabilities.json', 'mcp.json', 'connections.json', 'company.json', 'routines.json', 'approvals.json', 'gw-cursor-slack.json'];
/** 크루 카드·대화 정본 — 결재 없는 자기 범위 확대·가짜 사장 발화 주입의 경로. 동일. */
const WS_CONTROL_DIRS = ['agents', 'chats'];
/** 원장 — **쓰기만** 막고 읽기는 연다. permission-gate와 같은 근거(사장이 "이번 달 얼마 썼어?"라고
    물었을 때 답할 수단을 없애는 것은 자가 승격 차단과 무관한 기능 후퇴다). */
const WS_LEDGER_FILES = ['usage.jsonl', 'events.jsonl'];

const canon = (p) => realpath(p).then((r) => r, () => null);

/** 불변 경계 deny 글롭 — 반환 { read, write }(원장은 write만).
    ① APP_ROOT — 실행 중인 Argo 코드. writable_roots="/"가 앱 본체를 열었던 2026-07-22 크리티컬의 계열.
    ② 홈 직속 자격 — ~/.argo·~/.codex·~/.claude·~/.gemini·~/.claude.json·~/.mcp.json
       (permission-gate HARD_HOME_PATHS와 같은 목록. "전권은 파일을 맡긴다는 뜻이지 자격을 넘긴다는
       뜻이 아니다" — 그 파일 #187 원칙).
    ③ WS_ROOT의 **형제 회사** — 교차 테넌트 차단. WS_ROOT 통째로 deny하면 자기 회사(cwd)까지 막히므로
       형제만 열거한다(회사 수만큼 — readdir 1회). 열거 후 생성된 회사는 이 턴에 안 잡힌다(TOCTOU):
       회사 생성은 사장의 UI 행위라 턴 중 발생이 비현실적이고, 다음 턴엔 잡힌다 — 설계 문서에 명시.
    ④ 직속 도트 항목 — `<cwd>/.*`(.workroots.json 등) / `WS_ROOT/.*`(계정 시크릿·기기 마커).
       이 러너의 턴별 에이전트 설정(`<cwd>/.kiro`)도 여기 포함된다 — 크루가 자기 권한 설정을 고쳐
       다음 턴을 승격시키는 경로를 막는다.
    ⑤ 회사 금고 — 도트가 아닌 제어 파일·디렉터리(위 두 상수). ④의 도트 글롭으로는 안 잡힌다.

    ⚠ **raw + canonical 두 형태를 모두 싣는다**(분리 검수 CRITICAL 2026-08-12 실증): kiro-cli는
      canonical 경로로 deny를 판정하는데 우리가 raw만 실으면, 심링크 경유 ARGO_ROOT(맥의 /tmp·/var,
      외장 볼륨·동기화 폴더 경유가 흔하다)에서 **경계 전체가 조용히 열린다** — 재현 시 형제 회사
      파일과 WS_ROOT 직속 도트를 둘 다 읽었다. permission-gate가 하드 구역에 raw·canonical 두 형태를
      담는 것과 같은 이유·같은 방식(그 파일 "정션·심링크 홈에서 한쪽 leg가 무동작하는 계열" 주석).
    (export: 회귀 테스트용) */
export async function kiroDeniedPaths(cwd, appRoot = APP_ROOT) {
  const wsRoot = dirname(cwd);
  const mine = basename(cwd);
  const home = homeDir();
  // fail-closed(분리 검수 2라운드 MEDIUM): 홈을 모르면 홈 자격 경계(~/.argo·~/.codex·~/.claude·
  // ~/.gemini 등)를 만들 수 없다. 조용히 빠지면 그 경계가 **경고도 없이 사라진다**(실측:
  // env -u HOME -u USERPROFILE 에서 홈 항목 0건). deniedPaths가 이 러너 집행의 전부이므로,
  // 경계를 못 만들면 턴을 돌리지 않는다 — launchd·Tauri 최소 env가 정확히 이 조건이다.
  if (!home) {
    throw new Error('Kiro 러너를 실행할 수 없습니다: HOME(또는 USERPROFILE)이 없어 보안 경계를 만들 수 없습니다. '
      + 'Cannot run the Kiro runner: HOME/USERPROFILE is unset, so the security boundary cannot be built.');
  }
  // 형제는 **이름만** 뽑는다 — 경로는 아래에서 wsRoot의 두 형태에 각각 붙인다.
  const siblingNames = await readdir(wsRoot, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory() && e.name !== mine).map((e) => e.name))
    .catch(() => []); // 읽을 수 없으면 형제 열거를 포기한다 — 나머지 방어는 그대로 선다
  const forms = async (p) => { const c = await canon(p); return c && c !== p ? [p, c] : [p]; };
  const [appForms, homeForms, wsForms, cwdForms] = await Promise.all([
    forms(appRoot), forms(home), forms(wsRoot), forms(cwd),
  ]);

  const read = new Set();
  // 파일 자체 + 하위 전부 — HARD_HOME_PATHS·금고 목록에 파일과 디렉터리가 섞여 있다.
  const deny = (set, p) => { set.add(p); set.add(p + GLOB_ALL); };
  for (const a of appForms) deny(read, a);
  for (const h of homeForms) for (const d of HARD_HOME_PATHS) deny(read, join(h, d));
  for (const w of wsForms) {
    for (const s of siblingNames) deny(read, join(w, s));
    deny(read, join(w, '.*'));
  }
  for (const c of cwdForms) {
    deny(read, join(c, '.*'));
    for (const f of WS_CONTROL_FILES) deny(read, join(c, f));
    for (const d of WS_CONTROL_DIRS) deny(read, join(c, d));
  }
  /* ⚠ 조상 사슬(WS_ROOT → … → 루트) deny로 "위에서 훑어 내려오기"를 봉인하려 했으나 **불가능하다**
     (실측 2026-08-12): kiro-cli의 deny 판정은 정확 경로가 아니라 **디렉터리 포함**이다 — `/var/folders/…`
     한 줄을 넣으면 그 하위 파일 읽기가 전부 막힌다(`/`를 넣으면 전부 차단). 즉 WS_ROOT를 막으면
     자기 회사 폴더(크루 책상)도 같이 죽는다. 그래서 `read` Directory 모드 재귀 열거로 금지 구역의
     **경로가 열거되는 것**(내용은 보호됨)은 설정으로 막을 수 없다 — docs/kiro-runner-design.md
     한계 절에 그 심각도로 명시했다. 근본 해법은 `kiro-cli acp`(도구 호출을 우리가 승인·거절). */
  const write = new Set(read);
  for (const c of cwdForms) for (const f of WS_LEDGER_FILES) deny(write, join(c, f));
  return { read: [...read], write: [...write] };
}

/** 턴별 격리 에이전트 설정을 쓰고 에이전트 이름을 반환한다.
    위치는 `<cwd>/.kiro/agents/<name>.json` — kiro-cli는 워크스페이스 에이전트를 **cwd 기준으로만**
    찾는다(상위 탐색 없음, 실측). 전역 `~/.kiro/agents`를 쓰지 않는 이유: 사용자 자신의 kiro-cli
    에이전트 목록을 오염시키고 기기 전역이라 회사별 격리가 안 된다.
    이름에 턴 고유값을 넣어 **동시 턴 충돌·경합 삭제**를 막는다(같은 회사에서 두 크루가 동시에 답할 수 있다).
    호출부는 반드시 finally에서 removeKiroTurnAgent로 지운다 — 회사 금고에 잔재를 남기지 않는다. */
export async function writeKiroTurnAgent(cwd, { caps = null, appRoot = APP_ROOT, name } = {}) {
  const { tools, allowedTools } = kiroTools(caps);
  const denied = await kiroDeniedPaths(cwd, appRoot);
  const cfg = {
    name,
    description: 'Argo turn-scoped runner agent (generated per turn — do not edit)',
    tools,
    allowedTools,
    toolsSettings: {
      read: { deniedPaths: denied.read },
      write: { deniedPaths: denied.write }, // 원장(usage/events)은 쓰기만 추가로 막힌다
      // read·write 둘뿐인 이유는 위 BASE_TOOLS 주석에 있다: deniedPaths가 이 두 도구에만 서고,
      // grep·glob·shell은 같은 파일을 그냥 연다(실측). 경계가 없는 도구를 주지 않는 것이
      // 이 러너의 fail-closed다 — 설정으로 막을 수 없으니 도구 자체를 안 준다.
    },
    // 전역 설정 격리 — 사용자의 MCP 서버가 매 턴 로드되며 경고를 뱉고(실측) 크루에게 의도 밖
    // 도구를 준다. 빈 목록 + 레거시 json 미상속으로 닫는다.
    mcpServers: {},
    useLegacyMcpJson: false,
  };
  const dir = join(cwd, '.kiro', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return name;
}

/** 턴별 에이전트 설정 제거 — 실패는 무시(잔재 1개가 다음 턴을 막지 않는다).
    빈 디렉터리까지 걷어낸다: rmdir은 비어 있지 않으면 실패하므로 동시 턴의 설정이나 사용자가 만든
    `.kiro` 내용물을 지울 위험이 없다(분리 검수 LOW). */
export async function removeKiroTurnAgent(cwd, name) {
  await rm(join(cwd, '.kiro', 'agents', `${name}.json`), { force: true }).catch(() => {});
  await rmdir(join(cwd, '.kiro', 'agents')).catch(() => {});
  await rmdir(join(cwd, '.kiro')).catch(() => {});
}

/* ─── 파일 반경(openRoots)을 이 러너가 쓰지 않는 이유 — 정직 표기 ───
   codex(writable_roots)·gemini(includeDirectories)·antigravity(--add-dir)는 openRoots를 인자로
   받아 **반경을 넓힌다**. kiro-cli는 기본이 무제한이라(실측: cwd 밖 읽기·쓰기가 그냥 된다) 넓힐
   것이 없고, 좁히는 유일한 수단인 deniedPaths는 화이트리스트를 표현하지 못한다(위 실측 표).
   `toolsSettings.read.allowedPaths`에 openRoots를 넣어 두는 선택지는 **일부러 버렸다** — 비대화
   모드에서 효력이 0인데(실측) 설정 파일에는 반경이 적혀 있어, 다음 사람이 "반경이 걸려 있다"고
   오독할 죽은 설정이 된다. 러너별 집행 강도 차이는 UI가 정직 표기한다(workroots.mjs 러너별 집행 절).
   후속: `kiro-cli acp`로 옮기면 도구 호출을 우리가 승인·거절하므로 SDK 러너와 같은 강도가 된다. */

