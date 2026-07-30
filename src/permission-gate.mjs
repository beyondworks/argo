// 권한 게이트 — 전권 모델(2026-07-30, Hermes YOLO 이식)의 **하드라인**이다. 능력 토글·결재 게이트는
// 사라졌고(capabilities.mjs 상수 동결), 이 파일의 금지 구역(앱 본체·격리 홈·벤더 자격·타사 데이터·
// 회사 금고)만이 어떤 상태에서도 열리지 않는 경계다.
//
// ⚠ 적용 범위: 이 게이트는 **SDK 러너(claude/glm/kimi/openrouter)의 도구 호출**에만 걸린다
// (chat.mjs의 canUseTool). codex·gemini·antigravity 같은 외부 CLI 러너는 프로세스 단위 샌드박스라
// 여기를 지나지 않는다 — 한계와 그 근거는 docs/runner-isolation-limits.md.
// ⚠ 셸 한계(정직 표기): Bash는 명령 "문자열"이라 리터럴 방어뿐이다 — $HOME·변수·와일드카드로
// 우회 가능하다. 셸에서 하드라인은 강제가 아니라 1차 방어 + 프롬프트 지시가 계약이고, 완전 강제는
// Read/Write/MCP 인자 판정(isForbidden)의 몫이다. 그래도 리터럴 목록은 하드라인 목록과 **정합**해야
// 한다 — 같은 파일을 Read는 deny하고 Bash는 allow하면 도구별 판정이 갈린다(분리 검수 2026-07-30 HIGH).
import { resolve, dirname, join, basename, sep, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fold, insideFold } from './pathcase.mjs';

// 홈은 env로만(HOME/USERPROFILE) — node:os homedir()를 **동적 join**(map/flatMap·slice 인자)에 쓰면
// Next 추적기(nft)가 빌드타임 부분평가로 홈 루트를 통글롭해 Windows 릴리스 빌드가 죽는다
// (v0.1.35 릴리스 CI 실측: WindowsApps EACCES → Failed to compile. v0.1.30에서 chat.mjs로 확정한
// 불변식의 재발 — v0.1.34까지의 `join(homedir(),'.argo')` 같은 **상수 join**은 그 폴더만 훑어 관용됐고,
// #187의 동적 join이 트리거였다). env 부재는 비실재 환경(launchd·Windows·systemd 전부 설정) —
// 그래도 비면 틸드 확장을 fail-closed(deny)로 보수화한다(아래 isForbidden).
const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? '';

// 경로 인자를 갖는 읽기 도구 — 워크스페이스 경계를 적용한다(P1-5). TodoWrite는 경로가 없어 별도(항상 허용).
const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/** 읽기 도구의 경계 검사 대상 경로들 — 하나라도 워크스페이스 밖이면 게이트(P1-5).
    Glob은 path와 pattern을 둘 다 본다: path가 안이어도 pattern이 절대경로/상위탈출이면 밖을 열거할 수 있어서다
    (path만 검사하면 안쪽 path + 절대 pattern 조합으로 우회됨). Grep의 pattern은 정규식이라 제외.
    (export: 회귀 테스트용) */
export function readToolTargets(toolName, input = {}) {
  const s = (v) => (typeof v === 'string' && v.length > 0 ? [v] : []);
  if (toolName === 'Glob') return [...s(input.path), ...s(input.pattern)];
  if (toolName === 'Grep') return s(input.path); // pattern은 정규식 — 경로 아님
  return s(input.file_path); // Read
}
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']); // 읽기지만 회사 밖으로 나간다 — browser 능력을 따른다
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** 워크스페이스 경계 판정(심링크 탈출 방어 포함) — p가 root 안이면 true.
    렉시컬(resolve)로 ../ 탈출을 먼저 막고, 실제 경로(존재분)를 realpath로 정규화해 심링크 탈출까지 막는다.
    (export: 회귀 테스트용) */
export function makeInWorkspace(wsRoot) {
  const root = resolve(wsRoot);
  return async function inWorkspace(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = p.startsWith('/') ? resolve(p) : resolve(root, p);
    if (abs !== root && !abs.startsWith(`${root}${sep}`)) return false; // 렉시컬 탈출 차단(sep — Windows 백슬래시)
    const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
    const realRoot = (await canon(root)) ?? root;
    const real = (await canon(abs)) ?? (await canon(dirname(abs))); // 대상이 없으면 부모로 심링크 재확인
    if (!real) return true; // 대상·부모 모두 부재 — 렉시컬 통과에 맡김(읽기는 어차피 실패)
    return real === realRoot || real.startsWith(`${realRoot}${sep}`);
  };
}

/** 지정 작업 폴더(workRoots) 경계 — 사장이 설정에서 등록한 외부 폴더는 워크스페이스처럼 책상이다
    (workroots.mjs — 신고 11건 해소 2026-07-27). 절대경로만 판정한다: 상대경로는 cwd(워크스페이스)
    기준이라 inWorkspace가 담당하고, makeInWorkspace에 상대경로를 주면 그 루트 기준으로 오해석된다.
    심링크 탈출 봉인은 makeInWorkspace를 그대로 재사용. (export: 회귀 테스트용) */
