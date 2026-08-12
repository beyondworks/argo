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

import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, exists } from './shared.mjs';

/** 실행 중인 Argo 코드 루트 — src/runners/의 조부모. workroots.mjs·permission-gate.mjs의 APP_ROOT와
    같은 값(그 둘은 src/ 기준이라 '..' 한 번, 여기는 src/runners/라 두 번)이다. 인자로 주입할 수 있게
    기본값으로만 둔다 — 테스트가 임시 트리로 갈아끼울 수 있어야 경계 계산을 단위로 잠근다. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 공식 인스톨러 고정 경로 — GUI 최소 PATH(데스크톱 사이드카)에서 PATH 감지가 실패할 때의 폴백.
    상수 join만 쓴다: homedir()를 **동적 join**(map/flatMap 인자)에 넣으면 Next 추적기가 빌드타임
    부분평가로 홈 루트를 통글롭해 Windows 릴리스 빌드가 죽는다(permission-gate.mjs 주석의 불변식). */
const KIRO_LOCAL_BIN = () => join(homedir(), '.local', 'bin', 'kiro-cli');

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
const ASSISTANT_PREFIX = '> ';

/** stdout → 최종 답변(순수). ANSI 제거 후 마지막 어시스턴트 블록만 남긴다.
    접두사가 아예 없으면(예상 외 형식·미래 렌더러 변경) **전문을 반환**한다 — 조용한 빈 답변보다
    잡음 섞인 답변이 낫다(gemini 스크럽이 통삭제로 정상 응답을 지웠던 계열의 반대 방향).
    (export: 회귀 테스트용 — 순수 함수) */
export function kiroScrub(stdout) {
  const plain = String(stdout ?? '').replace(ANSI_RE, '');
  const lines = plain.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) if (lines[i].startsWith(ASSISTANT_PREFIX)) last = i;
  if (last < 0) return plain.trim();
  const block = lines.slice(last);
  block[0] = block[0].slice(ASSISTANT_PREFIX.length);
  return block.join('\n').trim();
}

/* ─── 추론 강도 ───
   `--effort low|medium|high|xhigh|max`(도움말 실측). Argo effort 값과 이름이 같아 통과시키면 되고,
   모르는 값은 **넘기지 않는다** — CLI가 인자 오류로 죽으면 그 턴이 통째로 실패한다(codex와 같은 방어). */
export const KIRO_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** effort → 인자(순수). 빈 값·미지값은 빈 배열(러너 기본값). (export: 회귀 테스트용) */
export const kiroEffortArgs = (effort) => (KIRO_EFFORTS.includes(String(effort ?? '')) ? ['--effort', String(effort)] : []);

/* ─── 능력(caps) → 도구 목록 ───
   kiro-cli 도구명(v2 엔진): read·write·shell·grep·glob·code·knowledge·thinking·todo·use_aws·web_fetch 등.
   Argo 능력 모델은 { fs, shell, browser } 셋이고, 크루는 **회사 폴더(cwd)에서 일하는 것이 기본**이라
   read/write는 능력과 무관하게 준다(codex가 상시 `--sandbox workspace-write`로 cwd를 여는 것과 같은
   자리 — 능력 OFF의 의미는 "cwd 밖으로 나가지 말라"이지 "아무것도 못 읽어라"가 아니다).
   그래서 caps가 갈라내는 것은 셸(shell)과 브라우저(web_fetch)다. */
const BASE_TOOLS = ['read', 'write', 'grep', 'glob'];

/** caps → { tools, allowedTools }(순수). allowedTools는 tools와 같게 준다 —
    비대화(`--no-interactive`)에서는 **포괄 신뢰가 없으면 도구 호출이 전부 거부**된다(실측:
    toolsSettings.allowedPaths만 두면 반경 안쪽 쓰기까지 거부). 경로 강제는 deniedPaths가 한다.
    fail-closed: caps 미전달(oneshot 등)이면 셸·브라우저를 끈다(antigravity `--sandbox`와 같은 방향).
    (export: 회귀 테스트용 — 순수 함수) */
