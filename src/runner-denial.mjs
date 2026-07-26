// 외부 CLI 러너(codex)의 샌드박스 거부를 Argo의 능력 계층으로 승격한다.
//
// 왜 필요한가 — SDK(Claude Code) 러너는 permission-gate가 도구 호출을 가로채 "켤까요?" 카드를
// 띄운다. 외부 CLI는 그 자리가 없다: 거부가 프로세스 안에서 일어나 `zsh:1: operation not
// permitted: /path` 같은 생 셸 에러로만 흘러나온다. 사장은 카드도 못 보고 안내도 못 받은 채
// "권한을 다 켜놨는데도 쓰기가 차단된다"로 읽는다(실사용 신고 2026-07-26, 재현 확인).
//
// 범위: codex 전용이다(배선도 chat.mjs에서 codex만 태운다). gemini는 샌드박스가 없어 fs 거부가
// caps와 무관한 OS 오류다 — 능력 원인으로 단정하면 거짓 안내가 된다(검수 MEDIUM-2, 2026-07-26).
//
// 오탐 방어(검수 HIGH-2, 실측 5/5): 크루가 에러를 *인용·설명*하는 정상 답변("아까 나온 zsh:1:…는
// 샌드박스가 막은 것입니다")을 거부로 오인하면, 아무것도 안 막힌 턴에 카드·오정보가 붙는다.
// 그래서 (a) 코드펜스(``` 블록) 안은 제외하고 (b) 생 출력 형태만 — 줄 머리에서 시작하는 에러만 —
// 인정한다. 설명 문장은 한국어·영어 서두가 붙어 줄 머리 매칭에서 자연히 걸러진다.

/** 파일 쓰기 거부 — 생 출력 줄 형태(줄 머리 앵커). 캡처 1 = 대상 경로(유닉스 절대/홈, 윈도우 드라이브). */
const BT = '`'; // 백틱 — String.raw 템플릿 안에 직접 못 쓴다(리터럴 종결)
const PATH = String.raw`((?:\/|~\/|[A-Za-z]:\\)[^\s'"${BT},)]+)`;
const Q = String.raw`['"${BT}]?`;
const FS_DENIAL = [
  new RegExp(String.raw`^\s*(?:zsh|bash|sh|dash):\s*(?:\d+:\s*)?operation not permitted:\s*${PATH}`, 'i'), // codex seatbelt 실측 형태
  new RegExp(String.raw`^\s*(?:\S{1,40}:\s*)?(?:Error:\s*)?(?:EPERM|EACCES)\b[^\n]*?${Q}${PATH}`),
  new RegExp(String.raw`^\s*(?:\S{1,40}:\s*)?permission denied[^\n]*?${Q}${PATH}`, 'i'),
  new RegExp(String.raw`^\s*(?:\S{1,40}:\s*)?${PATH}[^\n]*?read-only file system`, 'i'), // cp류는 경로가 문구 앞
  new RegExp(String.raw`^\s*(?:\S{1,40}:\s*)?read-only file system[^\n]*?${Q}${PATH}`, 'i'),
];

/** 네트워크 거부 — codex는 browser 능력이 꺼지면 network_access=false라 DNS부터 막힌다.
    역시 생 출력 줄만(curl/노드 에러 형태). 설명 문장 속 인용은 줄 머리 앵커가 거른다. */
const NET_DENIAL = [
  /^\s*curl:\s*\(\d+\)\s*could not resolve host/i,
  /^\s*(?:\S{1,40}:\s*)?(?:Error:\s*)?(?:getaddrinfo\s+)?(?:ENOTFOUND|EAI_AGAIN)\b/,
  /^\s*(?:\S{1,40}:\s*)?(?:name or service|nodename nor servname) not known/i,
  /^\s*(?:\S{1,40}:\s*)?network is unreachable/i,
  /^\s*(?:\S{1,40}:\s*)?temporary failure in name resolution/i,
];

/** 코드펜스 밖의 줄만 남긴다 — 크루가 에러를 예시로 보여주는 정석 표기가 코드블록이다. */
function unfencedLines(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) out.push(line);
  }
  return out;
}