export function makeInWorkRoots(workRoots) {
  const checks = (workRoots ?? []).map((r) => makeInWorkspace(r));
  return async function inWorkRoots(p) {
    if (!checks.length || typeof p !== 'string' || !isAbsolute(p)) return false;
    for (const c of checks) if (await c(p)) return true;
    return false;
  };
}

/* ─── 금지 구역(하드 차단) — 능력(fs)·결재·bypass로도 열리지 않는다 ───
   실사용 신고(2026-07-22, 크리티컬): 데스크톱은 앱 서버 소스가 로컬에 함께 배포되는 구조라,
   fs 능력이 켜진 크루에게 "앱 디자인 고쳐줘"라고 하면 실행 중인 Argo 코드를 실제로 수정할 수 있었다.
   금지 구역: ① 실행 중인 Argo 코드 루트(dev=레포, 데스크톱=Resources/server) ② ~/.argo(격리 홈·조달
   도구·자격)와 벤더 자격(~/.codex·~/.claude·~/.gemini, 그리고 홈 직속 ~/.claude.json·~/.mcp.json —
   HARD_HOME_PATHS) ③ WS_ROOT의 다른 회사 워크스페이스·계정 시크릿(교차 테넌트) ④ 자기 워크스페이스 직속
   도트파일(.secrets.json 등 — 회사 자격) ⑤ 자기 워크스페이스 직속 제어 파일·크루 카드(아래 "회사
   금고"). 그 외 자기 워크스페이스 파일은 크루의 책상이라 항상 허용. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/의 부모 = 실행 중인 Argo 코드 루트

/* ─── 회사 금고 — 워크스페이스 직속이지만 크루의 책상이 아닌 것들 ───
   vault·skills·산출물(competitions·inbox)은 크루가 일하라고 준 책상이다. 반면 아래 파일들은 회사의 설정·자격·결재·
   정본이고, 이것들을 바꾸는 정당한 경로는 전부 서버측이다 — 크루 MCP 도구(request_capability/
   update_profile/hire_crew) → 사장 결재 → 시스템 적용, 또는 웹 설정 UI. 그 경로는 canUseTool을 지나지
   않으므로 여기서 막아도 정상 흐름은 영향이 없다.
   실측(2026-07-27, 격리 재현): 능력이 전부 꺼진 크루가 Write로 capabilities.json에
   {"fs":true,"browser":true,"shell":true,"bypass":true}를 써넣으면, 턴마다 능력을 다시 읽는 구조
   (chat.mjs `const caps = await loadCapabilities(wsId)`) 때문에 **다음 턴에 셸·바이패스를 획득**했다.
   Bash가 열리고 홈 파일 읽기까지 통과 — 능력 모델 전체가 파일 쓰기 한 번으로 무력화된다. */
const WS_CONTROL_FILES = new Set([
  'capabilities.json', // 능력 토글 — 자가 승격의 본체
  'mcp.json',          // MCP 서버 정의 = 임의 command 실행(secretbox도 시크릿으로 분류)
  'connections.json',  // 러너 연결·자격(secretbox 시크릿)
  'company.json',      // 회사 정본 — ownerId(소유권)·lang
  'routines.json',     // 예약 실행 — 미래의 턴을 임의 지시로 채울 수 있다
  'approvals.json',    // 결재 정본 — 위조되면 승인 모델 자체가 무너진다
  'gw-cursor-slack.json', // 게이트웨이 커서 — 조작하면 메시지 재처리·건너뛰기(gateway.mjs)
]);
/* 원장 — **쓰기만** 막고 읽기는 연다. 위조되면 청구·활동의 근거가 무너지지만 자격이 아니라 유출
   위험이 없고, 이 변경 전에는 크루가 읽을 수 있었다. 사장이 "이번 달 얼마 썼어?"라고 물었을 때
   답할 수단을 없애는 것은 이 수정의 목적(자가 승격 차단)과 무관한 기능 후퇴다 — 크루에게 사용액
   조회 도구가 따로 없으므로 대체 경로도 없다(분리 검수 MEDIUM). */
const WS_LEDGER_FILES = new Set([
  'usage.jsonl',  // 사용액 원장(청구 근거) — appendUsage가 서버측에서 쓴다
  'events.jsonl', // 활동 원장 — 사장이 보는 활동 화면의 근거(events.mjs)
]);
/* 크루 카드 = 그 크루의 시스템 프롬프트이자 러너·모델·범위(skills/mcp) 선언이다. update_profile 도구는
   자기 프로필 변경조차 사장 결재로 올리는데(chat.mjs), 파일 직접 쓰기는 그 결재를 통째로 건너뛴다 —
   자기 범위 확대와 동료 카드 오염이 결재 없이 가능해진다. 카드 내용은 이미 시스템 프롬프트로,
   동료 명단은 rosterPrompt로 주입되므로 크루가 이 파일을 직접 읽을 일도 없다. */