export function kiroTools(caps) {
  const tools = [...BASE_TOOLS];
  if (caps?.shell) tools.push('shell');
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

/** 불변 경계 deny 글롭(순수 계산 + WS_ROOT 1회 readdir).
    ① APP_ROOT — 실행 중인 Argo 코드. writable_roots="/"가 앱 본체를 열었던 2026-07-22 크리티컬의 계열.
    ② ~/.argo — 기기 상태·러너 자격 보관소.
    ③ WS_ROOT의 **형제 회사** — 교차 테넌트 차단. WS_ROOT 통째로 deny하면 자기 회사(cwd)까지 막히므로
       형제만 열거한다(회사 수만큼 — readdir 1회). 열거 후 생성된 회사는 이 턴에 안 잡힌다(TOCTOU):
       회사 생성은 사장의 UI 행위라 턴 중 발생이 비현실적이고, 다음 턴엔 잡힌다 — 설계 문서에 명시.
    ④ 직속 도트 항목 — `<cwd>/.*`(회사 금고: .workroots.json 등 자가 승격 경로) / `WS_ROOT/.*`(계정 시크릿).
       ⑤ 이 러너가 쓰는 턴별 에이전트 설정(`<cwd>/.kiro`)도 ④에 포함된다 — 크루가 자기 권한 설정을
       고쳐 다음 턴을 승격시키는 경로를 막는다.
    (export: 회귀 테스트용) */
export async function kiroDeniedPaths(cwd, appRoot = APP_ROOT) {
  const wsRoot = dirname(cwd);
  const mine = basename(cwd);
  const siblings = await readdir(wsRoot, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory() && e.name !== mine).map((e) => join(wsRoot, e.name) + GLOB_ALL))
    .catch(() => []); // 읽을 수 없으면 형제 열거를 포기한다 — 아래 도트·앱루트 방어는 그대로 선다
  return [
    appRoot + GLOB_ALL,
    join(homedir(), '.argo') + GLOB_ALL,
    ...siblings,
    join(cwd, '.*'), join(cwd, '.*') + GLOB_ALL, // 직속 도트 항목(파일·디렉터리 하위 both) — .kiro 포함
    join(wsRoot, '.*'), join(wsRoot, '.*') + GLOB_ALL,
  ];
}

/** 턴별 격리 에이전트 설정을 쓰고 에이전트 이름을 반환한다.
    위치는 `<cwd>/.kiro/agents/<name>.json` — kiro-cli는 워크스페이스 에이전트를 **cwd 기준으로만**
    찾는다(상위 탐색 없음, 실측). 전역 `~/.kiro/agents`를 쓰지 않는 이유: 사용자 자신의 kiro-cli
    에이전트 목록을 오염시키고 기기 전역이라 회사별 격리가 안 된다.
    이름에 턴 고유값을 넣어 **동시 턴 충돌·경합 삭제**를 막는다(같은 회사에서 두 크루가 동시에 답할 수 있다).
    호출부는 반드시 finally에서 removeKiroTurnAgent로 지운다 — 회사 금고에 잔재를 남기지 않는다. */
export async function writeKiroTurnAgent(cwd, { caps = null, appRoot = APP_ROOT, name } = {}) {
  const { tools, allowedTools } = kiroTools(caps);
  const deniedPaths = await kiroDeniedPaths(cwd, appRoot);
  const cfg = {
    name,
    description: 'Argo turn-scoped runner agent (generated per turn — do not edit)',
    tools,
    allowedTools,
    toolsSettings: {
      read: { deniedPaths },
      write: { deniedPaths },
      // 셸은 능력이 켜졌을 때만 목록에 있다. 그때도 금지 구역 명령을 막을 수단은 없어(경로 인자
      // 판정이 없다) 읽기·쓰기와 집행 강도가 다르다 — UI 정직 표기 대상(설계 문서 한계 절).
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

/** 턴별 에이전트 설정 제거 — 실패는 무시(잔재 1개가 다음 턴을 막지 않는다). */
export async function removeKiroTurnAgent(cwd, name) {
  await rm(join(cwd, '.kiro', 'agents', `${name}.json`), { force: true }).catch(() => {});
}

/* ─── 파일 반경(openRoots)을 이 러너가 쓰지 않는 이유 — 정직 표기 ───
   codex(writable_roots)·gemini(includeDirectories)·antigravity(--add-dir)는 openRoots를 인자로
   받아 **반경을 넓힌다**. kiro-cli는 기본이 무제한이라(실측: cwd 밖 읽기·쓰기가 그냥 된다) 넓힐
   것이 없고, 좁히는 유일한 수단인 deniedPaths는 화이트리스트를 표현하지 못한다(위 실측 표).
   `toolsSettings.read.allowedPaths`에 openRoots를 넣어 두는 선택지는 **일부러 버렸다** — 비대화
   모드에서 효력이 0인데(실측) 설정 파일에는 반경이 적혀 있어, 다음 사람이 "반경이 걸려 있다"고
   오독할 죽은 설정이 된다. 러너별 집행 강도 차이는 UI가 정직 표기한다(workroots.mjs 러너별 집행 절).
   후속: `kiro-cli acp`로 옮기면 도구 호출을 우리가 승인·거절하므로 SDK 러너와 같은 강도가 된다. */

