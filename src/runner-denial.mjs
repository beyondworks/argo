// 외부 CLI 러너(codex)의 샌드박스 거부를 Argo의 능력 계층으로 승격한다.
//
// 왜 필요한가 — SDK(Claude Code) 러너는 permission-gate가 도구 호출을 가로채 "켤까요?" 카드를
// 띄운다. 외부 CLI는 그 자리가 없다: 거부가 프로세스 안에서 일어나고, 사장은 카드도 안내도 못
// 받은 채 "권한을 다 켜놨는데도 쓰기가 차단된다"로 읽는다(실사용 신고 2026-07-26).
//
// 두 단계 탐지 — 실측 근거(2026-07-26, codex-cli 0.144.1 캡처 2건):
//  ① 생 에러("reply with the exact error" 지시): `zsh:1: operation not permitted: /path` 그대로.
//  ② 크루형 지시(한국어 페르소나): 최종 메시지에 생 에러가 없고 "지정한 Desktop 경로에 쓰기
//     권한이 없습니다"처럼 **자연어로 서술**된다 — 정규식 생 에러 탐지로는 절대 안 잡힌다.
// 그래서 strict(생 출력 줄만, 어느 능력 상태든 신뢰) + narration(서술 표현, **능력 OFF일 때만**
// 헤지 문구로) 2단이다. 서술 탐지를 능력 OFF로 게이트하는 이유: 오탐하더라도 "꺼져 있는 능력을
// 켤까요?"라는 사실 기반 제안에 그쳐 오정보가 되지 않는다. 능력 ON의 오정보("켰는데도 차단"
// 안내)는 strict 매칭에서만 나올 수 있게 잠근다(검수 2라운드 2026-07-26).
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

/** 서술형 거부 탐지(순수) — 실측 캡처 ②: codex는 거부를 자연어로 서술한다
    ("지정한 Desktop 경로에 쓰기 권한이 없습니다"). { caps: ['browser'?, 'fs'?] } 또는 null.
    - 후보 배열이다: 호출부가 **OFF인 첫 능력**을 채택한다(3R: fs 단일 반환은 fs ON일 때
      browser 거부까지 삼켰다). browser를 앞에 둔다 — 네트워크 거부 서술에 "권한" 어휘가
      섞이는 게 흔해(3R MEDIUM: codex가 network 차단을 "not permitted"로 뱉음) fs 우선이면
      틀린 카드가 나간다.
    - 생 에러 토큰(bare "not permitted"·"permission denied")은 여기 없다 — 그건 strict의
      몫이고, 산문에 나타나면 대부분 인용이다(3R: 성공 보고·IAM 설명이 fs로 잡혔다).
    - 코드펜스 안은 제외(strict와 동일) — 펜스 인용 로그가 서술로 새지 않게.
    ⚠ 호출부는 반드시 **해당 능력이 OFF일 때만** 이 결과를 써야 한다 — 오탐해도
    "꺼진 능력을 켤까요?"라는 사실 기반 제안에 머물게 하는 안전선이다. */