/** 경로 꼬리 정리 — 문장 끝 마침표·따옴표가 경로에 붙어 들어오는 것 방지(검수 LOW-3). */
const cleanPath = (p) => String(p ?? '').replace(/[.,;:'"`)]+$/, '');

/** 러너 출력에서 능력 거부를 찾는다(순수) — { cap, path } 또는 null.
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
    for (const re of NET_DENIAL) {
      if (re.test(line)) return { cap: 'browser', path: '' };
    }
  }
  return null;
}

/** 거부 안내문(순수). 갈래:
    - 능력 OFF + 홈 안 경로 → "켤까요? 카드" (cardShown=false면 설정 경로 안내로 폴백 — 검수 LOW-2)
    - 능력 OFF + 홈 밖 경로 → 켜도 안 되는 조합이다. 카드를 약속하지 않고 홈 안 이동을 안내(검수 HIGH-1 —
      켜기 승인 후 같은 거부를 또 겪으면 "켰는데도 차단"이라는 신고 문구를 이 기능이 재생산한다)
    - 능력 ON인데 차단 → 원인 후보를 단정 없이 나열(검수 MEDIUM-3): 홈 밖 경로 / OS 파일 권한 /
      codex 연결 구버전(설정 미반영 — 실사용 전례 2026-07-22) */
export function denialNote({ cap, path = '', capOn, lang = 'ko', outsideHome = false, cardShown = true }) {
  const en = lang === 'en';
  const where = path ? (en ? ` (target: ${path})` : ` (대상: ${path})`) : '';

  if (!capOn) {
    if (cap === 'fs' && outsideHome) {
      return en
        ? `\n\n---\n⚠ The write was blocked${where}. The target is outside your home folder — even turning the File system capability on only opens your home folder, so this path would stay blocked. Move the file under your home folder (Documents, Desktop, …) and ask me again.`
        : `\n\n---\n⚠ 쓰기가 막혔습니다${where}. 대상이 홈 폴더 밖입니다 — 파일 시스템 능력을 켜도 열리는 범위는 홈 폴더까지라 이 경로는 계속 막힙니다. 파일을 홈 폴더 안(문서·데스크탑 등)으로 옮기고 다시 시켜 주세요.`;
    }
    if (!cardShown) {
      return cap === 'browser'
        ? (en
            ? `\n\n---\n⚠ This runner was blocked from reaching the network because **Web browsing** is off. Turn it on in **Settings → Local capabilities** and ask me again.`
            : `\n\n---\n⚠ **웹 브라우징** 능력이 꺼져 있어 네트워크가 막혔습니다. **설정 → 로컬 능력**에서 켜신 뒤 다시 시켜 주세요.`)
        : (en
            ? `\n\n---\n⚠ The write was blocked because **File system** is off${where}. Turn it on in **Settings → Local capabilities** and ask me again.`
            : `\n\n---\n⚠ **파일 시스템** 능력이 꺼져 있어 쓰기가 막혔습니다${where}. **설정 → 로컬 능력**에서 켜신 뒤 다시 시켜 주세요.`);
    }
    return cap === 'browser'
      ? (en
          ? `\n\n---\n⚠ This runner was blocked from reaching the network because **Web browsing** is off. I've put a "turn it on?" card in your chat — approve it and I'll continue from where I stopped.`
          : `\n\n---\n⚠ **웹 브라우징** 능력이 꺼져 있어 이 러너가 네트워크에서 막혔습니다. 대화창에 "켤까요?" 카드를 띄웠습니다 — 승인하시면 멈춘 자리에서 이어서 하겠습니다.`)
      : (en
          ? `\n\n---\n⚠ This runner was blocked from writing outside the company folder because **File system** is off${where}. I've put a "turn it on?" card in your chat — approve it and I'll continue from where I stopped.`
          : `\n\n---\n⚠ **파일 시스템** 능력이 꺼져 있어 회사 폴더 밖 쓰기가 막혔습니다${where}. 대화창에 "켤까요?" 카드를 띄웠습니다 — 승인하시면 멈춘 자리에서 이어서 하겠습니다.`);
  }

  // 능력은 켜져 있는데 막혔다 — 원인을 단정하지 않고 후보를 나열한다(검수 MEDIUM-3).
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