/* chats/도 같은 이유로 금고다. `chats/<slug>.json`은 대화 정본이고, 그 안의 `who === 'user'` 항목은
   다음 턴에 "사장:"으로 재생되어 모델 컨텍스트에 주입된다(chat.mjs). 크루가 동료 스레드에 가짜 사장
   발화를 써 넣으면 결재 없는 동료 지시 주입 + 사장이 보는 이력 위조가 성립한다 — agents/와 같은
   계열이다(분리 검수 MEDIUM). 크루가 이 파일을 직접 만질 정당한 흐름은 없다(이력은 프롬프트로
   주입되고 파일은 thread.mjs가 서버측에서 관리한다). */
const WS_CONTROL_DIRS = new Set(['agents', 'chats']);

/* 비교용 이름 정규화 — 파일시스템이 이름을 "손질해서" 같은 파일에 쓰는 경로를 막는다.
   ① Win32는 후행 점·공백을 잘라내므로 `capabilities.json.` / `capabilities.json `이 본체를 그대로
   덮는다. ② NTFS 대체 데이터 스트림(`capabilities.json::$DATA`)도 본체에 쓰인다. ③ 대소문자 무시
   파일시스템(macOS·Windows)에서는 `Capabilities.json`이 같은 파일이다 — 이미 있는 파일은 realpath가
   정규화해 주지만 아직 없는 파일은 렉시컬이라 표기만 바꾼 이름이 그대로 통과한다.
   macOS 실측으로는 후행 점이 별개 파일이라 무해했고(원본 미변경), 이 방어의 실제 대상은 Windows다 —
   Windows 라이브 미검증, 코드 방어. sep 하드코딩으로 경계가 통째로 불발되던 계열과 같은 교훈이다.
   ⚠ 의도적 과차단(fail-closed): 대소문자 구분 파일시스템에서 `Capabilities.json`은 실제로 별개
   파일이고 `capabilities.json:메모`도 POSIX에선 합법이지만 둘 다 막는다. 워크스페이스 루트는 애초에
   크루의 책상이 아니라 실질 피해가 없다 — "버그 같다"고 되돌리지 말 것. */
const normName = (n) => n.split(':')[0].replace(/[. ]+$/, '').toLowerCase();

/* 하드라인 홈 항목 — canonical 판정(roots().hard)과 Bash 리터럴 방어가 **같은 목록**을 쓴다.
   분리 검수 2026-07-30 HIGH: 벤더 자격을 hard에만 넣고 Bash 리터럴에서 빠뜨려, 같은 auth.json이
   Read/Write/MCP는 deny인데 `cat ~/.codex/auth.json`은 allow였다. 목록이 갈라지면 재발한다.
   디렉터리와 **홈 직속 파일**이 섞인다(이름이 _DIRS가 아닌 이유) — 자격은 디렉터리 안에만 살지 않는다. */
const HARD_HOME_PATHS = [
  '.argo',   // 격리 홈·조달 도구·자격
  '.codex',  // Codex CLI 자격(auth.json)
  '.claude', // Claude Code 자격(.credentials.json)
  '.gemini', // gemini-cli 자격(oauth_creds.json)
  // 홈 직속 **파일** — 위가 디렉터리 접두 비교라 목록 밖이었다(#191 분리 검수 INFO 실측:
  // `~/.claude.json`은 ALLOW인데 같은 성격의 `~/.claude/.credentials.json`은 DENY로 갈렸다).
  // 이 파일들은 호스트 MCP 서버 정의를 **env(토큰)까지** 담는다 — market.mjs가 그 env를 그대로
  // 회사 mcp.json에 복사하고 mcp.json은 시크릿 봉투 대상이라는 것이, 원본이 자격이라는 증거다.
  // #187의 원칙 그대로: 전권은 파일을 맡긴다는 뜻이지 자격을 넘긴다는 뜻이 아니다.
  // ⚠ 서버측 경로(listHostMcp·importHostMcp)는 canUseTool을 지나지 않아 그대로 동작한다 —
  // 막는 것은 "크루의 도구"가 이 파일에 닿는 경로뿐이다(호스트 MCP 가져오기 기능은 회귀 없음).
  '.claude.json',
  '.mcp.json',
];

/* Bash 리터럴 방어 대상(파일명) — 셸 명령 문자열에 이 이름이 그대로 들어간 순진한 시도를 막는다.
   제어·원장 "파일명"은 충분히 특이해 부분 문자열로 본다. 디렉터리(agents/·chats/)는 일반 토큰이라
   부분 문자열이면 URL(`/v1/chats/123`)·하위 데이터(`vault/chats/`)까지 오차단해 크루가 "API 호출이
   보호 구역에 막혔다"는 거짓 설명을 하게 된다(재검수 MEDIUM) — 토큰 시작 경계(행 머리·공백·따옴표·
   셸 연산자 뒤, 선택적 ./)에서만 잡는 정규식으로 좁힌다. 실판정은 isForbidden의 몫, 여기는 1차 방어. */