const NARR_BROWSER = /(?:네트워크|인터넷|웹)에? 접근(?:이|을|할 수)? ?(?:막|없|차단|불가|거부)|웹 검색(?:을|이)? ?(?:할 수 없|못 하|막|차단)|네트워크가 차단|(?:network|internet) (?:access )?(?:is )?(?:blocked|disabled|unavailable|restricted|not permitted|denied)/i;
const NARR_FS = /쓰기 권한이 없|쓰기가 (?:거부|차단|제한)|권한이 없어[^\n]{0,20}(?:쓰|저장|만들)|(?:저장|생성)할 수 없[^\n]{0,30}권한|밖(?:에|의)[^\n]{0,15}(?:쓸 수 없|저장할 수 없)|no write (?:access|permission)|write (?:access|permission) (?:is )?(?:denied|restricted|missing)|(?:don't|do not|doesn't|cannot|can't) (?:have )?write (?:permission|access)/i;
export function detectDeniedNarration(text) {
  const s = unfencedLines(String(text ?? '')).join('\n');
  if (!s) return null;
  const caps = [];
  if (NARR_BROWSER.test(s)) caps.push('browser');
  if (NARR_FS.test(s)) caps.push('fs');
  return caps.length ? { caps } : null;
}

/** 거부 안내문(순수). 갈래:
    - 능력 OFF + 홈 안 → "켤까요? 카드" (cardShown=false면 설정 경로 폴백 — 검수 LOW-2)
    - 능력 OFF + 홈 밖(strict의 경로 있을 때만) → 켜도 안 되는 조합. 카드를 약속하지 않고
      홈 안 이동 안내(검수 HIGH-1 — 켜기 승인 후 또 막히면 신고 문구를 재생산한다)
    - 능력 ON인데 차단(strict 전용) → 원인 후보를 단정 없이 나열(검수 MEDIUM-3)
    narrated=true(서술 탐지 유래)면 단정 대신 "~여서일 가능성이 큽니다"로 헤지한다. */
export function denialNote({ cap, path = '', capOn, lang = 'ko', outsideHome = false, cardShown = true, narrated = false }) {
  const en = lang === 'en';
  const where = path ? (en ? ` (target: ${path})` : ` (대상: ${path})`) : '';

  if (!capOn) {
    if (cap === 'fs' && outsideHome) {
      return en
        ? `\n\n---\n⚠ The write was blocked${where}. The target is outside your home folder — even turning the File system capability on only opens your home folder, so this path would stay blocked. Move the file under your home folder (Documents, Desktop, …) and ask me again.`
        : `\n\n---\n⚠ 쓰기가 막혔습니다${where}. 대상이 홈 폴더 밖입니다 — 파일 시스템 능력을 켜도 열리는 범위는 홈 폴더까지라 이 경로는 계속 막힙니다. 파일을 홈 폴더 안(문서·데스크탑 등)으로 옮기고 다시 시켜 주세요.`;
    }
    const label = cap === 'browser'
      ? (en ? 'Web browsing' : '웹 브라우징') : (en ? 'File system' : '파일 시스템');
    const cause = narrated
      ? (en ? `This looks blocked because **${label}** is off` : `**${label}** 능력이 꺼져 있어 막힌 것으로 보입니다`)
      : (en ? `This was blocked because **${label}** is off` : `**${label}** 능력이 꺼져 있어 막혔습니다`);
    if (!cardShown) {
      return en
        ? `\n\n---\n⚠ ${cause}${where}. Turn it on in **Settings → Local capabilities** and ask me again.`
        : `\n\n---\n⚠ ${cause}${where}. **설정 → 로컬 능력**에서 켜신 뒤 다시 시켜 주세요.`;
    }
    return en
      ? `\n\n---\n⚠ ${cause}${where}. I've put a "turn it on?" card in your chat — approve it and I'll continue from where I stopped.`
      : `\n\n---\n⚠ ${cause}${where}. 대화창에 "켤까요?" 카드를 띄웠습니다 — 승인하시면 멈춘 자리에서 이어서 하겠습니다.`;
  }

  // 능력은 켜져 있는데 막혔다(strict 매칭 전용) — 원인을 단정하지 않고 후보를 나열한다(검수 MEDIUM-3).
  if (cap === 'browser') {
    return en
      ? `\n\n---\n⚠ **Web browsing is already on**, but the network was still blocked. Likely one of: ① an actual network problem (offline, VPN, firewall), ② the runner connection not picking up settings — try reconnecting the runner in **Settings → AI connections** (or updating its CLI).`
      : `\n\n---\n⚠ **웹 브라우징 능력은 이미 켜져 있는데도** 네트워크가 막혔습니다. 다음 중 하나일 수 있습니다: ① 실제 네트워크 문제(오프라인·VPN·방화벽), ② 러너 연결에 설정이 반영되지 않음 — **설정 → AI 연결**에서 러너 재연결(또는 CLI 업데이트)을 시도해 주세요.`;
  }
  const candidates = outsideHome
    ? (en
        ? `The target is outside your home folder — this runner can only write inside your home folder even with the capability on. Move it under your home folder and I'll retry.`
        : `대상이 홈 폴더 밖입니다 — 이 능력을 켜도 쓰기 범위는 홈 폴더까지입니다. 홈 폴더 안으로 옮겨 주시면 다시 시도하겠습니다.`)
    : (en
        ? `Likely one of: ① the operating system is blocking it — **System Settings → Privacy & Security → Files and Folders** (or Full Disk Access), allow Argo and restart the app; on Windows, check the folder isn't read-only or under controlled folder access. ② The runner connection isn't picking up settings — reconnect the runner in **Settings → AI connections** (or update its CLI).`
        : `다음 중 하나일 수 있습니다: ① 운영체제가 막고 있음 — **시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더**(또는 전체 디스크 접근 권한)에서 Argo를 허용하고 앱을 다시 켜 주세요. 윈도우라면 폴더가 읽기 전용인지·제어된 폴더 액세스가 걸려 있는지 확인해 주세요. ② 러너 연결에 설정이 반영되지 않음 — **설정 → AI 연결**에서 러너 재연결(또는 CLI 업데이트)을 시도해 주세요.`);
  return en
    ? `\n\n---\n⚠ **File system is already on**${where}, but the write was still blocked. ${candidates}`
    : `\n\n---\n⚠ **파일 시스템 능력은 이미 켜져 있는데도** 쓰기가 막혔습니다${where}. ${candidates}`;
}
