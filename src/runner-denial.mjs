// 외부 CLI 러너(codex)의 샌드박스 거부를 Argo의 능력 계층으로 승격한다.
//
// 왜 필요한가 — SDK(Claude Code) 러너는 permission-gate가 도구 호출을 가로채 "켤까요?" 카드를
// 띄운다. 외부 CLI는 그 자리가 없다: 거부가 프로세스 안에서 일어나고, 사장은 카드도 안내도 못
// 받은 채 "권한을 다 켜놨는데도 쓰기가 차단된다"로 읽는다(실사용 신고 2026-07-26).
//
// strict(생 출력 줄) 탐지 단일 — 실측 근거(2026-07-26, codex-cli 0.144.1 캡처):
//  `zsh:1: operation not permitted: /path` 같은 생 에러 줄만 신뢰한다.
// 이전의 서술형 2차 탐지("쓰기 권한이 없습니다" 자연어)는 **능력 OFF일 때만** 켜기 카드로 잇는
// 설계였는데, 전권 전환(2026-07-30)으로 능력 OFF 상태 자체가 사라져 도달 불가가 됐다 — 죽은
// 배선을 소스 단언이 고정하고 있던 것을 분리 검수가 잡아 걷어냈다. 전권에서 거부가 남는 원인은
// 능력이 아니라 codex 샌드박스 쓰기 범위(홈·지정 작업 폴더 밖)와 OS 권한이다.
//
// 범위: codex 전용(배선도 chat.mjs에서 codex만 태운다). gemini는 샌드박스가 없어 fs 거부가
// caps와 무관한 OS 오류다 — 능력 원인으로 단정하면 거짓 안내가 된다(검수 MEDIUM-2).

const BT = '`'; // 백틱 — String.raw 템플릿 안에 직접 못 쓴다(리터럴 종결)
// 경로: 유닉스 절대/홈 + 윈도우 드라이브(역슬래시·슬래시 둘 다 — C:/ 형태에서 드라이브가 잘리면
// 홈 판정이 뒤집혀 카드가 억제된다, 검수 2R MEDIUM-2). 드라이브 대안을 앞에 둬 leftmost 매칭.
const PATH = String.raw`([A-Za-z]:[\\/][^\s'"${BT},)]+|(?:\/|~\/)[^\s'"${BT},)]+)`;
// 접두 토큰: ASCII 계열만(명령·파일명·"Error") — 한글 서두("참고:"·"주의:")가 통과하면
// 설명문이 생 출력으로 오인된다(검수 2R MEDIUM-1).
const PRE = String.raw`(?:[\w./\\-]{1,40}:\s*){0,2}`;
// 줄 머리: 공백 0~3칸만 — 4칸/탭 들여쓰기는 마크다운 코드블록(인용 예시)이다(검수 2R HIGH-2).
const HEAD = String.raw`^ {0,3}`;
const FS_DENIAL = [
  new RegExp(String.raw`${HEAD}(?:zsh|bash|sh|dash):\s*(?:\d+:\s*)?operation not permitted:\s*${PATH}`, 'i'), // codex seatbelt 실측 형태
  new RegExp(String.raw`${HEAD}${PRE}(?:EPERM|EACCES):[^\n]*?['"${BT}]?${PATH}`), // 콜론 필수 — "EACCES 오류는…" 설명문 차단
  new RegExp(String.raw`${HEAD}${PRE}permission denied[^\n]*?['"${BT}]?${PATH}`, 'i'),
  new RegExp(String.raw`${HEAD}${PRE}${PATH}[^\n]*?read-only file system`, 'i'), // cp류는 경로가 문구 앞
  new RegExp(String.raw`${HEAD}${PRE}read-only file system[^\n]*?['"${BT}]?${PATH}`, 'i'),
];

// 네트워크 거부 — codex는 browser 능력이 꺼지면 network_access=false라 DNS부터 막힌다.
// 생 에러 줄에는 한글이 없다 — 한글 포함 줄은 설명문으로 보고 건너뛴다(NET 전용 가드).
const NET_DENIAL = [
  new RegExp(String.raw`${HEAD}curl:\s*\(\d+\)\s*could not resolve host`, 'i'),
  new RegExp(String.raw`${HEAD}${PRE}(?:getaddrinfo\s+)?(?:ENOTFOUND|EAI_AGAIN)\s+[\w.-]*\.[\w-]+`), // 점 있는 호스트 필수 — "ENOTFOUND는…" 차단
  new RegExp(String.raw`${HEAD}${PRE}(?:name or service|nodename nor servname) not known`, 'i'),
  new RegExp(String.raw`${HEAD}${PRE}network is unreachable`, 'i'),
  new RegExp(String.raw`${HEAD}${PRE}temporary failure in name resolution`, 'i'),
];