const BASH_GUARDED = [...WS_CONTROL_FILES, ...WS_LEDGER_FILES];
// 경계 클래스에 리다이렉트·쉼표(<>,) 포함 — `>chats/b.json`(공백 없는 리다이렉트)이 위조 명령의 가장
// 자연스러운 형태다(재검수 3R). 잔여: `../`·`$PWD/` 간접 표기는 파일 헤더의 셸 한계 범위(실판정은 isForbidden).
const BASH_DIR_RE = new RegExp(String.raw`(^|[\s'"\x60;|&(=<>,])(\.[\\/])?(${[...WS_CONTROL_DIRS].join('|')})[\\/]`, 'i');

/** p가 금지 구역인가 — 판정 전 자기 워크스페이스 안(inWorkspace)이 먼저 통과됐다는 전제의 2차 검사.
    canonical(실경로) 기준 — 심링크로 금지 구역을 우회하지 못한다.
    mode='write'면 원장(usage/events.jsonl)까지 금지에 포함한다 — 읽기는 열려 있다(WS_LEDGER_FILES).
    (export: 회귀 테스트용) */
export function makeIsForbidden(wsRoot, appRoot = APP_ROOT) {
  const wsAbs = resolve(wsRoot);
  // sep 사용 필수 — Windows resolve()는 백슬래시라 '/' 하드코딩이면 경계 비교가 전부 불발돼
  // 보호가 통째로 무력화된다(검수 MED — workspace.mjs paths()의 v0.1.1 실측과 같은 계열).
  // 허용 분기(자기 워크스페이스 안)는 정확 비교, 금지 구역·타사 판정(deny)은 케이스 폴딩 —
  // 대상·부모 모두 미존재면 real이 렉시컬 폴백(입력 케이스 보존)이라, 폴딩 없인 ~/.ARGO/NS/DEEP 같은
  // 케이스 변형으로 하드 차단 안에 새 하위 트리를 만들 수 있었다(분리 검수 격리 재현 2026-07-28).
  // 폴딩은 deny에만 — 허용에 폴딩하면 허용이 넓어진다(원칙은 pathcase.mjs).
  const inside = (p, root) => p === root || p.startsWith(`${root}${sep}`);
  const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
  /* 아직 없는 경로의 canonical — 조상 중 실재하는 가장 가까운 것을 realpath하고 나머지 구간을 다시
     붙인다. 부모 하나만 보면 중간 디렉토리까지 없을 때(agents/sub/x.md, 스캐폴드 전 회사) 정규화가
     통째로 어긋나 경계 비교가 전부 불발된다 — macOS는 /var→/private/var 심링크라 ARGO_ROOT가
     /var/... 이면 실제로 발생한다(테스트 실측: agents/ 미존재 시 카드 쓰기가 통과했다). */
  const canonDeep = async (t, depth = 0) => {
    const direct = await canon(t);
    if (direct) return direct;
    const parent = dirname(t);
    // 상한 — 적대적으로 긴 미존재 경로가 세그먼트마다 realpath를 유발하는 비용을 막는다(200세그먼트
    // ≈ 7ms 실측). 상한에 닿으면 렉시컬로 떨어지는데, 그건 canonical 정규화를 못 했다는 뜻이라
    // 경계 비교가 느슨해질 수 있다 — 실제 경로는 이 깊이에 한참 못 미친다.
    if (parent === t || depth >= 64) return t; // 루트까지 올라갔다 — 더 볼 조상이 없다
    return join(await canonDeep(parent, depth + 1), basename(t));
  };
  // 비교 기준(루트들)도 canonical로 — macOS /var→/private/var 같은 루트 쪽 심링크 때문에
  // 대상만 realpath하면 경계 비교가 전부 어긋난다(테스트 실측). 1회 계산 후 재사용.
  let rootsP = null;
  const roots = () => (rootsP ??= (async () => {
    const ws = (await canon(wsAbs)) ?? wsAbs;
    // 하드 루트는 **렉시컬(raw)·canonical 두 형태를 모두** 비교 목록에 둔다 — 루트 자체에 심링크
    // 조상이 있으면(/var→/private/var, 정션 홈 Windows 설치) canonical만으론 렉시컬 leg(abs 비교)가
    // 무동작해 "안→밖 심링크"가 빠져나간다(분리 검수 LOW 실측: /tmp 경유 입력이 allow — 이번
    // forbidden-zone 심링크 테스트가 tmpdir에서 그대로 재현했다).
    const hardRaw = [resolve(appRoot), ...(homeDir() ? HARD_HOME_PATHS.map((d) => join(homeDir(), d)) : [])];
    return {
      ws,
      parent: dirname(ws), // WS_ROOT — 형제 = 다른 회사, 직속 도트파일 = 계정 시크릿·기기 마커
      // 벤더 자격 디렉터리가 하드라인에 함께 든다(2026-07-30). 전권이 기본이 된 뒤로 이 목록이
      // **유일한** 방어선이라, "~/.argo(격리 홈)는 막는데 그 격리 홈이 빌려 쓰는 원본은 열려 있다"는
      // 비대칭을 남길 수 없다. 실측(분리 검수 M1): fs 능력만으로 ~/.codex/auth.json·
      // ~/.gemini/oauth_creds.json·~/.claude/.credentials.json이 전부 allow였다. 사장이 위임한 것은
      // "문서 접근"인데 얻는 것은 "구독 계정 탈취"라 위임 범위가 어긋난다 — Hermes 하드라인과 같은 논리로,
      // 전권은 파일을 맡긴다는 뜻이지 자격을 넘긴다는 뜻이 아니다.
      hard: [...new Set([
        ...hardRaw, // Bash 리터럴 방어와 같은 목록(정합 계약)
        ...(await Promise.all(hardRaw.map(async (r) => (await canon(r)) ?? r))),
      ])],
    };
  })());
  return async function isForbidden(p, mode = 'read') {
    if (typeof p !== 'string' || !p.trim()) return false;
    // 선행 ~ 확장(재검수 HIGH) — 미확장이면 `~/.codex/...`가 워크스페이스 상대경로로 오해석돼
    // (<ws>/~/.codex) 하드라인이 통째로 열린다. Bash는 셸이 확실히 확장하고(cat ~/.codex/auth.json
    // 실유출 재현), MCP/Read도 소비 측 expanduser가 흔해 같은 형태를 같은 판정으로 묶는다.
    // 틸드인데 홈을 모르면(env 부재) 확장 불가 = 판정 불가 → deny(fail-closed). 미확장 통과는
    // `~/.codex/...`가 워크스페이스 상대경로로 오해석돼 하드라인이 통째로 열리는 방향이라 금지.
    const tilde = p === '~' || p.startsWith('~/') || p.startsWith('~\\');
    if (tilde && !homeDir()) return true;
    const pt = p === '~' ? homeDir() : tilde ? join(homeDir(), p.slice(2)) : p;
    const abs = pt.startsWith('/') ? resolve(pt) : resolve(wsAbs, pt);
    // 대상 자신의 경로를 유지한 채 canonical화한다. 이전처럼 미존재 대상을 부모로 통째 대체하면
    // 대상이 워크스페이스 루트 자체로 판정되어 "직속 파일" 검사가 불발된다 — 존재하지 않는
    // .secrets.json 생성이 그렇게 통과했다(2026-07-27 실측: 기존 테스트는 파일을 미리 만들고
    // 검사해 이 경로를 못 봤다).
    const real = await canonDeep(abs);
    const R = await roots();
    if (inside(real, R.ws)) {
      if (real === R.ws) return false; // 워크스페이스 루트 자체
      const rel = real.slice(R.ws.length + 1).split(sep); // sep — Windows 백슬래시
      // 직속 도트 항목은 하위까지 전부 금지. 파일만 막으면 도트 "디렉토리" 하위가 빠져나간다 —
      // .gw-queue-*/(게이트웨이 큐)에 항목을 넣으면 드레이너가 그대로 처리한다(전수 수색 2026-07-27).
      // vault/.trash처럼 직속이 아닌 도트 경로는 여기 걸리지 않는다(크루 책상의 정상 데이터, 통과).
      if (rel[0].startsWith('.')) return true;
      const head = normName(rel[0]); // 후행 점·공백·ADS·대소문자 손질 후 비교
      if (WS_CONTROL_DIRS.has(head)) return true; // agents/** — 크루 카드는 하위까지 전부
      if (rel.length !== 1) return false;
      return WS_CONTROL_FILES.has(head) || (mode === 'write' && WS_LEDGER_FILES.has(head));
    }
    // 하드 구역은 **렉시컬(abs)과 canonical(real) 둘 다** fail-closed로 본다(2026-07-30).
    // canonical만 보면 "보호 구역 안에 있으면서 밖을 가리키는 심링크"를 놓친다 — 실제로 조달이 만드는
    // ~/.argo/codex-home/auth.json → ~/.codex/auth.json 심링크가 그랬다(격리 재현: isForbidden('~/.argo')
    // =true인데 그 하위 심링크만 false). 반대로 렉시컬만 보면 밖에서 안을 가리키는 심링크를 놓친다.
    // deny 판정은 둘 중 하나만 걸려도 막는 게 맞다 — 허용 분기(정확 비교)와 방향이 반대다.
    for (const r of R.hard) if (insideFold(real, r) || insideFold(abs, r)) return true;
    // 부수 효과(의도): 자기 워크스페이스의 케이스 변형+미존재 경로는 허용 분기(정확 비교)에서 떨어져
    // 여기 걸린다 — fail-safe 과차단. 메시지가 '타사'라 오해 소지 있으나 허용 확대보다 낫다(검수 LOW 수용).
    if (insideFold(real, R.parent)) return true; // WS_ROOT 아래인데 자기 회사 밖 — 타사 데이터·계정 시크릿
    return false;
  };
}

const FORBIDDEN_MSG = {
  // 목록을 열거하지 않고 **규칙**으로 쓴다 — 차단 대상이 늘 때마다 이 문구가 코드와 어긋나고,
  // 크루는 막혔을 때 이 텍스트만 읽으므로 "그 목록엔 없던데"로 재시도하게 된다(분리 검수 MEDIUM).
  // ⚠ 없어진 도구를 지시하지 않는다 — request_capability는 전권 전환으로 제거됐다(분리 검수 2026-07-30:
  // denyHard마다 크루가 이 문구를 읽으므로, 죽은 도구 지시는 "그 도구가 없는데요" 혼란을 양산한다).
  ko: 'Argo 앱 자체(설치 폴더·서버 코드)와 다른 회사의 데이터, 그리고 이 회사의 설정·자격·결재·원장 파일과 크루 카드(agents/)·대화 정본(chats/)은 보호 구역이다. 회사 폴더 바로 아래에 있는 설정 파일들과 `.`으로 시작하는 항목이 전부 여기 해당한다 — 읽기도 쓰기도 막히고, 원장(사용액·활동)만 읽기가 열려 있다. 이 설정들은 파일을 고쳐서가 아니라 도구로 바꾼다 — 도구 설치는 request_tool_install(자동 승인·활동 기록), 프로필·영입은 update_profile/hire_crew로 사장 결재를 올려라. 네 책상(vault/·skills/·산출물)은 그대로 쓸 수 있다. 앱 개선 요청이면 사장에게 "설정 → 피드백"으로 전달하라고 안내하라.',
  en: 'The Argo app itself (install folder, server code), other companies’ data, and this company’s settings, credential, approval and ledger files plus crew cards (agents/) and chat threads (chats/) are protected. That means every settings file sitting directly in the company folder and anything starting with `.` — blocked for both reading and writing, except the ledgers (usage, activity) which stay readable. These settings change through tools, not file edits: use request_tool_install for tools (auto-approved, logged to Activity), and update_profile / hire_crew for crew changes, which go to the captain for approval. Your desk (vault/, skills/, project output) is unaffected. If the captain wants app improvements, point them to Settings → Feedback.',
};