/** 코드펜스 밖의 줄만 — 크루가 에러를 예시로 보여주는 정석 표기가 코드블록이다.
    펜스는 여는 마커의 문자·길이를 기억해 같은 종류·같은 길이 이상일 때만 닫는다
    (```…~~~ 혼합, 4중 백틱 안 3중 백틱에서 토글이 뒤집히던 결함 — 검수 2R LOW-2). */
function unfencedLines(text) {
  const out = [];
  let fence = null; // { ch, len }
  for (const line of String(text).split('\n')) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0], len = m[1].length;
      if (!fence) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len) fence = null;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

/** 경로 꼬리 정리 — 문장 끝 마침표·따옴표가 경로에 붙어 들어오는 것 방지(검수 LOW-3). */
const cleanPath = (p) => String(p ?? '').replace(/[.,;:'"`)]+$/, '');

/** 생 출력 거부 탐지(순수, strict) — { cap, path } 또는 null. 어느 능력 상태에서든 신뢰한다.
    fs를 먼저 본다: 네트워크 문구가 더 일반적이라 오탐 여지가 크다. */
export function detectRunnerDenial(text) {
  const s = String(text ?? '');
  if (!s) return null;
  const lines = unfencedLines(s);
  for (const line of lines) {
    for (const re of FS_DENIAL) {
      const m = line.match(re);
      if (m) return { cap: 'fs', path: cleanPath(m[1]) };
    }
  }
  for (const line of lines) {
    if (/[가-힣]/.test(line)) continue; // 생 네트워크 에러 줄에 한글은 없다
    for (const re of NET_DENIAL) {
      if (re.test(line)) return { cap: 'browser', path: '' };
    }
  }
  return null;
}

/** 거부 안내문(순수) — 전권 모델: 거부의 원인은 능력 토글이 아니라 codex 샌드박스 쓰기 범위
    (홈·지정 작업 폴더 밖)나 OS 권한·네트워크다. 원인을 단정하지 않고 후보를 나열한다(검수 MEDIUM-3).
    (능력 OFF·켜기 카드 갈래는 전권 전환으로 도달 불가가 되어 제거 — 분리 검수 2026-07-30) */
export function denialNote({ cap, path = '', lang = 'ko', outsideHome = false }) {
  const en = lang === 'en';
  const where = path ? (en ? ` (target: ${path})` : ` (대상: ${path})`) : '';

  if (cap === 'browser') {
    return en
      ? `\n\n---\n⚠ The network was blocked. Likely one of: ① an actual network problem (offline, VPN, firewall), ② the runner connection not picking up settings — try reconnecting the runner in **Settings → AI connections** (or updating its CLI).`
      : `\n\n---\n⚠ 네트워크가 막혔습니다. 다음 중 하나일 수 있습니다: ① 실제 네트워크 문제(오프라인·VPN·방화벽), ② 러너 연결에 설정이 반영되지 않음 — **설정 → AI 연결**에서 러너 재연결(또는 CLI 업데이트)을 시도해 주세요.`;
  }
  const candidates = outsideHome
    ? (en
        ? `The target is outside your home folder — this runner writes inside your home folder and the work folders you registered. Register that folder in **Settings → Work folders**, or move the file under your home folder, and I'll retry.`
        : `대상이 홈 폴더·지정 작업 폴더 밖입니다 — 이 러너의 쓰기 범위는 거기까지입니다. **설정 → 작업 폴더**에 그 폴더를 등록하시거나 파일을 홈 안으로 옮겨 주시면 다시 시도하겠습니다.`)
    : (en
        ? `Likely one of: ① the operating system is blocking it — **System Settings → Privacy & Security → Files and Folders** (or Full Disk Access), allow Argo and restart the app; on Windows, check the folder isn't read-only or under controlled folder access. ② The runner connection isn't picking up settings — reconnect the runner in **Settings → AI connections** (or update its CLI).`
        : `다음 중 하나일 수 있습니다: ① 운영체제가 막고 있음 — **시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더**(또는 전체 디스크 접근 권한)에서 Argo를 허용하고 앱을 다시 켜 주세요. 윈도우라면 폴더가 읽기 전용인지·제어된 폴더 액세스가 걸려 있는지 확인해 주세요. ② 러너 연결에 설정이 반영되지 않음 — **설정 → AI 연결**에서 러너 재연결(또는 CLI 업데이트)을 시도해 주세요.`);
  return en
    ? `\n\n---\n⚠ The write was blocked${where}. ${candidates}`
    : `\n\n---\n⚠ 쓰기가 막혔습니다${where}. ${candidates}`;
}