/** SDK 도구 호출의 유일한 게이트(전권 모델) — allowedTools에 없는 도구가 여기로 온다.
    전권은 결재·능력 체크가 없다는 뜻이고, **금지 구역은 예외 없이 차단**한다(실사용 신고 2026-07-22
    크리티컬 — "전권"의 의미는 파일을 맡긴다는 것이지 앱·자격·타사 데이터를 넘긴다는 것이 아니다).
    lang = 거절 메시지 언어. workRoots = 사장이 지정한 외부 작업 폴더 — **이 게이트 판정에는 현재
    미사용**(전권이라 안/밖 경계가 없고, 재귀 판정은 "워크스페이스를 품는가" 하나로 족하다). 소비처는
    codex writable_roots·시스템 프롬프트 주입이며, 파라미터는 호출 계약 유지용(재검수 LOW 정직화). */
export function makePermissionGate(wsId, slug, wsRoot, from = null, lang = 'ko', workRoots = []) {
  const isForbidden = makeIsForbidden(wsRoot);
  const denyHard = () => ({ behavior: 'deny', message: FORBIDDEN_MSG[lang === 'en' ? 'en' : 'ko'] });
  // Bash 보완 방어 — 명령 문자열에 금지 구역 경로가 리터럴로 들어간 순진한 시도를 차단한다.
  // (셸은 변수·상대경로로 우회 가능한 프로세스 단위 도구 — 완전 차단이 아니라 1차 방어 + 프롬프트
  //  지시가 계약. 파일 헤더의 "셸 한계" 참조.) 목록은 하드라인(HARD_HOME_PATHS)과 공유 — 갈라지면
  // 같은 파일의 도구별 판정이 갈린다(분리 검수 2026-07-30 HIGH).
  const bashHardLiterals = [APP_ROOT, ...HARD_HOME_PATHS.flatMap((d) => [...(homeDir() ? [join(homeDir(), d)] : []), `~/${d}`])]; // 틸드 형태 포함(재검수 HIGH — 셸이 확장하는 가장 자연스러운 표기)
  const wsAbs = resolve(wsRoot);

  /* 검색 루트가 금고를 품는가 — Grep/Glob은 준 경로 **아래를 재귀**하므로, 경로 자체가 금지가 아니어도
     그 아래 제어 파일이 걸리면 내용이 그대로 흘러나온다. 실측(분리 검수 HIGH): 워크스페이스 루트에
     `rg "token"`을 걸면 connections.json의 봇 토큰이 평문으로 나왔다 — 즉 "제어 파일 읽기 차단"이
     Read 단일 파일에만 성립하고 Grep 한 번에 무력화됐다. 대표 항목을 실제 판정에 태워 확인한다
     (목록이 늘어도 자동으로 따라온다). 원장은 읽기가 허용이므로 프로브에서 뺀다. */
  const coversControl = async (root) => {
    // 판정은 "검색 루트가 워크스페이스를 통째로 품는가" 하나면 족하다 — 금고는 전부 워크스페이스
    // 직속이므로, 재귀가 금고에 닿는 경우는 루트가 워크스페이스 자신이거나 그 조상일 때뿐이다.
    // 조상까지 봐야 하는 이유: 사장이 홈처럼 넓은 폴더를 작업 폴더(workRoots)로 등록하면 워크스페이스가
    // 그 안에 들어와, 직속만 검사하면 조상 경로에서 들어오는 재귀를 통째로 놓친다.
    // 상대경로는 크루의 cwd(=워크스페이스) 기준 — 서버 프로세스의 cwd로 풀면 엉뚱한 곳을 가리킨다.
    const abs = isAbsolute(root) ? resolve(root) : resolve(wsAbs, root);
    return makeInWorkspace(abs)(wsAbs);
  };
  const denyScope = () => ({ behavior: 'deny', message: lang === 'en'
    ? 'Searching the whole company folder is blocked because it would sweep in settings and credential files. Search a specific folder instead — `vault/` for documents and notes, `skills/` for company skills — and say which folder you searched.'
    : '회사 폴더 전체 검색은 설정·자격 파일까지 훑게 되어 막혀 있다. 구체적인 폴더를 지정해 다시 검색하라 — 문서·기록은 `vault/`, 회사 스킬은 `skills/`. 어느 폴더를 뒤졌는지 밝혀라.' });

  /* 도구 인자에 든 경로가 금지 구역인가 — 분류표에 없는 도구(SDK 신규 도구, 외부 MCP)가 경로를 들고
     와도 금고를 만지지 못하게 하는 마지막 그물이다. 도구 이름 화이트리스트를 늘려 가는 대신 "어떤
     도구든 금지 구역 경로를 인자로 주면 막는다"는 불변식으로 둔다 — 새 도구가 조용히 통과하지 않는다.
     실측(분리 검수 HIGH): `mcp__filesystem__write_file{path: <ws>/capabilities.json}`이 allow였다.
     인자 표면을 넓혔다(2026-07-30) — 예전엔 ① 얕은 Object.values만 보고 ② `sep`이 든 문자열만 검사해서
     `{paths:[<abs>]}`(배열)·`{args:{path:<abs>}}`(중첩)·`{path:"capabilities.json"}`(상대경로)가 전부
     통과했다(격리 실행 재현). 특히 상대경로가 위험하다 — MCP 서버는 cwd=회사 폴더로 스폰되므로
     `capabilities.json` 한 단어가 실제로 금고를 가리키는데, 같은 입력을 Write는 deny하고 MCP는 allow해
     두 경로의 판정이 갈렸다. */
  // 경로형 키 — 구분자 없는 단일 토큰을 경로 후보로 볼지 결정한다(아래). 값 기준(제어 파일명 목록)은
  // "agents"가 일반 단어이자 제어 디렉터리라 어느 쪽으로 정해도 한쪽이 깨졌다(재검수: 오차단을 풀면
  // {path:'agents'} deny가 사라지는 회귀). 키 기준이면 {note:'agents'} allow와 {path:'agents'} deny가
  // 동시에 성립한다. 배열 원소는 배열을 담은 키를 상속한다({paths:[...]}).
  const PATHY_KEY_RE = /path|file|dir|folder|target|dest|src|source|location/i; // 'name'·'url'은 제외 — 크루 이름·웹 주소 등 비경로 값이 흔하다(과차단 방향 회귀 방지)
  const argPathsForbidden = async (obj, depth = 0, keyHint = '') => {
    if (depth > 4 || obj == null) return false; // 깊이 상한 — 적대적으로 중첩된 인자 트리 비용 차단
    const entries = Array.isArray(obj) ? obj.map((v) => [keyHint, v]) : Object.entries(obj);
    for (const [k, v] of entries) {
      if (v && typeof v === 'object') { // 배열·중첩 객체도 훑는다(아래 주석)
        if (await argPathsForbidden(v, depth + 1, String(k))) return true;
        continue;
      }
      if (typeof v !== 'string' || !v.trim()) continue;
      // 길이·개행 컷 — 경로가 아닌 값(Write의 content 등)에 realpath 재귀를 태우지 않기 위한 비용
      // 방어다. PATH_MAX(4096)를 넘거나 (trim 후에도) 개행이 든 문자열은 도구 인자로서의 경로가
      // 아니다. 앞뒤 개행만 붙은 경로(`"capabilities.json\n"`)는 trim해 검사한다(분리 검수 LOW).
      if (v.length > 4096) continue;
      const vv = v.trim();
      if (vv.includes('\n')) continue;
      // 구분자 없는 단일 토큰 — (a) 키가 경로형이거나 (b) **값 자체가 금고를 특정**(제어·원장 파일명,
      // 도트 접두)할 때만 경로 후보로 본다. 키만 보면 비경로 키({to:'mcp.json'} — mcp__fs__move의
      // {from,to} 시그니처)로 제어 파일 쓰기가 열리고(재검수 3R: MCP 정의 덮어쓰기 = 임의 command),
      // 값만 보면 제어 디렉터리 단어({note:'agents'})가 오차단된다. 합집합이 정답 — 제어 "디렉터리"
      // (agents·chats)만 키 게이트에 남는다(그것이 오차단을 만든 유일한 값이었다).
      // 구분자(또는 ~) 동반 값은 키와 무관하게 전체 판정을 탄다.
      if (!vv.includes('/') && !vv.includes('\\') && !vv.startsWith('~')) {
        const n = normName(vv);
        const valueHit = n.startsWith('.') || WS_CONTROL_FILES.has(n) || WS_LEDGER_FILES.has(n);
        if (!valueHit && !PATHY_KEY_RE.test(String(k))) continue;
      }
      if (await isForbidden(vv, 'write')) return true; // 인자는 쓰기일 수 있다 — 넓은 쪽으로 판정
    }
    return false;
  };

  return async function canUseTool(toolName, input) {
    const allow = { behavior: 'allow', updatedInput: input };
    if (toolName === 'TodoWrite') return allow; // 경로 인자가 없다
    // 자체 크루 서버(mcp__crew__*)만 무검사 — 서버측 코드라 게이트를 지날 이유가 없다. 그 외 MCP는
    // 사장이 연결한 임의 서버(파일 쓰기 도구 포함)라 경로 인자를 검사한다.
    if (toolName.startsWith('mcp__')) {
      if (toolName.startsWith('mcp__crew__') || toolName === 'mcp__crew') return allow;
      return (await argPathsForbidden(input)) ? denyHard() : allow;
    }

    if (READ_FILE_TOOLS.has(toolName)) {
      // 파일 읽기(Read/Glob/Grep) — 전권이라 안/밖 구분이 없다. 금지 구역만이 경계다.
      const targets = readToolTargets(toolName, input); // Read=file_path, Grep=path, Glob=path+pattern
      // 금지 구역 검사를 안/밖 불문 **먼저** 전부 돌린다. 예전엔 워크스페이스 안 대상을 continue로
      // 건너뛰고 "전부 안쪽일 때"만 따로 검사했는데, 인자 하나가 밖이면 그 블록을 못 타 안쪽 금지
      // 대상이 미검사로 통과했다 — Glob{path: 밖의 임시디렉토리, pattern: <ws>/connections.json}이
      // fs·bypass에서 allow였다(분리 검수 HIGH, 실행 재현 2026-07-27). 인자가 여러 개인 도구는
      // "한 인자의 판정이 다른 인자의 검사를 건너뛰게 하지 않는다"가 계약이다.
      for (const t of targets) if (await isForbidden(t)) return denyHard();
      // 재귀 도구는 검색 **루트**를 따로 본다. path 생략이면 cwd = 워크스페이스 루트다(그래서 아무
      // 인자 없는 Grep이 금고까지 훑었다). pattern은 루트가 아니라 필터라 위 루프가 맡는다.
      if (toolName === 'Grep' || toolName === 'Glob') {
        const root = typeof input?.path === 'string' && input.path.trim() ? input.path : wsAbs;
        if (await coversControl(root)) return denyScope();
      }
      return allow; // 전권 — 금지 구역은 위에서 이미 전건 차단됐다
    }
    if (WEB_TOOLS.has(toolName)) return allow; // 전권 — 웹 도구엔 경로 인자가 없다
    if (WRITE_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.notebook_path ?? '';
      if (await isForbidden(target, 'write')) return denyHard(); // 금지 구역 — 제어 파일·원장·도트파일 포함
      return allow; // 전권 — 금지 구역(위 한 줄)만이 경계다
    }
    if (toolName === 'Bash') {
      const cmd = String(input?.command ?? '');
      if (bashHardLiterals.some((r) => fold(cmd).includes(fold(r)))) return denyHard(); // 리터럴 경로 1차 방어(케이스 폴딩) — 하드라인 목록과 공유(정합 계약)
      // 회사 금고도 같은 수준의 1차 방어를 받는다. 셸은 변수·상대경로로 우회 가능하지만, 그 논리라면
      // 위 줄도 없어야 한다 — 같은 자리에 같은 방어를 두는 것이 일관적이다(분리 검수 MEDIUM).
      // 이게 없으면 shell 능력이 켜진 SDK 크루가 `echo '{"bypass":true}' > capabilities.json` 한 줄로
      // 게이트를 우회한다(실측). 오탐(그 이름을 언급한 정당한 명령 거절)은 fail-closed로 수용한다.
      // 폴딩은 위 줄과 동일 기준(대소문자 무시 FS에서 CAPABILITIES.JSON 우회 차단 — #145 계열).
      if (BASH_GUARDED.some((n) => fold(cmd).includes(fold(n))) || BASH_DIR_RE.test(cmd)) return denyHard();
      return allow; // 전권 — 리터럴 방어(위 두 줄)가 셸의 하드라인이다
    }
    // 그 외 도구 — 능력 분류 밖(SDK 내장 Task 등). 능력 판정은 여전히 허용 쪽이다(이전 모델도 결재만
    // 걸고 결국 허용했으므로 동작 등가). 다만 **금고는 예외 없다** — 분류표에 없는 도구가 경로를 들고
    // 와도 여기서 막는다. SDK가 파일 쓰기 도구를 새로 노출하면 위 분류에 추가하는 것이 정식 대응이지만,
    // 추가하기 전까지 조용히 통과하던 창을 이 한 줄이 닫는다(분리 검수 HIGH·MEDIUM 공통 지적).
    return (await argPathsForbidden(input)) ? denyHard() : allow;
  };
}
